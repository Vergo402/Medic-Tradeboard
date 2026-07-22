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
let CAL_ITEMS = []; // what calendarList.list returns
let EVENTS = {}; // calendarId -> events[]
let FETCH_LOG = []; // every URL the worker requested, in order

function reset() {
  STORE = {};
  CAL_ITEMS = [];
  EVENTS = {};
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

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => listeners.push(fn) },
  },
  identity: {
    getAuthToken: (_opts, cb) => cb("synthetic-token"),
    removeCachedAuthToken: (_opts, cb) => cb(),
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

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

globalThis.fetch = async (url) => {
  FETCH_LOG.push(url);
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });

  if (url.startsWith(`${CAL_BASE}/users/me/calendarList`)) {
    return ok({ items: CAL_ITEMS });
  }
  const m = url.match(/\/calendars\/([^/]+)\/events/);
  if (m) {
    const calId = decodeURIComponent(m[1]);
    return ok({ items: EVENTS[calId] || [] });
  }
  throw new Error("unexpected fetch: " + url);
};

// Import AFTER the globals exist — sw.js registers its listener at module load.
await import("../sw.js");
assert.equal(listeners.length, 1, "sw.js should register exactly one message listener");
const onMessage = listeners[0];

/** Drive the real handler the same way chrome.runtime.sendMessage would. */
function send(msg) {
  return new Promise((resolve, reject) => {
    const kept = onMessage(msg, {}, resolve);
    if (kept !== true) reject(new Error("handler did not keep the channel open: " + msg.type));
  });
}

const eventsFetchedFor = (calId) =>
  FETCH_LOG.filter((u) => u.includes(`/calendars/${encodeURIComponent(calId)}/events`));

function timed(summary, day) {
  return {
    summary,
    start: { dateTime: `2026-08-${day}T08:00:00-04:00` },
    end: { dateTime: `2026-08-${day}T18:00:00-04:00` },
  };
}

const WINDOW = { windowStart: "2026-08-01", windowEnd: "2026-08-31" };

// ---------------------------------------------------------------------------
// #2 — a hidden calendar must not silently lose its blocking role
//
// "Hide from list" in Google Calendar is a DISPLAY preference. Google omits
// hidden calendars from calendarList.list unless the request passes
// showHidden=true, so without it the stored REJECT role is never consulted: the
// calendar stops blocking, and it also vanishes from the options page, so the
// user can neither see the failure nor undo it.
// ---------------------------------------------------------------------------

test("listCalendars: the calendarList request asks for hidden calendars", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-a", summary: "Crew Schedule" }];
  await send({ type: "listCalendars", interactive: false });

  const listUrls = FETCH_LOG.filter((u) => u.includes("/users/me/calendarList"));
  assert.equal(listUrls.length, 1);
  assert.ok(
    listUrls[0].includes("showHidden=true"),
    "without showHidden=true Google never returns a hidden calendar at all: " + listUrls[0]
  );
  // showDeleted stays off — a deleted calendar really is gone.
  assert.ok(!listUrls[0].includes("showDeleted=true"), listUrls[0]);
});

test("listCalendars: a hidden calendar with a stored REJECT role is still listed", async () => {
  reset();
  CAL_ITEMS = [
    { id: "cal-fd", summary: "Crew Schedule", hidden: true },
    { id: "cal-b", summary: "Household" },
  ];
  STORE.calRoles = { "cal-fd": "REJECT" };

  const resp = await send({ type: "listCalendars", interactive: false });
  assert.equal(resp.ok, true);
  const fd = resp.calendars.find((c) => c.id === "cal-fd");
  assert.ok(fd, "a hidden calendar the user configured to block must stay visible");
  assert.equal(fd.role, "REJECT");
  assert.equal(fd.hiddenInGoogle, true, "the panel has to be able to label it as hidden");
});

test("listCalendars: a hidden calendar the user never configured stays out of the list", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-x", summary: "Some Feed", hidden: true }];
  const resp = await send({ type: "listCalendars", interactive: false });
  assert.deepEqual(resp.calendars, []);
});

// The point of keeping it: it goes on blocking.
test("getCalendarData: a hidden REJECT calendar is still fetched and still blocks", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-fd", summary: "Crew Schedule", hidden: true }];
  STORE.calRoles = { "cal-fd": "REJECT" };
  EVENTS["cal-fd"] = [timed("Night Tour", "15")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.equal(
    eventsFetchedFor("cal-fd").length,
    1,
    "hiding a calendar in Google must not stop the extension reading it"
  );
  assert.equal(resp.commitments.length, 1);
  // A REJECT commitment's triplet label is now "" (no per-event override), so
  // the reject chip falls back to the user's global commitment label rather than
  // the calendar name. The calendar still BLOCKS — that is the assertion above.
  assert.equal(resp.commitments[0][2], "");
});

test("getCalendarData: a deleted calendar is never fetched, whatever role it carries", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-gone", summary: "Gone", deleted: true }];
  STORE.calRoles = { "cal-gone": "REJECT" };
  EVENTS["cal-gone"] = [timed("Night Tour", "15")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.equal(eventsFetchedFor("cal-gone").length, 0);
  assert.equal(resp.commitments.length, 0);
});

// ---------------------------------------------------------------------------
// #1 — an empty ticked list blocks NOTHING, end to end through the handler
// ---------------------------------------------------------------------------

test("getCalendarData: a RULE calendar with [] ticked produces ZERO commitments", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-r", summary: "Crew Schedule" }];
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
  CAL_ITEMS = [{ id: "cal-r", summary: "Crew Schedule" }];
  STORE.calRoles = { "cal-r": "RULE" };
  EVENTS["cal-r"] = [timed("Work day", "10")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.commitments.length, 0);
  // Nothing configured ⇒ nothing blocks AND nothing notes: the event is ignored.
  assert.equal(resp.soft.length, 0);
});

test("getCalendarData: the pattern hatch blocks only once explicitly armed", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-r", summary: "Crew Schedule" }];
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
    calendarId: "cal-1",
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
    calendarId: "cal-1",
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
    type: "setEventRules", calendarId: "cal-1", block: [], note: [], labels: {}, calLabel: "",
  });
  assert.equal(resp.ok, true);
  assert.equal("cal-1" in STORE.calLabelOverride, false);
});

test("setEventRules: bad shapes are refused and nothing is written", async () => {
  reset();
  assert.deepEqual(
    await send({ type: "setEventRules", block: [], note: [], labels: {}, calLabel: "" }),
    { ok: false, error: "bad_calendar_id" }
  );
  assert.deepEqual(
    await send({ type: "setEventRules", calendarId: "c", block: "nope", note: [], labels: {}, calLabel: "" }),
    { ok: false, error: "bad_block" }
  );
  assert.deepEqual(
    await send({ type: "setEventRules", calendarId: "c", block: [], note: "nope", labels: {}, calLabel: "" }),
    { ok: false, error: "bad_note" }
  );
  // A non-plain-object (including an array) is not a valid labels map.
  for (const bad of [null, "x", 5, ["a"]]) {
    assert.deepEqual(
      await send({ type: "setEventRules", calendarId: "c", block: [], note: [], labels: bad, calLabel: "" }),
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
    type: "setEventRules", calendarId: "cal-1", block: ["Crew - Desk"], note: [], labels: {}, calLabel: "",
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
  await send({ type: "setEventRules", calendarId: "cal-1", block: [], note: [], labels: {}, calLabel: "" });
  assert.equal(STORE.calCache, undefined);
});

// The WIRING advisor asked to pin: calLabelOverride must actually override the
// note prefix inside refreshCalendarData (override || cal.prefix), not just in
// bucketEvents. If the override were dropped the label would read
// "Crew Schedule · Music Class" instead.
test("getCalendarData: calLabelOverride prefixes the notes from a calendar", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-r", summary: "Crew Schedule" }];
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
  CAL_ITEMS = [{ id: "cal-r", summary: "Crew Schedule" }];
  STORE.calRoles = { "cal-r": "RULE" };
  STORE.calBlockTitles = { "cal-r": ["Crew - Desk"] };
  STORE.calTitleLabels = { "cal-r": { "Crew - Desk": "Desk" } };
  EVENTS["cal-r"] = [timed("Crew - Desk", "10")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.commitments.map((r) => r[2]), ["Desk"]);
});

test("listCalendarTitles: echoes back the full three-way state for restore", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-on", summary: "Crew Schedule" }];
  STORE.calRoles = { "cal-on": "RULE" };
  STORE.calBlockTitles = { "cal-on": ["Crew - Desk"] };
  STORE.calNoteTitles = { "cal-on": ["Music Class"] };
  STORE.calTitleLabels = { "cal-on": { "Crew - Desk": "Desk" } };
  STORE.calLabelOverride = { "cal-on": "Fam" };
  EVENTS["cal-on"] = [timed("Crew - Desk", "10")];

  const resp = await send({ type: "listCalendarTitles", calendarId: "cal-on" });
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

test("listCalendarTitles: an OFF calendar is refused and never read", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-private", summary: "Personal" }]; // no stored role ⇒ OFF
  EVENTS["cal-private"] = [timed("Therapy", "12")];

  const resp = await send({ type: "listCalendarTitles", calendarId: "cal-private" });
  assert.equal(resp.ok, false);
  assert.equal(resp.error, "calendar_off");
  assert.equal(
    eventsFetchedFor("cal-private").length,
    0,
    "an OFF calendar's events must never leave Google"
  );
  assert.equal(resp.titles, undefined);
});

test("listCalendarTitles: an explicitly OFF calendar is refused too", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-off", summary: "Personal" }];
  STORE.calRoles = { "cal-off": "OFF" };
  EVENTS["cal-off"] = [timed("Therapy", "12")];

  const resp = await send({ type: "listCalendarTitles", calendarId: "cal-off" });
  assert.equal(resp.error, "calendar_off");
  assert.equal(eventsFetchedFor("cal-off").length, 0);
});

test("listCalendarTitles: a switched-on calendar is read normally", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-on", summary: "Crew Schedule" }];
  STORE.calRoles = { "cal-on": "RULE" };
  STORE.calBlockTitles = { "cal-on": ["ACME - Desk"] };
  EVENTS["cal-on"] = [timed("ACME - Desk", "10"), timed("ACME - Desk", "12")];

  const resp = await send({ type: "listCalendarTitles", calendarId: "cal-on" });
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
test("listCalendarTitles: works immediately after setCalendarRole turns a calendar on", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-new", summary: "Crew Schedule" }];
  EVENTS["cal-new"] = [timed("Night Tour", "10")];

  const set = await send({ type: "setCalendarRole", calendarId: "cal-new", role: "FLAG" });
  assert.equal(set.ok, true);

  const resp = await send({ type: "listCalendarTitles", calendarId: "cal-new" });
  assert.equal(resp.ok, true, "the just-toggled-on calendar must be readable: " + resp.error);
  assert.deepEqual(
    resp.titles.map((t) => t.title),
    ["Night Tour"]
  );
});

test("listCalendarTitles: an unknown calendar id is refused before any events request", async () => {
  reset();
  CAL_ITEMS = [{ id: "cal-a", summary: "Crew Schedule" }];
  const resp = await send({ type: "listCalendarTitles", calendarId: "cal-nope" });
  assert.equal(resp.error, "unknown_calendar");
  assert.equal(FETCH_LOG.filter((u) => u.includes("/events")).length, 0);
});

// ---------------------------------------------------------------------------
// OFF calendars are never fetched — the promise the whole design rests on
// ---------------------------------------------------------------------------

test("getCalendarData: OFF calendars are never fetched", async () => {
  reset();
  CAL_ITEMS = [
    { id: "cal-on", summary: "Crew Schedule" },
    { id: "cal-off", summary: "Personal" },
  ];
  STORE.calRoles = { "cal-on": "REJECT" };
  EVENTS["cal-on"] = [timed("Night Tour", "10")];
  EVENTS["cal-off"] = [timed("Therapy", "11")];

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true);
  assert.equal(eventsFetchedFor("cal-off").length, 0);
  assert.equal(eventsFetchedFor("cal-on").length, 1);
});
