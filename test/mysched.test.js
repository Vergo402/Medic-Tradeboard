import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { parseMysched, fallbackFromTradeboard } from "../core/mysched.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);

// --- parseMysched --------------------------------------------------------
// The three page shapes parseMysched has to tell apart: a real (anonymized)
// empty "My Upcoming Shifts" page, a populated one whose row format has not
// been captured yet, and a page that is neither.

test("empty fixture parses to {status:'ok', schedule:[]}", () => {
  const html = readFileSync(new URL("mysched-future-empty.anon.html", FIXTURES), "utf8");
  assert.deepEqual(parseMysched(html), { status: "ok", schedule: [] });
});

test("a populated 'My Upcoming Shifts' page is 'unknown' (format not yet captured)", () => {
  // Synthetic populated page, same shape as test_populated_unseen_format_exits_3's fixture.
  const html =
    "<html>MY SCHEDULE My Upcoming Shifts Date/Time Position Desc " +
    "<tr><td>Sat 8/1 7:00am - 7:00pm</td><td>35 Medic 2</td></tr></html>";
  assert.deepEqual(parseMysched(html), { status: "unknown" });
});

test("a page with neither marker is 'unrecognized'", () => {
  assert.deepEqual(parseMysched("<html>Sign In</html>"), { status: "unrecognized" });
});

// --- fallbackFromTradeboard ------------------------------------------------
// Ground truth for the tradeboard-derived fallback schedule: which record
// kinds count as "mine", and how a midnight-spanning tour is normalized.

test("fallback: my_shift is included, open is excluded, overnight rolls to next day", () => {
  const records = [
    {
      date: "2026-08-01", start: "19:00", end: "07:00", position: "35 Medic 2",
      kind: "my_shift", w2w_id: "1", text: "Station B",
    },
    {
      date: "2026-08-02", start: "07:00", end: "19:00", position: "35 Medic 1",
      kind: "open", w2w_id: "2", text: "(Unassigned) Station A",
    },
  ];

  const out = fallbackFromTradeboard(records);

  // midnight-spanning night shift normalized to next-day end; open shift excluded
  assert.deepEqual(out, [["2026-08-01 19:00", "2026-08-02 07:00", "35 Medic 2 Station B"]]);
});

test("fallback: my_post is included too", () => {
  const records = [
    {
      date: "2026-08-03", start: "07:00", end: "19:00", position: "35 Medic 3",
      kind: "my_post", w2w_id: "3", text: "Station A",
    },
  ];

  assert.deepEqual(fallbackFromTradeboard(records), [
    ["2026-08-03 07:00", "2026-08-03 19:00", "35 Medic 3 Station A"],
  ]);
});

test("fallback: records with no start are excluded", () => {
  const records = [
    {
      date: "2026-08-04", start: "", end: "", position: "35 Medic 4",
      kind: "my_shift", w2w_id: "4", text: "No start",
    },
  ];

  assert.deepEqual(fallbackFromTradeboard(records), []);
});

test("fallback: equal start/end times roll to the next day (24h tour, <= not <)", () => {
  const records = [
    {
      date: "2026-08-05", start: "07:00", end: "07:00", position: "35 Medic 5",
      kind: "my_shift", w2w_id: "5", text: "Equal Times",
    },
  ];

  assert.deepEqual(fallbackFromTradeboard(records), [
    ["2026-08-05 07:00", "2026-08-06 07:00", "35 Medic 5 Equal Times"],
  ]);
});
