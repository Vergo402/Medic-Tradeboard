import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  MESSAGE_HEADER,
  fmtTime12,
  dayLetter,
  tourLetter,
  shiftLine,
  composeMessage,
} from "../core/compose.js";

// --- fmtTime12(): "HH:MM" -> 12-hour clock, passthrough on invalid input ---

const FMT_TIME_12_CASES = [
  { id: "morning_no_minutes", input: "07:00", expected: "7am" },
  { id: "evening_no_minutes", input: "19:00", expected: "7pm" },
  { id: "late_evening", input: "23:00", expected: "11pm" },
  { id: "morning_with_minutes", input: "07:30", expected: "7:30am" },
  { id: "midnight", input: "00:00", expected: "12am" },
  { id: "midnight_with_minutes", input: "00:05", expected: "12:05am" },
  { id: "noon", input: "12:00", expected: "12pm" },
  { id: "noon_with_minutes", input: "12:05", expected: "12:05pm" },
  { id: "unpadded_hour", input: "7:00", expected: "7am" },
  { id: "hour_24_passthrough", input: "24:00", expected: "24:00" },
  { id: "junk_passthrough", input: "junk", expected: "junk" },
  { id: "null_input", input: null, expected: "?" },
  { id: "undefined_input", input: undefined, expected: "?" },
];

for (const c of FMT_TIME_12_CASES) {
  test(`fmtTime12: ${c.id}`, () => {
    assert.equal(fmtTime12(c.input), c.expected);
  });
}

// --- dayLetter(): "YYYY-MM-DD" -> single-letter weekday --------------------
//
// Weekdays independently verified via Date.UTC(y, mo-1, d).getUTCDay() for
// each date below (Th/M/Su/S/F/T/W = Jul 23/27/26/25/24/21/22 2026).

const DAY_LETTER_CASES = [
  { id: "thursday", input: "2026-07-23", expected: "Th" },
  { id: "monday", input: "2026-07-27", expected: "M" },
  { id: "sunday", input: "2026-07-26", expected: "Su" },
  { id: "saturday", input: "2026-07-25", expected: "S" },
  { id: "friday", input: "2026-07-24", expected: "F" },
  { id: "tuesday", input: "2026-07-21", expected: "T" },
  { id: "wednesday", input: "2026-07-22", expected: "W" },
  { id: "garbage_input", input: "garbage", expected: "?" },
];

for (const c of DAY_LETTER_CASES) {
  test(`dayLetter: ${c.id}`, () => {
    assert.equal(dayLetter(c.input), c.expected);
  });
}

// --- tourLetter(): "D"/"N" for a shift start time ---------------------------
//
// tourLetter delegates to rowshape.js's tourOf() ([07:00, 19:00) window);
// this just pins the "D"/"N" letter mapping on top of that rule.

const TOUR_LETTER_CASES = [
  { id: "start_of_day", input: "07:00", expected: "D" },
  { id: "just_before_day", input: "06:59", expected: "N" },
  { id: "just_before_night", input: "18:59", expected: "D" },
  { id: "start_of_night", input: "19:00", expected: "N" },
  { id: "unpadded_hour_day", input: "7:00", expected: "D" },
  { id: "late_night", input: "23:00", expected: "N" },
  { id: "null_input", input: null, expected: "N" },
];

for (const c of TOUR_LETTER_CASES) {
  test(`tourLetter: ${c.id}`, () => {
    assert.equal(tourLetter(c.input), c.expected);
  });
}

// --- shiftLine(): one bullet line per shift ---------------------------------

test("shiftLine: normal day shift", () => {
  const line = shiftLine({ date: "2026-07-23", start: "07:00", end: "19:00" });
  assert.equal(line, "* Th Jul 23, D 7am-7pm");
});

test("shiftLine: overnight shift gets no next-day marker", () => {
  const line = shiftLine({ date: "2026-07-27", start: "23:00", end: "06:00" });
  assert.equal(line, "* M Jul 27, N 11pm-6am");
});

// --- MESSAGE_HEADER: exact literal -----------------------------------------

test("MESSAGE_HEADER is the exact literal string", () => {
  assert.equal(MESSAGE_HEADER, "Available Medic Shifts:");
});

// --- composeMessage(): golden byte-exact output -----------------------------

test("composeMessage: golden case, unsorted input sorted ascending by date+start", () => {
  const shifts = [
    { date: "2026-07-27", start: "23:00", end: "06:00" },
    { date: "2026-07-23", start: "07:00", end: "19:00" },
  ];
  const result = composeMessage(shifts);
  assert.equal(
    result,
    "Available Medic Shifts:\n\n* Th Jul 23, D 7am-7pm\n* M Jul 27, N 11pm-6am"
  );
});

test("composeMessage: empty array produces exactly the header, no trailing newline", () => {
  const result = composeMessage([]);
  assert.equal(result, "Available Medic Shifts:");
  assert.equal(result.endsWith("\n"), false);
});

test("composeMessage: does not mutate the input array", () => {
  const shifts = [
    { date: "2026-07-27", start: "23:00", end: "06:00" },
    { date: "2026-07-23", start: "07:00", end: "19:00" },
  ];
  const snapshot = JSON.parse(JSON.stringify(shifts));
  composeMessage(shifts);
  assert.deepEqual(shifts, snapshot);
});

test("composeMessage: same-day shifts sort by start time ascending", () => {
  const shifts = [
    { date: "2026-07-23", start: "19:00", end: "23:00" },
    { date: "2026-07-23", start: "07:00", end: "12:00" },
  ];
  const result = composeMessage(shifts);
  const lines = result.split("\n\n")[1].split("\n");
  assert.deepEqual(lines, [
    "* Th Jul 23, D 7am-12pm",
    "* Th Jul 23, N 7pm-11pm",
  ]);
});

test("composeMessage: stable sort keeps input order for identical date+start ties", () => {
  const shifts = [
    { date: "2026-07-23", start: "07:00", end: "19:00", label: "first" },
    { date: "2026-07-23", start: "07:00", end: "15:00", label: "second" },
  ];
  const result = composeMessage(shifts);
  const lines = result.split("\n\n")[1].split("\n");
  assert.deepEqual(lines, [
    "* Th Jul 23, D 7am-7pm",
    "* Th Jul 23, D 7am-3pm",
  ]);
});
