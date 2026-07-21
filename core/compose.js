/**
 * Compose-text logic for the drawer's "copy message" flow. Recipient-neutral
 * by design: it builds a plain shift-list message with no name, greeting, or
 * audience baked in, so callers can prepend/append whatever framing a given
 * recipient needs.
 *
 * The Day/Night tour boundary rule lives in exactly ONE place -- rowshape.js's
 * tourOf() -- and is imported here rather than re-derived, so the extension
 * never has two competing definitions of "Day" to drift out of sync.
 */

import { tourOf } from "./rowshape.js";

const WEEKDAY_LETTER = ["Su", "M", "T", "W", "Th", "F", "S"]; // Sun..Sat, getUTCDay() order

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]; // duplicated from rowshape.js's MONTH_ABBR is fine -- it's data, not a rule

export const MESSAGE_HEADER = "Available Medic Shifts:";

/**
 * Formats a nominally "HH:MM" time (hour may be 1-2 digits) as 12-hour
 * clock time: minutes suppressed when :00, zero-padded otherwise, lowercase
 * am/pm with no space ("7am", "7:30am", "12am", "12:05pm"). Invalid input
 * (bad shape, hour > 23, minute > 59) is passed back through unchanged --
 * a raw string beats a silently wrong time in a message the medic is about
 * to send. Nullish input -> "?".
 * @param {string|null|undefined} hhmm
 * @returns {string}
 */
export function fmtTime12(hhmm) {
  if (hhmm == null) return "?";
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return hhmm;
  const period = hour < 12 ? "am" : "pm";
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  const minutePart = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  return `${h12}${minutePart}${period}`;
}

/**
 * Single-letter weekday for a "YYYY-MM-DD" date string ("Th" for Thursday,
 * etc.). Parsed via the /^(\d{4})-(\d{2})-(\d{2})$/ regex and
 * `Date.UTC(y, mo-1, d)` -- NEVER `new Date(dateStr)` string parsing, which
 * can shift a day in America/New_York (repo-wide timezone rule; see
 * rowshape.js's goneLabel doc comment). Invalid input -> "?".
 * @param {string|null|undefined} dateStr
 * @returns {string}
 */
export function dayLetter(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return "?";
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAY_LETTER[dow];
}

/**
 * "D" or "N" for a shift start time, per rowshape.js's tourOf() -- the
 * extension's [07:00, 19:00) Day window rule. Not re-derived here; see
 * tourOf's doc comment for the rule itself.
 * @param {string|null|undefined} start
 * @returns {"D"|"N"}
 */
export function tourLetter(start) {
  return tourOf(start) === "Day" ? "D" : "N";
}

/**
 * One bullet line for a single shift: "* Th Jul 23, D 7am-7pm". The
 * weekday and "Mon D" pieces both come from the same "YYYY-MM-DD" regex
 * parse as dayLetter; an invalid date falls back to "?" for the weekday
 * and the raw date string in the month-day slot. Overnight shifts (end
 * time earlier than start) get no next-day marker -- times are shown as
 * given, with no date-rollover annotation.
 * @param {{date: string, start: string, end: string, [key: string]: unknown}} shift
 * @returns {string}
 */
export function shiftLine(shift) {
  const { date, start, end } = shift;
  const weekday = dayLetter(date);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  const monthDay = m ? `${MONTH_ABBR[Number(m[2]) - 1]} ${Number(m[3])}` : date;
  const tour = tourLetter(start);
  return `* ${weekday} ${monthDay}, ${tour} ${fmtTime12(start)}-${fmtTime12(end)}`;
}

/**
 * Builds the full clipboard message for a list of shifts: header, a blank
 * line, then one bullet per shift (see shiftLine), sorted ascending by the
 * string `${date} ${start}` -- the same sortkey formula as rowshape.js's
 * sortkey(), applied here to a copy of the input (never mutates the caller's
 * array). The sort is stable, so same-sortkey shifts keep their input order.
 * An empty list is a special case: exactly MESSAGE_HEADER with no blank
 * line and no trailing newline (the general join formula would otherwise
 * leave a trailing newline after the header).
 * @param {Array<{date: string, start: string, end: string}>} shifts
 * @returns {string}
 */
export function composeMessage(shifts) {
  const sorted = [...shifts].sort((a, b) => {
    const ka = `${a.date ?? ""} ${a.start ?? ""}`;
    const kb = `${b.date ?? ""} ${b.start ?? ""}`;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  const lines = sorted.map(shiftLine);
  // Empty input is a special case: the general join formula below would
  // otherwise leave a trailing blank line ("HEADER\n"), but the contract is
  // "exactly MESSAGE_HEADER" with no trailing newline at all.
  if (lines.length === 0) return MESSAGE_HEADER;
  return [MESSAGE_HEADER, "", ...lines].join("\n");
}
