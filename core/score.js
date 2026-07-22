/**
 * THE RULE, applied to one posted shift against the user's own calendars:
 *   1. reject on any overlap with a hard commitment (an event from a calendar
 *      the user marked REJECT)
 *   2. honor each commitment's explicit rest buffer: a commitment carries
 *      `restBefore`/`restAfter` hours (per-calendar default, optionally
 *      overridden per event; 0 when unset). A shift is rejected when it starts
 *      fewer than `restAfter` clear hours after a commitment ends, or ends
 *      fewer than `restBefore` clear hours before a commitment starts. With the
 *      0/0 default a commitment blocks only direct overlaps. Gaps are TRUE
 *      elapsed (DST-aware) hours, and gap == buffer passes (strict `<` fails).
 *   3. rank by hours to the nearest commitment (min of before/after)
 *
 * The buffer check iterates ALL commitments on each side against their OWN
 * buffer, because per-commitment buffers are non-monotonic: a farther
 * commitment with a large buffer can bind when a nearer small-buffer one
 * passes. `score` (ranking) still measures only the NEAREST commitment each
 * side, so a buffer reject's `rejectGapHours` (the smallest FAILING gap) can
 * differ from — even exceed — its `score`.
 *
 * This module is PURE and user-agnostic: it never sees the user's configured
 * commitment label, and every string it emits is neutral. Rejects carry a
 * structured `rejectKind` so the display layer can label them without
 * string-matching the prose.
 */

import { parseCivil, toEpoch, addDays, hours, fmt, fmtHM } from "./nytime.js";

/**
 * Sanitize a triplet's rest-buffer field into a non-negative finite number of
 * hours. Missing/short array, non-number, NaN/Infinity, or a negative value all
 * collapse to 0 (a 0-buffer commitment blocks only direct overlaps).
 * @param {unknown} v
 * @returns {number}
 */
function restHours(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Render a rest-buffer hour count for reason prose: a plain number with no
 * forced decimal ("12", "12.5"), matching the "(needs 12)" contract.
 * @param {number} n
 * @returns {string}
 */
function needStr(n) {
  return String(n);
}

/**
 * Parse rec.date ("YYYY-MM-DD") + rec.start/rec.end ("HH:MM") into civil and
 * epoch start/end. If end <= start (compared as instants, the same way
 * Python's aware-datetime `end <= start` resolves), the shift spans midnight
 * and end's civil date rolls forward one day.
 * @param {{date:string, start:string, end:string}} rec
 */
export function shiftTimes(rec) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.date);
  if (!dm) {
    throw new Error(`time data '${rec.date}' does not match format '%Y-%m-%d'`);
  }
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  const [sh, sm] = rec.start.split(":").map(Number);
  const [eh, em] = rec.end.split(":").map(Number);

  const startCivil = { y, mo, d, h: sh, mi: sm };
  let endCivil = { y, mo, d, h: eh, mi: em };
  const startEpoch = toEpoch(startCivil);
  let endEpoch = toEpoch(endCivil);
  if (endEpoch <= startEpoch) {
    endCivil = addDays(endCivil, 1);
    endEpoch = toEpoch(endCivil);
  }
  return { startCivil, endCivil, startEpoch, endEpoch };
}

/**
 * Parse+sort+merge raw commitment triplets into commitment blocks. A blocking
 * triplet is [start, end, label, restBefore, restAfter]; the two buffer fields
 * are optional (old caches are [start, end, label]) and default to 0 via
 * restHours(). Sort by (start, end, label), then merge when the next block's
 * start touches-or-overlaps the running merge's end (TOUCHING MERGES),
 * extending the end to the max and keeping the FIRST label. Merged buffers take
 * the MAX on each side (most restrictive wins).
 * @param {Array<[string, string, string, number?, number?]>} triplets
 * @returns {Array<{s:number, e:number, label:string, sCivil:object, eCivil:object, restBefore:number, restAfter:number}>}
 */
export function loadCommitments(triplets) {
  const parsed = triplets.map(([a, b, label, rb, ra]) => {
    const sCivil = parseCivil(a);
    const eCivil = parseCivil(b);
    return {
      s: toEpoch(sCivil),
      e: toEpoch(eCivil),
      label,
      sCivil,
      eCivil,
      restBefore: restHours(rb),
      restAfter: restHours(ra),
    };
  });
  parsed.sort((x, y) => {
    if (x.s !== y.s) return x.s - y.s;
    if (x.e !== y.e) return x.e - y.e;
    if (x.label < y.label) return -1;
    if (x.label > y.label) return 1;
    return 0;
  });

  const merged = [];
  for (const cur of parsed) {
    const last = merged[merged.length - 1];
    if (last && cur.s <= last.e) {
      if (cur.e > last.e) {
        last.e = cur.e;
        last.eCivil = cur.eCivil;
      }
      // first label wins - leave last.label untouched; buffers take the max on
      // each side so the most restrictive rest requirement survives the merge.
      last.restBefore = Math.max(last.restBefore, cur.restBefore);
      last.restAfter = Math.max(last.restAfter, cur.restAfter);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Evaluate one shift record against hard commitments, the medic's own W2W
 * shifts, and soft/flag calendar events.
 *
 * Precedence: commitment overlap is checked before my-shift overlap. A
 * buffer-failure reject KEEPS its numeric score; only overlap/collision
 * rejects null the score.
 *
 * Every reject also carries a structured `rejectKind`:
 *   "commitment" — overlaps an event on a REJECT-role calendar
 *   "my_shift"   — collides with one of the user's own W2W shifts
 *   "buffer"     — starts/ends inside a commitment's required rest window
 * plus `rejectGapHours`: for a buffer reject, the smallest FAILING gap in
 * hours (null otherwise). That is deliberately not `score` — score measures
 * only the NEAREST commitment each side (0-buffer neighbors included), while a
 * FARTHER commitment with a larger buffer can be the one that fails, so the two
 * differ whenever the failing gap is not the nearest.
 * @param {{date:string, start:string, end:string}} rec
 * @param {Array<{s:number,e:number,label:string,sCivil:object,eCivil:object,restBefore:number,restAfter:number}>} commitments
 * @param {Array<{s:number,e:number,label:string,sCivil:object,eCivil:object}>} [myShifts]
 * @param {Array<{s:number,e:number,label:string}>} [softEvents]
 */
export function evaluate(rec, commitments, myShifts = [], softEvents = []) {
  const { startEpoch, endEpoch } = shiftTimes(rec);

  // Dedupe by label: an overnight shift spans two calendar days, so it overlaps
  // BOTH days' copies of an all-day note (and the same event reached from two
  // calendars lands twice too). The commitment side already merges; notes must
  // collapse the same way, or an overnight shift's badge reads the same note twice.
  const fam = [...new Set(
    softEvents.filter((e) => e.s < endEpoch && e.e > startEpoch).map((e) => e.label)
  )];

  const overlap = commitments.filter((c) => c.s < endEpoch && c.e > startEpoch);
  if (overlap.length) {
    const c = overlap[0];
    return {
      verdict: "reject",
      reason: `overlaps a commitment (${fmt(c.sCivil)}-${fmtHM(c.eCivil)})`,
      rejectKind: "commitment",
      // The overlapping commitment's per-event "show as" label, or "" when it
      // carries none. The display layer (rowshape.rejectChipLabel) uses this to
      // label the reject chip, falling back to the user's global commitmentLabel
      // when it is empty. This module stays user-agnostic: the string it emits
      // is the user's OWN calendar label, never an employer default baked in.
      rejectLabel: c.label,
      rejectGapHours: null,
      score: null,
      before: null,
      after: null,
      fam,
    };
  }

  const myOverlap = myShifts.filter((c) => c.s < endEpoch && c.e > startEpoch);
  if (myOverlap.length) {
    const c = myOverlap[0];
    return {
      verdict: "reject",
      reason: `overlaps your medic shift (${fmt(c.sCivil)}-${fmtHM(c.eCivil)})`,
      rejectKind: "my_shift",
      rejectGapHours: null,
      score: null,
      before: null,
      after: null,
      fam,
    };
  }

  const prevs = commitments.filter((c) => c.e <= startEpoch);
  const nexts = commitments.filter((c) => c.s >= endEpoch);

  const why = [];
  // Gaps that FAILED a commitment's rest buffer, in hours. Kept separate from
  // the gaps that feed `score` (nearest neighbor only) so the display layer can
  // show the gap that actually caused the reject.
  const failedGaps = [];

  // Iterate ALL prevs/nexts against their OWN buffer: per-commitment buffers are
  // non-monotonic, so a farther large-buffer commitment can fail while a nearer
  // small-buffer one passes. prevs/nexts stay in loadCommitments' start-sorted
  // order, so the joined clauses are deterministic (prev clauses first).
  for (const p of prevs) {
    const gap = hours(p.e, startEpoch);
    if (gap < p.restAfter) {
      failedGaps.push(gap);
      why.push(`only ${gap.toFixed(1)}h after a commitment (needs ${needStr(p.restAfter)})`);
    }
  }
  for (const n of nexts) {
    const gap = hours(endEpoch, n.s);
    if (gap < n.restBefore) {
      failedGaps.push(gap);
      why.push(`only ${gap.toFixed(1)}h before a commitment (needs ${needStr(n.restBefore)})`);
    }
  }
  const ok = failedGaps.length === 0;

  // `score` and the before/after prose describe only the NEAREST commitment on
  // each side (0-buffer neighbors included), regardless of which commitment
  // actually failed above.
  let gb = null;
  let ga = null;
  let before = null;
  let after = null;
  if (prevs.length) {
    const p = prevs.reduce((best, c) => (c.e > best.e ? c : best));
    gb = hours(p.e, startEpoch);
    before = `commitment ends ${fmt(p.eCivil)} (${gb.toFixed(1)}h before)`;
  }
  if (nexts.length) {
    const n = nexts.reduce((best, c) => (c.s < best.s ? c : best));
    ga = hours(endEpoch, n.s);
    after = `commitment starts ${fmt(n.sCivil)} (${ga.toFixed(1)}h after)`;
  }

  const gaps = [gb, ga].filter((g) => g !== null);
  const score = gaps.length ? Math.min(...gaps) : 999;

  return {
    verdict: ok ? "pass" : "reject",
    reason: why.length ? why.join("; ") : "clears buffer rule",
    rejectKind: ok ? null : "buffer",
    rejectGapHours: failedGaps.length ? Math.min(...failedGaps) : null,
    score,
    before,
    after,
    fam,
  };
}

/**
 * Final ranking step: eligible (pass) results sorted STABLY by descending
 * score (input is expected pre-sorted by (date, start), and
 * Array.prototype.sort is stable in Node, so ties keep that original order).
 * Rejects are returned in input order, unsorted.
 * @param {Array<object>} results
 */
export function rankEligible(results) {
  const eligible = results.filter((r) => r.verdict === "pass").sort((a, b) => b.score - a.score);
  const rejects = results.filter((r) => r.verdict === "reject");
  return { eligible, rejects };
}
