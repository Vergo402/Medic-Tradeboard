import test from "node:test";
import assert from "node:assert/strict";

import { parseIcs, IcsError } from "../core/ics.js";
import { buildTriplet, bucketEvents } from "../sw.js";

// Every fixture here is SYNTHETIC. This repo is public and its git history is
// permanent: no real calendar id, event title, or person's name may appear.
//
// The load-bearing assertion is parse -> buildTriplet == the Google REST path
// for equivalent input: an .ics event and the Google-shaped object it stands in
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

test("multi-day all-day keeps the feed's exclusive DTEND (matches Google)", () => {
  const r = parse(ev("UID:a\nDTSTART;VALUE=DATE:20260804\nDTEND;VALUE=DATE:20260807"));
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 00:00", "2026-08-07 00:00"]);
});

test("DURATION (no DTEND) computes the end — never a zero-length block", () => {
  const r = parse(ev("UID:a\nDTSTART;TZID=America/New_York:20260804T080000\nDURATION:PT10H"));
  assert.deepEqual(buildTriplet(r.events[0]), ["2026-08-04 08:00", "2026-08-04 18:00"]);
});

// ---------------------------------------------------------------------------
// Equivalence: ICS path == Google path for the SAME logical event
// ---------------------------------------------------------------------------

test("equivalence: timed ICS event == its Google-shaped twin", () => {
  const google = {
    summary: "S",
    status: "confirmed",
    start: { dateTime: "2026-08-04T08:00:00-04:00" },
    end: { dateTime: "2026-08-04T18:00:00-04:00" },
  };
  const r = parse(
    ev("UID:a\nSUMMARY:S\nDTSTART;TZID=America/New_York:20260804T080000\nDTEND;TZID=America/New_York:20260804T180000")
  );
  assert.deepEqual(buildTriplet(r.events[0]), buildTriplet(google));
});

test("equivalence: all-day ICS event == its Google-shaped twin", () => {
  const google = { summary: "S", start: { date: "2026-08-04" }, end: { date: "2026-08-05" } };
  const r = parse(ev("UID:a\nSUMMARY:S\nDTSTART;VALUE=DATE:20260804"));
  assert.deepEqual(buildTriplet(r.events[0]), buildTriplet(google));
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
