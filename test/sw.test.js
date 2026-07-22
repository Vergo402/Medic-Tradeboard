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
  titleStem,
  titlesToMatcher,
  summarizeTitles,
  calendarRule,
  titleSampleWindow,
  normalizeTitleWhitespace,
  resolvePatternOptIn,
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

// THREE-WAY (approved change): on a RULE calendar a title is Block (stem match →
// commitment), Note (exact match in the note set → soft), or Ignore (in neither
// → dropped). Ignore is the DEFAULT: unmarked titles used to become notes; they
// are now dropped. Blocking is unchanged — only notes/ignore moved.
test("bucketEvents: RULE blocks a stem match, notes a note-set title, ignores the rest", () => {
  // Work day matches the block rule; Dentist is in the note set; Lunch is in
  // neither, so it is ignored (dropped).
  const out = bucketEvents(
    [timed("Work day"), timed("Dentist"), timed("Lunch")],
    "RULE", RULE, "", ["Dentist"], {}
  );
  // Work day blocked. A block's triplet label is the per-event "show as" or ""
  // (empty ⇒ the reject chip falls back to the global commitment label).
  assert.equal(out.commitments.length, 1);
  assert.equal(out.commitments[0][2], "");
  // Dentist is noted (exact note-set match).
  assert.deepEqual(out.soft.map((r) => r[2]), ["Dentist"]);
  // Lunch is in neither set → dropped: nothing else survives.
  assert.equal(out.commitments.length + out.soft.length, 2);
});

test("bucketEvents: RULE never blocks a rule-excluded title (it can still be a note)", () => {
  // "training" is in EXCLUDES, so the rule rejects it → it must not block.
  // Unmarked it would be ignored; put it in the note set to prove it can note.
  const out = bucketEvents([timed("Work training")], "RULE", RULE, "", ["Work training"], {});
  assert.equal(out.commitments.length, 0, "an excluded title must never block");
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
  // Dentist is in the note set so its prefixed note is also exercised here.
  const out = bucketEvents(
    [timed("Work day"), timed("Dentist")], "RULE", RULE, "Shared Cal", ["Dentist"], {}
  );
  // Work day blocked — proof the rule saw the RAW title: with an anchored
  // "^Work\b" against the prefixed label "Shared Cal · Work day" it could not
  // match, and commitments.length would be 0. Do not neutralize the anchor or
  // the non-empty prefix. The block's triplet label is "" — a note prefix never
  // leaks onto a hard commitment.
  assert.equal(out.commitments.length, 1);
  assert.equal(out.commitments[0][2], "");
  // A NOTE, by contrast, does carry the calendar prefix.
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
// bucketEvents — the THREE-WAY model (Block / Note / Ignore)
//
// On a RULE calendar a title is Block (stem-matches the block set → hard
// commitment), Note (exact-matches the note set → soft), or Ignore (in neither →
// dropped). Ignore is the DEFAULT. A block title may carry a per-event "show as"
// label (empty ⇒ fall back to the global commitment label); a note carries the
// calendar prefix plus the per-event label or the raw title.
// ---------------------------------------------------------------------------

// A stem block matcher for "Crew - Desk", the way calendarRule would build it.
const CREW_BLOCK = titlesToMatcher(["Crew - Desk"]);

test("bucketEvents three-way: block→commitment, note→soft, neither→dropped", () => {
  const events = [timed("Crew - Desk"), timed("Music Class"), timed("Brunch")];
  const out = bucketEvents(events, "RULE", CREW_BLOCK, "", ["Music Class"], {});
  // Crew - Desk stem-matches the block set → commitment.
  assert.equal(out.commitments.length, 1);
  // Music Class is in the note set → soft.
  assert.deepEqual(out.soft.map((r) => r[2]), ["Music Class"]);
  // Brunch is in NEITHER set → dropped: it must appear in neither array.
  const all = [...out.commitments.map((r) => r[2]), ...out.soft.map((r) => r[2])];
  assert.equal(all.includes("Brunch"), false);
  assert.equal(all.length, 2);
});

test("bucketEvents three-way: default ignore — empty block and note sets yield nothing", () => {
  const out = bucketEvents(
    [timed("Anything"), timed("Crew - Desk"), timed("Music Class")],
    "RULE", titlesToMatcher([]), "", [], {}
  );
  assert.equal(out.commitments.length, 0, "no block set ⇒ zero commitments");
  assert.equal(out.soft.length, 0, "no note set ⇒ zero soft notes (Ignore is the default)");
});

test("bucketEvents three-way: a block title's label becomes the commitment triplet label", () => {
  const out = bucketEvents(
    [timed("Crew - Desk")], "RULE", CREW_BLOCK, "", [], { "Crew - Desk": "Desk" }
  );
  assert.equal(out.commitments.length, 1);
  assert.equal(out.commitments[0][2], "Desk");
});

test("bucketEvents three-way: a block title with no label gets an empty commitment label", () => {
  const out = bucketEvents([timed("Crew - Desk")], "RULE", CREW_BLOCK, "", [], {});
  assert.equal(out.commitments[0][2], "");
});

test("bucketEvents three-way: a note title's label replaces the title, keeping the prefix", () => {
  const out = bucketEvents(
    [timed("Music Class")], "RULE", CREW_BLOCK, "Shared", ["Music Class"], { "Music Class": "Music" }
  );
  assert.deepEqual(out.soft.map((r) => r[2]), ["Shared · Music"]);
});

test("bucketEvents three-way: a per-calendar prefix leads every note label", () => {
  // The caller passes the resolved prefix (a calLabelOverride like "Fam" or the
  // calendar's display name); bucketEvents just prepends it to each note.
  const out = bucketEvents(
    [timed("Music Class")], "RULE", CREW_BLOCK, "Fam", ["Music Class"], {}
  );
  assert.equal(out.soft.length, 1);
  assert.ok(out.soft[0][2].startsWith("Fam · "), out.soft[0][2]);
  assert.equal(out.soft[0][2], "Fam · Music Class");
});

test("bucketEvents three-way: notes match EXACTLY, not by stem", () => {
  // "Music Class" is noted; "Music Class Recital" is a DIFFERENT title and must
  // NOT be auto-noted — a new title defaults to Ignore.
  const out = bucketEvents(
    [timed("Music Class"), timed("Music Class Recital")],
    "RULE", CREW_BLOCK, "", ["Music Class"], {}
  );
  assert.deepEqual(out.soft.map((r) => r[2]), ["Music Class"]);
  assert.equal(out.commitments.length, 0);
});

test("bucketEvents three-way: blocks STILL match by stem (unchanged, safety-critical)", () => {
  // Ticking "Crew - Desk" must block a future, unseen "Crew - Night".
  const out = bucketEvents([timed("Crew - Night")], "RULE", CREW_BLOCK, "", [], {});
  assert.equal(out.commitments.length, 1, "a stem sibling of a blocked title must block");
  assert.equal(out.soft.length, 0);
});

// ---------------------------------------------------------------------------
// defaultRole — the first-run cascade for a user who has configured nothing
// ---------------------------------------------------------------------------

// Inverted deliberately (was FLAG): the primary calendar is the most sensitive
// one an account holds, and reading it was never something the user consented
// to. Nothing is read until it is explicitly turned on.
test("defaultRole: even the account's own primary calendar defaults to OFF", () => {
  assert.equal(defaultRole({ id: "p", summary: "user@example.com", primary: true }), "OFF");
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
  assert.equal(defaultRole(item), "OFF");
  assert.equal(defaultRole(item), "OFF");
  assert.equal(defaultRole(item), "OFF");
});

test("defaultRole: NO input ever defaults to anything but OFF", () => {
  const items = [
    { id: "p", summary: "user@example.com", primary: true },
    { id: "a", summary: "Shared Household" },
    { id: "c", summary: "" },
    {},
    null,
    undefined,
  ];
  for (const it of items) assert.equal(defaultRole(it), "OFF", `input ${JSON.stringify(it)}`);
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
  assert.equal(resolveRoles(items, { p: "BOGUS" })[0].role, "OFF");
  assert.equal(resolveRoles(items, { p: null })[0].role, "OFF");
  assert.equal(resolveRoles(items, { p: "reject" })[0].role, "OFF"); // case-sensitive
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

// First run for a brand-new user: sign in, configure nothing. NOTHING is
// enabled — not one calendar is fetched until the user turns it on.
test("resolveRoles: an unconfigured user gets OFF on every calendar, primary included", () => {
  const items = [
    { id: "p", summary: "user@example.com", primary: true },
    { id: "a", summary: "Shared Household" },
    { id: "b", summary: "Holidays in United States" },
    { id: "c", summary: "Crew Schedule" },
  ];
  const out = resolveRoles(items, {});
  assert.deepEqual(
    out.map((c) => c.role),
    ["OFF", "OFF", "OFF", "OFF"]
  );
  assert.equal(out.filter((c) => c.role !== "OFF").length, 0);
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
  // Primary now defaults to OFF, so the user has to have turned it on for this
  // path to exist at all.
  const cal = resolveRoles([{ id: "p", summary: "user@example.com", primary: true }], {
    p: "FLAG",
  })[0];
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
  // With nothing in the note set the unmarked titles are ignored (dropped), not
  // noted — the deliberate default. The safety point is the zero commitments.
  assert.equal(out.soft.length, 0);
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

// ---------------------------------------------------------------------------
// titleStem — the leading segment of a real calendar title
// ---------------------------------------------------------------------------

test("titleStem: splits on the spaced hyphen", () => {
  assert.equal(titleStem("ACME - Desk"), "ACME");
});

test("titleStem: splits on the em dash and the en dash too", () => {
  assert.equal(titleStem("ACME — Desk"), "ACME");
  assert.equal(titleStem("ACME – Desk"), "ACME");
});

test("titleStem: splits on colon-space", () => {
  assert.equal(titleStem("Standby: Ladder"), "Standby");
});

// The separator that wins is the EARLIEST BY POSITION, not the first entry in
// the separator list — otherwise "Standby: Ladder - 2" stems to the wrong half.
test("titleStem: the earliest separator by position wins", () => {
  assert.equal(titleStem("A: B - C"), "A");
  assert.equal(titleStem("A - B: C"), "A");
});

test("titleStem: a title with no separator is its own stem", () => {
  assert.equal(titleStem("Medic 1 Shift"), "Medic 1 Shift");
  assert.equal(titleStem("Tech rescue Training"), "Tech rescue Training");
});

test("titleStem: a bare hyphen without spaces is not a separator", () => {
  assert.equal(titleStem("Mid-morning drill"), "Mid-morning drill");
});

test("titleStem: whitespace and junk input degrade to an empty stem", () => {
  for (const bad of ["", "   ", null, undefined, 42, {}, [], " - Desk"]) {
    assert.equal(titleStem(bad), "", `input ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// titlesToMatcher — anchored, case-insensitive, word-boundary matching
// ---------------------------------------------------------------------------

test("titlesToMatcher: a ticked title matches its own siblings under the same stem", () => {
  const m = titlesToMatcher(["ACME - Desk"]);
  assert.equal(m("ACME - Desk"), true);
  assert.equal(m("ACME - Night Tour"), true);
  assert.equal(m("ACME"), true);
});

test("titlesToMatcher: matching is case-insensitive", () => {
  const m = titlesToMatcher(["ACME - Desk"]);
  assert.equal(m("acme - desk"), true);
  assert.equal(m("Acme — Overtime"), true);
});

// THE anti-test. An all-day memorial CONTAINS the stem but does not START with
// it. A substring rule would hard-reject every shift that day and the user
// would never be told why.
test("titlesToMatcher: a title that merely CONTAINS the stem does not match", () => {
  const m = titlesToMatcher(["ACME - Desk"]);
  assert.equal(m("Jordan Rivers - ACME Memorial 1944"), false);
  assert.equal(m("Dinner with the ACME crew"), false);
});

test("titlesToMatcher: the word boundary rejects a longer first word", () => {
  const m = titlesToMatcher(["ACME - Desk"]);
  assert.equal(m("ACMEX - Desk"), false);
  assert.equal(m("ACME2 shift"), false);
});

test("titlesToMatcher: a separator, space, or end-of-string all count as a boundary", () => {
  const m = titlesToMatcher(["ACME - Desk"]);
  assert.equal(m("ACME"), true);
  assert.equal(m("ACME Desk"), true);
  assert.equal(m("ACME: Desk"), true);
  assert.equal(m("ACME, Desk"), true);
});

// The match-everything bug, pinned from every direction it has ever appeared.
test("titlesToMatcher: an EMPTY ticked list matches NOTHING, never everything", () => {
  for (const input of [[], null, undefined, "not an array", {}]) {
    const m = titlesToMatcher(input);
    for (const t of ["ACME - Desk", "", "anything at all", "Dentist"]) {
      assert.equal(m(t), false, `${JSON.stringify(input)} / ${JSON.stringify(t)}`);
    }
  }
});

test("titlesToMatcher: blank and non-string entries are discarded, not honoured", () => {
  const m = titlesToMatcher(["", "   ", null, undefined, 7, " - leading separator "]);
  assert.equal(m("ACME - Desk"), false);
  assert.equal(m(""), false);
});

test("titlesToMatcher: a real entry still works alongside discarded junk", () => {
  const m = titlesToMatcher(["", null, "ACME - Desk"]);
  assert.equal(m("ACME - Night Tour"), true);
  assert.equal(m("Dentist"), false);
});

test("titlesToMatcher: regex metacharacters in a title are literal, not a pattern", () => {
  const m = titlesToMatcher(["C++ (Advanced): week 1"]);
  assert.equal(m("C++ (Advanced): week 4"), true);
  assert.equal(m("Cxx Advanced"), false);
  assert.doesNotThrow(() => titlesToMatcher(["*** [unclosed"])("anything"));
});

test("titlesToMatcher: a non-string event title never matches", () => {
  const m = titlesToMatcher(["ACME - Desk"]);
  for (const t of [null, undefined, 5, {}]) assert.equal(m(t), false);
});

test("titlesToMatcher: multiple ticked titles are OR-ed", () => {
  const m = titlesToMatcher(["ACME - Desk", "Standby: Ladder"]);
  assert.equal(m("ACME - Night Tour"), true);
  assert.equal(m("Standby: Engine"), true);
  assert.equal(m("Dentist"), false);
});

// End to end through the thing that actually decides a hard reject.
test("titlesToMatcher + bucketEvents: a ticked title hard-rejects, a memorial does not", () => {
  const events = [
    { summary: "ACME - Desk", start: { dateTime: "2026-08-15T08:00:00-04:00" }, end: { dateTime: "2026-08-16T08:00:00-04:00" } },
    { summary: "Jordan Rivers - ACME Memorial 1944", start: { date: "2026-08-15" }, end: { date: "2026-08-16" } },
  ];
  const out = bucketEvents(events, "RULE", titlesToMatcher(["ACME - Desk"]), "");
  assert.equal(out.commitments.length, 1);
  // The ticked title blocks; its triplet label is "" (no per-event override).
  assert.equal(out.commitments[0][2], "");
  // The memorial CONTAINS "ACME" but does not START with the stem, so it never
  // blocks — and, being unmarked (not in the note set), it is now ignored.
  assert.equal(out.soft.length, 0);
});

// ---------------------------------------------------------------------------
// calendarRule — the ticked titles ARE the blocking set
//
// REVERSED CONTRACT. This section used to assert that an empty ticked list fell
// back to the legacy regex. That was the defect: resolveIncludeRegex turns an
// absent pattern into the anchored default "^Work\b", so a RULE calendar the
// user had ticked NOTHING on silently hard-rejected every event titled "Work…"
// — while the options page told them, in three separate places, that such a
// calendar blocks nothing. It also made "I want nothing to block"
// unrepresentable: un-ticking everything stores [], which re-armed the regex.
//
// The regex now requires an explicit opt-in (the third argument, resolved from
// stored `ruleUsePattern` — see resolvePatternOptIn). The old assertion was not
// weakened; it was inverted, because the behaviour it pinned was wrong.
// ---------------------------------------------------------------------------

test("calendarRule: ticked titles take over from the regex", () => {
  const { rule, mode } = calendarRule(["ACME - Desk"], RULE, false);
  assert.equal(mode, "titles");
  assert.equal(rule("ACME - Night Tour"), true);
  assert.equal(rule("Work day"), false); // the regex would have matched this
});

test("calendarRule: ticked titles beat the regex even when the pattern IS armed", () => {
  const { rule, mode } = calendarRule(["ACME - Desk"], RULE, true);
  assert.equal(mode, "titles");
  assert.equal(rule("ACME - Night Tour"), true);
  assert.equal(rule("Work day"), false);
});

// THE FIX. Nothing ticked and no explicit opt-in ⇒ this calendar blocks nothing.
test("calendarRule: no ticked titles and no opt-in blocks NOTHING", () => {
  for (const input of [undefined, null, [], ["", "  "], "junk"]) {
    for (const optIn of [undefined, false]) {
      const { rule, mode } = calendarRule(input, RULE, optIn);
      assert.equal(mode, "none", JSON.stringify(input));
      // "Work day" is exactly what the leaked default regex used to catch.
      for (const t of ["Work day", "Work from home", "Dentist", ""]) {
        assert.equal(rule(t), false, `${JSON.stringify(input)} / ${JSON.stringify(t)}`);
      }
    }
  }
});

test("calendarRule: the regex applies only on an explicit opt-in", () => {
  const { rule, mode } = calendarRule([], RULE, true);
  assert.equal(mode, "regex");
  assert.equal(rule("Work day"), true);
  assert.equal(rule("Dentist"), false);
});

// A truthy-but-not-true opt-in is not an opt-in: storage is user data and may
// have been hand-edited, and arming a hard reject is not a coercion decision.
test("calendarRule: only a strict true arms the pattern hatch", () => {
  for (const loose of [1, "true", "yes", {}, []]) {
    const { mode, rule } = calendarRule([], RULE, loose);
    assert.equal(mode, "none", JSON.stringify(loose));
    assert.equal(rule("Work day"), false);
  }
});

// THE REQUIRED END-TO-END ASSERTION. A RULE calendar with [] ticked must produce
// ZERO commitments even when the events are titled exactly what the old leaked
// default matched.
test("calendarRule + bucketEvents: [] ticked yields ZERO commitments for 'Work…' events", () => {
  const { rule } = calendarRule([], RULE, false);
  const out = bucketEvents(
    [timed("Work day"), timed("Work from home"), timed("Dentist")],
    "RULE",
    rule,
    ""
  );
  assert.equal(out.commitments.length, 0, "an empty ticked list must block nothing");
  // Unmarked titles are now ignored, not noted — the deliberate default. The
  // required end-to-end assertion is the zero commitments above.
  assert.equal(out.soft.length, 0);
});

// Same shape, but through the real regex resolver rather than a hand-built one —
// this is the exact path that leaked: resolveIncludeRegex(undefined) hands back
// the anchored default, which used to become the rule for an untouched calendar.
test("calendarRule + resolveIncludeRegex: an unconfigured RULE calendar blocks nothing", () => {
  const { includeRe } = resolveIncludeRegex(undefined);
  const regexRule = (t) => ruleMatches(t, includeRe, []);
  assert.equal(regexRule("Work day"), true, "precondition: the default WOULD match");

  const { rule, mode } = calendarRule([], regexRule, false);
  assert.equal(mode, "none");
  const out = bucketEvents([timed("Work day"), timed("Work from home")], "RULE", rule, "");
  assert.equal(out.commitments.length, 0);
  // Unmarked ⇒ ignored (dropped), not noted. The point is the zero commitments.
  assert.equal(out.soft.length, 0);
});

// ---------------------------------------------------------------------------
// resolvePatternOptIn — what counts as "the user armed the pattern hatch"
// ---------------------------------------------------------------------------

test("resolvePatternOptIn: an untouched store is NOT an opt-in", () => {
  for (const store of [undefined, null, {}, "junk", 42, { calRoles: {} }]) {
    assert.equal(resolvePatternOptIn(store), false, JSON.stringify(store));
  }
});

test("resolvePatternOptIn: the explicit flag arms it", () => {
  assert.equal(resolvePatternOptIn({ ruleUsePattern: true }), true);
});

test("resolvePatternOptIn: only a strict true counts as the flag", () => {
  for (const loose of [1, "true", "yes", {}]) {
    assert.equal(resolvePatternOptIn({ ruleUsePattern: loose }), false, JSON.stringify(loose));
  }
});

// A pattern can only reach storage through handleSetRuleFilter, which refuses
// blank and invalid input — so a stored non-blank pattern IS a past explicit
// act. Honouring it is what stops the upgrade from silently disarming a working
// configuration; it is never an inference from EMPTINESS.
test("resolvePatternOptIn: a pattern stored before the flag existed still counts", () => {
  assert.equal(resolvePatternOptIn({ ruleInclude: "^On[- ]?Duty\\b" }), true);
});

test("resolvePatternOptIn: a blank or non-string stored pattern is not an opt-in", () => {
  for (const src of ["", "   ", null, 0, {}, []]) {
    assert.equal(resolvePatternOptIn({ ruleInclude: src }), false, JSON.stringify(src));
  }
});

// ---------------------------------------------------------------------------
// summarizeTitles — what the picker renders
// ---------------------------------------------------------------------------

const ev = (summary, startIso, endIso) => ({
  summary,
  start: { dateTime: startIso },
  end: { dateTime: endIso },
});

test("summarizeTitles: distinct titles with counts, most frequent first", () => {
  const out = summarizeTitles([
    ev("Desk", "2026-08-01T08:00:00-04:00", "2026-08-01T20:00:00-04:00"),
    ev("Drill", "2026-08-02T19:00:00-04:00", "2026-08-02T21:00:00-04:00"),
    ev("Desk", "2026-08-03T08:00:00-04:00", "2026-08-03T20:00:00-04:00"),
  ]);
  assert.deepEqual(
    out.map((t) => [t.title, t.count]),
    [["Desk", 2], ["Drill", 1]]
  );
});

test("summarizeTitles: typicalMinutes is the median, not the mean", () => {
  const out = summarizeTitles([
    ev("Desk", "2026-08-01T08:00:00-04:00", "2026-08-01T20:00:00-04:00"), // 720
    ev("Desk", "2026-08-03T08:00:00-04:00", "2026-08-03T20:00:00-04:00"), // 720
    ev("Desk", "2026-08-05T08:00:00-04:00", "2026-08-12T08:00:00-04:00"), // 10080 outlier
  ]);
  assert.equal(out[0].typicalMinutes, 720);
});

test("summarizeTitles: an all-day event reads as 1440 minutes", () => {
  const out = summarizeTitles([
    { summary: "Memorial", start: { date: "2026-08-15" }, end: { date: "2026-08-16" } },
  ]);
  assert.equal(out[0].typicalMinutes, 1440);
});

test("summarizeTitles: cancelled, blank-titled and startless events are dropped", () => {
  const out = summarizeTitles([
    { summary: "Desk", status: "cancelled", start: { date: "2026-08-01" }, end: { date: "2026-08-02" } },
    { summary: "   ", start: { date: "2026-08-01" }, end: { date: "2026-08-02" } },
    { summary: "No start", start: {}, end: {} },
  ]);
  assert.deepEqual(out, []);
});

test("summarizeTitles: titles are grouped verbatim, never pre-stemmed", () => {
  const out = summarizeTitles([
    ev("ACME - Desk", "2026-08-01T08:00:00-04:00", "2026-08-01T20:00:00-04:00"),
    ev("ACME - Night", "2026-08-02T20:00:00-04:00", "2026-08-03T08:00:00-04:00"),
  ]);
  assert.deepEqual(out.map((t) => t.title).sort(), ["ACME - Desk", "ACME - Night"]);
});

test("summarizeTitles: null/undefined event list is safe", () => {
  assert.deepEqual(summarizeTitles(null), []);
  assert.deepEqual(summarizeTitles(undefined), []);
});

// ---------------------------------------------------------------------------
// resolveRoles — the widened calendarList fields
// ---------------------------------------------------------------------------

test("resolveRoles: summaryOverride wins over summary for display, prefix and sort", () => {
  const out = resolveRoles(
    [{ id: "a", summary: "Owner's Name For It", summaryOverride: "My Squad" }],
    {}
  );
  assert.equal(out[0].summary, "My Squad");
  assert.equal(out[0].prefix, "My Squad");
});

test("resolveRoles: a blank summaryOverride falls back to summary", () => {
  const out = resolveRoles([{ id: "a", summary: "Crew Schedule", summaryOverride: "  " }], {});
  assert.equal(out[0].summary, "Crew Schedule");
});

test("resolveRoles: accessRole is carried through, defaulting to an empty string", () => {
  const out = resolveRoles(
    [
      { id: "a", summary: "Busy Only", accessRole: "freeBusyReader" },
      { id: "b", summary: "No Field" },
    ],
    {}
  );
  assert.equal(out[0].accessRole, "freeBusyReader");
  assert.equal(out[1].accessRole, "");
});

test("resolveRoles: selected is normalised to a boolean", () => {
  const out = resolveRoles([{ id: "a", summary: "X", selected: true }, { id: "b", summary: "Y" }], {});
  assert.equal(out[0].selected, true);
  assert.equal(out[1].selected, false);
});

test("resolveRoles: deleted and hidden calendars are filtered out", () => {
  const out = resolveRoles(
    [
      { id: "a", summary: "Gone", deleted: true },
      { id: "b", summary: "Hidden", hidden: true },
      { id: "c", summary: "Kept" },
      null,
    ],
    {}
  );
  assert.deepEqual(out.map((c) => c.id), ["c"]);
});

test("resolveRoles: sorting uses the override name, not the owner's name", () => {
  const out = resolveRoles(
    [
      { id: "z", summary: "Aardvark", summaryOverride: "Zulu" },
      { id: "a", summary: "Mango" },
    ],
    {}
  );
  assert.deepEqual(out.map((c) => c.id), ["a", "z"]);
});

// ---------------------------------------------------------------------------
// titleSampleWindow — which span the picker samples titles from
// ---------------------------------------------------------------------------

test("titleSampleWindow: an explicit valid window is honoured verbatim", () => {
  assert.deepEqual(titleSampleWindow("2026-08-01", "2026-08-31"), {
    start: "2026-08-01",
    end: "2026-08-31",
  });
});

test("titleSampleWindow: a missing, malformed or inverted window falls back around today", () => {
  const noon = Date.parse("2026-08-15T16:00:00Z"); // 12:00 NY
  for (const args of [
    [undefined, undefined],
    ["2026-08-01", undefined],
    ["08/01/2026", "08/31/2026"],
    ["2026-08-31", "2026-08-01"], // inverted
    [42, {}],
  ]) {
    const w = titleSampleWindow(args[0], args[1], noon);
    assert.equal(w.start, "2026-07-16", JSON.stringify(args));
    assert.equal(w.end, "2026-10-14", JSON.stringify(args));
  }
});

// ---------------------------------------------------------------------------
// titlesToMatcher — the whole realistic ticked set at once
//
// Every test above builds a matcher from one or two titles. This section builds
// it from a full multi-commitment calendar, because that is the shape that
// actually shipped the bug: a user whose calendar holds two departments' tours,
// numbered shifts, one-off trainings, AND unrelated personal events. A matcher
// that is correct for a single ticked title can still be wrong for nine.
//
// SYNTHETIC BY REQUIREMENT. This repo is public and its history is permanent,
// so the real stems and the real memorial's name are NOT reproduced here. The
// two structural properties that make the fixture load-bearing are preserved:
//
//   1. ACME is a proper substring of WESTACME. In the real data the two
//      department prefixes nest the same way. So stem "acme" must not swallow
//      "WESTACME - Drill" — a `includes`-style matcher would, and the test
//      would catch it.
//   2. The memorial CONTAINS a ticked stem mid-string but does not start with
//      one. Without that, the anti-substring assertion is vacuous: it would
//      pass even under a broken substring matcher.
// ---------------------------------------------------------------------------

// A ticked set with the same shape as a real medic/firefighter's calendar:
// two department prefixes, three numbered shifts, one separator-less one-off.
const TICKED_SET = [
  "ACME - Desk",
  "WESTACME - Drill",
  "WESTACME - Water Rescue Drill",
  "WESTACME - Eng Co Meeting",
  "WESTACME - Commissioners Meeting",
  "Medic 1 Shift",
  "Medic 2 Shift",
  "Medic 3 Shift",
  "Tech rescue Training",
];

// Real commitments. Failing to match ANY of these means the extension shows the
// user a shift that collides head-on with a tour he is already working.
const MUST_MATCH = [
  "ACME - Desk",
  "WESTACME - Drill",
  "WESTACME - Water Rescue Drill",
  "WESTACME - Eng Co Meeting",
  "WESTACME - Commissioners Meeting",
  "Medic 1 Shift",
  "Medic 2 Shift",
  "Medic 3 Shift",
  "Tech rescue Training",
];

// Not commitments. Matching any of these hard-rejects a day the user was free.
const MUST_NOT_MATCH = [
  // THE KEY CASE: an all-day memorial that CONTAINS a ticked stem but does not
  // START with it. Under a substring rule this blocks the entire day and the
  // user is never told why. It must not match.
  "Jordan Rivers - WESTACME Memorial 1944",
  "Music Class",
  "Session",
  "11 am session",
  "Cleaning ladies",
  "Tentative supervision meeting",
  "Relative's surgery",
  "Kid dentist",
];

test("titleStem: every title in a realistic ticked set reduces to the right stem", () => {
  assert.equal(titleStem("ACME - Desk"), "ACME");
  assert.equal(titleStem("WESTACME - Water Rescue Drill"), "WESTACME");
  assert.equal(titleStem("WESTACME - Commissioners Meeting"), "WESTACME");
  // No separator: the title is its own stem, which is what makes a one-off
  // tickable as itself rather than collapsing to a broad prefix.
  assert.equal(titleStem("Medic 1 Shift"), "Medic 1 Shift");
  assert.equal(titleStem("Tech rescue Training"), "Tech rescue Training");
});

test("titlesToMatcher: the full ticked set matches every real commitment", () => {
  const m = titlesToMatcher(TICKED_SET);
  for (const t of MUST_MATCH) {
    assert.equal(m(t), true, `must match: ${JSON.stringify(t)}`);
  }
});

test("titlesToMatcher: the full ticked set matches nothing it should not", () => {
  const m = titlesToMatcher(TICKED_SET);
  for (const t of MUST_NOT_MATCH) {
    assert.equal(m(t), false, `must NOT match: ${JSON.stringify(t)}`);
  }
});

test("titlesToMatcher: a nested stem does not swallow the longer one", () => {
  const m = titlesToMatcher(TICKED_SET);
  // "acme" is a prefix of "westacme". Anchoring means "WESTACME - Drill"
  // matches on its OWN stem, never on the shorter one.
  assert.equal(m("WESTACME - Drill"), true);
  // And the shorter stem alone must not reach the longer department's titles.
  const shortOnly = titlesToMatcher(["ACME - Desk"]);
  assert.equal(shortOnly("WESTACME - Drill"), false);
  assert.equal(shortOnly("WESTACME - Eng Co Meeting"), false);
});

test("titlesToMatcher: the full set is case-insensitive in both directions", () => {
  const m = titlesToMatcher(TICKED_SET);
  assert.equal(m("acme - desk"), true);
  assert.equal(m("WESTACME - DRILL"), true);
  assert.equal(m("westacme - water rescue drill"), true);
  assert.equal(m("MEDIC 2 SHIFT"), true);
  assert.equal(m("tech rescue training"), true);
  // Case folding must not widen the rule — the memorial still does not match.
  assert.equal(m("JORDAN RIVERS - WESTACME MEMORIAL 1944"), false);
});

test("titlesToMatcher: the full set still respects the word boundary", () => {
  const m = titlesToMatcher(TICKED_SET);
  assert.equal(m("ACMEX something"), false);
  assert.equal(m("WESTACMEX Drill"), false);
  assert.equal(m("Medic 1 Shifts Meeting"), false);
  // A separator, a space, or end-of-string after the stem all still match.
  assert.equal(m("ACME"), true);
  assert.equal(m("ACME - Night Tour"), true);
  assert.equal(m("ACME: Overtime"), true);
});

test("titlesToMatcher: an empty ticked set rejects the whole realistic corpus", () => {
  // A match-everything matcher would hard-reject every event on every ticked
  // calendar and hide every shift on the board. Pinned against the same corpus
  // the populated matcher is tested with, so a regression cannot slip through
  // on a title this section does not otherwise exercise.
  for (const input of [[], null, undefined]) {
    const m = titlesToMatcher(input);
    for (const t of [...MUST_MATCH, ...MUST_NOT_MATCH]) {
      assert.equal(m(t), false, `${JSON.stringify(input)} / ${JSON.stringify(t)}`);
    }
  }
});

test("titlesToMatcher: junk entries inside a real ticked set are discarded, not honoured", () => {
  const m = titlesToMatcher(["", "   ", null, undefined, 123, ...TICKED_SET]);
  // The junk must not have widened the rule...
  for (const t of MUST_NOT_MATCH) {
    assert.equal(m(t), false, `must NOT match: ${JSON.stringify(t)}`);
  }
  // ...and must not have suppressed the real entries either.
  for (const t of MUST_MATCH) {
    assert.equal(m(t), true, `must match: ${JSON.stringify(t)}`);
  }
});

// ---------------------------------------------------------------------------
// normalizeTitleWhitespace + non-ASCII whitespace in titles
//
// iCal/Outlook feed exports routinely write the separator with a NO-BREAK SPACE.
// Before this, such a title never stemmed — titleStem handed back the whole
// string — so the ticked title stopped matching its own siblings and the shift
// was offered as free while the user was on a tour. The failure was asymmetric
// (it depended on which of the two titles carried the odd character) and
// completely invisible.
//
// The escapes below are spelled out on purpose: a literal NBSP in source is
// indistinguishable from a space and the next reader would "tidy" it away.
// ---------------------------------------------------------------------------

const NBSP = "\u00A0"; // NO-BREAK SPACE
const NNBSP = "\u202F"; // NARROW NO-BREAK SPACE
const FIGSP = "\u2007"; // FIGURE SPACE
const ZWSP = "\u200B"; // ZERO WIDTH SPACE

test("normalizeTitleWhitespace: exotic spaces fold to ASCII, zero-width vanishes", () => {
  assert.equal(normalizeTitleWhitespace("ACME" + NBSP + "-" + NBSP + "Desk"), "ACME - Desk");
  assert.equal(normalizeTitleWhitespace("ACME" + NNBSP + "-" + NNBSP + "Desk"), "ACME - Desk");
  assert.equal(normalizeTitleWhitespace("ACME" + FIGSP + "-" + FIGSP + "Desk"), "ACME - Desk");
  assert.equal(normalizeTitleWhitespace("AC" + ZWSP + "ME - Desk"), "ACME - Desk");
  assert.equal(normalizeTitleWhitespace("ACME\t-\tDesk"), "ACME - Desk");
  assert.equal(normalizeTitleWhitespace("ACME  -  Desk"), "ACME - Desk");
});

test("normalizeTitleWhitespace: a non-string is an empty string, not a crash", () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(normalizeTitleWhitespace(bad), "", JSON.stringify(bad));
  }
});

// Leading/trailing spaces survive: titleStem needs a leading separator to stay
// at index 0 so " - Desk" still reads as an empty stem.
test("normalizeTitleWhitespace: does not trim", () => {
  assert.equal(normalizeTitleWhitespace(NBSP + "- Desk"), " - Desk");
});

test("titleStem: an NBSP-separated title stems exactly like the ASCII one", () => {
  assert.equal(titleStem("ACME" + NBSP + "-" + NBSP + "Desk"), "ACME");
  assert.equal(titleStem("ACME" + NNBSP + "—" + NNBSP + "Night Tour"), "ACME");
  assert.equal(titleStem("Standby:" + NBSP + "Ladder"), "Standby");
  // Still an empty stem when the NBSP-written separator opens the title.
  assert.equal(titleStem(NBSP + "-" + NBSP + "Desk"), "");
});

// THE ASYMMETRIC FAILURE, pinned from both directions.
test("titlesToMatcher: an NBSP ticked title matches its plain-space siblings", () => {
  const m = titlesToMatcher(["ACME" + NBSP + "-" + NBSP + "Desk"]);
  assert.equal(m("ACME - Night Tour"), true);
  assert.equal(m("ACME - Desk"), true);
  assert.equal(m("ACME"), true);
  // ...and the anti-substring guarantee is not lost in the process.
  assert.equal(m("Jordan Rivers - ACME Memorial 1944"), false);
  assert.equal(m("ACMEX - Desk"), false);
});

test("titlesToMatcher: a plain-space ticked title matches an NBSP event title", () => {
  const m = titlesToMatcher(["ACME - Desk"]);
  assert.equal(m("ACME" + NBSP + "-" + NBSP + "Night Tour"), true);
  assert.equal(m("ACME" + NNBSP + "Desk"), true);
  assert.equal(m("AC" + ZWSP + "ME - Night Tour"), true);
  // The memorial still must not match, whichever spaces it is written with.
  assert.equal(m("Jordan Rivers" + NBSP + "-" + NBSP + "ACME Memorial 1944"), false);
});

test("titlesToMatcher + bucketEvents: an NBSP tour still hard-rejects", () => {
  const events = [
    {
      summary: "ACME" + NBSP + "-" + NBSP + "Night Tour",
      start: { dateTime: "2026-08-15T20:00:00-04:00" },
      end: { dateTime: "2026-08-16T08:00:00-04:00" },
    },
  ];
  const out = bucketEvents(events, "RULE", titlesToMatcher(["ACME - Desk"]), "");
  assert.equal(out.commitments.length, 1, "an NBSP in the feed must not disarm the block");
  assert.equal(out.soft.length, 0);
});

// ---------------------------------------------------------------------------
// titlesToMatcher — the boundary test must be Unicode-aware
//
// /\w/ is ASCII-only, so for a Cyrillic, Greek or CJK title every following
// letter reads as a non-word character: the boundary protection evaporates and
// anchored matching silently degrades to bare prefix matching. All titles below
// are synthetic.
// ---------------------------------------------------------------------------

test("titlesToMatcher: the word boundary holds for a Cyrillic title", () => {
  const m = titlesToMatcher(["Смена - Пост"]);
  assert.equal(m("Смена - Ночь"), true); // sibling under the same stem
  assert.equal(m("Смена"), true); // end of string is a boundary
  assert.equal(m("Сменах - Ночь"), false); // longer word — must NOT match
  assert.equal(m("Сменаа"), false);
});

test("titlesToMatcher: the word boundary holds for a Greek title", () => {
  const m = titlesToMatcher(["Βάρδια - Γραφείο"]);
  assert.equal(m("Βάρδια - Νύχτα"), true);
  assert.equal(m("Βάρδιαα"), false);
});

test("titlesToMatcher: the word boundary holds for a CJK title", () => {
  const m = titlesToMatcher(["当直 - 夜勤"]);
  assert.equal(m("当直 - 日勤"), true);
  assert.equal(m("当直室"), false); // a longer word, not the ticked stem
});

test("titlesToMatcher: a non-Latin digit after the stem is still a word char", () => {
  const m = titlesToMatcher(["Смена"]);
  assert.equal(m("Смена٣"), false); // ARABIC-INDIC DIGIT THREE — \p{N}
  assert.equal(m("Смена, Ночь"), true); // punctuation IS a boundary
});

// ---------------------------------------------------------------------------
// resolveRoles — a hidden calendar must not silently lose its blocking role
//
// "Hide from list" in Google Calendar is a DISPLAY preference, not an
// unsubscribe. Dropping such a calendar here meant a stored REJECT stopped being
// consulted the moment the user tidied their sidebar: it silently stopped
// blocking AND vanished from the options page, so the failure was invisible and
// un-fixable. (listCalendars must also send showHidden=true, or Google never
// returns the item at all — covered in sw_handlers.test.js.)
// ---------------------------------------------------------------------------

test("resolveRoles: a hidden calendar KEEPS its stored REJECT role", () => {
  const out = resolveRoles([{ id: "h", summary: "Crew Schedule", hidden: true }], { h: "REJECT" });
  assert.equal(out.length, 1, "a hidden calendar with a blocking role must not disappear");
  assert.equal(out[0].role, "REJECT");
  assert.equal(out[0].hiddenInGoogle, true);
});

test("resolveRoles: a hidden calendar keeps a stored FLAG or RULE role too", () => {
  for (const role of ["FLAG", "RULE"]) {
    const out = resolveRoles([{ id: "h", summary: "Crew Schedule", hidden: true }], { h: role });
    assert.equal(out.length, 1, role);
    assert.equal(out[0].role, role);
  }
});

test("resolveRoles: an unconfigured or explicitly-OFF hidden calendar is still dropped", () => {
  const item = [{ id: "h", summary: "Crew Schedule", hidden: true }];
  assert.deepEqual(resolveRoles(item, {}), []);
  assert.deepEqual(resolveRoles(item, { h: "OFF" }), []);
  assert.deepEqual(resolveRoles(item, { h: "BOGUS" }), []);
});

test("resolveRoles: a deleted calendar is dropped even when it has a REJECT role", () => {
  const out = resolveRoles([{ id: "d", summary: "Gone", deleted: true }], { d: "REJECT" });
  assert.deepEqual(out, []);
});

test("resolveRoles: hiddenInGoogle is false for a normal calendar", () => {
  const out = resolveRoles([{ id: "a", summary: "Crew Schedule" }], { a: "REJECT" });
  assert.equal(out[0].hiddenInGoogle, false);
});

// The hidden calendar's events must actually reach the commitment list — the
// point of keeping it is that it goes on blocking.
test("resolveRoles + bucketEvents: a hidden REJECT calendar still produces commitments", () => {
  const cal = resolveRoles([{ id: "h", summary: "Crew Schedule", hidden: true }], {
    h: "REJECT",
  })[0];
  const out = bucketEvents([timed("Night Tour")], cal.role, () => false, cal.prefix);
  assert.equal(out.commitments.length, 1);
  // A REJECT commitment's triplet label is the per-event "show as" or "" — the
  // reject chip uses the user's global commitment label, not the calendar name.
  assert.equal(out.commitments[0][2], "");
});

test("defaultRole: no input of any shape yields REJECT, FLAG or RULE", () => {
  const inputs = [
    null,
    undefined,
    {},
    { id: "p", summary: "user@example.com", primary: true },
    { id: "p2", primary: true },
    { id: "a", summary: "ACME Tours" },
    { id: "b", summary: "", primary: false },
    { id: "c", accessRole: "owner", primary: true, selected: true },
    { id: "d", summaryOverride: "Renamed", primary: true },
    { primary: "yes" },
    { primary: 1 },
    [],
    "not an object",
    42,
  ];
  for (const it of inputs) {
    const role = defaultRole(it);
    assert.equal(role, "OFF", `input ${JSON.stringify(it)}`);
    for (const bad of ["REJECT", "FLAG", "RULE"]) {
      assert.notEqual(role, bad, `input ${JSON.stringify(it)} must not be ${bad}`);
    }
  }
});
