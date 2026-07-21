import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { monthOf, viewOk, skillOk } from "../core/w2wstate.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);

// --- monthOf ---------------------------------------------------------------

test("monthOf finds a synthetic month/year header", () => {
  const html = '<span id="nmThisMonth">March  2027</span> ... March  2027 Tradeboard ...';
  assert.deepEqual(monthOf(html), ["March", 2027]);
});

test("monthOf returns [null, null] when there is no header (not a bare null)", () => {
  assert.deepEqual(monthOf("<html>nothing here</html>"), [null, null]);
});

// --- viewOk ------------------------------------------------------------

test("viewOk is true when the named view is Selected", () => {
  const html = 'name="MTBView" onChange="x"><option value="Drop" Selected>Show Drops Only</option>';
  assert.equal(viewOk(html, "Drop"), true);
});

test("viewOk is false when a different view is Selected", () => {
  const html = 'name="MTBView"><option value="All" Selected>Show All</option>';
  assert.equal(viewOk(html, "Drop"), false);
});

test("viewOk spans newlines within the window (Python compiles with re.S)", () => {
  const html = 'name="MTBView"\n<option value="Drop"\nSelected>Drop</option>';
  assert.equal(viewOk(html, "Drop"), true);
});

test("viewOk respects the 800-char window between the marker and value=", () => {
  const near = 'name="MTBView"' + "x".repeat(750) + 'value="All" Selected';
  const far = 'name="MTBView"' + "x".repeat(850) + 'value="All" Selected';
  assert.equal(viewOk(near, "All"), true);
  assert.equal(viewOk(far, "All"), false);
});

// --- skillOk -----------------------------------------------------------

test("skillOk is true when All Positions (-1) is Selected", () => {
  const html = 'name="EmpListSkill"><option value="-1"  Selected>All Positions</option>';
  assert.equal(skillOk(html), true);
});

test("skillOk is false when a different skill filter is Selected", () => {
  const html = 'name="EmpListSkill"><option value="-2" Selected>My Positions</option>';
  assert.equal(skillOk(html), false);
});

test("skillOk respects the 400-char window between the marker and value=", () => {
  const near = 'name="EmpListSkill"' + "x".repeat(350) + 'value="-1" Selected';
  const far = 'name="EmpListSkill"' + "x".repeat(450) + 'value="-1" Selected';
  assert.equal(skillOk(near), true);
  assert.equal(skillOk(far), false);
});

// --- real board shape: fixtures/board-2026-08.anon.html --------------------
// A real W2W monthly tradeboard page, anonymized by tools/scrub-fixtures.mjs:
// markup untouched, every identity string replaced. Ground truth for this page
// is monthOf -> ["August", 2026], viewOk("All") -> true, viewOk("Drop") ->
// false, skillOk -> true.

test("real fixture board-2026-08.anon.html: monthOf identifies August 2026", () => {
  const html = readFileSync(new URL("board-2026-08.anon.html", FIXTURES), "utf8");
  assert.deepEqual(monthOf(html), ["August", 2026]);
});

test("real fixture board-2026-08.anon.html: viewOk('All') passes, viewOk('Drop') fails", () => {
  const html = readFileSync(new URL("board-2026-08.anon.html", FIXTURES), "utf8");
  assert.equal(viewOk(html, "All"), true);
  assert.equal(viewOk(html, "Drop"), false);
});

test("real fixture board-2026-08.anon.html: skillOk passes (All Positions selected)", () => {
  const html = readFileSync(new URL("board-2026-08.anon.html", FIXTURES), "utf8");
  assert.equal(skillOk(html), true);
});
