/**
 * America/New_York civil-time <-> epoch conversions, mirroring Python's
 * datetime/ZoneInfo semantics.
 *
 * A "civil" value is a plain object {y, mo, d, h, mi} (mo is 1-12) representing
 * wall-clock fields in America/New_York, with NO epoch/offset baked in yet -
 * exactly the state Python has right after `datetime.strptime(...)`, before
 * `.replace(tzinfo=ZoneInfo(...))` resolves it to an instant.
 *
 * toEpoch() resolves civil -> instant the same way Python's
 * `datetime(..., tzinfo=ZoneInfo("America/New_York")).timestamp()` does with
 * fold=0 (the default fold): on the ambiguous fall-back hour, fold=0 picks the
 * EARLIER (still-DST) instant; on the spring-forward gap, fold=0 resolves using
 * the offset that was in effect immediately BEFORE the gap. See PEP 495 for why
 * "before the transition" is the fold=0 rule for gaps specifically.
 */

const TZ = "America/New_York";
const DAY_MS = 24 * 3600 * 1000;
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, mo) {
  const dim = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dim[mo - 1];
}

/**
 * Parse "YYYY-MM-DD HH:MM" into a civil object. Strict: mirrors
 * datetime.strptime(s, "%Y-%m-%d %H:%M") semantics (1-2 digit month/day/
 * hour/minute accepted like strptime's %m/%d/%H/%M, but out-of-range values
 * and malformed strings raise, matching strptime's ValueError).
 * @param {string} s
 * @returns {{y:number, mo:number, d:number, h:number, mi:number}}
 */
export function parseCivil(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m) {
    throw new Error(`time data '${s}' does not match format '%Y-%m-%d %H:%M'`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (mo < 1 || mo > 12) {
    throw new Error(`time data '${s}' does not match format '%Y-%m-%d %H:%M'`);
  }
  if (d < 1 || d > daysInMonth(y, mo)) {
    throw new Error(`day ${d} must be in range 1..${daysInMonth(y, mo)} for month ${mo} in year ${y}`);
  }
  if (h > 23) {
    throw new Error(`time data '${s}' does not match format '%Y-%m-%d %H:%M'`);
  }
  if (mi > 59) {
    throw new Error(`unconverted data remains for '${s}'`);
  }
  return { y, mo, d, h, mi };
}

/**
 * NY UTC offset (minutes, e.g. -240 for EDT, -300 for EST) in effect at a
 * given UTC instant, derived by formatting the instant in America/New_York
 * and diffing against the instant itself. No hardcoded -4/-5.
 * @param {number} epochMs
 */
function tzOffsetMinutes(epochMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return Math.round((asUTC - epochMs) / 60000);
}

function civilEquals(a, b) {
  return a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi;
}

/**
 * Resolve a civil NY wall-clock time to the civil fields observed at a given
 * epoch instant (used internally to round-trip-check toEpoch candidates and
 * by openTourInGap in score.js to recover a gap boundary's calendar date).
 * @param {number} epochSeconds
 * @returns {{y:number, mo:number, d:number, h:number, mi:number}}
 */
export function civilFromEpoch(epochSeconds) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(epochSeconds * 1000))) map[p.type] = p.value;
  let h = Number(map.hour);
  if (h === 24) h = 0; // guard against the old ICU h23-midnight-as-24 quirk
  return { y: Number(map.year), mo: Number(map.month), d: Number(map.day), h, mi: Number(map.minute) };
}

/**
 * Civil NY wall-clock -> POSIX seconds, matching Python's
 * datetime(..., tzinfo=ZoneInfo("America/New_York")).timestamp() with fold=0.
 * @param {{y:number, mo:number, d:number, h:number, mi:number}} civil
 * @returns {number} POSIX seconds
 */
export function toEpoch(civil) {
  const { y, mo, d, h, mi } = civil;
  // Civil fields read as if they were UTC - not an instant yet, just a
  // reference point close (within a day) to the true instant, used to probe
  // the offsets actually in effect around this civil moment.
  const guessMs = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offBefore = tzOffsetMinutes(guessMs - DAY_MS);
  const offAfter = tzOffsetMinutes(guessMs + DAY_MS);
  const candidates = [...new Set([offBefore, offAfter])];

  const roundTrips = [];
  for (const offMin of candidates) {
    // NY_local = UTC + offset  =>  UTC = NY_local - offset
    const epochMs = guessMs - offMin * 60000;
    const rt = civilFromEpoch(Math.round(epochMs / 1000));
    if (civilEquals(rt, civil)) roundTrips.push(epochMs);
  }

  if (roundTrips.length >= 1) {
    // Exactly one candidate round-trips in the normal case. In the ambiguous
    // fall-back hour both round-trip; fold=0 takes the EARLIER (EDT) instant,
    // which is the smaller of the two candidate epochs.
    return Math.min(...roundTrips) / 1000;
  }

  // Neither round-trips: spring-forward gap. fold=0 resolves using the offset
  // in effect immediately BEFORE the transition (offBefore).
  return (guessMs - offBefore * 60000) / 1000;
}

/**
 * Pure civil calendar-day arithmetic (DST-agnostic wall-clock math), mirroring
 * Python's `aware_datetime + timedelta(days=n)`: the delta is applied to the
 * naive wall-clock fields only; the same tzinfo is reattached and only
 * reinterpreted (for offset purposes) later, at toEpoch() time.
 * @param {{y:number, mo:number, d:number, h:number, mi:number}} civil
 * @param {number} n
 */
export function addDays(civil, n) {
  const ms = Date.UTC(civil.y, civil.mo - 1, civil.d, civil.h, civil.mi) + n * DAY_MS;
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
  };
}

/**
 * Pure civil wall-clock-hour arithmetic. Same DST-agnostic semantics as
 * addDays: this is deliberately NOT epoch + n*3600, because a civil "14 hour
 * tour" that starts before a fall-back transition and ends after it spans 15
 * REAL hours, and openTourInGap in score.js relies on that (the civil
 * t1 + timedelta(hours=duration) is naive-field arithmetic in Python).
 * @param {{y:number, mo:number, d:number, h:number, mi:number}} civil
 * @param {number} n
 */
export function addHours(civil, n) {
  const ms = Date.UTC(civil.y, civil.mo - 1, civil.d, civil.h, civil.mi) + n * 3600 * 1000;
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
  };
}

/**
 * Decompose a non-negative finite double x into BigInt mantissa/exponent such
 * that x === mantissa * 2^e exactly (standard IEEE-754 binary64 decomposition).
 */
function decomposeDouble(x) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  const mantHi = hi & 0xfffff;
  let mantissa = (BigInt(mantHi) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) {
    e = -1074; // subnormal
  } else {
    mantissa |= 1n << 52n; // implicit leading bit
    e = exp - 1075; // bias 1023 + 52 mantissa bits
  }
  return { mantissa, e };
}

/**
 * Round to 1 decimal place with EXACT round-half-to-even on the double's true
 * binary value - i.e. Python-faithful round(x, 1). A naive `Math.round(x*10)/10`
 * is wrong two different ways: (a) it round-half-*up*s ties instead of to-even,
 * and (b) `x*10` can itself introduce float noise that manufactures or hides a
 * tie that isn't really there (e.g. round(12.35, 1) is 12.3 in Python, not
 * 12.4, because the double nearest to 12.35 is actually just under it - not a
 * genuine tie at all). Decomposing to BigInt mantissa*2^e and doing the half
 * comparison in exact integer arithmetic sidesteps both problems.
 * @param {number} x
 */
function round1(x) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const neg = x < 0;
  const { mantissa, e } = decomposeDouble(Math.abs(x));

  let tenths;
  if (e >= 0) {
    // x*10 is an exact integer already; no rounding decision needed.
    tenths = mantissa * 10n * (1n << BigInt(e));
  } else {
    const numerator = mantissa * 10n;
    const denominator = 1n << BigInt(-e);
    const q = numerator / denominator;
    const r = numerator % denominator;
    const twiceR = r * 2n;
    if (twiceR < denominator) {
      tenths = q;
    } else if (twiceR > denominator) {
      tenths = q + 1n;
    } else {
      tenths = q % 2n === 0n ? q : q + 1n; // exact tie -> round to even
    }
  }
  const result = Number(tenths) / 10;
  return neg ? -result : result;
}

/**
 * True elapsed hours from instant a to instant b, rounded to 1 decimal with
 * Python-faithful round-half-to-even. Computed directly from epoch seconds
 * (not wall-clock civil fields), so a gap spanning a DST transition counts
 * its real elapsed time rather than the wall-clock-dropped/added time.
 * @param {number} aEpoch POSIX seconds
 * @param {number} bEpoch POSIX seconds
 */
export function hours(aEpoch, bEpoch) {
  return round1((bEpoch - aEpoch) / 3600);
}

/**
 * "%a %m/%d %H:%M" - e.g. "Sun 11/01 19:00". Weekday is computed from the
 * civil calendar date directly (Zeller-equivalent via Date.UTC), matching
 * Python's %a (Mon..Sun) under the C/en_US locale.
 * @param {{y:number, mo:number, d:number, h:number, mi:number}} civil
 */
export function fmt(civil) {
  const wd = WEEKDAY_ABBR[new Date(Date.UTC(civil.y, civil.mo - 1, civil.d)).getUTCDay()];
  return `${wd} ${pad2(civil.mo)}/${pad2(civil.d)} ${pad2(civil.h)}:${pad2(civil.mi)}`;
}

/**
 * "%H:%M".
 * @param {{y:number, mo:number, d:number, h:number, mi:number}} civil
 */
export function fmtHM(civil) {
  return `${pad2(civil.h)}:${pad2(civil.mi)}`;
}
