/**
 * The single source of truth for one question: "is ANY calendar configured to
 * block a shift?" — i.e. is the scorer actually allowed to reject anything on
 * the strength of the user's calendar?
 *
 * Two surfaces ask this and must never disagree:
 *   - content/boot.js sets state.anyCalendarBlocks from anyoneBlocks(), which
 *     the drawer uses to decide whether to show the honest "not checking your
 *     calendar" state instead of a falsely-confident ranking.
 *   - options/options.js decides whether to raise its "nothing blocks" banner,
 *     via the per-calendar calendarBlocks() this module also exports.
 *
 * A calendar BLOCKS when:
 *   - its role is "REJECT" (every event hard-rejects an overlapping shift), OR
 *   - its role is "RULE" AND either it has at least one ticked block-title, OR
 *     the advanced regex hatch is armed (ruleUsePattern === true). The regex is
 *     a single global opt-in, so any RULE calendar counts as blocking once it
 *     is armed — matching how sw.js's calendarRule() actually behaves.
 *
 * Everything else — OFF, FLAG, or a RULE calendar with nothing ticked and no
 * pattern armed — blocks nothing. This closes the gap documented in the older
 * options.js calBlocks(), which returned false for a pattern-armed RULE
 * calendar and would have under-warned.
 *
 * Pure, no DOM and no chrome.* — unit tested in test/blocks.test.js. Every
 * input may be undefined, empty, or the wrong type; the answer is always a
 * boolean, never a throw.
 */

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Does ONE calendar block, given its role, its ticked block-titles, and the
 * global pattern opt-in? Shared by anyoneBlocks() and the options page so the
 * two surfaces can never disagree.
 *
 * @param {unknown} role          "OFF" | "FLAG" | "REJECT" | "RULE" (or anything)
 * @param {unknown} blockTitles   the ticked titles for this calendar (want an array)
 * @param {unknown} ruleUsePattern the advanced-regex opt-in flag
 * @returns {boolean}
 */
export function calendarBlocks(role, blockTitles, ruleUsePattern) {
  if (role === "REJECT") return true;
  if (role !== "RULE") return false;
  const hasTicks = Array.isArray(blockTitles) && blockTitles.length > 0;
  return hasTicks || ruleUsePattern === true;
}

/**
 * True if ANY calendar in calRoles is configured to block a shift.
 *
 * @param {unknown} calRoles       { [calendarId]: role } — sparse; may be undefined
 * @param {unknown} calBlockTitles { [calendarId]: string[] } — may be undefined
 * @param {unknown} ruleUsePattern boolean — may be undefined
 * @returns {boolean}
 */
export function anyoneBlocks(calRoles, calBlockTitles, ruleUsePattern) {
  if (!isPlainObject(calRoles)) return false;
  const titles = isPlainObject(calBlockTitles) ? calBlockTitles : {};
  const usePattern = ruleUsePattern === true;
  for (const calendarId of Object.keys(calRoles)) {
    if (calendarBlocks(calRoles[calendarId], titles[calendarId], usePattern)) {
      return true;
    }
  }
  return false;
}
