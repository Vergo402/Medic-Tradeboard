import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseMonth, mergeMonths, driftCheck } from "../core/parse.js";

// Resolve fixtures directory. The *.anon.html board captures are real W2W
// pages run through tools/scrub-fixtures.mjs — structure byte-for-byte intact,
// every name/employer/location replaced with a synthetic stand-in.
const FIX = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(FIX, "fixtures");

/**
 * Read a fixture file
 */
function readFixture(filename) {
  return readFileSync(join(FIXTURES_DIR, filename), "utf8");
}

test("corpus record counts", async (t) => {
  const corpus = [
    { filename: "board-2026-07.anon.html", year: 2026, month: 7, expected: 0 },
    { filename: "board-2026-08.anon.html", year: 2026, month: 8, expected: 20 },
    { filename: "board-2026-09.anon.html", year: 2026, month: 9, expected: 29 },
    { filename: "board-2026-10.anon.html", year: 2026, month: 10, expected: 8 },
  ];

  for (const { filename, year, month, expected } of corpus) {
    await t.test(`${filename} → ${expected} records`, () => {
      const html = readFixture(filename);
      const result = parseMonth(html, year, month);
      assert.equal(
        result.records.length,
        expected,
        `Expected ${expected} records in ${filename}, got ${result.records.length}`
      );
    });
  }
});

test("minimal fixture full content", () => {
  const html = readFixture("board-minimal.html");
  const result = parseMonth(html, 2026, 7);
  const recs = result.records;

  assert.equal(recs.length, 3, "Expected 3 records from minimal fixture");

  const [openRec, tradeRec, myRec] = recs;

  assert.deepEqual(openRec, {
    date: "2026-07-06",
    start: "07:00",
    end: "19:00",
    position: "35 Medic 9",
    kind: "open",
    w2w_id: "12345",
    css: "shiftUnassigned",
    text: "(Unassigned) Test Station 1",
  });

  assert.deepEqual(tradeRec, {
    date: "2026-07-06",
    start: "07:00",
    end: "19:00",
    position: "35 Medic 9",
    kind: "trade_post",
    w2w_id: "23456",
    css: "onTB",
    text: "Doe, Jane Test Station 1",
  });

  assert.deepEqual(myRec, {
    date: "2026-07-06",
    start: "07:00",
    end: "19:00",
    position: "35 Medic 9",
    kind: "my_shift",
    w2w_id: "34567",
    css: "myShift",
    text: "Smith, John Test Station 1",
  });
});

test("dedupe and merge by w2w_id (first wins)", () => {
  // Create mock records with duplicates
  const month1 = [
    {
      date: "2026-07-06",
      start: "07:00",
      end: "19:00",
      position: "35 Medic 9",
      kind: "open",
      w2w_id: "12345",
      css: "shiftUnassigned",
      text: "First Occurrence",
    },
  ];

  const month2 = [
    {
      date: "2026-07-13",
      start: "19:00",
      end: "07:00",
      position: "35 Medic 9",
      kind: "trade_post",
      w2w_id: "12345", // Duplicate w2w_id
      css: "onTB",
      text: "Duplicate (should be ignored)",
    },
    {
      date: "2026-07-20",
      start: "07:00",
      end: "19:00",
      position: "35 Medic 9",
      kind: "my_shift",
      w2w_id: "99999",
      css: "myShift",
      text: "New Entry",
    },
  ];

  const merged = mergeMonths([month1, month2]);

  assert.equal(merged.length, 2, "Expected 2 records after deduping");

  // First occurrence should win
  const dup = merged.find((r) => r.w2w_id === "12345");
  assert.equal(dup.text, "First Occurrence");
  assert.equal(dup.kind, "open");

  // New entry should be present
  const newEntry = merged.find((r) => r.w2w_id === "99999");
  assert.equal(newEntry.text, "New Entry");
});

test("merge sorts by (date, start||'')", () => {
  const records = [
    {
      date: "2026-07-20",
      start: "19:00",
      position: "A",
      kind: "open",
      w2w_id: "3",
      css: "test",
      text: "Late same day",
      end: "07:00",
    },
    {
      date: "2026-07-06",
      start: "07:00",
      position: "A",
      kind: "open",
      w2w_id: "1",
      css: "test",
      text: "Early",
      end: "19:00",
    },
    {
      date: "2026-07-20",
      start: "07:00",
      position: "A",
      kind: "open",
      w2w_id: "2",
      css: "test",
      text: "Early same day",
      end: "19:00",
    },
    {
      date: "2026-07-20",
      start: null,
      position: "A",
      kind: "open",
      w2w_id: "4",
      css: "test",
      text: "No start time",
      end: null,
    },
  ];

  const merged = mergeMonths([records]);

  // Expected order: date asc, then start asc (null converts to "" which sorts before any non-empty string)
  assert.deepEqual(
    merged.map((r) => r.w2w_id),
    ["1", "4", "2", "3"],
    "Sort order should be by date, then start (null start comes before non-null)"
  );
});

test("dom-strategy attribute case: lowercased onclick= parses identically", async (t) => {
  // Chrome's HTML parser lowercases attribute names, so the "dom" scan
  // strategy (parse of serialized document.body.innerHTML) sees onclick=
  // where raw W2W HTML has onClick=. Validated against real Chrome
  // serialization on live captures — 58/58 records deeply equal; this test
  // pins the attribute-case half of that so the regex never regresses to
  // onClick-only.
  const corpus = [
    { filename: "board-minimal.html", year: 2026, month: 7, expected: 3 },
    { filename: "board-2026-08.anon.html", year: 2026, month: 8, expected: 20 },
    { filename: "board-2026-09.anon.html", year: 2026, month: 9, expected: 29 },
    { filename: "board-2026-10.anon.html", year: 2026, month: 10, expected: 8 },
  ];

  for (const { filename, year, month, expected } of corpus) {
    await t.test(`${filename} lowercased → ${expected} records`, () => {
      const raw = readFixture(filename);
      const lowered = raw.replaceAll('onClick="return CCL', 'onclick="return CCL');
      assert.notEqual(lowered, raw, `${filename} should contain onClick= anchors`);
      const fromRaw = parseMonth(raw, year, month);
      const fromLowered = parseMonth(lowered, year, month);
      assert.equal(fromLowered.records.length, expected);
      assert.deepEqual(fromLowered.records, fromRaw.records);
      assert.equal(fromLowered.anchors, fromRaw.anchors);
    });
  }
});

test("drift guard fires on zero records with anchors", () => {
  const html = readFixture("board-minimal.html");

  // Mutate HTML to break parsing (change "weekpubback" to "wkpubback")
  // This removes the "week" substring, breaking the content row detector
  const mutated = html.replace("weekpubback", "wkpubback");

  const result = parseMonth(mutated, 2026, 7);

  // Should have 0 records but 3 anchors
  assert.equal(result.records.length, 0, "Mutated fixture should have 0 records");
  assert.equal(result.anchors, 3, "Mutated fixture should still have 3 anchors");

  // driftCheck should fire
  assert.equal(driftCheck(result), true, "driftCheck should detect drift");
});

test("drift guard does NOT fire on mismatched counts (just warning)", () => {
  // A case where records != anchors but records > 0
  // (This is hard to construct from the fixture; just verify the logic)
  const parseResult = {
    records: [{ w2w_id: "123" }],
    anchors: 2,
  };

  // driftCheck should NOT fire (only fires if records==0 AND anchors>0)
  assert.equal(driftCheck(parseResult), false, "Mismatch alone should not trigger drift");
});

test("drift guard does not fire on zero anchors", () => {
  const parseResult = {
    records: [],
    anchors: 0,
  };

  // No drift if both are zero
  assert.equal(driftCheck(parseResult), false, "Zero records and zero anchors should not trigger drift");
});
