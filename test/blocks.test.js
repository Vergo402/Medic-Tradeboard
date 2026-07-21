import { test } from "node:test";
import { strict as assert } from "node:assert";
import { anyoneBlocks, calendarBlocks } from "../core/blocks.js";

// ---------------------------------------------------------------------------
// anyoneBlocks — the truth table the drawer's muted state and the options
// "nothing blocks" banner both depend on. Every row here is a promise made to
// the user: a false "nothing blocks" is noise, a missing one is the bug this
// module exists to fix, so the boundary between them is pinned exactly.
// ---------------------------------------------------------------------------

test("REJECT blocks", () => {
  assert.equal(anyoneBlocks({ a: "REJECT" }, {}, false), true);
});

test("RULE with at least one ticked title blocks", () => {
  assert.equal(anyoneBlocks({ a: "RULE" }, { a: ["Work"] }, false), true);
});

test("RULE with the pattern hatch armed blocks (even with no ticks)", () => {
  assert.equal(anyoneBlocks({ a: "RULE" }, {}, true), true);
});

test("RULE with no ticks and no pattern does NOT block", () => {
  assert.equal(anyoneBlocks({ a: "RULE" }, { a: [] }, false), false);
});

test("RULE with no ticks and no pattern (titles absent) does NOT block", () => {
  assert.equal(anyoneBlocks({ a: "RULE" }, {}, false), false);
});

test("all-OFF does not block", () => {
  assert.equal(anyoneBlocks({ a: "OFF", b: "OFF" }, {}, false), false);
});

test("all-FLAG does not block", () => {
  assert.equal(anyoneBlocks({ a: "FLAG", b: "FLAG" }, {}, false), false);
});

test("empty roles object does not block", () => {
  assert.equal(anyoneBlocks({}, {}, false), false);
});

test("undefined args do not block and do not throw", () => {
  assert.equal(anyoneBlocks(undefined, undefined, undefined), false);
});

test("a non-array in calBlockTitles is treated as no-ticks, not a crash", () => {
  // RULE calendar whose stored block-titles are corrupt (a string, not an
  // array): with no pattern armed this must be false, and must never throw.
  assert.equal(anyoneBlocks({ a: "RULE" }, { a: "not-an-array" }, false), false);
  assert.doesNotThrow(() => anyoneBlocks({ a: "RULE" }, { a: 42 }, false));
});

test("mixed roles: one FLAG plus one REJECT blocks", () => {
  assert.equal(anyoneBlocks({ a: "FLAG", b: "REJECT" }, {}, false), true);
});

// A few defensive extras beyond the required table.

test("mixed: RULE with ticks alongside OFF blocks", () => {
  assert.equal(anyoneBlocks({ a: "OFF", b: "RULE" }, { b: ["Shift"] }, false), true);
});

test("non-object calRoles (array, string, number) does not block", () => {
  assert.equal(anyoneBlocks(["REJECT"], {}, false), false);
  assert.equal(anyoneBlocks("REJECT", {}, false), false);
  assert.equal(anyoneBlocks(42, {}, false), false);
});

test("non-object calBlockTitles falls back to empty, does not throw", () => {
  assert.equal(anyoneBlocks({ a: "RULE" }, "nope", false), false);
  assert.equal(anyoneBlocks({ a: "RULE" }, "nope", true), true);
});

test("ruleUsePattern only counts when strictly true", () => {
  // A truthy-but-not-true value (e.g. a leftover 1) must not arm the hatch.
  assert.equal(anyoneBlocks({ a: "RULE" }, {}, 1), false);
  assert.equal(anyoneBlocks({ a: "RULE" }, {}, "true"), false);
});

// ---------------------------------------------------------------------------
// calendarBlocks — the per-calendar predicate options.js delegates to.
// ---------------------------------------------------------------------------

test("calendarBlocks: REJECT true; OFF/FLAG false", () => {
  assert.equal(calendarBlocks("REJECT", [], false), true);
  assert.equal(calendarBlocks("OFF", ["x"], true), false);
  assert.equal(calendarBlocks("FLAG", ["x"], true), false);
});

test("calendarBlocks: RULE gated on ticks or the pattern hatch", () => {
  assert.equal(calendarBlocks("RULE", ["x"], false), true);
  assert.equal(calendarBlocks("RULE", [], true), true);
  assert.equal(calendarBlocks("RULE", [], false), false);
  assert.equal(calendarBlocks("RULE", undefined, false), false);
  assert.equal(calendarBlocks("RULE", "not-an-array", false), false);
});
