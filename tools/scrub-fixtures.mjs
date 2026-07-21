#!/usr/bin/env node
/**
 * scrub-fixtures.mjs — turn private WhenToWork board captures into public,
 * committable test fixtures.
 *
 *   node tools/scrub-fixtures.mjs <source-dir> [--out <dir>] [--map <file>]
 *
 * The source directory is always supplied by the caller, so no path into a
 * private repo is ever baked into this file. Output defaults to
 * `test/fixtures/` next to this script.
 *
 * WHAT IT DOES
 *   Replaces every identity-bearing string in a capture — coworker names, the
 *   signed-in user's name, the employer, station/location names, the W2W
 *   session id, the org logo id — with a stable synthetic stand-in. The same
 *   real value always maps to the same fake value, so tests that depend on a
 *   name appearing twice keep working.
 *
 * WHAT IT DOES NOT DO
 *   It never touches HTML structure, attribute order or quoting, whitespace,
 *   shift ids, times, dates, or position strings. Every board file is re-parsed
 *   after scrubbing and every parsed field except `text` must be byte-identical
 *   to the pre-scrub parse, or the run aborts.
 *
 * SAFETY
 *   Output is assembled in memory and audited before a single byte is written.
 *   The audit fails the whole run — loudly, non-zero, no file written — if any
 *   real token survives, or if a person-shaped string appears that this script
 *   did not itself generate. It cannot emit a partially-scrubbed file.
 *
 * KNOWN LIMITS
 *   The fail-loud audit recognizes comma-form names ("Last, First"), the
 *   signed-in-user element, and every CCL anchor's bolded subject. A bare
 *   "First Last" sitting in a free text node is neither discovered nor caught —
 *   if W2W ever starts rendering names that way, teach discover() and
 *   RE_PERSON_SHAPE about it before trusting a new capture.
 *
 * DETERMINISM
 *   No randomness, no clock. Stand-ins are assigned from fixed pools indexed by
 *   the sorted order of the discovered originals, so the same input directory
 *   always yields byte-identical output.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { parseMonth } from "../core/parse.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, "../test/fixtures");

// ---------------------------------------------------------------------------
// Stand-in pools. Fixed, ordered, deliberately unlike any real roster.
// ---------------------------------------------------------------------------

const FAKE_SURNAMES = [
  "Alder", "Bramble", "Cardoza", "Dunlap", "Ellery", "Fairbank", "Garrick",
  "Holloway", "Ivers", "Jessup", "Kellner", "Lindqvist", "Mabry", "Norcross",
  "Okonkwo", "Prewitt", "Quill", "Rasmussen", "Stavros", "Thackeray",
];
const FAKE_GIVENS = [
  "Avery", "Blair", "Casey", "Devon", "Ellis", "Frankie", "Gale", "Harper",
  "Indigo", "Jordan", "Kai", "Logan", "Marlow", "Noel", "Oakley", "Parker",
  "Quinn", "Reese", "Sasha", "Tatum",
];
const FAKE_ORGS = [
  "Example County Paramedics EMS, Inc.",
  "Second Example Ambulance Service, Inc.",
];
const FAKE_STATIONS = [
  "Station A", "Station B", "Station C", "Station D", "Station E",
  "Station F", "Station G", "Station H",
];

// Words that carry no identity and must not be treated as leaked tokens.
const STOPWORDS = new Set([
  "inc", "station", "stations", "paramedics", "ambulance", "ems", "service",
  "the", "and", "of", "unassigned", "medic", "medics",
]);

class ScrubError extends Error {}

// ---------------------------------------------------------------------------
// Discovery — find every identity-bearing string in a capture.
// ---------------------------------------------------------------------------

const RE_ANCHOR = /on[Cc]lick="return CCL\(this,'[*#!$]\d+'\)"[^>]*class="\w+">([\s\S]*?)<\/a>/g;
const RE_ANCHOR_BOLD = /<b>([^<]+)<\/b>/;
const RE_TITLE_NAME = /<b class="title">([^<]+)<\/b>/g;
const RE_ORG = /<h3>([^<]+)<\/h3>/g;
const RE_SID = /(?:data-sid="([0-9A-Za-z]+)"|setCustomAttribute\('sessionid',\s*"([0-9A-Za-z]+)")/g;
const RE_LOGO = /\/logo\/([0-9A-Za-z]+)\.(?:PNG|png|gif|jpe?g)/g;
const NBSP_GAP = /&nbsp;&nbsp;/;

/** Normalize a person name to an identity key, so "Doe, Jane" === "Jane Doe". */
function personKey(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Scan one document and add whatever identity strings it holds to `found`.
 * `found` accumulates across all files so stand-ins stay consistent between
 * fixtures that mention the same person.
 */
function discover(html, found) {
  for (const [, raw] of html.matchAll(RE_TITLE_NAME)) found.people.add(raw.trim());
  for (const [, raw] of html.matchAll(RE_ORG)) found.orgs.add(raw.trim());
  for (const m of html.matchAll(RE_SID)) found.sids.add(m[1] || m[2]);
  for (const [, id] of html.matchAll(RE_LOGO)) found.logos.add(id);

  RE_ANCHOR.lastIndex = 0;
  for (const [, inner] of html.matchAll(RE_ANCHOR)) {
    // Anchor text is "<who> &nbsp;&nbsp; <where>". <who> is a person only when
    // it is bolded; the open-shift form is the literal "(Unassigned)".
    const parts = inner.split(NBSP_GAP);
    const who = parts[0] ?? "";
    const where = parts.slice(1).join(" ");

    const bold = who.match(RE_ANCHOR_BOLD);
    if (bold) {
      found.people.add(bold[1].trim());
    } else if (!/^\s*\(Unassigned\)\s*$/.test(stripTags(who))) {
      throw new ScrubError(
        `Unrecognized anchor subject ${JSON.stringify(stripTags(who))} — this ` +
          `script cannot tell whether it is a person. Refusing to write a ` +
          `possibly-unscrubbed fixture; teach discover() this shape first.`
      );
    }

    const loc = stripTags(where).trim();
    if (loc) found.locations.add(loc);
  }
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Mapping — deterministic real -> fake assignment.
// ---------------------------------------------------------------------------

function take(pool, index, label) {
  if (index >= pool.length) {
    throw new ScrubError(
      `Ran out of stand-ins for ${label} (need ${index + 1}, pool holds ${pool.length}). ` +
        `Extend the pool; do not reuse an entry.`
    );
  }
  return pool[index];
}

function buildMapping(found) {
  const map = { people: new Map(), orgs: new Map(), locations: new Map(), sids: new Map(), logos: new Map() };

  // People: one stand-in per identity, shared by every spelling of that person.
  const byIdentity = new Map();
  for (const raw of [...found.people].sort()) {
    const key = personKey(raw);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(raw);
  }
  [...byIdentity.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .forEach(([, spellings], i) => {
      const surname = take(FAKE_SURNAMES, i, "person surnames");
      const given = take(FAKE_GIVENS, i, "person given names");
      for (const raw of spellings) {
        // Preserve the surface form: "Last, First" stays comma-first.
        map.people.set(raw, raw.includes(",") ? `${surname}, ${given}` : `${given} ${surname}`);
      }
    });

  [...found.orgs].sort().forEach((raw, i) => map.orgs.set(raw, take(FAKE_ORGS, i, "organizations")));

  [...found.locations].sort().forEach((raw, i) => {
    const fake = take(FAKE_STATIONS, i, "locations");
    // Keep SHOUTING locations shouting so casing-sensitive code still sees it.
    map.locations.set(raw, raw === raw.toUpperCase() ? fake.toUpperCase() : fake);
  });

  [...found.sids].sort().forEach((raw) => map.sids.set(raw, "0".repeat(raw.length)));
  [...found.logos].sort().forEach((raw, i) => map.logos.set(raw, `EXAMPLELOGO${i}`));

  return map;
}

/** Every string the scrubber is allowed to have produced. */
function allowedOutputs(map) {
  return new Set([
    ...map.people.values(),
    ...map.orgs.values(),
    ...map.locations.values(),
    ...map.sids.values(),
    ...map.logos.values(),
  ]);
}

/** Identity-bearing words that must not survive anywhere in the output. */
function secretTokens(map) {
  const tokens = new Set();
  const addWords = (s) => {
    for (const w of s.split(/[^A-Za-z0-9]+/)) {
      const lower = w.toLowerCase();
      if (lower.length >= 3 && !STOPWORDS.has(lower) && !/^\d+$/.test(lower)) tokens.add(lower);
    }
  };
  for (const s of map.people.keys()) addWords(s);
  for (const s of map.orgs.keys()) addWords(s);
  for (const s of map.locations.keys()) addWords(s);
  for (const s of map.sids.keys()) tokens.add(s.toLowerCase());
  for (const s of map.logos.keys()) tokens.add(s.toLowerCase());
  // Never flag a word the stand-ins themselves contain.
  for (const fake of allowedOutputs(map)) {
    for (const w of fake.split(/[^A-Za-z0-9]+/)) tokens.delete(w.toLowerCase());
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Substitution — longest-first literal replacement, structure untouched.
// ---------------------------------------------------------------------------

function scrub(html, map) {
  let out = html;
  const pairs = [
    ...map.orgs.entries(),
    ...map.people.entries(),
    ...map.locations.entries(),
    ...map.sids.entries(),
    ...map.logos.entries(),
  ].sort((a, b) => b[0].length - a[0].length);

  for (const [real, fake] of pairs) out = out.split(real).join(fake);
  return out;
}

// ---------------------------------------------------------------------------
// Audit — the gate. Nothing is written unless every check passes.
// ---------------------------------------------------------------------------

const RE_PERSON_SHAPE = /[A-Z][a-z]+(?:['’\-][A-Za-z]+)?,\s*[A-Z][a-z]+\.?/g;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_PHONE = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;

function audit(name, output, map) {
  const fail = (msg) => {
    throw new ScrubError(`${name}: ${msg}`);
  };
  const allowed = allowedOutputs(map);
  const lower = output.toLowerCase();

  for (const token of secretTokens(map)) {
    if (new RegExp(`(?<![a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(lower)) {
      fail(`real token "${token}" survived scrubbing`);
    }
  }

  for (const m of output.match(RE_PERSON_SHAPE) ?? []) {
    if (!allowed.has(m)) fail(`unrecognized person-shaped string ${JSON.stringify(m)} in output`);
  }
  for (const m of output.match(RE_EMAIL) ?? []) fail(`email address ${JSON.stringify(m)} in output`);
  for (const m of output.match(RE_PHONE) ?? []) fail(`phone number ${JSON.stringify(m)} in output`);

  for (const [, inner] of output.matchAll(RE_TITLE_NAME)) {
    if (!allowed.has(inner.trim())) fail(`signed-in user name ${JSON.stringify(inner)} not scrubbed`);
  }
  RE_ANCHOR.lastIndex = 0;
  for (const [, inner] of output.matchAll(RE_ANCHOR)) {
    const bold = inner.match(RE_ANCHOR_BOLD);
    if (bold && !allowed.has(bold[1].trim())) {
      fail(`anchor name ${JSON.stringify(bold[1])} not scrubbed`);
    }
  }
}

/** Board captures must parse to exactly the same records, `text` aside. */
function auditStructure(name, before, after, ym) {
  if (!ym) return;
  const a = parseMonth(before, ym.year, ym.month);
  const b = parseMonth(after, ym.year, ym.month);
  if (a.anchors !== b.anchors) {
    throw new ScrubError(`${name}: anchor count changed (${a.anchors} -> ${b.anchors})`);
  }
  if (a.records.length !== b.records.length) {
    throw new ScrubError(`${name}: record count changed (${a.records.length} -> ${b.records.length})`);
  }
  const FIELDS = ["date", "start", "end", "position", "kind", "w2w_id", "css"];
  a.records.forEach((rec, i) => {
    for (const f of FIELDS) {
      if (rec[f] !== b.records[i][f]) {
        throw new ScrubError(
          `${name}: record ${i} field "${f}" changed (${JSON.stringify(rec[f])} -> ` +
            `${JSON.stringify(b.records[i][f])}) — scrubbing corrupted structure`
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** tb_2026-08.html -> board-2026-08.anon.html; mysched_x.html -> mysched-x.anon.html */
function outputNameFor(file) {
  let m = file.match(/^tb_(\d{4})-(\d{2})\.html$/);
  if (m) return { out: `board-${m[1]}-${m[2]}.anon.html`, ym: { year: +m[1], month: +m[2] } };
  m = file.match(/^mysched_(.+)\.html$/);
  if (m) return { out: `mysched-${m[1].replace(/_/g, "-")}.anon.html`, ym: null };
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { src: null, out: DEFAULT_OUT, map: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = resolve(argv[++i]);
    else if (argv[i] === "--map") args.map = resolve(argv[++i]);
    else if (!args.src) args.src = resolve(argv[i]);
    else throw new ScrubError(`unexpected argument ${JSON.stringify(argv[i])}`);
  }
  if (!args.src) {
    throw new ScrubError(
      "usage: node tools/scrub-fixtures.mjs <source-dir> [--out <dir>] [--map <file>]\n" +
        "  <source-dir>  directory holding the private tb_*.html / mysched_*.html captures\n" +
        "  --map         write the real->fake mapping here. MUST be outside this repo:\n" +
        "                it contains the real names and is a verification aid only."
    );
  }
  if (args.map && resolve(args.map).startsWith(resolve(HERE, "..") + "/")) {
    throw new ScrubError(
      `--map ${args.map} is inside this repository. The mapping holds real names ` +
        `and must never be written where it could be committed.`
    );
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const sources = readdirSync(args.src)
    .filter((f) => outputNameFor(f))
    .sort();
  if (sources.length === 0) throw new ScrubError(`no tb_*.html or mysched_*.html files in ${args.src}`);

  // Pass 1 — discover across the whole corpus so stand-ins are corpus-wide stable.
  const found = { people: new Set(), orgs: new Set(), locations: new Set(), sids: new Set(), logos: new Set() };
  const raw = new Map();
  for (const file of sources) {
    const html = readFileSync(join(args.src, file), "utf8");
    raw.set(file, html);
    discover(html, found);
  }
  const map = buildMapping(found);

  // Pass 2 — scrub and audit everything BEFORE writing anything.
  const staged = [];
  for (const file of sources) {
    const { out, ym } = outputNameFor(file);
    const scrubbed = scrub(raw.get(file), map);
    audit(out, scrubbed, map);
    auditStructure(out, raw.get(file), scrubbed, ym);
    staged.push({ out, scrubbed, ym });
  }

  if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });
  for (const { out, scrubbed, ym } of staged) {
    writeFileSync(join(args.out, out), scrubbed);
    const n = ym ? parseMonth(scrubbed, ym.year, ym.month).records.length : "-";
    console.log(`wrote ${basename(args.out)}/${out}  (${n} records)`);
  }

  if (args.map) {
    writeFileSync(
      args.map,
      JSON.stringify(
        {
          people: Object.fromEntries(map.people),
          orgs: Object.fromEntries(map.orgs),
          locations: Object.fromEntries(map.locations),
          sids: Object.fromEntries(map.sids),
          logos: Object.fromEntries(map.logos),
          secretTokens: [...secretTokens(map)].sort(),
        },
        null,
        2
      )
    );
    console.log(`wrote mapping to ${args.map} (contains real names — keep it out of any repo)`);
  }

  console.log(`scrubbed ${staged.length} fixture(s); all audits passed`);
}

try {
  main();
} catch (err) {
  if (err instanceof ScrubError) {
    console.error(`scrub-fixtures: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
