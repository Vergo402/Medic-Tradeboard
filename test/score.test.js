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
// Each case's gap/score/reason was hand-derived from THE explicit rest-buffer
// RULE in score.js's header comment: a commitment carries restBefore/restAfter
// hours (5-element triplet: [start, end, label, restBefore, restAfter]) and a
// shift is rejected only when a gap is STRICTLY LESS than the relevant
// commitment's own buffer (gap == buffer passes). This REPLACES the old
// "a full grid tour must fit the gap" rule entirely -- there is no tour grid
// any more, only explicit numeric buffers. Commitment labels here are
// arbitrary test strings -- evaluate() never reads them for its verdict,
// reason, or chip: rejects are classified by the structured `rejectKind`, and
// the user's own commitment label is applied later, in the display layer.

const CASES = [
  {
    id: "a_overlap_reject",
    // Shift entirely inside a commitment block -> straight overlap reject,
    // BEFORE any buffer check runs (this precedence is unchanged by the
    // buffer-hours rewrite and must stay first).
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
    // BEHAVIOR CHANGE (hours model): restAfter=8, gap = 8.0h exactly (commitment
    // ends Tue 07/14 18:00; shift starts 07/15 02:00). gap == buffer PASSES
    // (strict `<` is what fails), per THE RULE's explicit "gap == buffer
    // passes" contract -- this is the boundary case the old tour-grid table
    // used to cover with a fitting 18:00-08:00 tour.
    schedule: [["2026-07-14 08:00", "2026-07-14 18:00", "Day Tour", 0, 8]],
    rec: { date: "2026-07-15", start: "02:00", end: "10:00" },
    verdict: "pass",
    reason: "clears buffer rule",
    rejectKind: null,
    rejectGapHours: null,
    score: 8.0,
    before: "commitment ends Tue 07/14 18:00 (8.0h before)",
    after: null,
  },
  {
    id: "c_restAfter_reject",
    // BEHAVIOR CHANGE (hours model): restAfter=12, actual gap = 8.0h -> fails
    // (8 < 12). Single-sided, single-commitment, so rejectGapHours == score
    // here (the score-vs-rejectGapHours split is exercised elsewhere).
    schedule: [["2026-07-16 06:00", "2026-07-16 12:00", "Day Tour", 0, 12]],
    rec: { date: "2026-07-16", start: "20:00", end: "23:00" },
    verdict: "reject",
    reason: "only 8.0h after a commitment (needs 12)",
    rejectKind: "buffer",
    rejectGapHours: 8.0,
    score: 8.0,
    before: "commitment ends Thu 07/16 12:00 (8.0h before)",
    after: null,
  },
  {
    id: "c2_both_sides_fail",
    // BEHAVIOR CHANGE (hours model): prev restAfter=12 fails an 8.0h gap;
    // next restBefore=15 fails a 10.0h gap. Both clauses are emitted, prev
    // clause first, joined with "; ", and rejectGapHours is the SMALLEST of
    // the two failing gaps (8.0).
    schedule: [
      ["2026-07-16 06:00", "2026-07-16 12:00", "Day Tour", 0, 12],
      ["2026-07-17 09:00", "2026-07-17 15:00", "Early Tour", 15, 0],
    ],
    rec: { date: "2026-07-16", start: "20:00", end: "23:00" },
    verdict: "reject",
    reason:
      "only 8.0h after a commitment (needs 12); "
      + "only 10.0h before a commitment (needs 15)",
    rejectKind: "buffer",
    rejectGapHours: 8.0,
    score: 8.0,
    before: "commitment ends Thu 07/16 12:00 (8.0h before)",
    after: "commitment starts Fri 07/17 09:00 (10.0h after)",
  },
  {
    id: "d_failing_gap_is_not_the_score",
    // BEHAVIOR CHANGE (hours model), same shape as before: the 14.0h gap
    // before passes its restAfter=12 (14 !< 12), while the 21.0h gap after
    // FAILS its restBefore=24 (21 < 24). score is min over ALL (nearest) gaps
    // = 14.0; the reject was caused by the 21.0h side, so rejectGapHours must
    // be 21.0. Pinning the two apart is the point of this row -- a chip built
    // from `score` would wrongly read "BUFFER 14h".
    schedule: [
      ["2026-07-14 08:00", "2026-07-14 18:00", "Day Tour", 0, 12],
      ["2026-07-16 17:00", "2026-07-16 23:00", "Evening Tour", 24, 0],
    ],
    rec: { date: "2026-07-15", start: "08:00", end: "20:00" },
    verdict: "reject",
    reason: "only 21.0h before a commitment (needs 24)",
    rejectKind: "buffer",
    rejectGapHours: 21.0,
    score: 14.0,
    before: "commitment ends Tue 07/14 18:00 (14.0h before)",
    after: "commitment starts Thu 07/16 17:00 (21.0h after)",
  },
  {
    id: "e_dst_fall_back",
    // PRESERVED VERBATIM (MUST NOT WEAKEN). THE TRIPWIRE. Commitment ends Sat
    // 2026-10-31 18:00 (EDT); medic night shift starts Sun 2026-11-01 19:00
    // (EST) -- the gap spans the fall-back. Wall-clock says 25h, but Nov 1
    // 2026 has 25 wall hours, so real rest is 26.0h. Gaps are measured in TRUE
    // elapsed hours -- unaffected by the buffer-hours rewrite: this 3-element
    // (old-cache-shaped) triplet defaults restAfter to 0, so it passes
    // trivially, but the DST elapsed-hours math driving `score`/`before` is
    // exactly what must survive the rewrite.
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
    // PRESERVED VERBATIM (MUST NOT WEAKEN). No commitments at all -> the 999
    // sentinel score.
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
    // BEHAVIOR CHANGE (hours model): before restAfter=20 passes a 23.0h gap
    // (23 !< 20); after restBefore=20 passes a 25.0h gap (25 !< 20). Both
    // pass for a REAL numeric reason (not a vacuous 0/0 default), and score =
    // min(23.0, 25.0) = 23.0.
    schedule: [
      ["2026-07-20 18:00", "2026-07-21 08:00", "Night Tour", 0, 20],
      ["2026-07-23 20:00", "2026-07-24 08:00", "Night Tour 2", 20, 0],
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

// --- NEW: per-commitment rest-buffer model ----------------------------------
//
// These pin the CONTRACT directly: restBefore/restAfter default to 0 (a
// blocking calendar with no configured buffer rejects only direct overlaps),
// gap == buffer passes (strict `<` fails), and buffer failures are evaluated
// per-commitment (not nearest-only), so a farther commitment's larger buffer
// can bind when a nearer commitment's smaller buffer passes.

test("evaluate: 0/0 buffer imposes no buffer at all -- only overlap rejects, no matter how close", () => {
  // Commitment ends exactly when the shift starts (touching, not overlapping):
  // gap == 0. With restBefore=restAfter=0, 0 < 0 is false, so this passes no
  // matter how tight the touch is -- only a true overlap could reject it.
  const commitments = loadCommitments([["2026-07-13 08:00", "2026-07-13 10:00", "Tour", 0, 0]]);
  const rec = { date: "2026-07-13", start: "10:00", end: "12:00" };
  const result = evaluate(rec, commitments);
  assert.equal(result.verdict, "pass");
  assert.equal(result.rejectKind, null);
  assert.equal(result.score, 0.0);
});

// restAfter: a prev commitment ending 8h before the shift, varied restAfter.
for (const [restAfter, verdict] of [[12, "reject"], [8, "pass"], [0, "pass"]]) {
  test(`evaluate: restAfter=${restAfter} against an 8.0h gap -> ${verdict}`, () => {
    const commitments = loadCommitments([
      ["2026-07-16 06:00", "2026-07-16 12:00", "Tour", 0, restAfter],
    ]);
    const rec = { date: "2026-07-16", start: "20:00", end: "23:00" };
    const result = evaluate(rec, commitments);
    assert.equal(result.verdict, verdict);
    if (verdict === "reject") {
      assert.equal(result.rejectKind, "buffer");
      assert.equal(result.rejectGapHours, 8.0);
      assert.equal(result.reason, `only 8.0h after a commitment (needs ${restAfter})`);
    } else {
      assert.equal(result.rejectKind, null);
      assert.equal(result.score, 8.0);
    }
  });
}

// restBefore mirrors restAfter on the next side: a next commitment starting
// 8h after the shift ends, varied restBefore.
for (const [restBefore, verdict] of [[12, "reject"], [8, "pass"], [0, "pass"]]) {
  test(`evaluate: restBefore=${restBefore} against an 8.0h gap -> ${verdict}`, () => {
    const commitments = loadCommitments([
      ["2026-07-17 09:00", "2026-07-17 15:00", "Tour", restBefore, 0],
    ]);
    const rec = { date: "2026-07-16", start: "20:00", end: "01:00" };
    const result = evaluate(rec, commitments);
    assert.equal(result.verdict, verdict);
    if (verdict === "reject") {
      assert.equal(result.rejectKind, "buffer");
      assert.equal(result.rejectGapHours, 8.0);
      assert.equal(result.reason, `only 8.0h before a commitment (needs ${restBefore})`);
    } else {
      assert.equal(result.rejectKind, null);
      assert.equal(result.score, 8.0);
    }
  });
}

// THE MONOTONICITY CASE: per-commitment buffers are non-monotonic, so
// evaluate() must check EVERY prev/next against its OWN buffer, not just the
// nearest. Here the nearest prev (2h before, restAfter=1) passes, but a
// FARTHER prev (20h before, restAfter=24) fails -- a nearest-only
// implementation would wrongly pass this shift.
test("evaluate: a farther commitment's larger buffer can fail when the nearest one passes", () => {
  const commitments = loadCommitments([
    ["2026-07-21 08:00", "2026-07-21 16:00", "Farther Tour", 0, 24], // ends 20h before shift start
    ["2026-07-22 08:00", "2026-07-22 10:00", "Nearest Tour", 0, 1], // ends 2h before shift start
  ]);
  const rec = { date: "2026-07-22", start: "12:00", end: "20:00" };
  const result = evaluate(rec, commitments);

  assert.equal(result.verdict, "reject");
  assert.equal(result.rejectKind, "buffer");
  // score reflects the NEAREST gap (2.0h, which itself passed its own buffer);
  // rejectGapHours reflects the FAILING gap (20.0h, from the farther commitment).
  assert.equal(result.score, 2.0);
  assert.equal(result.rejectGapHours, 20.0);
  assert.equal(result.reason, "only 20.0h after a commitment (needs 24)");
  assert.equal(result.before, "commitment ends Wed 07/22 10:00 (2.0h before)");
  assert.equal(result.after, null);
});

// --- loadCommitments(): buffer merge + old-cache defaulting -----------------

test("loadCommitments(): touching commitments merge buffers by taking the MAX on each side", () => {
  const schedule = [
    ["2026-07-10 18:00", "2026-07-11 08:00", "Night Tour", 0, 4],
    ["2026-07-11 08:00", "2026-07-12 08:00", "24h Tour", 0, 12],
  ];
  const commitments = loadCommitments(schedule);
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0].restAfter, 12);
  assert.equal(commitments[0].restBefore, 0);
});

test("loadCommitments(): a 3-element (old-cache-shaped) triplet defaults restBefore/restAfter to 0", () => {
  const commitments = loadCommitments([["2026-07-13 08:00", "2026-07-13 18:00", "Old Tour"]]);
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0].restBefore, 0);
  assert.equal(commitments[0].restAfter, 0);
});

test("loadCommitments(): a non-numeric/negative/NaN/Infinity buffer field collapses to 0", () => {
  const schedule = [
    ["2026-07-13 08:00", "2026-07-13 18:00", "A", -5, NaN],
    ["2026-07-20 08:00", "2026-07-20 18:00", "B", Infinity, "12"],
  ];
  const commitments = loadCommitments(schedule);
  assert.equal(commitments[0].restBefore, 0);
  assert.equal(commitments[0].restAfter, 0);
  assert.equal(commitments[1].restBefore, 0);
  assert.equal(commitments[1].restAfter, 0);
});

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

// The per-event "show as" override rides from the overlapping commitment's
// triplet label into evaluate()'s rejectLabel; rowshape.rejectChipLabel turns
// it into the chip. This pins the score→rowshape seam directly: the CASES above
// never assert rejectLabel, and the rowshape test uses a synthetic reject, so
// without this a wrong field name in evaluate() would leave all suites green.
test("evaluate: a commitment reject carries the overlapping block's label as rejectLabel", () => {
  const commitments = loadCommitments([["2026-07-13 08:00", "2026-07-13 18:00", "Drill"]]);
  const rec = { date: "2026-07-13", start: "10:00", end: "14:00" };
  const result = evaluate(rec, commitments);
  assert.equal(result.rejectKind, "commitment");
  assert.equal(result.rejectLabel, "Drill");
});

test("evaluate: a commitment with an empty label yields an empty rejectLabel", () => {
  const commitments = loadCommitments([["2026-07-13 08:00", "2026-07-13 18:00", ""]]);
  const rec = { date: "2026-07-13", start: "10:00", end: "14:00" };
  const result = evaluate(rec, commitments);
  assert.equal(result.rejectKind, "commitment");
  assert.equal(result.rejectLabel, "");
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

// An overnight shift spans two calendar days, so it overlaps BOTH days' copies
// of an all-day note. Those are two distinct events with the same label; fam
// must collapse them, or the badge reads the label twice ("Standby · Backup ·
// Standby · Backup") on a 19:00-07:00 shift.
test("evaluate: fam dedupes an all-day note that both days of an overnight shift touch", () => {
  const softEvents = [
    triplet("2026-09-25 00:00", "2026-09-26 00:00", "Standby"),
    triplet("2026-09-25 00:00", "2026-09-26 00:00", "Backup"),
    triplet("2026-09-26 00:00", "2026-09-27 00:00", "Standby"),
    triplet("2026-09-26 00:00", "2026-09-27 00:00", "Backup"),
  ];
  const rec = { date: "2026-09-25", start: "19:00", end: "07:00" }; // overnight
  const result = evaluate(rec, [], [], softEvents);
  // Each label appears once, first-occurrence order preserved.
  assert.deepEqual(result.fam, ["Standby", "Backup"]);
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
