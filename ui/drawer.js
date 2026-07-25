/**
 * ESM module -- dynamic-imported via chrome.runtime.getURL('ui/drawer.js').
 *
 * export function initDrawer(callbacks) -> controller
 *   callbacks = { onScanAll(), onRowClick(w2w_id), onOpenSetup() }
 *   controller.update(state) fully rerenders the drawer from `state`.
 *
 * Mounting: a single fixed-position host <div> is appended to
 * document.body, right-docked, full viewport height, ~300px wide
 * (24px collapsed), z-index 2147483000. All markup lives inside
 * host.attachShadow({mode:'open'}) so W2W's ancient page CSS can't bleed in
 * and ours can't bleed out onto the board.
 *
 * Stylesheet loading (a deliberate choice): a
 * <link rel="stylesheet" href="chrome.runtime.getURL('ui/drawer.css')">
 * appended once into the shadow root, rather than fetch()+<style>. A <link>
 * lets the browser parse/cache the stylesheet the normal way and needs no
 * extra fetch-and-inline plumbing; ui/drawer.css is already declared under
 * web_accessible_resources in manifest.json so the cross-origin load is
 * permitted from the whentowork.com page.
 *
 * Local (non-`state`) UI state -- collapsed, the tour filter, whether the
 * REJECTED section is expanded, the compose-text selection (`selected`, a
 * Set of w2w_id strings), whether the compose preview is open
 * (`composeOpen`), and the transient post-copy flash (`copyFlash` /
 * `copyFlashTimer`) -- lives in this closure and survives every
 * controller.update() call, since update() is documented as a full
 * innerHTML rebuild of the shadow root's content and would otherwise wipe
 * it. Rank numbers are never renumbered: filtering only narrows the arrays
 * passed to the row renderers, it never re-indexes them.
 */

import { composeMessage } from "../core/compose.js";

const WIDTH_PX = 300;
const COLLAPSED_PX = 24;
const Z_INDEX = 2147483000;
const HOST_ID = "medic-shift-drawer-host";

const TOUR_PILL = {
  day: { bg: "#3a2f14", color: "#ffb428" },
  night: { bg: "#16243a", color: "#5aa9ff" },
};
const NEW_PILL = { bg: "#33290f", color: "#ffb428" };
const TIER_COLOR = { t1: "#3fd68f", t2: "#ffb428", t3: "#8b98ab" };

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * "2m ago" / "3h ago" / "5d ago" formatting plus the color band the status
 * line uses: green under 2h, amber 2-24h, red at/after 24h. A null age is
 * displayed as "—" and colored red -- grouping "no calendar data at all"
 * under the same red/warning color as "stale calendar data," so the absence
 * of data reads at least as alarming as staleness would. Documented as a
 * deliberate assumption, not an oversight.
 */
function calAgeInfo(calAgeMs) {
  if (calAgeMs == null) return { text: "—", cls: "red" };
  const mins = calAgeMs / 60000;
  const hrs = calAgeMs / 3600000;
  let text;
  if (mins < 1) text = "<1m ago";
  else if (mins < 60) text = `${Math.round(mins)}m ago`;
  else if (hrs < 24) text = `${Math.round(hrs)}h ago`;
  else text = `${Math.round(hrs / 24)}d ago`;
  const cls = hrs < 2 ? "green" : hrs < 24 ? "amber" : "red";
  return { text, cls };
}

function myschedHtml(status) {
  if (status === "ok") return '<span class="mysched mysched-ok">✓</span>';
  if (status === "partial") return '<span class="mysched mysched-partial">partial</span>';
  return '<span class="mysched mysched-none">—</span>';
}

function calSegmentHtml(state) {
  if (state.calError) {
    // Any truthy error needs a visible signal rather than silently falling back
    // to the healthy age display. A feed that did not load gets its own wording,
    // because it is the actionable case: the user has a link to fix.
    const isFeed = String(state.calError).startsWith("feed_failed");
    return `<span class="cal-age cal-red" title="${escapeHtml(state.calError)}">${
      isFeed ? "FEED ERR" : "CAL ERR"
    }</span>`;
  }
  const { text, cls } = calAgeInfo(state.calAgeMs);
  return `<span class="cal-age cal-${cls}">${escapeHtml(text)}</span>`;
}

function boldDayNumber(dateLabel) {
  const label = String(dateLabel == null ? "" : dateLabel);
  const idx = label.lastIndexOf(" ");
  if (idx === -1) return escapeHtml(label);
  return `${escapeHtml(label.slice(0, idx + 1))}<b>${escapeHtml(label.slice(idx + 1))}</b>`;
}

function scoreText(score) {
  return score >= 999 ? "999" : String(Math.round(score));
}

function tourKey(tour) {
  return String(tour || "").toLowerCase() === "night" ? "night" : "day";
}

function unitLabel(pos) {
  return String(pos || "").replace(/^Medic\s+/, "M") || pos;
}

function unitOptions(state) {
  const seen = new Set();
  for (const x of [...(state.rows || []), ...(state.rejects || [])]) {
    if (x.pos) seen.add(x.pos);
  }
  return Array.from(seen).sort();
}

function pillHtml(text, bg, color, extraClass) {
  return `<span class="pill${extraClass ? " " + extraClass : ""}" style="background:${bg};color:${color};">${escapeHtml(text)}</span>`;
}

function noticeHtml(notice) {
  return `<div class="notice">${escapeHtml(notice)}</div>`;
}

function bannerHtml(banner) {
  const segs = [];
  if (banner.newCount > 0) segs.push(`<span class="banner-new">+${banner.newCount} new</span>`);
  if (banner.goneLabels && banner.goneLabels.length) {
    segs.push(`<span class="banner-gone">${banner.goneLabels.length} gone (${escapeHtml(banner.goneLabels.join(" · "))})</span>`);
  }
  if (banner.changedCount > 0) segs.push(`<span class="banner-changed">${banner.changedCount} change</span>`);
  return `<div class="since-banner"><div class="since-label">SINCE LAST VISIT</div><div class="since-segs">${segs.join(" · ")}</div></div>`;
}

function statsHtml(stats) {
  const best = stats.best == null ? "—" : `${Math.round(stats.best)}h`;
  return `<div class="stats">
    <div class="stat-tile stat-elig"><b>${escapeHtml(stats.elig)}</b><span>ELIG</span></div>
    <div class="stat-tile stat-rej"><b>${escapeHtml(stats.rej)}</b><span>REJ</span></div>
    <div class="stat-tile stat-best"><b>${escapeHtml(best)}</b><span>BEST</span></div>
    <div class="stat-tile stat-top"><b>${escapeHtml(stats.topCount)}</b><span>≥47H</span></div>
  </div>`;
}

/**
 * The stats strip in the de-confidence (no-calendar-blocks) state. Only the
 * first tile carries a real number — OPEN, the count of open shifts. The other
 * three are dashed and muted on purpose: without a blocking calendar there is
 * no honest BLOCKED / BEST / ≥47H to report, so we show "—" rather than a
 * number that looks like a real ranking. (REJECTED's own header count can still
 * be non-zero here — those rejects come from the user's own W2W schedule, not a
 * calendar — so it too is muted below.)
 */
function mutedStatsHtml(openCount) {
  return `<div class="stats">
    <div class="stat-tile stat-open"><b>${escapeHtml(openCount)}</b><span>OPEN</span></div>
    <div class="stat-tile stat-muted"><b>—</b><span>BLOCKED</span></div>
    <div class="stat-tile stat-muted"><b>—</b><span>BEST</span></div>
    <div class="stat-tile stat-muted"><b>—</b><span>≥47H</span></div>
  </div>`;
}

/** The red "we are not checking your calendar" block, shown above the stats
 * whenever no feed is set to block. Its CTA shares the gear's data-action so
 * both routes reach onOpenSetup(). */
function deconfidenceBannerHtml() {
  return `<div class="deconf-banner">
    <div class="deconf-head">Not checking your calendar</div>
    <div class="deconf-body">No feed is set to block, so these are all open shifts — not shifts you're free for. Some may overlap what you already have.</div>
    <button type="button" class="deconf-cta" data-action="open-setup">Add a feed →</button>
  </div>`;
}

/**
 * Pull the feed name out of sw.js's `feed_failed: "<name>" — <why>` error so the
 * banner can say WHICH feed to go fix. Falls back to neutral wording rather than
 * rendering the raw error string at a user.
 */
function feedErrorDetail(err) {
  const m = /^feed_failed: "([^"]*)"/.exec(String(err || ""));
  const who = m ? m[1] : "";
  return who
    ? `${who} didn't load, so these shifts aren't checked against it.`
    : "A calendar feed didn't load, so these shifts aren't checked against it.";
}

/**
 * The red "a blocking feed did not load" block. Reuses the de-confidence
 * styling because it means the same thing to the user — nothing here is a real
 * ranking — and it replaces that banner rather than stacking with it.
 *
 * This is the visible half of sw.js's failure policy: a feed that can hard-reject
 * shifts failed to load, so the board is NOT scored at all. Scoring anyway would
 * render every shift as free, including the ones the user is already committed to.
 */
function feedErrorBannerHtml(state) {
  return `<div class="deconf-banner">
    <div class="deconf-head">Not scoring right now</div>
    <div class="deconf-body">${escapeHtml(feedErrorDetail(state.calError))}</div>
    <button type="button" class="deconf-cta" data-action="open-setup">Fix feed →</button>
  </div>`;
}

function filterRowHtml(filterTour) {
  const btn = (val, label) =>
    `<button type="button" class="filter-btn${filterTour === val ? " active" : ""}" data-action="filter" data-tour="${val}">${label}</button>`;
  return `<div class="filter-row">${btn("ALL", "ALL")}${btn("DAY", "DAY")}${btn("NIGHT", "NIGHT")}</div>`;
}

function filterUnitRowHtml(filterUnit, options) {
  if (options.length < 2) return "";
  const btn = (val, label) =>
    `<button type="button" class="filter-btn${filterUnit === val ? " active" : ""}" data-action="filter-unit" data-unit="${escapeHtml(val)}">${escapeHtml(label)}</button>`;
  return `<div class="filter-row">${btn("ALL", "ALL")}${options.map((p) => btn(p, unitLabel(p))).join("")}</div>`;
}

/**
 * Shared checkbox markup for both eligible rows and reject rows -- always
 * the FIRST flex child of its row container, per the approved mockup.
 * @param {{w2w_id:string, dateLabel:string, tour:string, pos:string}} x
 * @param {boolean} checked
 */
function checkboxHtml(x, checked) {
  return `<input type="checkbox" class="row-check" data-action="toggle-select" data-id="${escapeHtml(x.w2w_id)}" aria-label="Select ${escapeHtml(x.dateLabel)} ${escapeHtml(x.tour)} ${escapeHtml(x.pos)}"${checked ? " checked" : ""}>`;
}

function rowHtml(row, checked, muted) {
  const tk = tourKey(row.tour);
  const pill = TOUR_PILL[tk];
  const tourPill = pillHtml(String(row.tour || "").toUpperCase(), pill.bg, pill.color, `pill-${tk}`);
  const newPill = row.isNew ? " " + pillHtml("NEW", NEW_PILL.bg, NEW_PILL.color, "pill-new") : "";
  const line2 = (row.famLabels && row.famLabels.length)
    ? `<span class="fam-line">${escapeHtml(row.famLabels.join(" · "))}</span>`
    : `<span class="loc-line">${escapeHtml(row.locLine)}</span>`;
  if (muted) {
    // De-confidence variant: no rank number (a muted bullet), no tier color, a
    // muted "?" where the score would be, and a "· not checked" tail. The point
    // is that NOTHING in the row looks like a real ranking, because it isn't
    // one — no calendar was consulted.
    return `<div class="row row-muted" data-action="row-click" data-id="${escapeHtml(row.w2w_id)}" role="button" tabindex="0">
    ${checkboxHtml(row, checked)}
    <div class="row-rank row-rank-muted">•</div>
    <div class="row-mid">
      <div class="row-line1">${boldDayNumber(row.dateLabel)} ${tourPill} <span class="row-pos">${escapeHtml(row.pos)}</span>${newPill}</div>
      <div class="row-line2">${line2} · <span class="not-checked">not checked</span></div>
    </div>
    <div class="row-score row-score-muted">?</div>
  </div>`;
  }
  const tierColor = TIER_COLOR[row.tier] || TIER_COLOR.t3;
  const rowClass = row.tier === "t3" ? "row row-dim" : "row";
  return `<div class="${rowClass}" data-action="row-click" data-id="${escapeHtml(row.w2w_id)}" role="button" tabindex="0">
    ${checkboxHtml(row, checked)}
    <div class="row-rank">#${escapeHtml(row.rank)}</div>
    <div class="row-mid">
      <div class="row-line1">${boldDayNumber(row.dateLabel)} ${tourPill} <span class="row-pos">${escapeHtml(row.pos)}</span>${newPill}</div>
      <div class="row-line2">${line2}</div>
    </div>
    <div class="row-score" style="color:${tierColor};">${scoreText(row.score)}h</div>
  </div>`;
}

function rejectHtml(reject, checked, muted) {
  const tk = tourKey(reject.tour);
  const pill = TOUR_PILL[tk];
  const tourPill = pillHtml(String(reject.tour || "").toUpperCase(), pill.bg, pill.color, `pill-${tk}`);
  const rowClass = muted ? "reject-row reject-row-muted" : "reject-row";
  return `<div class="${rowClass}">
    ${checkboxHtml(reject, checked)}
    <div class="reject-mid">
      <div class="reject-line1">${escapeHtml(reject.dateLabel)} ${tourPill} <span class="reject-pos">${escapeHtml(reject.pos)}</span> — <span class="reject-reason">${escapeHtml(reject.reason)}</span></div>
      <div class="reject-line2">${escapeHtml(reject.locLine)}</div>
    </div>
  </div>`;
}

/** State-1 compose bar: renders between the REJECTED section and the
 * footer whenever >=1 shift is selected. */
function composeBarHtml(count) {
  return `<div class="compose-bar">
    <span class="compose-count">${escapeHtml(count)} SELECTED</span>
    <button type="button" class="compose-clear" data-action="clear-selection">✕ CLEAR</button>
    <button type="button" class="compose-btn" data-action="compose-open">TEXT ›</button>
  </div>`;
}

/** State-2 preview view: replaces everything between the header and footer.
 * `copyFlash` ("ok"|"err"|null) is passed in from the closure since this is
 * a plain top-level render helper with no access to it otherwise. */
function composeViewHtml(shifts, copyFlash) {
  const text = composeMessage(shifts);
  const flash = copyFlash === "ok"
    ? '<div class="copy-flash copy-ok">COPIED ✓</div>'
    : copyFlash === "err"
      ? '<div class="copy-flash copy-err">COPY FAILED</div>'
      : "";
  return `<div class="compose-view">
    <div class="preview-topbar">
      <button type="button" class="compose-back" data-action="compose-back">‹ BACK</button>
      <span class="preview-title">TEXT PREVIEW · ${escapeHtml(shifts.length)} SHIFTS</span>
    </div>
    <div class="compose-text">${escapeHtml(text)}</div>
    <button type="button" class="compose-copy" data-action="copy-message">⧉ COPY MESSAGE</button>
    ${flash}
    <div class="compose-caption">Paste into Messages — nothing is sent for you.</div>
  </div>`;
}

function footerHtml(scanning) {
  const active = !!(scanning && scanning.active);
  const label = active
    ? `SCANNING ${escapeHtml(scanning.done)}/${escapeHtml(scanning.total)}…`
    : "↻ SCAN ALL 4 MONTHS";
  return `<div class="footer">
    <button type="button" class="scan-btn" data-action="scan-all"${active ? " disabled" : ""}>${label}</button>
    <div class="footer-note">Read-only — you pull the trigger in W2W.</div>
  </div>`;
}

function headerHtml() {
  return `<div class="header">
    <span class="header-title">MEDIC SHIFT <span class="accent">SCANNER</span></span>
    <button type="button" class="chevron" data-action="toggle-collapse" title="Collapse" aria-label="Collapse drawer">›</button>
  </div>`;
}

function collapsedTabHtml() {
  return `<div class="edge-tab" data-action="toggle-collapse" title="Expand Medic Shift Scanner" role="button" tabindex="0">
    <span class="edge-tab-label">MEDIC</span>
  </div>`;
}

/**
 * @param {{onScanAll?:Function, onRowClick?:Function, onOpenSetup?:Function}} callbacks
 */
export function initDrawer(callbacks) {
  const cb = callbacks || {};

  let collapsed = false;
  let filterTour = "ALL";
  let filterUnit = "ALL";
  let rejectedExpanded = false;
  let lastState = null;
  let originalMarginRight;

  // Compose-text selection state (w2w_id strings). DELIBERATE DESIGN:
  // `selected` is NEVER pruned when a new state arrives -- stale ids simply
  // fail to resolve in selectedShifts() below, so the visible count/message
  // always reflect whatever currently resolves against the latest board
  // state, and selections survive a transient repaint (e.g. a
  // scan-in-progress tick, or a failed calendar reconnect) instead of
  // silently evaporating. ✕ CLEAR is the only explicit reset.
  const selected = new Set();
  let composeOpen = false;
  let copyFlash = null; // "ok" | "err" | null
  let copyFlashTimer = null;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.right = "0";
  host.style.bottom = "0";
  host.style.width = `${WIDTH_PX}px`;
  host.style.zIndex = String(Z_INDEX);
  host.style.pointerEvents = "auto";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("ui/drawer.css");
  shadow.appendChild(link);

  const root = document.createElement("div");
  root.className = "medic-drawer-root";
  shadow.appendChild(root);

  function applyPageMargin() {
    const de = document.documentElement;
    if (originalMarginRight === undefined) originalMarginRight = de.style.marginRight || "";
    de.style.marginRight = collapsed ? originalMarginRight : `${WIDTH_PX}px`;
  }

  function applyHostWidth() {
    host.style.width = collapsed ? `${COLLAPSED_PX}px` : `${WIDTH_PX}px`;
  }

  function applyTourFilter(list) {
    if (filterTour === "ALL") return list || [];
    return (list || []).filter((item) => tourKey(item.tour) === filterTour.toLowerCase());
  }

  function applyUnitFilter(list) {
    if (filterUnit === "ALL") return list || [];
    return (list || []).filter((item) => item.pos === filterUnit);
  }

  /** Resolves `selected`'s w2w_ids against the CURRENT lastState (rows then
   * rejects), returning the full shift objects. See the `selected` closure
   * comment above for why stale ids are silently dropped here rather than
   * pruned from the Set itself. */
  function selectedShifts() {
    if (!lastState) return [];
    const pool = [...(lastState.rows || []), ...(lastState.rejects || [])];
    return pool.filter((x) => selected.has(x.w2w_id));
  }

  /** Shared success/failure path for the copy-message click handler: flip
   * copyFlash, repaint immediately, then clear it back to null after
   * ~1.5s (any earlier pending timer is cancelled first). */
  function flashCopy(status) {
    copyFlash = status;
    clearTimeout(copyFlashTimer);
    render();
    copyFlashTimer = setTimeout(() => {
      copyFlash = null;
      render();
    }, 1500);
  }

  function render() {
    applyHostWidth();
    applyPageMargin();

    if (collapsed) {
      root.innerHTML = collapsedTabHtml();
      return;
    }

    if (composeOpen && selectedShifts().length === 0) composeOpen = false;

    const state = lastState;
    if (!state) {
      root.innerHTML = `${headerHtml()}<div class="status-line">Loading…</div>`;
      return;
    }

    if (state.notice) {
      root.innerHTML = `${headerHtml()}${noticeHtml(state.notice)}`;
      return;
    }

    if (composeOpen) {
      // STATE 2: header + preview view + footer ONLY -- status line, stats,
      // filter row, rows, rejected section, and compose bar are all hidden.
      root.innerHTML = `${headerHtml()}${composeViewHtml(selectedShifts(), copyFlash)}${footerHtml(state.scanning)}`;
      return;
    }

    // STATE 1: the normal list view, plus the compose bar when >=1 shift
    // is selected.
    //
    // The "muted" pass strips every rank number, tier colour and score, so
    // nothing on screen can read as a real ranking. It fires for BOTH ways the
    // board can be unscored:
    //   - no feed is set to block (nothing was ever going to be checked), or
    //   - a blocking feed failed to load, so sw.js refused to score at all.
    // The feed failure wins the banner slot: it names something the user can go
    // fix, and stacking both would just dilute it. When neither holds,
    // EVERYTHING below renders exactly as it did before these states existed.
    const feedBroken = Boolean(state.calError);
    const muted = !state.anyCalendarBlocks || feedBroken;

    let html = headerHtml();
    // Gear, always present, at the end of the status line. It pulses amber
    // (gear-attention) whenever nothing is set to block, calm otherwise.
    const gearClass = state.anyCalendarBlocks ? "gear-btn" : "gear-btn gear-attention";
    html += `<div class="status-line">${escapeHtml(state.monthLabel)} · CAL ${calSegmentHtml(state)} · MYSCHED ${myschedHtml(state.myschedStatus)}<button type="button" class="${gearClass}" data-action="open-setup" title="Calendar setup" aria-label="Calendar setup">⚙</button></div>`;

    const banner = state.banner;
    const bannerHasContent = banner && (
      (banner.newCount || 0) > 0 ||
      (banner.goneLabels && banner.goneLabels.length) ||
      (banner.changedCount || 0) > 0
    );
    if (bannerHasContent) html += bannerHtml(banner);

    if (feedBroken) html += feedErrorBannerHtml(state);
    else if (muted) html += deconfidenceBannerHtml();

    html += muted
      ? mutedStatsHtml(state.rows ? state.rows.length : 0)
      : statsHtml(state.stats || { elig: 0, rej: 0, best: null, topCount: 0 });
    html += filterRowHtml(filterTour);
    html += filterUnitRowHtml(filterUnit, unitOptions(state));

    const rows = applyUnitFilter(applyTourFilter(state.rows));
    html += `<div class="rows-scroll">${
      rows.length
        ? rows.map((row) => rowHtml(row, selected.has(row.w2w_id), muted)).join("")
        : '<div class="empty-msg">No eligible shifts this window.</div>'
    }</div>`;

    const rejects = applyUnitFilter(applyTourFilter(state.rejects));
    html += `<div class="rejected-section">
      <div class="rejected-header" data-action="toggle-rejected" role="button" tabindex="0">
        <span class="rejected-chevron">${rejectedExpanded ? "⌄" : "›"}</span>
        <span class="rejected-title">REJECTED (${rejects.length})</span>
      </div>
      ${rejectedExpanded ? `<div class="rejected-list">${
        rejects.length
          ? rejects.map((reject) => rejectHtml(reject, selected.has(reject.w2w_id), muted)).join("")
          : '<div class="empty-msg">No rejected shifts.</div>'
      }</div>` : ""}
    </div>`;

    const selCount = selectedShifts().length;
    if (selCount > 0) html += composeBarHtml(selCount);

    html += footerHtml(state.scanning);

    root.innerHTML = html;
  }

  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "toggle-collapse") {
      collapsed = !collapsed;
      render();
    } else if (action === "open-setup") {
      cb.onOpenSetup && cb.onOpenSetup();
    } else if (action === "filter") {
      filterTour = target.dataset.tour;
      render();
    } else if (action === "filter-unit") {
      filterUnit = target.dataset.unit;
      render();
    } else if (action === "toggle-rejected") {
      rejectedExpanded = !rejectedExpanded;
      render();
    } else if (action === "scan-all") {
      if (target.hasAttribute("disabled")) return;
      cb.onScanAll && cb.onScanAll();
    } else if (action === "row-click") {
      cb.onRowClick && cb.onRowClick(target.dataset.id);
    } else if (action === "toggle-select") {
      // NOTE: the checkbox is the innermost [data-action] element, so
      // event.target.closest("[data-action]") above already resolved to
      // it (target === the checkbox) and the parent row's row-click never
      // fires. Relying on that; do NOT add stopPropagation.
      const id = target.dataset.id;
      if (target.checked) selected.add(id); else selected.delete(id);
      render();
      // The innerHTML rebuild inside render() destroys the focused node --
      // keyboard users must not lose their place.
      const refocus = root.querySelector('input.row-check[data-id="' + CSS.escape(id) + '"]');
      if (refocus) refocus.focus();
    } else if (action === "clear-selection") {
      selected.clear();
      composeOpen = false;
      render();
    } else if (action === "compose-open") {
      composeOpen = true;
      render();
    } else if (action === "compose-back") {
      composeOpen = false;
      render();
      const backBtn = root.querySelector(".compose-btn");
      if (backBtn) backBtn.focus();
    } else if (action === "copy-message") {
      // Build the text synchronously and call navigator.clipboard.writeText
      // DIRECTLY in this handler -- the click's transient user activation
      // authorizes the write; nothing async runs before it.
      const text = composeMessage(selectedShifts());
      navigator.clipboard.writeText(text)
        .then(() => flashCopy("ok"))
        .catch(() => flashCopy("err"));
    }
  });

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && composeOpen) {
      composeOpen = false;
      render();
      const backBtn = root.querySelector(".compose-btn");
      if (backBtn) backBtn.focus();
      return;
    }
    // CRITICAL: without this guard, Space on a focused checkbox falls
    // through to the row-click branch below (closest('[data-action="row-
    // click"]') reaches the parent row) and flashes the board anchor.
    // Checkboxes handle Space/Enter natively; let that happen undisturbed.
    if (event.target instanceof Element && event.target.matches("input.row-check")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest('[data-action="row-click"], [data-action="toggle-collapse"], [data-action="toggle-rejected"]');
    if (!target) return;
    event.preventDefault();
    target.click();
  });

  // Initial mount: expanded by default, page margin reserved immediately.
  render();

  return {
    update(state) {
      lastState = state;
      render();
    },
  };
}
