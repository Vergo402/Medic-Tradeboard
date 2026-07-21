/**
 * content/board.js — classic content script, attaches window.MedicBoard.
 *
 * Content scripts listed in the same manifest content_scripts entry share
 * one JS realm (the "isolated world") and Chrome runs their synchronous
 * top-level code in array order. boot.js (listed after this file in
 * manifest.json's content_scripts array) calls window.MedicBoard.* as
 * soon as its own script executes, so window.MedicBoard is attached
 * SYNCHRONOUSLY at the bottom of this IIFE, not inside a .then()/after an
 * await — only the *use* of the dynamically-imported core modules is
 * deferred (awaited inside fullSweep/fetchMysched), not the namespace
 * assignment itself.
 *
 * READ-ONLY toward W2W: every fetch below targets only
 * empmonthtradeboard (with at most one state param: MTBView / SkillFilter
 * / Date) or empschedule?...&MyView=Future — never an action endpoint,
 * never more than one state param per request (W2W silently ignores any
 * extras).
 */
(function () {
  "use strict";

  const w2wstateReady = import(chrome.runtime.getURL("core/w2wstate.js"));
  const nytimeReady = import(chrome.runtime.getURL("core/nytime.js"));

  // Duplicated from core/w2wstate.js's own copy — see domscan.js's
  // identical comment; this is the established per-file duplication
  // convention in this codebase, not an oversight.
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
  ];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Session-drop check: true when "Sign In" appears within the first ~4000
   * chars of the response AND "Tradeboard" is absent from the WHOLE
   * response text. The scoping is asymmetric on purpose -- only the
   * "Sign In" check is windowed; the "Tradeboard" absence check is
   * unrestricted. Do not assume both terms share the same 4000-char window.
   * @param {string} html
   */
  function isLoggedOut(html) {
    return html.slice(0, 4000).includes("Sign In") && !html.includes("Tradeboard");
  }

  /**
   * fetchBoardUrl: builds {host}{dll}empmonthtradeboard?SID={sid} plus AT
   * MOST ONE state param — W2W honors only one state param per request and
   * silently ignores the rest. `dll` already carries its own leading+trailing
   * slashes (e.g. "/cgi-bin/w2wCC.dll/", per boot.js's tag.dataset.w2w read),
   * so no slash is inserted here.
   * @param {{host: string, dll: string, sid: string}} base
   * @param {string} [param] e.g. "MTBView=All", "SkillFilter=-1", "Date=8%2F1%2F2026"
   */
  function fetchBoardUrl({ host, dll, sid }, param) {
    const base = `${host}${dll}empmonthtradeboard?SID=${sid}`;
    return param ? `${base}&${param}` : base;
  }

  const LOGGED_OUT = Symbol("logged_out");

  /**
   * Serialized same-origin fetch — never parallel; W2W's server-side view
   * state is shared across requests for a session. Returns response text,
   * or the LOGGED_OUT sentinel if the session dropped.
   */
  async function doFetch(url) {
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    if (isLoggedOut(html)) return LOGGED_OUT;
    return html;
  }

  /**
   * Fire `param` as a bare nudge, then poll (re-firing the same nudge each
   * attempt) until `check(html)` passes. Up to 8 attempts, 1500 + 500*n ms
   * backoff between attempts.
   * @returns {Promise<boolean|typeof LOGGED_OUT>}
   */
  async function nudgeAndValidate(ids, param, check) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const html = await doFetch(fetchBoardUrl(ids, param));
      if (html === LOGGED_OUT) return LOGGED_OUT;
      if (check(html)) return true;
      await sleep(1500 + attempt * 500);
    }
    return false;
  }

  /**
   * Validated fetch+retry of one month, with nudge-on-failure branching:
   * check logged-out first, then re-nudge the view if it's wrong, else
   * re-nudge the skill filter if THAT's wrong; a month/date-only mismatch
   * (view and skill both already correct) gets no nudge at all — just a
   * backoff and retry, since that's a server echo lag catching up on its
   * own. `d` is today's day-of-month for the CURRENT (y, mo), else 1 for
   * other months in the sweep.
   * @returns {Promise<string|null|typeof LOGGED_OUT>} html, or null after 8 failed attempts
   */
  async function fetchMonthView(ids, { monthOf, viewOk, skillOk }, expectView, y, mo, d) {
    const want = [MONTH_NAMES[mo - 1], y];
    const dateArg = `${mo}%2F${d}%2F${y}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const html = await doFetch(fetchBoardUrl(ids, `Date=${dateArg}`));
      if (html === LOGGED_OUT) return LOGGED_OUT;
      const [mn, yr] = monthOf(html);
      if (mn === want[0] && yr === want[1] && viewOk(html, expectView) && skillOk(html)) {
        return html;
      }
      if (!viewOk(html, expectView)) {
        const nudged = await doFetch(fetchBoardUrl(ids, `MTBView=${expectView}`));
        if (nudged === LOGGED_OUT) return LOGGED_OUT;
      } else if (!skillOk(html)) {
        const nudged = await doFetch(fetchBoardUrl(ids, "SkillFilter=-1"));
        if (nudged === LOGGED_OUT) return LOGGED_OUT;
      }
      await sleep(1500 + attempt * 500);
    }
    return null;
  }

  /**
   * Fetch every month of the sweep window in MTBView=All, then restore the
   * view state the human was in before the sweep started.
   *
   * priorView and restoreMonth ({y, mo}) are passed in explicitly because
   * neither is derivable inside this function -- the restore step needs to
   * know what view the user was in and what month they were actually
   * looking at before the sweep started. boot.js is this function's only
   * caller and already has both values on hand (the MTBView select's prior
   * value, and domscan's visible-month result), so this doesn't require
   * guessing anything, just wiring it through.
   *
   * `months` intentionally carries no per-month day override ({y, mo}
   * only) — the current-month-uses-today.day rule is applied here instead,
   * via this module's own core/nytime.js import, rather than smuggling a
   * `d` field onto the months the caller passes in.
   *
   * @param {{host: string, dll: string, sid: string, months: Array<{y: number, mo: number}>,
   *   expectView: string, priorView: string, restoreMonth: {y: number, mo: number},
   *   onProgress?: (done: number, total: number) => void}} opts
   * @returns {Promise<{monthHtmls: Array<{y: number, mo: number, html: string|null}>, restored: boolean}|{error: "logged_out"}>}
   */
  async function fullSweep({ host, dll, sid, months, expectView, priorView, restoreMonth, onProgress }) {
    const w2wstate = await w2wstateReady;
    const { civilFromEpoch } = await nytimeReady;
    const ids = { host, dll, sid };
    const todayCivil = civilFromEpoch(Date.now() / 1000);

    // Step 1: set MTBView=All (validated+retried), then SkillFilter=-1
    // (validated+retried) — this extension only ever scans one view, so
    // there's a single view-major nudge rather than separately nudging
    // multiple views (All/Drop/Trade/TD).
    let r = await nudgeAndValidate(ids, `MTBView=${expectView}`, (h) => w2wstate.viewOk(h, expectView));
    if (r === LOGGED_OUT) return { error: "logged_out" };
    r = await nudgeAndValidate(ids, "SkillFilter=-1", (h) => w2wstate.skillOk(h));
    if (r === LOGGED_OUT) return { error: "logged_out" };

    // Step 2: per-month validated fetch, serialized (never parallel).
    const monthHtmls = [];
    let done = 0;
    for (const { y, mo } of months) {
      const d = (y === todayCivil.y && mo === todayCivil.mo) ? todayCivil.d : 1;
      const html = await fetchMonthView(ids, w2wstate, expectView, y, mo, d);
      if (html === LOGGED_OUT) return { error: "logged_out" };
      monthHtmls.push({ y, mo, html }); // html is null if never validated in 8 attempts
      done += 1;
      if (onProgress) onProgress(done, months.length);
    }

    // Step 3 (logged-out detection) is folded into doFetch/fetchMonthView/
    // nudgeAndValidate above rather than a separate pass — every response
    // this function reads goes through doFetch, which checks it.

    // Step 4: restore, success OR failure. Single fire-and-forget nudges
    // (not validated/retried like steps 1/2) — one MTBView nudge and one
    // Date nudge, no retry loop.
    let rv = await doFetch(fetchBoardUrl(ids, `MTBView=${priorView}`));
    if (rv === LOGGED_OUT) return { error: "logged_out" };
    const rm = restoreMonth || { y: todayCivil.y, mo: todayCivil.mo };
    let rd = await doFetch(fetchBoardUrl(ids, `Date=${rm.mo}%2F1%2F${rm.y}`));
    if (rd === LOGGED_OUT) return { error: "logged_out" };

    return { monthHtmls, restored: true };
  }

  /**
   * One fetch of the user's own "My Upcoming Shifts" view. No retry, no
   * logged-out handling here (spec: "one fetch, credentials include") —
   * core/mysched.js's parseMysched() already returns status:"unrecognized"
   * for a login-page response, so a session drop degrades gracefully into
   * the fallbackFromTradeboard() path in boot.js rather than needing
   * special-casing here.
   * @param {{host: string, dll: string, sid: string}} opts
   * @returns {Promise<string>} raw HTML
   */
  async function fetchMysched({ host, dll, sid }) {
    const url = `${host}${dll}empschedule?SID=${sid}&MyView=Future`;
    const res = await fetch(url, { credentials: "include" });
    return res.text();
  }

  window.MedicBoard = { fullSweep, fetchMysched };
})();
