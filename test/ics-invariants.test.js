import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { parseIcs } from "../core/ics.js";

// Property-style companion to test/ics.test.js. That file pins KNOWN behavior on
// hand-written feeds; this one sweeps a generated matrix and asserts only what
// must hold for EVERY structurally valid feed, so it catches the cell nobody
// thought to write a case for.
//
// Everything here is SYNTHETIC (this repo is public): titles are matrix labels.
//
// Invariants asserted over the sweep:
//   I1  a timed occurrence ends strictly after it starts (all-day: end.date >
//       start.date), and both endpoints parse;
//   I2  every emitted occurrence overlaps the query window;
//   I3  a VEVENT that emits nothing produced at least one warning naming it —
//       "silently gone" is never a legal outcome for an in-window shape (the
//       legitimate empty expansions live in their own test below, so the sweep
//       is built to contain none of them);
//   I4  parseIcs never throws on structurally valid input;
//   I5  every warning is a non-empty string.
//
// Failures collect and report together with the exact generated .ics body — one
// run enumerates every violation rather than hiding 2..n behind the first.

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const p2 = (n) => String(n).padStart(2, "0");
const ymd = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`; };
const dayMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const plusDays = (s, n) => ymd(dayMs(s) + n * 86400000);

// 2026 US DST anchors: spring-forward 03-08 02:00 (02:30 wall does not exist),
// fall-back 11-01 02:00 (01:30 wall happens twice), plus a non-DST control.
// Each cell gets its OWN narrow window bracketing its anchor: it keeps the sweep
// fast (civilToMs builds a fresh Intl formatter per call) AND actually exercises
// the overlap filter, which a 17-month window never would. winMin sits two days
// BEFORE the anchor so a zero-length ("none" duration) occurrence still satisfies
// endMs > winMin and reaches its loud skip rather than falling out of the window.
const ANCHORS = [
  { tag: "spring", date: "20260308", h: 2, mi: 30 },
  { tag: "fall", date: "20261101", h: 1, mi: 30 },
  { tag: "control", date: "20260615", h: 9, mi: 0 },
];

const ZONES = [
  { tag: "ny", tzid: "America/New_York", other: "America/Los_Angeles" },
  { tag: "la", tzid: "America/Los_Angeles", other: "America/New_York" },
  { tag: "utc", utc: true, other: "America/New_York" },
  { tag: "float", other: "America/Los_Angeles" }, // no TZID, no Z -> NY civil frame
  { tag: "quoted", tzid: '"America/New_York"', other: "America/Los_Angeles" },
];

// A cross-zone DTEND is offset +12 wall hours so it stays after DTSTART under any
// pairing here (max offset spread is 8h) — the cell tests zone CONVERSION rather
// than trivially warning on an inversion.
const DURS = [
  { tag: "dtend_same", line: (a, z) => dt("DTEND", z, a.date, a.h + 10, a.mi) },
  { tag: "dtend_other", line: (a, z) => `DTEND;TZID=${z.other}:${a.date}T${p2(a.h + 12)}${p2(a.mi)}00` },
  { tag: "dtend_utc", line: (a) => `DTEND:${a.date}T${p2(a.h + 12)}${p2(a.mi)}00Z` },
  { tag: "dur_pt_h", line: () => "DURATION:PT10H" },
  { tag: "dur_pt_m", line: () => "DURATION:PT90M" },
  { tag: "dur_pt_s", line: () => "DURATION:PT3600S" },
  { tag: "dur_p1d", line: () => "DURATION:P1D" },
  { tag: "dur_p1w", line: () => "DURATION:P1W" },
  { tag: "none", line: () => null }, // RFC point-in-time -> must be skipped LOUDLY
];

const KINDS = [
  { tag: "single", rrule: null },
  { tag: "daily", rrule: "FREQ=DAILY;COUNT=5" },
  { tag: "weekly_byday", rrule: "FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4" },
  { tag: "monthly", rrule: "FREQ=MONTHLY;COUNT=2" },
];

const ALLDAY_DURS = [
  { tag: "dtend_date", line: (a) => `DTEND;VALUE=DATE:${plusDays(a.date, 3)}` },
  { tag: "absent", line: () => null },
];

function dt(name, z, date, h, mi) {
  const t = `${date}T${p2(h)}${p2(mi)}00`;
  if (z.utc) return `${name}:${t}Z`;
  if (z.tzid) return `${name};TZID=${z.tzid}:${t}`;
  return `${name}:${t}`;
}

function cal(inner) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Invariants//EN\r\n${inner}\r\nEND:VCALENDAR\r\n`;
}
function vevent(label, lines) {
  return `BEGIN:VEVENT\r\nUID:${label}\r\nSUMMARY:${label}\r\n${lines.filter(Boolean).join("\r\n")}\r\nEND:VEVENT`;
}

// Each cell is one VEVENT, one window, one label that fully identifies it.
function buildMatrix() {
  const cells = [];
  for (const a of ANCHORS) {
    const min = new Date(dayMs(a.date) - 2 * 86400000).toISOString();
    const max = new Date(dayMs(a.date) + 17 * 86400000).toISOString();
    for (const z of ZONES) {
      for (const d of DURS) {
        for (const k of KINDS) {
          const label = `${a.tag}.${z.tag}.${d.tag}.${k.tag}`;
          const body = cal(vevent(label, [
            dt("DTSTART", z, a.date, a.h, a.mi),
            d.line(a, z),
            k.rrule && `RRULE:${k.rrule}`,
          ]));
          cells.push({ label, body, min, max, mustEmit: d.tag !== "none" });
        }
      }
    }
    for (const d of ALLDAY_DURS) {
      for (const k of KINDS) {
        const label = `${a.tag}.allday.${d.tag}.${k.tag}`;
        const body = cal(vevent(label, [
          `DTSTART;VALUE=DATE:${a.date}`,
          d.line(a),
          k.rrule && `RRULE:${k.rrule}`,
        ]));
        cells.push({ label, body, min, max, mustEmit: true });
      }
    }
  }
  return cells;
}

// NY civil date of an instant — the frame all-day occurrences are resolved in.
const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const nyDate = (iso) => NY_DATE.format(new Date(Date.parse(iso)));

// ---------------------------------------------------------------------------
// 1. Invariant sweep
// ---------------------------------------------------------------------------

test("invariant sweep: every generated feed satisfies the parser contract", () => {
  const cells = buildMatrix();
  const bad = [];
  const fail = (cell, why) => bad.push(`[${cell.label}] ${why}\n--- feed ---\n${cell.body.replace(/\r/g, "")}`);
  let emitted = 0;

  for (const cell of cells) {
    let res;
    try {
      res = parseIcs(cell.body, cell.min, cell.max); // I4
    } catch (e) {
      fail(cell, `parseIcs THREW on structurally valid input: ${e && e.name}: ${e && e.message}`);
      continue;
    }
    const wMin = Date.parse(cell.min);
    const wMax = Date.parse(cell.max);
    const minDate = nyDate(cell.min);
    const maxDate = nyDate(cell.max);

    for (const w of res.warnings) { // I5
      if (typeof w !== "string" || !w.length) fail(cell, `warning is not a non-empty string: ${JSON.stringify(w)}`);
    }
    // I3 — nothing vanishes in silence.
    if (!res.events.length && !res.warnings.length) {
      fail(cell, "VEVENT produced NO event and NO warning (silent drop)");
    }
    if (cell.mustEmit && !res.events.length) {
      fail(cell, `no occurrence emitted; warnings=${JSON.stringify(res.warnings)}`);
    }

    for (const ev of res.events) {
      emitted++;
      if (ev.start.dateTime) {
        const s = Date.parse(ev.start.dateTime);
        const e = Date.parse(ev.end.dateTime);
        if (!Number.isFinite(s) || !Number.isFinite(e)) {
          fail(cell, `unparseable endpoints ${ev.start.dateTime} / ${ev.end.dateTime}`);
          continue;
        }
        if (!(e > s)) fail(cell, `I1 end <= start: ${ev.start.dateTime} -> ${ev.end.dateTime}`); // I1
        if (!(e > wMin && s < wMax)) fail(cell, `I2 outside window [${cell.min},${cell.max}): ${ev.start.dateTime} -> ${ev.end.dateTime}`); // I2
      } else {
        if (!(ev.end.date > ev.start.date)) fail(cell, `I1 all-day end <= start: ${ev.start.date} -> ${ev.end.date}`);
        if (!(ev.end.date > minDate && ev.start.date <= maxDate)) {
          fail(cell, `I2 all-day outside window [${minDate},${maxDate}]: ${ev.start.date} -> ${ev.end.date}`);
        }
      }
    }
  }

  assert.equal(bad.length, 0, `${bad.length}/${cells.length} cells violated an invariant:\n\n${bad.join("\n\n")}`);
  assert.equal(cells.length, 564, "matrix size drifted — update the expectation deliberately");
  // Exact, not a floor: a floor lets a COUNT off-by-one across the recurring
  // kinds slip through. Drift here means the matrix stopped exercising expansion
  // (or expansion changed) — either way, update it deliberately.
  assert.equal(emitted, 1386, `sweep emitted ${emitted} occurrences, expected 1386`);
});

test("sweep: the point-in-time shape is the ONLY cell that emits nothing, and it warns", () => {
  // Pins the sweep's own premise: I3 is meaningful only because every non-"none"
  // cell really does emit. If a future parser change makes another shape empty,
  // this fails alongside the sweep instead of quietly weakening it.
  for (const cell of buildMatrix().filter((c) => !c.mustEmit)) {
    const r = parseIcs(cell.body, cell.min, cell.max);
    assert.equal(r.events.length, 0, cell.label);
    assert.ok(r.warnings.some((w) => w.includes(cell.label)), `${cell.label}: warnings=${JSON.stringify(r.warnings)}`);
    assert.match(r.warnings.join("|"), /ends at or before it starts/, cell.label);
  }
});

// ---------------------------------------------------------------------------
// 2. Legitimate empty expansions — a rule that genuinely selects no in-window
// day emits nothing AND warns about nothing. Kept separate from the sweep so
// invariant I3 stays strict there instead of being blunted to "usually".
// ---------------------------------------------------------------------------

const CLEAN_EMPTY = [
  // 2026-06-01 is a Monday; the rule's first Saturday (Jun 6) is past winMax.
  ["weekly BYDAY outside a short window", "DTSTART;TZID=America/New_York:20260601T090000\r\nDTEND;TZID=America/New_York:20260601T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=SA", "2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z"],
  // BYMONTHDAY=31 selects nothing in June, and July 31 is past winMax.
  ["monthly BYMONTHDAY=31 in a 30-day month", "DTSTART;TZID=America/New_York:20260601T090000\r\nDTEND;TZID=America/New_York:20260601T100000\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31", "2026-06-01T00:00:00Z", "2026-06-30T00:00:00Z"],
  // COUNT exhausted before the window opens.
  ["COUNT exhausted before the window", "DTSTART;TZID=America/New_York:20260601T090000\r\nDTEND;TZID=America/New_York:20260601T100000\r\nRRULE:FREQ=DAILY;COUNT=2", "2026-06-10T00:00:00Z", "2026-06-20T00:00:00Z"],
];

test("a rule that selects no in-window day is a clean empty expansion, not a warning", () => {
  for (const [name, lines, min, max] of CLEAN_EMPTY) {
    const r = parseIcs(cal(vevent(name, lines.split("\r\n"))), min, max);
    assert.equal(r.events.length, 0, name);
    assert.deepEqual(r.warnings, [], `${name} warned about a legitimate empty expansion`);
  }
});

// ---------------------------------------------------------------------------
// 3. Non-silence: shapes the sweep cannot see (each either emits an event or is
// indistinguishable from a clean empty expansion) that the parser must still
// refuse LOUDLY. These four started life as characterization tests pinning
// silent drops the sweep surfaced; the parser was fixed and they now assert the
// loud behavior.
// ---------------------------------------------------------------------------

const W6 = ["2026-06-01T00:00:00Z", "2026-08-01T00:00:00Z"];

test("an out-of-range/NaN BY* part skips the rule loudly, never a clean empty feed", () => {
  // BYMONTH/BYMONTHDAY get the same non-silence rule as COUNT/UNTIL: an
  // impossible or non-numeric value would select no day, ever —
  // indistinguishable downstream from "you have nothing scheduled".
  for (const rr of ["FREQ=MONTHLY;BYMONTH=13", "FREQ=MONTHLY;BYMONTHDAY=0", "FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=MONTHLY;BYMONTHDAY=abc", "FREQ=YEARLY;BYMONTH=0"]) {
    const r = parseIcs(cal(vevent("bad-by", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", `RRULE:${rr}`])), ...W6);
    assert.equal(r.events.length, 0, rr);
    assert.equal(r.warnings.length, 1, rr);
    assert.match(r.warnings[0], /unsupported recurrence: BYMONTH(DAY)?=/, rr);
  }
  // Structurally valid parts whose intersection is merely empty (Feb 30) stay a
  // clean, warning-free empty expansion — range validation must not eat it.
  const ok = parseIcs(cal(vevent("feb30", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30"])), ...W6);
  assert.deepEqual([ok.events.length, ok.warnings.length], [0, 0]);
});

test("an all-day DTSTART with a DATE-TIME DTEND skips loudly instead of guessing one day", () => {
  const r = parseIcs(cal(vevent("mixed", ["DTSTART;VALUE=DATE:20260601", "DTEND;TZID=America/New_York:20260604T120000"])), ...W6);
  assert.equal(r.events.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /unusable DTEND on all-day event/);
});

test("an all-day DURATION is honored (nominal days); a time part or non-positive value skips loudly", () => {
  // RFC 5545 permits DURATION on a DATE-valued DTSTART, dur-day/dur-week only.
  const r = parseIcs(cal(vevent("adur", ["DTSTART;VALUE=DATE:20260601", "DURATION:P3D"])), ...W6);
  assert.deepEqual(r.events[0].end, { date: "2026-06-04" });
  assert.deepEqual(r.warnings, []);
  const t = parseIcs(cal(vevent("tdur", ["DTSTART;VALUE=DATE:20260601", "DURATION:P1DT2H"])), ...W6);
  assert.deepEqual([t.events.length, t.warnings.length], [0, 1]);
  assert.match(t.warnings[0], /time-part DURATION on all-day event/);
});

test("an inverted all-day DTEND skips loudly instead of clamping to one day", () => {
  const r = parseIcs(cal(vevent("inv", ["DTSTART;VALUE=DATE:20260604", "DTEND;VALUE=DATE:20260601"])), ...W6);
  assert.equal(r.events.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /DTEND at or before DTSTART/);
});

// ---------------------------------------------------------------------------
// 4. Termination, with a real wall-clock kill.
//
// FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30 once never returned. A regression must
// FAIL CI loudly, not wedge it — so the battery runs in a CHILD node process
// under spawnSync's timeout. The child prints one line per case as it finishes
// and spawnSync hands back buffered stdout even when the child is killed, so a
// wedge localizes to the case after the last printed line.
// ---------------------------------------------------------------------------

const BATTERY = [
  // [name, VEVENT lines, expected warning substring or null]
  ["former_hang_monthly_feb30", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30"], null],
  ["former_hang_yearly_feb30", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"], null],
  ["bymonthday_0", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=0"], null],
  ["bymonthday_32", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=32"], null],
  ["bymonthday_nan", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=abc"], null],
  ["byday_bymonthday_disjoint", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-31"], null],
  ["interval_huge_daily", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=DAILY;INTERVAL=100000000"], null],
  ["interval_huge_weekly", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=WEEKLY;INTERVAL=100000000;BYDAY=MO"], null],
  ["interval_huge_yearly", ["DTSTART;TZID=America/New_York:20260601T090000", "DTEND;TZID=America/New_York:20260601T100000", "RRULE:FREQ=YEARLY;INTERVAL=100000000"], null],
  ["far_future_daily", ["DTSTART;TZID=America/New_York:30000601T090000", "DTEND;TZID=America/New_York:30000601T100000", "RRULE:FREQ=DAILY"], null],
  ["far_past_monthly_feb30", ["DTSTART;TZID=America/New_York:10000601T090000", "DTEND;TZID=America/New_York:10000601T100000", "RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30"], null],
  // The one case that really reaches the iteration backstop: ~375k daily steps
  // from year 1000, well past MAX_STEPS, so it must warn rather than grind on.
  // Deliberately UTC: civilToMs short-circuits for UTC, whereas a zoned variant
  // builds ~4 Intl formatters for each of the 200k pre-backstop occurrences and
  // takes ~22s — real work, not a hang, but slow enough to make the wall-clock
  // kill below flaky. The backstop path exercised is identical either way.
  ["far_past_daily", ["DTSTART:10000601T090000Z", "DTEND:10000601T100000Z", "RRULE:FREQ=DAILY"], "recurrence too large"],
];

test("termination: degenerate and former-hang rules all return, under a hard wall-clock kill", () => {
  const icsUrl = new URL("../core/ics.js", import.meta.url).href;
  const cases = BATTERY.map(([name, lines]) => [name, cal(vevent(name, lines))]);
  const src = `
import { parseIcs } from ${JSON.stringify(icsUrl)};
for (const [name, body] of ${JSON.stringify(cases)}) {
  const t0 = Date.now();
  const r = parseIcs(body, "2026-06-01T00:00:00Z", "2026-08-01T00:00:00Z");
  console.log(JSON.stringify({ name, ms: Date.now() - t0, events: r.events.length, warnings: r.warnings }));
}
console.log("BATTERY_DONE");
`;
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    timeout: 30000, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = (res.stdout || "").trim().split("\n").filter(Boolean);
  const done = lines.pop();
  const seen = lines.map((l) => JSON.parse(l));
  const where = seen.length ? `last completed: ${seen[seen.length - 1].name}` : "no case completed";

  assert.equal(res.error && res.error.code, undefined, `child failed: ${res.error && res.error.message} (${where})`);
  assert.equal(res.signal, null, `child was KILLED — a rule hangs (${where})\nstderr: ${res.stderr}`);
  assert.equal(res.status, 0, `child exited ${res.status} (${where})\nstderr: ${res.stderr}`);
  assert.equal(done, "BATTERY_DONE", `battery did not finish (${where})`);
  assert.equal(seen.length, BATTERY.length, `expected ${BATTERY.length} results, got ${seen.length}`);

  for (const [i, [name, , wantWarn]] of BATTERY.entries()) {
    assert.equal(seen[i].name, name);
    if (wantWarn) {
      assert.ok(seen[i].warnings.some((w) => w.includes(wantWarn)), `${name}: expected a "${wantWarn}" warning, got ${JSON.stringify(seen[i].warnings)}`);
    }
  }
  assert.ok(Date.now() - t0 < 30000, "battery ran to the kill deadline");
});
