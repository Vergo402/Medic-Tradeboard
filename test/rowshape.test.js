import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  tourOf, goneLabel, loc, posShort, tierClass, sortkey,
  rejectChipLabel, DEFAULT_COMMITMENT_LABEL,
} from "../core/rowshape.js";

// --- tourOf(): the extension's [07:00, 19:00) Day/Night boundary rule -------
//
// DELIBERATE DIVERGENCE from a literal `start == "07:00"` check (see
// rowshape.js's tourOf doc comment for the full rule). This is the single
// source of truth for the Day/Night boundary; compose.js's tourLetter()
// delegates to it rather than re-deriving the rule.

const TOUR_OF_CASES = [
  { id: "just_before_day", input: "06:59", expected: "Night" },
  { id: "start_of_day", input: "07:00", expected: "Day" },
  { id: "noon", input: "12:00", expected: "Day" },
  { id: "just_before_night", input: "18:59", expected: "Day" },
  { id: "start_of_night", input: "19:00", expected: "Night" },
  { id: "late_night", input: "23:00", expected: "Night" },
  { id: "midnight", input: "00:00", expected: "Night" },
  { id: "unpadded_hour_lenient", input: "7:00", expected: "Day" },
  { id: "null_input", input: null, expected: "Night" },
  { id: "empty_string", input: "", expected: "Night" },
  { id: "junk", input: "junk", expected: "Night" },
  { id: "hour_24_out_of_range", input: "24:00", expected: "Night" },
];

for (const c of TOUR_OF_CASES) {
  test(`tourOf: ${c.id}`, () => {
    assert.equal(tourOf(c.input), c.expected);
  });
}

// --- goneLabel(): tour component now sourced from tourOf() ------------------
//
// A literal `start == "07:00"` check would send "07:30" to Night; tourOf()'s
// [07:00, 19:00) window sends it to Day. This is a real, intentional
// behavior difference -- pinned here as the NEW row.

const GONE_LABEL_CASES = [
  {
    id: "exact_0700_still_day",
    entry: { date: "2026-10-01", start: "07:00", position: "35 Medic 1" },
    expected: "Oct 1 Day M1",
  },
  {
    id: "0730_now_day_NEW_behavior",
    entry: { date: "2026-10-01", start: "07:30", position: "35 Medic 1" },
    expected: "Oct 1 Day M1",
  },
  {
    id: "1900_still_night",
    entry: { date: "2026-10-01", start: "19:00", position: "35 Medic 1" },
    expected: "Oct 1 Night M1",
  },
];

for (const c of GONE_LABEL_CASES) {
  test(`goneLabel: ${c.id}`, () => {
    assert.equal(goneLabel(c.entry), c.expected);
  });
}

// --- Untouched rowshape exports: light pinning (not covered elsewhere) -----

test("loc: strips leading (Unassigned) marker", () => {
  assert.equal(loc("(Unassigned) Test Station 1"), "Test Station 1");
});

test("loc: strips leading 'Lastname, Firstname ' pair from a coworker post", () => {
  assert.equal(loc("Doe, Jane Test Station 1"), "Test Station 1");
});

test("posShort: drops the '35 ' prefix", () => {
  assert.equal(posShort("35 Medic 1"), "Medic 1");
});

test("tierClass: t1 at and above 47, t2 below it", () => {
  assert.equal(tierClass(47), "t1");
  assert.equal(tierClass(46.9), "t2");
});

test("tierClass: t2 at and above 25, t3 below it", () => {
  assert.equal(tierClass(25), "t2");
  assert.equal(tierClass(24.9), "t3");
});

test("sortkey: '<date> <start>' formula", () => {
  assert.equal(sortkey({ date: "2026-07-20", start: "07:00" }), "2026-07-20 07:00");
});

// --- rejectChipLabel(): chip label keyed off the STRUCTURED reject kind ---
//
// score.js's evaluate() returns `rejectKind` ("commitment" | "my_shift" |
// "buffer" | null) plus `rejectGapHours`; the chip is derived from those and
// never from the reason prose. Only the "commitment" kind wears a user-set word
// -- and it must wear whatever that word is, including one that reads like
// another category ("My Shifts"), which is exactly what string matching used to
// get wrong.
//
// That word arrives ALREADY RESOLVED as `rejectLabel`: sw.js's bucketEvents
// picks the per-event "show as" if there is one, else the feed's own commitment
// label, and writes it into the commitment triplet. There is no longer a global
// label argument -- an absent/blank rejectLabel means the user configured
// nothing for that feed and yields the neutral default.

const REJECT_CHIP_LABEL_CASES = [
  {
    id: "commitment_uses_the_resolved_label",
    reject: { rejectKind: "commitment", rejectLabel: "Fire Dept", rejectGapHours: null },
    expected: "✕ Fire Dept",
  },
  {
    // Two feeds, two words: this is the whole point of the label being per-feed.
    id: "commitment_label_is_whatever_that_feed_set",
    reject: { rejectKind: "commitment", rejectLabel: "Family", rejectGapHours: null },
    expected: "✕ Family",
  },
  {
    id: "commitment_label_colliding_with_my_shift_wording",
    reject: { rejectKind: "commitment", rejectLabel: "My Shifts", rejectGapHours: null },
    expected: "✕ My Shifts",
  },
  {
    id: "commitment_label_is_trimmed",
    reject: { rejectKind: "commitment", rejectLabel: "  Station 3  ", rejectGapHours: null },
    expected: "✕ Station 3",
  },
  {
    // The feed had no label configured, so the triplet carried nothing.
    id: "commitment_missing_label_falls_back_to_default",
    reject: { rejectKind: "commitment", rejectGapHours: null },
    expected: `✕ ${DEFAULT_COMMITMENT_LABEL}`,
  },
  {
    id: "commitment_empty_label_falls_back_to_default",
    reject: { rejectKind: "commitment", rejectLabel: "", rejectGapHours: null },
    expected: `✕ ${DEFAULT_COMMITMENT_LABEL}`,
  },
  {
    // A whitespace-only label is not a real one -- it must never render "✕ ".
    id: "commitment_blank_label_falls_back_to_default",
    reject: { rejectKind: "commitment", rejectLabel: "   ", rejectGapHours: null },
    expected: `✕ ${DEFAULT_COMMITMENT_LABEL}`,
  },
  {
    id: "commitment_non_string_label_falls_back_to_default",
    reject: { rejectKind: "commitment", rejectLabel: 42, rejectGapHours: null },
    expected: `✕ ${DEFAULT_COMMITMENT_LABEL}`,
  },
  {
    // A label must never leak into a different reject kind.
    id: "my_shift_ignores_the_label",
    reject: { rejectKind: "my_shift", rejectLabel: "Fire Dept", rejectGapHours: null },
    expected: "✕ Medic Shift",
  },
  {
    id: "buffer_ignores_the_label",
    reject: { rejectKind: "buffer", rejectLabel: "Fire Dept", rejectGapHours: 12.4 },
    expected: "✕ BUFFER 12h",
  },
  {
    id: "buffer_rounds_half_up",
    reject: { rejectKind: "buffer", rejectGapHours: 9.5 },
    expected: "✕ BUFFER 10h",
  },
  {
    id: "buffer_missing_gap",
    reject: { rejectKind: "buffer", rejectGapHours: null },
    expected: "✕ BUFFER",
  },
  {
    id: "buffer_non_finite_gap",
    reject: { rejectKind: "buffer", rejectGapHours: NaN },
    expected: "✕ BUFFER",
  },
  {
    id: "pass_shaped_result_has_no_kind",
    reject: { rejectKind: null, rejectGapHours: null },
    expected: "✕ REJECTED",
  },
  {
    id: "unknown_kind",
    reject: { rejectKind: "something_new", rejectLabel: "Fire Dept", rejectGapHours: null },
    expected: "✕ REJECTED",
  },
  { id: "null_input", reject: null, expected: "✕ REJECTED" },
  { id: "undefined_input", reject: undefined, expected: "✕ REJECTED" },
  { id: "empty_object", reject: {}, expected: "✕ REJECTED" },
];

for (const c of REJECT_CHIP_LABEL_CASES) {
  test(`rejectChipLabel: ${c.id}`, () => {
    assert.equal(rejectChipLabel(c.reject), c.expected);
  });
}

// The reason prose is now IRRELEVANT to the chip. A buffer reject whose prose
// mentions commitments no longer risks being read as a commitment overlap,
// and a stale/foreign reason string cannot pull the chip either way.
test("rejectChipLabel: the reason string does not influence the chip", () => {
  const buffer = {
    rejectKind: "buffer",
    rejectGapHours: 12.0,
    reason: "no full open tour after the previous commitment (12.0h gap)",
  };
  assert.equal(rejectChipLabel(buffer), "\u2715 BUFFER 12h");

  const misleading = {
    rejectKind: "my_shift",
    rejectGapHours: null,
    reason: "overlaps a commitment (Mon 09/14 08:00-18:00)",
  };
  assert.equal(rejectChipLabel(misleading), "\u2715 Medic Shift");
});

// The default must never name an employer -- this repo is public.
test("DEFAULT_COMMITMENT_LABEL is generic", () => {
  assert.equal(typeof DEFAULT_COMMITMENT_LABEL, "string");
  assert.ok(DEFAULT_COMMITMENT_LABEL.trim().length > 0);
});
