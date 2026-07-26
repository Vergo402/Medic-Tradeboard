/**
 * MV3 service worker (ESM module — manifest declares "type": "module").
 *
 * Purpose: on request from the content script, produce two triplet lists for
 * the scoring engine in NY-local "YYYY-MM-DD HH:MM" string form:
 *   - commitments: hard conflicts — every event of a REJECT feed, plus the
 *     events of a RULE feed whose title matches the user's block list.
 *   - soft: annotations — every event of a FLAG feed, plus the events of a
 *     RULE feed whose title does NOT match.
 *
 * A RULE feed's block list is the set of real event titles the user ticked
 * in the picker (`calBlockTitles`), matched by stem, anchored at the start of
 * the title. THAT IS THE WHOLE BLOCKING SET: a RULE calendar with nothing
 * ticked blocks NOTHING. The older ruleInclude/ruleExclude regex applies only
 * to a user who explicitly opted into the advanced pattern hatch (the stored
 * `ruleUsePattern` flag) — never as a fallback inferred from an empty tick list.
 *
 * THE SOURCE IS SUBSCRIBED iCal FEEDS — there is no sign-in anywhere in this
 * extension. A feed is either an .ics URL the user pasted (a read-only secret
 * capability link: a provider's secret/subscription URL) or an .ics file they
 * uploaded. core/ics.js parses either into the same event shape, so everything
 * below buildTriplet is unchanged.
 *
 * Feed identity is per-user config, never code. Every feed carries one of four
 * roles — OFF | FLAG | REJECT | RULE — chosen by the user and stored sparsely
 * under `calRoles`, keyed by the feed's id. An id with no stored entry falls
 * back to defaultRole(), which is deliberately conservative: it never invents a
 * hard reject for a feed the user has not spoken about.
 *
 * Notes are labelled "<feed name> · <title>", so a note always says which feed
 * it came from.
 *
 * PRIVACY/SAFETY:
 *   - Read-only in every direction. The worker only ever GETs a feed URL, with
 *     credentials omitted; it never writes to any calendar and never posts.
 *   - A feed URL is a CREDENTIAL. It lives in chrome.storage.local, is never
 *     synced, and never reaches the options page — only redactFeedUrl's host
 *     form does, so the token cannot leak into a screenshot or a support paste.
 *   - Never logs event titles or attendee data on production paths. A single
 *     DEBUG flag (default false) gates the only verbose logging, and even then
 *     we log counts/warnings/mode — never event summaries.
 *   - OFF feeds are never fetched: the refresh loop skips them before any
 *     request, so their contents never reach this extension. EVERY feed starts
 *     OFF; nothing is read until the user explicitly turns it on.
 *   - A blocking-capable feed that fails to load FAILS the whole refresh rather
 *     than scoring without it — see refreshCalendarData's failure policy.
 *
 * ALL chrome.* references live inside function/listener bodies (the sole
 * top-level touch is the typeof-guarded addListener at the bottom) so a bare
 * `import` of this module in Node — for offline unit tests of the pure helpers
 * — succeeds without a chrome global.
 */

import { toEpoch, civilFromEpoch, addDays, parseCivil } from "./core/nytime.js";
import { parseIcs } from "./core/ics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Every calendar feed the user has subscribed this extension to. A feed is
// either an .ics URL (fetched live; webcal:// normalized to https://) or an
// uploaded .ics file whose text is stored in `content`. There is no auth of any
// kind: a URL feed is a read-only secret capability link, a file feed is a
// static snapshot the user re-uploads to refresh.
//
//   feeds = [{ id, kind:"url"|"file", url?, content?, name, addedAt,
//              calName?, tz?, syncedAt? }]
//
// A feed's ROLE and every per-feed picker map key on the feed's `id`, keyed the
// same way they used to be: the config layer below is RE-KEYED, not rebuilt, so
// calRoles / calBlockTitles / calNoteTitles / calTitleLabels / calBufferBefore /
// calBufferAfter / calEventBuffers all keep working unchanged (and core/blocks.js's
// anyoneBlocks keeps reading calRoles as it always has).
const FEEDS_KEY = "feeds";

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

// Per-calendar NOTE set: { [calendarId]: string[] }. Titles the user marked
// "Note" in the three-way picker, matched by EXACT (whitespace-normalized)
// title, never by stem. A note is cosmetic — it annotates a shift, it never
// blocks it — so exact match is correct: marking "Music Class" notes all its
// occurrences, but a new, different title is NOT auto-noted (it defaults to
// Ignore). Additive to BLOCK_TITLES_KEY, which is unchanged.
const NOTE_TITLES_KEY = "calNoteTitles";

// Per-feed baseline of the title set the user has already reviewed in the
// picker: { [feedId]: string[] }. ABSENCE of a feed's entry means "never
// reviewed" (first sync) and is handled differently from a stored EMPTY
// array ("reviewed, saw nothing new that time") — see the first-sync guard
// in refreshCalendarData and handleListFeedTitles. Never default this map's
// per-feed entry with `|| []` before checking for that distinction; it
// erases exactly the thing this key exists to represent.
const SEEN_TITLES_KEY = "calSeenTitles";

// Top-level (not per-feed-prefixed, unlike the maps above) snapshot of which
// RULE/titles-mode feeds currently have unreviewed new titles: { [feedId]:
// {feedName, titles: string[]} }. Rebuilt WHOLESALE on every successful
// refreshCalendarData run (never merged with the prior value) so a feed that
// stops qualifying — role changed, or its ticked list now covers everything —
// doesn't leave a stale nag behind. handleListFeedTitles clears one feed's
// entry the moment its picker is opened (that IS "reviewed").
const NEW_TITLES_KEY = "newTitlesByFeed";

// Per-calendar per-event "show as" overrides: { [calendarId]: { [title]:
// shortLabel } }. For a Block title the label replaces the reject chip text;
// for a Note title it replaces the note body. Keyed by the same exact title the
// picker rows show.
const TITLE_LABELS_KEY = "calTitleLabels";

// Per-calendar short name: { [calendarId]: string }. When set it PREFIXES every
// note from that calendar in place of the calendar's full display name.
const LABEL_OVERRIDE_KEY = "calLabelOverride";

// Per-feed word for "I am already committed", shown on the reject chip of every
// shift this feed knocks out: { [feedId]: string }. This is what makes a feed's
// rejects say "✕ Fire Dept" while another feed's say "✕ Family".
//
// It is NOT calLabelOverride. That one prefixes this feed's NOTES and has never
// touched the chip; the two are separate on purpose, because the word for "why
// I am unavailable" is not the same thing as the name of the calendar a note
// came from. Precedence on the chip, most specific first:
//
//   per-event "show as" (calTitleLabels) → this → DEFAULT_COMMITMENT_LABEL
//
// Resolution happens in bucketEvents, at the moment the commitment triplet is
// built, because that is the last point at which the feed is still known:
// core/score.js merges overlapping commitments and keeps only the FIRST label,
// and the cached triplets carry no feed id at all.
const BLOCK_LABEL_KEY = "calBlockLabel";

// Per-calendar default "rest" hours required around a blocking (commitment)
// event before a shift may be considered clear of it: { [calendarId]: number }.
// restBefore = clear hours required BEFORE the commitment starts (checked
// against a shift that ends before it); restAfter = clear hours required AFTER
// the commitment ends (checked against a shift that starts after it). Missing
// entry ⇒ 0 — a blocking calendar with no configured buffer rejects only a
// direct overlap, nothing more.
const BUFFER_BEFORE_KEY = "calBufferBefore";
const BUFFER_AFTER_KEY = "calBufferAfter";

// Per-calendar PER-EVENT buffer override, keyed by the same exact
// (whitespace-normalized) title the Block/Note picker uses:
// { [calendarId]: { [title]: {before:number, after:number} } }. When present
// for a title it wins over that calendar's BUFFER_BEFORE_KEY/BUFFER_AFTER_KEY
// default — see effectiveBuffer().
const EVENT_BUFFERS_KEY = "calEventBuffers";

/**
 * The effective rest-buffer hours for one commitment event, per the CONTRACT:
 *   restBefore = eventBuffers[title]?.before ?? calBefore ?? 0
 *   restAfter  = eventBuffers[title]?.after  ?? calAfter  ?? 0
 *
 * `title` must already be whitespace-normalized/trimmed the same way the
 * eventBuffers map's keys are, so an NBSP in the feed can't disarm an override
 * the same way it can't disarm a label or note match elsewhere in this file.
 *
 * @param {string} title  normalized title
 * @param {unknown} calBefore  this calendar's default restBefore (may be absent)
 * @param {unknown} calAfter   this calendar's default restAfter (may be absent)
 * @param {unknown} eventBuffers  this calendar's { [title]: {before,after} } map
 * @returns {{before:number, after:number}}
 */
export function effectiveBuffer(title, calBefore, calAfter, eventBuffers) {
  const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const defBefore = num(calBefore, 0);
  const defAfter = num(calAfter, 0);
  let override;
  if (eventBuffers && typeof eventBuffers === "object" && !Array.isArray(eventBuffers)) {
    override = eventBuffers[title];
  }
  const before = override && typeof override === "object" ? num(override.before, defBefore) : defBefore;
  const after = override && typeof override === "object" ? num(override.after, defAfter) : defAfter;
  return { before, after };
}

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

// How old a cached calendar may be and still be scored against. There is NO
// background sync in this extension — the calendar only refreshes when the
// tradeboard is loaded — so a cache goes stale by the user being away, not by
// a timer lapsing. Past this bound "last sync" stops being a reasonable proxy
// for the user's actual commitments and we would rather show nothing.
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

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
 * Convert a normalized event to a [start, end] triplet pair in NY-local
 * "YYYY-MM-DD HH:MM" form, or null if it carries no usable start.
 *
 * Timed events (start.dateTime): the instant is normalized to NY civil time via
 * nytime civilFromEpoch(ms/1000), so any foreign-timezone event lands on NY
 * wall time — the scorer's expected frame.
 *
 * All-day events (start.date / end.date): the all-day end.date is ALREADY
 * the exclusive next day, so we DO NOT add a day — the pair already reads as
 * "00:00 → next-day 00:00", the all-day convention the scorer expects.
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
 * WHY THIS EXISTS. Real-world feed exports routinely emit a NO-BREAK SPACE
 * around the dash in a title, so what the user reads as "ACME - Desk" is
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
 * The role a feed takes when the user has never picked one for it.
 *
 * EVERY feed defaults to OFF. There is no cascade and no exception:
 *
 *   - A default may never produce a hard REJECT. A wrong reject silently hides
 *     a shift the user was actually free to take, and we would be guessing.
 *   - A default may never produce a FLAG either. A personal calendar is the most
 *     sensitive thing a user can subscribe this to — a family member's surgery,
 *     a therapy appointment, a lawyer's name in an event title. Reading it
 *     because we assumed consent is not ours to assume, and annotating with it
 *     means those titles get rendered onto a work page.
 *   - OFF means the refresh loop never fetches that feed at all, so its contents
 *     are never even retrieved.
 *
 * Accepted cost: a feed contributes nothing until it has a role. That is the
 * correct trade — the extension has nothing to say about a user's availability
 * until the user tells it which feeds represent real commitments. (The add-feed
 * flow asks for a role up front, so in practice this is the safety net rather
 * than the common path.)
 *
 * @param {{id:string, name?:string}} _feed
 * @returns {string} always "OFF"
 */
export function defaultRole(_feed) {
  return "OFF";
}

/**
 * Redact a feed URL down to something safe to render.
 *
 * A subscription URL IS the credential — a provider's secret/subscription URL
 * carries a token that grants read access to the whole calendar forever. The
 * options page therefore shows the host and nothing else; the full value stays
 * in chrome.storage.local, never on screen, never in a screenshot, never in a
 * support paste.
 *
 * @param {unknown} url
 * @returns {string} e.g. "calendar.example.com/…", or "" when there is no URL
 */
export function redactFeedUrl(url) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (raw === "") return "";
  try {
    return new URL(raw.replace(/^webcal:\/\//i, "https://")).host + "/…";
  } catch (_e) {
    return "…";
  }
}

/**
 * Attach the effective role and label prefix to each stored feed. The roles map
 * is sparse and may have been hand-edited, so an entry that is not a known role
 * falls back to defaultRole.
 *
 * DISPLAY NAME: the user names a feed when they add it; an unnamed feed falls
 * back to the calendar's own X-WR-CALNAME (captured at add time), then to a
 * neutral placeholder. It is NEVER the raw URL — see redactFeedUrl.
 *
 * PREFIX is that same display name: it is what prefixes every note this feed
 * produces. A per-feed short label (calLabelOverride) still wins over it
 * downstream, as it has always done.
 *
 * Malformed entries (non-object, missing id) are dropped rather than repaired: a
 * feed with no id cannot be keyed to a role or a block list anyway, so keeping it
 * would render a row whose every control silently did nothing.
 *
 * @param {unknown} feeds  the stored feeds array (user data — any shape)
 * @param {unknown} storedRoles  the calRoles map (may be undefined/sparse)
 * @returns {Array<{id:string, name:string, kind:string, role:string,
 *                  prefix:string, url:string, hasContent:boolean,
 *                  calName:string, tz:string, syncedAt:number|null}>}
 *          case-insensitive alpha by display name
 */
export function resolveFeedRoles(feeds, storedRoles) {
  const roles = storedRoles && typeof storedRoles === "object" ? storedRoles : {};
  const out = (Array.isArray(feeds) ? feeds : [])
    .filter((f) => f && typeof f === "object" && typeof f.id === "string" && f.id !== "")
    .map((f) => {
      const calName = typeof f.calName === "string" ? f.calName.trim() : "";
      const named = typeof f.name === "string" ? f.name.trim() : "";
      const name = named || calName || "Untitled feed";
      const stored = roles[f.id];
      return {
        id: f.id,
        name,
        kind: f.kind === "file" ? "file" : "url",
        role: ROLES.includes(stored) ? stored : defaultRole(f),
        prefix: name,
        url: typeof f.url === "string" ? f.url : "",
        // Carried so fetchFeedText can read a file feed's bytes. Both this and
        // `url` are SECRETS: handleListFeeds maps them away before anything
        // reaches the options page (see redactFeedUrl).
        content: typeof f.content === "string" ? f.content : "",
        hasContent: typeof f.content === "string" && f.content.trim() !== "",
        calName,
        tz: typeof f.tz === "string" ? f.tz : "",
        syncedAt: typeof f.syncedAt === "number" ? f.syncedAt : null,
      };
    });
  out.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return out;
}

/**
 * Compose a note's triplet label: the calendar prefix (a short override or the
 * calendar's display name, "" for the primary) joined to the shown text with
 * the middot separator. An empty prefix leaves the text bare — the primary
 * calendar's notes must not open with a stray " · ".
 * @param {string} prefix
 * @param {string} shown
 * @returns {string}
 */
function noteLabel(prefix, shown) {
  return prefix ? prefix + LABEL_SEP + shown : shown;
}

/**
 * Split one calendar's events into hard commitments vs soft notes according to
 * its role, under the THREE-WAY model (Block / Note / Ignore). Cancelled and
 * un-triplet-able events are dropped in every role. Each output row is a
 * [start, end, label] triplet.
 *
 * THE THREE-WAY BRANCH (RULE role):
 *   - Block: title STEM-matches the block set (`rule`, from titlesToMatcher) →
 *     hard commitment. Triplet label = the per-event "show as" label if one is
 *     set, ELSE the empty string. Empty is deliberate: it means "no custom
 *     label", and the reject chip then falls back to the user's global
 *     commitmentLabel (the display layer, not here). Stem match is the
 *     safety-critical, forward-looking rule and is UNCHANGED.
 *   - Note: title EXACT-matches (whitespace-normalized) the note set → soft
 *     note. Triplet label = prefix + (per-event "show as" || the raw title).
 *     Exact — not stem — because a note is cosmetic: marking "Music Class" must
 *     not silently start noting a future, different "Music Class Recital".
 *   - Ignore: title in NEITHER set → DROPPED entirely, not even a note. Ignore
 *     is the default, so a RULE calendar the user has not configured produces
 *     nothing and the board stays quiet.
 *
 * REJECT notes nothing and blocks everything (label = per-event "show as" ||
 * ""). FLAG (and any unknown role) blocks nothing and notes everything, honoring
 * the prefix and per-event labels. OFF produces nothing.
 *
 * The rule predicate runs on the RAW event title, NEVER on the prefixed label.
 * An anchored user regex like "^Work\b" could never match "Shared Cal · Work
 * day", so running it on the label would silently stop every non-primary RULE
 * calendar from producing hard rejects — a shift would be offered as free while
 * the user is in fact committed.
 *
 * BUFFER TRIPLET SHAPE: a commitment row is [start, end, label, restBefore,
 * restAfter] — restBefore/restAfter are the effective rest-buffer hours for
 * that event (see effectiveBuffer()), 0 when unconfigured. A soft/note row
 * stays [start, end, label] — buffers are meaningless for a non-blocking note
 * and are never appended to one.
 *
 * @param {object[]} events
 * @param {string} role  one of ROLES
 * @param {(title:string)=>boolean} rule  block predicate, called with the raw title only
 * @param {string} prefix  short override or calendar summary ("" for primary)
 * @param {unknown} [noteTitles]  the note set for this calendar (want string[])
 * @param {unknown} [labels]  per-event "show as" map { [title]: shortLabel }
 * @param {{before?:number, after?:number, eventBuffers?:object, blockLabel?:string}} [feedOpts]
 *   this calendar's default restBefore/restAfter and its per-event override
 *   map ({ [title]: {before,after} }, keyed like `labels`/`noteTitles`).
 * @returns {{commitments: string[][], soft: string[][]}}
 */
export function bucketEvents(events, role, rule, prefix, noteTitles, labels, feedOpts) {
  const bufOpts = feedOpts && typeof feedOpts === "object" ? feedOpts : {};
  // This feed's own commitment word. Trimmed here so a whitespace-only stored
  // value behaves as "unset" and falls through to the display-layer default,
  // rather than rendering a chip that reads "✕".
  const blockLabel = typeof bufOpts.blockLabel === "string" ? bufOpts.blockLabel.trim() : "";
  const eventBuffers = bufOpts.eventBuffers;
  const commitments = [];
  const soft = [];
  if (role === "OFF") return { commitments, soft };

  // Normalized lookups, built once. Both the note set and the label map are
  // matched by EXACT whitespace-normalized title, the same normalization the
  // stem matcher applies, so an NBSP in the feed cannot disarm either.
  const noteSet = new Set();
  for (const t of Array.isArray(noteTitles) ? noteTitles : []) {
    const k = normalizeTitleWhitespace(t).trim();
    if (k) noteSet.add(k);
  }
  const labelMap = new Map();
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    for (const [k, v] of Object.entries(labels)) {
      if (typeof v !== "string") continue;
      const nk = normalizeTitleWhitespace(k).trim();
      const nv = v.trim();
      if (nk && nv) labelMap.set(nk, nv);
    }
  }
  // Same normalization as noteSet/labelMap: a per-event buffer override is keyed
  // by whitespace-normalized title, so an NBSP or double space in the feed can't
  // silently drop the override and fall back to the calendar default.
  const bufferMap = {};
  if (eventBuffers && typeof eventBuffers === "object" && !Array.isArray(eventBuffers)) {
    for (const [k, v] of Object.entries(eventBuffers)) {
      const nk = normalizeTitleWhitespace(k).trim();
      if (nk) bufferMap[nk] = v;
    }
  }

  for (const ev of events || []) {
    if (ev.status === "cancelled") continue;
    const trip = buildTriplet(ev);
    if (!trip) continue;
    const rawTitle = ev.summary || "";
    const normTitle = normalizeTitleWhitespace(rawTitle).trim();
    const perEventLabel = labelMap.get(normTitle) || "";

    // Bucket the event: "commitment" (hard block), "soft" (note), or null (drop).
    let bucket;
    let label;
    if (role === "REJECT") {
      bucket = "commitment";
      // Per-event "show as" beats the feed's own word; "" ⇒ the reject chip
      // falls back to DEFAULT_COMMITMENT_LABEL in the display layer. The note
      // prefix is deliberately NOT applied — a chip must never read "Feed · X".
      label = perEventLabel || blockLabel;
    } else if (role === "RULE") {
      if (rule(rawTitle)) {
        bucket = "commitment"; // Block — stem match
        label = perEventLabel || blockLabel;
      } else if (noteSet.has(normTitle)) {
        bucket = "soft"; // Note — exact match
        label = noteLabel(prefix, perEventLabel || rawTitle);
      } else {
        bucket = null; // Ignore — the default
      }
    } else {
      // FLAG, and defensively any unknown role: note everything.
      bucket = "soft";
      label = noteLabel(prefix, perEventLabel || rawTitle);
    }

    if (bucket === null) continue;
    if (bucket === "commitment") {
      const buf = effectiveBuffer(normTitle, bufOpts.before, bufOpts.after, bufferMap);
      commitments.push([trip[0], trip[1], label, buf.before, buf.after]);
    } else {
      soft.push([trip[0], trip[1], label]);
    }
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
 * TODAY-OR-LATER FILTER (declutter). A title survives only if at least ONE of
 * its instances falls on today or later (by its start date, NY civil). A
 * recurring commitment always has an upcoming instance in the 30-back/60-fwd
 * sample window and keeps surfacing; a one-off that already happened has only
 * past instances and drops out of the list entirely — that stale clutter was
 * the whole complaint. The filter is per-TITLE (on the max date across all its
 * instances), never per-instance: a title's count/typicalMinutes still reflect
 * every instance in the sample, past and future, once the title itself
 * qualifies. "Today" is derived as an NY civil date via civilFromEpoch — never
 * hand-rolled or read from local browser time — with an injectable clock
 * (nowMs) so this is testable, mirroring titleSampleWindow's convention.
 *
 * RECURRING FLAG (picker declutter, phase 2). Each output row carries
 * `recurring`: true the moment ANY of that title's instances came from an
 * RRULE series (core/ics.js stamps this per-instance, including
 * RECURRENCE-ID overrides — see mkEvent). A title with a mix of recurring and
 * standalone instances under the same exact text still reads as recurring;
 * that is the more useful signal for a user deciding whether a title is a
 * standing commitment.
 *
 * Sorted most-frequent first, ties broken case-insensitively by title so the
 * order is stable between calls. UNCHANGED by the above — the options page
 * re-sorts alphabetically itself, so this sort is not what orders the picker,
 * and other callers may depend on it as-is.
 *
 * @param {object[]} events
 * @param {number} [nowMs] injectable clock for tests — see titleSampleWindow
 * @returns {Array<{title:string, count:number, typicalMinutes:number, recurring:boolean}>}
 */
export function summarizeTitles(events, nowMs) {
  const today = civilFromEpoch((nowMs === undefined ? Date.now() : nowMs) / 1000);
  const todayIso = `${today.y}-${pad2(today.mo)}-${pad2(today.d)}`;
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
    const dateStr = trip[0].slice(0, 10); // "YYYY-MM-DD HH:MM" -> "YYYY-MM-DD"
    const bucket = byTitle.get(title) || { durations: [], maxDate: dateStr, recurring: false };
    bucket.durations.push(mins);
    if (dateStr > bucket.maxDate) bucket.maxDate = dateStr;
    if (ev.recurring === true) bucket.recurring = true;
    byTitle.set(title, bucket);
  }
  const out = [];
  for (const [title, bucket] of byTitle) {
    if (bucket.maxDate < todayIso) continue; // stale one-off — no instance today-or-later
    const durations = bucket.durations.slice().sort((a, b) => a - b);
    const mid = Math.floor((durations.length - 1) / 2); // lower median on ties
    out.push({ title, count: durations.length, typicalMinutes: durations[mid], recurring: bucket.recurring });
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
 * Which of a feed's CURRENT today-or-later titles are genuinely new — the
 * computation behind the "review new titles" nudge (see refreshCalendarData
 * and handleListFeedTitles). A title is dropped from the result (never
 * flagged) for any of three reasons, each of which means the user has already
 * effectively dealt with it:
 *
 *   - already in `seenTitles` (whitespace-normalized exact match) — reviewed
 *     in a prior picker session or seeded by the first-sync baseline;
 *   - already covered by a ticked BLOCK title, by the same stem logic
 *     titlesToMatcher uses for real scoring — a title that already blocks
 *     shifts must not also nag;
 *   - already in the NOTE list (whitespace-normalized exact match, matching
 *     bucketEvents' own note-matching rule).
 *
 * Callers are responsible for the first-sync distinction: this function only
 * compares against whatever `seenTitles` it is given, so an ABSENT baseline
 * must be handled by the caller (seed silently, flag nothing) BEFORE calling
 * this — passing `[]` for "never reviewed" would flag every title on a user's
 * first sync, training them to ignore the banner. See SEEN_TITLES_KEY.
 *
 * @param {unknown} currentTitles  today-or-later title strings (summarizeTitles output, mapped to .title)
 * @param {unknown} seenTitles  this feed's stored calSeenTitles entry (want string[])
 * @param {unknown} blockTitlesForFeed  this feed's calBlockTitles entry (want string[])
 * @param {unknown} noteTitlesForFeed  this feed's calNoteTitles entry (want string[])
 * @returns {string[]} the subset of currentTitles that are new
 */
export function newTitlesForFeed(currentTitles, seenTitles, blockTitlesForFeed, noteTitlesForFeed) {
  const seenSet = new Set(
    (Array.isArray(seenTitles) ? seenTitles : []).map((t) => normalizeTitleWhitespace(t).trim())
  );
  const noteSet = new Set(
    (Array.isArray(noteTitlesForFeed) ? noteTitlesForFeed : []).map((t) => normalizeTitleWhitespace(t).trim())
  );
  const blockMatches = titlesToMatcher(blockTitlesForFeed);
  return (Array.isArray(currentTitles) ? currentTitles : []).filter((t) => {
    if (typeof t !== "string") return false;
    const norm = normalizeTitleWhitespace(t).trim();
    if (norm === "") return false;
    if (seenSet.has(norm)) return false;
    if (noteSet.has(norm)) return false;
    if (blockMatches(t)) return false;
    return true;
  });
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
// ICS feeds — the calendar source. NO AUTH: a URL feed is a read-only secret
// capability link the user pasted, a file feed is a snapshot they uploaded.
// (This consumes .ics feeds directly; nothing below the seam changed, because
// both sources produce the same normalized event shape.)
// ---------------------------------------------------------------------------

function taggedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Normalize a user-supplied feed URL, or return "" when it is not a fetchable
 * calendar URL.
 *
 * webcal:// is the scheme calendar apps hand out for subscriptions — it is
 * ordinary https in transport, so it is rewritten rather than refused.
 * Everything that is not http(s) AFTER that rewrite is refused: a feed URL is
 * stored config that later reaches fetch(), and javascript:/data:/file: have no
 * business there.
 *
 * @param {unknown} src
 * @returns {string} a fetchable http(s) URL, or "" when unusable
 */
export function normalizeFeedUrl(src) {
  const raw = typeof src === "string" ? src.trim() : "";
  if (raw === "") return "";
  const swapped = raw.replace(/^webcal:\/\//i, "https://");
  let u;
  try {
    u = new URL(swapped);
  } catch (_e) {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  return u.href;
}

/**
 * A fresh per-feed config key. Every per-calendar map (calRoles, calBlockTitles,
 * calNoteTitles, calTitleLabels, calBufferBefore/After, calEventBuffers) is keyed
 * by this, so it is generated ONCE when the feed is added and then stored on the
 * feed forever: deriving it from the URL instead would silently detach the whole
 * configuration the moment a user re-pasted a rotated secret link.
 */
function newFeedId() {
  return "feed_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

/**
 * Read one feed's raw .ics text.
 *
 *   kind:"file" — the bytes the user uploaded, already in storage. No network
 *     and no host permission, which also sidesteps CORS for providers that do
 *     not expose a fetchable URL.
 *   kind:"url"  — a plain GET with credentials omitted: the secret lives in the
 *     URL itself, and that IS the entire auth model. Nothing is ever sent.
 *
 * Every failure throws a tagged error. Nothing here may answer "no events" for a
 * feed that did not actually load: a blocking feed silently yielding zero events
 * is precisely how a shift the user is already committed to would look free.
 */
async function fetchFeedText(feed) {
  if (feed.kind === "file") {
    if (typeof feed.content !== "string" || feed.content.trim() === "") {
      throw taggedError("feed_empty", "no uploaded file content — re-upload the .ics");
    }
    return feed.content;
  }
  const url = normalizeFeedUrl(feed.url);
  if (!url) throw taggedError("feed_bad_url", "not a usable https feed URL");
  let resp;
  try {
    resp = await fetch(url, { credentials: "omit", redirect: "follow" });
  } catch (e) {
    throw taggedError("feed_unreachable", "unreachable: " + (e && e.message ? e.message : String(e)));
  }
  if (!resp.ok) throw taggedError("feed_http", "http_" + resp.status);
  return resp.text();
}

/**
 * One feed's events for [timeMin, timeMax) in the normalized form
 * buildTriplet consumes, plus the feed's own X-WR-CALNAME/X-WR-TIMEZONE and any
 * per-event skip warnings the parser raised.
 *
 * parseIcs throws when the body is not iCalendar at all — an expired secret
 * link or a captive portal answers with HTML, and that must read as a broken
 * feed, never as a calendar with nothing on it.
 *
 * @returns {{events:object[], calName:string|null, tz:string|null, warnings:string[]}}
 */
async function getIcsEvents(feed, timeMin, timeMax) {
  const text = await fetchFeedText(feed);
  try {
    return parseIcs(text, timeMin, timeMax);
  } catch (e) {
    throw taggedError("feed_unparseable", e && e.message ? e.message : String(e));
  }
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
// Refresh: stored feeds → per-feed .ics fetch + parse → triplet lists → cache
// ---------------------------------------------------------------------------

/**
 * Fetch every switched-on feed, bucket its events, and return the envelope the
 * content script consumes: { ok, fetchedAt, commitments, soft, warnings }.
 *
 * FAILURE POLICY — the safety-critical decision in this file:
 *
 *   - A BLOCKING-CAPABLE feed (REJECT or RULE) that fails to load does NOT
 *     automatically fail the whole refresh. If a last-good `calCache` exists,
 *     COVERS the requested window (windowCovers), and is no older than
 *     STALE_MAX_MS, that cache is served instead: ok:true, stale:true,
 *     fromCache:true, with fetchedAt carried from the CACHE's own timestamp
 *     (never Date.now()) so the drawer's staleness banner names the true age.
 *     The failing feed's error string rides along so the drawer can say which
 *     feed to go fix. Only when the cache is missing, doesn't cover the
 *     window, or has aged past the cap does the refresh give up outright and
 *     return ok:false — because at that point "last sync" is no longer a
 *     reasonable proxy for the user's actual commitments, and if a feed that
 *     can hard-reject shifts did not load AND we have nothing trustworthy to
 *     fall back on, every shift on the board would otherwise render as free —
 *     the single failure this extension exists to prevent. No answer beats a
 *     confidently wrong one; a stale-but-covering answer beats no answer.
 *   - A FLAG feed (notes only) that fails is NOT fatal. Notes are cosmetic;
 *     losing them degrades annotation, never correctness. It records a loud
 *     warning and scoring continues.
 *   - An OFF feed is never fetched, so it can neither fail nor leak.
 *
 * Per-event parser warnings (an unsupported recurrence, an unresolvable
 * timezone) are prefixed with the feed's name and passed through: those events
 * were skipped, and the user has to be told which.
 */
async function refreshCalendarData(windowStart, windowEnd) {
  await migrateCommitmentLabel();
  const cfg = await loadConfig();
  const warnings = [...cfg.warnings];

  const store = await chrome.storage.local.get([
    FEEDS_KEY,
    ROLES_KEY,
    BLOCK_TITLES_KEY,
    NOTE_TITLES_KEY,
    TITLE_LABELS_KEY,
    LABEL_OVERRIDE_KEY,
    BLOCK_LABEL_KEY,
    BUFFER_BEFORE_KEY,
    BUFFER_AFTER_KEY,
    EVENT_BUFFERS_KEY,
    SEEN_TITLES_KEY,
  ]);
  const feeds = resolveFeedRoles(store[FEEDS_KEY], store[ROLES_KEY]);
  const blockTitles = store[BLOCK_TITLES_KEY] || {};
  const noteTitles = store[NOTE_TITLES_KEY] || {};
  const titleLabels = store[TITLE_LABELS_KEY] || {};
  const labelOverride = store[LABEL_OVERRIDE_KEY] || {};
  const blockLabels = store[BLOCK_LABEL_KEY] || {};
  const bufferBefore = store[BUFFER_BEFORE_KEY] || {};
  const bufferAfter = store[BUFFER_AFTER_KEY] || {};
  const eventBuffers = store[EVENT_BUFFERS_KEY] || {};
  // Mutated in place below (first-sync seeding only — see the per-feed loop).
  // Read RAW (not defaulted per-feed with `|| []`): hasOwnProperty on this map
  // is how a feed's never-reviewed state is told apart from "reviewed, saw
  // nothing new" (a stored []). Only written back to storage if
  // seenTitlesTouched ends up true, i.e. at least one feed was seeded.
  const seenTitlesMap = store[SEEN_TITLES_KEY] || {};
  let seenTitlesTouched = false;
  // Rebuilt wholesale this run — see NEW_TITLES_KEY's doc comment.
  const newTitlesByFeed = {};

  const timeMin = nyMidnightRfc3339(windowStart, 0);
  const timeMax = nyMidnightRfc3339(windowEnd, 1); // +1 day: exclusive upper bound

  const commitments = [];
  const soft = [];
  const regexRule = (title) => ruleMatches(title, cfg.includeRe, cfg.excludes);
  const meta = {};

  for (const feed of feeds) {
    if (feed.role === "OFF") continue; // never fetched — no request is made at all

    let parsed;
    try {
      parsed = await getIcsEvents(feed, timeMin, timeMax);
    } catch (e) {
      const why = e && e.message ? e.message : String(e);
      if (feed.role === "FLAG") {
        warnings.push(`feed_unavailable: "${feed.name}" (${why}) — its notes are missing`);
        continue;
      }
      const error = `feed_failed: "${feed.name}" — ${why}`;
      // Blocking feed down. Before giving up outright, see if a last-good cache
      // can stand in: it must cover the requested window (a partial cache would
      // silently score the uncovered dates as free) and be within STALE_MAX_MS
      // (past that, "last sync" stops being a reasonable proxy for reality).
      const cached = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
      if (
        cached &&
        windowCovers(cached, windowStart, windowEnd) &&
        Date.now() - cached.fetchedAt <= STALE_MAX_MS
      ) {
        return {
          ok: true, stale: true, error, fromCache: true, fetchedAt: cached.fetchedAt,
          commitments: cached.commitments, soft: cached.soft, warnings,
        };
      }
      return { ok: false, error };
    }

    for (const w of parsed.warnings) warnings.push(`${feed.name}: ${w}`);
    meta[feed.id] = { calName: parsed.calName || "", tz: parsed.tz || "", syncedAt: Date.now() };

    // Ticked titles are per-feed and are the whole blocking set. The legacy
    // regex is consulted ONLY for a user who explicitly armed it.
    const { rule, mode } = calendarRule(blockTitles[feed.id], regexRule, cfg.usePattern);

    // NEW-TITLE REVIEW NUDGE. Gate is EXACT and must not widen: only a RULE
    // feed actually deciding its blocking set from ticked titles has a picker
    // to review in the first place (REJECT has none and blocks everything
    // anyway; RULE in "regex"/"none" mode isn't picker-driven; FLAG/OFF never
    // block, so there is nothing to silently mis-score).
    if (feed.role === "RULE" && mode === "titles") {
      const currentTitles = summarizeTitles(parsed.events).map((t) => t.title);
      if (!Object.prototype.hasOwnProperty.call(seenTitlesMap, feed.id)) {
        // First sync for this feed: seed the baseline silently and flag
        // NOTHING this run. Mirrors loadBannerFromLastDiff's first_run guard
        // — without this, a user's very first sync would flag every title
        // they already own, training them to ignore the banner forever after.
        seenTitlesMap[feed.id] = currentTitles;
        seenTitlesTouched = true;
      } else {
        const fresh = newTitlesForFeed(
          currentTitles, seenTitlesMap[feed.id], blockTitles[feed.id], noteTitles[feed.id]
        );
        if (fresh.length > 0) newTitlesByFeed[feed.id] = { feedName: feed.name, titles: fresh };
      }
    }

    // A per-feed short name, when set, replaces the feed's display name as the
    // prefix on every note from it.
    const override = typeof labelOverride[feed.id] === "string" ? labelOverride[feed.id].trim() : "";
    const prefix = override || feed.prefix;
    const b = bucketEvents(
      parsed.events, feed.role, rule, prefix, noteTitles[feed.id], titleLabels[feed.id],
      {
        before: bufferBefore[feed.id],
        after: bufferAfter[feed.id],
        eventBuffers: eventBuffers[feed.id],
        blockLabel: blockLabels[feed.id],
      }
    );
    commitments.push(...b.commitments);
    soft.push(...b.soft);
    dlog("feed events", feed.role, mode, parsed.events.length);
  }

  // Sort each list by triplet start string (lexicographic == chronological here).
  const byStart = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  commitments.sort(byStart);
  soft.sort(byStart);

  const fetchedAt = Date.now();
  // newTitlesByFeed is written HERE, alongside the cache, never on an
  // early-return path above (feed_unavailable/FLAG-continue aside, those
  // don't return). A refresh that gives up early (ok:false, or the
  // stale-cache fallback) returns before reaching this line, so a
  // previously-computed newTitlesByFeed value is left exactly as it was
  // rather than being clobbered with a partial or empty recomputation.
  const toSet = { [CACHE_KEY]: { fetchedAt, commitments, soft, windowStart, windowEnd }, [NEW_TITLES_KEY]: newTitlesByFeed };
  if (seenTitlesTouched) toSet[SEEN_TITLES_KEY] = seenTitlesMap;
  await chrome.storage.local.set(toSet);
  await recordFeedMeta(meta);

  dlog("refresh done", { commitments: commitments.length, soft: soft.length, warnings });
  return { ok: true, fromCache: false, fetchedAt, commitments, soft, warnings };
}

// The single global commitment word this extension used before every feed got
// its own. Read only by the migration below, then deleted.
const LEGACY_COMMITMENT_LABEL_KEY = "commitmentLabel";

/**
 * Carry a pre-per-feed global commitment label onto every feed, once.
 *
 * WHY THIS EXISTS. The reject chip used to read one global word for every feed.
 * Deleting that setting without moving its value would silently turn a user's
 * "✕ Fire Dept" into "✕ Commitment" — config they deliberately set, disarmed
 * without a word. This codebase has shipped that class of bug twice (an empty
 * include regex, a hidden calendar losing its role) and both times the damage
 * was that it was INVISIBLE. So the value is copied first and the old key is
 * removed only after.
 *
 * Applied to EVERY feed, not just the ones that currently block: the old label
 * would have applied to any feed the moment it was switched to a blocking role,
 * so seeding all of them is what actually reproduces the prior behaviour.
 *
 * Idempotent and self-deleting — once the legacy key is gone this is a single
 * storage read that does nothing, so it is safe to call on every refresh. It
 * never overwrites a per-feed label the user has already set.
 */
async function migrateCommitmentLabel() {
  const store = await chrome.storage.local.get([LEGACY_COMMITMENT_LABEL_KEY, FEEDS_KEY, BLOCK_LABEL_KEY]);
  const legacy = store[LEGACY_COMMITMENT_LABEL_KEY];
  if (typeof legacy !== "string") return;
  const word = legacy.trim();

  if (word) {
    const labels = store[BLOCK_LABEL_KEY] || {};
    let touched = false;
    for (const f of Array.isArray(store[FEEDS_KEY]) ? store[FEEDS_KEY] : []) {
      if (!f || typeof f.id !== "string" || !f.id) continue;
      if (typeof labels[f.id] === "string" && labels[f.id].trim()) continue; // user already set one
      labels[f.id] = word;
      touched = true;
    }
    if (touched) await chrome.storage.local.set({ [BLOCK_LABEL_KEY]: labels });
  }
  await chrome.storage.local.remove(LEGACY_COMMITMENT_LABEL_KEY);
  dlog("migrated commitmentLabel", word ? "seeded" : "blank — dropped");
}

/**
 * Persist what a successful fetch learned about each feed: the calendar's own
 * name and timezone (UI defaults for a feed the user never named) and when it
 * last synced (the "synced Nm ago" chip). Never touches a role or anything the
 * user typed — a background refresh must not overwrite their own words.
 */
async function recordFeedMeta(meta) {
  if (Object.keys(meta).length === 0) return;
  const feeds = (await chrome.storage.local.get(FEEDS_KEY))[FEEDS_KEY];
  if (!Array.isArray(feeds)) return;
  let touched = false;
  for (const f of feeds) {
    const m = f && typeof f === "object" ? meta[f.id] : null;
    if (!m) continue;
    if (m.calName) f.calName = m.calName;
    if (m.tz) f.tz = m.tz;
    f.syncedAt = m.syncedAt;
    touched = true;
  }
  if (touched) await chrome.storage.local.set({ [FEEDS_KEY]: feeds });
}

// A tagged feed error carries its own code; anything else is an unexpected
// throw and is surfaced verbatim rather than smoothed over.
function errorResponse(e) {
  if (e && e.code) return { ok: false, error: e.code + ": " + (e.message || "") };
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
    // Same STALE_MAX_MS bound as the refresh-failure fallback (refreshCalendarData
    // above). Without it, boot's cache path would happily serve a week-old cache
    // and flip calendarLoaded true before the refresh even runs, defeating that cap.
    if (
      stored &&
      windowCovers(stored, windowStart, windowEnd) &&
      Date.now() - stored.fetchedAt <= STALE_MAX_MS
    ) {
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

  if (mode === "refresh" || mode === "interactive") {
    // "interactive" was the OAuth consent path. With no auth there is nothing to
    // prompt for, so it is simply a refresh — kept as an accepted mode so the
    // content script's existing connect affordance keeps working unchanged.
    return refreshCalendarData(windowStart, windowEnd);
  }
  return { ok: false, error: "bad_mode" };
}

/**
 * The options page's view of the configured feeds.
 *
 * The panel shows the RAW stored regex strings, not loadConfig's compiled form:
 * when a stored regex is invalid loadConfig silently falls back to the default,
 * but the user still needs to see the broken value in order to fix it.
 *
 * NO feed URL is returned — only redactFeedUrl's host form. A subscription URL
 * is the credential, and the panel never needs the secret to render a row, only
 * to have added it in the first place.
 */
async function handleListFeeds() {
  // The options page is the other way a user reaches this worker, so the
  // migration runs here too — otherwise a legacy label would sit unmoved until
  // the next board refresh and the panel would render the wrong thing meanwhile.
  await migrateCommitmentLabel();
  const store = await chrome.storage.local.get([
    FEEDS_KEY,
    ROLES_KEY,
    BLOCK_TITLES_KEY,
    PATTERN_OPT_IN_KEY,
    "ruleInclude",
    "ruleExclude",
    BLOCK_LABEL_KEY,
    BUFFER_BEFORE_KEY,
    BUFFER_AFTER_KEY,
  ]);
  const blockTitles = store[BLOCK_TITLES_KEY] || {};
  const blockLabels = store[BLOCK_LABEL_KEY] || {};
  const bufferBefore = store[BUFFER_BEFORE_KEY] || {};
  const bufferAfter = store[BUFFER_AFTER_KEY] || {};
  const feeds = resolveFeedRoles(store[FEEDS_KEY], store[ROLES_KEY]).map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
    role: f.role,
    // The host only — never the secret capability URL.
    source: f.kind === "file" ? "uploaded file" : redactFeedUrl(f.url),
    // A file feed is a static snapshot; the panel says so rather than showing a
    // "synced Nm ago" chip that would imply it refreshes itself.
    syncedAt: f.syncedAt,
    hasContent: f.hasContent,
    calName: f.calName,
    tz: f.tz,
    // blockTitles lets the picker show what is already ticked without a second
    // round trip.
    blockTitles: Array.isArray(blockTitles[f.id]) ? blockTitles[f.id] : [],
    // This feed's word on the reject chip ("" = fall back to the neutral
    // default). Only meaningful for a feed that can block.
    blockLabel: typeof blockLabels[f.id] === "string" ? blockLabels[f.id] : "",
    // Default rest-buffer hours for this feed's blocking events (0 when
    // unconfigured) — see BUFFER_BEFORE_KEY/BUFFER_AFTER_KEY.
    bufferBefore: typeof bufferBefore[f.id] === "number" ? bufferBefore[f.id] : 0,
    bufferAfter: typeof bufferAfter[f.id] === "number" ? bufferAfter[f.id] : 0,
  }));

  return {
    ok: true,
    feeds,
    ruleFilter: {
      include: typeof store.ruleInclude === "string" ? store.ruleInclude : DEFAULTS.ruleInclude,
      exclude: typeof store.ruleExclude === "string" ? store.ruleExclude : DEFAULTS.ruleExclude,
      // Whether the pattern is actually ARMED — without it the panel cannot tell
      // an inert legacy pattern from one that is deciding hard rejects.
      usePattern: resolvePatternOptIn(store),
    },
  };
}

/**
 * The id of the feed a config message is about.
 *
 * `calendarId` is accepted as an alias for `feedId`: every per-calendar map in
 * this worker is keyed by an opaque id string, and when the source changed
 * to .ics feeds only the ID's ORIGIN changed, never its role. Accepting both
 * keeps one vocabulary at the wire without forcing a flag-day rename on callers.
 *
 * @param {unknown} msg
 * @returns {string} the id, or "" when absent/not a string
 */
function msgFeedId(msg) {
  const m = msg && typeof msg === "object" ? msg : {};
  const id = typeof m.feedId === "string" ? m.feedId : m.calendarId;
  return typeof id === "string" ? id : "";
}

// Every mutator REMOVES the cache rather than leaving it for the next refresh to
// overwrite: if that refresh fails, a stale cache bucketed under the old roles
// would be served as authoritative on the next boot, silently applying rejects
// the user just turned off. Removal surfaces the failure as no_cache instead.
async function handleSetFeedRole(msg) {
  const feedId = msgFeedId(msg);
  if (!feedId || !ROLES.includes(msg.role)) {
    return { ok: false, error: "bad_role" };
  }
  const roles = (await chrome.storage.local.get(ROLES_KEY))[ROLES_KEY] || {};
  roles[feedId] = msg.role;
  await chrome.storage.local.set({ [ROLES_KEY]: roles });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

/**
 * Persist one feed's reject-chip word (calBlockLabel).
 *
 * Deliberately its own tiny handler rather than a field on setEventRules: that
 * one writes a SNAPSHOT of the whole three-way picker, and a REJECT feed never
 * loads a picker — routing this through it would send empty block/note arrays
 * and wipe config the user still has.
 *
 * An empty or whitespace-only value REMOVES the entry rather than storing "",
 * so "unset" has exactly one representation and the chip falls back to the
 * neutral default.
 *
 * -> { type:"setFeedBlockLabel", feedId, label }
 * <- { ok:true } | { ok:false, error:"bad_feed_id" }
 */
async function handleSetFeedBlockLabel(msg) {
  const feedId = msgFeedId(msg);
  if (!feedId) return { ok: false, error: "bad_feed_id" };
  const label = typeof (msg && msg.label) === "string" ? msg.label.trim() : "";

  const map = (await chrome.storage.local.get(BLOCK_LABEL_KEY))[BLOCK_LABEL_KEY] || {};
  if (label) map[feedId] = label;
  else delete map[feedId];
  await chrome.storage.local.set({ [BLOCK_LABEL_KEY]: map });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

/**
 * Coerce a candidate buffer-hours value to a valid, storable number: finite,
 * non-negative, rounded to at most 2 decimal places. Returns null for anything
 * else (NaN, Infinity, negative, non-numeric) so the caller can reject rather
 * than silently store a nonsensical buffer.
 * @param {unknown} v
 * @returns {number|null}
 */
function coerceBufferHours(v) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Persist this calendar's default rest-buffer hours (calBufferBefore/After).
 * Per-event overrides (calEventBuffers) are untouched — they are written by
 * setEventRules.
 *
 * -> { type:"setCalendarBuffer", calendarId, before:number, after:number }
 * <- { ok:true } | { ok:false, error:"bad_feed_id"|"bad_buffer" }
 */
async function handleSetCalendarBuffer(msg) {
  const calendarId = msgFeedId(msg);
  if (!calendarId) return { ok: false, error: "bad_feed_id" };

  const before = coerceBufferHours(msg && msg.before);
  const after = coerceBufferHours(msg && msg.after);
  if (before === null || after === null) return { ok: false, error: "bad_buffer" };

  const cur = await chrome.storage.local.get([BUFFER_BEFORE_KEY, BUFFER_AFTER_KEY]);
  const beforeMap = cur[BUFFER_BEFORE_KEY] || {};
  const afterMap = cur[BUFFER_AFTER_KEY] || {};
  beforeMap[calendarId] = before;
  afterMap[calendarId] = after;
  await chrome.storage.local.set({
    [BUFFER_BEFORE_KEY]: beforeMap,
    [BUFFER_AFTER_KEY]: afterMap,
  });
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
 * List ONE feed's distinct event titles, so the user can tick the ones that mean
 * "I am unavailable" instead of writing a regex.
 *
 * -> { type:"listFeedTitles", feedId[, windowStart, windowEnd] }
 * <- { ok:true, titles:[{title,count,typicalMinutes,recurring,isNew}], warnings,
 *      blockTitles, … }
 * <- { ok:false, error }   error:"feed_off" when the feed is not switched on —
 *                          this handler reads events, so it is gated on the same
 *                          stored role everything else is.
 *
 * windowStart/windowEnd are the same NY date strings getCalendarData takes. A
 * caller that has a scored window (the drawer) should pass it so the picker
 * samples exactly what will be scored; the options page has no window of its
 * own, so omitting them falls back to a sampling window around today. The
 * fallback is only ever used to POPULATE A LIST OF TITLES — it never decides
 * whether a shift is blocked, so a wider-than-scored sample costs nothing but an
 * extra row in the picker.
 *
 * blockTitles — and the rest of the three-way state — echo back what is stored
 * for this feed, so the picker renders without a second round trip.
 *
 * OPENING THE PICKER MARKS IT REVIEWED. `isNew` on each returned title is
 * computed against the PRE-write calSeenTitles baseline (never seen ⇒ nothing
 * is flagged, mirroring the first-sync rule in refreshCalendarData — there is
 * no prior state to compare against, so nothing can honestly be called
 * "new"). AFTER computing it, this handler overwrites calSeenTitles[feedId]
 * with the current today-or-later title set and clears this feed's
 * newTitlesByFeed entry, so the drawer's nudge is gone by the next paint. The
 * order matters: computing isNew from the POST-write state would mean the
 * user always walks into a picker where nothing is ever flagged.
 */
async function handleListFeedTitles(msg) {
  const feedId = msg && msg.feedId;
  if (!feedId) return { ok: false, error: "bad_feed_id" };
  const win = titleSampleWindow(msg.windowStart, msg.windowEnd);

  const stored = await chrome.storage.local.get([
    FEEDS_KEY,
    ROLES_KEY,
    BLOCK_TITLES_KEY,
    NOTE_TITLES_KEY,
    TITLE_LABELS_KEY,
    LABEL_OVERRIDE_KEY,
    EVENT_BUFFERS_KEY,
    SEEN_TITLES_KEY,
    NEW_TITLES_KEY,
  ]);
  const feed = resolveFeedRoles(stored[FEEDS_KEY], stored[ROLES_KEY]).find((f) => f.id === feedId);
  if (!feed) return { ok: false, error: "unknown_feed" };

  // THE ROLE GATE. PRIVACY.md promises the extension reads only the feeds the
  // user configured it to read, and this worker enforces that itself rather than
  // trusting whoever sent the message — otherwise one stray message would read an
  // OFF feed's event titles.
  //
  // No deadlock for the legitimate caller: the options page awaits setFeedRole
  // (which persists a non-OFF role) BEFORE it asks for titles, so by the time
  // this runs the feed the user just switched on is already non-OFF.
  if (feed.role === "OFF") return { ok: false, error: "feed_off" };

  // Echo back the FULL persisted three-way state for this feed, so the picker
  // restores every Block/Note/label — including titles whose events fall outside
  // the sampling window and so never appear as rows. The picker seeds its
  // authoritative sets from these and re-sends them whole, which is what keeps an
  // off-sample block title from being silently dropped on the next save (that
  // would weaken blocking — see options.js).
  const blockTitles = Array.isArray((stored[BLOCK_TITLES_KEY] || {})[feedId])
    ? stored[BLOCK_TITLES_KEY][feedId]
    : [];
  const noteTitles = Array.isArray((stored[NOTE_TITLES_KEY] || {})[feedId])
    ? stored[NOTE_TITLES_KEY][feedId]
    : [];
  const rawLabels = (stored[TITLE_LABELS_KEY] || {})[feedId];
  const titleLabels = rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)
    ? rawLabels
    : {};
  const calLabel = typeof (stored[LABEL_OVERRIDE_KEY] || {})[feedId] === "string"
    ? stored[LABEL_OVERRIDE_KEY][feedId]
    : "";
  const rawEventBuffers = (stored[EVENT_BUFFERS_KEY] || {})[feedId];
  const eventBuffers =
    rawEventBuffers && typeof rawEventBuffers === "object" && !Array.isArray(rawEventBuffers)
      ? rawEventBuffers
      : {};

  try {
    const parsed = await getIcsEvents(
      feed,
      nyMidnightRfc3339(win.start, 0),
      nyMidnightRfc3339(win.end, 1) // +1 day: exclusive upper bound
    );
    const titles = summarizeTitles(parsed.events);
    dlog("listFeedTitles", parsed.events.length, titles.length);

    // isNew, computed against the state as it stands BEFORE the mark-seen
    // write below — see the doc comment above for why the order is load-bearing.
    const seenMap = stored[SEEN_TITLES_KEY] || {};
    const hadSeen = Object.prototype.hasOwnProperty.call(seenMap, feedId);
    const currentTitleStrings = titles.map((t) => t.title);
    const newSet = hadSeen
      ? new Set(
          newTitlesForFeed(currentTitleStrings, seenMap[feedId], blockTitles, noteTitles)
            .map((t) => normalizeTitleWhitespace(t).trim())
        )
      : new Set(); // never reviewed before — nothing to honestly call "new" yet
    const titledOut = titles.map((t) => ({
      ...t,
      isNew: newSet.has(normalizeTitleWhitespace(t.title).trim()),
    }));

    // Mark reviewed: this feed's baseline becomes the set the user is looking
    // at right now, and any pending nudge for it is cleared.
    const nextSeenMap = { ...seenMap, [feedId]: currentTitleStrings };
    const nextNewTitlesByFeed = { ...(stored[NEW_TITLES_KEY] || {}) };
    delete nextNewTitlesByFeed[feedId];
    await chrome.storage.local.set({
      [SEEN_TITLES_KEY]: nextSeenMap,
      [NEW_TITLES_KEY]: nextNewTitlesByFeed,
    });

    return {
      ok: true,
      titles: titledOut,
      // Per-event skips surface HERE too: a title the parser could not expand is
      // a title the user cannot tick, and they must be told rather than left
      // wondering why a known commitment never appears in the picker.
      warnings: parsed.warnings,
      blockTitles,
      noteTitles,
      titleLabels,
      calLabel,
      eventBuffers,
    };
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
  const calendarId = msgFeedId(msg);
  if (!calendarId) return { ok: false, error: "bad_feed_id" };
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

// Trim, drop empties, and dedupe an incoming title array. Non-strings are
// discarded rather than coerced — the array is user data off the wire.
function cleanTitleArray(arr) {
  const out = [];
  for (const t of arr) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Persist the WHOLE three-way picker state for one calendar in a single write.
 *
 * -> { type:"setEventRules", calendarId, block:string[], note:string[],
 *      labels:{ [title]:shortLabel }, calLabel:string,
 *      eventBuffers?:{ [title]:{before:number, after:number} } }
 * <- { ok:true } | { ok:false, error }
 *
 * This is the ONLY handler the rebuilt picker uses. It writes all five
 * per-calendar keys atomically (block set, note set, per-event labels, the
 * calendar short name, per-event rest-buffer overrides) in one
 * chrome.storage.local.set, so there are no per-checkbox races: whatever the
 * caller last sent is exactly what is stored. The legacy setBlockTitles
 * handler stays in place for its existing tests, but the UI no longer calls it.
 *
 * Every field is validated and cleaned: block/note must be arrays (trimmed,
 * de-duped, empties dropped); labels must be a plain object (empty titles and
 * empty labels dropped, both sides trimmed); calLabel is trimmed, and an empty
 * one REMOVES the override rather than storing "". eventBuffers, when present,
 * must be a plain object; each entry's title is trimmed (empty titles
 * dropped) and its before/after coerced with the same non-negative
 * finite/2-decimal rule as setCalendarBuffer — an entry with either side
 * invalid is dropped rather than partially stored. eventBuffers is OPTIONAL:
 * an absent field leaves the calendar's stored overrides untouched, but a
 * present field (including {}) REPLACES them wholesale, mirroring how
 * block/note/labels already work.
 *
 * Drops the cache for the same reason the other mutators do: a cache bucketed
 * under the old rules would keep applying blocks/notes/buffers the user just
 * changed.
 */
async function handleSetEventRules(msg) {
  const calendarId = msgFeedId(msg);
  if (!calendarId) return { ok: false, error: "bad_feed_id" };
  if (!Array.isArray(msg.block)) return { ok: false, error: "bad_block" };
  if (!Array.isArray(msg.note)) return { ok: false, error: "bad_note" };
  if (!msg.labels || typeof msg.labels !== "object" || Array.isArray(msg.labels)) {
    return { ok: false, error: "bad_labels" };
  }
  const hasEventBuffers = Object.prototype.hasOwnProperty.call(msg, "eventBuffers");
  if (
    hasEventBuffers &&
    (!msg.eventBuffers || typeof msg.eventBuffers !== "object" || Array.isArray(msg.eventBuffers))
  ) {
    return { ok: false, error: "bad_event_buffers" };
  }

  const block = cleanTitleArray(msg.block);
  const note = cleanTitleArray(msg.note);
  const labels = {};
  for (const [k, v] of Object.entries(msg.labels)) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    const kk = k.trim();
    const vv = v.trim();
    if (kk !== "" && vv !== "") labels[kk] = vv;
  }
  const calLabel = typeof msg.calLabel === "string" ? msg.calLabel.trim() : "";

  let newEventBuffers = null;
  if (hasEventBuffers) {
    newEventBuffers = {};
    for (const [k, v] of Object.entries(msg.eventBuffers)) {
      if (typeof k !== "string") continue;
      const kk = k.trim();
      if (kk === "" || !v || typeof v !== "object") continue;
      const before = coerceBufferHours(v.before);
      const after = coerceBufferHours(v.after);
      if (before === null || after === null) continue;
      newEventBuffers[kk] = { before, after };
    }
  }

  const cur = await chrome.storage.local.get([
    BLOCK_TITLES_KEY,
    NOTE_TITLES_KEY,
    TITLE_LABELS_KEY,
    LABEL_OVERRIDE_KEY,
    EVENT_BUFFERS_KEY,
  ]);
  const blockMap = cur[BLOCK_TITLES_KEY] || {};
  const noteMap = cur[NOTE_TITLES_KEY] || {};
  const labelMap = cur[TITLE_LABELS_KEY] || {};
  const overrideMap = cur[LABEL_OVERRIDE_KEY] || {};
  const eventBufferMap = cur[EVENT_BUFFERS_KEY] || {};

  blockMap[calendarId] = block;
  noteMap[calendarId] = note;
  labelMap[calendarId] = labels;
  if (calLabel) overrideMap[calendarId] = calLabel;
  else delete overrideMap[calendarId];
  if (newEventBuffers !== null) eventBufferMap[calendarId] = newEventBuffers;

  await chrome.storage.local.set({
    [BLOCK_TITLES_KEY]: blockMap,
    [NOTE_TITLES_KEY]: noteMap,
    [TITLE_LABELS_KEY]: labelMap,
    [LABEL_OVERRIDE_KEY]: overrideMap,
    [EVENT_BUFFERS_KEY]: eventBufferMap,
  });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Feed management (add / remove / re-upload)
// ---------------------------------------------------------------------------

/**
 * Validate a candidate feed by ACTUALLY READING IT, over a sampling window
 * around today, and report back what the calendar calls itself.
 *
 * Adding is the one moment the user is looking straight at the field they just
 * filled in, so it is the right place to fail: a link that 404s, that needs a
 * host permission they declined, or that answers with a login page is refused
 * HERE. The alternative — storing it and discovering the problem at the next
 * refresh — surfaces as a board that simply looks empty.
 */
async function probeFeed(feed) {
  const win = titleSampleWindow();
  try {
    const parsed = await getIcsEvents(
      feed,
      nyMidnightRfc3339(win.start, 0),
      nyMidnightRfc3339(win.end, 1) // +1 day: exclusive upper bound
    );
    return { ok: true, calName: parsed.calName || "", tz: parsed.tz || "" };
  } catch (e) {
    return errorResponse(e);
  }
}

// The user's own name for a feed wins; an unnamed feed falls back to what the
// calendar calls itself (X-WR-CALNAME), then to a neutral placeholder. Never the
// URL — that is the credential.
function cleanFeedName(name, calName) {
  const n = typeof name === "string" ? name.trim() : "";
  if (n) return n;
  const c = typeof calName === "string" ? calName.trim() : "";
  return c || "Untitled feed";
}

async function storeNewFeed(feed, role) {
  const store = await chrome.storage.local.get([FEEDS_KEY, ROLES_KEY]);
  const feeds = Array.isArray(store[FEEDS_KEY]) ? store[FEEDS_KEY] : [];
  const roles = store[ROLES_KEY] || {};
  const id = newFeedId();
  feeds.push({ id, addedAt: Date.now(), syncedAt: Date.now(), ...feed });
  roles[id] = role;
  await chrome.storage.local.set({ [FEEDS_KEY]: feeds, [ROLES_KEY]: roles });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true, feedId: id };
}

/**
 * Add a subscription-URL feed.
 *
 * The host permission for the URL's origin must already have been granted —
 * chrome.permissions.request() only works from a user gesture in the options
 * page, so the panel asks first and then sends this. A declined permission shows
 * up here as an ordinary unreachable-feed error, which is exactly right: either
 * way we cannot read it, and either way the user must be told.
 *
 * -> { type:"addFeedUrl", url, name, role }
 * <- { ok:true, feedId } | { ok:false, error }
 */
async function handleAddFeedUrl(msg) {
  const url = normalizeFeedUrl(msg && msg.url);
  if (!url) return { ok: false, error: "bad_url" };
  const role = ROLES.includes(msg && msg.role) ? msg.role : defaultRole(null);
  const probe = await probeFeed({ kind: "url", url });
  if (!probe.ok) return probe;
  return storeNewFeed(
    { kind: "url", url, name: cleanFeedName(msg && msg.name, probe.calName), calName: probe.calName, tz: probe.tz },
    role
  );
}

/**
 * Add a feed from .ics text the options page read off the user's disk. No
 * network and no host permission at all: the bytes are already in hand, which is
 * also how a provider that refuses cross-origin reads can still be used.
 *
 * -> { type:"addFeedFile", content, name, role }
 * <- { ok:true, feedId } | { ok:false, error }
 */
async function handleAddFeedFile(msg) {
  const content = typeof (msg && msg.content) === "string" ? msg.content : "";
  if (content.trim() === "") return { ok: false, error: "empty_file" };
  const role = ROLES.includes(msg && msg.role) ? msg.role : defaultRole(null);
  const probe = await probeFeed({ kind: "file", content });
  if (!probe.ok) return probe;
  return storeNewFeed(
    { kind: "file", content, name: cleanFeedName(msg && msg.name, probe.calName), calName: probe.calName, tz: probe.tz },
    role
  );
}

// Every per-feed map, so removal can clear all of them in one pass.
const PER_FEED_KEYS = [
  ROLES_KEY, BLOCK_TITLES_KEY, NOTE_TITLES_KEY, TITLE_LABELS_KEY,
  LABEL_OVERRIDE_KEY, BLOCK_LABEL_KEY, BUFFER_BEFORE_KEY, BUFFER_AFTER_KEY,
  EVENT_BUFFERS_KEY,
];

/**
 * Remove a feed and EVERY per-feed key that referenced it. Leaving the config
 * behind would accumulate orphaned block lists, labels and buffers that no UI
 * can reach and no user can audit — and a stored REJECT role for a feed that no
 * longer exists is exactly the kind of invisible state this codebase avoids.
 *
 * -> { type:"removeFeed", feedId }
 */
async function handleRemoveFeed(msg) {
  const feedId = msgFeedId(msg);
  if (!feedId) return { ok: false, error: "bad_feed_id" };
  const store = await chrome.storage.local.get([FEEDS_KEY, ...PER_FEED_KEYS]);
  const write = {
    [FEEDS_KEY]: (Array.isArray(store[FEEDS_KEY]) ? store[FEEDS_KEY] : []).filter(
      (f) => !(f && f.id === feedId)
    ),
  };
  for (const key of PER_FEED_KEYS) {
    const map = store[key];
    if (map && typeof map === "object" && !Array.isArray(map) && feedId in map) {
      delete map[feedId];
      write[key] = map;
    }
  }
  await chrome.storage.local.set(write);
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

/**
 * Replace a file feed's stored snapshot with freshly uploaded text. A file feed
 * is static by definition, so this is the only way it ever changes — the panel
 * labels it that way rather than showing a sync age that would imply otherwise.
 *
 * -> { type:"reuploadFile", feedId, content }
 */
async function handleReuploadFile(msg) {
  const feedId = msgFeedId(msg);
  const content = typeof (msg && msg.content) === "string" ? msg.content : "";
  if (!feedId) return { ok: false, error: "bad_feed_id" };
  if (content.trim() === "") return { ok: false, error: "empty_file" };
  const probe = await probeFeed({ kind: "file", content });
  if (!probe.ok) return probe;

  const feeds = (await chrome.storage.local.get(FEEDS_KEY))[FEEDS_KEY];
  const feed = Array.isArray(feeds) ? feeds.find((f) => f && f.id === feedId) : null;
  if (!feed) return { ok: false, error: "unknown_feed" };
  feed.content = content;
  if (probe.calName) feed.calName = probe.calName;
  if (probe.tz) feed.tz = probe.tz;
  feed.syncedAt = Date.now();
  await chrome.storage.local.set({ [FEEDS_KEY]: feeds });
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
  // The content script's contract — unchanged by the source swap.
  getCalendarData: handleGetCalendarData,
  openOptions: handleOpenOptions,
  // Feed management (options page).
  listFeeds: handleListFeeds,
  listFeedTitles: handleListFeedTitles,
  addFeedUrl: handleAddFeedUrl,
  addFeedFile: handleAddFeedFile,
  removeFeed: handleRemoveFeed,
  reuploadFile: handleReuploadFile,
  // Per-feed configuration (keyed by feed id; see msgFeedId).
  setFeedRole: handleSetFeedRole,
  setCalendarRole: handleSetFeedRole, // compatibility alias — same handler
  setFeedBlockLabel: handleSetFeedBlockLabel,
  setCalendarBuffer: handleSetCalendarBuffer,
  setBlockTitles: handleSetBlockTitles,
  setEventRules: handleSetEventRules,
  setRuleFilter: handleSetRuleFilter,
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
