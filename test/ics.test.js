import test from "node:test";
import assert from "node:assert/strict";

import { parseIcs, IcsError } from "../core/ics.js";
import { buildTriplet, bucketEvents } from "../sw.js";

// Every fixture here is SYNTHETIC. This repo is public and its git history is
// permanent: no real calendar id, event title, or person's name may appear.
//
// The load-bearing assertion is parse -> buildTriplet == the normalized calendar-feed path
// for equivalent input: an .ics event and the normalized object it stands in
// for must civil-ize to the SAME NY triplet, because everything below
// buildTriplet (scorer, drawer, picker) is unchanged by the ICS swap.

// 2026 DST anchors used below (US rules): spring-forward 2026-03-08 02:00,
// fall-back 2026-11-01 02:00. Verified calendar facts: 2026-03-01 and 2026-11-01
// are Sundays; 2026-03-02 is a Monday; 2026-03-10 is the 2nd Tuesday of March.

const W_MIN = "2026-01-01T00:00:00Z";
const W_MAX = "2027-06-01T00:00:00Z";

function ev(inner) {
  return `BEGIN:VEVENT\n${inner}\nEND:VEVENT`;
}
function parse(body, min = W_MIN, max = W_MAX) {
  const text =
    "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n" +
    "X-WR-CALNAME:Test Cal\nX-WR-TIMEZONE:America/New_York\n" +
    body +
    "\nEND:VCALENDAR\n";
  return parseIcs(text, min, max);
}
function tripsOf(res) {
  return res.events.map(buildTriplet);
}
function startsOf(res) {
  return res.events.map((e) => buildTriplet(e)[0]).sort();
}

// ---------------------------------------------------------------------------
// Timestamp normalization -> NY civil triplet
// ---------------------------------------------------------------------------

test("timed TZID=America/New_York civil-izes to the wall time as written", () => {
  const r = parse(
    ev("UID:a\nSUMMARY:S\nDTSTART;TZID=America/New_York:20260804T080000\nDTEND;TZID=America/New_York:20260804T180000")
  );
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 08:00", "2026-08-04 18:00"]);
});

test("UTC Z timed lands on NY wall time (EDT = -4 in August)", () => {
  const r = parse(ev("UID:a\nDTSTART:20260804T120000Z\nDTEND:20260804T220000Z"));
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 08:00", "2026-08-04 18:00"]);
});

test("floating (no TZID, no Z) is read as NY-local — the app's civil frame", () => {
  const r = parse(ev("UID:a\nDTSTART:20260804T080000\nDTEND:20260804T180000"));
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 08:00", "2026-08-04 18:00"]);
});

test("foreign TZID resolves to NY wall time (LA 08:00 = NY 11:00)", () => {
  const r = parse(
    ev("UID:a\nDTSTART;TZID=America/Los_Angeles:20260804T080000\nDTEND;TZID=America/Los_Angeles:20260804T090000")
  );
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 11:00", "2026-08-04 12:00"]);
});

test("all-day with omitted DTEND synthesizes an exclusive next-day end", () => {
  const r = parse(ev("UID:a\nDTSTART;VALUE=DATE:20260804"));
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 00:00", "2026-08-05 00:00"]);
});

test("multi-day all-day keeps the feed's exclusive DTEND", () => {
  const r = parse(ev("UID:a\nDTSTART;VALUE=DATE:20260804\nDTEND;VALUE=DATE:20260807"));
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 00:00", "2026-08-07 00:00"]);
});

test("DURATION (no DTEND) computes the end — never a zero-length block", () => {
  const r = parse(ev("UID:a\nDTSTART;TZID=America/New_York:20260804T080000\nDURATION:PT10H"));
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 08:00", "2026-08-04 18:00"]);
});

// ---------------------------------------------------------------------------
// Equivalence: ICS path == normalized path for the SAME logical event
// ---------------------------------------------------------------------------

test("equivalence: timed ICS event == its normalized twin", () => {
  const normalized = {
    summary: "S",
    status: "confirmed",
    start: { dateTime: "2026-08-04T08:00:00-04:00" },
    end: { dateTime: "2026-08-04T18:00:00-04:00" },
  };
  const r = parse(
    ev("UID:a\nSUMMARY:S\nDTSTART;TZID=America/New_York:20260804T080000\nDTEND;TZID=America/New_York:20260804T180000")
  );
  assert.deepEqual(buildTriplet(r.events[0]), buildTriplet(normalized));
});

test("equivalence: all-day ICS event == its normalized twin", () => {
  const normalized = { summary: "S", start: { date: "2026-08-04" }, end: { date: "2026-08-05" } };
  const r = parse(ev("UID:a\nSUMMARY:S\nDTSTART;VALUE=DATE:20260804"));
  assert.deepEqual(buildTriplet(r.events[0]), buildTriplet(normalized));
});

// ---------------------------------------------------------------------------
// Recurrence expansion
// ---------------------------------------------------------------------------

test("WEEKLY;BYDAY=MO,TH;COUNT=4 expands to the right four dates", () => {
  // DTSTART 2026-03-02 is a Monday.
  const r = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20260302T090000\nDTEND;TZID=America/New_York:20260302T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4")
  );
  assert.deepEqual(startsOf(r), [
    "2026-03-02 09:00", // Mon
    "2026-03-05 09:00", // Thu
    "2026-03-09 09:00", // Mon
    "2026-03-12 09:00", // Thu
  ]);
});

test("MONTHLY;BYDAY=2TU expands to each month's second Tuesday", () => {
  const r = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20260310T090000\nDTEND;TZID=America/New_York:20260310T100000\nRRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3")
  );
  assert.deepEqual(startsOf(r), ["2026-03-10 09:00", "2026-04-14 09:00", "2026-05-12 09:00"]);
});

test("YEARLY all-day (birthday) yields one occurrence per year in window", () => {
  const r = parse(ev("UID:a\nDTSTART;VALUE=DATE:20260227\nRRULE:FREQ=YEARLY"));
  assert.deepEqual(startsOf(r), ["2026-02-27 00:00", "2027-02-27 00:00"]);
});

test("EXDATE removes exactly the excluded occurrence", () => {
  const r = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20260302T090000\nDTEND;TZID=America/New_York:20260302T100000\nRRULE:FREQ=WEEKLY;COUNT=3\nEXDATE;TZID=America/New_York:20260309T090000")
  );
  assert.deepEqual(startsOf(r), ["2026-03-02 09:00", "2026-03-16 09:00"]);
});

test("COUNT bounds the series; UNTIL bounds it inclusively", () => {
  const c = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20260302T090000\nDTEND;TZID=America/New_York:20260302T100000\nRRULE:FREQ=DAILY;COUNT=3")
  );
  assert.equal(c.events.length, 3);
  const u = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20260302T090000\nDTEND;TZID=America/New_York:20260302T100000\nRRULE:FREQ=DAILY;UNTIL=20260304T235959Z")
  );
  assert.deepEqual(startsOf(u), ["2026-03-02 09:00", "2026-03-03 09:00", "2026-03-04 09:00"]);
});

test("window filter keeps only occurrences overlapping [timeMin,timeMax)", () => {
  const r = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20260302T090000\nDTEND;TZID=America/New_York:20260302T100000\nRRULE:FREQ=WEEKLY"),
    "2026-03-09T00:00:00Z",
    "2026-03-23T00:00:00Z" // exclusive
  );
  // In-window Mondays: Mar 9 and Mar 16 (Mar 23 is the exclusive upper bound).
  assert.deepEqual(startsOf(r), ["2026-03-09 09:00", "2026-03-16 09:00"]);
});

// ---------------------------------------------------------------------------
// RECURRENCE-ID overrides (the advisor's mandatory case; 126 in the real feed)
// ---------------------------------------------------------------------------

test("a moved instance replaces the base occurrence at its old slot", () => {
  const master = ev(
    "UID:x\nDTSTART;TZID=America/New_York:20260302T080000\nDTEND;TZID=America/New_York:20260302T090000\nRRULE:FREQ=WEEKLY;COUNT=3"
  );
  const moved = ev(
    "UID:x\nRECURRENCE-ID;TZID=America/New_York:20260309T080000\nDTSTART;TZID=America/New_York:20260309T200000\nDTEND;TZID=America/New_York:20260309T210000"
  );
  const r = parse(master + "\n" + moved);
  // Mar 2 & Mar 16 keep 08:00; Mar 9's 08:00 base is gone, replaced by 20:00.
  assert.deepEqual(startsOf(r), ["2026-03-02 08:00", "2026-03-09 20:00", "2026-03-16 08:00"]);
});

test("a cancelled instance removes the occurrence entirely (via bucketEvents)", () => {
  const master = ev(
    "UID:x\nSUMMARY:Tour\nDTSTART;TZID=America/New_York:20260302T080000\nDTEND;TZID=America/New_York:20260302T090000\nRRULE:FREQ=WEEKLY;COUNT=3"
  );
  const cancelled = ev(
    "UID:x\nSUMMARY:Tour\nSTATUS:CANCELLED\nRECURRENCE-ID;TZID=America/New_York:20260309T080000\nDTSTART;TZID=America/New_York:20260309T080000\nDTEND;TZID=America/New_York:20260309T090000"
  );
  const r = parse(master + "\n" + cancelled);
  const out = bucketEvents(r.events, "REJECT", () => false, "");
  // The cancelled override is dropped by bucketEvents; the base at its slot is
  // suppressed. Two commitments survive: Mar 2 and Mar 16.
  assert.equal(out.commitments.length, 2);
  assert.deepEqual(out.commitments.map((c) => c[0]).sort(), ["2026-03-02 08:00", "2026-03-16 08:00"]);
});

// ---------------------------------------------------------------------------
// DST: recurrence keeps wall-clock; a single event keeps real elapsed time
// ---------------------------------------------------------------------------

test("weekly recurrence keeps its wall time across the fall-back transition", () => {
  // DTSTART 2026-10-30 (Fri, EDT) 08:00; next occurrence 2026-11-06 (EST) 08:00.
  const r = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20261030T080000\nDTEND;TZID=America/New_York:20261030T090000\nRRULE:FREQ=WEEKLY;COUNT=2")
  );
  assert.deepEqual(startsOf(r), ["2026-10-30 08:00", "2026-11-06 08:00"]);
  // Same wall time, but the two instants are 169h apart (an extra real hour from
  // the fall-back), which is what preserves true elapsed time downstream.
  const [a, b] = r.events.map((e) => Date.parse(e.start.dateTime));
  assert.equal((b - a) / 3600000, 169);
});

test("an event spanning the fall-back keeps real elapsed hours (not wall hours)", () => {
  // 2026-11-01 00:30 -> 03:30 crosses 02:00->01:00: 3 wall hours, 4 real hours.
  const r = parse(
    ev("UID:a\nDTSTART;TZID=America/New_York:20261101T003000\nDTEND;TZID=America/New_York:20261101T033000")
  );
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-11-01 00:30", "2026-11-01 03:30"]);
  const s = Date.parse(r.events[0].start.dateTime);
  const e = Date.parse(r.events[0].end.dateTime);
  assert.equal((e - s) / 3600000, 4);
});

// ---------------------------------------------------------------------------
// Loud failure: skip the one bad event with a named warning; feed stays usable
// ---------------------------------------------------------------------------

test("an unsupported RRULE part skips only that event, names it, keeps the rest", () => {
  const bad = ev("UID:a\nSUMMARY:Weird\nDTSTART;TZID=America/New_York:20260302T090000\nRRULE:FREQ=WEEKLY;BYSETPOS=1");
  const good = ev("UID:b\nSUMMARY:Fine\nDTSTART;TZID=America/New_York:20260305T090000\nDTEND;TZID=America/New_York:20260305T100000");
  const r = parse(bad + "\n" + good);
  assert.equal(r.events.length, 1, "the good event still loads");
  assert.equal(startsOf(r)[0], "2026-03-05 09:00");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Weird/);
  assert.match(r.warnings[0], /BYSETPOS/);
});

test("an unresolvable timezone skips the event loudly, never guesses a time", () => {
  const r = parse(ev("UID:a\nSUMMARY:Mars\nDTSTART;TZID=Mars/Phobos:20260302T090000\nDTEND;TZID=Mars/Phobos:20260302T100000"));
  assert.equal(r.events.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /unresolvable timezone: Mars\/Phobos/);
});

test("a non-iCalendar body throws (a fetched error page reads as broken, not empty)", () => {
  assert.throws(() => parseIcs("<html><body>404 Not Found</body></html>", W_MIN, W_MAX), IcsError);
});

test("STATUS:CANCELLED single events are carried through and dropped by bucketEvents", () => {
  const r = parse(ev("UID:a\nSTATUS:CANCELLED\nDTSTART;TZID=America/New_York:20260302T090000\nDTEND;TZID=America/New_York:20260302T100000"));
  assert.equal(r.events[0].status, "cancelled");
  const out = bucketEvents(r.events, "REJECT", () => false, "");
  assert.equal(out.commitments.length, 0);
});

// ---------------------------------------------------------------------------
// Integration with bucketEvents: recurrence -> commitments
// ---------------------------------------------------------------------------

test("a REJECT feed turns every expanded occurrence into a commitment", () => {
  const r = parse(
    ev("UID:a\nSUMMARY:Tour\nDTSTART;TZID=America/New_York:20260302T080000\nDTEND;TZID=America/New_York:20260302T180000\nRRULE:FREQ=WEEKLY;COUNT=3")
  );
  const out = bucketEvents(r.events, "REJECT", () => false, "");
  assert.equal(out.commitments.length, 3);
  // Each commitment row is [start, end, label, restBefore, restAfter].
  for (const c of out.commitments) assert.equal(c.length, 5);
});

// ---------------------------------------------------------------------------
// Calendar-level metadata (UI defaults)
// ---------------------------------------------------------------------------

test("X-WR-CALNAME and X-WR-TIMEZONE are surfaced as UI defaults", () => {
  const r = parse(ev("UID:a\nDTSTART;VALUE=DATE:20260804"));
  assert.equal(r.calName, "Test Cal");
  assert.equal(r.tz, "America/New_York");
});

// ---------------------------------------------------------------------------
// Adversarial regression pins (session-handoff 2026-07-25, 26 findings).
// Each .ics body below is the finding's VERBATIM reproducer — a full VCALENDAR,
// so it is fed straight to parseIcs (NOT through the local ev()/parse() helper,
// which would double-wrap it in its own BEGIN/END:VCALENDAR).
// ---------------------------------------------------------------------------

test("DTEND is resolved in its OWN zone, not naive civil-field subtraction against DTSTART's zone", () => {
  // Two mixed-zone VEVENTs in one feed: a UTC DTEND against an NY DTSTART, and an
  // LA DTEND against an NY DTSTART. Before the fix, computeEndShape threw away
  // DTEND's resolved zone and subtracted raw civil fields, so "Class" came out 4h
  // too long and "Call" collapsed to zero length.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:endz
SUMMARY:Class
DTSTART;TZID=America/New_York:20260315T080000
DTEND:20260315T170000Z
END:VEVENT
BEGIN:VEVENT
UID:endla
SUMMARY:Call
DTSTART;TZID=America/New_York:20260315T090000
DTEND;TZID=America/Los_Angeles:20260315T090000
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, W_MIN, W_MAX);
  assert.equal(r.warnings.length, 0);
  const [cls, call] = r.events;
  assert.deepEqual(buildTriplet(cls), ["2026-03-15 08:00", "2026-03-15 13:00"]); // 5h
  assert.deepEqual(buildTriplet(call), ["2026-03-15 09:00", "2026-03-15 12:00"]); // 3h
});

test("a spring-forward-gap start carries its shift onto the resolved duration", () => {
  // 02:30 NY on 2026-03-08 does not exist (spring-forward). Before the fix the
  // start took the pre-gap offset while the end (03:00, which DOES exist) took
  // the post-gap offset, inverting the event (end before start). The gap shift
  // must be carried onto a same-zone DTEND so the 30-minute duration holds.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:neg
SUMMARY:Med check
DTSTART;TZID=America/New_York:20260308T023000
DTEND;TZID=America/New_York:20260308T030000
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, W_MIN, W_MAX);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-03-08 03:30", "2026-03-08 04:00"]);
});

test("a quoted TZID param value is unquoted before zone resolution (DTSTART)", () => {
  // RFC 5545 3.1 allows a quoted-string param value; the DQUOTEs are delimiters,
  // not part of the zone name. Two independent findings hit the same DTSTART/DTEND
  // TZID-unquoting root cause on different VEVENTs — both pinned here.
  const drill = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:q
SUMMARY:Drill
DTSTART;TZID="America/New_York":20260315T080000
DTEND;TZID="America/New_York":20260315T200000
END:VEVENT
END:VCALENDAR`;
  const rDrill = parseIcs(drill, W_MIN, W_MAX);
  assert.equal(rDrill.warnings.length, 0);
  assert.equal(rDrill.events.length, 1);
  assert.deepEqual(buildTriplet(rDrill.events[0]), ["2026-03-15 08:00", "2026-03-15 20:00"]);

  const quotedTz = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:j
SUMMARY:QuotedTz
DTSTART;TZID="America/New_York":20260710T180000
DTEND;TZID="America/New_York":20260710T200000
END:VEVENT
END:VCALENDAR`;
  const rQ = parseIcs(quotedTz, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.equal(rQ.warnings.length, 0);
  assert.equal(rQ.events.length, 1);
  assert.deepEqual(buildTriplet(rQ.events[0]), ["2026-07-10 18:00", "2026-07-10 20:00"]);
});

test("a local (non-Z) UNTIL is resolved in DTSTART's own zone, not hardcoded NY", () => {
  // DTSTART is America/Los_Angeles; UNTIL=20260705T090000 carries no TZID/Z.
  // Resolving it hardcoded-NY truncated the series a day early because NY's
  // 09:00 local is earlier than LA's. Resolved in LA, Jul 5 09:00 PDT is kept.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:u
SUMMARY:Standby
DTSTART;TZID=America/Los_Angeles:20260703T090000
DTEND;TZID=America/Los_Angeles:20260703T100000
RRULE:FREQ=DAILY;UNTIL=20260705T090000
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, W_MIN, W_MAX);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(
    r.events.map((e) => buildTriplet(e)),
    [
      ["2026-07-03 12:00", "2026-07-03 13:00"],
      ["2026-07-04 12:00", "2026-07-04 13:00"],
      ["2026-07-05 12:00", "2026-07-05 13:00"],
    ]
  );
});

test("DURATION:P1D is NOMINAL (a calendar day, wall-clock preserving) across a DST transition", () => {
  // RFC 5545 3.3.6: day/week DURATION parts are nominal, not an exact 86400s.
  // Two independent findings hit the same nominal-vs-exact confusion.
  const camping = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:d
SUMMARY:Camping
DTSTART;TZID=America/New_York:20260307T200000
DURATION:P1D
END:VEVENT
END:VCALENDAR`;
  const rCamping = parseIcs(camping, W_MIN, W_MAX);
  assert.equal(rCamping.warnings.length, 0);
  assert.deepEqual(buildTriplet(rCamping.events[0]), ["2026-03-07 20:00", "2026-03-08 20:00"]);

  const nominalDay = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:e4
SUMMARY:NominalDay
DTSTART;TZID=America/New_York:20260307T120000
DURATION:P1D
END:VEVENT
END:VCALENDAR`;
  const rNominal = parseIcs(nominalDay, "2026-03-01T00:00:00-05:00", "2026-03-20T00:00:00-04:00");
  assert.equal(rNominal.warnings.length, 0);
  assert.deepEqual(buildTriplet(rNominal.events[0]), ["2026-03-07 12:00", "2026-03-08 12:00"]);
});

test("a MONTHLY rule selecting zero days in every month (Feb 30) returns [] promptly, no warnings, no hang", () => {
  // FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30 never lands on a real date. The
  // generator must terminate via its own outer-iteration cap even though it
  // never yields a single candidate for the consumer's own step guard to see.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:hang@t
SUMMARY:Feb 30 rule
DTSTART;TZID=America/New_York:20260215T090000
DTEND;TZID=America/New_York:20260215T100000
RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30
END:VEVENT
END:VCALENDAR`;
  const startedAt = Date.now();
  const r = parseIcs(text, "2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z");
  assert.ok(Date.now() - startedAt < 5000, "must return promptly, not spin to the generator's step cap");
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.warnings, []);
});

test("FREQ=DAILY honors BYDAY as a LIMIT — weekday-only rules exclude weekends", () => {
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:daily-byday@t
SUMMARY:Weekday day tour
DTSTART;TZID=America/New_York:20260706T090000
DTEND;TZID=America/New_York:20260706T100000
RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(startsOf(r), [
    "2026-07-06 09:00", // Mon
    "2026-07-07 09:00", // Tue
    "2026-07-08 09:00", // Wed
    "2026-07-09 09:00", // Thu
    "2026-07-10 09:00", // Fri
  ]); // no Sat 07-11, no Sun 07-12
});

test("MONTHLY BYDAY intersects with BYMONTHDAY, not replaces it (Friday the 13th)", () => {
  // RFC 5545 3.3.10 Notes 1/2: for MONTHLY/YEARLY, when both are present BYDAY
  // LIMITS the BYMONTHDAY expansion (an intersection), rather than BYDAY winning
  // outright and running every Friday.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:fri13@t
SUMMARY:Friday the 13th
DTSTART;TZID=America/New_York:20260213T090000
DTEND;TZID=America/New_York:20260213T100000
RRULE:FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z");
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(startsOf(r), ["2026-02-13 09:00", "2026-03-13 09:00"]);
});

test("FREQ=WEEKLY honors BYMONTH as a LIMIT — a seasonal weekly rule stays in-season", () => {
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:janmon@t
SUMMARY:January Monday drill
DTSTART;TZID=America/New_York:20260105T090000
DTEND;TZID=America/New_York:20260105T100000
RRULE:FREQ=WEEKLY;BYMONTH=1;BYDAY=MO
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z");
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(startsOf(r), [
    "2026-01-05 09:00",
    "2026-01-12 09:00",
    "2026-01-19 09:00",
    "2026-01-26 09:00",
  ]); // no February Mondays
});

test("an unparseable UNTIL skips the event loudly rather than becoming an unbounded series", () => {
  // Truncated seconds field: UNTIL=20260706T1400Z is not a valid DATE-TIME/DATE.
  // untilToMs must return null so the rule is rejected up front, not silently
  // treated as "no UNTIL was given".
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:baduntil@t
SUMMARY:Series that ended July 6
DTSTART;TZID=America/New_York:20260701T090000
DTEND;TZID=America/New_York:20260701T100000
RRULE:FREQ=DAILY;UNTIL=20260706T1400Z
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.deepEqual(r.events, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Series that ended July 6/);
  assert.match(r.warnings[0], /UNTIL=20260706T1400Z/);
});

test("an unparseable COUNT skips the event loudly rather than becoming an unbounded series", () => {
  // COUNT= (empty) parses as NaN; `count > NaN` is always false, so a naive
  // guard never fires. applyRulePart must reject a non-numeric COUNT up front.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:badcount@t
SUMMARY:Three-day series
DTSTART;TZID=America/New_York:20260701T090000
DTEND;TZID=America/New_York:20260701T100000
RRULE:FREQ=DAILY;COUNT=
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.deepEqual(r.events, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Three-day series/);
  assert.match(r.warnings[0], /COUNT=/);
});

test("an ordinal BYDAY is rejected for WEEKLY (and, by the same rule, for DAILY)", () => {
  // RFC 5545 3.3.10: the BYDAY numeric ordinal is only meaningful for
  // MONTHLY/YEARLY. FREQ=WEEKLY;BYDAY=2MO must be a named, loud skip rather
  // than silently reinterpreted as "every Monday".
  const weekly = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:w2mo@t
SUMMARY:Second Monday
DTSTART;TZID=America/New_York:20260713T090000
DTEND;TZID=America/New_York:20260713T100000
RRULE:FREQ=WEEKLY;BYDAY=2MO
END:VEVENT
END:VCALENDAR`;
  const rWeekly = parseIcs(weekly, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.deepEqual(rWeekly.events, []);
  assert.equal(rWeekly.warnings.length, 1);
  assert.match(rWeekly.warnings[0], /ordinal_byday_with_weekly/);

  // Same rule, DAILY side: encodes the documented parallel warning shape
  // (the core/ics.js frequency check names the offending FREQ in the reason).
  const daily = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:d2mo@t
SUMMARY:Second weekday
DTSTART;TZID=America/New_York:20260713T090000
DTEND;TZID=America/New_York:20260713T100000
RRULE:FREQ=DAILY;BYDAY=2MO
END:VEVENT
END:VCALENDAR`;
  const rDaily = parseIcs(daily, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.deepEqual(rDaily.events, []);
  assert.equal(rDaily.warnings.length, 1);
  assert.match(rDaily.warnings[0], /ordinal_byday_with_daily/);
});

test("an unresolvable RECURRENCE-ID timezone warns but does NOT change event flow (documented gap)", () => {
  // Per the module's design, an unresolvable EXDATE/RECURRENCE-ID key is a named
  // warning, not a silent change to which occurrences are emitted — it is NOT
  // treated the same as an unresolvable DTSTART timezone (which skips the whole
  // event). Concretely: the override event is still emitted, and the base
  // occurrence at that slot is NOT suppressed, so Jul 10 appears twice. This test
  // pins that current, documented behavior rather than demanding a flow change.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:s1
DTSTART;TZID=America/New_York:20260703T090000
DTEND;TZID=America/New_York:20260703T170000
RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=2
SUMMARY:Medic
END:VEVENT
BEGIN:VEVENT
UID:s1
RECURRENCE-ID;TZID=Mars/Phobos:20260710T090000
DTSTART;TZID=America/New_York:20260710T150000
DTEND;TZID=America/New_York:20260710T230000
SUMMARY:Medic moved
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^unresolvable_recurrence_id: Medic moved \(timezone Mars\/Phobos\)$/);
  const trips = r.events.map((e) => [e.summary, ...buildTriplet(e)]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(trips, [
    ["Medic", "2026-07-03 09:00", "2026-07-03 17:00"],
    ["Medic", "2026-07-10 09:00", "2026-07-10 17:00"], // base NOT suppressed
    ["Medic moved", "2026-07-10 15:00", "2026-07-10 23:00"], // override still emitted
  ]);
});

test("an unresolvable EXDATE timezone warns but does NOT change event flow (documented gap)", () => {
  // Same design as the RECURRENCE-ID case above: an EXDATE key the parser
  // cannot resolve is named in a warning; the exclusion it names is simply not
  // applied (the occurrence still appears) — pinning current behavior, not a
  // flow change.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:s2
DTSTART;TZID=America/New_York:20260703T090000
DTEND;TZID=America/New_York:20260703T170000
RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=2
EXDATE;TZID=Mars/Phobos:20260710T090000
SUMMARY:Medic
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^unresolvable_exdate: 20260710T090000 \(timezone Mars\/Phobos\)$/);
  assert.deepEqual(startsOf(r), ["2026-07-03 09:00", "2026-07-10 09:00"]); // exclusion NOT applied
});

test("RECURRENCE-ID;RANGE=THISANDFUTURE applies to one slot only (documented gap, not expanded)", () => {
  // RFC 5545 3.8.4.4 says RANGE=THISANDFUTURE should move the target instance AND
  // every later one. core/ics.js does not implement RANGE — it only suppresses
  // the single targeted occurrence — so later occurrences (Jul 17) keep the
  // pre-override wall time. This is an intentional, documented gap: RANGE is
  // parsed but not applied to more than the one slot. Pinning current behavior.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:s4
DTSTART;TZID=America/New_York:20260703T090000
DTEND;TZID=America/New_York:20260703T170000
RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3
SUMMARY:Medic
END:VEVENT
BEGIN:VEVENT
UID:s4
RECURRENCE-ID;TZID=America/New_York;RANGE=THISANDFUTURE:20260710T090000
DTSTART;TZID=America/New_York:20260710T140000
DTEND;TZID=America/New_York:20260710T220000
SUMMARY:Medic
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.equal(r.warnings.length, 0);
  const trips = r.events.map((e) => buildTriplet(e)).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(trips, [
    ["2026-07-03 09:00", "2026-07-03 17:00"], // untouched
    ["2026-07-10 14:00", "2026-07-10 22:00"], // moved slot itself
    ["2026-07-17 09:00", "2026-07-17 17:00"], // NOT carried forward (the gap)
  ]);
});

test("a quoted TZID on EXDATE/RECURRENCE-ID is unquoted, so the exclusion/override actually applies", () => {
  // Contrast with the Mars/Phobos cases above: HERE the zone is perfectly valid
  // once unquoted, so the fix (splitProp/unquote) makes the exclusion and the
  // override both take effect as intended, instead of reading as unresolvable.
  const exdate1 = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:s3
DTSTART;TZID=America/New_York:20260703T090000
DTEND;TZID=America/New_York:20260703T170000
RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=2
EXDATE;TZID="America/New_York":20260710T090000
SUMMARY:Medic
END:VEVENT
END:VCALENDAR`;
  const r1 = parseIcs(exdate1, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.equal(r1.warnings.length, 0);
  assert.deepEqual(startsOf(r1), ["2026-07-03 09:00"]); // Jul 10 excluded

  const exdate2 = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:m
SUMMARY:WeeklyEx
DTSTART;TZID=America/New_York:20260706T180000
DTEND;TZID=America/New_York:20260706T200000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID="America/New_York":20260713T180000
END:VEVENT
END:VCALENDAR`;
  const r2 = parseIcs(exdate2, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.equal(r2.warnings.length, 0);
  assert.deepEqual(startsOf(r2), ["2026-07-06 18:00", "2026-07-20 18:00", "2026-07-27 18:00"]); // Jul 13 excluded

  const recid = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:n
SUMMARY:WeeklyMaster
DTSTART;TZID=America/New_York:20260706T180000
DTEND;TZID=America/New_York:20260706T200000
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:n
SUMMARY:Moved Instance
RECURRENCE-ID;TZID="America/New_York":20260713T180000
DTSTART;TZID=America/New_York:20260713T090000
DTEND;TZID=America/New_York:20260713T110000
END:VEVENT
END:VCALENDAR`;
  const r3 = parseIcs(recid, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.equal(r3.warnings.length, 0);
  const trips = r3.events.map((e) => [e.summary, ...buildTriplet(e)]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(trips, [
    ["WeeklyMaster", "2026-07-06 18:00", "2026-07-06 20:00"],
    ["Moved Instance", "2026-07-13 09:00", "2026-07-13 11:00"], // replaces the base slot
    ["WeeklyMaster", "2026-07-20 18:00", "2026-07-20 20:00"],
  ].sort((a, b) => a[1].localeCompare(b[1])));
});

test("RFC 5545 TEXT escapes (\\, \\; \\n) are decoded in SUMMARY and X-WR-CALNAME", () => {
  const text = `BEGIN:VCALENDAR
X-WR-CALNAME:Alex\\, HFD Duty
BEGIN:VEVENT
UID:esc
SUMMARY:Medic Shift\\, Cortlandt\\; Tour 3\\nSecond line
DTSTART;TZID=America/New_York:20260710T180000
DTEND;TZID=America/New_York:20260710T200000
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.equal(r.warnings.length, 0);
  assert.equal(r.calName, "Alex, HFD Duty");
  assert.equal(r.events[0].summary, "Medic Shift, Cortlandt; Tour 3\nSecond line");
});

test("a floating DTSTART with a differently-zoned DTEND resolves each endpoint in its own zone", () => {
  // DTSTART has no TZID/Z (floating -> NY); DTEND is an explicit UTC instant.
  // The two are one real hour apart; the naive civil-subtraction bug (fixed
  // above for the TZID/TZID case) applied here too.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:h1
SUMMARY:FloatZ
DTSTART:20260710T180000
DTEND:20260710T230000Z
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-07-10 18:00", "2026-07-10 19:00"]);
});

test("one unbalanced BEGIN/END anywhere in the feed throws IcsError (never a quiet empty calendar)", () => {
  // The VTIMEZONE here is missing its END, leaving depth permanently off by one.
  // The nested VEVENT is itself well-formed; under no reading may the result be
  // a clean, empty parse.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:VEVENT
UID:b1
SUMMARY:Real Shift
DTSTART;TZID=America/New_York:20260710T180000
DTEND;TZID=America/New_York:20260710T200000
END:VEVENT
END:VCALENDAR`;
  assert.throws(
    () => parseIcs(text, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00"),
    (e) => e instanceof IcsError && /^unbalanced_component/.test(e.message)
  );
});

test("lowercase begin:/end: component delimiters are recognized (case-insensitive per RFC 5545 3.1)", () => {
  const text = `BEGIN:VCALENDAR
VERSION:2.0
begin:vevent
UID:g3
SUMMARY:LowerComp
DTSTART;TZID=America/New_York:20260710T180000
DTEND;TZID=America/New_York:20260710T200000
end:vevent
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.equal(r.warnings.length, 0);
  assert.equal(r.events.length, 1);
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-07-10 18:00", "2026-07-10 20:00"]);
});

test("lowercase BYDAY weekday tokens (and freq=/count=) are recognized case-insensitively", () => {
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:g4
SUMMARY:LowerRrule
DTSTART;TZID=America/New_York:20260706T180000
DTEND;TZID=America/New_York:20260706T200000
RRULE:freq=weekly;byday=mo,we;count=4
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(startsOf(r), [
    "2026-07-06 18:00", // Mon
    "2026-07-08 18:00", // Wed
    "2026-07-13 18:00", // Mon
    "2026-07-15 18:00", // Wed
  ]);
});

test("an unparseable DURATION skips the event loudly instead of degrading to zero length", () => {
  // "pt10h" is lowercase (parseDuration's regex is case-sensitive by design) and
  // so parses as null; computeEndShape must turn that into a named skip, not a
  // silent zero-length event ({kind:"fixed", ms:0}), which the "occurrence ends
  // at or before it starts" invariant would then also need to catch.
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:x
SUMMARY:LowerDur
DTSTART;TZID=America/New_York:20260710T180000
DURATION:pt10h
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(text, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.deepEqual(r.events, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /unparseable DURATION: pt10h/);

  // Documented parallel case: a value that DOES parse but resolves to zero or
  // negative (e.g. DURATION:P with every component omitted) must be rejected as
  // "non-positive DURATION", not silently accepted as a valid zero-length event.
  const nonPositive = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:zp
SUMMARY:EmptyDur
DTSTART;TZID=America/New_York:20260710T180000
DURATION:P
END:VEVENT
END:VCALENDAR`;
  const rNonPositive = parseIcs(nonPositive, "2026-07-01T00:00:00-04:00", "2026-08-01T00:00:00-04:00");
  assert.deepEqual(rNonPositive.events, []);
  assert.equal(rNonPositive.warnings.length, 1);
  assert.match(rNonPositive.warnings[0], /non-positive DURATION: P/);
});

// ---------------------------------------------------------------------------
// Adversarial-review regressions. Each one pins a defect an audit found against
// this parser: a silent partial expansion, a phantom or vanished occurrence, a
// mis-framed bound, or a whole-feed crash. The unifying contract is the module
// header's: nothing is dropped or invented in silence, and no single VEVENT can
// take the feed down.
// ---------------------------------------------------------------------------

test("YEARLY ordinal BYDAY with no BYMONTH counts from January, not within DTSTART's month", () => {
  // RFC 5545 3.3.10's own example, "every 20th Monday of the year". Under a
  // month-scoped reading nthWeekday(y, 5, MO, 20) finds no 20th Monday inside May
  // and the whole series vanished with no warning. Hand-checked: 1997-01-01 is a
  // Wednesday so the year's first Monday is Jan 6, and Jan 6 + 19 weeks (133 days)
  // = May 19; 1998 starts Thursday -> Jan 5 + 133 = May 18; 1999 starts Friday ->
  // Jan 4 + 133 = May 17. 09:00 floating = NY = 13:00Z under EDT.
  const text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:t10\r\nSUMMARY:T10\r\nDTSTART:19970519T090000\r\nDTEND:19970519T100000\r\nRRULE:FREQ=YEARLY;BYDAY=20MO\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const r = parseIcs(text, "1997-01-01T00:00:00Z", "2000-01-01T00:00:00Z");
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.events.map((e) => e.start.dateTime), [
    "1997-05-19T13:00:00.000Z",
    "1998-05-18T13:00:00.000Z",
    "1999-05-17T13:00:00.000Z",
  ]);
});

test("YEARLY non-ordinal BYDAY with no BYMONTH covers the whole year, not just DTSTART's month", () => {
  // The dangerous shape: month-scoping emitted the five January Thursdays and
  // nothing else, so the output looked plausible while ~48 commitments a year
  // went missing. 2026 opens AND closes on a Thursday, so it holds 53 of them.
  const text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:t11\r\nSUMMARY:T11\r\nDTSTART:20260101T090000\r\nDTEND:20260101T100000\r\nRRULE:FREQ=YEARLY;BYDAY=TH\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const r = parseIcs(text, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
  assert.deepEqual(r.warnings, []);
  const starts = r.events.map((e) => e.start.dateTime);
  assert.equal(starts.length, 53);
  assert.equal(starts[0], "2026-01-01T14:00:00.000Z");
  assert.equal(starts[52], "2026-12-31T14:00:00.000Z");
  // Each occurrence is resolved in ITS OWN offset rather than reusing DTSTART's:
  // 09:00 NY is 14:00Z under EST and 13:00Z under EDT. 2026 runs EDT 03-08..11-01,
  // leaving 10 EST Thursdays before it (5 Jan + 4 Feb + Mar 5) and 9 after
  // (4 Nov + 5 Dec) = 19, so 34 fall in EDT.
  assert.equal(starts.filter((s) => s.endsWith("T14:00:00.000Z")).length, 19);
  assert.equal(starts.filter((s) => s.endsWith("T13:00:00.000Z")).length, 34);
});

test("a date-only UNTIL ends the day in the EVENT'S zone, not a hardcoded NY end-of-day", () => {
  // NY 23:59:59 on Jul 10 is 2026-07-11T03:59:59Z, which is already Jul 11 in
  // Tokyo: the series emitted a fourth, phantom occurrence a full day past UNTIL.
  // The mirror error truncated a west-coast evening series a day early.
  const tokyo = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:t1\r\nSUMMARY:Tky\r\nDTSTART;TZID=Asia/Tokyo:20260708T090000\r\nDTEND;TZID=Asia/Tokyo:20260708T100000\r\nRRULE:FREQ=DAILY;UNTIL=20260710\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const rt = parseIcs(tokyo, "2026-07-01T00:00:00Z", "2026-07-20T00:00:00Z");
  assert.deepEqual(rt.warnings, []);
  assert.deepEqual(rt.events.map((e) => e.start.dateTime), [
    "2026-07-08T00:00:00.000Z", // Jul 8 09:00 Tokyo (UTC+9)
    "2026-07-09T00:00:00.000Z",
    "2026-07-10T00:00:00.000Z", // UNTIL day, inclusive; no Jul 11
  ]);
  // Westward: 22:00 LA on the UNTIL day is 05:00Z the NEXT day and used to fall
  // outside the NY bound, silently dropping the series' last occurrence.
  const la = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:t2\r\nSUMMARY:LA\r\nDTSTART;TZID=America/Los_Angeles:20260708T220000\r\nDTEND;TZID=America/Los_Angeles:20260708T230000\r\nRRULE:FREQ=DAILY;UNTIL=20260710\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const rl = parseIcs(la, "2026-07-01T00:00:00Z", "2026-07-20T00:00:00Z");
  assert.deepEqual(rl.warnings, []);
  assert.deepEqual(rl.events.map((e) => e.start.dateTime), [
    "2026-07-09T05:00:00.000Z", // Jul 8 22:00 PDT
    "2026-07-10T05:00:00.000Z",
    "2026-07-11T05:00:00.000Z", // Jul 10 22:00 PDT — the UNTIL day, kept
  ]);
});

test("a DATE-valued EXDATE on a timed series excludes by date; the reverse mismatch warns", () => {
  // Producer-invalid per RFC 5545 3.8.5.1, but common, and the majority of
  // importers honor it. It used to resolve to a "d<date>" key that could never
  // match a timed "t<ms>" occurrence, so the instance the user deleted stayed on
  // the calendar with no warning at all.
  const timed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:em1\r\nSUMMARY:MM1\r\nDTSTART;TZID=America/New_York:20260706T100000\r\nDTEND;TZID=America/New_York:20260706T110000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;VALUE=DATE:20260707\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const rt = parseIcs(timed, "2026-07-01T00:00:00Z", "2026-07-31T00:00:00Z");
  assert.deepEqual(rt.warnings, []);
  assert.deepEqual(rt.events.map((e) => e.start.dateTime), [
    "2026-07-06T14:00:00.000Z",
    "2026-07-08T14:00:00.000Z", // Jul 7 excluded
  ]);
  // A timed EXDATE against an ALL-DAY series names no single day to remove, so it
  // is refused loudly instead of being dropped on the floor.
  const allDay = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:em1b\r\nSUMMARY:AD\r\nDTSTART;VALUE=DATE:20260706\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;TZID=America/New_York:20260707T000000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const ra = parseIcs(allDay, "2026-07-01T00:00:00Z", "2026-07-31T00:00:00Z");
  assert.equal(ra.events.length, 3);
  assert.equal(ra.warnings.length, 1);
  assert.match(ra.warnings[0], /unresolvable_exdate: 20260707T000000 \(EXDATE value type does not match series\)/);
});

test("a type-mismatched RECURRENCE-ID warns instead of silently leaving a duplicate", () => {
  // A DATE-valued RECURRENCE-ID against a timed master suppresses nothing, so the
  // user sees the moved instance AND the base slot it was supposed to replace.
  // Matching across kinds would be a guess about which instant was replaced, so
  // the override still emits on its own and the mismatch is named.
  const text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:em2\r\nSUMMARY:MM2\r\nDTSTART;TZID=America/New_York:20260706T100000\r\nDTEND;TZID=America/New_York:20260706T110000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:em2\r\nSUMMARY:MovedMM2\r\nRECURRENCE-ID;VALUE=DATE:20260707\r\nDTSTART;TZID=America/New_York:20260707T120000\r\nDTEND;TZID=America/New_York:20260707T130000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const r = parseIcs(text, "2026-07-01T00:00:00Z", "2026-07-31T00:00:00Z");
  assert.equal(r.events.length, 4);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /unresolvable_recurrence_id: MovedMM2 \(value type does not match series\)/);
});

test("a huge DURATION skips only its own event; the rest of the feed survives", () => {
  // The endpoint overflowed the Date range and iso()/Intl threw a RangeError that
  // escaped parseIcs entirely, so one corrupt VEVENT destroyed the whole calendar
  // with an exception type the documented contract never promised.
  for (const bad of ["P99999999999999D", "PT9999999999999H"]) {
    const text = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Bad\r\nDTSTART:20260710T120000Z\r\nDURATION:${bad}\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Good\r\nDTSTART:20260711T120000Z\r\nDTEND:20260711T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const r = parseIcs(text, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.equal(r.events.length, 1, bad);
    assert.equal(r.events[0].summary, "Good", bad);
    assert.equal(r.warnings.length, 1, bad);
    assert.match(r.warnings[0], /skipped_event: "Bad" \(unsupported DURATION \(too large\)/, bad);
  }
  // The all-day branch reaches the overflow through zoneParts/Intl instead of
  // iso(), so it gets its own case rather than sharing the timed one.
  const week = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:BadW\r\nDTSTART;VALUE=DATE:20260710\r\nDURATION:P99999999999999W\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const rw = parseIcs(week, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z");
  assert.deepEqual(rw.events, []);
  assert.match(rw.warnings[0], /unsupported DURATION \(too large\): P99999999999999W/);
});

test("an impossible DATE-TIME field is a loud skip, never a rolled-over phantom event", () => {
  // Date.UTC normalizes overflow, so June 31 became a confirmed commitment on
  // July 1, hour 25 slid to the next morning, minute 75 became 13:15, and Feb 30
  // rolled clean out of the query window and vanished without a word.
  for (const v of ["20260631T120000Z", "20260710T250000Z", "20260710T127500Z", "20260230T120000Z"]) {
    const text = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Ghost\r\nDTSTART:${v}\r\nDTEND:20260710T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const r = parseIcs(text, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.deepEqual(r.events, [], v);
    assert.deepEqual(r.warnings, ['skipped_event: "Ghost" (unparseable DTSTART)'], v);
  }
});

test("an impossible all-day DATE is a loud skip, never an invalid \"2026-06-32\" literal", () => {
  // dateStr stamped the unvalidated fields straight through for the start while
  // addDaysYMD normalized the end, so the emitted pair was not even self
  // consistent — and nytime's parseCivil cannot resolve the start downstream.
  const text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Day32\r\nDTSTART;VALUE=DATE:20260632\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const r = parseIcs(text, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z");
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.warnings, ['skipped_event: "Day32" (unparseable DTSTART)']);
});

test("a leading UTF-8 BOM is stripped instead of being read as a broken component", () => {
  // Outlook/Windows exports carry one. It glued to the first line, so the
  // VCALENDAR wrapper never opened and a valid feed threw unbalanced_component —
  // loud, but pointing at the wrong cause.
  const text = "﻿BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Ok\r\nDTSTART:20260710T120000Z\r\nDTEND:20260710T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const r = parseIcs(text, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z");
  assert.deepEqual(r.warnings, []);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].start.dateTime, "2026-07-10T12:00:00.000Z");
});

test("a folded BEGIN:VCALENDAR line is accepted (the wrapper test runs after unfolding)", () => {
  // RFC 5545 3.1 permits a fold at any point in any content line, and every OTHER
  // folded line already worked; only the wrapper was tested against the raw text.
  const text = "BEGIN:VCAL\r\n ENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nDTSTART:20260710T120000Z\r\nDTEND:20260710T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const r = parseIcs(text, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z");
  assert.deepEqual(r.warnings, []);
  assert.equal(r.events.length, 1);
});

test("a body that merely quotes BEGIN:VCALENDAR mid-line throws, never a quiet empty calendar", () => {
  // A proxy or validator error page that echoes the marker it expected used to
  // pass the substring test and return {events:[]} — indistinguishable from a
  // healthy empty calendar, which makes every shift look free.
  const body = '{"error":"upstream said: expected BEGIN:VCALENDAR header","code":502}';
  assert.throws(() => parseIcs(body, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z"), (e) => e instanceof IcsError && /not_icalendar/.test(e.message));
  // The marker must be the whole first logical line, but ordinary trailing
  // whitespace and case variation stay acceptable.
  const ok = "begin:vcalendar  \r\nBEGIN:VEVENT\r\nSUMMARY:y\r\nDTSTART:20260710T120000Z\r\nDTEND:20260710T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  assert.equal(parseIcs(ok, "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z").events.length, 1);
});

test("YEARLY BYMONTH+ordinal BYDAY stays MONTH-scoped (the year-scoped path must not leak)", () => {
  // Discriminator for the branch added above: with BYMONTH present the ordinal is
  // month-relative per RFC 5545 3.3.10, so this is the first Thursday of NOVEMBER,
  // not of the year. 2026-11-01 is a Sunday -> Nov 5; 2027-11-01 is a Monday ->
  // Nov 4. DST ends on the first Sunday in November, so 2026-11-05 is already EST
  // (09:00 NY = 14:00Z) while 2027-11-04 still precedes the Nov 7 changeover and
  // is EDT (13:00Z) — the same own-offset resolution the year-scoped case checks.
  const text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ym\r\nSUMMARY:YM\r\nDTSTART;TZID=America/New_York:20261105T090000\r\nDTEND;TZID=America/New_York:20261105T100000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1TH\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const r = parseIcs(text, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z");
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.events.map((e) => e.start.dateTime), [
    "2026-11-05T14:00:00.000Z",
    "2027-11-04T13:00:00.000Z",
  ]);
});

// --- Round-3 adversarial findings -------------------------------------------

test("trailing whitespace on BEGIN:VEVENT/END:VEVENT never silently drops the event", () => {
  const r = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT \nSUMMARY:Spacey\nDTSTART:20260801T090000Z\nDTEND:20260801T170000Z\nEND:VEVENT \nEND:VCALENDAR\n",
    "2026-07-01T00:00:00Z", "2026-09-01T00:00:00Z");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].summary, "Spacey");
  assert.deepEqual(r.warnings, []);
});

test("a fully-lowercase begin:vcalendar wrapper is accepted (component names are case-insensitive)", () => {
  const r = parseIcs("begin:vcalendar\nbegin:vevent\nSUMMARY:LC\ndtstart:20260801T090000Z\ndtend:20260801T100000Z\nend:vevent\nend:vcalendar\n",
    "2026-07-01T00:00:00Z", "2026-09-01T00:00:00Z");
  assert.deepEqual([r.events.length, r.warnings.length], [1, 0]);
});

test("lowercase t/z in a DATE-TIME value is ABNF-legal and parses, not a skip", () => {
  const r = parse(ev("SUMMARY:lz\nDTSTART:20260801t090000z\nDTEND:20260801T100000Z"));
  assert.deepEqual(tripsOf(r), [["2026-08-01 05:00", "2026-08-01 06:00"]]);
  assert.deepEqual(r.warnings, []);
});

test("YEARLY BYMONTHDAY with no BYMONTH expands every month of the year, COUNT bounding it", () => {
  const r = parse(ev("SUMMARY:y15\nDTSTART;TZID=America/New_York:20260115T080000\nDTEND;TZID=America/New_York:20260115T090000\nRRULE:FREQ=YEARLY;BYMONTHDAY=15;COUNT=5"),
    "2026-01-01T00:00:00Z", "2031-01-01T00:00:00Z");
  assert.deepEqual(r.events.map((e) => e.start.dateTime), [
    "2026-01-15T13:00:00.000Z", "2026-02-15T13:00:00.000Z", "2026-03-15T12:00:00.000Z",
    "2026-04-15T12:00:00.000Z", "2026-05-15T12:00:00.000Z",
  ]);
  assert.deepEqual(r.warnings, []);
});

test("YEARLY BYDAY=FR;BYMONTHDAY=13 with no BYMONTH is every Friday the 13th", () => {
  const r = parse(ev("SUMMARY:fri13\nDTSTART;TZID=America/New_York:20260213T080000\nDTEND;TZID=America/New_York:20260213T090000\nRRULE:FREQ=YEARLY;BYDAY=FR;BYMONTHDAY=13;COUNT=4"),
    "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
  assert.deepEqual(r.events.map((e) => e.start.dateTime), [
    "2026-02-13T13:00:00.000Z", "2026-03-13T12:00:00.000Z",
    "2026-11-13T13:00:00.000Z", "2027-08-13T12:00:00.000Z",
  ]);
  assert.deepEqual(r.warnings, []);
});

test("a gapped DTSTART only drags a same-zone DTEND with it when honoring it as stated would invert", () => {
  // DTEND 05:00 is a real wall time after the gap: honored exactly as stated.
  const a = parse(ev("SUMMARY:GapValidEnd\nDTSTART;TZID=America/New_York:20260308T023000\nDTEND;TZID=America/New_York:20260308T050000"));
  assert.deepEqual(a.events.map((e) => [e.start.dateTime, e.end.dateTime]),
    [["2026-03-08T07:30:00.000Z", "2026-03-08T09:00:00.000Z"]]);
  // DTEND 03:00 was authored against the pre-gap clock (unshifted it precedes
  // the pushed start): pushed by the same gap, preserving the 30-min wall span.
  const b = parse(ev("SUMMARY:GapPreEnd\nDTSTART;TZID=America/New_York:20260308T023000\nDTEND;TZID=America/New_York:20260308T030000"));
  assert.deepEqual(b.events.map((e) => [e.start.dateTime, e.end.dateTime]),
    [["2026-03-08T07:30:00.000Z", "2026-03-08T08:00:00.000Z"]]);
  assert.deepEqual([a.warnings, b.warnings], [[], []]);
});

// --- Round-4 adversarial findings -------------------------------------------

test("a nested non-VALARM component's props never leak into the enclosing VEVENT", () => {
  const r = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Host\nDTSTART:20260710T100000Z\nDTEND:20260710T110000Z\nBEGIN:X-IMPOSTOR\nDTSTART:20260720T220000Z\nDTEND:20260720T230000Z\nEND:X-IMPOSTOR\nEND:VEVENT\nEND:VCALENDAR",
    "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.deepEqual(r.events.map((e) => [e.summary, e.start.dateTime, e.end.dateTime]),
    [["Host", "2026-07-10T10:00:00.000Z", "2026-07-10T11:00:00.000Z"]]);
  assert.deepEqual(r.warnings, []);
  // Ordering variant: the impostor block sits BEFORE the event's own DTEND.
  const v = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Host2\nDTSTART:20260710T100000Z\nBEGIN:VTODO\nDTSTART:20260701T220000Z\nDTEND:20260701T230000Z\nEND:VTODO\nDTEND:20260710T110000Z\nEND:VEVENT\nEND:VCALENDAR",
    "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.deepEqual(v.events.map((e) => [e.summary, e.start.dateTime]), [["Host2", "2026-07-10T10:00:00.000Z"]]);
  assert.deepEqual(v.warnings, []);
});

test("duplicate overrides for one recurrence instance: highest SEQUENCE wins, stale revision warns", () => {
  const r = parse(ev("UID:e1\nSUMMARY:Base\nDTSTART;TZID=America/New_York:20260706T100000\nDTEND;TZID=America/New_York:20260706T110000\nRRULE:FREQ=DAILY;COUNT=3")
    + "\n" + ev("UID:e1\nSUMMARY:OvrOld\nSEQUENCE:1\nRECURRENCE-ID;TZID=America/New_York:20260707T100000\nDTSTART;TZID=America/New_York:20260707T120000\nDTEND;TZID=America/New_York:20260707T130000")
    + "\n" + ev("UID:e1\nSUMMARY:OvrNew\nSEQUENCE:2\nRECURRENCE-ID;TZID=America/New_York:20260707T100000\nDTSTART;TZID=America/New_York:20260707T150000\nDTEND;TZID=America/New_York:20260707T160000"),
    "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z");
  assert.deepEqual(r.events.map((e) => [e.summary, e.start.dateTime]).sort(), [
    ["Base", "2026-07-06T14:00:00.000Z"],
    ["Base", "2026-07-08T14:00:00.000Z"],
    ["OvrNew", "2026-07-07T19:00:00.000Z"],
  ]);
  assert.deepEqual(r.warnings, ['duplicate_override: OvrOld (stale revision discarded)']);
});
