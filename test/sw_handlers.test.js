/**
 * Service-worker MESSAGE HANDLER tests.
 *
 * sw.test.js covers the pure helpers. This file covers the handlers themselves —
 * the layer where a calendar is actually fetched or not fetched — by installing
 * a fake `chrome` and a fake `fetch` BEFORE importing sw.js, then driving the
 * real chrome.runtime.onMessage listener the worker registers.
 *
 * node:test runs each test file in its own process, so mutating globalThis here
 * cannot leak into sw.test.js.
 *
 * Everything below is synthetic. This repo is public and its history permanent:
 * no real calendar id, calendar name, event title, or person's name.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Fakes — installed before the import of sw.js below
// ---------------------------------------------------------------------------

let STORE = {}; // chrome.storage.local contents
let EVENTS = {}; // feedId -> events[] (declared normalized, served as .ics)
let FEED_BODIES = {}; // feedId -> raw .ics text, when a test wants to control it
let URL_TO_ID = {}; // feed URL -> feedId, for the fake fetch
let FETCH_LOG = []; // every URL the worker requested, in order

function reset() {
  STORE = {};
  EVENTS = {};
  FEED_BODIES = {};
  URL_TO_ID = {};
  FETCH_LOG = [];
}

// chrome.storage.local.get accepts a string, an array of keys, or an object of
// defaults. sw.js uses all three shapes, so the fake has to honour all three.
function storageGet(keys) {
  if (typeof keys === "string") {
    return Object.prototype.hasOwnProperty.call(STORE, keys) ? { [keys]: STORE[keys] } : {};
  }
  if (Array.isArray(keys)) {
    const out = {};
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(STORE, k)) out[k] = STORE[k];
    }
    return out;
  }
  const out = { ...(keys || {}) };
  for (const k of Object.keys(keys || {})) {
    if (Object.prototype.hasOwnProperty.call(STORE, k)) out[k] = STORE[k];
  }
  return out;
}

const listeners = [];

// No chrome.identity: there is no auth anywhere in this extension any more.
globalThis.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => listeners.push(fn) },
  },
  storage: {
    local: {
      get: async (keys) => storageGet(keys),
      set: async (obj) => {
        Object.assign(STORE, obj);
      },
      remove: async (key) => {
        for (const k of Array.isArray(key) ? key : [key]) delete STORE[k];
      },
    },
  },
};

const FEED_HOST = "https://feeds.example.com";
const feedUrlFor = (id) => `${FEED_HOST}/${id}.ics`;

// "2026-08-04T08:00:00-04:00" -> "20260804T120000Z" (iCalendar UTC basic form).
function icsStamp(isoish) {
  return new Date(isoish).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Serialize the normalized fixtures these tests already declare into a real
 * .ics body. The worker then parses them back through core/ics.js, so every
 * handler test exercises the actual feed path end to end rather than a stub.
 */
function icsFrom(events) {
  const body = (events || [])
    .map((ev, i) => {
      const lines = [`UID:synthetic-${i}@example.com`, `SUMMARY:${ev.summary || ""}`];
      if (ev.status === "cancelled") lines.push("STATUS:CANCELLED");
      if (ev.start && ev.start.date) {
        lines.push(`DTSTART;VALUE=DATE:${ev.start.date.replace(/-/g, "")}`);
        if (ev.end && ev.end.date) lines.push(`DTEND;VALUE=DATE:${ev.end.date.replace(/-/g, "")}`);
      } else {
        lines.push(`DTSTART:${icsStamp(ev.start.dateTime)}`);
        if (ev.end && ev.end.dateTime) lines.push(`DTEND:${icsStamp(ev.end.dateTime)}`);
      }
      return `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT`;
    })
    .join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nX-WR-TIMEZONE:America/New_York\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

/**
 * Declare the user's configured feeds. Each spec is { id, name, role?, kind? };
 * a role is written into calRoles exactly as the options page would.
 */
function setFeeds(specs) {
  STORE.feeds = specs.map((s) => {
    const base = { id: s.id, name: s.name || s.id, kind: s.kind || "url" };
    if (base.kind === "file") base.content = s.content !== undefined ? s.content : icsFrom(EVENTS[s.id] || []);
    else base.url = feedUrlFor(s.id);
    URL_TO_ID[feedUrlFor(s.id)] = s.id;
    return base;
  });
  const roles = STORE.calRoles || {};
  for (const s of specs) if (s.role) roles[s.id] = s.role;
  STORE.calRoles = roles;
}

globalThis.fetch = async (url) => {
  FETCH_LOG.push(url);
  const id = URL_TO_ID[url];
  if (!id) throw new Error("unexpected fetch: " + url);
  if (Object.prototype.hasOwnProperty.call(FEED_BODIES, id)) {
    const body = FEED_BODIES[id];
    if (body === null) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  }
  return { ok: true, status: 200, text: async () => icsFrom(EVENTS[id] || []) };
};

// Import AFTER the globals exist — sw.js registers its listener at module load.
const sw = await import("../sw.js");
assert.equal(listeners.length, 1, "sw.js should register exactly one message listener");
const onMessage = listeners[0];

/** Drive the real handler the same way chrome.runtime.sendMessage would. */
function send(msg) {
  return new Promise((resolve, reject) => {
    const kept = onMessage(msg, {}, resolve);
    if (kept !== true) reject(new Error("handler did not keep the channel open: " + msg.type));
  });
}

const eventsFetchedFor = (feedId) => FETCH_LOG.filter((u) => u === feedUrlFor(feedId));

function timed(summary, day) {
  return {
    summary,
    start: { dateTime: `2026-08-${day}T08:00:00-04:00` },
    end: { dateTime: `2026-08-${day}T18:00:00-04:00` },
  };
}

const WINDOW = { windowStart: "2026-08-01", windowEnd: "2026-08-31" };

// ---------------------------------------------------------------------------
// #2 — a feed that cannot be read must never look like a feed with no events
//
// A feed URL that 404s, expires, or answers with a login page must not degrade
// to "no events" — if that happened every shift on the board would render as
// free. A blocking-capable feed fails the whole refresh loudly; only notes-only
// feeds are allowed to degrade gracefully.
// ---------------------------------------------------------------------------

test("listFeeds: returns the configured feeds with their stored roles", async () => {
  reset();
  setFeeds([
    { id: "feed-fd", name: "Crew Schedule", role: "REJECT" },
    { id: "feed-b", name: "Household" },
  ]);

  const resp = await send({ type: "listFeeds" });
  assert.equal(resp.ok, true);
  assert.equal(resp.feeds.find((f) => f.id === "feed-fd").role, "REJECT");
  assert.equal(resp.feeds.find((f) => f.id === "feed-b").role, "OFF");
});

test("listFeeds: never returns the feed URL, only its host", async () => {
  reset();
  setFeeds([{ id: "feed-a", name: "Crew Schedule", role: "REJECT" }]);
  const resp = await send({ type: "listFeeds" });
  assert.equal(resp.feeds[0].source, "feeds.example.com/…");
  assert.equal(
    JSON.stringify(resp.feeds).includes("feed-a.ics"),
    false,
    "the feed URL must never reach the panel"
  );
});

test("listFeeds: needs no network at all", async () => {
  reset();
  setFeeds([{ id: "feed-a", name: "Crew Schedule", role: "REJECT" }]);
  await send({ type: "listFeeds" });
  assert.deepEqual(FETCH_LOG, [], "listing configured feeds must not fetch them");
});

test("getCalendarData: a REJECT feed that fails to load FAILS the refresh, loudly", async () => {
  reset();
  setFeeds([{ id: "feed-fd", name: "Crew Schedule", role: "REJECT" }]);
  FEED_BODIES["feed-fd"] = null; // 404

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, false, "a blocking feed that did not load must not yield a scored board");
  assert.match(resp.error, /feed_failed/);
  assert.match(resp.error, /Crew Schedule/, "the error has to name the feed, or it is not fixable");
});

test("getCalendarData: a feed answering with HTML is an error, never an empty calendar", async () => {
  reset();
  setFeeds([{ id: "feed-fd", name: "Crew Schedule", role: "REJECT" }]);
  // An expired secret link or a captive portal answers with a login page.
  FEED_BODIES["feed-fd"] = "<html><body>Sign in to continue</body></html>";

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, false);
  assert.match(resp.error, /feed_failed/);
});

test("getCalendarData: a FLAG feed that fails only warns — notes are cosmetic", async () => {
  reset();
  setFeeds([
    { id: "feed-note", name: "Family", role: "FLAG" },
    { id: "feed-fd", name: "Crew Schedule", role: "REJECT" },
  ]);
  FEED_BODIES["feed-note"] = null; // 404
  EVENTS["feed-fd"] = [timed("Night Tour", "15")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true, "losing notes must not cost the user their scoring");
  assert.equal(resp.commitments.length, 1);
  assert.ok(
    resp.warnings.some((w) => w.includes("Family")),
    "the failure still has to be visible: " + JSON.stringify(resp.warnings)
  );
});

test("getCalendarData: a REJECT feed blocks, end to end through the real .ics path", async () => {
  reset();
  setFeeds([{ id: "feed-fd", name: "Crew Schedule", role: "REJECT" }]);
  EVENTS["feed-fd"] = [timed("Night Tour", "15")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.equal(eventsFetchedFor("feed-fd").length, 1);
  assert.equal(resp.commitments.length, 1);
  // A REJECT commitment's triplet label is "" (no per-event override), so the
  // reject chip falls back to the user's global commitment label.
  assert.equal(resp.commitments[0][2], "");
});

test("getCalendarData: an uploaded file feed blocks without touching the network", async () => {
  reset();
  EVENTS["feed-up"] = [timed("Night Tour", "15")];
  setFeeds([{ id: "feed-up", name: "Uploaded", role: "REJECT", kind: "file" }]);

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.equal(resp.commitments.length, 1);
  assert.deepEqual(FETCH_LOG, [], "a file feed must never hit the network");
});

test("getCalendarData: a recurring commitment expands and blocks every occurrence", async () => {
  reset();
  setFeeds([{ id: "feed-fd", name: "Crew Schedule", role: "REJECT" }]);
  // Raw RRULE, as published by calendar feeds.
  FEED_BODIES["feed-fd"] =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n" +
    "BEGIN:VEVENT\r\nUID:r1\r\nSUMMARY:Night Tour\r\n" +
    "DTSTART;TZID=America/New_York:20260804T080000\r\n" +
    "DTEND;TZID=America/New_York:20260804T180000\r\n" +
    "RRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.deepEqual(
    resp.commitments.map((c) => c[0]),
    ["2026-08-04 08:00", "2026-08-11 08:00", "2026-08-18 08:00"],
    "an unexpanded recurrence would leave two of these three tours looking free"
  );
});

// ---------------------------------------------------------------------------
// #1 — an empty ticked list blocks NOTHING, end to end through the handler
// ---------------------------------------------------------------------------

test("getCalendarData: a RULE calendar with [] ticked produces ZERO commitments", async () => {
  reset();
  setFeeds([{ id: "cal-r", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-r": "RULE" };
  STORE.calBlockTitles = { "cal-r": [] }; // the user un-ticked everything
  EVENTS["cal-r"] = [timed("Work day", "10"), timed("Work from home", "11")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.equal(
    resp.commitments.length,
    0,
    'the leaked default "^Work\\b" must not hard-reject an untouched RULE calendar'
  );
  // With no note titles configured, the unmarked events are ignored (dropped),
  // not noted — the deliberate default. The safety point is zero commitments.
  assert.equal(resp.soft.length, 0);
});

test("getCalendarData: an absent calBlockTitles entry also blocks nothing", async () => {
  reset();
  setFeeds([{ id: "cal-r", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-r": "RULE" };
  EVENTS["cal-r"] = [timed("Work day", "10")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.commitments.length, 0);
  // Nothing configured ⇒ nothing blocks AND nothing notes: the event is ignored.
  assert.equal(resp.soft.length, 0);
});

test("getCalendarData: the pattern hatch blocks only once explicitly armed", async () => {
  reset();
  setFeeds([{ id: "cal-r", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-r": "RULE" };
  STORE.calBlockTitles = { "cal-r": [] };
  STORE.ruleInclude = "^Work\\b";
  STORE.ruleUsePattern = true;
  EVENTS["cal-r"] = [timed("Work day", "10"), timed("Dentist", "11")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  // With the pattern hatch armed, Work day matches the regex and BLOCKS (its
  // triplet label is "" — the reject chip uses the global commitment label).
  // Dentist matches neither the regex nor any note title, so it is ignored.
  assert.deepEqual(
    resp.commitments.map((r) => r[2]),
    [""]
  );
  assert.deepEqual(resp.soft.map((r) => r[2]), []);
});

test("setRuleFilter: saving a pattern arms the opt-in flag in the same write", async () => {
  reset();
  const resp = await send({ type: "setRuleFilter", include: "^On[- ]?Duty\\b", exclude: "" });
  assert.equal(resp.ok, true);
  assert.equal(STORE.ruleInclude, "^On[- ]?Duty\\b");
  assert.equal(STORE.ruleUsePattern, true, "a stored pattern nobody armed would be inert config");
});

test("setRuleFilter: a blank or invalid pattern is refused and arms nothing", async () => {
  reset();
  assert.deepEqual(await send({ type: "setRuleFilter", include: "  ", exclude: "" }), {
    ok: false,
    error: "empty_include",
  });
  assert.deepEqual(await send({ type: "setRuleFilter", include: "Work(", exclude: "" }), {
    ok: false,
    error: "bad_regex",
  });
  assert.equal(STORE.ruleUsePattern, undefined);
  assert.equal(STORE.ruleInclude, undefined);
});

// ---------------------------------------------------------------------------
// setEventRules — the atomic three-way write the rebuilt picker uses
// ---------------------------------------------------------------------------

test("setEventRules: writes all four per-calendar keys in one shot", async () => {
  reset();
  const resp = await send({
    type: "setEventRules",
    feedId: "cal-1",
    block: ["Crew - Desk"],
    note: ["Music Class"],
    labels: { "Crew - Desk": "Desk", "Music Class": "Music" },
    calLabel: "Fam",
  });
  assert.equal(resp.ok, true);
  assert.deepEqual(STORE.calBlockTitles, { "cal-1": ["Crew - Desk"] });
  assert.deepEqual(STORE.calNoteTitles, { "cal-1": ["Music Class"] });
  assert.deepEqual(STORE.calTitleLabels, { "cal-1": { "Crew - Desk": "Desk", "Music Class": "Music" } });
  assert.deepEqual(STORE.calLabelOverride, { "cal-1": "Fam" });
});

test("setEventRules: trims and de-dupes arrays and drops empty-string titles", async () => {
  reset();
  const resp = await send({
    type: "setEventRules",
    feedId: "cal-1",
    block: ["  Crew - Desk  ", "Crew - Desk", "", "   ", 5, null],
    note: ["Music Class", "Music Class", ""],
    labels: { "Crew - Desk": "  Desk  ", "": "x", "Music Class": "   " },
    calLabel: "  ",
  });
  assert.equal(resp.ok, true);
  assert.deepEqual(STORE.calBlockTitles["cal-1"], ["Crew - Desk"]);
  assert.deepEqual(STORE.calNoteTitles["cal-1"], ["Music Class"]);
  // Label value is trimmed; an empty-title key and an empty-value label drop.
  assert.deepEqual(STORE.calTitleLabels["cal-1"], { "Crew - Desk": "Desk" });
  // A whitespace-only calLabel is treated as empty ⇒ no override stored.
  assert.equal("cal-1" in (STORE.calLabelOverride || {}), false);
});

test("setEventRules: an empty calLabel removes a previously stored override", async () => {
  reset();
  STORE.calLabelOverride = { "cal-1": "Fam" };
  const resp = await send({
    type: "setEventRules", feedId: "cal-1", block: [], note: [], labels: {}, calLabel: "",
  });
  assert.equal(resp.ok, true);
  assert.equal("cal-1" in STORE.calLabelOverride, false);
});

test("setEventRules: bad shapes are refused and nothing is written", async () => {
  reset();
  assert.deepEqual(
    await send({ type: "setEventRules", block: [], note: [], labels: {}, calLabel: "" }),
    { ok: false, error: "bad_feed_id" }
  );
  assert.deepEqual(
    await send({ type: "setEventRules", feedId: "c", block: "nope", note: [], labels: {}, calLabel: "" }),
    { ok: false, error: "bad_block" }
  );
  assert.deepEqual(
    await send({ type: "setEventRules", feedId: "c", block: [], note: "nope", labels: {}, calLabel: "" }),
    { ok: false, error: "bad_note" }
  );
  // A non-plain-object (including an array) is not a valid labels map.
  for (const bad of [null, "x", 5, ["a"]]) {
    assert.deepEqual(
      await send({ type: "setEventRules", feedId: "c", block: [], note: [], labels: bad, calLabel: "" }),
      { ok: false, error: "bad_labels" }
    );
  }
  assert.equal(STORE.calBlockTitles, undefined);
  assert.equal(STORE.calNoteTitles, undefined);
  assert.equal(STORE.calTitleLabels, undefined);
});

test("setEventRules: merges into the maps, preserving OTHER calendars", async () => {
  reset();
  STORE.calBlockTitles = { "cal-other": ["Keep"] };
  STORE.calNoteTitles = { "cal-other": ["KeepNote"] };
  const resp = await send({
    type: "setEventRules", feedId: "cal-1", block: ["Crew - Desk"], note: [], labels: {}, calLabel: "",
  });
  assert.equal(resp.ok, true);
  assert.deepEqual(STORE.calBlockTitles["cal-other"], ["Keep"]);
  assert.deepEqual(STORE.calBlockTitles["cal-1"], ["Crew - Desk"]);
  assert.deepEqual(STORE.calNoteTitles["cal-other"], ["KeepNote"]);
});

test("setEventRules: drops the calCache so stale rules are not served", async () => {
  reset();
  STORE.calCache = {
    fetchedAt: 1, commitments: [], soft: [], windowStart: "2026-08-01", windowEnd: "2026-08-31",
  };
  await send({ type: "setEventRules", feedId: "cal-1", block: [], note: [], labels: {}, calLabel: "" });
  assert.equal(STORE.calCache, undefined);
});

// The WIRING advisor asked to pin: calLabelOverride must actually override the
// note prefix inside refreshCalendarData (override || cal.prefix), not just in
// bucketEvents. If the override were dropped the label would read
// "Crew Schedule · Music Class" instead.
test("getCalendarData: calLabelOverride prefixes the notes from a calendar", async () => {
  reset();
  setFeeds([{ id: "cal-r", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-r": "RULE" };
  STORE.calNoteTitles = { "cal-r": ["Music Class"] };
  STORE.calLabelOverride = { "cal-r": "Fam" };
  EVENTS["cal-r"] = [timed("Music Class", "10")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.soft.map((r) => r[2]), ["Fam · Music Class"]);
  assert.equal(resp.commitments.length, 0);
});

// A block title's per-event label reaches the commitment triplet end to end.
test("getCalendarData: a Block title's per-event label becomes the commitment label", async () => {
  reset();
  setFeeds([{ id: "cal-r", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-r": "RULE" };
  STORE.calBlockTitles = { "cal-r": ["Crew - Desk"] };
  STORE.calTitleLabels = { "cal-r": { "Crew - Desk": "Desk" } };
  EVENTS["cal-r"] = [timed("Crew - Desk", "10")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.commitments.map((r) => r[2]), ["Desk"]);
});

test("listFeedTitles: echoes back the full three-way state for restore", async () => {
  reset();
  setFeeds([{ id: "cal-on", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-on": "RULE" };
  STORE.calBlockTitles = { "cal-on": ["Crew - Desk"] };
  STORE.calNoteTitles = { "cal-on": ["Music Class"] };
  STORE.calTitleLabels = { "cal-on": { "Crew - Desk": "Desk" } };
  STORE.calLabelOverride = { "cal-on": "Fam" };
  EVENTS["cal-on"] = [timed("Crew - Desk", "10")];

  const resp = await send({ type: "listFeedTitles", feedId: "cal-on" });
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.blockTitles, ["Crew - Desk"]);
  assert.deepEqual(resp.noteTitles, ["Music Class"]);
  assert.deepEqual(resp.titleLabels, { "Crew - Desk": "Desk" });
  assert.equal(resp.calLabel, "Fam");
});

// ---------------------------------------------------------------------------
// #4 — listCalendarTitles must enforce the extension's own read promise
//
// PRIVACY.md: the extension reads only "the calendars you've configured it to
// read". This handler fetches events, so it has to check the stored role itself
// rather than trusting whoever sent the message — it previously resolved roles
// against an EMPTY map and then read whatever calendarId it was handed.
// ---------------------------------------------------------------------------

test("listFeedTitles: an OFF calendar is refused and never read", async () => {
  reset();
  setFeeds([{ id: "cal-private", name: "Personal" }]); // no stored role ⇒ OFF
  EVENTS["cal-private"] = [timed("Therapy", "12")];

  const resp = await send({ type: "listFeedTitles", feedId: "cal-private" });
  assert.equal(resp.ok, false);
  assert.equal(resp.error, "feed_off");
  assert.equal(
    eventsFetchedFor("cal-private").length,
    0,
    "an OFF feed's events must never be fetched"
  );
  assert.equal(resp.titles, undefined);
});

test("listFeedTitles: an explicitly OFF calendar is refused too", async () => {
  reset();
  setFeeds([{ id: "cal-off", name: "Personal" }]);
  STORE.calRoles = { "cal-off": "OFF" };
  EVENTS["cal-off"] = [timed("Therapy", "12")];

  const resp = await send({ type: "listFeedTitles", feedId: "cal-off" });
  assert.equal(resp.error, "feed_off");
  assert.equal(eventsFetchedFor("cal-off").length, 0);
});

test("listFeedTitles: a switched-on calendar is read normally", async () => {
  reset();
  setFeeds([{ id: "cal-on", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-on": "RULE" };
  STORE.calBlockTitles = { "cal-on": ["ACME - Desk"] };
  EVENTS["cal-on"] = [timed("ACME - Desk", "10"), timed("ACME - Desk", "12")];

  const resp = await send({ type: "listFeedTitles", feedId: "cal-on" });
  assert.equal(resp.ok, true);
  assert.deepEqual(
    resp.titles.map((t) => [t.title, t.count]),
    [["ACME - Desk", 2]]
  );
  assert.deepEqual(resp.blockTitles, ["ACME - Desk"]);
});

// The legitimate flow the gate must not deadlock: the options page toggles a
// calendar ON and asks for its titles immediately afterwards. It awaits
// setCalendarRole first, so the role is already persisted when this runs.
test("listFeedTitles: works immediately after setCalendarRole turns a calendar on", async () => {
  reset();
  setFeeds([{ id: "cal-new", name: "Crew Schedule" }]);
  EVENTS["cal-new"] = [timed("Night Tour", "10")];

  const set = await send({ type: "setCalendarRole", feedId: "cal-new", role: "FLAG" });
  assert.equal(set.ok, true);

  const resp = await send({ type: "listFeedTitles", feedId: "cal-new" });
  assert.equal(resp.ok, true, "the just-toggled-on calendar must be readable: " + resp.error);
  assert.deepEqual(
    resp.titles.map((t) => t.title),
    ["Night Tour"]
  );
});

test("listFeedTitles: an unknown calendar id is refused before any events request", async () => {
  reset();
  setFeeds([{ id: "cal-a", name: "Crew Schedule" }]);
  const resp = await send({ type: "listFeedTitles", feedId: "cal-nope" });
  assert.equal(resp.error, "unknown_feed");
  assert.equal(FETCH_LOG.filter((u) => u.includes("/events")).length, 0);
});

// ---------------------------------------------------------------------------
// OFF calendars are never fetched — the promise the whole design rests on
// ---------------------------------------------------------------------------

test("getCalendarData: OFF calendars are never fetched", async () => {
  reset();
  setFeeds([
    { id: "cal-on", name: "Crew Schedule" },
    { id: "cal-off", name: "Personal" },
  ]);
  STORE.calRoles = { "cal-on": "REJECT" };
  EVENTS["cal-on"] = [timed("Night Tour", "10")];
  EVENTS["cal-off"] = [timed("Therapy", "11")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.equal(eventsFetchedFor("cal-off").length, 0);
  assert.equal(eventsFetchedFor("cal-on").length, 1);
});

// ---------------------------------------------------------------------------
// Per-calendar / per-event rest-buffer CONTRACT
//
//   restBefore = calEventBuffers[C]?.[T]?.before ?? calBufferBefore[C] ?? 0
//   restAfter  = calEventBuffers[C]?.[T]?.after  ?? calBufferAfter[C]  ?? 0
// ---------------------------------------------------------------------------

test("setCalendarBuffer: writes both calBufferBefore/After for the calendar and drops the cache", async () => {
  reset();
  STORE.calCache = {
    fetchedAt: 1, commitments: [], soft: [], windowStart: "2026-08-01", windowEnd: "2026-08-31",
  };
  const resp = await send({ type: "setCalendarBuffer", feedId: "cal-1", before: 6, after: 12.5 });
  assert.equal(resp.ok, true);
  assert.equal(STORE.calBufferBefore["cal-1"], 6);
  assert.equal(STORE.calBufferAfter["cal-1"], 12.5);
  assert.equal(STORE.calCache, undefined, "a stale cache must not survive a buffer change");
});

test("setCalendarBuffer: NaN/negative/Infinity are all refused as bad_buffer, nothing written", async () => {
  reset();
  for (const bad of [NaN, -1, Infinity, -Infinity]) {
    const resp = await send({ type: "setCalendarBuffer", feedId: "cal-1", before: bad, after: 0 });
    assert.deepEqual(resp, { ok: false, error: "bad_buffer" }, `before=${bad}`);
    const resp2 = await send({ type: "setCalendarBuffer", feedId: "cal-1", before: 0, after: bad });
    assert.deepEqual(resp2, { ok: false, error: "bad_buffer" }, `after=${bad}`);
  }
  assert.equal(STORE.calBufferBefore, undefined);
  assert.equal(STORE.calBufferAfter, undefined);
});

test("setCalendarBuffer: missing calendarId is refused as bad_calendar_id", async () => {
  reset();
  const resp = await send({ type: "setCalendarBuffer", before: 1, after: 1 });
  assert.deepEqual(resp, { ok: false, error: "bad_feed_id" });
});

test("setEventRules: persists eventBuffers alongside block/note/labels/calLabel", async () => {
  reset();
  const resp = await send({
    type: "setEventRules",
    feedId: "cal-1",
    block: ["Crew - Desk"],
    note: [],
    labels: {},
    calLabel: "",
    eventBuffers: { "Crew - Desk": { before: 4, after: 10 } },
  });
  assert.equal(resp.ok, true);
  assert.deepEqual(STORE.calBlockTitles["cal-1"], ["Crew - Desk"]);
  assert.deepEqual(STORE.calEventBuffers["cal-1"], { "Crew - Desk": { before: 4, after: 10 } });
});

test("setEventRules: omitting eventBuffers leaves the calendar's stored overrides untouched", async () => {
  reset();
  STORE.calEventBuffers = { "cal-1": { "Crew - Desk": { before: 4, after: 10 } } };
  const resp = await send({
    type: "setEventRules", feedId: "cal-1", block: ["Crew - Desk"], note: [], labels: {}, calLabel: "",
  });
  assert.equal(resp.ok, true);
  assert.deepEqual(STORE.calEventBuffers["cal-1"], { "Crew - Desk": { before: 4, after: 10 } });
});

test("listFeeds: each calendar gets bufferBefore/bufferAfter, default 0 when unconfigured", async () => {
  reset();
  setFeeds([
    { id: "cal-a", name: "Crew Schedule" },
    { id: "cal-b", name: "Household" },
  ]);
  STORE.calBufferBefore = { "cal-a": 6 };
  STORE.calBufferAfter = { "cal-a": 12 };

  const resp = await send({ type: "listFeeds" });
  assert.equal(resp.ok, true);
  const a = resp.feeds.find((c) => c.id === "cal-a");
  const b = resp.feeds.find((c) => c.id === "cal-b");
  assert.equal(a.bufferBefore, 6);
  assert.equal(a.bufferAfter, 12);
  assert.equal(b.bufferBefore, 0);
  assert.equal(b.bufferAfter, 0);
});

test("listFeedTitles: echoes eventBuffers for the calendar (default {})", async () => {
  reset();
  setFeeds([{ id: "cal-on", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-on": "RULE" };
  STORE.calBlockTitles = { "cal-on": ["Crew - Desk"] };
  STORE.calEventBuffers = { "cal-on": { "Crew - Desk": { before: 4, after: 10 } } };
  EVENTS["cal-on"] = [timed("Crew - Desk", "10")];

  const resp = await send({ type: "listFeedTitles", feedId: "cal-on" });
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.eventBuffers, { "Crew - Desk": { before: 4, after: 10 } });
});

test("listFeedTitles: a calendar with no stored eventBuffers echoes {}", async () => {
  reset();
  setFeeds([{ id: "cal-on", name: "Crew Schedule" }]);
  STORE.calRoles = { "cal-on": "RULE" };
  EVENTS["cal-on"] = [timed("Crew - Desk", "10")];

  const resp = await send({ type: "listFeedTitles", feedId: "cal-on" });
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.eventBuffers, {});
});

// ---------------------------------------------------------------------------
// bucketEvents(): the commitment triplet's 5th/4th elements ARE the effective
// buffer for that event — a per-event override beats the calendar's default.
// ---------------------------------------------------------------------------

test("bucketEvents: a commitment triplet is 5 elements carrying the effective restBefore/restAfter", () => {
  const events = [timed("Crew - Desk", "10")];
  const rule = (title) => title === "Crew - Desk";
  const { commitments } = sw.bucketEvents(
    events,
    "RULE",
    rule,
    "",
    [],
    {},
    { before: 6, after: 12, eventBuffers: {} }
  );
  assert.equal(commitments.length, 1);
  const trip = commitments[0];
  assert.equal(trip.length, 5);
  assert.equal(trip[3], 6, "restBefore should fall back to the calendar default");
  assert.equal(trip[4], 12, "restAfter should fall back to the calendar default");
});

test("bucketEvents: a per-event buffer override beats the calendar default", () => {
  const events = [timed("Crew - Desk", "10")];
  const rule = (title) => title === "Crew - Desk";
  const { commitments } = sw.bucketEvents(
    events,
    "RULE",
    rule,
    "",
    [],
    {},
    { before: 6, after: 12, eventBuffers: { "Crew - Desk": { before: 1, after: 2 } } }
  );
  assert.equal(commitments.length, 1);
  const trip = commitments[0];
  assert.equal(trip[3], 1, "per-event restBefore override should win");
  assert.equal(trip[4], 2, "per-event restAfter override should win");
});

// Regression: the override lookup is whitespace-normalized, matching how the
// note set and label map are keyed. Without it, an NBSP (or double space) in a
// feed title silently drops the override and falls back to the calendar default
// — the exact failure a reviewer caught.
test("bucketEvents: a per-event buffer override still applies when the title has a non-break space", () => {
  const NBSP = "Crew - Tour"; // no-break spaces around the dash, as real-world feeds emit
  const events = [timed(NBSP, "10")];
  const { commitments } = sw.bucketEvents(
    events,
    "REJECT",
    () => true,
    "",
    [],
    {},
    { before: 6, after: 12, eventBuffers: { [NBSP]: { before: 1, after: 2 } } }
  );
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0][3], 1, "override must survive whitespace normalization, not fall back to 6");
  assert.equal(commitments[0][4], 2, "override must survive whitespace normalization, not fall back to 12");
});

test("bucketEvents: with no bufferOpts at all, the commitment triplet defaults both sides to 0", () => {
  const events = [timed("Crew - Desk", "10")];
  const rule = (title) => title === "Crew - Desk";
  const { commitments } = sw.bucketEvents(events, "RULE", rule, "", [], {});
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0][3], 0);
  assert.equal(commitments[0][4], 0);
});

// ---------------------------------------------------------------------------
// Per-feed commitment label, and the migration off the old single global one
// ---------------------------------------------------------------------------

test("setFeedBlockLabel: stores the trimmed word and drops the cache", async () => {
  reset();
  setFeeds([{ id: "f1", name: "Crew Schedule", role: "REJECT" }]);
  STORE.calCache = { fetchedAt: 1, commitments: [], soft: [] };

  const resp = await send({ type: "setFeedBlockLabel", feedId: "f1", label: "  Fire Dept  " });
  assert.equal(resp.ok, true);
  assert.deepEqual(STORE.calBlockLabel, { f1: "Fire Dept" });
  assert.equal("calCache" in STORE, false, "a stale cache would keep serving the old chip word");
});

test("setFeedBlockLabel: a blank value REMOVES the entry rather than storing an empty string", async () => {
  reset();
  setFeeds([{ id: "f1", name: "Crew Schedule", role: "REJECT" }]);
  STORE.calBlockLabel = { f1: "Fire Dept" };
  await send({ type: "setFeedBlockLabel", feedId: "f1", label: "   " });
  assert.deepEqual(STORE.calBlockLabel, {}, "unset must have exactly one representation");
});

test("setFeedBlockLabel: a missing feed id is refused", async () => {
  reset();
  const resp = await send({ type: "setFeedBlockLabel", label: "Fire Dept" });
  assert.equal(resp.ok, false);
  assert.equal(resp.error, "bad_feed_id");
});

test("getCalendarData: a feed's label rides on its commitment triplets", async () => {
  reset();
  setFeeds([{ id: "f1", name: "Crew Schedule", role: "REJECT" }]);
  STORE.calBlockLabel = { f1: "Fire Dept" };
  EVENTS["f1"] = [timed("Night Tour", "15")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.commitments[0][2], "Fire Dept");
});

// The whole point of the change: one word per feed, not one for the board.
test("getCalendarData: two feeds keep their own separate words", async () => {
  reset();
  setFeeds([
    { id: "f1", name: "Crew Schedule", role: "REJECT" },
    { id: "f2", name: "Family", role: "REJECT" },
  ]);
  STORE.calBlockLabel = { f1: "Fire Dept", f2: "Family" };
  EVENTS["f1"] = [timed("Night Tour", "15")];
  EVENTS["f2"] = [timed("Recital", "16")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.deepEqual(resp.commitments.map((c) => c[2]).sort(), ["Family", "Fire Dept"]);
});

test("listFeeds: echoes each feed's label back to the panel", async () => {
  reset();
  setFeeds([{ id: "f1", name: "Crew Schedule", role: "REJECT" }, { id: "f2", name: "Family" }]);
  STORE.calBlockLabel = { f1: "Fire Dept" };
  const resp = await send({ type: "listFeeds" });
  assert.equal(resp.feeds.find((f) => f.id === "f1").blockLabel, "Fire Dept");
  assert.equal(resp.feeds.find((f) => f.id === "f2").blockLabel, "");
});

test("removeFeed: deletes the feed's label along with the rest of its config", async () => {
  reset();
  setFeeds([{ id: "f1", name: "Crew Schedule", role: "REJECT" }]);
  STORE.calBlockLabel = { f1: "Fire Dept" };
  await send({ type: "removeFeed", feedId: "f1" });
  assert.deepEqual(STORE.calBlockLabel, {});
});

// MIGRATION. The label used to be ONE global word. Deleting that setting without
// moving its value would silently turn a deliberate "✕ Fire Dept" into
// "✕ Commitment" — config disarmed with no signal, which is the exact class of
// bug this codebase has shipped before and now refuses to.
test("migration: a stored global label is copied onto every feed, then deleted", async () => {
  reset();
  setFeeds([
    { id: "f1", name: "Crew Schedule", role: "REJECT" },
    { id: "f2", name: "Family", role: "FLAG" },
  ]);
  STORE.commitmentLabel = "Fire Dept";

  await send({ type: "listFeeds" });
  assert.deepEqual(STORE.calBlockLabel, { f1: "Fire Dept", f2: "Fire Dept" });
  assert.equal("commitmentLabel" in STORE, false, "the legacy key must be gone once moved");
});

test("migration: never overwrites a per-feed label the user already set", async () => {
  reset();
  setFeeds([{ id: "f1", name: "A", role: "REJECT" }, { id: "f2", name: "B", role: "REJECT" }]);
  STORE.commitmentLabel = "Fire Dept";
  STORE.calBlockLabel = { f1: "Station 3" };

  await send({ type: "listFeeds" });
  assert.deepEqual(STORE.calBlockLabel, { f1: "Station 3", f2: "Fire Dept" });
});

test("migration: is idempotent — a later re-run cannot resurrect the old word", async () => {
  reset();
  setFeeds([{ id: "f1", name: "A", role: "REJECT" }]);
  STORE.commitmentLabel = "Fire Dept";

  await send({ type: "listFeeds" });
  await send({ type: "setFeedBlockLabel", feedId: "f1", label: "Changed" });
  await send({ type: "listFeeds" });
  assert.deepEqual(STORE.calBlockLabel, { f1: "Changed" });
});

test("migration: a blank global label is simply dropped, seeding nothing", async () => {
  reset();
  setFeeds([{ id: "f1", name: "A", role: "REJECT" }]);
  STORE.commitmentLabel = "   ";

  await send({ type: "listFeeds" });
  assert.equal("commitmentLabel" in STORE, false);
  assert.deepEqual(STORE.calBlockLabel || {}, {});
});

test("migration: the migrated word is what rejects actually say", async () => {
  reset();
  setFeeds([{ id: "f1", name: "Crew Schedule", role: "REJECT" }]);
  STORE.commitmentLabel = "Fire Dept";
  EVENTS["f1"] = [timed("Night Tour", "15")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.commitments[0][2], "Fire Dept",
    "a pre-upgrade word must survive the upgrade end to end");
});
