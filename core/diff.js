/**
 * Computes the new/gone/changed diff between this scan's scored board and
 * the prior scan's stored snapshot, plus the scan-history line and the
 * replacement snapshot.
 *
 * Signature note: `window` is its own positional argument (window.window_end)
 * rather than being nested inside `scored` -- `scored` only ever needs its
 * eligible/rejects fields.
 */

const DISPLAY_KEYS = ["w2w_id", "date", "start", "end", "position", "text", "kind"];

/**
 * Subset of a scored record carried into diff/snapshot output: DISPLAY_KEYS,
 * plus score IFF rec.score is not null/undefined (mirrors Python's
 * `rec.get("score") is not None`, which also excludes an absent key).
 * @param {object} rec
 * @returns {object}
 */
export function displayFields(rec) {
  const out = {};
  for (const k of DISPLAY_KEYS) out[k] = rec[k];
  if (rec.score !== null && rec.score !== undefined) out.score = rec.score;
  return out;
}

/**
 * Computes the new/gone/changed diff between this scan and the prior
 * snapshot, returning the diff, the scan-history line, and the replacement
 * snapshot to persist.
 *
 * @param {{eligible: object[], rejects: object[]}} scored - records carry
 *   verdict/score/reason plus the DISPLAY_KEYS fields.
 * @param {{window_end: string}} window - the scan window's parsed content.
 * @param {{eligible: object[], reject_ids: Array<string|number>}|null} snapshot
 *   prior stored snapshot, or null on the very first run.
 * @param {string} today - "YYYY-MM-DD"
 * @returns {{diff: object, historyLine: object, newSnapshot: object}}
 */
export function runDiff(scored, window, snapshot, today) {
  const board = new Map();
  for (const r of [...scored.eligible, ...scored.rejects]) board.set(r.w2w_id, r);

  const firstRun = snapshot === null || snapshot === undefined;
  const newList = [];
  const gone = [];
  const changed = [];

  if (!firstRun) {
    // Map (not a plain object) so iteration order matches the snapshot's
    // own array order -- plain objects would reorder integer-like string
    // keys numerically and silently scramble gone[]/changed[] ordering.
    const snapElig = new Map();
    for (const e of snapshot.eligible || []) snapElig.set(e.w2w_id, e);
    const snapRejectIds = new Set(snapshot.reject_ids || []);
    const snapKnown = new Set([...snapElig.keys(), ...snapRejectIds]);

    for (const rec of scored.eligible) {
      if (!snapKnown.has(rec.w2w_id)) newList.push(displayFields(rec));
    }

    for (const [wid, e] of snapElig) {
      if (e.date < today) continue; // expired -- pruned silently, never "gone"
      const rec = board.get(wid);
      if (rec === undefined) {
        gone.push(displayFields(e));
      } else if (rec.verdict === "reject") {
        changed.push({ ...displayFields(rec), from: "pass", to: "reject", reason: rec.reason });
      }
    }

    for (const wid of [...snapRejectIds].sort()) {
      const rec = board.get(wid);
      if (rec !== undefined && rec.verdict === "pass") {
        changed.push({ ...displayFields(rec), from: "reject", to: "pass", reason: rec.reason });
      }
    }
  }

  const diff = { first_run: firstRun, scanned: today, new: newList, gone, changed };

  const scores = scored.eligible.map((r) => r.score);
  const historyLine = {
    scanned: today,
    window_end: window.window_end,
    n_eligible: scored.eligible.length,
    n_rejects: scored.rejects.length,
    // Math.max(...[]) is -Infinity, not null -- guard the empty case
    // explicitly to match Python's `max(scores) if scores else None`.
    top_score: scores.length ? Math.max(...scores) : null,
    new_ids: newList.map((d) => d.w2w_id),
    gone_ids: gone.map((d) => d.w2w_id),
    changed_ids: changed.map((d) => d.w2w_id),
  };

  const newSnapshot = {
    scanned: today,
    window_end: window.window_end,
    eligible: scored.eligible.map(displayFields),
    reject_ids: scored.rejects.map((r) => r.w2w_id),
  };

  return { diff, historyLine, newSnapshot };
}
