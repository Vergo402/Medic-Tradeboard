import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTriplet,
  ruleMatches,
  defaultRole,
  resolveRoles,
  bucketEvents,
  resolveIncludeRegex,
  parseExcludes,
} from "../sw.js";

// Every fixture in this file is synthetic. This repo is public and its git
// history is permanent: no real calendar id, calendar name, event title, or
// person's name may ever appear here.

// A user's own RULE regex. ANCHORED on purpose — see the raw-title trap below.
const INCLUDE_RE = /^Work\b/i;
const EXCLUDES = ["training"];
const RULE = (title) => ruleMatches(title, INCLUDE_RE, EXCLUDES);

function timed(summary, extra) {
  return Object.assign(
    {
      summary,
      start: { dateTime: "2026-08-04T08:00:00-04:00" },
      end: { dateTime: "2026-08-04T18:00:00-04:00" },
    },
    extra || {}
  );
}

// ---------------------------------------------------------------------------
// bucketEvents — the priority: it decides hard rejects
// ---------------------------------------------------------------------------

test("bucketEvents: REJECT sends every event to commitments", () => {
  const out = bucketEvents([timed("Work day"), timed("Dentist")], "REJECT", RULE, "");
  assert.equal(out.commitments.length, 2);
  assert.equal(out.soft.length, 0);
});

test("bucketEvents: REJECT does not consult the rule at all", () => {
  let called = false;
  const out = bucketEvents(
    [timed("Dentist")],
    "REJECT",
    () => {
      called = true;
      return false;
    },
    ""
  );
  assert.equal(called, false);
  assert.equal(out.commitments.length, 1);
});

test("bucketEvents: FLAG sends every event to soft, even rule-matching ones", () => {
  const out = bucketEvents([timed("Work day"), timed("Dentist")], "FLAG", RULE, "");
  assert.equal(out.soft.length, 2);
  assert.equal(out.commitments.length, 0);
});

test("bucketEvents: RULE splits on the predicate", () => {
  const out = bucketEvents([timed("Work day"), timed("Dentist")], "RULE", RULE, "");
  assert.deepEqual(
    out.commitments.map((r) => r[2]),
    ["Work day"]
  );
  assert.deepEqual(
    out.soft.map((r) => r[2]),
    ["Dentist"]
  );
});

test("bucketEvents: RULE sends an excluded title to soft, not commitments", () => {
  const out = bucketEvents([timed("Work training")], "RULE", RULE, "");
  assert.equal(out.commitments.length, 0);
  assert.deepEqual(
    out.soft.map((r) => r[2]),
    ["Work training"]
  );
});

test("bucketEvents: OFF yields both arrays empty and never calls the rule", () => {
  let called = false;
  const out = bucketEvents(
    [timed("Work day")],
    "OFF",
    () => {
      called = true;
      return true;
    },
    ""
  );
  assert.deepEqual(out, { commitments: [], soft: [] });
  assert.equal(called, false);
});

test("bucketEvents: an unknown role is treated as soft, never as a hard reject", () => {
  const out = bucketEvents([timed("Work day")], "BOGUS", RULE, "");
  assert.equal(out.commitments.length, 0);
  assert.equal(out.soft.length, 1);
});

test("bucketEvents: cancelled events are dropped in every role", () => {
  for (const role of ["FLAG", "REJECT", "RULE"]) {
    const out = bucketEvents([timed("Work day", { status: "cancelled" })], role, RULE, "");
    assert.equal(out.commitments.length + out.soft.length, 0, `role ${role}`);
  }
});

test("bucketEvents: an event with neither start.date nor start.dateTime is dropped", () => {
  for (const role of ["FLAG", "REJECT", "RULE"]) {
    const out = bucketEvents([{ summary: "No start", start: {}, end: {} }], role, RULE, "");
    assert.equal(out.commitments.length + out.soft.length, 0, `role ${role}`);
  }
});

test("bucketEvents: an event with no summary becomes an empty title, not undefined", () => {
  const out = bucketEvents([{ start: { date: "2026-08-04" }, end: { date: "2026-08-05" } }], "FLAG", RULE, "");
  assert.equal(out.soft[0][2], "");
});

test("bucketEvents: rows carry the triplet start and end alongside the label", () => {
  const out = bucketEvents([timed("Dentist")], "FLAG", RULE, "");
  assert.deepEqual(out.soft[0], ["2026-08-04 08:00", "2026-08-04 18:00", "Dentist"]);
});

test("bucketEvents: empty prefix leaves the title bare", () => {
  const out = bucketEvents([timed("Dinner")], "FLAG", RULE, "");
  assert.equal(out.soft[0][2], "Dinner");
});

test("bucketEvents: a non-empty prefix is joined with the middot separator", () => {
  const out = bucketEvents([timed("Dinner")], "FLAG", RULE, "Shared Cal");
  assert.equal(out.soft[0][2], "Shared Cal · Dinner");
});

// THE TRAP. The rule predicate must run on the RAW title. If it ever runs on the
// prefixed label instead, the anchored "^Work\b" cannot match "Shared Cal · Work
// day", so a non-primary RULE calendar silently stops producing hard rejects —
// the shift is offered as free while the user is actually committed.
//
// The anchor and the non-empty prefix are what give this test teeth: with an
// unanchored pattern it would pass even with the bug present. Do not neutralize
// either one.
test("bucketEvents: RULE matches the RAW title, not the prefixed label", () => {
  const out = bucketEvents([timed("Work day"), timed("Dentist")], "RULE", RULE, "Shared Cal");
  assert.deepEqual(
    out.commitments.map((r) => r[2]),
    ["Shared Cal · Work day"]
  );
  assert.deepEqual(
    out.soft.map((r) => r[2]),
    ["Shared Cal · Dentist"]
  );
});

test("bucketEvents: the rule receives the raw title as its only argument", () => {
  const seen = [];
  bucketEvents([timed("Work day")], "RULE", (t) => {
    seen.push(t);
    return true;
  }, "Shared Cal");
  assert.deepEqual(seen, ["Work day"]);
});

test("bucketEvents: null/undefined event list is safe", () => {
  assert.deepEqual(bucketEvents(null, "FLAG", RULE, ""), { commitments: [], soft: [] });
  assert.deepEqual(bucketEvents(undefined, "REJECT", RULE, ""), { commitments: [], soft: [] });
});

// ---------------------------------------------------------------------------
// defaultRole — the first-run cascade for a user who has configured nothing
// ---------------------------------------------------------------------------

test("defaultRole: the account's own primary calendar defaults to FLAG", () => {
  assert.equal(defaultRole({ id: "p", summary: "user@example.com", primary: true }), "FLAG");
});

test("defaultRole: every non-primary calendar defaults to OFF", () => {
  assert.equal(defaultRole({ id: "a", summary: "Shared Household" }), "OFF");
  assert.equal(defaultRole({ id: "b", summary: "Holidays in United States" }), "OFF");
  assert.equal(defaultRole({ id: "c", summary: "Crew Schedule" }), "OFF");
  assert.equal(defaultRole({ id: "d", summary: "" }), "OFF");
  assert.equal(defaultRole({ id: "e" }), "OFF");
});

test("defaultRole: primary:false and a missing primary field both mean non-primary", () => {
  assert.equal(defaultRole({ id: "a", summary: "Some Cal", primary: false }), "OFF");
  assert.equal(defaultRole({ id: "b", summary: "Some Cal" }), "OFF");
});

// The safety invariant behind the whole cascade: the extension must never invent
// a hard reject for a calendar the user has not explicitly spoken about.
test("defaultRole: NO input ever defaults to REJECT", () => {
  const items = [
    { id: "p", summary: "user@example.com", primary: true },
    { id: "a", summary: "Shared Household" },
    { id: "b", summary: "Work Schedule" },
    { id: "c", summary: "" },
    { id: "d" },
    null,
    undefined,
  ];
  for (const it of items) {
    assert.notEqual(defaultRole(it), "REJECT", `input ${JSON.stringify(it)}`);
  }
});

test("defaultRole: RULE is never a default — it requires a user-written regex", () => {
  assert.notEqual(defaultRole({ id: "p", summary: "user@example.com", primary: true }), "RULE");
  assert.notEqual(defaultRole({ id: "a", summary: "Work Schedule" }), "RULE");
});

test("defaultRole: null/undefined is OFF, not a crash", () => {
  assert.equal(defaultRole(null), "OFF");
  assert.equal(defaultRole(undefined), "OFF");
});

test("defaultRole: is stateless across repeated calls", () => {
  const item = { id: "p", summary: "user@example.com", primary: true };
  assert.equal(defaultRole(item), "FLAG");
  assert.equal(defaultRole(item), "FLAG");
  assert.equal(defaultRole(item), "FLAG");
});

// ---------------------------------------------------------------------------
// resolveRoles
// ---------------------------------------------------------------------------

test("resolveRoles: a stored role overrides the default", () => {
  const items = [{ id: "a", summary: "Crew Schedule" }];
  assert.equal(resolveRoles(items, { a: "REJECT" })[0].role, "REJECT");
  assert.equal(resolveRoles(items, { a: "RULE" })[0].role, "RULE");
});

test("resolveRoles: a stored role can turn the primary calendar off", () => {
  const items = [{ id: "p", summary: "user@example.com", primary: true }];
  assert.equal(resolveRoles(items, { p: "OFF" })[0].role, "OFF");
});

test("resolveRoles: an unrecognised stored value falls back to the default", () => {
  const items = [{ id: "p", summary: "user@example.com", primary: true }];
  assert.equal(resolveRoles(items, { p: "BOGUS" })[0].role, "FLAG");
  assert.equal(resolveRoles(items, { p: null })[0].role, "FLAG");
  assert.equal(resolveRoles(items, { p: "reject" })[0].role, "FLAG"); // case-sensitive
});

test("resolveRoles: an entry for a calendar that is no longer listed is ignored", () => {
  const out = resolveRoles([{ id: "a", summary: "Crew Schedule" }], { gone: "REJECT" });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "OFF");
});

test("resolveRoles: undefined or empty storedRoles is safe", () => {
  const items = [{ id: "a", summary: "Crew Schedule" }];
  assert.equal(resolveRoles(items, undefined)[0].role, "OFF");
  assert.equal(resolveRoles(items, {})[0].role, "OFF");
  assert.deepEqual(resolveRoles(undefined, {}), []);
  assert.deepEqual(resolveRoles(null, undefined), []);
});

// First run for a brand-new user: sign in, configure nothing. Exactly one
// calendar — their own — is enabled, and it can only annotate, never block.
test("resolveRoles: an unconfigured user gets FLAG on primary and OFF everywhere else", () => {
  const items = [
    { id: "p", summary: "user@example.com", primary: true },
    { id: "a", summary: "Shared Household" },
    { id: "b", summary: "Holidays in United States" },
    { id: "c", summary: "Crew Schedule" },
  ];
  const out = resolveRoles(items, {});
  assert.deepEqual(
    out.map((c) => c.role),
    ["FLAG", "OFF", "OFF", "OFF"]
  );
  assert.equal(out.filter((c) => c.role === "REJECT").length, 0);
});

test("resolveRoles: primary sorts first, then case-insensitive alpha by summary", () => {
  const items = [
    { id: "c", summary: "zebra" },
    { id: "a", summary: "Apple" },
    { id: "p", summary: "user@example.com", primary: true },
    { id: "b", summary: "banana" },
  ];
  assert.deepEqual(
    resolveRoles(items, {}).map((c) => c.id),
    ["p", "a", "b", "c"]
  );
});

test("resolveRoles: prefix is empty for primary and the summary for everyone else", () => {
  const items = [
    { id: "p", summary: "user@example.com", primary: true },
    { id: "k", summary: "Shared Household" },
  ];
  const byId = Object.fromEntries(resolveRoles(items, {}).map((c) => [c.id, c]));
  assert.equal(byId.p.prefix, "");
  assert.equal(byId.k.prefix, "Shared Household");
});

test("resolveRoles: a missing summary becomes an empty string, not undefined", () => {
  const out = resolveRoles([{ id: "a" }], {});
  assert.equal(out[0].summary, "");
  assert.equal(out[0].prefix, "");
});

test("resolveRoles: primary is a boolean, normalised from a missing field", () => {
  const out = resolveRoles([{ id: "a", summary: "Crew Schedule" }], {});
  assert.equal(out[0].primary, false);
});

// resolveRoles feeds bucketEvents directly, so its prefix must be the one that
// keeps a primary event unprefixed end to end.
test("resolveRoles + bucketEvents: primary events stay unprefixed", () => {
  const cal = resolveRoles([{ id: "p", summary: "user@example.com", primary: true }], {})[0];
  const out = bucketEvents([timed("Dentist")], cal.role, RULE, cal.prefix);
  assert.equal(out.soft[0][2], "Dentist");
});

// ---------------------------------------------------------------------------
// ruleMatches — the user-editable RULE predicate
// ---------------------------------------------------------------------------

test("ruleMatches: an anchored pattern matches a title that starts with it", () => {
  assert.equal(ruleMatches("Work day", INCLUDE_RE, EXCLUDES), true);
});

test("ruleMatches: the word boundary rejects a longer word", () => {
  assert.equal(ruleMatches("Workshop day", INCLUDE_RE, EXCLUDES), false);
});

test("ruleMatches: the i flag makes a lowercase title match", () => {
  assert.equal(ruleMatches("work day", INCLUDE_RE, EXCLUDES), true);
});

test("ruleMatches: an exclude substring vetoes an otherwise-matching title", () => {
  assert.equal(ruleMatches("Work - annual training", INCLUDE_RE, EXCLUDES), false);
});

test("ruleMatches: excludes match case-insensitively", () => {
  assert.equal(ruleMatches("Work - annual TRAINING", INCLUDE_RE, EXCLUDES), false);
});

test("ruleMatches: a non-matching title is false regardless of excludes", () => {
  assert.equal(ruleMatches("Dentist", INCLUDE_RE, EXCLUDES), false);
});

test("ruleMatches: an empty exclude list vetoes nothing", () => {
  assert.equal(ruleMatches("Work - annual training", INCLUDE_RE, []), true);
});

test("ruleMatches: a missing title does not throw", () => {
  assert.equal(ruleMatches(undefined, INCLUDE_RE, EXCLUDES), false);
  assert.equal(ruleMatches("", INCLUDE_RE, EXCLUDES), false);
});

// ---------------------------------------------------------------------------
// resolveIncludeRegex — the empty-pattern guard.
//
// THE MOST IMPORTANT TESTS IN THIS FILE. new RegExp("", "i") matches EVERY
// string. If an empty stored include pattern were ever compiled and used, a
// calendar in the RULE role would hard-reject 100% of its events, and the user
// would silently never be shown a single shift they were free to take. A
// regression here is invisible: no error, no warning, just an empty board.
// ---------------------------------------------------------------------------

// Titles that a correctly-defaulted rule must NOT treat as a commitment. If the
// guard breaks and "" gets compiled, every one of these starts matching.
// Deliberately excludes anything the anchored default "^Work\b" is SUPPOSED to
// match — the claim under test is "an empty pattern does not match everything",
// not "the fallback matches nothing".
const NON_COMMITMENT_TITLES = ["Dentist", "", "Lunch", "Kid pickup", "?!", "Homework"];

for (const src of ["", "   ", "\t\n "]) {
  test(`resolveIncludeRegex: an empty include pattern (${JSON.stringify(src)}) does NOT match every title`, () => {
    const { includeRe } = resolveIncludeRegex(src);
    for (const title of NON_COMMITMENT_TITLES) {
      assert.equal(
        includeRe.test(title),
        false,
        `empty include pattern must not match ${JSON.stringify(title)}`
      );
    }
  });

  test(`resolveIncludeRegex: an empty include pattern (${JSON.stringify(src)}) falls back to the anchored default`, () => {
    const { includeRe, warnings } = resolveIncludeRegex(src);
    assert.equal(includeRe.test("Work day"), true); // the default still works
    assert.equal(includeRe.test("Workshop day"), false); // ...and is still anchored+bounded
    assert.deepEqual(warnings, ["empty_rule_regex"]);
  });
}

// End to end through bucketEvents: the guard's whole point is that an
// unconfigured RULE calendar does not silently swallow the board.
test("resolveIncludeRegex + bucketEvents: an empty include pattern does not hard-reject everything", () => {
  const { includeRe } = resolveIncludeRegex("");
  const rule = (title) => ruleMatches(title, includeRe, []);
  const out = bucketEvents([timed("Dentist"), timed("Lunch"), timed("Kid pickup")], "RULE", rule, "");
  assert.equal(out.commitments.length, 0, "no event should become a hard commitment");
  assert.equal(out.soft.length, 3);
});

test("resolveIncludeRegex: a non-string stored value is treated as not configured", () => {
  for (const src of [undefined, null, 0, {}]) {
    const { includeRe, warnings } = resolveIncludeRegex(src);
    assert.equal(includeRe.test("Dentist"), false);
    assert.equal(includeRe.test("Work day"), true);
    assert.deepEqual(warnings, ["empty_rule_regex"]);
  }
});

test("resolveIncludeRegex: an invalid regex falls back to the default and warns", () => {
  const { includeRe, warnings } = resolveIncludeRegex("Work(");
  assert.equal(includeRe.test("Work day"), true);
  assert.equal(includeRe.test("Dentist"), false);
  assert.deepEqual(warnings, ["bad_rule_regex"]);
});

test("resolveIncludeRegex: a valid user pattern is used as-is, case-insensitively, with no warning", () => {
  const { includeRe, warnings } = resolveIncludeRegex("^On[- ]?Duty\\b");
  assert.equal(includeRe.test("on duty — medic 1"), true);
  assert.equal(includeRe.test("On-Duty"), true);
  assert.equal(includeRe.test("Dentist"), false);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// parseExcludes
// ---------------------------------------------------------------------------

test("parseExcludes: splits, trims, lowercases and drops empties", () => {
  assert.deepEqual(parseExcludes(" Training, MEETING ,, "), ["training", "meeting"]);
});

test("parseExcludes: an empty or non-string field yields no excludes", () => {
  assert.deepEqual(parseExcludes(""), []);
  assert.deepEqual(parseExcludes(undefined), []);
});

// ---------------------------------------------------------------------------
// buildTriplet
// ---------------------------------------------------------------------------

test("buildTriplet: an all-day event uses end.date as-is with no +1 day", () => {
  const trip = buildTriplet({ start: { date: "2026-08-04" }, end: { date: "2026-08-05" } });
  assert.deepEqual(trip, ["2026-08-04 00:00", "2026-08-05 00:00"]);
});

test("buildTriplet: a single all-day event with no end.date reuses start.date", () => {
  const trip = buildTriplet({ start: { date: "2026-08-04" }, end: {} });
  assert.deepEqual(trip, ["2026-08-04 00:00", "2026-08-04 00:00"]);
});

test("buildTriplet: a timed event normalises to NY civil time", () => {
  const trip = buildTriplet({
    start: { dateTime: "2026-08-04T08:00:00-04:00" },
    end: { dateTime: "2026-08-04T18:00:00-04:00" },
  });
  assert.deepEqual(trip, ["2026-08-04 08:00", "2026-08-04 18:00"]);
});

test("buildTriplet: a UTC timestamp is converted into NY local, not left as UTC", () => {
  const trip = buildTriplet({
    start: { dateTime: "2026-08-04T12:00:00Z" },
    end: { dateTime: "2026-08-04T22:00:00Z" },
  });
  assert.deepEqual(trip, ["2026-08-04 08:00", "2026-08-04 18:00"]);
});

test("buildTriplet: a foreign-timezone event lands on NY wall time", () => {
  const trip = buildTriplet({
    start: { dateTime: "2026-08-04T15:00:00+02:00" },
    end: { dateTime: "2026-08-04T17:00:00+02:00" },
  });
  assert.deepEqual(trip, ["2026-08-04 09:00", "2026-08-04 11:00"]);
});

test("buildTriplet: a timed event with no end falls back to the start instant", () => {
  const trip = buildTriplet({ start: { dateTime: "2026-08-04T08:00:00-04:00" }, end: {} });
  assert.deepEqual(trip, ["2026-08-04 08:00", "2026-08-04 08:00"]);
});

test("buildTriplet: no start.date and no start.dateTime returns null", () => {
  assert.equal(buildTriplet({ start: {}, end: {} }), null);
  assert.equal(buildTriplet({}), null);
  assert.equal(buildTriplet(null), null);
});
