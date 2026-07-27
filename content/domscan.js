/**
 * content/domscan.js — classic content script, attaches
 * window.MedicDomscan.
 *
 * MV3 content scripts cannot be ES modules, but classic scripts can still
 * call the dynamic `import()` function; it returns a promise for the
 * module namespace object of an extension-page ESM module reached via
 * chrome.runtime.getURL(). That promise is kicked off synchronously at the
 * top of this file so it's already in flight by the time any method below
 * is called, but is only *awaited* inside each method body.
 *
 * IMPORTANT: window.MedicDomscan is assigned SYNCHRONOUSLY at the bottom of
 * this IIFE (not inside a .then()/after an await). Content scripts listed
 * in the same manifest content_scripts entry share one JS realm (the
 * "isolated world") and Chrome runs them in array order, but that only
 * guarantees their synchronous top-level code runs in order — it says
 * nothing about when async work inside them finishes. boot.js (listed after
 * this file in manifest.json's content_scripts array) references
 * window.MedicDomscan as soon as its own script executes, so if this
 * namespace were attached inside an async continuation instead, it could
 * still be undefined at that point.
 */
(function () {
  "use strict";

  const w2wstateReady = import(chrome.runtime.getURL("core/w2wstate.js"));
  const parseReady = import(chrome.runtime.getURL("core/parse.js"));

  // Duplicated locally rather than imported from core/w2wstate.js — that
  // module only exposes the month *regex probe* (monthOf), not this name
  // list. core/w2wstate.js and content/board.js each keep their own copy
  // too; matching that existing convention rather than inventing a shared
  // constants file.
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
  ];

  /**
   * Locate the tradeboard anchor for a given w2w_id, for badges.js's
   * in-cell chip placement and boot.js's row-click scroll-into-view.
   *
   * NOT a literal match on `'${w2wId}'` as a bare substring: parse.js's own
   * capture regex (core/parse.js's innerRegex) shows the onclick
   * attribute is `CCL(this,'MARKER+ID')` with the single kind-marker
   * character (*, #, !, or $) immediately inside the opening quote, e.g.
   * `CCL(this,'*128371')` for w2w_id "128371" — never `CCL(this,'128371')`.
   * A plain `includes("'128371'")` check would therefore never match any
   * real anchor, since the character right after the quote is always the
   * marker, not the first digit. This scans for the id preceded by any one
   * of the four marker characters instead.
   * @param {string} w2wId
   * @returns {Element|null}
   */
  function findAnchor(w2wId) {
    const marker = /^[*#!$]/;
    const anchors = document.querySelectorAll("a[onclick*=\"CCL(this,'\"]");
    for (const a of anchors) {
      const onclick = a.getAttribute("onclick") || "";
      const m = onclick.match(/CCL\(this,'([*#!$]\d+)'\)/);
      if (m && m[1].slice(1) === w2wId && marker.test(m[1])) return a;
    }
    return null;
  }

  /**
   * @param {{strategy?: "dom"|"refetch"|"diag", host: string, dll: string, sid: string}} opts
   * @returns {Promise<{records: object[], anchors: number, year: number, month: number, monthName: string, source: "dom"|"refetch"}|{error: "no_month_header"}>}
   */
  async function scanVisibleMonth({ strategy, host, dll, sid } = {}) {
    const mode = strategy || "dom"; // storage default per the module contract (boot.js must match)
    const { monthOf } = await w2wstateReady;
    const { parseMonth } = await parseReady;

    const [monthName, year] = monthOf(document.documentElement.outerHTML);
    if (!monthName) return { error: "no_month_header" };
    const month = MONTH_NAMES.indexOf(monthName) + 1;

    // `anchors` rides along with `records` from the SAME parse so boot.js can
    // run core/parse.js's driftCheck against the very HTML that produced the
    // records (a second, independent DOM parse could pair refetch records with
    // DOM anchors and fire a false drift).
    async function domResult() {
      const { records, anchors } = parseMonth(document.body.innerHTML, year, month);
      return { records, anchors, year, month, monthName, source: "dom" };
    }

    async function refetchResult() {
      // Bare board URL, NO state params — mutates nothing server-side, per
      // the read-only hard rule. Same-origin, credentials included so the
      // existing W2W session cookie is sent (no credential handling here).
      const url = `${host}${dll}empmonthtradeboard?SID=${sid}`;
      const res = await fetch(url, { credentials: "include" });
      const html = await res.text();
      const { records, anchors } = parseMonth(html, year, month);
      return { records, anchors, year, month, monthName, source: "refetch" };
    }

    if (mode === "dom") return domResult();

    if (mode === "diag") {
      // Stage-0 live evidence collector: run both, log a comparison, but
      // still return the refetch result (the raw-HTML baseline) so a
      // stray "diag" strategy value doesn't change scoring behavior.
      const [dom, refetch] = await Promise.all([domResult(), refetchResult()]);
      const domIds = dom.records.map((r) => r.w2w_id).sort((a, b) => Number(a) - Number(b));
      const refetchIds = refetch.records.map((r) => r.w2w_id).sort((a, b) => Number(a) - Number(b));
      const equal = domIds.length === refetchIds.length && domIds.every((id, i) => id === refetchIds[i]);
      console.log("[medic-diag]", JSON.stringify({
        domCount: dom.records.length,
        refetchCount: refetch.records.length,
        domIds,
        refetchIds,
        equal,
      }));
      console.log("[medic-diag] dom records", JSON.stringify(dom.records));
      return refetch;
    }

    return refetchResult();
  }

  window.MedicDomscan = { scanVisibleMonth, findAnchor };
})();
