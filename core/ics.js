/**
 * core/ics.js — iCalendar (RFC 5545) feed parser for the Medic Tradeboard.
 *
 * Converts a raw .ics feed into the SAME event objects the old Google Calendar
 * REST path produced, so everything below buildTriplet (the scorer, the drawer,
 * the title picker) stays byte-for-byte unchanged. Emitted events are
 * Google-shaped:
 *
 *     { summary, status, start:{dateTime}|{date}, end:{dateTime}|{date} }
 *
 * A timed start/end.dateTime is always a UTC "…Z" RFC3339 string — buildTriplet
 * runs Date.parse on it and re-expresses it in NY civil time, so the source
 * timezone is fully resolved here and never leaks downstream. An all-day date
 * keeps Google's exclusive-end convention (end.date is the day AFTER the last
 * day). One parser covers Google, iCloud, Aladtec and any RFC 5545 feed.
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
// magnitude above any real feed and only trips on corruption.
const MAX_STEPS = 200000;

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

// "NAME;PARAM=v;PARAM2=v2:VALUE" -> { name, params, value }. Split at the FIRST
// colon (the name/value separator); the value keeps any later colons (URLs etc.).
function splitProp(line) {
  const ci = line.indexOf(":");
  if (ci === -1) return null;
  const segs = line.slice(0, ci).split(";");
  const params = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf("=");
    if (eq > -1) params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1);
  }
  return { name: segs[0].toUpperCase(), params, value: line.slice(ci + 1) };
}

function parseDateOnly(v) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}
function parseDateTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], utc: m[7] === "Z" };
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

// ISO 8601 duration (PT10H, P1D, P1DT2H30M, -PT1H, PT0S) -> signed milliseconds,
// or null. Days/weeks are treated as fixed 24h/168h — a safety fallback for
// feeds that use DURATION instead of DTEND (Google and Aladtec use neither).
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || "");
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const secs = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400) + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0);
  return sign * secs * 1000;
}

// ---------------------------------------------------------------------------
// RRULE
// ---------------------------------------------------------------------------

function untilToMs(v) {
  const dt = parseDateTime(v);
  if (dt) return dt.utc ? Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s) : civilToMs(dt, NY);
  const d = parseDateOnly(v);
  // Date-only UNTIL is inclusive through that whole day (NY frame).
  if (d) return civilToMs({ y: d.y, mo: d.mo, d: d.d, h: 23, mi: 59, s: 59 }, NY);
  return null;
}

function parseByday(rule, v) {
  const out = [];
  for (const tok of v.split(",")) {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.trim());
    if (!m) return "BYDAY=" + tok;
    out.push({ ord: m[1] ? parseInt(m[1], 10) : null, day: WD[m[2]] });
  }
  rule.byday = out;
  return null;
}

// Fold one recognized RRULE part into `rule`; return a reason string if the part
// is malformed, else null.
function applyRulePart(rule, k, v) {
  if (k === "FREQ") rule.freq = v.toUpperCase();
  else if (k === "INTERVAL") rule.interval = Math.max(1, parseInt(v, 10) || 1);
  else if (k === "COUNT") rule.count = parseInt(v, 10);
  else if (k === "UNTIL") rule.until = untilToMs(v);
  else if (k === "WKST") rule.wkst = v.toUpperCase();
  else if (k === "BYMONTH") rule.bymonth = v.split(",").map(Number);
  else if (k === "BYMONTHDAY") rule.bymonthday = v.split(",").map(Number);
  else if (k === "BYDAY") return parseByday(rule, v);
  return null;
}

/**
 * Parse an RRULE value into a structured rule, or {unsupported:"<why>"} when it
 * uses a part or FREQ the expander does not implement. `<why>` names the exact
 * offender so the skip warning is actionable.
 */
function parseRRule(value) {
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
    const bad = applyRulePart(rule, k, part.slice(eq + 1));
    if (bad) return { unsupported: bad };
  }
  if (!RRULE_FREQS.has(rule.freq)) return { unsupported: "FREQ=" + rule.freq };
  return rule;
}

// ---------------------------------------------------------------------------
// Occurrence-date generators (each yields {y,mo,d} in ascending order; the
// caller bounds them by COUNT/UNTIL/window and the MAX_STEPS guard)
// ---------------------------------------------------------------------------

function* genDaily(start, interval) {
  let c = { ...start };
  for (;;) {
    yield c;
    c = addDaysYMD(c, interval);
  }
}

function weekStart(c, wkstDay) {
  const wd = weekdayOf(c.y, c.mo, c.d);
  return addDaysYMD(c, -((wd - wkstDay + 7) % 7));
}

function* genWeekly(start, interval, byday, wkst) {
  const wkstDay = wkst in WD ? WD[wkst] : 1;
  const days = byday && byday.length ? byday.map((b) => b.day) : [weekdayOf(start.y, start.mo, start.d)];
  const offsets = [...new Set(days.map((d) => (d - wkstDay + 7) % 7))].sort((a, b) => a - b);
  let block = weekStart(start, wkstDay);
  for (;;) {
    for (const off of offsets) yield addDaysYMD(block, off);
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

// The sorted, in-range day numbers a monthly/yearly rule selects within one
// month: BYDAY (ordinal or every-weekday) wins, else BYMONTHDAY (negative =
// from month end), else the series' own start day-of-month.
function monthDays(y, mo, rule, startDay) {
  let days;
  if (rule.byday) {
    days = [];
    for (const b of rule.byday) {
      if (b.ord === null) {
        for (let d = 1; d <= daysInMonth(y, mo); d++) if (weekdayOf(y, mo, d) === b.day) days.push(d);
      } else {
        const d = nthWeekday(y, mo, b.day, b.ord);
        if (d) days.push(d);
      }
    }
  } else if (rule.bymonthday) {
    days = rule.bymonthday.map((d) => (d < 0 ? daysInMonth(y, mo) + 1 + d : d));
  } else {
    days = [startDay];
  }
  const dim = daysInMonth(y, mo);
  return [...new Set(days)].filter((d) => d >= 1 && d <= dim).sort((a, b) => a - b);
}

function* genMonthly(start, rule) {
  let ym = { y: start.y, mo: start.mo };
  for (;;) {
    if (!rule.bymonth || rule.bymonth.includes(ym.mo)) {
      for (const d of monthDays(ym.y, ym.mo, rule, start.d)) yield { y: ym.y, mo: ym.mo, d };
    }
    ym = addMonths(ym.y, ym.mo, rule.interval);
  }
}

function* genYearly(start, rule) {
  const months = [...(rule.bymonth || [start.mo])].sort((a, b) => a - b);
  let y = start.y;
  for (;;) {
    for (const mo of months) for (const d of monthDays(y, mo, rule, start.d)) yield { y, mo, d };
    y += rule.interval;
  }
}

function candidateGen(start, rule) {
  if (rule.freq === "DAILY") return genDaily(start, rule.interval);
  if (rule.freq === "WEEKLY") return genWeekly(start, rule.interval, rule.byday, rule.wkst);
  if (rule.freq === "MONTHLY") return genMonthly(start, rule);
  return genYearly(start, rule);
}

// ---------------------------------------------------------------------------
// Event assembly
// ---------------------------------------------------------------------------

function evTitle(props) {
  return props.SUMMARY ? props.SUMMARY.value : "(untitled)";
}
function skipMsg(title, why) {
  return `skipped_event: "${title || "(untitled)"}" (${why})`;
}

// The event's nominal end, resolved per occurrence:
//   all-day  -> { kind:"days", n }        (DTEND is exclusive; absent -> +1 day)
//   DTEND    -> { kind:"wall", ms }        (wall duration, re-resolved each occ)
//   DURATION -> { kind:"fixed", ms }       (fixed offset from each occ start)
//   neither  -> { kind:"fixed", ms:0 }     (RFC point-in-time / zero length)
function computeEndShape(start, props) {
  if (start.allDay) {
    let n = 1;
    if (props.DTEND) {
      const e = classifyValue(props.DTEND.value, props.DTEND.params);
      if (e && e.allDay) n = dayDiff(start.date, e.date);
    }
    return { kind: "days", n: n >= 1 ? n : 1 };
  }
  if (props.DTEND) {
    const e = classifyValue(props.DTEND.value, props.DTEND.params);
    if (e && !e.allDay) {
      const s = start.civil, ec = e.civil;
      const ms = Date.UTC(ec.y, ec.mo - 1, ec.d, ec.h, ec.mi, ec.s) -
        Date.UTC(s.y, s.mo - 1, s.d, s.h, s.mi, s.s);
      return { kind: "wall", ms: ms >= 0 ? ms : 0 };
    }
  }
  if (props.DURATION) {
    const d = parseDuration(props.DURATION.value);
    if (d !== null) return { kind: "fixed", ms: d >= 0 ? d : 0 };
  }
  return { kind: "fixed", ms: 0 };
}

// Build one concrete occurrence (Google-shaped event + instant bounds + the
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
  const startCivil = { y: cand.y, mo: cand.mo, d: cand.d, h: sc.h, mi: sc.mi, s: sc.s };
  const startMs = civilToMs(startCivil, zone);
  const endMs = base.endShape.kind === "wall"
    ? civilToMs(shiftWall(startCivil, base.endShape.ms), zone)
    : startMs + base.endShape.ms;
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
  const status = props.STATUS && props.STATUS.value.toUpperCase() === "CANCELLED" ? "cancelled" : "confirmed";
  return {
    summary: props.SUMMARY ? props.SUMMARY.value : "",
    status,
    uid: props.UID ? props.UID.value : "",
    start,
    endShape: computeEndShape(start, props),
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

function parseExdates(props) {
  const set = new Set();
  for (const p of props._EXDATE) {
    for (const v of p.value.split(",")) {
      const cv = classifyValue(v, p.params);
      const k = cv && occKey(cv);
      if (k) set.add(k);
    }
  }
  return set;
}

// Index override VEVENTs (those carrying RECURRENCE-ID) by UID -> set of the
// original-occurrence keys they replace, so master expansion can suppress the
// base occurrence at each moved/cancelled instance.
function indexOverrides(overrides) {
  const map = new Map();
  for (const props of overrides) {
    const rid = props["RECURRENCE-ID"];
    const cv = rid && classifyValue(rid.value, rid.params);
    const k = cv && occKey(cv);
    if (!k) continue;
    const uid = props.UID ? props.UID.value : "";
    if (!map.has(uid)) map.set(uid, new Set());
    map.get(uid).add(k);
  }
  return map;
}

function emitSingle(props, winMin, winMax, out, warnings) {
  const base = toEvent(props, warnings);
  if (!base) return;
  const built = buildOccurrence(base, base.anchor);
  if (built.endMs > winMin && built.startMs < winMax) out.push(built.ev);
}

function emitMaster(props, overrideKeys, winMin, winMax, out, warnings) {
  const base = toEvent(props, warnings);
  if (!base) return;
  const rule = parseRRule(props.RRULE.value);
  if (rule.unsupported) {
    warnings.push(skipMsg(base.summary, "unsupported recurrence: " + rule.unsupported));
    return;
  }
  const exdates = parseExdates(props);
  const okeys = overrideKeys.get(base.uid) || EMPTY_SET;
  let count = 0;
  let steps = 0;
  for (const cand of candidateGen(base.anchor, rule)) {
    if (++steps > MAX_STEPS) {
      warnings.push(skipMsg(base.summary, "recurrence too large"));
      return;
    }
    if (cmpYMD(cand, base.anchor) < 0) continue; // generator may open the block before DTSTART
    count++;
    if (rule.count !== null && count > rule.count) return;
    const built = buildOccurrence(base, cand);
    if (rule.until !== null && built.startMs > rule.until) return;
    if (built.startMs >= winMax) return; // monotonic: nothing later is in-window
    if (exdates.has(built.key) || okeys.has(built.key)) continue;
    if (built.endMs > winMin && built.startMs < winMax) out.push(built.ev);
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
function collectComponents(lines) {
  const vevents = [];
  let calName = null;
  let tz = null;
  let cur = null;
  let depth = 0;
  let inAlarm = 0;
  for (const line of lines) {
    if (line.startsWith("BEGIN:")) {
      const comp = line.slice(6).toUpperCase();
      if (comp === "VEVENT" && depth === 1) cur = { _EXDATE: [] };
      else if (cur && comp === "VALARM") inAlarm++;
      depth++;
    } else if (line.startsWith("END:")) {
      const comp = line.slice(4).toUpperCase();
      if (comp === "VEVENT" && cur) {
        vevents.push(cur);
        cur = null;
      } else if (comp === "VALARM" && inAlarm) inAlarm--;
      depth--;
    } else if (cur && !inAlarm) {
      const p = splitProp(line);
      if (p) addProp(cur, p);
    } else if (!cur) {
      const p = splitProp(line);
      if (p && p.name === "X-WR-CALNAME") calName = p.value;
      else if (p && p.name === "X-WR-TIMEZONE") tz = p.value;
    }
  }
  return { vevents, calName, tz };
}

/**
 * Parse a raw .ics feed into Google-shaped events overlapping [timeMinIso,
 * timeMaxIso] (the same exclusive-end window semantics Google's singleEvents
 * REST call uses: an event is kept when its end is after timeMin AND its start
 * is before timeMax).
 *
 * @param {string} text  raw .ics feed body
 * @param {string} timeMinIso  window lower bound, an RFC3339 instant
 * @param {string} timeMaxIso  window upper bound (exclusive), an RFC3339 instant
 * @returns {{events:object[], calName:string|null, tz:string|null, warnings:string[]}}
 * @throws {IcsError}  when `text` is not an iCalendar body, or the window is unparseable
 */
export function parseIcs(text, timeMinIso, timeMaxIso) {
  if (typeof text !== "string" || text.indexOf("BEGIN:VCALENDAR") === -1) {
    throw new IcsError("not_icalendar");
  }
  const winMin = Date.parse(timeMinIso);
  const winMax = Date.parse(timeMaxIso);
  if (!Number.isFinite(winMin) || !Number.isFinite(winMax)) throw new IcsError("bad_window");

  const { vevents, calName, tz } = collectComponents(unfold(text));

  const masters = [];
  const overrides = [];
  const singles = [];
  for (const props of vevents) {
    if (props["RECURRENCE-ID"]) overrides.push(props);
    else if (props.RRULE) masters.push(props);
    else singles.push(props);
  }
  const overrideKeys = indexOverrides(overrides);

  const events = [];
  const warnings = [];
  for (const props of singles) emitSingle(props, winMin, winMax, events, warnings);
  for (const props of overrides) emitSingle(props, winMin, winMax, events, warnings);
  for (const props of masters) emitMaster(props, overrideKeys, winMin, winMax, events, warnings);

  return { events, calName, tz, warnings };
}
