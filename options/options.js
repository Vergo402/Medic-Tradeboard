/**
 * Options page — "Your calendar feeds".
 *
 * SAFETY PREMISE. This page is the only place a user can say "this feed means I
 * am already committed". Until they do, NOTHING blocks: defaultRole() in sw.js
 * gives EVERY feed OFF, so a 24-hour tour on the user's own calendar happily
 * coexists with a shift ranked "top eligible". That is the failure this page
 * exists to fix, so two states are deliberately LOUD:
 *
 *   1. #loadBanner — we could not read the feeds at all. Never allowed to
 *      degrade into a calm empty list, because an empty list would render as
 *      "nothing is blocking" and hide the real cause.
 *   2. #noBlockBanner — feeds loaded, and none of them blocks anything.
 *
 * A feed counts as blocking only if its role is REJECT, or its role is RULE AND
 * (it has at least one ticked title OR the advanced pattern hatch is armed).
 * That last clause is why an unloaded RULE feed can still count: a stored
 * ruleUsePattern blocks via the regex regardless of what titles we have listed.
 * A RULE feed with nothing ticked and no pattern blocks nothing. This is the
 * shared core/blocks.js definition (see calBlocks below), the same one the
 * drawer uses, so the two surfaces cannot disagree.
 *
 * PRIVACY. Switching a feed on is the only thing that reads it. We never show
 * event counts on the feed list itself — that would require reading every feed
 * including the switched-off ones, breaking PRIVACY.md's promise that only
 * configured feeds are read. Counts appear inside the picker only, which is
 * reached only after a deliberate toggle.
 *
 * A feed URL is a CREDENTIAL — a capability link that grants read access to the
 * whole calendar. sw.js never sends one to this page: rows show redactFeedUrl's
 * host form, so the token cannot leak into a screenshot or a support paste.
 *
 * ---------------------------------------------------------------------------
 * SERVICE-WORKER CONTRACT ASSUMED BY THIS PAGE
 * ---------------------------------------------------------------------------
 * These are the exact shapes this page sends and expects; a mismatch should be
 * fixed here, not papered over.
 *
 *   → { type: "listFeeds" }
 *   ← { ok:true,
 *       feeds:[{ id, name, kind:"url"|"file", role, source, syncedAt,
 *                blockTitles, blockLabel, bufferBefore, bufferAfter }],
 *       ruleFilter:{ include, exclude, usePattern } }
 *     source: the feed's HOST only ("calendar.google.com/…") or "uploaded file".
 *     syncedAt: last successful read (ms), or null. A file feed is static, so
 *       the row says so instead of implying it refreshes itself.
 *     usePattern: whether the advanced regex hatch is actually armed.
 *     blockLabel: the word THIS feed's rejected shifts wear ("" = the neutral
 *       default). Per feed, never global — see setFeedBlockLabel below.
 *
 *   → { type: "listFeedTitles", feedId }
 *     NOTE: no time window is sent. The options page has no board month, so the
 *     HANDLER owns the range it samples (a few months either side of now).
 *   ← { ok: true,
 *       titles: [ { title: string,
 *                   count: number,            // occurrences in the sampled range
 *                   minutes: number } ],      // typical duration, minutes
 *       warnings: string[],                   // events core/ics.js had to skip
 *       blockTitles: string[],                // persisted Block set (stem match)
 *       noteTitles: string[],                 // persisted Note set (exact match)
 *       titleLabels: { [title]: shortLabel }, // per-event "show as" overrides
 *       calLabel: string }                    // per-feed short name ("" = none)
 *   ← { ok: false, error: string }
 *     error "feed_off": the worker refuses to read a feed that is not switched
 *     on, whoever asked. Reachable only out of order — setRole() awaits
 *     setFeedRole before it asks for titles.
 *     `warnings` is NOT decoration: a skipped event is one the user cannot tick
 *     and one that will not block, so the row renders them rather than leaving
 *     the gap invisible.
 *     The block/note/label sets are the FULL persisted state, including titles
 *     whose events fall outside the sample and so never render as rows. The
 *     picker seeds its authoritative sets from these and re-sends them whole via
 *     setEventRules, so an off-sample Block title is never dropped — dropping it
 *     would silently weaken blocking.
 *
 *   → { type: "addFeedUrl", url, name, role }
 *   → { type: "addFeedFile", content, name, role }
 *   ← { ok:true, feedId } | { ok:false, error }
 *     The worker FETCHES AND PARSES the feed before storing it, so a dead link
 *     fails while the user is still looking at the field they pasted into. A URL
 *     feed needs host access first: this page asks for it with
 *     chrome.permissions.request() inside the click's user gesture (see
 *     requestOrigin), one origin at a time, so the extension never holds broad
 *     browsing access it does not need.
 *
 *   → { type: "removeFeed", feedId }   also deletes that feed's whole config
 *   → { type: "setFeedRole", feedId, role }   role ∈ OFF|FLAG|REJECT|RULE
 *   → { type: "setEventRules", feedId, block, note, labels, calLabel, eventBuffers }
 *     ONE atomic write of the whole three-way picker state for the feed. The
 *     page sends the entire current sets on every change (snapshot at send time),
 *     so there are no per-control races.
 *   → { type: "setCalendarBuffer", feedId, before, after }
 *   → { type: "setFeedBlockLabel", feedId, label }
 *     The word on this feed's reject chips. Its own tiny handler rather than a
 *     field on setEventRules: that one writes a snapshot of the whole picker,
 *     and a REJECT feed never loads a picker, so routing this through it would
 *     send empty block/note arrays and wipe config. A blank label REMOVES the
 *     stored entry, so "unset" has exactly one representation.
 *   → { type: "setRuleFilter", include, exclude }   (advanced escape hatch only)
 *
 * Tolerated aliases (defensive only — the names above are the contract):
 *   titles[].typicalMinutes / durationMinutes as alternates for `minutes`,
 *   titles[].n as an alternate for `count`,
 *   a bare string instead of an object (title with unknown count/duration).
 */

// The per-feed block predicate, shared with content/boot.js's
// anyCalendarBlocks signal so the drawer's muted state and this page's "nothing
// blocks" banner can never disagree. This is why options.html loads options.js
// as type="module".
import { calendarBlocks } from '../core/blocks.js';

// `ruleInclude` must match sw.js's DEFAULTS.ruleInclude and must stay a real,
// non-empty, anchored pattern: new RegExp("") matches EVERY string, so an empty
// include would make a RULE feed hard-reject all of its events and silently hide
// every shift.
const DEFAULTS = {
  ruleInclude: '^Work\\b',
  ruleExclude: ''
};

// Plain-language labels. The STORED values are unchanged — only the words move.
const ROLE_CHOICES = [
  { role: 'REJECT', label: 'All of it blocks' },
  { role: 'RULE', label: 'Only some events' },
  { role: 'FLAG', label: 'Notes only' }
];

// The role a feed takes the moment its toggle is ticked. FLAG, never
// REJECT: turning a switch on must not silently start hiding shifts. Blocking
// is always a second, deliberate choice.
const ROLE_ON_ENABLE = 'FLAG';

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

const state = {
  calendars: [],          // [{id, summary, primary, role}]
  loadError: null,        // string | null — set means the LOUD load banner shows
  // feedId -> { status, error, saveError,
  //            items:[{title,count,minutes}],  // distinct titles in the sample
  //            blockSet:Set<title>,            // Block — stem match, safety-critical
  //            noteSet:Set<title>,             // Note — exact match, cosmetic
  //            labels:Map<title,shortLabel>,   // per-event "show as"
  //            calLabel:string }               // per-calendar short name
  // blockSet/noteSet/labels are seeded from the FULL persisted arrays and may
  // hold titles with no row in the current sample; they are re-sent whole so
  // those never get dropped.
  titles: new Map(),
  search: new Map(),      // calId -> current search box text
  ruleUsePattern: false   // the advanced regex hatch — the RAW ruleUsePattern key, the
                          // same value content/boot.js feeds anyoneBlocks(), so the two
                          // surfaces stay in lockstep. See loadCalendars().
};

function send(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) return done({ ok: false, error: 'sw_unreachable: ' + le.message });
        // A handler that returns nothing is a bug, not a success.
        done(resp || { ok: false, error: 'no_response' });
      });
    } catch (e) {
      done({ ok: false, error: 'sw_unreachable: ' + (e && e.message ? e.message : String(e)) });
    }
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmtDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return Math.round(minutes) + 'm';
  const h = minutes / 60;
  const rounded = Math.round(h * 10) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + 'h';
}

function metaFor(item) {
  const bits = [];
  if (Number.isFinite(item.count) && item.count > 0) bits.push(item.count + '×');
  const dur = fmtDuration(item.minutes);
  if (dur) bits.push(dur);
  return bits.join(' · ');
}

function joinNames(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ' and ' + names[1];
  if (names.length <= 4) return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' others';
}

function calDisplayName(cal) {
  // resolveFeedRoles already resolved this: the user's own name, else the
  // calendar's X-WR-CALNAME, else a placeholder. Never the feed URL.
  return cal.name || '(unnamed feed)';
}

// "4m ago" / "3h ago" / "2d ago" for a feed's last successful read.
function fmtSince(ms) {
  const mins = (Date.now() - ms) / 60000;
  if (!Number.isFinite(mins) || mins < 0) return 'just now';
  if (mins < 1) return 'just now';
  if (mins < 60) return Math.round(mins) + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
}

// Human wording for the sw.js feed error strings ("feed_http: http_404",
// "feed_unreachable: …", "feed_unparseable: …", "feed_bad_url", "feed_empty",
// "feed_off", "sw_unreachable: …").
function explainError(err) {
  const e = String(err || '');
  if (e.startsWith('feed_http')) {
    const code = (e.match(/http_(\d+)/) || [])[1];
    return {
      title: 'That link did not work',
      body: 'The calendar answered with HTTP ' + (code || '?') + '. Secret calendar links can be reset by the provider — open your calendar settings, copy the link again, and replace it here.'
    };
  }
  if (e.startsWith('feed_unreachable')) {
    return { title: 'Could not reach that calendar', body: 'The link could not be loaded: ' + e + '. Check the address, your connection, and that you allowed access to the site when asked.' };
  }
  if (e.startsWith('feed_unparseable') || e.includes('not_icalendar')) {
    return { title: 'That link is not a calendar feed', body: 'The address loaded, but what came back is not an iCalendar (.ics) file — usually a sign-in page instead of the feed. Copy the link labelled iCal or "secret address" rather than the one from your browser bar.' };
  }
  if (e === 'feed_bad_url') {
    return { title: 'That is not a usable calendar address', body: 'A feed link has to start with https:// or webcal://. Paste the iCal link from your calendar provider.' };
  }
  if (e === 'feed_empty') {
    return { title: 'That file was empty', body: 'The uploaded .ics file had no content in it. Export the calendar again and upload the new file.' };
  }
  if (e === 'feed_off') {
    return { title: 'That feed is switched off', body: 'The extension only reads feeds that are switched on here, so it did not open this one. Switch it on and try again.' };
  }
  if (e.startsWith('sw_unreachable')) {
    return { title: 'The extension\'s background worker did not answer', body: e + '. Try reloading this page; if it persists, reload the extension.' };
  }
  return { title: 'Can’t read your feeds', body: 'Something went wrong: ' + e + '. Nothing is blocking shifts.' };
}

// ---------------------------------------------------------------------------
// Blocking / banner logic
// ---------------------------------------------------------------------------

function calBlocks(cal) {
  // Delegates to the shared core/blocks.js predicate so this banner and the
  // drawer's muted state use ONE definition of "blocks". A RULE calendar counts
  // when it has at least one ticked title OR the advanced pattern hatch is armed
  // (state.ruleUsePattern) — the latter closes the gap the old inline check left
  // open, where a pattern-armed RULE calendar returned false and the banner
  // over-warned.
  const t = state.titles.get(cal.id);
  const blockTitles = t && t.blockSet ? Array.from(t.blockSet) : [];
  return calendarBlocks(cal.role, blockTitles, state.ruleUsePattern);
}

function renderBanners() {
  const loadBanner = document.getElementById('loadBanner');
  const noBlock = document.getElementById('noBlockBanner');

  if (state.loadError) {
    const info = explainError(state.loadError);
    document.getElementById('loadBannerTitle').textContent = info.title;
    document.getElementById('loadBannerSub').textContent = 'Nothing is blocking shifts right now';
    document.getElementById('loadBannerBody').textContent = info.body;
    loadBanner.hidden = false;
    // Only ONE red banner at a time: the load failure is the real cause, and
    // "no calendars selected" alongside it would misattribute the problem.
    noBlock.hidden = true;
    return;
  }

  loadBanner.hidden = true;
  noBlock.hidden = state.calendars.some(calBlocks);
}

function renderPrivacyNote() {
  const note = document.getElementById('privacyNote');
  if (state.loadError) {
    note.textContent = 'No calendar is being read.';
    return;
  }
  const total = state.calendars.length;
  const on = state.calendars.filter((c) => c.role !== 'OFF');
  if (total === 0) {
    note.textContent = 'No feeds yet. Feed links are stored on this computer only and are never synced.';
    return;
  }
  if (on.length === 0) {
    note.textContent = 'These feeds are added but switched off. Their contents are not read unless you switch one on.';
    return;
  }
  const off = state.calendars.filter((c) => c.role === 'OFF').map(calDisplayName);
  let text = 'Reading ' + on.length + ' of ' + total + ' feed' + (total === 1 ? '' : 's') + '.';
  if (off.length) text += ' ' + joinNames(off) + (off.length === 1 ? ' is' : ' are') + ' never opened.';
  note.textContent = text;
}

// ---------------------------------------------------------------------------
// The event picker
// ---------------------------------------------------------------------------

function normalizeTitleItems(raw) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    const title = typeof r === 'string' ? r : (r && typeof r.title === 'string' ? r.title : '');
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const src = typeof r === 'string' ? {} : r;
    const count = Number(src.count !== undefined ? src.count : src.n);
    const minutes = Number(
      src.minutes !== undefined ? src.minutes
        : src.typicalMinutes !== undefined ? src.typicalMinutes
          : src.durationMinutes
    );
    out.push({
      title,
      count: Number.isFinite(count) ? count : NaN,
      minutes: Number.isFinite(minutes) ? minutes : NaN
    });
  }
  out.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  return out;
}

function emptyThreeWay() {
  return {
    blockSet: new Set(), noteSet: new Set(), labels: new Map(), calLabel: '',
    eventBuffers: new Map() // title -> { before, after }, overrides only (zero entries dropped)
  };
}

// Coerce any raw input (string from a number field, blank, etc.) to a
// non-negative, finite, <=2-decimal hours value. Never returns NaN.
function toHours(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

// Seed the authoritative Block/Note/label/calLabel state from the handler's FULL
// persisted arrays — not from the visible rows — so a Block title whose events
// are outside the sample survives the next save. See the contract note above.
function seedThreeWay(resp) {
  const strs = (arr) => (Array.isArray(arr) ? arr : []).filter((t) => typeof t === 'string');
  const labels = new Map();
  const raw = resp.titleLabels;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && typeof v === 'string') labels.set(k, v);
    }
  }
  const noteSet = new Set(strs(resp.noteTitles));
  const blockSet = new Set(strs(resp.blockTitles));
  // A title can only be one thing; if storage ever holds it in both, Block wins
  // (it is the safety-critical, forward-looking rule) — mirror bucketEvents.
  for (const b of blockSet) noteSet.delete(b);

  const eventBuffers = new Map();
  const rawBuffers = resp.eventBuffers;
  if (rawBuffers && typeof rawBuffers === 'object' && !Array.isArray(rawBuffers)) {
    for (const [title, v] of Object.entries(rawBuffers)) {
      if (typeof title !== 'string' || !v || typeof v !== 'object') continue;
      const before = toHours(v.before);
      const after = toHours(v.after);
      if (before > 0 || after > 0) eventBuffers.set(title, { before, after });
    }
  }

  return {
    blockSet,
    noteSet,
    labels,
    calLabel: typeof resp.calLabel === 'string' ? resp.calLabel : '',
    eventBuffers
  };
}

async function loadTitles(calId, force) {
  const existing = state.titles.get(calId);
  if (!force && existing && existing.status === 'ok') return existing;
  state.titles.set(calId, { status: 'loading', items: [], ...emptyThreeWay() });
  render();

  const resp = await send({ type: 'listFeedTitles', feedId: calId });
  if (!resp.ok) {
    state.titles.set(calId, {
      status: 'error',
      error: resp.error,
      items: [],
      ...emptyThreeWay()
    });
  } else {
    state.titles.set(calId, {
      status: 'ok',
      items: normalizeTitleItems(resp.titles),
      // Events core/ics.js had to skip on this feed. They are not being applied,
      // so the row renders them rather than letting the gap stay invisible.
      warnings: Array.isArray(resp.warnings) ? resp.warnings : [],
      ...seedThreeWay(resp)
    });
  }
  render();
  return state.titles.get(calId);
}

// One in-flight save per calendar, chained.
//
// WHY. Every change fires a save carrying a FULL snapshot of the calendar's
// three-way state, and the worker handles it with an awaited read-modify-write.
// Fired concurrently, two saves can be applied out of order, so an older
// snapshot wins: a change the user can still see on screen is silently not
// persisted, and the page reports success because its own request succeeded.
// Marking events fast is exactly what a user does when configuring a calendar.
//
// Chaining per calendar makes last-write-wins correct by construction: the
// snapshot is taken when the request is about to GO OUT (in sendEventRules), not
// when it was queued, so the final write always carries what is on screen and
// the intermediate states collapse harmlessly.
const saveChains = new Map();
const saveTimers = new Map();

function persistEventRules(calId) {
  const timer = saveTimers.get(calId);
  if (timer) { clearTimeout(timer); saveTimers.delete(calId); }
  const previous = saveChains.get(calId) || Promise.resolve();
  const next = previous.then(() => sendEventRules(calId));
  saveChains.set(calId, next);
  return next;
}

// Typing in a "show as" field would fire a save per keystroke; debounce it. The
// snapshot is still taken at send time, so a debounced save and an immediate one
// (a segment click) both persist exactly what is on screen when they go out.
function persistEventRulesDebounced(calId, ms = 400) {
  const existing = saveTimers.get(calId);
  if (existing) clearTimeout(existing);
  saveTimers.set(calId, setTimeout(() => {
    saveTimers.delete(calId);
    persistEventRules(calId);
  }, ms));
}

// Never throws: a rejection here would poison the chain above and every later
// change for this calendar would silently stop being saved.
async function sendEventRules(calId) {
  const t = state.titles.get(calId);
  if (!t) return;
  const hadError = Boolean(t.saveError);
  try {
    // Snapshotted HERE, at send time — see the note above. Labels are sent only
    // for titles that are actually Block or Note (an Ignored title has no label
    // to show), trimmed, empties dropped.
    const labels = {};
    for (const [title, lab] of t.labels) {
      if (!t.blockSet.has(title) && !t.noteSet.has(title)) continue;
      const v = (typeof lab === 'string' ? lab : '').trim();
      if (v) labels[title] = v;
    }
    // Per-event overrides only apply to Block rows and only when actually set
    // (non-zero) — a title with no override inherits the calendar default via
    // the FIXED CONTRACT's ?? fallback, so a zero/absent entry must not be sent.
    const eventBuffers = {};
    for (const [title, buf] of t.eventBuffers) {
      if (!t.blockSet.has(title)) continue;
      const before = toHours(buf && buf.before);
      const after = toHours(buf && buf.after);
      if (before > 0 || after > 0) eventBuffers[title] = { before, after };
    }
    const resp = await send({
      type: 'setEventRules',
      calendarId: calId,
      block: Array.from(t.blockSet),
      note: Array.from(t.noteSet),
      labels,
      calLabel: (typeof t.calLabel === 'string' ? t.calLabel : '').trim(),
      eventBuffers
    });
    t.saveError = resp.ok ? null : resp.error;
  } catch (e) {
    t.saveError = e && e.message ? e.message : String(e);
  }
  // Only re-render when the error state changed. On the happy path nothing
  // visual changed, and a re-render would steal focus from a "show as" field the
  // user is still typing in (the debounced save can fire mid-edit).
  if (t.saveError || hadError) render();
}

// ---------------------------------------------------------------------------
// Rest buffer — calendar-level default (setCalendarBuffer)
// ---------------------------------------------------------------------------
//
// Same one-in-flight-per-calendar, snapshot-at-send pattern as the event-rules
// save above, kept as its own chain/timer pair so a buffer save and an
// event-rules save for the same calendar never block on each other.
const bufferSaveChains = new Map();
const bufferSaveTimers = new Map();

function persistCalendarBuffer(calId) {
  const timer = bufferSaveTimers.get(calId);
  if (timer) { clearTimeout(timer); bufferSaveTimers.delete(calId); }
  const previous = bufferSaveChains.get(calId) || Promise.resolve();
  const next = previous.then(() => sendCalendarBuffer(calId));
  bufferSaveChains.set(calId, next);
  return next;
}

function persistCalendarBufferDebounced(calId, ms = 400) {
  const existing = bufferSaveTimers.get(calId);
  if (existing) clearTimeout(existing);
  bufferSaveTimers.set(calId, setTimeout(() => {
    bufferSaveTimers.delete(calId);
    persistCalendarBuffer(calId);
  }, ms));
}

async function sendCalendarBuffer(calId) {
  const cal = state.calendars.find((c) => c.id === calId);
  if (!cal) return;
  const hadError = Boolean(cal.bufferSaveError);
  try {
    // Snapshotted here, at send time — whatever is on screen right now.
    const resp = await send({
      type: 'setCalendarBuffer',
      calendarId: calId,
      before: toHours(cal.bufferBefore),
      after: toHours(cal.bufferAfter)
    });
    cal.bufferSaveError = resp.ok ? null : resp.error;
  } catch (e) {
    cal.bufferSaveError = e && e.message ? e.message : String(e);
  }
  if (cal.bufferSaveError || hadError) render();
}

function buildBufferField(cal, key, label) {
  const wrap = el('label', 'buffer-field');
  wrap.appendChild(document.createTextNode(label + ' '));
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.5';
  input.inputMode = 'decimal';
  input.value = String(key === 'before' ? cal.bufferBefore : cal.bufferAfter);
  input.addEventListener('input', () => {
    const v = toHours(input.value);
    if (key === 'before') cal.bufferBefore = v; else cal.bufferAfter = v;
    persistCalendarBufferDebounced(cal.id);
  });
  wrap.appendChild(input);
  wrap.appendChild(document.createTextNode(' h'));
  return wrap;
}

// One in-flight save per feed, chained — same reasoning as the buffer and
// event-rule chains above: typing fires a save per keystroke, and two
// concurrent read-modify-writes can land out of order so an older snapshot wins.
const blockLabelChains = new Map();
const blockLabelTimers = new Map();

function persistBlockLabel(calId) {
  const prev = blockLabelChains.get(calId) || Promise.resolve();
  const next = prev.then(() => sendBlockLabel(calId)).catch(() => {});
  blockLabelChains.set(calId, next);
  return next;
}

function persistBlockLabelDebounced(calId, ms = 400) {
  clearTimeout(blockLabelTimers.get(calId));
  blockLabelTimers.set(calId, setTimeout(() => persistBlockLabel(calId), ms));
}

// Snapshot at SEND time, not queue time, so the last write always carries what
// is on screen.
async function sendBlockLabel(calId) {
  const cal = state.calendars.find((c) => c.id === calId);
  if (!cal) return;
  const hadError = Boolean(cal.blockLabelSaveError);
  try {
    const resp = await send({ type: 'setFeedBlockLabel', feedId: calId, label: cal.blockLabel || '' });
    cal.blockLabelSaveError = resp.ok ? null : resp.error;
  } catch (e) {
    cal.blockLabelSaveError = e && e.message ? e.message : String(e);
  }
  if (cal.blockLabelSaveError || hadError) render();
}

/**
 * The word this feed's rejected shifts wear ("✕ Fire Dept").
 *
 * Lives beside the rest buffer because both belong to the same question — what
 * this feed does when it blocks — and both therefore render on exactly the roles
 * that CAN block. A "Notes only" feed never rejects anything, so it never shows
 * this field.
 *
 * No render() on input: rebuilding the list mid-keystroke would steal focus. The
 * chip preview is updated in place instead.
 */
function buildBlockLabelRow(cal) {
  const row = el('div', 'cal-label-row');
  row.appendChild(el('label', null, 'Rejected shifts say →'));

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Commitment';
  input.value = cal.blockLabel || '';

  const chip = el('span', 'chip', '✕ ' + (cal.blockLabel || 'Commitment'));
  input.addEventListener('input', () => {
    cal.blockLabel = input.value;
    chip.textContent = '✕ ' + (input.value.trim() || 'Commitment');
    persistBlockLabelDebounced(cal.id);
  });

  row.appendChild(input);
  row.appendChild(chip);
  return row;
}

// Feed-level "Rest buffer" block — shown on any feed that can block: a REJECT
// card's body, and the header of a RULE feed's picker.
function buildBufferBlock(cal) {
  const box = el('div', 'buffer-block');
  box.appendChild(el('div', 'buffer-title', 'Rest buffer'));
  const row = el('div', 'buffer-row');
  row.appendChild(buildBufferField(cal, 'before', 'Before'));
  row.appendChild(buildBufferField(cal, 'after', 'After'));
  box.appendChild(row);
  box.appendChild(el('p', 'buffer-hint',
    'Shifts within this window of a blocking event are rejected. 0 = block only direct overlaps.'));
  if (cal.bufferSaveError) {
    box.appendChild(el('div', 'cal-status error', 'Not saved (' + cal.bufferSaveError + ').'));
  }
  box.appendChild(buildBlockLabelRow(cal));
  box.appendChild(el('p', 'buffer-hint',
    'The word shown on shifts this feed knocks out. Leave blank for “Commitment”.'));
  if (cal.blockLabelSaveError) {
    box.appendChild(el('div', 'cal-status error', 'Label not saved (' + cal.blockLabelSaveError + ').'));
  }
  return box;
}

// Per-event override, shown only on a Block row. Both fields at 0 means
// "inherit the calendar default" — nothing is sent for this title in that case.
function buildEventBufferRow(cal, t, item) {
  const cur = t.eventBuffers.get(item.title) || { before: 0, after: 0 };
  const wrap = el('div', 'event-buffer');
  wrap.appendChild(el('span', 'arrow', '↳'));
  wrap.appendChild(document.createTextNode(' Before'));

  const beforeInput = document.createElement('input');
  beforeInput.type = 'number';
  beforeInput.min = '0';
  beforeInput.step = '0.5';
  beforeInput.value = String(cur.before || 0);
  beforeInput.dataset.title = item.title;
  beforeInput.addEventListener('input', () => {
    setEventBuffer(cal.id, item.title, 'before', beforeInput.value);
  });
  wrap.appendChild(beforeInput);

  wrap.appendChild(document.createTextNode(' / After'));

  const afterInput = document.createElement('input');
  afterInput.type = 'number';
  afterInput.min = '0';
  afterInput.step = '0.5';
  afterInput.value = String(cur.after || 0);
  afterInput.dataset.title = item.title;
  afterInput.addEventListener('input', () => {
    setEventBuffer(cal.id, item.title, 'after', afterInput.value);
  });
  wrap.appendChild(afterInput);

  wrap.appendChild(document.createTextNode(' h (override)'));
  return wrap;
}

// Move a title to exactly one of the three states, preserving any typed label.
function setTitleMode(calId, title, mode) {
  const t = state.titles.get(calId);
  if (!t) return;
  t.blockSet.delete(title);
  t.noteSet.delete(title);
  if (mode === 'block') t.blockSet.add(title);
  else if (mode === 'note') t.noteSet.add(title);
  persistEventRules(calId);
  // The row's "show as" field appears/disappears and the totals move, so a
  // re-render is needed; keep the clicked segment focused for keyboard users.
  render({ focus: { calId, kind: 'seg', title, mode } });
}

// Set one side (before/after) of a title's per-event buffer override. A title
// that lands back at {0,0} is removed from the map entirely — that IS "no
// override, inherit the calendar default", not "an override of zero".
function setEventBuffer(calId, title, key, raw) {
  const t = state.titles.get(calId);
  if (!t) return;
  const v = toHours(raw);
  const cur = t.eventBuffers.get(title) || { before: 0, after: 0 };
  cur[key] = v;
  if (cur.before === 0 && cur.after === 0) t.eventBuffers.delete(title);
  else t.eventBuffers.set(title, cur);
  // Debounced, no render(): same reasoning as the "show as" field — the row's
  // shape does not change as the number is typed, and a re-render would drop
  // focus/caret out of the input.
  persistEventRulesDebounced(calId);
}

function modeOf(t, title) {
  if (t.blockSet.has(title)) return 'block';
  if (t.noteSet.has(title)) return 'note';
  return 'ignore';
}

// One title row: a header line (title + meta + the Block/Note/Ignore segmented
// control), then a "show as" line revealed only when the row is Block or Note.
function buildTitleRow(cal, t, item) {
  const mode = modeOf(t, item.title);
  const row = el('div', 'title-row');

  const main = el('div', 'title-main');
  main.appendChild(el('span', 't', item.title));
  const meta = metaFor(item);
  if (meta) main.appendChild(el('span', 'meta', meta));

  const seg = el('div', 'seg');
  for (const [m, label] of [['block', 'Block'], ['note', 'Note'], ['ignore', 'Ignore']]) {
    const btn = el('button', mode === m ? 'on-' + m : null, label);
    btn.type = 'button';
    btn.dataset.title = item.title;
    btn.dataset.mode = m;
    btn.setAttribute('aria-pressed', String(mode === m));
    btn.addEventListener('click', () => {
      if (modeOf(t, item.title) !== m) setTitleMode(cal.id, item.title, m);
    });
    seg.appendChild(btn);
  }
  main.appendChild(seg);
  row.appendChild(main);

  if (mode === 'block' || mode === 'note') {
    const showas = el('div', 'showas');
    showas.appendChild(el('span', 'arrow', '↳ show as'));
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = mode === 'block' ? 'reject chip (optional)' : 'note text (optional)';
    input.value = t.labels.get(item.title) || '';
    input.dataset.title = item.title;
    input.addEventListener('input', () => {
      t.labels.set(item.title, input.value);
      // Debounced, and deliberately no render(): the field's presence does not
      // change as its own text is typed, and a re-render would drop the caret.
      // Totals and the blocking banner do not depend on labels.
      persistEventRulesDebounced(cal.id);
    });
    showas.appendChild(input);
    row.appendChild(showas);
  }

  if (mode === 'block') row.appendChild(buildEventBufferRow(cal, t, item));

  return row;
}

function buildPicker(cal) {
  const wrap = el('div', 'picker');
  wrap.appendChild(el('h3', null, 'What matters on this feed?'));
  wrap.appendChild(el('p', 'hint',
    'Mark an event Block to knock out an overlapping shift, or Note to leave a '
    + 'reminder. Everything you leave on Ignore is dropped.'));

  // Rest buffer default lives at the top of the picker, above search/loading
  // states — a RULE calendar can block via this default even while its titles
  // are still loading or failed to load.
  wrap.appendChild(buildBufferBlock(cal));

  const t = state.titles.get(cal.id);

  if (!t || t.status === 'loading') {
    wrap.appendChild(el('div', 'cal-status', 'Reading this feed…'));
    return wrap;
  }

  if (t.status === 'error') {
    const info = explainError(t.error);
    const err = el('div', 'cal-status error',
      'Could not read this feed — ' + info.title + ' (' + t.error + '). '
      + 'Nothing from it is blocking shifts.');
    wrap.appendChild(err);
    const retry = el('button', 'ghost', 'Try again');
    retry.type = 'button';
    retry.style.marginTop = '8px';
    retry.addEventListener('click', () => loadTitles(cal.id, true));
    wrap.appendChild(retry);
    return wrap;
  }

  if (t.items.length === 0) {
    wrap.appendChild(el('div', 'cal-status',
      'No events found on this feed, so nothing here can block a shift.'));
    return wrap;
  }

  // Per-calendar short name: prefixes every note from this calendar in place of
  // its full display name. No render() on input — same reasoning as "show as".
  const calLabelRow = el('div', 'cal-label-row');
  calLabelRow.appendChild(el('label', null, 'Show this feed as →'));
  const calInput = document.createElement('input');
  calInput.type = 'text';
  calInput.placeholder = calDisplayName(cal);
  calInput.value = t.calLabel || '';
  calInput.addEventListener('input', () => {
    t.calLabel = calInput.value;
    persistEventRulesDebounced(cal.id);
  });
  calLabelRow.appendChild(calInput);
  wrap.appendChild(calLabelRow);

  // Search — some accounts have 200+ distinct titles.
  const query = (state.search.get(cal.id) || '');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search event names…';
  search.value = query;
  search.addEventListener('input', () => {
    state.search.set(cal.id, search.value);
    render({ focus: { calId: cal.id, kind: 'search', pos: search.selectionStart } });
  });
  wrap.appendChild(search);

  const q = query.trim().toLowerCase();
  const shown = t.items.filter((i) => !q || i.title.toLowerCase().includes(q));
  if (shown.length === 0) {
    wrap.appendChild(el('div', 'empty-group', 'No matches for “' + query.trim() + '”.'));
  } else {
    for (const item of shown) wrap.appendChild(buildTitleRow(cal, t, item));
  }

  // Running total, counted over the titles in this sample so it always sums to
  // the number of rows. Off-sample Block/Note titles (kept in the sets so they
  // are not dropped) have no row and are not counted here.
  let nBlock = 0;
  let nNote = 0;
  let nIgnore = 0;
  for (const i of t.items) {
    const m = modeOf(t, i.title);
    if (m === 'block') nBlock += 1;
    else if (m === 'note') nNote += 1;
    else nIgnore += 1;
  }
  const totals = el('div', 'totals');
  totals.appendChild(el('strong', null, nBlock + ' block'));
  totals.appendChild(document.createTextNode(' · '));
  totals.appendChild(el('strong', null, nNote + ' note'));
  totals.appendChild(document.createTextNode(' · '));
  totals.appendChild(el('strong', null, nIgnore + ' ignored'));
  totals.appendChild(document.createTextNode(
    ' — anything you don’t mark is ignored, so the board stays quiet by default.'));
  wrap.appendChild(totals);

  if (t.saveError) {
    wrap.appendChild(el('div', 'cal-status error',
      'Your last change was NOT saved (' + t.saveError + ') — it is not being applied yet.'));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Calendar rows
// ---------------------------------------------------------------------------

async function setRole(calId, role) {
  const cal = state.calendars.find((c) => c.id === calId);
  if (!cal) return;
  const previous = cal.role;
  cal.role = role;
  render();

  const resp = await send({ type: 'setFeedRole', feedId: calId, role });
  if (!resp.ok) {
    cal.role = previous;
    cal.roleError = 'Not saved (' + resp.error + ') — this feed is still "'
      + previous + '".';
    render();
    return;
  }
  cal.roleError = null;

  // Turning a calendar on reads it immediately — the owner's explicit decision,
  // so there is no second "load events" step. It also proves access works and
  // warms the picker.
  if (previous === 'OFF' && role !== 'OFF') {
    await loadTitles(calId, true);
  } else if (role === 'RULE') {
    await loadTitles(calId, false);
  } else {
    render();
  }
}

function buildRoleRow(cal) {
  const row = el('div', 'roles');
  for (const choice of ROLE_CHOICES) {
    const pill = el('label', 'role-pill' + (cal.role === choice.role ? ' sel' : ''));
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'role-' + cal.id;
    radio.checked = cal.role === choice.role;
    radio.addEventListener('change', () => { if (radio.checked) setRole(cal.id, choice.role); });
    pill.appendChild(radio);
    pill.appendChild(el('span', null, choice.label));
    row.appendChild(pill);
  }
  return row;
}

function buildCalendar(cal) {
  const on = cal.role !== 'OFF';
  const card = el('div', 'cal' + (on ? ' on' : ''));

  const head = el('div', 'cal-head');
  const sw = el('label', 'switch');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = on;
  toggle.setAttribute('aria-label', 'Read ' + calDisplayName(cal));
  toggle.addEventListener('change', () => {
    setRole(cal.id, toggle.checked ? ROLE_ON_ENABLE : 'OFF');
  });
  sw.appendChild(toggle);
  sw.appendChild(el('span', 'slider'));
  head.appendChild(sw);

  const name = el('div', 'cal-name', calDisplayName(cal));
  // The host only — never the secret capability URL, which sw.js does not even
  // send to this page.
  if (cal.source) name.appendChild(el('span', 'tag', cal.source));
  head.appendChild(name);

  // A URL feed refreshes itself, so it shows how fresh it is. An uploaded file
  // never can, so it says so outright rather than showing an age that would
  // imply it updates on its own.
  head.appendChild(el('span', 'cal-sync', cal.kind === 'file'
    ? 'static — re-upload to update'
    : (cal.syncedAt ? 'synced ' + fmtSince(cal.syncedAt) : 'not read yet')));

  const remove = el('button', 'feed-remove', '✕');
  remove.type = 'button';
  remove.title = 'Remove this feed';
  remove.setAttribute('aria-label', 'Remove ' + calDisplayName(cal));
  remove.addEventListener('click', () => removeFeed(cal));
  head.appendChild(remove);
  card.appendChild(head);

  if (on) {
    const body = el('div', 'cal-body');
    body.appendChild(buildRoleRow(cal));
    if (cal.roleError) body.appendChild(el('div', 'cal-status error', cal.roleError));

    const t = state.titles.get(cal.id);
    if (cal.role === 'REJECT') {
      body.appendChild(buildBufferBlock(cal));
    }
    if (cal.role === 'RULE') {
      body.appendChild(buildPicker(cal));
    } else if (t && t.status === 'error') {
      // Toggled on but the read failed: never let it look "on and fine".
      body.appendChild(el('div', 'cal-status error',
        'This calendar is switched on but could not be read (' + t.error
        + '), so nothing from it is being applied.'));
    }
    // Events the parser had to skip on this feed. They are NOT being applied, so
    // saying which ones is the difference between a known gap and a silent one.
    if (t && Array.isArray(t.warnings) && t.warnings.length) {
      const warn = el('div', 'cal-warn');
      warn.appendChild(el('div', 'cal-warn-head',
        t.warnings.length + (t.warnings.length === 1 ? ' event was skipped' : ' events were skipped')));
      warn.appendChild(el('div', 'cal-warn-body', t.warnings.join(' · ')));
      body.appendChild(warn);
    }
    card.appendChild(body);
  }
  return card;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(opts) {
  renderBanners();
  renderPrivacyNote();

  const list = document.getElementById('calList');
  list.textContent = '';
  if (state.loadError) return;
  for (const cal of state.calendars) list.appendChild(buildCalendar(cal));

  // The list is rebuilt wholesale, so focus has to be restored by hand —
  // otherwise typing in the search box drops a character per keystroke and
  // every tick throws a keyboard user back to the top of the page.
  const f = opts && opts.focus;
  if (!f) return;
  const card = list.children[state.calendars.findIndex((c) => c.id === f.calId)];
  if (!card) return;
  if (f.kind === 'search') {
    const box = card.querySelector('input[type="search"]');
    if (box) {
      box.focus();
      if (f.pos !== null && f.pos !== undefined) box.setSelectionRange(f.pos, f.pos);
    }
  } else if (f.kind === 'seg') {
    // Marking a title rebuilds the list; keep the just-clicked segment focused so
    // a keyboard user is not dumped back to the top of the page.
    const btns = card.querySelectorAll('.seg button');
    for (const btn of btns) {
      if (btn.dataset.title === f.title && btn.dataset.mode === f.mode) { btn.focus(); break; }
    }
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function loadCalendars(interactive) {
  // Read the RAW ruleUsePattern key — the exact value content/boot.js feeds
  // anyoneBlocks — rather than resp.ruleFilter.usePattern (which sw.js resolves
  // more broadly, e.g. from a stored ruleInclude). Feeding the same input keeps
  // this banner and the drawer's muted state from ever disagreeing.
  try {
    const flags = await chrome.storage.local.get('ruleUsePattern');
    state.ruleUsePattern = flags.ruleUsePattern === true;
  } catch (_e) {
    state.ruleUsePattern = false;
  }

  const resp = await send({ type: 'listFeeds' });
  if (!resp.ok) {
    state.loadError = resp.error || 'unknown_error';
    state.calendars = [];
    render();
    return;
  }
  state.loadError = null;
  state.calendars = (resp.feeds || []).map((c) => ({
    id: c.id,
    name: c.name || '',
    kind: c.kind === 'file' ? 'file' : 'url',
    source: c.source || '',
    syncedAt: typeof c.syncedAt === 'number' ? c.syncedAt : null,
    role: c.role || 'OFF',
    roleError: null,
    blockLabel: typeof c.blockLabel === 'string' ? c.blockLabel : '',
    blockLabelSaveError: null,
    bufferBefore: toHours(c.bufferBefore),
    bufferAfter: toHours(c.bufferAfter),
    bufferSaveError: null
  }));
  render();

  // Warm the picker for calendars the user already set to "Only some events" —
  // without it we could not tell whether they block anything, and the red
  // banner would stay up on a correctly-configured account.
  for (const cal of state.calendars) {
    if (cal.role === 'RULE') await loadTitles(cal.id, false);
  }
}

// ---------------------------------------------------------------------------
// The advanced pattern escape hatch
// ---------------------------------------------------------------------------

function setStatus(id, text, isError) {
  const status = document.getElementById(id);
  status.textContent = text;
  status.classList.toggle('error', Boolean(isError));
  if (!isError && text) {
    setTimeout(() => {
      if (status.textContent === text) {
        status.textContent = '';
        status.classList.remove('error');
      }
    }, 2000);
  }
}

function savePattern() {
  const includeField = document.getElementById('ruleInclude');
  const raw = includeField.value;
  // Never persist an empty include: it compiles to a match-everything regex.
  if (raw.trim() === '') {
    setStatus('patternStatus', 'Not saved — a blank include pattern would block every shift.', true);
    return;
  }
  try {
    new RegExp(raw, 'i');
  } catch (_err) {
    setStatus('patternStatus', 'Not saved — that is not a valid regular expression.', true);
    return;
  }
  send({
    type: 'setRuleFilter',
    include: raw,
    exclude: document.getElementById('ruleExclude').value
  }).then((resp) => {
    if (!resp.ok) {
      setStatus('patternStatus', 'Not saved (' + resp.error + ').', true);
      return;
    }
    setStatus('patternStatus', 'Saved');
  });
}

function loadLocalFields() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    // The RAW stored pattern is shown, not the compiled fallback: when a stored
    // regex is broken sw.js silently uses the default, but the user still needs
    // to see the broken value in order to fix it.
    document.getElementById('ruleInclude').value =
      typeof items.ruleInclude === 'string' && items.ruleInclude.trim()
        ? items.ruleInclude
        : DEFAULTS.ruleInclude;
    document.getElementById('ruleExclude').value =
      typeof items.ruleExclude === 'string' ? items.ruleExclude : DEFAULTS.ruleExclude;
  });
}

// ---------------------------------------------------------------------------
// Adding and removing feeds
// ---------------------------------------------------------------------------

// The origin pattern Chrome needs before the worker may fetch this feed.
function originPatternFor(url) {
  try {
    const u = new URL(String(url || '').trim().replace(/^webcal:\/\//i, 'https://'));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + '/*';
  } catch (_e) {
    return null;
  }
}

// Host access is OPTIONAL and asked for one origin at a time, at the moment the
// user adds that feed — so the extension never holds broad browsing access it
// does not need, and the prompt names the site the user just pasted.
function requestOrigin(pattern) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        // lastError fires when the call is not tied to a user gesture.
        resolve(!chrome.runtime.lastError && granted === true);
      });
    } catch (_e) {
      resolve(false);
    }
  });
}

function addStatus(text, isError) {
  const node = document.getElementById('addFeedStatus');
  node.textContent = text || '';
  node.classList.toggle('error', Boolean(isError));
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('unreadable file'));
    fr.readAsText(file);
  });
}

function currentFeedKind() {
  const picked = document.querySelector('input[name="feedKind"]:checked');
  return picked && picked.value === 'file' ? 'file' : 'url';
}

function reportAddFailure(err) {
  const info = explainError(err);
  addStatus(info.title + ' — ' + info.body, true);
}

async function addUrlFeed(name, role) {
  const raw = document.getElementById('feedUrl').value.trim();
  const pattern = originPatternFor(raw);
  if (!pattern) {
    addStatus('That is not a usable calendar link — it has to start with https:// or webcal://.', true);
    return false;
  }
  // Runs inside the click's user gesture: nothing may be awaited before it.
  if (!(await requestOrigin(pattern))) {
    addStatus('Chrome needs permission to read ' + pattern + ' before this feed can be added.', true);
    return false;
  }
  addStatus('Checking the link…');
  const resp = await send({ type: 'addFeedUrl', url: raw, name, role });
  if (!resp.ok) { reportAddFailure(resp.error); return false; }
  document.getElementById('feedUrl').value = '';
  return true;
}

async function addFileFeed(name, role) {
  const file = document.getElementById('feedFile').files[0];
  if (!file) { addStatus('Choose an .ics file first.', true); return false; }
  addStatus('Reading the file…');
  let content;
  try {
    content = await readFileText(file);
  } catch (_e) {
    addStatus('Could not read that file.', true);
    return false;
  }
  const resp = await send({ type: 'addFeedFile', content, name, role });
  if (!resp.ok) { reportAddFailure(resp.error); return false; }
  document.getElementById('feedFile').value = '';
  return true;
}

// The feed is fetched and parsed BEFORE it is stored, so a bad link fails here —
// while the user is still looking at the field they pasted into — rather than
// silently at the next refresh, when the board would just look empty.
async function addFeed() {
  const name = document.getElementById('feedName').value.trim();
  const role = document.getElementById('feedRole').value;
  addStatus('');
  const ok = currentFeedKind() === 'url'
    ? await addUrlFeed(name, role)
    : await addFileFeed(name, role);
  if (!ok) return;
  document.getElementById('feedName').value = '';
  addStatus('Feed added.');
  await loadCalendars(false);
}

async function removeFeed(cal) {
  // Removing also deletes this feed's block list, notes, labels and rest hours —
  // say so, because none of it can be recovered.
  const sure = window.confirm('Remove “' + calDisplayName(cal)
    + '”?\n\nIts block list, notes and rest hours are deleted too.');
  if (!sure) return;
  const resp = await send({ type: 'removeFeed', feedId: cal.id });
  if (!resp.ok) {
    setStatus('status', 'Could not remove that feed: ' + resp.error, true);
    return;
  }
  state.titles.delete(cal.id);
  await loadCalendars(false);
}

function wireAddFeed() {
  const kinds = document.getElementById('feedKinds');
  kinds.addEventListener('change', () => {
    const kind = currentFeedKind();
    document.getElementById('feedUrlWrap').hidden = kind !== 'url';
    document.getElementById('feedFileWrap').hidden = kind !== 'file';
    for (const pill of kinds.querySelectorAll('.role-pill')) {
      pill.classList.toggle('sel', pill.querySelector('input').checked);
    }
    addStatus('');
  });
  document.getElementById('addFeed').addEventListener('click', () => {
    addFeed().catch((e) => addStatus('Could not add that feed: ' + (e && e.message ? e.message : e), true));
  });
}

function init() {
  document.getElementById('savePattern').addEventListener('click', savePattern);
  document.getElementById('loadRetry').addEventListener('click', () => loadCalendars(true));
  wireAddFeed();
  loadLocalFields();
  loadCalendars(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
