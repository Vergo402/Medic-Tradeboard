/**
 * Computes the new/gone/changed diff between this scan's scored board and
 * the prior scan's stored snapshot, plus the scan-history line and the
 * replacement snapshot.
 *
 * Signature note: `window` is its own positional argument (window.window_end)
 * rather than being nested inside `scored` -- `scored` only ever needs its
 * eligible/rejects fields.
 *
 * WINDOW SCOPING. A scan covers a DATE RANGE (window.scan_start ..
 * window.scan_end, inclusive, "YYYY-MM-DD" so lexical compare is correct),
 * which is NOT necessarily the whole snapshot. The extension scans only the
 * visible month, while the stored snapshot can span months of prior scans;
 * treating every snapshot record absent from this board as GONE would report
 * every other month as vanished and then overwrite the snapshot with one
 * month of data. So: `gone` only considers snapshot entries dated inside the
 * scanned range, and the replacement snapshot MERGES -- out-of-window entries
 * are carried over verbatim, in-window entries are replaced by this scan.
 * scan_start/scan_end are REQUIRED; a caller that forgets them gets a throw,
 * never a silent full-board wipe.
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
 * Prior snapshot's reject entries, normalized to {w2w_id, date}.
 *
 * Current snapshots carry `rejects: [{w2w_id, date}]` -- the date is what
 * makes the window-scoped merge possible at all. LEGACY snapshots (written
 * before window scoping) carry a bare `reject_ids` id list with no dates; a
 * dateless entry is normalized to date "" so it reads as OUT of every window
 * and BEFORE every `today`, i.e. it is dropped rather than preserved forever
 * -- a one-time, self-healing cost paid on the first scan after the upgrade.
 * @param {{rejects?: Array<{w2w_id: string|number, date?: string}>,
 *   reject_ids?: Array<string|number>}} snapshot
 * @returns {Array<{w2w_id: string|number, date: string}>}
 */
export function snapshotRejects(snapshot) {
  if (snapshot.rejects) return snapshot.rejects.map((r) => ({ w2w_id: r.w2w_id, date: r.date || "" }));
  return (snapshot.reject_ids || []).map((id) => ({ w2w_id: id, date: "" }));
}

/**
 * Prior entries this scan must NOT speak for: dated strictly outside
 * [scan_start, scan_end] and not already expired. Preserved verbatim into the
 * replacement snapshot, in their original order. The `>= today` half is the
 * same expiry prune `gone` applies -- without it, out-of-window entries would
 * accumulate in the snapshot forever.
 * @param {Array<{date?: string}>} entries
 * @param {(d: string) => boolean} inWindow
 * @param {string} today
 */
function carriedOver(entries, inWindow, today) {
  return entries.filter((e) => Boolean(e.date) && !inWindow(e.date) && e.date >= today);
}

/**
 * Computes the new/gone/changed diff between this scan and the prior
 * snapshot, returning the diff, the scan-history line, and the replacement
 * snapshot to persist.
 *
 * @param {{eligible: object[], rejects: object[]}} scored - records carry
 *   verdict/score/reason plus the DISPLAY_KEYS fields. Every record is
 *   assumed to lie inside [scan_start, scan_end]; the caller window-filters.
 * @param {{window_end: string, scan_start: string, scan_end: string}} window -
 *   the scan window's parsed content. scan_start/scan_end bound the DATE RANGE
 *   this scan actually covered (inclusive) and are required -- see the
 *   file-header WINDOW SCOPING note.
 * @param {{eligible: object[], rejects?: Array<{w2w_id: string|number, date: string}>,
 *   reject_ids?: Array<string|number>}|null} snapshot
 *   prior stored snapshot, or null on the very first run.
 * @param {string} today - "YYYY-MM-DD"
 * @returns {{diff: object, historyLine: object, newSnapshot: object}}
 */
export function runDiff(scored, window, snapshot, today) {
  if (!window || !window.scan_start || !window.scan_end) {
    // Loud on purpose: defaulting the range would silently mark every
    // out-of-window snapshot record GONE and then overwrite the snapshot.
    throw new TypeError("runDiff: window.scan_start and window.scan_end are required");
  }
  const inWindow = (d) => window.scan_start <= d && d <= window.scan_end;

  const board = new Map();
  for (const r of [...scored.eligible, ...scored.rejects]) board.set(r.w2w_id, r);

  const firstRun = snapshot === null || snapshot === undefined;
  const newList = [];
  const gone = [];
  const changed = [];
  // Map (not a plain object) so iteration order matches the snapshot's
  // own array order -- plain objects would reorder integer-like string
  // keys numerically and silently scramble gone[]/changed[] ordering.
  const snapElig = new Map();
  let snapRejects = [];

  if (!firstRun) {
    for (const e of snapshot.eligible || []) snapElig.set(e.w2w_id, e);
    snapRejects = snapshotRejects(snapshot);
    const snapRejectIds = new Set(snapRejects.map((r) => r.w2w_id));
    const snapKnown = new Set([...snapElig.keys(), ...snapRejectIds]);

    // `new` needs no window scoping of its own: the board only ever holds
    // in-window records, and an out-of-window snapshot id can only suppress a
    // NEW flag for that same id (a shift whose date moved into the window),
    // which is the wanted answer -- we have seen it before.
    for (const rec of scored.eligible) {
      if (!snapKnown.has(rec.w2w_id)) newList.push(displayFields(rec));
    }

    for (const [wid, e] of snapElig) {
      if (e.date < today) continue; // expired -- pruned silently, never "gone"
      const rec = board.get(wid);
      if (rec === undefined) {
        // Absent from THIS scan only means gone if this scan covered its
        // date; an out-of-window entry was never looked for.
        if (inWindow(e.date)) gone.push(displayFields(e));
      } else if (rec.verdict === "reject") {
        // Scoped by construction: a record present on the board is in-window,
        // whatever date the snapshot had for it. Deliberately NOT gated on
        // inWindow(e.date), so a shift that moved INTO the window still
        // reports its pass->reject flip.
        changed.push({ ...displayFields(rec), from: "pass", to: "reject", reason: rec.reason });
      }
    }

    // Same window-safety-by-construction as the pass->reject pass above.
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
    // The range actually scanned, logged next to the configured window_end so
    // a one-month scan inside a four-month window is legible in the history.
    scan_start: window.scan_start,
    scan_end: window.scan_end,
    n_eligible: scored.eligible.length,
    n_rejects: scored.rejects.length,
    // Math.max(...[]) is -Infinity, not null -- guard the empty case
    // explicitly to match Python's `max(scores) if scores else None`.
    top_score: scores.length ? Math.max(...scores) : null,
    new_ids: newList.map((d) => d.w2w_id),
    gone_ids: gone.map((d) => d.w2w_id),
    changed_ids: changed.map((d) => d.w2w_id),
  };

  // MERGE, never wholesale replace: carried-over entries first (in their
  // snapshot order), then this scan's records (in rank order). Ordering
  // inside each group is preserved, which is all gone[]/changed[] ordering
  // semantics depend on.
  const newSnapshot = {
    scanned: today,
    window_end: window.window_end,
    scan_start: window.scan_start,
    scan_end: window.scan_end,
    eligible: [
      ...carriedOver([...snapElig.values()], inWindow, today),
      ...scored.eligible.map(displayFields),
    ],
    rejects: [
      ...carriedOver(snapRejects, inWindow, today).map((r) => ({ w2w_id: r.w2w_id, date: r.date })),
      ...scored.rejects.map((r) => ({ w2w_id: r.w2w_id, date: r.date })),
    ],
  };

  return { diff, historyLine, newSnapshot };
}
