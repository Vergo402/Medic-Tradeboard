/**
 * MV3 service worker (ESM module — manifest declares "type": "module").
 *
 * Purpose: on request from the content script, produce two triplet lists for
 * the scoring engine in NY-local "YYYY-MM-DD HH:MM" string form:
 *   - commitments: hard conflicts — every event of a REJECT calendar, plus the
 *     events of a RULE calendar whose title passes the user's rule regex.
 *   - soft: annotations — every event of a FLAG calendar, plus the events of a
 *     RULE calendar whose title FAILS that regex.
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
 *     events request, so their contents never reach this extension. Every
 *     calendar except the signed-in account's own primary starts OFF.
 *
 * ALL chrome.* references live inside function/listener bodies (the sole
 * top-level touch is the typeof-guarded addListener at the bottom) so a bare
 * `import` of this module in Node — for offline unit tests of the pure helpers
 * — succeeds without a chrome global.
 */

import { toEpoch, civilFromEpoch, addDays } from "./core/nytime.js";

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

/**
 * The role a calendar takes when the user has never picked one for it.
 *
 * The cascade is deliberately minimal, because for a freshly-installed user we
 * know nothing about which calendars represent real commitments:
 *
 *   - NO default may produce a hard REJECT. A wrong reject silently hides a
 *     shift the user was actually free to take, and we would be guessing. Hard
 *     rejects are opt-in, always.
 *   - The signed-in account's own primary calendar defaults to FLAG. It is the
 *     one calendar we can be sure belongs to the user, so annotating shifts
 *     with it gives immediate value on first run while blocking nothing.
 *   - Everything else defaults to OFF, so no other calendar — shared, family,
 *     subscribed holidays, a coworker's — is even fetched until the user opts
 *     in. Least data leaves Google by default.
 *
 * RULE is never a default: its protection only exists once the user has written
 * a regex describing their own title convention, so defaulting to it would buy
 * no safety over FLAG while implying a rule that isn't really configured.
 *
 * @param {{id:string, summary?:string, primary?:boolean}} item
 * @returns {string} one of ROLES
 */
export function defaultRole(item) {
  if (!item) return "OFF";
  if (item.primary === true) return "FLAG";
  return "OFF";
}

/**
 * Attach the effective role and label prefix to each calendarList item. The
 * stored map is sparse and may have been hand-edited, so an entry that isn't a
 * known role falls back to defaultRole.
 *
 * Primary gets an empty prefix because Google returns the account email as its
 * summary — unusable as a label, and an address we should not be rendering.
 *
 * @param {object[]} items  calendarList items (id, summary, primary)
 * @param {object} storedRoles  the calRoles map (may be undefined/sparse)
 * @returns {Array<{id:string, summary:string, primary:boolean, role:string, prefix:string}>}
 *          primary first, then case-insensitive alpha by summary
 */
export function resolveRoles(items, storedRoles) {
  const roles = storedRoles || {};
  const out = (items || []).map((it) => {
    const summary = it.summary || "";
    const primary = it.primary === true;
    const stored = roles[it.id];
    return {
      id: it.id,
      summary,
      primary,
      role: ROLES.includes(stored) ? stored : defaultRole(it),
      prefix: primary ? "" : summary,
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

async function loadConfig() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const { includeRe, warnings } = resolveIncludeRegex(cfg.ruleInclude);
  return { includeRe, excludes: parseExcludes(cfg.ruleExclude), warnings };
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
  const fields = "items(id,summary,primary),nextPageToken";
  do {
    let url = `${CAL_BASE}/users/me/calendarList?maxResults=250&fields=${encodeURIComponent(fields)}`;
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

  const stored = (await chrome.storage.local.get(ROLES_KEY))[ROLES_KEY];
  const cals = resolveRoles(calItems, stored);

  const timeMin = nyMidnightRfc3339(windowStart, 0);
  const timeMax = nyMidnightRfc3339(windowEnd, 1); // +1 day: exclusive upper bound

  const commitments = [];
  const soft = [];
  const rule = (title) => ruleMatches(title, cfg.includeRe, cfg.excludes);

  try {
    for (const cal of cals) {
      if (cal.role === "OFF") continue; // never fetched — no request is made at all
      const evs = await listEvents(holder, cal.id, timeMin, timeMax);
      const b = bucketEvents(evs, cal.role, rule, cal.prefix);
      commitments.push(...b.commitments);
      soft.push(...b.soft);
      dlog("calendar events", cal.role, evs.length);
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

  const store = await chrome.storage.local.get([ROLES_KEY, "ruleInclude", "ruleExclude"]);
  const calendars = resolveRoles(calItems, store[ROLES_KEY]).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary,
    role: c.role,
  }));

  return {
    ok: true,
    calendars,
    ruleFilter: {
      include: typeof store.ruleInclude === "string" ? store.ruleInclude : DEFAULTS.ruleInclude,
      exclude: typeof store.ruleExclude === "string" ? store.ruleExclude : DEFAULTS.ruleExclude,
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
  await chrome.storage.local.set({ ruleInclude: include, ruleExclude: exclude });
  await chrome.storage.local.remove(CACHE_KEY);
  return { ok: true };
}

const HANDLERS = {
  getCalendarData: handleGetCalendarData,
  listCalendars: handleListCalendars,
  setCalendarRole: handleSetCalendarRole,
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
