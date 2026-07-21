import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseCivil, toEpoch } from "../core/nytime.js";
import { shiftTimes, loadCommitments, evaluate, rankEligible } from "../core/score.js";

/**
 * Build a {s, e, label, sCivil, eCivil} entry directly, i.e. hand-build a
 * my_shifts/soft-event entry without going through loadCommitments' merge
 * step.
 */
function triplet(sStr, eStr, label) {
  const sCivil = parseCivil(sStr);
  const eCivil = parseCivil(eStr);
  return { s: toEpoch(sCivil), e: toEpoch(eCivil), label, sCivil, eCivil };
}

// --- table-driven evaluate() cases ------------------------------------------
//
// Each case's gap/score was hand-derived from THE RULE in score.js and
// cross-checked against the TOUR_STARTS grid: [(7,19),(19,7),(8,18),(18,8)].
// Commitment labels here are arbitrary test strings -- evaluate() never reads
// them for its verdict, reason, or chip: rejects are classified by the
// structured `rejectKind`, and the user's own commitment label is applied
// later, in the display layer.

const CASES = [
  {
    id: "a_overlap_reject",
    // Shift entirely inside a commitment block -> straight overlap reject.
    schedule: [["2026-07-13 08:00", "2026-07-13 18:00", "Day Tour"]],
    rec: { date: "2026-07-13", start: "10:00", end: "14:00" },
    verdict: "reject",
    reason: "overlaps a commitment (Mon 07/13 08:00-18:00)",
    rejectKind: "commitment",
    rejectGapHours: null,
    score: null,
    before: null,
    after: null,
  },
  {
    id: "b_boundary_touch_pass",
    // Commitment ends D 18:00; shift starts D+1 08:00 -> 14h gap, exactly
    // filled by the 18:00-08:00 tour (boundary-touch on both ends counts per
    // the rule).
    schedule: [["2026-07-14 08:00", "2026-07-14 18:00", "Day Tour"]],
    rec: { date: "2026-07-15", start: "08:00", end: "20:00" },
    verdict: "pass",
    reason: "clears buffer rule",
    rejectKind: null,
    rejectGapHours: null,
    score: 14.0,
    before: "commitment ends Tue 07/14 18:00 (14.0h before)",
    after: null,
  },
  {
    id: "c_no_complete_tour_reject",
    // Commitment ends D 12:00, shift starts D+1 06:00 -> 18h gap. No grid tour
    // (07-19/19-07/08-18/18-08) starts at/after 12:00 D and ends at/before
    // 06:00 D+1: the earliest candidate start on D is 18:00, which needs
    // >=10h and lands past 06:00 D+1 in every case. Reject, but the score
    // still reports the numeric gap (buffer-failure rejects keep their score).
    schedule: [["2026-07-16 06:00", "2026-07-16 12:00", "Day Tour"]],
    rec: { date: "2026-07-17", start: "06:00", end: "18:00" },
    verdict: "reject",
    reason: "no full open tour after the previous commitment (18.0h gap)",
    rejectKind: "buffer",
    rejectGapHours: 18.0,
    score: 18.0,
    before: "commitment ends Thu 07/16 12:00 (18.0h before)",
    after: null,
  },
  {
    id: "c2_both_sides_fail",
    // Same failing 18.0h gap before as c_no_complete_tour_reject, plus a 9.0h
    // gap after (D+1 18:00 -> D+2 03:00) that fits no grid tour either. Both
    // clauses are emitted, joined with "; ", and rejectGapHours is the
    // SMALLEST of the two failing gaps.
    schedule: [
      ["2026-07-16 06:00", "2026-07-16 12:00", "Day Tour"],
      ["2026-07-18 03:00", "2026-07-18 09:00", "Early Tour"],
    ],
    rec: { date: "2026-07-17", start: "06:00", end: "18:00" },
    verdict: "reject",
    reason:
      "no full open tour after the previous commitment (18.0h gap); "
      + "no full open tour before the next commitment (9.0h gap)",
    rejectKind: "buffer",
    rejectGapHours: 9.0,
    score: 9.0,
    before: "commitment ends Thu 07/16 12:00 (18.0h before)",
    after: "commitment starts Sat 07/18 03:00 (9.0h after)",
  },
  {
    id: "d_failing_gap_is_not_the_score",
    // Two-sided and ASYMMETRIC: the 14.0h gap before the shift is filled by
    // the 18:00-08:00 tour (passes), while the 21.0h gap after it fits no
    // grid tour (fails). score is min over ALL gaps = 14.0; the reject was
    // caused by the 21.0h side, so rejectGapHours must be 21.0. Pinning the
    // two apart is the point of this row -- a chip built from `score` would
    // wrongly read "BUFFER 14h".
    schedule: [
      ["2026-07-14 08:00", "2026-07-14 18:00", "Day Tour"],
      ["2026-07-16 17:00", "2026-07-16 23:00", "Evening Tour"],
    ],
    rec: { date: "2026-07-15", start: "08:00", end: "20:00" },
    verdict: "reject",
    reason: "no full open tour before the next commitment (21.0h gap)",
    rejectKind: "buffer",
    rejectGapHours: 21.0,
    score: 14.0,
    before: "commitment ends Tue 07/14 18:00 (14.0h before)",
    after: "commitment starts Thu 07/16 17:00 (21.0h after)",
  },
  {
    id: "e_dst_fall_back",
    // THE TRIPWIRE. Commitment ends Sat 2026-10-31 18:00 (EDT); medic night
    // shift starts Sun 2026-11-01 19:00 (EST) -- the gap spans the fall-back.
    // Wall-clock says 25h, but Nov 1 2026 has 25 wall hours, so real rest is
    // 26.0h. Gaps are measured in TRUE elapsed hours.
    schedule: [["2026-10-31 08:00", "2026-10-31 18:00", "Day Tour"]],
    rec: { date: "2026-11-01", start: "19:00", end: "07:00" },
    verdict: "pass",
    reason: "clears buffer rule",
    rejectKind: null,
    rejectGapHours: null,
    score: 26.0,
    before: "commitment ends Sat 10/31 18:00 (26.0h before)",
    after: null,
  },
  {
    id: "g_no_neighbor_pass",
    schedule: [],
    rec: { date: "2026-07-20", start: "07:00", end: "19:00" },
    verdict: "pass",
    reason: "clears buffer rule",
    rejectKind: null,
    rejectGapHours: null,
    score: 999,
    before: null,
    after: null,
  },
  {
    id: "h_min_of_two",
    // Before: commitment ends Tue 07/21 08:00 -> shift starts Wed 07/22 07:00
    //   = 23h gap; the 08-18 tour starting exactly at 08:00 fits.
    // After: shift ends Wed 07/22 19:00 -> next commitment starts Thu 07/23
    //   20:00 = 25h gap; the 19-07 tour starting exactly at 19:00 fits.
    // min(23.0, 25.0) = 23.0.
    schedule: [
      ["2026-07-20 18:00", "2026-07-21 08:00", "Night Tour"],
      ["2026-07-23 20:00", "2026-07-24 08:00", "Night Tour 2"],
    ],
    rec: { date: "2026-07-22", start: "07:00", end: "19:00" },
    verdict: "pass",
    reason: "clears buffer rule",
    rejectKind: null,
    rejectGapHours: null,
    score: 23.0,
    before: "commitment ends Tue 07/21 08:00 (23.0h before)",
    after: "commitment starts Thu 07/23 20:00 (25.0h after)",
  },
];

for (const c of CASES) {
  test(`evaluate: ${c.id}`, () => {
    const commitments = loadCommitments(c.schedule);
    const result = evaluate(c.rec, commitments);

    assert.equal(result.verdict, c.verdict);
    assert.equal(result.score, c.score);
    assert.equal(result.reason, c.reason);
    assert.equal(result.rejectKind, c.rejectKind);
    assert.equal(result.rejectGapHours, c.rejectGapHours);
    assert.equal(result.before, c.before);
    assert.equal(result.after, c.after);
  });
}

// No reject reason, on any path, may name a specific employer or calendar --
// the reason is neutral prose and the label lives only in the display layer.
test("evaluate: reject reasons stay neutral and carry a structured kind", () => {
  const commitments = loadCommitments([["2026-07-13 08:00", "2026-07-13 18:00", "Day Tour"]]);
  const rec = { date: "2026-07-13", start: "10:00", end: "14:00" };
  const result = evaluate(rec, commitments);
  assert.equal(result.rejectKind, "commitment");
  assert.match(result.reason, /^overlaps a commitment \(/);
  assert.doesNotMatch(result.reason, /Day Tour/);
});

// --- shiftTimes(): midnight-spanning ----------------------------------------

test("shiftTimes(): end <= start rolls end's civil date forward one day", () => {
  const rec = { date: "2026-07-18", start: "19:00", end: "07:00" };
  const { startCivil, endCivil } = shiftTimes(rec);
  assert.deepEqual(startCivil, { y: 2026, mo: 7, d: 18, h: 19, mi: 0 });
  assert.deepEqual(endCivil, { y: 2026, mo: 7, d: 19, h: 7, mi: 0 });
});

// --- loadCommitments(): adjacent-block merge --------------------------------

test("loadCommitments(): touching blocks merge into one, keeping the first label", () => {
  // A night block D 18:00 -> D+1 08:00, immediately followed by a 24h block
  // D+1 08:00 -> D+2 08:00: touching blocks merge into one.
  const schedule = [
    ["2026-07-10 18:00", "2026-07-11 08:00", "Night Tour"],
    ["2026-07-11 08:00", "2026-07-12 08:00", "24h Tour"],
  ];
  const commitments = loadCommitments(schedule);
  assert.equal(commitments.length, 1);
  assert.deepEqual(commitments[0].sCivil, { y: 2026, mo: 7, d: 10, h: 18, mi: 0 });
  assert.deepEqual(commitments[0].eCivil, { y: 2026, mo: 7, d: 12, h: 8, mi: 0 });
  assert.equal(commitments[0].label, "Night Tour");
});

// --- myShifts collision tests ------------------------------------------------
//
// myShifts is a second, non-merged overlap check layered onto evaluate(): it
// must never touch commitments, gap math, or openTourInGap.

test("evaluate: my-shift collision -> reject with null score", () => {
  const commitments = [];
  const myShifts = [triplet("2026-07-13 09:00", "2026-07-13 15:00", "My Shift")];
  const rec = { date: "2026-07-13", start: "10:00", end: "14:00" };
  const result = evaluate(rec, commitments, myShifts);
  assert.equal(result.verdict, "reject");
  assert.equal(result.rejectKind, "my_shift");
  assert.ok(result.reason.startsWith("overlaps your medic shift"));
  assert.equal(result.score, null);
});

test("evaluate: commitment overlap takes precedence over my-shift overlap", () => {
  // Candidate overlaps both a commitment and a myShift -> the commitment
  // check runs first, so both its kind and its reason win.
  const commitments = loadCommitments([["2026-07-13 08:00", "2026-07-13 18:00", "Day Tour"]]);
  const myShifts = [triplet("2026-07-13 09:00", "2026-07-13 15:00", "My Shift")];
  const rec = { date: "2026-07-13", start: "10:00", end: "14:00" };
  const result = evaluate(rec, commitments, myShifts);
  assert.equal(result.verdict, "reject");
  assert.equal(result.rejectKind, "commitment");
  assert.ok(result.reason.startsWith("overlaps a commitment"));
});

test("evaluate: my-shift never affects buffers/score", () => {
  // Same setup as CASES.b_boundary_touch_pass: 14h gap exactly filled by the
  // 18:00-08:00 tour. A myShift that touches (but does not overlap) the
  // candidate's end must not leak into commitments/gap math and must not
  // change verdict or score.
  const commitments = loadCommitments([["2026-07-14 08:00", "2026-07-14 18:00", "Day Tour"]]);
  const rec = { date: "2026-07-15", start: "08:00", end: "20:00" };
  const myShifts = [triplet("2026-07-15 20:00", "2026-07-16 08:00", "Next Medic Shift")];

  const withoutCollision = evaluate(rec, commitments);
  const withCollision = evaluate(rec, commitments, myShifts);

  assert.equal(withoutCollision.verdict, "pass");
  assert.equal(withCollision.verdict, "pass");
  assert.equal(withoutCollision.score, 14.0);
  assert.equal(withCollision.score, 14.0);
});

// --- fam (soft events) attachment tests --------------------------------------
//
// fam is informational only: attached to every returned dict, never affects
// verdict or score.

test("evaluate: fam attaches on pass without affecting score", () => {
  // Same setup as CASES.g_no_neighbor_pass: no commitments, always passes.
  const commitments = [];
  const softEvents = [triplet("2026-07-20 10:00", "2026-07-20 12:00", "Kid's Birthday")];
  const rec = { date: "2026-07-20", start: "07:00", end: "19:00" };

  const control = evaluate(rec, commitments);
  const result = evaluate(rec, commitments, [], softEvents);

  assert.equal(result.verdict, "pass");
  assert.equal(result.score, control.score);
  assert.deepEqual(result.fam, ["Kid's Birthday"]);
});

test("evaluate: fam attaches on reject too", () => {
  // Same setup as CASES.a_overlap_reject. fam must still be attached to a
  // reject result, and the reject must still be the commitment-overlap one
  // (fam never influences verdict/reason/kind).
  const commitments = loadCommitments([["2026-07-13 08:00", "2026-07-13 18:00", "Day Tour"]]);
  const softEvents = [triplet("2026-07-13 11:00", "2026-07-13 12:00", "Anniversary")];
  const rec = { date: "2026-07-13", start: "10:00", end: "14:00" };
  const result = evaluate(rec, commitments, [], softEvents);
  assert.equal(result.verdict, "reject");
  assert.equal(result.rejectKind, "commitment");
  assert.ok(result.reason.startsWith("overlaps a commitment"));
  assert.deepEqual(result.fam, ["Anniversary"]);
});

// --- rankEligible(): descending-score sort, stable, rejects untouched ------
//
// Eligible rows sort by descending score (stable, so ties keep the caller's
// input order, which is pre-sorted by date+start); rejects come back in input
// order, unsorted.

test("rankEligible(): eligible sorted descending by score, stable on ties; rejects kept in input order", () => {
  const results = [
    { verdict: "pass", score: 10, id: "p10" },
    { verdict: "reject", score: null, id: "r1" },
    { verdict: "pass", score: 25, id: "p25a" },
    { verdict: "pass", score: 25, id: "p25b" }, // tie with p25a -> stable sort keeps input order
    { verdict: "reject", score: 18, id: "r2" },
    { verdict: "pass", score: 999, id: "p999" },
  ];
  const { eligible, rejects } = rankEligible(results);
  assert.deepEqual(
    eligible.map((r) => r.id),
    ["p999", "p25a", "p25b", "p10"]
  );
  assert.deepEqual(
    rejects.map((r) => r.id),
    ["r1", "r2"]
  );
});
