/**
 * MV3 service worker (ESM module — manifest declares "type": "module").
 *
 * Purpose: on request from the content script, produce two triplet lists for
 * the scoring engine in NY-local "YYYY-MM-DD HH:MM" string form:
 *   - commitments: hard conflicts — every event of a REJECT calendar, plus the
 *     events of a RULE calendar whose title matches the user's block list.
 *   - soft: annotations — every event of a FLAG calendar, plus the events of a
 *     RULE calendar whose title does NOT match.
 *
 * A RULE calendar's block list is the set of real event titles the user ticked
 * in the picker (`calBlockTitles`), matched by stem, anchored at the start of
 * the title. THAT IS THE WHOLE BLOCKING SET: a RULE calendar with nothing
 * ticked blocks NOTHING. The older ruleInclude/ruleExclude regex applies only
 * to a user who explicitly opted into the advanced pattern hatch (the stored
 * `ruleUsePattern` flag) — never as a fallback inferred from an empty tick list.
 *
 * Calendar identity is per-user config, never code. Every Google calendar the
 * signed-in account can see carries one of four roles — OFF | FLAG | REJECT |
 * RULE — chosen by the user and stored sparsely under `calRoles`. An id with no
 * stored entry falls back to defaultRole(), which is deliberately conservative:
 * it never invents a hard reject for a calendar the user has not spoken about.
 *
 * Events from non-primary calendars are labelled "<calendar summary> · <title>";
 * primary-calendar events stay unprefixed, so an unprefixed label means the
 * event came from the user's own calendar.
 *
 * PRIVACY/SAFETY:
 *   - Read-only Google Calendar (calendar.readonly). Never writes to any Google
 *     API; only ever GETs from https://www.googleapis.com/calendar/v3/*.
 *   - Never logs event titles or attendee data on production paths. A single
 *     DEBUG flag (default false) gates the only verbose logging, and even then
 *     we log counts/warnings/mode — never event summaries.
 *   - OFF calendars are never fetched: the refresh loop skips them before any
 *     events request, so their contents never reach this extension. EVERY
 *     calendar starts OFF — including the signed-in account's own primary.
 *     Nothing is read until the user explicitly turns it on.
 *
 * ALL chrome.* references live inside function/listener bodies (the sole
 * top-level touch is the typeof-guarded addListener at the bottom) so a bare
 * `import` of this module in Node — for offline unit tests of the pure helpers
 * — succeeds without a chrome global.
 */

import { toEpoch, civilFromEpoch, addDays, parseCivil } from "./core/nytime.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

// Starting point for the RULE role's regex. Both values are placeholders the
// user is expected to replace with the title convention their own employer's
// calendar feed uses — nothing here is employer-specific.
//
// ruleInclude MUST NOT default to "" — and an empty stored value must never be
// honoured either: new RegExp("") matches every string, so an empty include
// pattern would make the first calendar a user flips to RULE hard-reject ALL of
// its events, silently hiding every shift they could have taken. The default is
// anchored and matches little on purpose; resolveIncludeRegex() below enforces
// the same rule at read time.
const DEFAULTS = { ruleInclude: "^Work\\b", ruleExclude: "" };

// Separator between a non-primary calendar's summary and the event title
// (U+00B7 middle dot).
const LABEL_SEP = " · ";

const ROLES = ["OFF", "FLAG", "REJECT", "RULE"];
const ROLES_KEY = "calRoles";

// Per-calendar list of the event titles the user ticked as "I am unavailable":
// { [calendarId]: string[] }. This is the ONLY way a RULE calendar decides a
// hard reject unless the pattern hatch below is explicitly armed. Empty list ⇒
// that calendar blocks nothing.
const BLOCK_TITLES_KEY = "calBlockTitles";

// The user's explicit opt-in to the legacy regex ("advanced pattern") hatch.
// Written ONLY by handleSetRuleFilter, i.e. only when the user opened the
// advanced disclosure on the options page and saved a real pattern.
//
// This flag exists because the alternative — inferring "use the regex" from an
// EMPTY ticked list — is the bug it replaces: it made a RULE calendar with
// nothing ticked hard-reject every event matching the default "^Work\b", which
// is the exact opposite of what the options page tells the user that state
// means, and it made "I want nothing to block" unrepresentable (un-ticking
// everything stores [] and would re-arm the regex).
const PATTERN_OPT_IN_KEY = "ruleUsePattern";

const CACHE_KEY = "calCache";

// Verbose logging is OFF in production. When flipped on for local debugging it
// still must not log event titles or attendee data — only counts/ids/warnings.
const DEBUG = false;
function dlog(...args) {
  if (DEBUG) console.log("[sw]", ...args);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for future offline tests — no chrome.* inside)
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtCivil(c) {
  // "YYYY-MM-DD HH:MM" — the format core/nytime.js's parseCivil() expects.
  return `${c.y}-${pad2(c.mo)}-${pad2(c.d)} ${pad2(c.h)}:${pad2(c.mi)}`;
}

/**
 * Convert a Google Calendar event to a [start, end] triplet pair in NY-local
 * "YYYY-MM-DD HH:MM" form, or null if it carries no usable start.
 *
 * Timed events (start.dateTime): the instant is normalized to NY civil time via
 * nytime civilFromEpoch(ms/1000), so any foreign-timezone event lands on NY
 * wall time — the scorer's expected frame.
 *
 * All-day events (start.date / end.date): Google's all-day end.date is ALREADY
 * the exclusive next day, so we DO NOT add a day — the pair already reads as
 * "00:00 → next-day 00:00", the same all-day convention the scorer expects.
 *
 * @param {object} event
 * @returns {[string,string]|null}
 */
export function buildTriplet(event) {
  const s = (event && event.start) || {};
  const e = (event && event.end) || {};
  if (s.dateTime) {
    const startStr = fmtCivil(civilFromEpoch(Date.parse(s.dateTime) / 1000));
    const endMs = e.dateTime ? Date.parse(e.dateTime) : Date.parse(s.dateTime);
    const endStr = fmtCivil(civilFromEpoch(endMs / 1000));
    return [startStr, endStr];
  }
  if (s.date) {
    const startStr = `${s.date} 00:00`;
    const endStr = `${e.date || s.date} 00:00`;
    return [startStr, endStr];
  }
  return null; // no start.date and no start.dateTime — skip.
}

/**
 * The RULE role's commitment filter: title matches the include regex AND
 * contains none of the exclude substrings (case-insensitive). Both the regex
 * and the exclude list are user-supplied config, not code.
 *
 * @param {string} summary  the RAW event title — never a prefixed label
 * @param {RegExp} includeRe  built with the "i" flag (stateless — no "g")
 * @param {string[]} excludes lowercased, trimmed, non-empty substrings
 * @returns {boolean}
 */
export function ruleMatches(summary, includeRe, excludes) {
  const str = summary || "";
  if (!includeRe.test(str)) return false;
  const low = str.toLowerCase();
  for (const ex of excludes) {
    if (ex && low.includes(ex)) return false;
  }
  return true;
}

// The separators that end a title's leading segment. Three dash variants
// (hyphen, em dash, en dash) each surrounded by spaces, plus colon-space.
//
// These carry ASCII spaces ONLY, which is safe exclusively because every title
// is run through normalizeTitleWhitespace() first — see the note there.
const STEM_SEPARATORS = [" - ", " — ", " – ", ": "];

// Zero-width characters: deleted outright. They are invisible, so a title
// carrying one must behave as the identical-looking title without it.
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

// Every other space-like character, folded to a plain ASCII space: tab, the
// newline family, NO-BREAK SPACE (U+00A0), OGHAM SPACE MARK, the U+2000–200A
// run (which includes FIGURE SPACE U+2007), NARROW NO-BREAK SPACE (U+202F),
// MEDIUM MATHEMATICAL SPACE (U+205F) and IDEOGRAPHIC SPACE (U+3000).
const SPACE_LIKE_RE = /[\t\n\v\f\r\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Fold a title's exotic whitespace to plain ASCII spaces.
 *
 * WHY THIS EXISTS. iCal and Outlook feed exports routinely emit a NO-BREAK
 * SPACE around the dash in a title, so what the user reads as "ACME - Desk" is
 * really "ACME\u00A0-\u00A0Desk". Matched literally, that title never stems:
 * titleStem hands back the whole string, so the ticked title stops matching its
 * own siblings ("ACME - Night Tour") and the shift is offered as free while the
 * user is on a tour. The failure is asymmetric — it depends on which of the two
 * titles carried the odd character — and completely invisible.
 *
 * Applied to BOTH sides of every comparison: the stored ticked titles and the
 * incoming event titles. Normalizing only one side would just move the seam.
 *
 * DOES NOT TRIM. titleStem depends on a leading separator staying at index 0 so
 * that " - Desk" still reads as an empty stem rather than a real one.
 *
 * @param {unknown} s
 * @returns {string} "" for any non-string
 */
export function normalizeTitleWhitespace(s) {
  if (typeof s !== "string") return "";
  return s.replace(ZERO_WIDTH_RE, "").replace(SPACE_LIKE_RE, " ").replace(/ {2,}/g, " ");
}

/**
 * The leading segment of an event title, before the first separator.
 *
 * "First" means EARLIEST BY POSITION across all four separators, not the first
 * separator that happens to appear in STEM_SEPARATORS — "Standby: Ladder - 2"
 * must stem to "Standby", not to "Standby: Ladder".
 *
 * A title with no separator is its own stem, trimmed. That is what makes a
 * one-off title like "Tech rescue Training" tickable as itself.
 *
 *   "ACME - Desk"                -> "ACME"
 *   "ACME - Water Rescue Drill"  -> "ACME"
 *   "Medic 1 Shift"              -> "Medic 1 Shift"
 *
 * Whitespace is normalized FIRST, so a feed that writes the separator with a
 * NO-BREAK SPACE stems exactly like the same title written with plain spaces.
 * Without that, the separator search silently misses and the whole title comes
 * back as its own stem — see normalizeTitleWhitespace.
 *
 * @param {unknown} title
 * @returns {string} the stem, trimmed ("" for non-string/blank input)
 */
export function titleStem(title) {
  if (typeof title !== "string") return "";
  // Normalized but NOT trimmed: a title that OPENS with a separator (" - Desk")
  // has an empty leading segment, and trimming first would hide the separator
  // and hand back "- Desk" as if it were a real stem.
  const str = normalizeTitleWhitespace(title);
  let cut = -1;
  for (const sep of STEM_SEPARATORS) {
    const i = str.indexOf(sep);
    if (i > -1 && (cut === -1 || i < cut)) cut = i;
  }
  return (cut === -1 ? str : str.slice(0, cut)).trim();
}

// A "word" character for the stem-boundary test: any Unicode letter, digit,
// combining mark, or underscore. NOT /\w/ — see titlesToMatcher.
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_]/u;

/**
 * Build the predicate behind "these titles mean I am unavailable".
 *
 * The user ticks real titles off their own calendar; each is reduced to its
 * stem, and an event matches if its title STARTS WITH one of those stems,
 * case-insensitively, at a word boundary.
 *
 * ANCHORING IS THE WHOLE POINT. A substring rule would be a silent disaster: a
 * calendar can hold an all-day memorial like "Jordan Rivers - ACME Memorial
 * 1944", which CONTAINS "ACME" but is not a commitment. Under a substring rule
 * that event hard-rejects every shift touching that day and the user never
 * learns why. It must not match — it does not START with the stem.
 *
 * The word-boundary check stops "ACME" from swallowing "ACMEX"; a stem followed
 * by a separator, space, or end-of-string still matches, which is the case that
 * actually occurs ("ACME" ticked, "ACME - Night Tour" must match).
 *
 * Matching is done with string comparison, never a compiled RegExp: the stems
 * are raw user calendar data and may contain regex metacharacters ("C++ Class",
 * "Q3 (tentative)"), which would either throw or match the wrong thing.
 *
 * Two ways the input can be degenerate, both handled the same way — DISCARD:
 * non-string or blank entries, and entries whose stem is empty. An empty stem
 * would make startsWith("") true for every event, i.e. hard-reject everything.
 * An EMPTY ticked list therefore yields a matcher that matches NOTHING. Never
 * everything: this codebase has already shipped that bug once (see
 * resolveIncludeRegex) and it hid every shift the user could have taken.
 *
 * The boundary test is UNICODE-AWARE (\p{L}\p{N}\p{M}_), not /\w/. /\w/ is
 * ASCII-only, so for a Cyrillic, Greek or CJK title every following letter reads
 * as a non-word character and the boundary protection silently evaporates —
 * anchored matching quietly degrades into bare prefix matching, and a ticked
 * stem starts swallowing longer unrelated words in exactly the alphabets where
 * nobody is watching for it.
 *
 * @param {unknown} titles  array of ticked event titles (any shape — user data)
 * @returns {(eventTitle:string)=>boolean}
 */
export function titlesToMatcher(titles) {
  const stems = [];
  for (const t of Array.isArray(titles) ? titles : []) {
    const stem = titleStem(t);
    if (stem === "") continue; // blank / non-string / separator-led — discard
    const low = stem.toLowerCase();
    if (!stems.includes(low)) stems.push(low);
  }
  if (stems.length === 0) return () => false; // match NOTHING, never everything
  return function matches(eventTitle) {
    if (typeof eventTitle !== "string") return false;
    // Normalized on this side too: the stems above already went through
    // titleStem, so comparing a raw incoming title against them would make the
    // match depend on which of the two carried the odd whitespace.
    const low = normalizeTitleWhitespace(eventTitle).trim().toLowerCase();
    for (const stem of stems) {
      if (!low.startsWith(stem)) continue;
      const next = low.charAt(stem.length);
      // End of string, or a non-word char — "ACME" must not match "ACMEX".
      if (next === "" || !WORD_CHAR_RE.test(next)) return true;
    }
    return false;
  };
}

/**
 * The role a calendar takes when the user has never picked one for it.
 *
 * EVERY calendar defaults to OFF — the primary included. There is no cascade
 * and no exception:
 *
 *   - A default may never produce a hard REJECT. A wrong reject silently hides
 *     a shift the user was actually free to take, and we would be guessing.
 *   - A default may never produce a FLAG either, not even on the primary. The
 *     primary calendar is the MOST sensitive one the account holds — a family
 *     member's surgery, a therapy appointment, a lawyer's name in an event
 *     title. Reading it because we assumed consent is not ours to assume, and
 *     annotating with it means those titles get rendered onto a work page.
 *   - OFF means the refresh loop never issues an events request for it at all,
 *     so its contents never leave Google.
 *
 * Accepted cost: a freshly-installed user gets no scoring value until they open
 * the picker and turn a calendar on. That is the correct trade — the extension
 * has nothing to say about a user's availability until the user tells it which
 * calendars represent real commitments.
 *
 * @param {{id:string, summary?:string, primary?:boolean}} _item
 * @returns {string} always "OFF"
 */
export function defaultRole(_item) {
  return "OFF";
}

/**
 * Attach the effective role and label prefix to each calendarList item. The
 * stored map is sparse and may have been hand-edited, so an entry that isn't a
 * known role falls back to defaultRole.
 *
 * DISPLAY NAME: `summaryOverride` is the name the USER gave the calendar in
 * Google Calendar; `summary` is the name its owner gave it. When both exist the
 * override wins everywhere — display, label prefix, and sort key — or the user
 * would be shown a calendar they renamed under a name they do not recognise.
 *
 * ACCESS ROLE is carried through untouched. A "freeBusyReader" calendar returns
 * events with NO summary at all, so a title picker over it can only ever render
 * blank rows; the UI needs this field to say so instead of looking broken.
 *
 * Primary gets an empty prefix because Google returns the account email as its
 * summary — unusable as a label, and an address we should not be rendering.
 *
 * DELETED calendars are dropped: they are not things the user still has.
 *
 * HIDDEN calendars are NOT. "Hide from list" in Google Calendar is a display
 * preference — the user is still subscribed, and the calendar still holds the
 * tours that must knock a shift out. Dropping it here (combined with Google
 * omitting it entirely unless the request passes showHidden=true) meant a stored
 * REJECT role stopped being consulted the moment the user tidied their sidebar:
 * the calendar silently stopped blocking AND disappeared from the options page,
 * so the failure was both invisible and un-fixable.
 *
 * A hidden calendar is therefore kept whenever the user has given it a real
 * blocking-capable role (FLAG/REJECT/RULE), and flagged `hiddenInGoogle` so the
 * options page can label it rather than looking like it invented a calendar the
 * user cannot find. A hidden calendar with no stored role — or an explicit OFF —
 * is still dropped: it is nothing the user has spoken about, it is not blocking
 * anything, and accounts accumulate dozens of them.
 *
 * @param {object[]} items  calendarList items
 * @param {object} storedRoles  the calRoles map (may be undefined/sparse)
 * @returns {Array<{id:string, summary:string, primary:boolean, role:string,
 *                  prefix:string, accessRole:string, selected:boolean,
 *                  hiddenInGoogle:boolean}>}
 *          primary first, then case-insensitive alpha by display name
 */
export function resolveRoles(items, storedRoles) {
  const roles = storedRoles || {};
  const out = (items || [])
    .filter((it) => {
      if (!it || it.deleted === true) return false;
      if (it.hidden !== true) return true;
      const stored = roles[it.id];
      return ROLES.includes(stored) && stored !== "OFF";
    })
    .map((it) => {
      const override = typeof it.summaryOverride === "string" ? it.summaryOverride.trim() : "";
      const summary = override || it.summary || "";
      const primary = it.primary === true;
      const stored = roles[it.id];
      return {
        id: it.id,
        summary,
        primary,
        role: ROLES.includes(stored) ? stored : defaultRole(it),
        prefix: primary ? "" : summary,
        accessRole: typeof it.accessRole === "string" ? it.accessRole : "",
        selected: it.selected === true,
        hiddenInGoogle: it.hidden === true,
      };
    });
  out.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    const as = a.summary.toLowerCase();
    const bs = b.summary.toLowerCase();
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
  return out;
}

/**
 * Split one calendar's events into hard commitments vs soft flags according to
 * its role. Cancelled and un-triplet-able events are dropped in every role.
 * Each output row is a [start, end, label] triplet.
 *
 * The rule predicate runs on the RAW event title, NEVER on the prefixed label.
 * An anchored user regex like "^Work\b" could never match "Shared Cal · Work
 * day", so running it on the label would silently stop every non-primary RULE
 * calendar from producing hard rejects — a shift would be offered as free while
 * the user is in fact committed.
 *
 * @param {object[]} events
 * @param {string} role  one of ROLES
 * @param {(title:string)=>boolean} rule  called with the raw title only
 * @param {string} prefix  "" for primary, the calendar summary otherwise
 * @returns {{commitments: string[][], soft: string[][]}}
 */
export function bucketEvents(events, role, rule, prefix) {
  const commitments = [];
  const soft = [];
  if (role === "OFF") return { commitments, soft };
  for (const ev of events || []) {
    if (ev.status === "cancelled") continue;
    const trip = buildTriplet(ev);
    if (!trip) continue;
    const title = ev.summary || "";
    const row = [trip[0], trip[1], prefix ? prefix + LABEL_SEP + title : title];
    const hard = role === "REJECT" || (role === "RULE" && rule(title));
    if (hard) commitments.push(row);
    else soft.push(row);
  }
  return { commitments, soft };
}

/**
 * Roll a calendar's events up into the DISTINCT titles the picker offers.
 *
 * Titles are grouped verbatim (trimmed) rather than by stem: the user is
 * picking their own real event titles, and collapsing "ACME - Desk" into "ACME"
 * before they have chosen would hide from them what they are actually ticking.
 * Stemming happens later, in titlesToMatcher, on what they picked.
 *
 * typicalMinutes is the MEDIAN duration of that title's occurrences (even
 * counts take the lower of the two middle values). Median, not mean, because a
 * single mis-entered all-day copy of a 12-hour tour would drag a mean far
 * enough to misdescribe the title in the picker.
 *
 * Cancelled, untriplet-able, and blank-titled events are dropped — a blank row
 * is not something a user can meaningfully tick.
 *
 * Sorted most-frequent first, ties broken case-insensitively by title so the
 * order is stable between calls.
 *
 * @param {object[]} events
 * @returns {Array<{title:string, count:number, typicalMinutes:number}>}
 */
export function summarizeTitles(events) {
  const byTitle = new Map();
  for (const ev of events || []) {
    if (!ev || ev.status === "cancelled") continue;
    const title = typeof ev.summary === "string" ? ev.summary.trim() : "";
    if (title === "") continue;
    const trip = buildTriplet(ev);
    if (!trip) continue;
    let mins = 0;
    try {
      mins = Math.round((toEpoch(parseCivil(trip[1])) - toEpoch(parseCivil(trip[0]))) / 60);
    } catch (_e) {
      mins = 0; // unparseable bound — count the event, claim no duration for it
    }
    if (!Number.isFinite(mins) || mins < 0) mins = 0;
    const bucket = byTitle.get(title) || [];
    bucket.push(mins);
    byTitle.set(title, bucket);
  }
  const out = [];
  for (const [title, durations] of byTitle) {
    durations.sort((a, b) => a - b);
    const mid = Math.floor((durations.length - 1) / 2); // lower median on ties
    out.push({ title, count: durations.length, typicalMinutes: durations[mid] });
  }
  out.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const at = a.title.toLowerCase();
    const bt = b.title.toLowerCase();
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
  return out;
}

/**
 * The commitment predicate for ONE calendar.
 *
 * A RULE calendar's blocking set is its ticked titles, FULL STOP. Nothing ticked
 * means nothing blocks — the matcher matches nothing, and every event on that
 * calendar becomes a soft note.
 *
 * EMPTINESS IS NOT A REQUEST FOR THE REGEX. Routing an empty ticked list to the
 * legacy pattern is the defect this signature exists to kill: resolveIncludeRegex
 * turns an absent pattern into the anchored default "^Work\b", so a RULE calendar
 * the user had ticked nothing on silently hard-rejected every event titled
 * "Work…". That contradicted the options page in three places (it renders
 * "Nothing ticked yet — this calendar blocks nothing"), and it made "I want
 * nothing to block" unrepresentable: un-ticking everything stores [], which
 * re-armed the regex.
 *
 * The pattern hatch therefore requires an EXPLICIT stored opt-in
 * (`ruleUsePattern`, resolved by resolvePatternOptIn) — never an inference from
 * an empty list. Ticked titles still win over the pattern when both are present:
 * the picker is what a configured user actually sees and edits.
 *
 * @param {unknown} tickedTitles  calBlockTitles[calId]
 * @param {(title:string)=>boolean} regexRule  the legacy global rule predicate
 * @param {boolean} usePattern  the user's explicit pattern-hatch opt-in
 * @returns {{rule:(title:string)=>boolean, mode:"titles"|"regex"|"none"}}
 */
export function calendarRule(tickedTitles, regexRule, usePattern) {
  const list = Array.isArray(tickedTitles) ? tickedTitles : [];
  const usable = list.filter((t) => titleStem(t) !== "");
  if (usable.length > 0) return { rule: titlesToMatcher(usable), mode: "titles" };
  if (usePattern === true && typeof regexRule === "function") {
    return { rule: regexRule, mode: "regex" };
  }
  return { rule: () => false, mode: "none" };
}

/**
 * Has the user explicitly opted into the advanced pattern hatch?
 *
 * Two things count, and emptiness is not one of them:
 *
 *   - `ruleUsePattern === true`: written by handleSetRuleFilter, i.e. the user
 *     opened the advanced disclosure and saved a valid pattern. This is the
 *     signal going forward.
 *   - a stored non-blank `ruleInclude`: the same affirmative act, performed
 *     before the flag existed. A pattern can only ever reach storage through
 *     handleSetRuleFilter, which refuses blank and invalid input, so its presence
 *     IS a past opt-in. Honouring it is what stops an upgrade from silently
 *     disarming a working configuration — the same failure mode as a hidden
 *     calendar losing its REJECT role.
 *
 * MUST be given the RAW stored object. Reading storage with a defaults object
 * (chrome.storage.local.get(DEFAULTS)) backfills ruleInclude with the default
 * pattern for users who never saved one, which would read as an opt-in for
 * everybody.
 *
 * @param {unknown} store  raw chrome.storage.local contents
 * @returns {boolean}
 */
export function resolvePatternOptIn(store) {
  const s = store && typeof store === "object" ? store : {};
  if (s[PATTERN_OPT_IN_KEY] === true) return true;
  return typeof s.ruleInclude === "string" && s.ruleInclude.trim() !== "";
}

// ---------------------------------------------------------------------------
// Config (reads the user-editable RULE regex from chrome.storage.local)
// ---------------------------------------------------------------------------

/**
 * Resolve the stored RULE include pattern into a usable regex, refusing the two
 * ways a stored value can be unusable. Pure and exported so the guards below are
 * testable offline — they are the difference between "this shift is blocked" and
 * "this shift is hidden for no reason".
 *
 *   - EMPTY / whitespace-only → not configured. new RegExp("", "i") matches
 *     EVERY string, so honouring it would turn a RULE calendar into a blanket
 *     hard-reject of all its events — the user would silently never see a shift
 *     they were free to take. Treated exactly like an invalid regex: fall back
 *     to the anchored default and warn.
 *   - SYNTACTICALLY INVALID → fall back to the default and warn.
 *
 * @param {unknown} src  the raw stored pattern (any type — storage is user data)
 * @returns {{includeRe: RegExp, warnings: string[]}}
 */
export function resolveIncludeRegex(src) {
  const warnings = [];
  const raw = typeof src === "string" ? src : "";

  if (raw.trim() === "") {
    // Not configured (or configured to the match-everything pattern). Never
    // compile this — see the guard note above. A non-string stored value lands
    // here too: it is equally "not configured", and equally worth surfacing.
    warnings.push("empty_rule_regex");
    return { includeRe: new RegExp(DEFAULTS.ruleInclude, "i"), warnings };
  }

  try {
    return { includeRe: new RegExp(raw, "i"), warnings };
  } catch (_err) {
    warnings.push("bad_rule_regex"); // invalid user regex → fall back to default
    return { includeRe: new RegExp(DEFAULTS.ruleInclude, "i"), warnings };
  }
}

/**
 * Split the stored comma-separated exclude field into lowercased substrings.
 * @param {unknown} src
 * @returns {string[]}
 */
export function parseExcludes(src) {
  const raw = typeof src === "string" ? src : DEFAULTS.ruleExclude;
  return raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 0);
}

// Read RAW — never with a defaults object. get(DEFAULTS) backfills ruleInclude
// with the default pattern for a user who never saved one, and resolvePatternOptIn
// would then read that as an opt-in for every user on earth.
async function loadConfig() {
  const cfg = await chrome.storage.local.get(["ruleInclude", "ruleExclude", PATTERN_OPT_IN_KEY]);
  const usePattern = resolvePatternOptIn(cfg);
  const { includeRe, warnings } = resolveIncludeRegex(cfg.ruleInclude);
  return {
    includeRe,
    excludes: parseExcludes(cfg.ruleExclude),
    usePattern,
    // A broken/absent pattern only matters to someone actually using the hatch.
    // Warning everyone else about a regex that is never consulted is noise, and
    // noise is how a real warning gets ignored.
    warnings: usePattern ? warnings : [],
  };
}

// ---------------------------------------------------------------------------
// OAuth (chrome.identity.getAuthToken)
// ---------------------------------------------------------------------------
//
// Primary flow: chrome.identity.getAuthToken. The manifest oauth2 block carries
// the client_id (currently the placeholder "REPLACE_ME..." — a config error the
// drawer surfaces as "oauth_config: <msg>") and the calendar.readonly scope.
//
// ALTERNATIVE FLOW (not implemented): for a Chrome profile that is not signed
// into the Google account holding the user's calendars (see README.md's OAuth
// runbook), the getAuthToken path is replaced by chrome.identity.launchWebAuthFlow
// with a "Web application" OAuth client and redirect URI
// https://<extension-id>.chromiumapp.org/, its client_id configured HERE in
// sw.js. It would slot in as an alternate implementation of getToken() below.

function getToken(interactive) {
  return new Promise((resolve) => {
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr || !token) {
          resolve({ token: null, error: lastErr ? lastErr.message : "no_token" });
        } else {
          resolve({ token, error: null });
        }
      });
    } catch (e) {
      resolve({ token: null, error: e && e.message ? e.message : String(e) });
    }
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    try {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    } catch (_e) {
      resolve();
    }
  });
}

// Chrome's lastError string is the only signal available, so distinguishing a
// misconfigured OAuth client from a merely-not-yet-consented user is a
// heuristic, not a contract: if the message names the client / credentials, we
// treat it as a config error; otherwise interactive consent is what's needed.
const CONFIG_HINTS = [
  "client",
  "invalid_client",
  "bad client id",
  "oauth2 not supported",
  "custom uri scheme",
  "unsupported",
];
function classifyAuthError(msg) {
  const m = (msg || "").toLowerCase();
  if (CONFIG_HINTS.some((h) => m.includes(h))) {
    return { error: "oauth_config: " + msg };
  }
  return { error: "auth_required" };
}

// ---------------------------------------------------------------------------
// Google Calendar REST (GET-only; 401 → refresh token once, then auth_expired)
// ---------------------------------------------------------------------------

/**
 * Fetch a Calendar API URL with the holder's bearer token. On 401, remove the
 * cached token and retry ONCE with a fresh non-interactive token (shared across
 * the whole refresh operation via holder.refreshed). A fresh token that still
 * 401s means the grant is genuinely expired → throws code "auth_expired".
 */
async function authedFetch(url, holder) {
  let resp = await fetch(url, { headers: { Authorization: "Bearer " + holder.token } });

  if (resp.status === 401) {
    if (holder.refreshed) {
      throw taggedError("auth_expired", "auth_expired");
    }
    holder.refreshed = true;
    await removeCachedToken(holder.token);
    const fresh = await getToken(false);
    if (!fresh.token) {
      throw taggedError("auth_expired", "auth_expired");
    }
    holder.token = fresh.token;
    resp = await fetch(url, { headers: { Authorization: "Bearer " + holder.token } });
    if (resp.status === 401) {
      throw taggedError("auth_expired", "auth_expired");
    }
  }

  if (!resp.ok) {
    const err = taggedError("http_error", "http_" + resp.status);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function taggedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function listCalendars(holder) {
  const items = [];
  let pageToken = "";
  // accessRole: freeBusyReader calendars return titleless events — the picker
  //   must be told, not left rendering blank rows.
  // summaryOverride: the user's own rename of the calendar; preferred over
  //   summary so they recognise it.
  // selected: mirrors the checkbox in Google Calendar — an ordering signal.
  // deleted/hidden: deleted calendars are dropped; hidden ones are KEPT when the
  //   user has given them a blocking role (see resolveRoles).
  const fields =
    "items(id,summary,summaryOverride,primary,accessRole,selected,deleted,hidden),nextPageToken";
  do {
    // showHidden=true is REQUIRED, not an optimization. Without it Google omits
    // every calendar the user has "Hide from list"-ed — which is a display
    // preference, not an unsubscribe. A fire-department calendar set to REJECT
    // and then hidden would vanish from this response, its stored role would
    // never be consulted, and it would stop blocking without a word. It also
    // disappeared from the options list, so the user could neither see the
    // problem nor undo it. showDeleted stays OFF: a deleted calendar really is
    // gone, and resolveRoles drops any that slip through anyway.
    let url =
      `${CAL_BASE}/users/me/calendarList?maxResults=250&showHidden=true` +
      `&fields=${encodeURIComponent(fields)}`;
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
    const data = await authedFetch(url, holder);
    if (Array.isArray(data.items)) items.push(...data.items);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return items;
}

async function listEvents(holder, calId, timeMin, timeMax) {
  const events = [];
  let pageToken = "";
  const base = `${CAL_BASE}/calendars/${encodeURIComponent(calId)}/events`;
  const fields = "items(summary,start,end,status),nextPageToken";
  do {
    let url =
      `${base}?singleEvents=true&maxResults=2500` +
      `&timeMin=${encodeURIComponent(timeMin)}` +
      `&timeMax=${encodeURIComponent(timeMax)}` +
      `&fields=${encodeURIComponent(fields)}`;
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
    const data = await authedFetch(url, holder);
    if (Array.isArray(data.items)) events.push(...data.items);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return events;
}

/**
 * NY-midnight of dateStr (+ optional whole days) as an RFC3339 UTC instant.
 * Uses nytime toEpoch on the civil {y,mo,d,00:00} so the bound is NY-correct
 * across DST without hand-rolled offsets.
 */
export function nyMidnightRfc3339(dateStr, plusDays) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  let civil = { y, mo, d, h: 0, mi: 0 };
  if (plusDays) civil = addDays(civil, plusDays);
  const epochSec = toEpoch(civil);
  return new Date(epochSec * 1000).toISOString();
}

// How far either side of today the title picker samples when the caller has no
// window of its own. Wide enough that a monthly or quarterly commitment shows
// up at all — a title the user never sees is a title they cannot tick.
const TITLE_SAMPLE_BACK_DAYS = 30;
const TITLE_SAMPLE_FWD_DAYS = 60;

/**
 * The NY date range a title sample covers. Honours an explicit window when the
 * caller has one; otherwise spans TITLE_SAMPLE_BACK/FWD days around today.
 *
 * Sampling only ever decides WHICH TITLES ARE OFFERED, never whether a shift is
 * blocked, so a default that is wider than the scored window is harmless.
 *
 * @param {unknown} start  "YYYY-MM-DD" or absent
 * @param {unknown} end    "YYYY-MM-DD" or absent
 * @param {number} [nowMs] injectable clock for tests
 * @returns {{start:string, end:string}}
 */
export function titleSampleWindow(start, end, nowMs) {
  const ok = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (ok(start) && ok(end) && start <= end) return { start, end };
  const today = civilFromEpoch((nowMs === undefined ? Date.now() : nowMs) / 1000);
  const base = { y: today.y, mo: today.mo, d: today.d, h: 0, mi: 0 };
  const iso = (c) => `${c.y}-${pad2(c.mo)}-${pad2(c.d)}`;
  return {
    start: iso(addDays(base, -TITLE_SAMPLE_BACK_DAYS)),
    end: iso(addDays(base, TITLE_SAMPLE_FWD_DAYS)),
  };
}

// ---------------------------------------------------------------------------
// Refresh: token → calendarList → per-calendar events → triplet lists → cache
// ---------------------------------------------------------------------------

async function refreshCalendarData(windowStart, windowEnd, interactive) {
  const tok = await getToken(interactive);
  if (!tok.token) {
    return { ok: false, ...classifyAuthError(tok.error) };
  }
  const holder = { token: tok.token, refreshed: false };

  const cfg = await loadConfig();
  const warnings = [...cfg.warnings];

  let calItems;
  try {
    calItems = await listCalendars(holder);
  } catch (e) {
    return errorResponse(e);
  }

  const store = await chrome.storage.local.get([ROLES_KEY, BLOCK_TITLES_KEY]);
  const cals = resolveRoles(calItems, store[ROLES_KEY]);
  const blockTitles = store[BLOCK_TITLES_KEY] || {};

  const timeMin = nyMidnightRfc3339(windowStart, 0);
  const timeMax = nyMidnightRfc3339(windowEnd, 1); // +1 day: exclusive upper bound

  const commitments = [];
  const soft = [];
  const regexRule = (title) => ruleMatches(title, cfg.includeRe, cfg.excludes);

  try {
    for (const cal of cals) {
      if (cal.role === "OFF") continue; // never fetched — no request is made at all
      const evs = await listEvents(holder, cal.id, timeMin, timeMax);
      // Ticked titles are per-calendar and are the whole blocking set. The
      // legacy regex is consulted ONLY for a user who explicitly armed it.
      const { rule, mode } = calendarRule(blockTitles[cal.id], regexRule, cfg.usePattern);
      const b = bucketEvents(evs, cal.role, rule, cal.prefix);
      commitments.push(...b.commitments);
      soft.push(...b.soft);
      dlog("calendar events", cal.role, mode, evs.length);
    }
  } catch (e) {
    return errorResponse(e);
  }

  // Sort each list by triplet start string (lexicographic == chronological here).
  const byStart = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  commitments.sort(byStart);
  soft.sort(byStart);

  const fetchedAt = Date.now();
  await chrome.storage.local.set({
    [CACHE_KEY]: { fetchedAt, commitments, soft, windowStart, windowEnd },
  });

  dlog("refresh done", { commitments: commitments.length, soft: soft.length, warnings });
  return { ok: true, fromCache: false, fetchedAt, commitments, soft, warnings };
}

function errorResponse(e) {
  if (e && e.code === "auth_expired") return { ok: false, error: "auth_expired" };
  if (e && e.code === "http_error") return { ok: false, error: e.message };
  return { ok: false, error: "fetch_failed: " + (e && e.message ? e.message : String(e)) };
}

// A cache is only usable if its stored window COVERS the requested window;
// lexicographic compare is valid for "YYYY-MM-DD".
function windowCovers(cache, windowStart, windowEnd) {
  return (
    typeof cache.windowStart === "string" &&
    typeof cache.windowEnd === "string" &&
    cache.windowStart <= windowStart &&
    cache.windowEnd >= windowEnd
  );
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleGetCalendarData(msg) {
  const { mode, windowStart, windowEnd } = msg;

  if (mode === "cache") {
    const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (stored && windowCovers(stored, windowStart, windowEnd)) {
      return {
        ok: true,
        fromCache: true,
        fetchedAt: stored.fetchedAt,
        commitments: stored.commitments,
        soft: stored.soft,
      };
    }
    return { ok: false, error: "no_cache" };
  }

  if (mode === "refresh") {
    return refreshCalendarData(windowStart, windowEnd, false);
  }
  if (mode === "interactive") {
    return refreshCalendarData(windowStart, windowEnd, true);
  }
  return { ok: false, error: "bad_mode" };
}

// The panel shows the RAW stored regex strings, not loadConfig's compiled form:
// when a stored regex is invalid, loadConfig silently falls back to the default
// but the user still needs to see the broken value in order to fix it.
async function handleListCalendars(msg) {
  const tok = await getToken(msg.interactive);
  if (!tok.token) {
    return { ok: false, ...classifyAuthError(tok.error) };
  }
  const holder = { token: tok.token, refreshed: false };

  let calItems;
  try {
    calItems = await listCalendars(holder);
  } catch (e) {
    return errorResponse(e);
  }

  const store = await chrome.storage.local.get([
    ROLES_KEY,
    BLOCK_TITLES_KEY,
    PATTERN_OPT_IN_KEY,
    "ruleInclude",
    "ruleExclude",
  ]);
  const blockTitles = store[BLOCK_TITLES_KEY] || {};
  const calendars = resolveRoles(calItems, store[ROLES_KEY]).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary,
    role: c.role,
    // accessRole lets the panel warn instead of rendering a titleless picker;
    // blockTitles lets it show what is already ticked without a second round trip.
    accessRole: c.accessRole,
    selected: c.selected,
    // Hidden in Google Calendar but still configured here — the panel must say
    // so, or it looks like it conjured up a calendar the user cannot find.
    hiddenInGoogle: c.hiddenInGoogle,
    blockTitles: Array.isArray(blockTitles[c.id]) ? blockTitles[c.id] : [],
  }));

  return {
    ok: true,
    calendars,
    ruleFilter: {
      include: typeof store.ruleInclude === "string" ? store.ruleInclude : DEFAULTS.ruleInclude,
      exclude: typeof store.ruleExclude === "string" ? store.ruleExclude : DEFAULTS.ruleExclude,
      // Whether the pattern is actually ARMED — without it the panel cannot tell
      // an inert legacy pattern from one that is deciding hard rejects.
      usePattern: resolvePatternOptIn(store),
    },
  };
}

// Both mutators REMOVE the cache rather than leaving it for the next refresh to
// overwrite: if that refresh fails, a stale cache bucketed under the old roles
// would be served as authoritative on the next boot, silently applying rejects
// the user just turned off. Removal surfaces the failure as no_cache instead.
async function handleSetCalendarRole(msg) {
  if (!msg.calendarId || !ROLES.includes(msg.role)) {
    return { ok: false, error: "bad_role" };
  }
  const roles = (await chrome.storage.local.get(ROLES_KEY))[ROLES_KEY] || {};
  roles[msg.calendarId] = msg.role;
  await chrome.storage.local.set({ [ROLES_KEY]: roles });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

async function handleSetRuleFilter(msg) {
  const include = typeof msg.include === "string" ? msg.include : "";
  const exclude = typeof msg.exclude === "string" ? msg.exclude : "";
  // An empty include is rejected, not stored: new RegExp("") matches every
  // string, so persisting it would arm a blanket hard-reject on the RULE
  // calendar. Callers must send a real pattern (or leave the stored one alone).
  if (include.trim() === "") {
    return { ok: false, error: "empty_include" }; // reject without persisting
  }
  try {
    new RegExp(include, "i");
  } catch (_err) {
    return { ok: false, error: "bad_regex" }; // reject without persisting
  }
  // Saving a pattern IS the opt-in, and it is written in the same set() as the
  // pattern itself: the flag is what arms the hatch, and a pattern stored
  // without it would be inert config the user believes is blocking shifts.
  await chrome.storage.local.set({
    ruleInclude: include,
    ruleExclude: exclude,
    [PATTERN_OPT_IN_KEY]: true,
  });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

/**
 * List ONE calendar's distinct event titles, so the user can tick the ones that
 * mean "I am unavailable" instead of writing a regex.
 *
 * -> { type:"listCalendarTitles", calendarId[, windowStart, windowEnd] }
 * <- { ok:true, titles:[{title,count,typicalMinutes}], accessRole, blockTitles }
 * <- { ok:false, error }   error:"calendar_off" when the calendar is not
 *                          switched on — this handler reads events, so it is
 *                          gated on the same stored role everything else is.
 *
 * windowStart/windowEnd are the same NY date strings getCalendarData takes. A
 * caller that has a scored window (the drawer) should pass it so the picker
 * samples exactly what will be scored; the options page has no window of its
 * own, so omitting them falls back to a sampling window around today. The
 * fallback is only ever used to POPULATE A LIST OF TITLES — it never decides
 * whether a shift is blocked, so a wider-than-scored sample costs nothing but
 * an extra row in the picker.
 *
 * blockTitles echoes back what is currently ticked for this calendar, so the
 * picker can render its checkboxes without a second round trip.
 *
 * A freeBusyReader calendar returns events with no summary at all, so there is
 * nothing to pick. We return an EMPTY list plus the accessRole and let the UI
 * explain that, rather than rendering rows of blanks that look like a bug.
 */
async function handleListCalendarTitles(msg) {
  const calendarId = msg && msg.calendarId;
  if (!calendarId) return { ok: false, error: "bad_calendar_id" };
  const win = titleSampleWindow(msg.windowStart, msg.windowEnd);

  const tok = await getToken(false);
  if (!tok.token) return { ok: false, ...classifyAuthError(tok.error) };
  const holder = { token: tok.token, refreshed: false };

  let calItems;
  try {
    calItems = await listCalendars(holder);
  } catch (e) {
    return errorResponse(e);
  }
  const stored = await chrome.storage.local.get([ROLES_KEY, BLOCK_TITLES_KEY]);
  const cal = resolveRoles(calItems, stored[ROLES_KEY]).find((c) => c.id === calendarId);
  if (!cal) return { ok: false, error: "unknown_calendar" };

  // THE ROLE GATE. PRIVACY.md promises the extension reads only "the calendars
  // you've configured it to read", and this worker has to enforce that itself
  // rather than trusting whoever sent the message: it previously resolved roles
  // against an EMPTY map and then fetched whatever calendarId it was handed, so
  // one stray message would have read an OFF calendar's event titles.
  //
  // No deadlock for the legitimate caller: the options page awaits
  // setCalendarRole (which persists FLAG) BEFORE it asks for titles, so by the
  // time this runs the calendar the user just switched on is already non-OFF.
  if (cal.role === "OFF") return { ok: false, error: "calendar_off" };

  const blockTitles = Array.isArray((stored[BLOCK_TITLES_KEY] || {})[calendarId])
    ? stored[BLOCK_TITLES_KEY][calendarId]
    : [];

  // A freeBusyReader grant returns events with no summary at all. Return the
  // empty list and the accessRole so the UI can say why, instead of drawing
  // rows of blanks that read as a broken picker.
  if (cal.accessRole === "freeBusyReader") {
    return { ok: true, titles: [], accessRole: cal.accessRole, blockTitles };
  }

  try {
    const evs = await listEvents(
      holder,
      calendarId,
      nyMidnightRfc3339(win.start, 0),
      nyMidnightRfc3339(win.end, 1) // +1 day: exclusive upper bound
    );
    const titles = summarizeTitles(evs);
    dlog("listCalendarTitles", evs.length, titles.length);
    return { ok: true, titles, accessRole: cal.accessRole, blockTitles };
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Persist the ticked titles for one calendar under `calBlockTitles`.
 *
 * An empty array is a legitimate value — it is how the user says "nothing on
 * this calendar blocks a shift" — so it is stored, not rejected. calendarRule()
 * reads it as "match nothing": never as "block everything", and no longer as
 * "fall back to the legacy regex" either.
 *
 * Drops the cache for the same reason the other mutators do: a cache bucketed
 * under the old titles would keep applying blocks the user just removed.
 */
async function handleSetBlockTitles(msg) {
  const calendarId = msg && msg.calendarId;
  if (!calendarId) return { ok: false, error: "bad_calendar_id" };
  if (!Array.isArray(msg.titles)) return { ok: false, error: "bad_titles" };

  const titles = [];
  for (const t of msg.titles) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed !== "" && !titles.includes(trimmed)) titles.push(trimmed);
  }

  const map = (await chrome.storage.local.get(BLOCK_TITLES_KEY))[BLOCK_TITLES_KEY] || {};
  map[calendarId] = titles;
  await chrome.storage.local.set({ [BLOCK_TITLES_KEY]: map });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

/**
 * Open the extension's own options page.
 *
 * This lives in the service worker because chrome.runtime.openOptionsPage() is
 * ONLY callable from an extension context (worker/popup/options), never from a
 * content script — the drawer's gear sends { type:"openOptions" } and the
 * worker does the opening on its behalf.
 */
async function handleOpenOptions() {
  try {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

const HANDLERS = {
  getCalendarData: handleGetCalendarData,
  listCalendars: handleListCalendars,
  listCalendarTitles: handleListCalendarTitles,
  setCalendarRole: handleSetCalendarRole,
  setBlockTitles: handleSetBlockTitles,
  setRuleFilter: handleSetRuleFilter,
  openOptions: handleOpenOptions,
};

function onMessage(msg, _sender, sendResponse) {
  const h = msg && HANDLERS[msg.type];
  if (!h) {
    return false; // not ours — let other listeners handle it
  }
  h(msg)
    .then(sendResponse)
    .catch((e) =>
      sendResponse({ ok: false, error: "internal: " + (e && e.message ? e.message : String(e)) })
    );
  return true; // keep the message channel open for the async response
}

// The ONLY top-level chrome.* touch — typeof-guarded so a bare `import` of this
// module in Node (offline helper tests) doesn't throw on an undefined chrome.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(onMessage);
}
