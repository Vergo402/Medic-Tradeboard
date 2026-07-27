/**
 * Display helpers: row shaping for the drawer and the board badges
 * (loc/posShort/goneLabel/tourOf/sortkey/tierClass/posterNote, plus the
 * reject chip label).
 *
 * DELIBERATE DEPARTURE (posterNote only -- by design): the extension drops
 * the drop/trade distinction, so posterNote returns a single "<Surname>
 * posted" note for any coworker post, rather than distinguishing
 * "<Surname> — clean pickup" for drop posts from "<Surname> — wants a
 * swap" for trade posts. Do not treat this as a bug -- the kind-specific
 * wording is intentionally not implemented here.
 *
 * Scoping note (report this, not a silent choice): posterNote here fires
 * only for kind === "drop_post" | "trade_post" ("coworker '#' posts"). A
 * broader gate that fired on any kind other than "open"/"drop_post" would
 * also catch "my_post" and "my_shift" -- the user's own posts -- if their
 * text happened to contain ", ". Narrowing to the two genuine
 * coworker-post kinds avoids that false positive; it's a deliberate scope
 * decision, not an oversight.
 */

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Extracts the bare location from a row's raw text: strips a leading
 * "(Unassigned)" marker, or a coworker post's leading "Lastname, Firstname "
 * pair, down to the location.
 * @param {string} text
 * @returns {string}
 */
export function loc(text) {
  const t = text || "";
  if (t.includes("(Unassigned)")) {
    return t.replaceAll("(Unassigned)", "").trim();
  }
  // Coworker posts are "Lastname, Firstname  Location" -- drop the leading
  // "Lastname, Firstname " pair and keep the rest as the location.
  const m = /^[^,]+,\s*\S+\s+(.*)$/.exec(t);
  if (m) return m[1].trim();
  return t.trim();
}

/**
 * Strips the leading "35 " position-code prefix: "35 Medic 1" -> "Medic 1".
 * @param {string} position
 * @returns {string}
 */
export function posShort(position) {
  return position.replaceAll("35 ", "");
}

/**
 * Fallback commitment label, used when the user has not configured one. The
 * display layer substitutes the user's own word (e.g. their department or
 * second job) wherever a hard commitment is named. Nothing employer-specific
 * may ever be baked in here.
 */
export const DEFAULT_COMMITMENT_LABEL = "Commitment";

/**
 * Score tier thresholds: score >= 47 -> 't1', >= 25 -> 't2', else 't3'.
 * @param {number} score
 * @returns {"t1"|"t2"|"t3"}
 */
export function tierClass(score) {
  return score >= 47 ? "t1" : score >= 25 ? "t2" : "t3";
}

/**
 * Formats a gone/removed shift label like "Oct 1 Night M1". Dates are
 * parsed by splitting the "YYYY-MM-DD" string manually (never
 * `new Date(dateStr)`, which parses as UTC midnight and can display as the
 * previous day in America/New_York). The tour component comes from
 * tourOf()'s [07:00, 19:00) window rule (see its doc comment below), not a
 * literal `start == "07:00"` string check.
 * @param {{date: string, start: string, position?: string}} entry
 * @returns {string}
 */
export function goneLabel(entry) {
  const [, mo, d] = entry.date.split("-").map(Number);
  const tour = tourOf(entry.start);
  const pos = (entry.position || "").replaceAll("35 ", "").replaceAll("Medic ", "M");
  return `${MONTH_ABBR[mo - 1]} ${d} ${tour} ${pos}`;
}

/**
 * EXTENSION Day/Night rule. The extension treats the whole [07:00, 19:00)
 * window as "Day" ("7am is start of day, 7pm is start of night for medic
 * shifts"), rather than matching only an exact `start == "07:00"` string.
 * That range check also means an unpadded "7:00" (single-digit hour) is
 * matched correctly as Day instead of falling through to Night, since the
 * hour is parsed as a number (1-2 digits accepted), not compared as a
 * literal string.
 * @param {string|null|undefined} start nominally "HH:MM" (hour may be 1-2
 *   digits); null/garbage tolerated.
 * @returns {"Day"|"Night"}
 */
export function tourOf(start) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(start || "");
  if (!m) return "Night";
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return "Night";
  const mins = hour * 60 + minute;
  return mins >= 420 && mins < 1140 ? "Day" : "Night";
}

/**
 * Sort key shared by eligible and reject rows: "{date} {start}", which
 * sorts correctly as a plain string since both fields are zero-padded.
 * @param {{date: string, start: string}} rec
 * @returns {string}
 */
export function sortkey(rec) {
  return `${rec.date} ${rec.start}`;
}

/**
 * See the module doc comment (DELIBERATE DEPARTURE) for the reasoning.
 * Returns "<Surname> posted" for coworker drop/trade posts whose text is
 * "Lastname, Firstname Location" (surname = text up to the first ", "), or
 * null for open/my_post/my_shift records and any post without a comma.
 * @param {{kind: string, text: string}} rec
 * @returns {string|null}
 */
export function posterNote(rec) {
  if (rec.kind !== "drop_post" && rec.kind !== "trade_post") return null;
  const text = rec.text || "";
  if (!text.includes(", ")) return null;
  const surname = text.split(", ")[0];
  return `${surname} posted`;
}

/**
 * Chip label for a rejected row, keyed off the STRUCTURED `rejectKind`
 * score.js's evaluate() returns -- never off the reason prose. String
 * matching was fragile in both directions: the reason wording is free to
 * change, and a user whose commitment label happens to read like another
 * reject category ("My Shifts") would collide with it.
 *
 * Only the "commitment" kind carries a user-configured word; the other kinds
 * are board-wide concepts with fixed wording.
 *
 * `rejectLabel` is the overlapping commitment's triplet label, and by the time
 * it reaches here it has ALREADY been resolved by sw.js's bucketEvents to the
 * most specific thing the user configured — the per-event "show as" if there is
 * one, else the feed's own commitment word. That resolution has to happen there,
 * not here, because score.js merges overlapping commitments and keeps only the
 * first label, so which feed a rejection came from is no longer knowable at this
 * point. An empty/absent `rejectLabel` means the user configured nothing for
 * that feed and falls back to DEFAULT_COMMITMENT_LABEL.
 *
 * `rejectGapHours` is the smallest FAILING gap (evaluate() computes it; do not
 * substitute `score`, which also counts gaps that passed the tour check) and is
 * rounded with `Math.round`. Unknown/absent kinds fall back to "✕ REJECTED", and
 * a buffer reject with no gap number to "✕ BUFFER".
 * @param {{rejectKind?:string|null, rejectLabel?:string|null, rejectGapHours?:number|null}|null|undefined} reject
 *   the evaluate() result (or the row built from it)
 * @returns {string} short chip label, e.g. "✕ Fire Dept", "✕ Drill", "✕ BUFFER 10h"
 */
export function rejectChipLabel(reject) {
  const kind = reject && reject.rejectKind;
  if (kind === "commitment") {
    const custom = reject.rejectLabel;
    if (typeof custom === "string" && custom.trim()) return `✕ ${custom.trim()}`;
    return `✕ ${DEFAULT_COMMITMENT_LABEL}`;
  }
  if (kind === "my_shift") return "✕ Medic Shift";
  if (kind === "buffer") {
    const gap = reject.rejectGapHours;
    if (typeof gap !== "number" || !Number.isFinite(gap)) return "✕ BUFFER";
    return `✕ BUFFER ${Math.round(gap)}h`;
  }
  return "✕ REJECTED";
}
