import { test } from "node:test";
import { strict as assert } from "node:assert";
import { displayFields, runDiff } from "../core/diff.js";

// Fixed "today" and window-end used throughout this suite. scan_start/scan_end
// are the range the scan actually covered; the shared WINDOW deliberately spans
// the whole suite's dates (including 2026-07-10, before TODAY) so the expiry
// prune, not window scoping, is what suppresses past-dated gone entries below.
const TODAY = "2026-07-20";
const WINDOW_END = "2026-10-31";
const WINDOW = { today: TODAY, window_end: WINDOW_END, scan_start: "2026-07-01", scan_end: WINDOW_END };

// A deliberately NARROW scan window (August only) for the window-scoping cases.
const AUG = { window_end: WINDOW_END, scan_start: "2026-08-01", scan_end: "2026-08-31" };

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
  assert.deepEqual(newSnapshot.rejects, [{ w2w_id: "200", date: "2026-07-26" }]);
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
    ["changed_ids", "gone_ids", "n_eligible", "n_rejects", "new_ids", "scan_end", "scan_start",
      "scanned", "top_score", "window_end"].sort()
  );
  assert.equal(historyLine.scanned, TODAY);
  assert.equal(historyLine.window_end, WINDOW_END);
  assert.equal(historyLine.scan_start, WINDOW.scan_start);
  assert.equal(historyLine.scan_end, WINDOW.scan_end);
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

// --- window scoping: gone -------------------------------------------------
// The extension scans ONE month while the snapshot spans months of prior
// scans. Only the scanned range may be called gone.

test("gone is scoped to the scanned window: out-of-window snapshot entries are not gone", () => {
  const inAug = displayOf(makeRec("810", "2026-08-14", "pass", { score: 11.0 }));
  const inSep = displayOf(makeRec("910", "2026-09-14", "pass", { score: 12.0 }));
  const snapshot = {
    scanned: "2026-07-15", window_end: WINDOW_END,
    eligible: [inAug, inSep], rejects: [],
  };
  const scored = { eligible: [], rejects: [] }; // August board is empty this scan

  const { diff, historyLine } = runDiff(scored, AUG, snapshot, TODAY);

  assert.deepEqual(diff.gone.map((d) => d.w2w_id), ["810"]);
  assert.deepEqual(historyLine.gone_ids, ["810"]);
  assert.deepEqual(diff.new, []);
  assert.deepEqual(diff.changed, []);
});

test("out-of-window snapshot entry still reports its pass -> reject flip if it is on this board", () => {
  // 920 was dated September in the snapshot but appears (re-dated) on the
  // August board as a reject: present on the board means in-window, so the
  // flip is reported rather than swallowed by the date scoping.
  const snapSep = displayOf(makeRec("920", "2026-09-14", "pass", { score: 12.0 }));
  const snapshot = {
    scanned: "2026-07-15", window_end: WINDOW_END, eligible: [snapSep], rejects: [],
  };
  const nowReject = makeRec("920", "2026-08-14", "reject", { reason: "overlaps Northgate (moved)" });
  const scored = { eligible: [], rejects: [nowReject] };

  const { diff } = runDiff(scored, AUG, snapshot, TODAY);

  assert.deepEqual(diff.gone, []);
  assert.deepEqual(diff.changed.map((d) => [d.w2w_id, d.from, d.to]), [["920", "pass", "reject"]]);
});

// --- window scoping: snapshot merge ---------------------------------------

test("snapshot merges: out-of-window entries preserved verbatim, in-window ones replaced", () => {
  const inAugOld = displayOf(makeRec("810", "2026-08-14", "pass", { score: 11.0 }));
  const inSep = displayOf(makeRec("910", "2026-09-14", "pass", { score: 12.0 }));
  const expired = displayOf(makeRec("710", "2026-07-10", "pass", { score: 4.0 }));
  const snapshot = {
    scanned: "2026-07-15", window_end: WINDOW_END,
    eligible: [inSep, expired, inAugOld], rejects: [],
  };
  // This scan sees only August, and 810 is no longer on it; 820 is.
  const scored = { eligible: [makeRec("820", "2026-08-20", "pass", { score: 13.0 })], rejects: [] };

  const { newSnapshot } = runDiff(scored, AUG, snapshot, TODAY);

  // 910 carried over verbatim (out of window, still future); 710 dropped
  // (out of window but expired); 810 dropped (in window, gone this scan);
  // 820 added. Carried-over entries keep snapshot order and come first.
  assert.deepEqual(newSnapshot.eligible.map((e) => e.w2w_id), ["910", "820"]);
  assert.deepEqual(newSnapshot.eligible[0], inSep);
  assert.equal(newSnapshot.scan_start, AUG.scan_start);
  assert.equal(newSnapshot.scan_end, AUG.scan_end);
});

test("rejects merge the same way, out-of-window reject ids preserved with their dates", () => {
  const snapshot = {
    scanned: "2026-07-15", window_end: WINDOW_END, eligible: [],
    rejects: [
      { w2w_id: "930", date: "2026-09-14" }, // out of window -> preserved
      { w2w_id: "830", date: "2026-08-14" }, // in window, not on this board -> dropped
      { w2w_id: "730", date: "2026-07-10" }, // out of window but expired -> dropped
    ],
  };
  const scored = { eligible: [], rejects: [makeRec("840", "2026-08-21", "reject")] };

  const { newSnapshot } = runDiff(scored, AUG, snapshot, TODAY);

  assert.deepEqual(newSnapshot.rejects, [
    { w2w_id: "930", date: "2026-09-14" },
    { w2w_id: "840", date: "2026-08-21" },
  ]);
});

test("legacy dateless reject_ids still suppress new, and drop out of the merged snapshot", () => {
  // Pre-window-scoping snapshots carry a bare id list. Without dates those ids
  // cannot be window-scoped, so they are replaced by this scan (self-healing,
  // one-time) rather than preserved forever — but they are still "known", so
  // an id that reappears is not reported new.
  const snapshot = { scanned: "2026-07-15", window_end: WINDOW_END, eligible: [], reject_ids: ["850", "860"] };
  const scored = { eligible: [makeRec("850", "2026-08-14", "pass", { score: 14.0 })], rejects: [] };

  const { diff, newSnapshot } = runDiff(scored, AUG, snapshot, TODAY);

  assert.deepEqual(diff.new, []); // known from reject_ids
  assert.deepEqual(diff.changed.map((d) => [d.w2w_id, d.from, d.to]), [["850", "reject", "pass"]]);
  assert.deepEqual(newSnapshot.rejects, []); // 860 not carried over: no date to scope it by
  assert.ok(!("reject_ids" in newSnapshot), "the merged snapshot writes the dated `rejects` shape only");
});

test("first run is unaffected by window scoping: no gone/new, snapshot is just this scan", () => {
  const scored = {
    eligible: [makeRec("870", "2026-08-14", "pass")],
    rejects: [makeRec("880", "2026-08-15", "reject")],
  };

  const { diff, newSnapshot } = runDiff(scored, AUG, null, TODAY);

  assert.equal(diff.first_run, true);
  assert.deepEqual(diff.gone, []);
  assert.deepEqual(diff.new, []);
  assert.deepEqual(newSnapshot.eligible.map((e) => e.w2w_id), ["870"]);
  assert.deepEqual(newSnapshot.rejects, [{ w2w_id: "880", date: "2026-08-15" }]);
});

test("a window without scan_start/scan_end throws rather than wiping the snapshot", () => {
  const scored = { eligible: [], rejects: [] };
  assert.throws(
    () => runDiff(scored, { window_end: WINDOW_END }, { eligible: [], rejects: [] }, TODAY),
    /scan_start/
  );
});

// --- extra: displayFields excludes score for reject-shaped records --------

test("displayFields omits score entirely when rec.score is null", () => {
  const rec = makeRec("800", "2026-07-25", "reject");
  const out = displayFields(rec);
  assert.ok(!("score" in out));
  assert.deepEqual(Object.keys(out).sort(), ["date", "end", "kind", "position", "start", "text", "w2w_id"].sort());
});
