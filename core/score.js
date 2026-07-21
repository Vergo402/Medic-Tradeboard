/**
 * THE RULE, applied to one posted shift against the user's own calendars:
 *   1. reject on any overlap with a hard commitment (an event from a calendar
 *      the user marked REJECT)
 *   2. require >=1 complete open day-or-night tour fully inside the gap on
 *      each side (grids: 08-18/18-08, 07-19/19-07; boundary-touch counts)
 *   3. rank by hours to the nearest commitment (min of before/after)
 *
 * This module is PURE and user-agnostic: it never sees the user's configured
 * commitment label, and every string it emits is neutral. Rejects carry a
 * structured `rejectKind` so the display layer can label them without
 * string-matching the prose.
 */

import { parseCivil, toEpoch, addDays, addHours, hours, fmt, fmtHM, civilFromEpoch } from "./nytime.js";

const TOUR_STARTS = [
  [7, 19],
  [19, 7],
  [8, 18],
  [18, 8],
];

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
 * Parse+sort+merge raw [start, end, label] string triplets into commitment
 * blocks: sort by (start, end, label), then merge when the next block's
 * start touches-or-overlaps the running merge's end (TOUCHING MERGES),
 * extending the end to the max and keeping the FIRST label.
 * @param {Array<[string, string, string]>} triplets
 * @returns {Array<{s:number, e:number, label:string, sCivil:object, eCivil:object}>}
 */
export function loadCommitments(triplets) {
  const parsed = triplets.map(([a, b, label]) => {
    const sCivil = parseCivil(a);
    const eCivil = parseCivil(b);
    return { s: toEpoch(sCivil), e: toEpoch(eCivil), label, sCivil, eCivil };
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
      // first label wins - leave last.label untouched
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Checks whether a full open tour fits inside the gap [gs, ge). gs/ge are
 * POSIX-second instants; the calendar date to start scanning from is derived
 * from gs's NY civil date minus one day (mirroring Python's
 * `date - timedelta(days=1)` semantics), since a tour starting the evening
 * before a gap can still fully contain it.
 *
 * t2 is computed via CIVIL wall-clock addHours (not epoch + duration*3600) -
 * this is the DST tripwire: a 12h civil tour starting the evening before a
 * fall-back transition ends 13 REAL hours later, and the containment checks
 * below compare against gs/ge as instants (epochs), so that extra real hour
 * is what lets a tour fully cover a 26h real gap.
 * @param {number} gs gap start, POSIX seconds
 * @param {number} ge gap end, POSIX seconds
 */
export function openTourInGap(gs, ge) {
  let day = addDays(civilFromEpoch(gs), -1);
  // Python re-evaluates `ge + timedelta(days=1)` every loop iteration, but it
  // never changes, so hoisting it here is behavior-preserving.
  const geComparisonEpoch = toEpoch(addDays(civilFromEpoch(ge), 1));

  while (true) {
    for (const [h1, h2] of TOUR_STARTS) {
      const t1Civil = { y: day.y, mo: day.mo, d: day.d, h: h1, mi: 0 };
      const t1 = toEpoch(t1Civil);
      const duration = ((h2 - h1) % 24 + 24) % 24 || 24;
      const t2 = toEpoch(addHours(t1Civil, duration));
      if (t1 >= gs && t2 <= ge) return true;
    }
    day = addDays(day, 1);
    const dayMidnightEpoch = toEpoch({ y: day.y, mo: day.mo, d: day.d, h: 0, mi: 0 });
    if (dayMidnightEpoch > geComparisonEpoch) return false;
  }
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
 *   "buffer"     — no complete open tour fits in the gap on one/both sides
 * plus `rejectGapHours`: for a buffer reject, the smallest FAILING gap in
 * hours (null otherwise). That is deliberately not `score` — score is the min
 * over all gaps, including a side that passed the tour check, so the two
 * differ whenever the smaller gap is the one that passed.
 * @param {{date:string, start:string, end:string}} rec
 * @param {Array<{s:number,e:number,label:string,sCivil:object,eCivil:object}>} commitments
 * @param {Array<{s:number,e:number,label:string,sCivil:object,eCivil:object}>} [myShifts]
 * @param {Array<{s:number,e:number,label:string}>} [softEvents]
 */
export function evaluate(rec, commitments, myShifts = [], softEvents = []) {
  const { startEpoch, endEpoch } = shiftTimes(rec);

  const fam = softEvents.filter((e) => e.s < endEpoch && e.e > startEpoch).map((e) => e.label);

  const overlap = commitments.filter((c) => c.s < endEpoch && c.e > startEpoch);
  if (overlap.length) {
    const c = overlap[0];
    return {
      verdict: "reject",
      reason: `overlaps a commitment (${fmt(c.sCivil)}-${fmtHM(c.eCivil)})`,
      rejectKind: "commitment",
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

  let gb = null;
  let ga = null;
  let before = null;
  let after = null;
  let ok = true;
  const why = [];
  // Gaps that FAILED the open-tour check, in hours. Kept separate from the
  // gaps that feed `score` so the display layer can show the gap that
  // actually caused the reject.
  const failedGaps = [];

  const prevs = commitments.filter((c) => c.e <= startEpoch);
  const nexts = commitments.filter((c) => c.s >= endEpoch);

  if (prevs.length) {
    const p = prevs.reduce((best, c) => (c.e > best.e ? c : best));
    gb = hours(p.e, startEpoch);
    before = `commitment ends ${fmt(p.eCivil)} (${gb.toFixed(1)}h before)`;
    if (!openTourInGap(p.e, startEpoch)) {
      ok = false;
      failedGaps.push(gb);
      why.push(`no full open tour after the previous commitment (${gb.toFixed(1)}h gap)`);
    }
  }
  if (nexts.length) {
    const n = nexts.reduce((best, c) => (c.s < best.s ? c : best));
    ga = hours(endEpoch, n.s);
    after = `commitment starts ${fmt(n.sCivil)} (${ga.toFixed(1)}h after)`;
    if (!openTourInGap(endEpoch, n.s)) {
      ok = false;
      failedGaps.push(ga);
      why.push(`no full open tour before the next commitment (${ga.toFixed(1)}h gap)`);
    }
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
