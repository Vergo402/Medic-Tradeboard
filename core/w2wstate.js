/**
 * Regex probes used to validate a tradeboard response before trusting it
 * (W2W's server-side view state can lag a request by one round trip).
 */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];

const MONTH_RE = new RegExp(`(${MONTH_NAMES.join("|")})\\s+(20\\d\\d)\\s+Tradeboard`);

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns a (month_name, year) pair, or [null, null] when the header isn't
 * found -- deliberately a pair rather than a single combined "MonthName
 * YYYY" string or a single null, mirrored here as a 2-element array.
 * @param {string} html
 * @returns {[string, number]|[null, null]}
 */
export function monthOf(html) {
  const m = MONTH_RE.exec(html);
  return m ? [m[1], Number(m[2])] : [null, null];
}

/**
 * True if the page's MTBView <select> shows `view` as Selected within 800
 * chars -- catches the same view-echo lag monthOf() catches for &Date=.
 *
 * Uses the 's' (dotAll) flag so '.' spans newlines, matching Python's
 * regex compiled with re.S (DOTALL).
 * @param {string} html
 * @param {string} view
 * @returns {boolean}
 */
export function viewOk(html, view) {
  const re = new RegExp(`name="MTBView".{0,800}?value="${reEscape(view)}"\\s+Selected`, "s");
  return re.test(html);
}

/**
 * True if the positions filter still shows All Positions (-1) Selected
 * within 400 chars -- guards against the account default changing and
 * silently shrinking coverage. Same 's' (dotAll) flag treatment as viewOk.
 * @param {string} html
 * @returns {boolean}
 */
export function skillOk(html) {
  return /name="EmpListSkill".{0,400}?value="-1"\s+Selected/s.test(html);
}
