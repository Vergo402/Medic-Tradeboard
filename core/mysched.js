/**
 * Parses the user's own W2W schedule (the "My Upcoming Shifts" list), which
 * feeds the scorer's collision-reject check: a shift the medic is already
 * working can never be a candidate to pick up.
 *
 * Only the EMPTY state has been observed live. A populated list is an unseen
 * format, so it is reported as such rather than guessed at — the three
 * outcomes (empty / populated-but-uncaptured / unrecognized) are returned as
 * distinct status values.
 */

const EMPTY_MARKER = "not currently scheduled for any shifts";

/**
 * Classify a "My Upcoming Shifts" page.
 * @param {string} html
 * @returns {{status: "ok", schedule: []}|{status: "unknown"}|{status: "unrecognized"}}
 */
export function parseMysched(html) {
  if (html.includes(EMPTY_MARKER)) {
    return { status: "ok", schedule: [] };
  }
  if (html.includes("My Upcoming Shifts")) {
    // Populated list found, but the row format hasn't been captured yet.
    return { status: "unknown" };
  }
  return { status: "unrecognized" };
}

function nextCalendarDay(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + 1));
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Fallback when the schedule page can't be parsed: derive own-shift triplets
 * from the tradeboard's own $/! markers (kind my_shift/my_post) for records
 * that have a start time. Known coverage gap — only shifts that appear on the
 * board are visible this way.
 *
 * End rolls to the next calendar day when end <= start (plain string
 * comparison on "HH:MM" -- note this is <=, not <, so equal start/end (a 24h
 * tour) also rolls over).
 * @param {object[]} records - parsed tradeboard records.
 * @returns {Array<[string, string, string]>} [startStr, endStr, label] triplets,
 *   e.g. ["2026-08-01 19:00", "2026-08-02 07:00", "35 Medic 2 Northgate Station"].
 */
export function fallbackFromTradeboard(records) {
  const out = [];
  for (const r of records) {
    if ((r.kind === "my_shift" || r.kind === "my_post") && r.start) {
      const start = `${r.date} ${r.start}`;
      const endDate = r.end <= r.start ? nextCalendarDay(r.date) : r.date;
      const end = `${endDate} ${r.end}`;
      const label = `${r.position} ${r.text}`.trim();
      out.push([start, end, label]);
    }
  }
  return out;
}
