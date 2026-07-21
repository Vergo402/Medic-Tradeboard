import { test } from "node:test";
import { strict as assert } from "node:assert";
import { displayFields, runDiff } from "../core/diff.js";

// Fixed "today" and window-end used throughout this suite.
const TODAY = "2026-07-20";
const WINDOW_END = "2026-10-31";
const WINDOW = { today: TODAY, window_end: WINDOW_END };

// Builds a minimal scored record for a given verdict, filling in realistic
// defaults for the fields runDiff/displayFields care about.
function makeRec(w2wId, dt, verdict, opts = {}) {
  const { score = null, reason = null, ...overrides } = opts;
  const rec = {
    w2w_id: w2wId, date: dt, start: "07:00", end: "19:00",
    position: "35 Medic 9", text: "(Unassigned) Test Station 1", kind: "open",
    ...overrides,
  };
  if (verdict === "pass") {
    rec.verdict = "pass";
    rec.score = score === null ? 10.0 : score;
    rec.reason = "clears buffer rule";
  } else {
    rec.verdict = "reject";
    rec.score = null;
    rec.reason = reason || "overlaps Northgate (test)";
  }
  return rec;
}

// Convenience wrapper used to seed a realistic prior snapshot in these tests.
function displayOf(rec) {
  return displayFields(rec);
}

// --- 1. first run -----------------------------------------------------

test("first run: empty diff, first_run true, snapshot + history populated", () => {
  const scored = {
    eligible: [makeRec("100", "2026-07-25", "pass")],
    rejects: [makeRec("200", "2026-07-26", "reject")],
  };

  const { diff, historyLine, newSnapshot } = runDiff(scored, WINDOW, null, TODAY);

  assert.equal(diff.first_run, true);
  assert.deepEqual(diff.new, []);
  assert.deepEqual(diff.gone, []);
  assert.deepEqual(diff.changed, []);

  assert.equal(newSnapshot.eligible.length, 1);
  assert.deepEqual(newSnapshot.reject_ids, ["200"]);
  assert.equal(historyLine.n_eligible, 1);
  assert.equal(historyLine.n_rejects, 1);
});

// --- 2. second run, identical board -------------------------------------

test("second run, identical board: empty diff, first_run false", () => {
  const scored = {
    eligible: [makeRec("100", "2026-07-25", "pass")],
    rejects: [makeRec("200", "2026-07-26", "reject")],
  };

  const first = runDiff(scored, WINDOW, null, TODAY); // first run: creates snapshot
  const second = runDiff(scored, WINDOW, first.newSnapshot, TODAY); // second run: identical board

  assert.equal(second.diff.first_run, false);
  assert.deepEqual(second.diff.new, []);
  assert.deepEqual(second.diff.gone, []);
  assert.deepEqual(second.diff.changed, []);
});

// --- 3. new -----------------------------------------------------------

test("new eligible shift appears in new with the full display shape", () => {
  const snapshot = { scanned: "2026-07-15", window_end: WINDOW_END, eligible: [], reject_ids: [] };
  const newRec = makeRec("999", "2026-07-28", "pass", { score: 15.0, position: "35 Medic 2" });
  const scored = { eligible: [newRec], rejects: [] };

  const { diff, historyLine } = runDiff(scored, WINDOW, snapshot, TODAY);

  // deepStrictEqual on the whole entry, not per-field asserts, so a leaked
  // verdict/reason/before/after key (fields the display shape must NOT
  // carry) would fail this test.
  assert.deepEqual(diff.new, [
    {
      w2w_id: "999", date: "2026-07-28", start: "07:00", end: "19:00",
      position: "35 Medic 2", text: "(Unassigned) Test Station 1", kind: "open",
      score: 15.0,
    },
  ]);
  assert.deepEqual(diff.gone, []);
  assert.deepEqual(diff.changed, []);

  // Full historyLine field set is asserted here (once), not repeated in
  // every case below.
  assert.deepEqual(
    Object.keys(historyLine).sort(),
    ["changed_ids", "gone_ids", "n_eligible", "n_rejects", "new_ids", "scanned", "top_score", "window_end"].sort()
  );
  assert.equal(historyLine.scanned, TODAY);
  assert.equal(historyLine.window_end, WINDOW_END);
  assert.equal(historyLine.n_eligible, 1);
  assert.equal(historyLine.n_rejects, 0);
  assert.equal(historyLine.top_score, 15.0);
  assert.deepEqual(historyLine.new_ids, ["999"]);
  assert.deepEqual(historyLine.gone_ids, []);
  assert.deepEqual(historyLine.changed_ids, []);
});

// --- 4. gone (future-dated) -------------------------------------------------

test("future-dated snapshot shift missing from the board is gone", () => {
  const snapEntry = displayOf(makeRec("300", "2026-07-25", "pass", { score: 12.0 }));
  const snapshot = { scanned: "2026-07-15", window_end: WINDOW_END, eligible: [snapEntry], reject_ids: [] };
  const scored = { eligible: [], rejects: [] }; // 300 no longer on the board at all

  const { diff } = runDiff(scored, WINDOW, snapshot, TODAY);

  // Full entry, not just w2w_id/date, so a dropped field (e.g. score) would fail this.
  assert.deepEqual(diff.gone, [
    {
      w2w_id: "300", date: "2026-07-25", start: "07:00", end: "19:00",
      position: "35 Medic 9", text: "(Unassigned) Test Station 1", kind: "open",
      score: 12.0,
    },
  ]);
  assert.deepEqual(diff.new, []);
  assert.deepEqual(diff.changed, []);
});

// --- 5. past-dated shift is NOT reported gone ------------------------------

test("past-dated snapshot shift missing from the board is not gone (pruned silently)", () => {
  const snapEntry = displayOf(makeRec("400", "2026-07-10", "pass", { score: 8.0 }));
  const snapshot = { scanned: "2026-07-15", window_end: WINDOW_END, eligible: [snapEntry], reject_ids: [] };
  const scored = { eligible: [], rejects: [] }; // 400 is gone, but it's already in the past

  const { diff } = runDiff(scored, WINDOW, snapshot, TODAY); // TODAY 2026-07-20 > 2026-07-10

  assert.deepEqual(diff.gone, []);
  assert.deepEqual(diff.new, []);
  assert.deepEqual(diff.changed, []);
});

// --- 6. reject -> pass ------------------------------------------------------

test("reject -> pass is changed, not new, and carries score", () => {
  const snapshot = { scanned: "2026-07-15", window_end: WINDOW_END, eligible: [], reject_ids: ["500"] };
  const nowEligible = makeRec("500", "2026-07-27", "pass", { score: 20.0 });
  const scored = { eligible: [nowEligible], rejects: [] };

  const { diff } = runDiff(scored, WINDOW, snapshot, TODAY);

  assert.deepEqual(diff.new, []);
  assert.equal(diff.changed.length, 1);
  const entry = diff.changed[0];
  assert.equal(entry.w2w_id, "500");
  assert.equal(entry.from, "reject");
  assert.equal(entry.to, "pass");
  assert.equal(entry.reason, "clears buffer rule");
  assert.equal(entry.score, 20.0);
});

// --- 7. pass -> reject -------------------------------------------------------

test("pass -> reject is changed, with no score key on the entry", () => {
  const snapEntry = displayOf(makeRec("600", "2026-07-29", "pass", { score: 9.0 }));
  const snapshot = { scanned: "2026-07-15", window_end: WINDOW_END, eligible: [snapEntry], reject_ids: [] };
  const nowReject = makeRec("600", "2026-07-29", "reject", { reason: "overlaps Northgate (new commitment)" });
  const scored = { eligible: [], rejects: [nowReject] };

  const { diff } = runDiff(scored, WINDOW, snapshot, TODAY);

  assert.equal(diff.changed.length, 1);
  const entry = diff.changed[0];
  assert.equal(entry.w2w_id, "600");
  assert.equal(entry.from, "pass");
  assert.equal(entry.to, "reject");
  assert.equal(entry.reason, "overlaps Northgate (new commitment)");
  assert.ok(!("score" in entry), "changed entry must not carry a score key when score is null");
});

// --- extra: gone[]/changed[] preserve snapshot insertion order -------------
// Ground-truthed against the live Python: run_diff builds these via a dict
// comprehension over snapshot["eligible"], which preserves LIST order, not
// numeric order. A plain JS object keyed by w2w_id would silently reorder
// integer-like string keys ("100" before "900") and fail this test; a Map
// (used in diff.js) does not.

test("gone[] preserves snapshot insertion order, not numeric key order", () => {
  const snap900 = displayOf(makeRec("900", "2026-07-25", "pass", { score: 5.0 }));
  const snap100 = displayOf(makeRec("100", "2026-07-26", "pass", { score: 6.0 }));
  const snapshot = {
    scanned: "2026-07-15", window_end: WINDOW_END,
    eligible: [snap900, snap100], // inserted 900 before 100
    reject_ids: [],
  };
  const scored = { eligible: [], rejects: [] };

  const { diff } = runDiff(scored, WINDOW, snapshot, TODAY);

  assert.deepEqual(diff.gone.map((d) => d.w2w_id), ["900", "100"]);
});

// --- extra: changed[] orders pass->reject entries before reject->pass ------
// Mirrors run_diff's two-pass structure: the pass->reject pass walks
// snapshot["eligible"] first, then the reject->pass pass walks sorted
// snapshot["reject_ids"] second. Ground-truthed against the live Python with
// both flips present in the same run.

test("changed[] lists pass->reject entries before reject->pass entries in the same run", () => {
  const snapElig700 = displayOf(makeRec("700", "2026-07-25", "pass", { score: 7.0 }));
  const snapshot = {
    scanned: "2026-07-15", window_end: WINDOW_END,
    eligible: [snapElig700],
    reject_ids: ["800"],
  };
  const nowReject700 = makeRec("700", "2026-07-25", "reject", { reason: "overlaps Northgate (new)" });
  const nowPass800 = makeRec("800", "2026-07-26", "pass", { score: 9.0 });
  const scored = { eligible: [nowPass800], rejects: [nowReject700] };

  const { diff } = runDiff(scored, WINDOW, snapshot, TODAY);

  assert.deepEqual(
    diff.changed.map((d) => [d.w2w_id, d.from, d.to]),
    [
      ["700", "pass", "reject"],
      ["800", "reject", "pass"],
    ]
  );
});

// --- extra: empty-eligible top_score must be null, not -Infinity ----------
// Math.max(...[]) === -Infinity in JS; guards the translation of Python's
// `max(scores) if scores else None`.

test("historyLine.top_score is null (not -Infinity) when there are no eligible shifts", () => {
  const scored = { eligible: [], rejects: [makeRec("700", "2026-07-25", "reject")] };

  const { historyLine } = runDiff(scored, WINDOW, null, TODAY);

  assert.equal(historyLine.top_score, null);
});

// --- extra: displayFields excludes score for reject-shaped records --------

test("displayFields omits score entirely when rec.score is null", () => {
  const rec = makeRec("800", "2026-07-25", "reject");
  const out = displayFields(rec);
  assert.ok(!("score" in out));
  assert.deepEqual(Object.keys(out).sort(), ["date", "end", "kind", "position", "start", "text", "w2w_id"].sort());
});
