/**
 * content/board.js — classic content script, attaches window.MedicBoard.
 *
 * Content scripts listed in the same manifest content_scripts entry share
 * one JS realm (the "isolated world") and Chrome runs their synchronous
 * top-level code in array order. boot.js (listed after this file in
 * manifest.json's content_scripts array) calls window.MedicBoard.* as
 * soon as its own script executes, so window.MedicBoard is attached
 * SYNCHRONOUSLY at the bottom of this IIFE, not inside a .then()/after an
 * await.
 *
 * READ-ONLY toward W2W: the one fetch below targets only
 * empschedule?...&MyView=Future — never an action endpoint.
 */
(function () {
  "use strict";

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

  window.MedicBoard = { fetchMysched };
})();
