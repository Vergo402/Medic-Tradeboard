/**
 * END TO END: a real .ics feed → the real service-worker handlers → the real
 * scorer → the chip a user actually sees.
 *
 * Every other suite tests one seam. This one tests that the seams line up:
 * core/ics.js parses the feed, sw.js buckets it into commitment triplets and
 * caches them, core/score.js merges and evaluates them against shifts parsed
 * from a REAL (anonymized) tradeboard capture, and core/rowshape.js turns the
 * verdict into the chip. Nothing between the .ics bytes and the chip is stubbed
 * — only the two things that genuinely cannot run offline: `chrome` and the
 * network fetch.
 *
 * It exists because unit tests agreeing with each other is not the same as the
 * pipeline working. The failure this catches is a contract drifting at a seam
 * while both sides still pass their own tests.
 *
 * Board fixture: test/fixtures/board-2026-08.anon.html — scrubbed capture,
 * synthetic names only. The .ics bodies below are synthetic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// --- the two unavoidable fakes, installed before sw.js is imported ----------

let STORE = {};
let FEED_TEXT = {}; // feedId -> raw .ics
const FEED_HOST = "https://feeds.example.com";
const feedUrlFor = (id) => `${FEED_HOST}/${id}.ics`;

const listeners = [];
globalThis.chrome = {
  runtime: { lastError: undefined, onMessage: { addListener: (fn) => listeners.push(fn) } },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return keys in STORE ? { [keys]: STORE[keys] } : {};
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (k in STORE) out[k] = STORE[k];
          return out;
        }
        const out = { ...(keys || {}) };
        for (const k of Object.keys(keys || {})) if (k in STORE) out[k] = STORE[k];
        return out;
      },
      set: async (obj) => { Object.assign(STORE, obj); },
      remove: async (key) => { for (const k of [].concat(key)) delete STORE[k]; },
    },
  },
};
globalThis.fetch = async (url) => {
  const id = Object.keys(FEED_TEXT).find((k) => feedUrlFor(k) === url);
  if (!id) throw new Error("unexpected fetch: " + url);
  return { ok: true, status: 200, text: async () => FEED_TEXT[id] };
};

await import("../sw.js");
const onMessage = listeners[0];
const send = (msg) => new Promise((resolve) => onMessage(msg, {}, resolve));

const { parseMonth } = await import("../core/parse.js");
const { loadCommitments, evaluate, rankEligible } = await import("../core/score.js");
const { rejectChipLabel } = await import("../core/rowshape.js");

// --- fixtures ---------------------------------------------------------------

const BOARD = fs.readFileSync(new URL("./fixtures/board-2026-08.anon.html", import.meta.url), "utf8");
const WINDOW = { windowStart: "2026-08-01", windowEnd: "2026-08-31" };

// A real open shift from the capture: Sat 2026-08-01, 07:00–19:00, Medic 1.
const BLOCKED_SHIFT = "821325827";
// A real open shift a week later that nothing below touches.
const FREE_SHIFT = "821325917";

function ics(events) {
  const body = events.map((e, i) =>
    `BEGIN:VEVENT\r\nUID:e${i}@example.com\r\nSUMMARY:${e.summary}\r\n` +
    `DTSTART;TZID=America/New_York:${e.start}\r\nDTEND;TZID=America/New_York:${e.end}\r\n` +
    (e.rrule ? `RRULE:${e.rrule}\r\n` : "") + "END:VEVENT"
  ).join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

function reset() {
  STORE = {};
  FEED_TEXT = {};
}

/** Configure one feed exactly as the options page would. */
function addFeed({ id, name, role, blockLabel, events }) {
  STORE.feeds = (STORE.feeds || []).concat([{ id, kind: "url", url: feedUrlFor(id), name }]);
  STORE.calRoles = Object.assign({}, STORE.calRoles, { [id]: role });
  if (blockLabel) STORE.calBlockLabel = Object.assign({}, STORE.calBlockLabel, { [id]: blockLabel });
  FEED_TEXT[id] = ics(events);
}

/** The content script's scoring pass, verbatim in shape (see boot.js). */
async function scoreBoard() {
  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, true, "the feed must load: " + resp.error);
  const commitments = loadCommitments(resp.commitments);
  const records = parseMonth(BOARD, 2026, 8).records;
  const results = records.map((rec) => ({ ...rec, ...evaluate(rec, commitments, [], []) }));
  const { eligible, rejects } = rankEligible(results);
  return { resp, eligible, rejects, records };
}

// ---------------------------------------------------------------------------

test("e2e: an .ics commitment knocks out the shift it overlaps, and only that one", async () => {
  reset();
  addFeed({
    id: "crew", name: "Crew Schedule", role: "REJECT", blockLabel: "Fire Dept",
    events: [{ summary: "Night Tour", start: "20260801T080000", end: "20260801T180000" }],
  });

  const { eligible, rejects, records } = await scoreBoard();
  assert.ok(records.length > 0, "the board fixture must still parse");

  const blocked = rejects.find((r) => r.w2w_id === BLOCKED_SHIFT);
  assert.ok(blocked, "the overlapping shift must be rejected, not offered");
  assert.equal(blocked.rejectKind, "commitment");

  assert.ok(
    eligible.some((r) => r.w2w_id === FREE_SHIFT),
    "a shift the feed does not touch must stay eligible"
  );
});

test("e2e: the feed's own word is what the reject chip says", async () => {
  reset();
  addFeed({
    id: "crew", name: "Crew Schedule", role: "REJECT", blockLabel: "Fire Dept",
    events: [{ summary: "Night Tour", start: "20260801T080000", end: "20260801T180000" }],
  });

  const { rejects } = await scoreBoard();
  const blocked = rejects.find((r) => r.w2w_id === BLOCKED_SHIFT);
  assert.equal(blocked.rejectLabel, "Fire Dept");
  assert.equal(rejectChipLabel(blocked), "✕ Fire Dept");
});

test("e2e: a feed with no word falls back to the neutral default", async () => {
  reset();
  addFeed({
    id: "crew", name: "Crew Schedule", role: "REJECT",
    events: [{ summary: "Night Tour", start: "20260801T080000", end: "20260801T180000" }],
  });

  const { rejects } = await scoreBoard();
  const blocked = rejects.find((r) => r.w2w_id === BLOCKED_SHIFT);
  assert.equal(rejectChipLabel(blocked), "✕ Commitment");
});

// The reason the label is resolved per feed rather than globally: two feeds
// blocking two different shifts must produce two different chips.
test("e2e: two feeds produce two different chips on the shifts each one blocks", async () => {
  reset();
  addFeed({
    id: "crew", name: "Crew Schedule", role: "REJECT", blockLabel: "Fire Dept",
    events: [{ summary: "Night Tour", start: "20260801T080000", end: "20260801T180000" }],
  });
  addFeed({
    id: "fam", name: "Family", role: "REJECT", blockLabel: "Family",
    events: [{ summary: "Recital", start: "20260807T200000", end: "20260808T060000" }],
  });

  const { rejects } = await scoreBoard();
  assert.equal(rejectChipLabel(rejects.find((r) => r.w2w_id === BLOCKED_SHIFT)), "✕ Fire Dept");
  assert.equal(rejectChipLabel(rejects.find((r) => r.w2w_id === FREE_SHIFT)), "✕ Family");
});

// An unexpanded recurrence would leave the later tours looking free — the exact
// failure the parser's RRULE support exists to prevent, proven on a real board.
test("e2e: a weekly recurrence blocks every occurrence it lands on", async () => {
  reset();
  addFeed({
    id: "crew", name: "Crew Schedule", role: "REJECT", blockLabel: "Fire Dept",
    events: [{
      summary: "Night Tour", start: "20260801T080000", end: "20260801T180000",
      rrule: "FREQ=WEEKLY;COUNT=3",
    }],
  });

  const { resp } = await scoreBoard();
  assert.deepEqual(
    resp.commitments.map((c) => c[0]),
    ["2026-08-01 08:00", "2026-08-08 08:00", "2026-08-15 08:00"]
  );
});

// The failure policy, proven through the whole stack rather than at the handler.
test("e2e: a blocking feed that will not load yields no scoring at all", async () => {
  reset();
  addFeed({
    id: "crew", name: "Crew Schedule", role: "REJECT", blockLabel: "Fire Dept",
    events: [{ summary: "Night Tour", start: "20260801T080000", end: "20260801T180000" }],
  });
  FEED_TEXT.crew = "<html><body>Sign in to continue</body></html>";

  const resp = await send({ type: "getCalendarData", mode: "refresh", ...WINDOW });
  assert.equal(resp.ok, false, "scoring a board without a feed that can block it is the bug");
  assert.match(resp.error, /feed_failed/);
  assert.match(resp.error, /Crew Schedule/);
});

// A rest buffer is what turns "does not overlap" into "does not leave me enough
// time", and it has to survive the whole trip too.
test("e2e: a rest buffer rejects a shift that merely sits too close", async () => {
  reset();
  addFeed({
    id: "crew", name: "Crew Schedule", role: "REJECT", blockLabel: "Fire Dept",
    // Ends 06:00 on the 1st — clear of the 07:00 shift, but only by an hour.
    events: [{ summary: "Night Tour", start: "20260731T180000", end: "20260801T060000" }],
  });
  STORE.calBufferAfter = { crew: 10 };

  const { rejects } = await scoreBoard();
  const blocked = rejects.find((r) => r.w2w_id === BLOCKED_SHIFT);
  assert.ok(blocked, "a shift inside the rest window must be rejected");
  assert.equal(blocked.rejectKind, "buffer");
  assert.match(rejectChipLabel(blocked), /^✕ BUFFER/);
});
