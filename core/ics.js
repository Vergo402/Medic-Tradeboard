/**
 * core/ics.js — iCalendar (RFC 5545) feed parser for the Medic Tradeboard.
 *
 * Converts a raw .ics feed into normalized event objects, so everything below
 * buildTriplet (the scorer, the drawer, the title picker) stays byte-for-byte
 * unchanged. Emitted events have the normalized shape:
 *
 *     { summary, status, start:{dateTime}|{date}, end:{dateTime}|{date} }
 *
 * A timed start/end.dateTime is always a UTC "…Z" RFC3339 string — buildTriplet
 * runs Date.parse on it and re-expresses it in NY civil time, so the source
 * timezone is fully resolved here and never leaks downstream. An all-day date
 * keeps the exclusive-end convention (end.date is the day AFTER the last day).
 * One parser covers any RFC 5545 feed.
 *
 * WHY IT FAILS LOUD. This is the layer that decides whether a shift looks free.
 * A silently dropped commitment mis-scores a shift, so nothing is dropped in
 * silence: a recurrence part the engine does not implement, or a timezone it
 * cannot resolve, skips ONLY that one event and records a named warning the
 * caller surfaces. A body that is not iCalendar at all (a fetched error page)
 * throws, so the feed reads as broken rather than quietly empty.
 *
 * Pure and chrome-free: no chrome.*, no DOM, no network. The service worker
 * fetches the text and hands it here; unit tests import parseIcs directly.
 */

const NY = "America/New_York";
const DAY_MS = 86400000;

// Guard against a pathological series (a corrupt feed with a far-past DTSTART
// and no COUNT/UNTIL). The scan window sits near "today", so even a daily rule
// running since ~2010 reaches it in a few thousand steps; this cap is orders of
// magnitude above any real feed and only trips on corruption. It bounds BOTH the
// candidates a consumer draws AND each generator's own outer iterations — a rule
// like FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30 selects no day in any month, so it
// would otherwise spin forever without ever yielding for a consumer to count.
const MAX_STEPS = 200000;

// Sentinel a generator yields when it hits its iteration backstop; the consumer
// turns it into a named skip. Distinct from "yielded nothing", which is a
// perfectly correct empty expansion and warns about nothing.
const OVERFLOW = { overflow: true };

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const EMPTY_SET = new Set();

// RRULE parts the engine expands. Anything else in an RRULE (BYSETPOS, BYWEEKNO,
// BYYEARDAY, BYHOUR/BYMINUTE/BYSECOND, a FREQ below DAILY, …) is unsupported: the
// event is skipped with a named warning, never silently mis-expanded.
const RRULE_PARTS = new Set([
  "FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST",
]);
const RRULE_FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

export class IcsError extends Error {
  constructor(message) {
    super(message);
    this.name = "IcsError";
  }
}

// ---------------------------------------------------------------------------
// Calendar arithmetic (pure civil fields; UTC has no DST so Date.UTC is exact)
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}
function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
function daysInMonth(y, mo) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}
function weekdayOf(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
function dateStr(c) {
  return `${c.y}-${pad2(c.mo)}-${pad2(c.d)}`;
}
function addDaysYMD(c, n) {
  const dt = new Date(Date.UTC(c.y, c.mo - 1, c.d) + n * DAY_MS);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function cmpYMD(a, b) {
  return a.y - b.y || a.mo - b.mo || a.d - b.d;
}
// Whole civil days from a to b (both {y,mo,d}); exact because pure dates carry no
// time and Date.UTC of a bare date is a clean 24h multiple.
function dayDiff(a, b) {
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / DAY_MS);
}
function addMonths(y, mo, n) {
  const idx = y * 12 + (mo - 1) + n;
  return { y: Math.floor(idx / 12), mo: (idx % 12) + 1 };
}

// ---------------------------------------------------------------------------
// Timezone: civil wall-clock <-> epoch ms, parameterized by zone.
// Mirrors core/nytime.js toEpoch's fold=0 rule (earlier instant on the fall-back
// hour, pre-gap offset on spring-forward) but for an arbitrary IANA zone. UTC
// short-circuits. The caller validates the zone (isValidZone) before relying on
// this; an unknown zone reaching Intl throws, which parseIcs turns into a skip.
// ---------------------------------------------------------------------------

function zoneParts(ms, zone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const m = {};
  for (const p of dtf.formatToParts(new Date(ms))) m[p.type] = p.value;
  let h = Number(m.hour);
  if (h === 24) h = 0; // old-ICU h23-midnight-as-24 guard
  return { y: +m.year, mo: +m.month, d: +m.day, h, mi: +m.minute, s: +m.second };
}

function zoneOffsetMinutes(ms, zone) {
  const p = zoneParts(ms, zone);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUTC - ms) / 60000);
}

function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (_e) {
    return false;
  }
}

function civilEq(a, b) {
  return a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi && a.s === b.s;
}

function civilToMs(c, zone) {
  const s = c.s || 0;
  if (zone === "UTC") return Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, s);
  const guess = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, s);
  const offB = zoneOffsetMinutes(guess - DAY_MS, zone);
  const offA = zoneOffsetMinutes(guess + DAY_MS, zone);
  const cands = offB === offA ? [offB] : [offB, offA];
  const want = { y: c.y, mo: c.mo, d: c.d, h: c.h, mi: c.mi, s };
  const hits = [];
  for (const off of cands) {
    const ms = guess - off * 60000;
    if (civilEq(zoneParts(ms, zone), want)) hits.push(ms);
  }
  if (hits.length) return Math.min(...hits); // fold=0 -> earlier instant on fall-back
  return guess - offB * 60000; // spring-forward gap -> pre-transition offset
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Civil fields shifted by a wall-clock millisecond delta (naive field math,
// DST-agnostic — same semantics as core/nytime.js addHours/addDays). Used to
// carry an event's nominal wall duration onto each recurrence occurrence before
// it is resolved back to an instant in the event's own zone.
function shiftWall(c, ms) {
  const dt = new Date(Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s || 0) + ms);
  return {
    y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
    h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds(),
  };
}

// ---------------------------------------------------------------------------
// Line + value parsing
// ---------------------------------------------------------------------------

// RFC 5545 line unfolding: a CRLF (or bare LF) followed by one space/tab
// continues the previous logical line. Normalize newlines, splice the folds out,
// then split into logical lines.
function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

// Split `s` on `sep`, but a DQUOTE-delimited run (RFC 5545 §3.1 quoted-string)
// hides any `sep` inside it — needed because a param value may itself contain
// ';' or ':' when quoted (X;P="a:b":v).
function splitUnquoted(s, sep) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (const ch of s) {
    if (ch === '"') inQ = !inQ;
    if (ch === sep && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// A param-value may be a quoted-string (param-value = paramtext / quoted-string);
// the DQUOTEs are delimiters, not part of the value.
function unquote(v) {
  return v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"' ? v.slice(1, -1) : v;
}

// "NAME;PARAM=v;PARAM2=v2:VALUE" -> { name, params, value }. The name/value
// colon is found by scanning for the first UNQUOTED ':' — a quoted param value
// may itself contain ':' or ';', so a naive indexOf/split breaks on those.
function splitProp(line) {
  let ci = -1;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ":" && !inQ) { ci = i; break; }
  }
  if (ci === -1) return null;
  const segs = splitUnquoted(line.slice(0, ci), ";");
  const params = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf("=");
    if (eq > -1) params[segs[i].slice(0, eq).toUpperCase()] = unquote(segs[i].slice(eq + 1));
  }
  return { name: segs[0].toUpperCase(), params, value: line.slice(ci + 1) };
}

// RFC 5545 §3.3.11 TEXT escapes: \\ \, \; are literal chars, \n / \N is a line
// break. Decode ONLY for TEXT-valued props actually consumed as text (SUMMARY,
// X-WR-CALNAME) — date/rule values are never run through this.
function decodeText(v) {
  return v.replace(/\\([\\,;nN])/g, (_m, c) => (c === "n" || c === "N" ? "\n" : c));
}

// Digit counts alone are not a valid date: Date.UTC ROLLS OVER an impossible
// field (June 31 -> July 1, hour 25 -> next day 01:00), so an unvalidated value
// becomes a confirmed commitment on a day the feed never stated. Every field is
// range-checked here and an impossible one returns null, which every caller
// already turns into a named skip. Deliberate narrowings vs the RFC grammar:
// second 60 (§3.3.12 leap second) and the wild-in-practice hour 24 are refused
// loudly rather than normalized.
function validYMD(y, mo, d) {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}
function parseDateOnly(v) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!m || !validYMD(+m[1], +m[2], +m[3])) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}
function parseDateTime(v) {
  // [Tt]/[Zz]: RFC 5234 ABNF string literals are case-INsensitive, so a
  // lowercase separator or UTC suffix is a legal DATE-TIME, not a skip.
  const m = /^(\d{4})(\d{2})(\d{2})[Tt](\d{2})(\d{2})(\d{2})([Zz])?$/.exec(v);
  if (!m || !validYMD(+m[1], +m[2], +m[3])) return null;
  const [h, mi, s] = [+m[4], +m[5], +m[6]];
  if (h > 23 || mi > 59 || s > 59) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h, mi, s, utc: !!m[7] };
}

/**
 * Resolve a DTSTART/DTEND/RECURRENCE-ID/EXDATE value + params into either an
 * all-day date {allDay:true, date:{y,mo,d}} or a zoned wall time
 * {allDay:false, civil:{y,mo,d,h,mi,s}, zone}. `zone` is "UTC" for a trailing Z,
 * the TZID for a zoned local time, or NY for a floating local time (the app's
 * civil frame). Returns null for an unparseable value.
 */
function classifyValue(value, params) {
  if (params.VALUE === "DATE") {
    const d = parseDateOnly(value);
    return d ? { allDay: true, date: d } : null;
  }
  const dt = parseDateTime(value);
  if (dt) {
    const zone = dt.utc ? "UTC" : params.TZID || NY;
    return { allDay: false, civil: { y: dt.y, mo: dt.mo, d: dt.d, h: dt.h, mi: dt.mi, s: dt.s }, zone };
  }
  const d = parseDateOnly(value); // 8-digit value with no VALUE=DATE param
  return d ? { allDay: true, date: d } : null;
}

// ISO 8601 duration (PT10H, P1D, P1DT2H30M, -PT1H, PT0S) -> {days, ms}, or null
// when the value cannot be read at all (the caller then skips the event loudly).
// RFC 5545 §3.3.6 splits the two halves: W/D parts are NOMINAL (calendar days,
// wall-clock preserving, so a day across spring-forward is 23 real hours) and T
// parts are EXACT elapsed time. They are kept apart here and resolved per
// occurrence in the event's own zone.
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || "");
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const secs = +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0);
  return { days: sign * (+(m[2] || 0) * 7 + +(m[3] || 0)), ms: sign * secs * 1000 };
}

// The digit runs above are unbounded, so P99999999999999D lands an endpoint far
// outside the ±8.64e15 Date range; iso()/Intl then throw a RangeError that used
// to escape parseIcs and take the WHOLE feed down. A year is already orders of
// magnitude past anything a shift feed can mean, so a longer one is refused here
// as a named per-event skip.
const MAX_DUR_DAYS = 3660;
const MAX_DUR_MS = 366 * DAY_MS;
function durationOf(v) {
  const d = parseDuration(v);
  if (!d) return { err: "unparseable DURATION: " + v };
  if (Math.abs(d.days) > MAX_DUR_DAYS || Math.abs(d.ms) > MAX_DUR_MS) {
    return { err: "unsupported DURATION (too large): " + v };
  }
  return { d };
}

// ---------------------------------------------------------------------------
// RRULE
// ---------------------------------------------------------------------------

// `zone` is the master event's own DTSTART zone. RFC 5545 §3.3.10 requires UNTIL
// to be UTC when DTSTART carries a TZID, but some real-world producers emit a
// local-time UNTIL anyway; resolving it in the event's own zone (rather than a
// hardcoded NY) is what keeps a western-zone series from being truncated a day
// early. Returns null for a value that parses as neither DATE-TIME nor DATE —
// the caller treats that as a malformed, loudly-skipped rule.
function untilToMs(v, zone) {
  const dt = parseDateTime(v);
  if (dt) return dt.utc ? Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s) : civilToMs(dt, zone || NY);
  const d = parseDateOnly(v);
  // Date-only UNTIL is inclusive through that whole day — end-of-day IN THE
  // EVENT'S OWN ZONE. A hardcoded NY end-of-day is a different instant for any
  // other zone, which let a Tokyo series emit a phantom occurrence the day AFTER
  // UNTIL (NY 23:59:59 is already the next Tokyo morning) and truncated an LA
  // evening series a day early. `zone` is NY for an all-day or floating series,
  // so the app's civil frame still applies wherever there is no zone of its own.
  if (d) return civilToMs({ y: d.y, mo: d.mo, d: d.d, h: 23, mi: 59, s: 59 }, zone || NY);
  return null;
}

function parseByday(rule, v) {
  const out = [];
  for (const tok of v.split(",")) {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(tok.trim());
    if (!m) return "BYDAY=" + tok;
    out.push({ ord: m[1] ? parseInt(m[1], 10) : null, day: WD[m[2].toUpperCase()] });
  }
  rule.byday = out;
  return null;
}

// Fold one recognized RRULE part into `rule`; return a reason string if the part
// is malformed, else null. An UNTIL or COUNT the engine cannot read must NOT
// silently become "no bound" (a NaN COUNT or null UNTIL defeats the guards in
// emitMaster and the series runs forever) — both are rejected here instead.
function applyRulePart(rule, k, v, zone) {
  if (k === "FREQ") rule.freq = v.toUpperCase();
  else if (k === "INTERVAL") rule.interval = Math.max(1, parseInt(v, 10) || 1);
  else if (k === "COUNT") {
    if (!/^\d+$/.test(v.trim())) return "COUNT=" + v;
    rule.count = parseInt(v, 10);
  } else if (k === "UNTIL") {
    const ms = untilToMs(v, zone);
    if (ms === null) return "UNTIL=" + v;
    rule.until = ms;
  } else if (k === "WKST") rule.wkst = v.toUpperCase();
  else if (k === "BYMONTH") {
    // Same non-silence rule as COUNT/UNTIL: an out-of-range or non-numeric
    // BY* part would select no day in ANY period, so the series would vanish
    // as a clean-looking empty expansion instead of a named skip.
    const ms = v.split(",").map(Number);
    if (ms.some((n) => !Number.isInteger(n) || n < 1 || n > 12)) return "BYMONTH=" + v;
    rule.bymonth = ms;
  } else if (k === "BYMONTHDAY") {
    const ds = v.split(",").map(Number);
    if (ds.some((n) => !Number.isInteger(n) || n === 0 || n < -31 || n > 31)) return "BYMONTHDAY=" + v;
    rule.bymonthday = ds;
  } else if (k === "BYDAY") return parseByday(rule, v);
  return null;
}

/**
 * Parse an RRULE value into a structured rule, or {unsupported:"<why>"} when it
 * uses a part or FREQ the expander does not implement. `<why>` names the exact
 * offender so the skip warning is actionable. `zone` is the master event's own
 * DTSTART zone, needed to resolve a local-time UNTIL correctly.
 */
function parseRRule(value, zone) {
  const rule = {
    freq: null, interval: 1, count: null, until: null,
    byday: null, bymonthday: null, bymonth: null, wkst: "MO",
  };
  for (const part of value.split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) return { unsupported: "malformed_rrule" };
    const k = part.slice(0, eq).toUpperCase();
    if (!RRULE_PARTS.has(k)) return { unsupported: k };
    const bad = applyRulePart(rule, k, part.slice(eq + 1), zone);
    if (bad) return { unsupported: bad };
  }
  if (!RRULE_FREQS.has(rule.freq)) return { unsupported: "FREQ=" + rule.freq };
  // RFC 5545 §3.3.10: the BYDAY numeric ordinal is only meaningful for
  // MONTHLY/YEARLY. Honestly unsupported for WEEKLY and DAILY rather than
  // silently reinterpreted as every matching weekday.
  if ((rule.freq === "WEEKLY" || rule.freq === "DAILY") && rule.byday && rule.byday.some((b) => b.ord !== null)) {
    return { unsupported: "ordinal_byday_with_" + rule.freq.toLowerCase() };
  }
  return rule;
}

// ---------------------------------------------------------------------------
// Occurrence-date generators (each yields {y,mo,d} in ascending order). Every
// one is self-bounding: it stops when its cursor passes `ceil` (the window's
// upper civil date, so nothing later could start in-window) and yields OVERFLOW
// after MAX_STEPS outer ITERATIONS. Counting iterations rather than yields is
// what makes a rule that selects no day in any period terminate — the consumer's
// own guard only runs once per yielded candidate. The caller still bounds the
// yields it draws by COUNT/UNTIL/window.
// ---------------------------------------------------------------------------

// BYDAY (day-of-week only; ordinals are meaningless for DAILY) and BYMONTH are
// LIMITS for FREQ=DAILY (RFC 5545 §3.3.10 Note): a candidate whose weekday/month
// isn't selected is filtered out. Filtering here never changes the iteration
// count — `i` still advances one calendar day per step regardless of match, so
// the MAX_STEPS/ceil termination is untouched by the filter.
function* genDaily(start, interval, byday, bymonth, ceil) {
  let c = { ...start };
  for (let i = 0; cmpYMD(c, ceil) <= 0; i++) {
    if (i > MAX_STEPS) return yield OVERFLOW;
    const wd = weekdayOf(c.y, c.mo, c.d);
    const dayOk = !byday || !byday.length || byday.some((b) => b.day === wd);
    const monOk = !bymonth || bymonth.includes(c.mo);
    if (dayOk && monOk) yield c;
    c = addDaysYMD(c, interval);
  }
}

function weekStart(c, wkstDay) {
  const wd = weekdayOf(c.y, c.mo, c.d);
  return addDaysYMD(c, -((wd - wkstDay + 7) % 7));
}

// BYMONTH is a LIMIT for FREQ=WEEKLY (RFC 5545 §3.3.10 Note): filtered per
// candidate day, same non-widening rationale as genDaily above — the block
// cursor still advances one week per outer iteration either way.
function* genWeekly(start, interval, byday, wkst, bymonth, ceil) {
  const wkstDay = wkst in WD ? WD[wkst] : 1;
  const days = byday && byday.length ? byday.map((b) => b.day) : [weekdayOf(start.y, start.mo, start.d)];
  const offsets = [...new Set(days.map((d) => (d - wkstDay + 7) % 7))].sort((a, b) => a - b);
  let block = weekStart(start, wkstDay);
  for (let i = 0; cmpYMD(block, ceil) <= 0; i++) {
    if (i > MAX_STEPS) return yield OVERFLOW;
    for (const off of offsets) {
      const cand = addDaysYMD(block, off);
      if (!bymonth || bymonth.includes(cand.mo)) yield cand;
    }
    block = addDaysYMD(block, interval * 7);
  }
}

// The nth (or -nth, from month end) weekday in a month, or null if it falls off
// the month.
function nthWeekday(y, mo, weekday, ord) {
  const dim = daysInMonth(y, mo);
  if (ord > 0) {
    const day = 1 + ((weekday - weekdayOf(y, mo, 1) + 7) % 7) + (ord - 1) * 7;
    return day <= dim ? day : null;
  }
  const day = dim - ((weekdayOf(y, mo, dim) - weekday + 7) % 7) + (ord + 1) * 7;
  return day >= 1 ? day : null;
}

// BYDAY (ordinal or every-weekday) days within one month.
function bydayDaysInMonth(y, mo, byday) {
  const days = [];
  for (const b of byday) {
    if (b.ord === null) {
      for (let d = 1; d <= daysInMonth(y, mo); d++) if (weekdayOf(y, mo, d) === b.day) days.push(d);
    } else {
      const d = nthWeekday(y, mo, b.day, b.ord);
      if (d) days.push(d);
    }
  }
  return days;
}

// The sorted, in-range day numbers a monthly/yearly rule selects within one
// month. RFC 5545 §3.3.10 Notes 1/2: when BOTH BYDAY and BYMONTHDAY are present
// for MONTHLY/YEARLY, BYDAY LIMITS the BYMONTHDAY expansion (intersect) rather
// than one silently winning. BYMONTHDAY alone (negative = from month end), or
// BYDAY alone, or neither (the series' own start day-of-month) fall through.
function monthDays(y, mo, rule, startDay) {
  let days;
  if (rule.byday && rule.bymonthday) {
    const bySet = new Set(bydayDaysInMonth(y, mo, rule.byday));
    const mdays = rule.bymonthday.map((d) => (d < 0 ? daysInMonth(y, mo) + 1 + d : d));
    days = mdays.filter((d) => bySet.has(d));
  } else if (rule.byday) {
    days = bydayDaysInMonth(y, mo, rule.byday);
  } else if (rule.bymonthday) {
    days = rule.bymonthday.map((d) => (d < 0 ? daysInMonth(y, mo) + 1 + d : d));
  } else {
    days = [startDay];
  }
  const dim = daysInMonth(y, mo);
  return [...new Set(days)].filter((d) => d >= 1 && d <= dim).sort((a, b) => a - b);
}

function* genMonthly(start, rule, ceil) {
  let ym = { y: start.y, mo: start.mo };
  for (let i = 0; ym.y * 12 + ym.mo <= ceil.y * 12 + ceil.mo; i++) {
    if (i > MAX_STEPS) return yield OVERFLOW;
    if (!rule.bymonth || rule.bymonth.includes(ym.mo)) {
      for (const d of monthDays(ym.y, ym.mo, rule, start.d)) yield { y: ym.y, mo: ym.mo, d };
    }
    ym = addMonths(ym.y, ym.mo, rule.interval);
  }
}

// The nth (or -nth, from year end) weekday of a whole YEAR, or null when the
// ordinal runs off the year. Anchors on the first/last matching weekday and steps
// whole weeks, so it needs no month arithmetic.
function nthWeekdayOfYear(y, weekday, ord) {
  const c = ord > 0
    ? addDaysYMD({ y, mo: 1, d: 1 + ((weekday - weekdayOf(y, 1, 1) + 7) % 7) }, (ord - 1) * 7)
    : addDaysYMD({ y, mo: 12, d: 31 - ((weekdayOf(y, 12, 31) - weekday + 7) % 7) }, (ord + 1) * 7);
  return c.y === y ? c : null;
}

// RFC 5545 §3.3.10: under FREQ=YEARLY with no BYMONTH, BYDAY is scoped to the
// WHOLE YEAR — a bare weekday means every one of them in the year, and an ordinal
// (the RFC's own BYDAY=20MO, "every 20th Monday of the year") counts from January.
// Deduped because BYDAY=MO,1MO legitimately collides on the year's first Monday.
function bydayDaysInYear(y, byday) {
  const out = [];
  for (const b of byday) {
    if (b.ord === null) {
      for (let mo = 1; mo <= 12; mo++) {
        for (let d = 1; d <= daysInMonth(y, mo); d++) if (weekdayOf(y, mo, d) === b.day) out.push({ y, mo, d });
      }
    } else {
      const c = nthWeekdayOfYear(y, b.day, b.ord);
      if (c) out.push(c);
    }
  }
  const seen = new Set();
  return out.filter((c) => !seen.has(dateStr(c)) && seen.add(dateStr(c))).sort(cmpYMD);
}

// Year-scoped BYDAY. Same self-bounding contract as its siblings: the outer
// iteration count is what terminates it, and each year yields at most ~53 dates
// per BYDAY token, so the consumer's own MAX_STEPS guard still applies normally.
function* genYearlyByday(start, rule, ceil) {
  let y = start.y;
  for (let i = 0; y <= ceil.y; i++) {
    if (i > MAX_STEPS) return yield OVERFLOW;
    for (const c of bydayDaysInYear(y, rule.byday)) yield c;
    y += rule.interval;
  }
}

function* genYearly(start, rule, ceil) {
  // Restricting a BYMONTH-less YEARLY BYDAY rule to DTSTART's month is a silent
  // partial expansion (11 months of real commitments vanish), so it goes to the
  // year-scoped expander instead. BYMONTH present keeps the month-scoped path,
  // where ordinals are month-relative per the RFC.
  if (rule.byday && !rule.bymonth && !rule.bymonthday) return yield* genYearlyByday(start, rule, ceil);
  // Same year-scoping for BYMONTHDAY (± BYDAY as a limit) with no BYMONTH: the
  // RFC's expand table covers every month of the year, not DTSTART's. monthDays
  // already intersects byday∩bymonthday per month. DTSTART's month is only the
  // anchor when NO expanding by-part is present at all.
  const months = rule.bymonth ? [...rule.bymonth].sort((a, b) => a - b)
    : rule.bymonthday ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      : [start.mo];
  let y = start.y;
  for (let i = 0; y <= ceil.y; i++) {
    if (i > MAX_STEPS) return yield OVERFLOW;
    for (const mo of months) for (const d of monthDays(y, mo, rule, start.d)) yield { y, mo, d };
    y += rule.interval;
  }
}

function candidateGen(start, rule, ceil) {
  if (rule.freq === "DAILY") return genDaily(start, rule.interval, rule.byday, rule.bymonth, ceil);
  if (rule.freq === "WEEKLY") return genWeekly(start, rule.interval, rule.byday, rule.wkst, rule.bymonth, ceil);
  if (rule.freq === "MONTHLY") return genMonthly(start, rule, ceil);
  return genYearly(start, rule, ceil);
}

// The last civil date a generator has to reach: the window's upper bound plus
// two days of slack for any zone offset. Nothing after it can start in-window.
function winCeil(ms) {
  const d = new Date(ms);
  return addDaysYMD({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }, 2);
}

// ---------------------------------------------------------------------------
// Event assembly
// ---------------------------------------------------------------------------

function evTitle(props) {
  return props.SUMMARY ? decodeText(props.SUMMARY.value) : "(untitled)";
}
function skipMsg(title, why) {
  return `skipped_event: "${title || "(untitled)"}" (${why})`;
}

// How far a spring-forward gap pushed a wall time: the civil fields `ms` really
// lands on, minus the ones asked for. 0 whenever the wall time exists.
function gapShift(civil, zone, ms) {
  const p = zoneParts(ms, zone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) -
    Date.UTC(civil.y, civil.mo - 1, civil.d, civil.h, civil.mi, civil.s);
}

// The event's duration, resolved per occurrence:
//   all-day  -> { kind:"days", n }           (DTEND is exclusive; absent -> +1 day)
//   DTEND    -> { kind:"exact", ms }         (RFC 5545 §3.8.5.3: EXACT instant delta)
//   DURATION -> { kind:"nominal", days, ms } (D/W are calendar days; T is exact)
//   neither  -> { kind:"exact", ms:0 }       (RFC point-in-time; the emit-time
//                                             invariant skips it loudly)
// or { err } when the event cannot be given a usable duration — the caller turns
// that into a named skip, so a broken value never degrades to zero length.
//
// Each endpoint is resolved to an instant IN ITS OWN ZONE (DTSTART and DTEND may
// legally differ, or one may be UTC), which is what the old civil-field
// subtraction threw away. The one wall-clock correction: when DTSTART lands in a
// spring-forward gap it is pushed past the gap, so a SAME-ZONE DTEND — authored
// against the same pre-gap clock — is pushed with it and the wall duration holds.
// All-day half of computeEndShape. Same non-silence rule as the timed branch:
// a DTEND/DURATION the engine cannot honor is a loud skip, never a silently
// mis-sized block.
function allDayEndShape(start, props) {
  if (props.DTEND) {
    const e = classifyValue(props.DTEND.value, props.DTEND.params);
    if (!e || !e.allDay) return { err: "unusable DTEND on all-day event: " + props.DTEND.value };
    const n = dayDiff(start.date, e.date);
    return n >= 1 ? { kind: "days", n } : { err: "DTEND at or before DTSTART" };
  }
  if (props.DURATION) {
    const { d, err } = durationOf(props.DURATION.value);
    if (err) return { err };
    // RFC 5545 §3.6.1: a DATE-valued event's DURATION must be dur-day/dur-week.
    if (d.ms !== 0) return { err: "time-part DURATION on all-day event: " + props.DURATION.value };
    if (d.days < 1) return { err: "non-positive DURATION: " + props.DURATION.value };
    return { kind: "days", n: d.days };
  }
  return { kind: "days", n: 1 };
}

function computeEndShape(start, props) {
  if (start.allDay) return allDayEndShape(start, props);
  if (props.DTEND) {
    const e = classifyValue(props.DTEND.value, props.DTEND.params);
    if (!e || e.allDay) return { err: "unusable DTEND: " + props.DTEND.value };
    if (e.zone !== "UTC" && !isValidZone(e.zone)) return { err: "unresolvable DTEND timezone: " + e.zone };
    const startMs = civilToMs(start.civil, start.zone);
    // Honor DTEND exactly as stated first. Only when that would invert the event
    // AND the start was pushed out of a spring-forward gap is the DTEND read as
    // authored against the same pre-gap clock and pushed by the same shift — a
    // valid later wall time (05:00 after a gapped 02:30 start) stays as stated.
    let ms = civilToMs(e.civil, e.zone) - startMs;
    if (ms <= 0 && e.zone === start.zone) {
      const gap = gapShift(start.civil, start.zone, startMs);
      if (gap) ms = civilToMs(shiftWall(e.civil, gap), e.zone) - startMs;
    }
    return ms > 0 ? { kind: "exact", ms } : { err: "DTEND at or before DTSTART" };
  }
  if (props.DURATION) {
    const { d, err } = durationOf(props.DURATION.value);
    if (err) return { err };
    if (d.days <= 0 && d.ms <= 0) return { err: "non-positive DURATION: " + props.DURATION.value };
    return { kind: "nominal", days: d.days, ms: d.ms };
  }
  return { kind: "exact", ms: 0 };
}

// Build one concrete occurrence (normalized event + instant bounds + the
// recurrence key used for EXDATE/override matching) for a base event at date
// `cand`. For a non-recurring event `cand` is just the event's own start date.
function buildOccurrence(base, cand) {
  if (base.start.allDay) {
    const endDate = addDaysYMD(cand, base.endShape.n);
    const startMs = civilToMs({ y: cand.y, mo: cand.mo, d: cand.d, h: 0, mi: 0, s: 0 }, NY);
    const endMs = civilToMs({ y: endDate.y, mo: endDate.mo, d: endDate.d, h: 0, mi: 0, s: 0 }, NY);
    const ev = mkEvent(base, { date: dateStr(cand) }, { date: dateStr(endDate) });
    return { startMs, endMs, key: "d" + dateStr(cand), ev };
  }
  const zone = base.start.zone;
  const sc = base.start.civil;
  const sh = base.endShape;
  // The start keeps its wall clock on every occurrence (a 08:00 series is 08:00
  // on both sides of a transition); the end is then measured FROM THAT INSTANT,
  // so it can never invert or collapse the way a re-resolved wall delta could.
  const startCivil = { y: cand.y, mo: cand.mo, d: cand.d, h: sc.h, mi: sc.mi, s: sc.s };
  const startMs = civilToMs(startCivil, zone);
  const endMs = sh.kind === "nominal" && sh.days
    ? civilToMs(shiftWall(startCivil, sh.days * DAY_MS), zone) + sh.ms
    : startMs + sh.ms;
  const ev = mkEvent(base, { dateTime: iso(startMs) }, { dateTime: iso(endMs) });
  return { startMs, endMs, key: "t" + startMs, ev };
}

function mkEvent(base, start, end) {
  return { summary: base.summary, status: base.status, start, end };
}

// A raw VEVENT prop map -> the base event, or null (with a named warning) when it
// cannot be placed in time. Recurrence-agnostic: masters, overrides and singles
// all go through here.
function toEvent(props, warnings) {
  const ds = props.DTSTART;
  if (!ds) {
    warnings.push(skipMsg(evTitle(props), "no DTSTART"));
    return null;
  }
  const start = classifyValue(ds.value, ds.params);
  if (!start) {
    warnings.push(skipMsg(evTitle(props), "unparseable DTSTART"));
    return null;
  }
  if (!start.allDay && start.zone !== "UTC" && !isValidZone(start.zone)) {
    warnings.push(skipMsg(evTitle(props), "unresolvable timezone: " + start.zone));
    return null;
  }
  const anchor = start.allDay
    ? { y: start.date.y, mo: start.date.mo, d: start.date.d }
    : { y: start.civil.y, mo: start.civil.mo, d: start.civil.d };
  const endShape = computeEndShape(start, props);
  if (endShape.err) {
    warnings.push(skipMsg(evTitle(props), endShape.err));
    return null;
  }
  const status = props.STATUS && props.STATUS.value.toUpperCase() === "CANCELLED" ? "cancelled" : "confirmed";
  return {
    summary: props.SUMMARY ? decodeText(props.SUMMARY.value) : "",
    status,
    uid: props.UID ? props.UID.value : "",
    start,
    endShape,
    anchor,
  };
}

// The instant/date key of one EXDATE or RECURRENCE-ID value, matching the key
// buildOccurrence stamps on an occurrence. null if unresolvable.
function occKey(cv) {
  if (cv.allDay) return "d" + dateStr(cv.date);
  if (cv.zone === "UTC" || isValidZone(cv.zone)) return "t" + civilToMs(cv.civil, cv.zone);
  return null;
}

// RFC 5545 §3.8.5.1 requires EXDATE's value type to match DTSTART's, but real
// producers emit a DATE-valued EXDATE against a timed series. That one is honored
// BY DATE (emitMaster also tests the candidate's "d<date>" key), matching what
// the majority of importers do — the instance the user deleted really goes away.
// The reverse, a timed EXDATE against an all-day series, names no single day to
// remove, so it is refused loudly rather than dropped on the floor.
function parseExdates(props, warnings, allDay) {
  const set = new Set();
  for (const p of props._EXDATE) {
    for (const v of p.value.split(",")) {
      const cv = classifyValue(v, p.params);
      const k = cv && occKey(cv);
      if (!k) warnings.push("unresolvable_exdate: " + v + (p.params.TZID ? " (timezone " + p.params.TZID + ")" : ""));
      else if (allDay && !cv.allDay) warnings.push("unresolvable_exdate: " + v + " (EXDATE value type does not match series)");
      else set.add(k);
    }
  }
  return set;
}

// Index override VEVENTs (those carrying RECURRENCE-ID) by UID -> set of the
// original-occurrence keys they replace, so master expansion can suppress the
// base occurrence at each moved/cancelled instance.
// UID -> whether that master series is all-day, so a RECURRENCE-ID of the wrong
// value type can be recognized instead of matching nothing.
function masterKinds(masters) {
  const map = new Map();
  for (const props of masters) {
    const ds = props.DTSTART;
    const cv = ds && classifyValue(ds.value, ds.params);
    if (cv) map.set(props.UID ? props.UID.value : "", cv.allDay);
  }
  return map;
}

function indexOverrides(overrides, warnings, kinds) {
  const map = new Map();
  for (const props of overrides) {
    const rid = props["RECURRENCE-ID"];
    const cv = rid && classifyValue(rid.value, rid.params);
    const k = cv && occKey(cv);
    if (!k) {
      const why = rid ? (rid.params.TZID ? "timezone " + rid.params.TZID : "unparseable value " + rid.value) : "missing value";
      warnings.push("unresolvable_recurrence_id: " + evTitle(props) + " (" + why + ")");
      continue;
    }
    const uid = props.UID ? props.UID.value : "";
    // §3.8.4.4 requires RECURRENCE-ID's value type to match the master DTSTART's.
    // A DATE-valued id against a timed series (or vice versa) resolves to a key of
    // the wrong kind, so it suppresses nothing and the base occurrence stays put
    // beside the override — a phantom duplicate. Matching across kinds would be
    // guesswork about WHICH instant was replaced, so the mismatch is named instead
    // and the override still emits as its own event.
    if (kinds.has(uid) && kinds.get(uid) !== cv.allDay) {
      warnings.push("unresolvable_recurrence_id: " + evTitle(props) + " (value type does not match series)");
      continue;
    }
    if (!map.has(uid)) map.set(uid, new Set());
    map.get(uid).add(k);
  }
  return map;
}

// Backstop invariant: an in-window occurrence that ends at or before it starts
// blocks nothing downstream, so it is skipped LOUDLY rather than emitted as a
// zero-width commitment. Only the point-in-time case (no DTEND, no DURATION) can
// still reach it — every other shape is validated positive at parse time.
function keep(built, base, out, warnings) {
  if (built.endMs > built.startMs) {
    out.push(built.ev);
    return true;
  }
  warnings.push(skipMsg(base.summary, "occurrence ends at or before it starts"));
  return false;
}

function emitSingle(props, winMin, winMax, out, warnings) {
  const base = toEvent(props, warnings);
  if (!base) return;
  const built = buildOccurrence(base, base.anchor);
  if (built.endMs > winMin && built.startMs < winMax) keep(built, base, out, warnings);
}

function emitMaster(props, overrideKeys, winMin, winMax, out, warnings) {
  const base = toEvent(props, warnings);
  if (!base) return;
  const rule = parseRRule(props.RRULE.value, base.start.allDay ? NY : base.start.zone);
  if (rule.unsupported) {
    warnings.push(skipMsg(base.summary, "unsupported recurrence: " + rule.unsupported));
    return;
  }
  const exdates = parseExdates(props, warnings, base.start.allDay);
  const okeys = overrideKeys.get(base.uid) || EMPTY_SET;
  let count = 0;
  let steps = 0;
  for (const cand of candidateGen(base.anchor, rule, winCeil(winMax))) {
    if (cand === OVERFLOW || ++steps > MAX_STEPS) {
      warnings.push(skipMsg(base.summary, "recurrence too large"));
      return;
    }
    if (cmpYMD(cand, base.anchor) < 0) continue; // generator may open the block before DTSTART
    count++;
    if (rule.count !== null && count > rule.count) return;
    const built = buildOccurrence(base, cand);
    if (rule.until !== null && built.startMs > rule.until) return;
    if (built.startMs >= winMax) return; // monotonic: nothing later is in-window
    // A timed series also honors a DATE-valued EXDATE by day (see parseExdates);
    // for an all-day series built.key IS the "d<date>" key, so this adds nothing.
    if (exdates.has(built.key) || exdates.has("d" + dateStr(cand)) || okeys.has(built.key)) continue;
    // One bad occurrence means a bad duration, which is a property of the whole
    // series — warn once and drop the rest rather than repeating per instance.
    if (built.endMs > winMin && !keep(built, base, out, warnings)) return;
  }
}

// Defense in depth around ONE event's emit. Every known bad value is already a
// named skip, but a whole-feed crash is the worst possible outcome here (a
// scheduler with no calendar at all), so an unforeseen throw is demoted to a skip
// of just that event. Any occurrence already pushed is rolled back, otherwise the
// "skipped" warning would be a lie. IcsError still propagates: a structural
// problem is a property of the feed, not of one VEVENT.
function guarded(emit, props, out, warnings) {
  const mark = out.length;
  try {
    emit();
  } catch (e) {
    if (e instanceof IcsError) throw e;
    out.length = mark;
    warnings.push(skipMsg(evTitle(props), "internal error: " + ((e && e.message) || e)));
  }
}

// ---------------------------------------------------------------------------
// Component collection + top-level parse
// ---------------------------------------------------------------------------

function addProp(map, p) {
  if (p.name === "EXDATE") map._EXDATE.push({ params: p.params, value: p.value });
  else map[p.name] = p; // single-valued props: last occurrence wins
}

// Walk unfolded lines, returning each top-level VEVENT's prop map plus the
// calendar-level X-WR-CALNAME / X-WR-TIMEZONE (UI defaults). VALARM props are
// suppressed so a reminder's own TRIGGER/DTSTART can't be mistaken for the
// event's; VTIMEZONE and other components are ignored (IANA zones are resolved
// via Intl).
// BEGIN:<comp> — st is the collector's mutable {cur, depth, inAlarm} state.
function beginComponent(st, comp) {
  if (comp === "VEVENT" && st.depth === 1) st.cur = { _EXDATE: [] };
  else if (st.cur && comp === "VALARM") st.inAlarm++;
  st.depth++;
}

// END:<comp> — throws on any imbalance (depth going negative, or an
// END:VEVENT with no open VEVENT to close); see collectComponents header.
function endComponent(st, comp, vevents) {
  st.depth--;
  if (st.depth < 0) throw new IcsError("unbalanced_component: END:" + comp + " with no matching BEGIN");
  if (comp === "VEVENT") {
    if (!st.cur) throw new IcsError("unbalanced_component: END:VEVENT with no matching BEGIN:VEVENT");
    vevents.push(st.cur);
    st.cur = null;
  } else if (comp === "VALARM" && st.inAlarm) st.inAlarm--;
}

// One unbalanced BEGIN:/END: anywhere in the feed must throw rather than
// silently yield 0 (or partial) events — a structurally broken feed should
// read as broken, never as a clean empty calendar.
function collectComponents(lines) {
  const vevents = [];
  let calName = null;
  let tz = null;
  const st = { cur: null, depth: 0, inAlarm: 0 };
  for (const line of lines) {
    const uline = line.toUpperCase(); // BEGIN:/END: are property names -> case-insensitive (§3.1)
    // trim(): stray whitespace around a component name (a real producer quirk)
    // must not turn BEGIN:VEVENT into an unrecognized component — the event's
    // props would be misread as calendar-level lines and the whole event would
    // vanish without a warning OR a throw (depth still balances).
    if (uline.startsWith("BEGIN:")) beginComponent(st, uline.slice(6).trim());
    else if (uline.startsWith("END:")) endComponent(st, uline.slice(4).trim(), vevents);
    else if (st.cur && !st.inAlarm) {
      const p = splitProp(line);
      if (p) addProp(st.cur, p);
    } else if (!st.cur) {
      const p = splitProp(line);
      if (p && p.name === "X-WR-CALNAME") calName = decodeText(p.value);
      else if (p && p.name === "X-WR-TIMEZONE") tz = p.value;
    }
  }
  if (st.depth !== 0) throw new IcsError("unbalanced_component: unclosed BEGIN at end of feed");
  return { vevents, calName, tz };
}

/**
 * Parse a raw .ics feed into normalized events overlapping [timeMinIso,
 * timeMaxIso] (using exclusive-end window semantics: an event is kept when its
 * end is after timeMin AND its start is before timeMax).
 *
 * @param {string} text  raw .ics feed body
 * @param {string} timeMinIso  window lower bound, an RFC3339 instant
 * @param {string} timeMaxIso  window upper bound (exclusive), an RFC3339 instant
 * @returns {{events:object[], calName:string|null, tz:string|null, warnings:string[]}}
 * @throws {IcsError}  when `text` is not an iCalendar body, or the window is unparseable
 */
export function parseIcs(text, timeMinIso, timeMaxIso) {
  if (typeof text !== "string") throw new IcsError("not_icalendar");
  // A leading UTF-8 BOM (Outlook/Windows exports carry one) would glue to the
  // first line and make a valid feed read as structurally broken.
  const lines = unfold(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  // The wrapper test runs on the first non-empty LOGICAL line, post-unfold, and
  // demands the whole line. A substring search on the raw text was wrong in both
  // directions: an error page merely QUOTING "BEGIN:VCALENDAR" mid-sentence passed
  // and returned a quietly empty calendar (every shift then looks free), while a
  // legally folded wrapper line failed.
  const first = lines.find((l) => l.trim() !== "");
  if (!first || first.trimEnd().toUpperCase() !== "BEGIN:VCALENDAR") throw new IcsError("not_icalendar");
  const winMin = Date.parse(timeMinIso);
  const winMax = Date.parse(timeMaxIso);
  if (!Number.isFinite(winMin) || !Number.isFinite(winMax)) throw new IcsError("bad_window");

  const { vevents, calName, tz } = collectComponents(lines);

  const masters = [];
  const overrides = [];
  const singles = [];
  for (const props of vevents) {
    if (props["RECURRENCE-ID"]) overrides.push(props);
    else if (props.RRULE) masters.push(props);
    else singles.push(props);
  }
  const events = [];
  const warnings = [];
  const overrideKeys = indexOverrides(overrides, warnings, masterKinds(masters));

  for (const props of singles) guarded(() => emitSingle(props, winMin, winMax, events, warnings), props, events, warnings);
  for (const props of overrides) guarded(() => emitSingle(props, winMin, winMax, events, warnings), props, events, warnings);
  for (const props of masters) guarded(() => emitMaster(props, overrideKeys, winMin, winMax, events, warnings), props, events, warnings);

  return { events, calName, tz, warnings };
}
