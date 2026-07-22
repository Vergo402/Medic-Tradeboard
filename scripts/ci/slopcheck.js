#!/usr/bin/env node
// Scan this repo's own prose/source for egregious LLM-"slop" tells listed in
// scripts/ci/banned-words.txt. Whole-word / whole-phrase, case-insensitive.
// Prints each hit as `path:line: <matched term>` and exits 1 on any hit (0 when
// clean) so the gate fails loud rather than warning quiet. Node stdlib only —
// this repo stays Python-free.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const EXTS = [".js", ".mjs", ".md", ".sh", ".css"];
const PRUNE_DIRS = new Set([".git", "node_modules", "dist", "assets"]);
const PRUNE_PATHS = ["test/fixtures"]; // scrubbed captures, not our prose

const terms = readFileSync(join(HERE, "banned-words.txt"), "utf8")
  .split("\n").map((l) => l.split("#")[0].trim()).filter(Boolean);
const pats = terms.map((t) => {
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return [t, new RegExp("\\b" + esc + "\\b", "i")];
});

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    const rel = relative(ROOT, p).split("\\").join("/");
    if (ent.isDirectory()) {
      if (PRUNE_DIRS.has(ent.name)) continue;
      if (PRUNE_PATHS.some((pp) => rel === pp || rel.startsWith(pp + "/"))) continue;
      yield* walk(p);
    } else if (EXTS.some((e) => ent.name.endsWith(e))) {
      yield p;
    }
  }
}

let hits = 0;
for (const file of [...walk(ROOT)].sort()) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const [term, pat] of pats) {
      if (pat.test(text)) { console.log(`${rel}:${i + 1}: ${term}`); hits++; }
    }
  });
}
if (hits) {
  console.error(`SLOPCHECK — ${hits} banned-word hit(s) (see scripts/ci/banned-words.txt)`);
  process.exit(1);
}
console.log("slopcheck: clean");
