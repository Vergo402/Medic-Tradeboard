/**
 * Options page — "Choose your calendars".
 *
 * SAFETY PREMISE. This page is the only place a user can say "this calendar
 * means I am already committed". Until they do, NOTHING blocks: defaultRole()
 * in sw.js gives EVERY calendar OFF, the primary included, so a 24-hour tour on
 * the user's own calendar happily coexists with a shift ranked "top eligible".
 * That is the failure this page exists to fix, so two states are deliberately
 * LOUD:
 *
 *   1. #loadBanner — we could not list the calendars at all (not signed in,
 *      token expired, HTTP error). Never allowed to degrade into a calm empty
 *      list, because an empty list would render as "nothing is blocking" and
 *      hide the real cause.
 *   2. #noBlockBanner — signed in, list loaded, and no calendar blocks anything.
 *
 * A calendar counts as blocking only if its role is REJECT, or its role is RULE
 * AND (it has at least one ticked title OR the advanced pattern hatch is armed).
 * That last clause is why an unloaded RULE calendar can still count: a stored
 * ruleUsePattern blocks via the regex regardless of what titles we have listed.
 * A RULE calendar with nothing ticked and no pattern blocks nothing. This is
 * the shared core/blocks.js definition (see calBlocks below), the same one the
 * drawer uses, so the two surfaces cannot disagree.
 *
 * PRIVACY. Turning a calendar on is the only thing that reads it. We never show
 * event counts on the calendar list itself — that would require reading every
 * calendar including the switched-off ones, breaking PRIVACY.md's promise that
 * only configured calendars are read. Counts appear inside the picker only,
 * which is reached only after a deliberate toggle.
 *
 * ---------------------------------------------------------------------------
 * SERVICE-WORKER CONTRACT ASSUMED BY THIS PAGE
 * ---------------------------------------------------------------------------
 * These are the exact shapes this page sends and expects; a mismatch should be
 * fixed here, not papered over.
 *
 *   → { type: "listCalendarTitles", calendarId }
 *     NOTE: no time window is sent. The options page has no board month, so the
 *     HANDLER owns the range it samples (e.g. a few months either side of now).
 *   ← { ok: true,
 *       accessRole: "owner" | "writer" | "reader" | "freeBusyReader",
 *       titles: [ { title: string,
 *                   count: number,            // occurrences in the sampled range
 *                   minutes: number } ],      // typical duration, minutes
 *       blockTitles: string[],                // persisted Block set (stem match)
 *       noteTitles: string[],                 // persisted Note set (exact match)
 *       titleLabels: { [title]: shortLabel }, // per-event "show as" overrides
 *       calLabel: string }                    // per-calendar short name ("" = none)
 *   ← { ok: false, error: string, accessRole?: string }
 *     error "calendar_off": the worker refuses to read a calendar that is not
 *     switched on, whoever asked. Reachable only out of order — setRole() awaits
 *     setCalendarRole before it asks for titles.
 *     The block/note/label sets are the FULL persisted state, including titles
 *     whose events fall outside the sample and so never render as rows. The
 *     picker seeds its authoritative sets from these and re-sends them whole via
 *     setEventRules, so an off-sample Block title is never dropped — dropping it
 *     would silently weaken blocking.
 *
 *   → { type: "setEventRules", calendarId,
 *       block: string[], note: string[],
 *       labels: { [title]: shortLabel }, calLabel: string }
 *   ← { ok: true } | { ok: false, error: string }
 *     ONE atomic write of the whole three-way picker state for the calendar.
 *     The page sends the entire current sets on every change (snapshot at send
 *     time), so there are no per-control races. The legacy setBlockTitles
 *     handler still exists in sw.js but this page no longer calls it.
 *
 * Tolerated aliases (defensive only — the names above are the contract):
 *   titles[].typicalMinutes / durationMinutes as alternates for `minutes`,
 *   titles[].n as an alternate for `count`,
 *   a bare string instead of an object (title with unknown count/duration).
 *
 * Already in sw.js and unchanged:
 *   → { type: "listCalendars", interactive }
 *   ← { ok:true, calendars:[{id,summary,primary,role,accessRole,hiddenInGoogle}],
 *       ruleFilter:{include,exclude,usePattern} }
 *     hiddenInGoogle: hidden in Google Calendar but still configured here, so
 *       still read — the row is labelled rather than silently dropped.
 *     usePattern: whether the advanced regex hatch is actually armed.
 *   → { type: "setCalendarRole", calendarId, role }   role ∈ OFF|FLAG|REJECT|RULE
 *   → { type: "setRuleFilter", include, exclude }     (advanced escape hatch only)
 */

// The per-calendar block predicate, shared with content/boot.js's
// anyCalendarBlocks signal so the drawer's muted state and this page's "nothing
// blocks" banner can never disagree. This is why options.html loads options.js
// as type="module".
import { calendarBlocks } from '../core/blocks.js';

// `commitmentLabel` must match core/rowshape.js's DEFAULT_COMMITMENT_LABEL,
// which is what content/boot.js falls back to. `ruleInclude` must match sw.js's
// DEFAULTS.ruleInclude and must stay a real, non-empty, anchored pattern:
// new RegExp("") matches EVERY string, so an empty include would make a RULE
// calendar hard-reject all of its events and silently hide every shift.
const DEFAULTS = {
  ruleInclude: '^Work\\b',
  ruleExclude: '',
  commitmentLabel: 'Commitment'
};

// Plain-language labels. The STORED values are unchanged — only the words move.
const ROLE_CHOICES = [
  { role: 'REJECT', label: 'All of it blocks' },
  { role: 'RULE', label: 'Only some events' },
  { role: 'FLAG', label: 'Notes only' }
];

// The role a calendar takes the moment its toggle is ticked. FLAG, never
// REJECT: turning a switch on must not silently start hiding shifts. Blocking
// is always a second, deliberate choice.
const ROLE_ON_ENABLE = 'FLAG';

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

const state = {
  calendars: [],          // [{id, summary, primary, role}]
  loadError: null,        // string | null — set means the LOUD load banner shows
  // calId -> { status, accessRole, error, saveError,
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
  // Google returns the account email as the primary calendar's summary — not a
  // name, and an address we should not be rendering.
  return cal.primary ? 'Your calendar' : (cal.summary || '(unnamed calendar)');
}

// Human wording for the sw.js error strings ("auth_required", "auth_expired",
// "oauth_config: …", "http_403", "fetch_failed: …", "sw_unreachable: …").
function explainError(err) {
  const e = String(err || '');
  if (e === 'auth_required') {
    return { title: 'Not connected to Google', body: 'This page has not been given access to your Google Calendar yet, so it cannot show you any calendars — and nothing is blocking shifts.' };
  }
  if (e === 'auth_expired') {
    return { title: 'Google sign-in expired', body: 'Your access to Google Calendar expired. Until you reconnect, no calendar is being read and nothing is blocking shifts.' };
  }
  if (e.startsWith('oauth_config')) {
    return { title: 'Extension is not configured for sign-in', body: 'Google refused the sign-in request because of the extension\'s OAuth configuration: ' + e };
  }
  if (e.startsWith('http_')) {
    return { title: 'Google refused the request', body: 'Google Calendar returned ' + e.replace('http_', 'HTTP ') + '. No calendars could be listed, so nothing is blocking shifts.' };
  }
  if (e === 'calendar_off') {
    return { title: 'That calendar is switched off', body: 'The extension only reads calendars that are switched on here, so it did not open this one. Switch it on and try again.' };
  }
  if (e.startsWith('sw_unreachable')) {
    return { title: 'The extension\'s background worker did not answer', body: e + '. Try reloading this page; if it persists, reload the extension.' };
  }
  return { title: 'Can’t read your calendar list', body: 'Something went wrong: ' + e + '. No calendars could be listed, so nothing is blocking shifts.' };
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
  if (total === 0 || on.length === 0) {
    note.textContent = 'These are the calendar names on your account. Their contents are not read unless you switch one on.';
    return;
  }
  const off = state.calendars.filter((c) => c.role === 'OFF').map(calDisplayName);
  let text = 'Reading ' + on.length + ' of ' + total + ' calendar' + (total === 1 ? '' : 's') + '.';
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
  return { blockSet: new Set(), noteSet: new Set(), labels: new Map(), calLabel: '' };
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
  return {
    blockSet,
    noteSet,
    labels,
    calLabel: typeof resp.calLabel === 'string' ? resp.calLabel : ''
  };
}

async function loadTitles(calId, force) {
  const existing = state.titles.get(calId);
  if (!force && existing && existing.status === 'ok') return existing;
  state.titles.set(calId, { status: 'loading', items: [], ...emptyThreeWay() });
  render();

  const resp = await send({ type: 'listCalendarTitles', calendarId: calId });
  if (!resp.ok) {
    state.titles.set(calId, {
      status: 'error',
      error: resp.error,
      accessRole: resp.accessRole,
      items: [],
      ...emptyThreeWay()
    });
  } else {
    state.titles.set(calId, {
      status: 'ok',
      accessRole: resp.accessRole || '',
      items: normalizeTitleItems(resp.titles),
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
    const resp = await send({
      type: 'setEventRules',
      calendarId: calId,
      block: Array.from(t.blockSet),
      note: Array.from(t.noteSet),
      labels,
      calLabel: (typeof t.calLabel === 'string' ? t.calLabel : '').trim()
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

function modeOf(t, title) {
  if (t.blockSet.has(title)) return 'block';
  if (t.noteSet.has(title)) return 'note';
  return 'ignore';
}

function buildFreeBusyNotice(cal) {
  const box = el('div', 'freebusy');
  box.appendChild(el('div', null,
    'This calendar only shares free/busy times with you, not event titles, so its '
    + 'individual events cannot be listed. Pick one of the two things it can still do.'));
  const acts = el('div', 'acts');

  const blockAll = el('button', null, 'Block every busy time');
  blockAll.type = 'button';
  blockAll.addEventListener('click', () => setRole(cal.id, 'REJECT'));

  const notes = el('button', 'ghost', 'Notes only');
  notes.type = 'button';
  notes.addEventListener('click', () => setRole(cal.id, 'FLAG'));

  acts.appendChild(blockAll);
  acts.appendChild(notes);
  box.appendChild(acts);
  return box;
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
  return row;
}

function buildPicker(cal) {
  const wrap = el('div', 'picker');
  wrap.appendChild(el('h3', null, 'What matters on this calendar?'));
  wrap.appendChild(el('p', 'hint',
    'Mark an event Block to knock out an overlapping shift, or Note to leave a '
    + 'reminder. Everything you leave on Ignore is dropped.'));

  const t = state.titles.get(cal.id);

  if (!t || t.status === 'loading') {
    wrap.appendChild(el('div', 'cal-status', 'Reading this calendar…'));
    return wrap;
  }

  if (t.status === 'error' || t.accessRole === 'freeBusyReader') {
    if (t.accessRole === 'freeBusyReader') {
      wrap.appendChild(buildFreeBusyNotice(cal));
      return wrap;
    }
    const info = explainError(t.error);
    const err = el('div', 'cal-status error',
      'Could not read this calendar — ' + info.title + ' (' + t.error + '). '
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
      'No events found on this calendar, so nothing here can block a shift.'));
    return wrap;
  }

  // Per-calendar short name: prefixes every note from this calendar in place of
  // its full display name. No render() on input — same reasoning as "show as".
  const calLabelRow = el('div', 'cal-label-row');
  calLabelRow.appendChild(el('label', null, 'Show this calendar as →'));
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

  const resp = await send({ type: 'setCalendarRole', calendarId: calId, role });
  if (!resp.ok) {
    cal.role = previous;
    cal.roleError = 'Not saved (' + resp.error + ') — this calendar is still "'
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
  if (cal.hiddenInGoogle) {
    // It is hidden in Google Calendar but still configured here, so it is still
    // being read. Saying so is the difference between "why is this blocking me?"
    // and a calendar the user cannot find to turn off.
    const tag = el('span', 'tag', 'hidden in Google Calendar');
    tag.title = 'You hid this calendar in Google Calendar. It is still switched '
      + 'on here, so it still counts.';
    name.appendChild(tag);
  }
  head.appendChild(name);
  card.appendChild(head);

  if (on) {
    const body = el('div', 'cal-body');
    body.appendChild(buildRoleRow(cal));
    if (cal.roleError) body.appendChild(el('div', 'cal-status error', cal.roleError));

    const t = state.titles.get(cal.id);
    if (cal.role === 'RULE') {
      body.appendChild(buildPicker(cal));
    } else if (t && t.status === 'error') {
      // Toggled on but the read failed: never let it look "on and fine".
      body.appendChild(el('div', 'cal-status error',
        'This calendar is switched on but could not be read (' + t.error
        + '), so nothing from it is being applied.'));
    } else if (t && t.accessRole === 'freeBusyReader' && cal.role !== 'REJECT') {
      body.appendChild(el('div', 'cal-status',
        'This calendar only shares free/busy times, so its event names cannot be listed. '
        + '“Only some events” is not available for it.'));
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

  const resp = await send({ type: 'listCalendars', interactive: Boolean(interactive) });
  if (!resp.ok) {
    state.loadError = resp.error || 'unknown_error';
    state.calendars = [];
    render();
    return;
  }
  state.loadError = null;
  state.calendars = (resp.calendars || []).map((c) => ({
    id: c.id,
    summary: c.summary || '',
    primary: c.primary === true,
    role: c.role || 'OFF',
    hiddenInGoogle: c.hiddenInGoogle === true,
    roleError: null
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
// commitmentLabel + the advanced pattern escape hatch
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

function paintChip() {
  const raw = document.getElementById('commitmentLabel').value.trim();
  document.getElementById('chipPreview').textContent =
    '✕ ' + (raw || DEFAULTS.commitmentLabel);
}

function saveCommitmentLabel() {
  const field = document.getElementById('commitmentLabel');
  const label = field.value.trim() === '' ? DEFAULTS.commitmentLabel : field.value.trim();
  chrome.storage.local.set({ commitmentLabel: label }, () => {
    field.value = label;
    paintChip();
    setStatus('status', 'Saved');
  });
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
    const label = (typeof items.commitmentLabel === 'string' && items.commitmentLabel.trim())
      ? items.commitmentLabel
      : DEFAULTS.commitmentLabel;
    document.getElementById('commitmentLabel').value = label;
    // The RAW stored pattern is shown, not the compiled fallback: when a stored
    // regex is broken sw.js silently uses the default, but the user still needs
    // to see the broken value in order to fix it.
    document.getElementById('ruleInclude').value =
      typeof items.ruleInclude === 'string' && items.ruleInclude.trim()
        ? items.ruleInclude
        : DEFAULTS.ruleInclude;
    document.getElementById('ruleExclude').value =
      typeof items.ruleExclude === 'string' ? items.ruleExclude : DEFAULTS.ruleExclude;
    paintChip();
  });
}

function init() {
  document.getElementById('commitmentLabel').addEventListener('input', paintChip);
  document.getElementById('commitmentLabel').addEventListener('change', saveCommitmentLabel);
  document.getElementById('savePattern').addEventListener('click', savePattern);
  document.getElementById('loadRetry').addEventListener('click', () => loadCalendars(true));
  loadLocalFields();
  loadCalendars(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
