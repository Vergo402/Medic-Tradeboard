import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseCivil, toEpoch, addDays, addHours, hours, fmt, fmtHM } from "../core/nytime.js";

// --- toEpoch: DST tripwire pins ---------------------------------------------
//
// Cross-checked against .venv/bin/python:
//   from datetime import datetime; from zoneinfo import ZoneInfo
//   datetime(2026,11,1,1,30,tzinfo=ZoneInfo("America/New_York")).timestamp()
//     -> 1793511000.0   (fold=0, ambiguous fall-back hour -> EARLIER/EDT instant)
//   datetime(2026,3,8,2,30,tzinfo=ZoneInfo("America/New_York")).timestamp()
//     -> 1772955000.0   (fold=0, spring-forward gap -> pre-transition/EST offset)
//   datetime(2026,7,20,12,0,tzinfo=ZoneInfo("America/New_York")).timestamp()
//     -> 1784563200.0   (normal instant, EDT)

test("toEpoch: fall-back ambiguous hour resolves fold=0 (earlier, EDT) instant", () => {
  const civil = parseCivil("2026-11-01 01:30");
  const got = toEpoch(civil);
  const expected = Date.UTC(2026, 10, 1, 5, 30) / 1000; // 01:30 EDT (UTC-4) -> 05:30Z
  assert.equal(got, expected);
  assert.equal(got, 1793511000);
});

test("toEpoch: spring-forward gap resolves fold=0 (pre-transition, EST) offset", () => {
  const civil = parseCivil("2026-03-08 02:30");
  const got = toEpoch(civil);
  const expected = Date.UTC(2026, 2, 8, 7, 30) / 1000; // 02:30 "EST" (UTC-5, the gap's pre-transition offset) -> 07:30Z
  assert.equal(got, expected);
  assert.equal(got, 1772955000);
});

test("toEpoch: normal instant (no DST edge)", () => {
  const civil = parseCivil("2026-07-20 12:00");
  const got = toEpoch(civil);
  const expected = Date.UTC(2026, 6, 20, 16, 0) / 1000; // 12:00 EDT (UTC-4) -> 16:00Z
  assert.equal(got, expected);
  assert.equal(got, 1784563200);
});

// --- hours(): Python-faithful round-half-to-even at 1 decimal --------------
//
// Genuine binary ties only occur at exact quarter-hour boundaries (x.25/x.75),
// since S/3600 lands exactly on a power-of-2 denominator only when S is a
// multiple of 900 seconds. Cross-checked against .venv/bin/python:
//   round(900/3600, 1)  == round(0.25, 1)  == 0.2   (tie -> even: 2)
//   round(2700/3600, 1) == round(0.75, 1)  == 0.8   (tie -> even: 8)

const ROUND_HALF_EVEN_CASES = [
  { id: "12h15m gap -> 0.25h ties to 0.2 (even)", seconds: 900, expected: 0.2 },
  { id: "45m gap -> 0.75h ties to 0.8 (even)", seconds: 2700, expected: 0.8 },
];

for (const c of ROUND_HALF_EVEN_CASES) {
  test(`hours(): round-half-to-even - ${c.id}`, () => {
    assert.equal(hours(0, c.seconds), c.expected);
  });
}

test("hours(): float-noise near-tie is NOT a tie (matches Python round(12.35,1) == 12.3)", () => {
  // 44460/3600 == 12.35 mathematically, but the nearest double to 12.35 is
  // actually a hair under it, so this is an ordinary round-down, not a
  // round-half-even tie. Guards against a naive `x*10` scale-and-round
  // implementation that would manufacture a false tie here.
  assert.equal(hours(0, 44460), 12.3);
});

test("hours(): whole-hour gaps report a clean .0", () => {
  assert.equal(hours(0, 14 * 3600), 14.0);
  assert.equal(hours(0, 26 * 3600), 26.0);
});

// --- fmt / fmtHM -------------------------------------------------------------

test("fmt(): weekday + zero-padding matches Python's %a %m/%d %H:%M", () => {
  assert.equal(fmt({ y: 2026, mo: 11, d: 1, h: 19, mi: 0 }), "Sun 11/01 19:00");
  assert.equal(fmt({ y: 2026, mo: 7, d: 20, h: 8, mi: 0 }), "Mon 07/20 08:00");
  // single-digit month/day/hour/minute all present -> exercises zero-padding
  assert.equal(fmt({ y: 2026, mo: 7, d: 5, h: 9, mi: 5 }), "Sun 07/05 09:05");
});

test("fmtHM(): %H:%M zero-padded", () => {
  assert.equal(fmtHM({ y: 2026, mo: 7, d: 5, h: 9, mi: 5 }), "09:05");
  assert.equal(fmtHM({ y: 2026, mo: 11, d: 1, h: 0, mi: 0 }), "00:00");
});

// --- addDays / addHours: civil wall-clock arithmetic, DST-agnostic ---------

test("addDays(): pure calendar-day increment, crosses month/year boundaries", () => {
  assert.deepEqual(addDays({ y: 2026, mo: 12, d: 31, h: 23, mi: 30 }, 1), {
    y: 2027,
    mo: 1,
    d: 1,
    h: 23,
    mi: 30,
  });
});

test("addHours(): CIVIL wall-clock add across fall-back spans an extra REAL hour", () => {
  // 19:00 EDT the evening before fall-back, +12 civil hours -> nominally 07:00
  // the next civil day. Because Nov 1 2026 has 25 wall hours, the REAL elapsed
  // time from instant to instant is 13h, not 12h - this is exactly what
  // open_tour_in_gap in score.js depends on to fully contain a 26h real gap
  // with a nominally-12h tour.
  const t1 = parseCivil("2026-10-31 19:00");
  const t2 = addHours(t1, 12);
  assert.deepEqual(t2, { y: 2026, mo: 11, d: 1, h: 7, mi: 0 });
  const realHours = (toEpoch(t2) - toEpoch(t1)) / 3600;
  assert.equal(realHours, 13);
});

// --- parseCivil: strict, mirrors strptime("%Y-%m-%d %H:%M") ----------------

test("parseCivil(): valid strings round-trip to the expected civil fields", () => {
  assert.deepEqual(parseCivil("2026-07-20 09:05"), { y: 2026, mo: 7, d: 20, h: 9, mi: 5 });
  assert.deepEqual(parseCivil("2024-02-29 10:00"), { y: 2024, mo: 2, d: 29, h: 10, mi: 0 }); // leap day
});

test("parseCivil(): rejects a non-leap-year Feb 29 (matches strptime's ValueError)", () => {
  assert.throws(() => parseCivil("2026-02-29 10:00"));
});

test("parseCivil(): rejects malformed input (wrong separator / trailing data)", () => {
  assert.throws(() => parseCivil("2026-07-20T09:05"));
  assert.throws(() => parseCivil("2026-07-20 09:05:00"));
});
