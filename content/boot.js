/**
 * content/boot.js — classic content script; the tradeboard page's entry
 * point.
 *
 * MV3 content scripts cannot themselves be ES modules, so core/*.js (which
 * IS ESM) is loaded via dynamic import(chrome.runtime.getURL(...)) instead
 * of a static `import` statement — dynamic import() works fine from a
 * classic script and returns a promise for the module namespace object.
 * The whole async body below is wrapped in an async IIFE for that reason.
 *
 * Depends on window.MedicBoard (board.js), window.MedicDomscan (domscan.js),
 * and window.MedicBadges (badges.js) already being attached — manifest.json's
 * content_scripts.js lists board.js, domscan.js, and badges.js before this
 * file for that to hold.
 *
 * This file calls window.MedicBadges.{paintBadges,clearBadges} through a
 * small guarded wrapper (paintBadgesSafe below), so if that namespace is
 * ever missing (e.g. a load-order regression) it degrades to a
 * console.warn instead of a hard crash.
 */
(function () {
  "use strict";

  if (!location.pathname.includes("empmonthtradeboard")) return;

  const MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /**
   * Same session-drop check as board.js's isLoggedOut (kept duplicated —
   * these are two independent classic scripts with no shared module
   * between them). "Sign In" is scoped to the first ~4000 chars; the
   * "Tradeboard" absence check is unrestricted, against the WHOLE document
   * -- do not assume both terms share the same 4000-char window.
   * @param {string} html
   */
  function isLoggedOut(html) {
    return html.slice(0, 4000).includes("Sign In") && !html.includes("Tradeboard");
  }

  /** Minimal drawer state for the two early-exit guard paths, before the
   * full core module set (and the rest of this file's state machinery) is
   * even loaded. */
  function emptyState(notice) {
    return {
      monthLabel: "",
      calAgeMs: null,
      calError: null,
      myschedStatus: "none",
      banner: null,
      stats: { elig: 0, rej: 0, best: null, topCount: 0 },
      rows: [],
      rejects: [],
      scanning: null,
      notice: notice || null,
      // Whether ANY calendar is configured to block a shift. false here is the
      // honest default for the early-exit guards (logged out / no page
      // identity): no config has been read yet, so we do not claim to be
      // checking anything.
      anyCalendarBlocks: false,
    };
  }

  (async () => {
    // --- Logged-out guard ---------------------------------------------
    const docHtml = document.documentElement.outerHTML;
    if (isLoggedOut(docHtml)) {
      const { initDrawer } = await import(chrome.runtime.getURL("ui/drawer.js"));
      const controller = initDrawer({ onScanAll() {}, onRowClick() {}, onConnectCalendar() {} });
      controller.update(emptyState("Log in to WhenToWork first"));
      return;
    }

    // --- Page identity ---------------------------------------------------
    const tag = document.querySelector("script[data-sid][data-w2w]");
    if (!tag || !tag.dataset.sid || !tag.dataset.w2w) {
      const { initDrawer } = await import(chrome.runtime.getURL("ui/drawer.js"));
      const controller = initDrawer({ onScanAll() {}, onRowClick() {}, onConnectCalendar() {} });
      controller.update(emptyState("Could not read page identity — reload the tradeboard"));
      return;
    }
    const sid = tag.dataset.sid;
    const dll = tag.dataset.w2w;
    const host = location.origin;

    // --- Dynamic-import the core modules + the UI drawer -----------------
    const [parseMod, nytime, scoreMod, diffMod, myschedMod, rowshape, blocksMod, uiMod] = await Promise.all([
      import(chrome.runtime.getURL("core/parse.js")),
      import(chrome.runtime.getURL("core/nytime.js")),
      import(chrome.runtime.getURL("core/score.js")),
      import(chrome.runtime.getURL("core/diff.js")),
      import(chrome.runtime.getURL("core/mysched.js")),
      import(chrome.runtime.getURL("core/rowshape.js")),
      import(chrome.runtime.getURL("core/blocks.js")),
      import(chrome.runtime.getURL("ui/drawer.js")),
    ]);
    const { parseMonth, mergeMonths, driftCheck } = parseMod;
    const { parseCivil, toEpoch, addDays, civilFromEpoch } = nytime;
    const { loadCommitments, evaluate, rankEligible } = scoreMod;
    const { runDiff } = diffMod;
    const { parseMysched, fallbackFromTradeboard } = myschedMod;
    const {
      loc, posShort, tierClass, goneLabel, posterNote, tourOf,
      rejectChipLabel, DEFAULT_COMMITMENT_LABEL,
    } = rowshape;
    const { anyoneBlocks } = blocksMod;
    const { initDrawer } = uiMod;

    // --- User-configured commitment label --------------------------------
    // The word this user uses for "I am already committed" (their department,
    // second job, whatever). core/score.js never sees it: it emits a neutral
    // reason plus a structured rejectKind, and the label is applied HERE, in
    // the display layer. Falls back to the neutral default when unset.
    // Storage key: `commitmentLabel` (chrome.storage.local), shared with the
    // options page.
    const storedLabel = (await chrome.storage.local.get("commitmentLabel")).commitmentLabel;
    const commitmentLabel = (typeof storedLabel === "string" && storedLabel.trim())
      ? storedLabel.trim()
      : DEFAULT_COMMITMENT_LABEL;

    /**
     * Non-merging companion to score.js's loadCommitments(): myShifts and
     * softEvents are passed to evaluate() as UNMERGED per-entry objects --
     * merging soft events would wrongly collapse distinct FAM labels into
     * one. Built from the same parseCivil/toEpoch primitives loadCommitments
     * uses internally, minus the sort+merge pass.
     * @param {Array<[string, string, string]>} triplets
     */
    function parseTriplets(triplets) {
      return (triplets || []).map(([a, b, label]) => {
        const sCivil = parseCivil(a);
        const eCivil = parseCivil(b);
        return { s: toEpoch(sCivil), e: toEpoch(eCivil), label, sCivil, eCivil };
      });
    }

    function civilDateStr(c) {
      return `${c.y}-${pad2(c.mo)}-${pad2(c.d)}`;
    }

    /** "Tue Aug 18" — weekday abbreviation (wd) plus a non-zero-padded
     * "Mon day" (md). Parses the record's own date string directly rather
     * than routing through an epoch/endCivil, which could roll across
     * midnight for an overnight shift. */
    function formatDateLabel(dateStr) {
      const [y, mo, d] = dateStr.split("-").map(Number);
      const wd = WEEKDAY_ABBR[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
      return `${wd} ${MONTH_ABBR[mo - 1]} ${d}`;
    }

    // Day/Night tour rule lives in exactly ONE place: rowshape.js's
    // tourOf(start). Not re-derived here; see tourOf's doc comment for the
    // rule itself.

    function paintBadgesSafe(rows, rejects) {
      if (window.MedicBadges && typeof window.MedicBadges.paintBadges === "function") {
        window.MedicBadges.paintBadges(rows, rejects);
      } else {
        console.warn("[medic-tradeboard] window.MedicBadges.paintBadges not found — badges skipped");
      }
    }

    function sendToSW(msg) {
      return chrome.runtime.sendMessage(msg);
    }

    async function askCalendar(mode) {
      try {
        return await sendToSW({ type: "getCalendarData", mode, windowStart: calWindowStart, windowEnd: calWindowEnd });
      } catch (e) {
        return { ok: false, error: (e && e.message) || "sw_unavailable" };
      }
    }

    // --- Window math: the 4-month scan window (this month plus next 3) ----
    const todayCivil = civilFromEpoch(Date.now() / 1000);
    const todayStr = civilDateStr(todayCivil);
    const months = [];
    for (let i = 0; i < 4; i++) {
      const idx = todayCivil.mo - 1 + i;
      const y = todayCivil.y + Math.floor(idx / 12);
      const mo = (idx % 12) + 1;
      months.push({ y, mo });
    }
    const lastMonth = months[months.length - 1];
    const lastDay = new Date(Date.UTC(lastMonth.y, lastMonth.mo, 0)).getUTCDate();
    const windowEndCivil = { y: lastMonth.y, mo: lastMonth.mo, d: lastDay, h: 0, mi: 0 };
    const windowEnd = civilDateStr(windowEndCivil);

    // The CALENDAR-FETCH window is wider than the shift-SCORING window
    // (todayStr..windowEnd, used below to filter which records get
    // evaluate()'d). The calendar window runs from 4 days before today to
    // 7 days past window end; using the bare [todayStr, windowEnd] pair
    // here would silently drop commitments ending just before today, which
    // evaluate()'s `prevs`
    // lookup needs to correctly score a shift near the window's leading
    // edge. This padded pair is what's sent to getCalendarData; the
    // unpadded todayStr/windowEnd below is what filters shift records.
    // sw.js's refreshCalendarData() uses whatever window it's given as-is
    // (only adjusting the upper bound to be RFC3339-exclusive), with no
    // additional padding of its own, so there's no double-padding here.
    const calWindowStart = civilDateStr(addDays(todayCivil, -4));
    const calWindowEnd = civilDateStr(addDays(windowEndCivil, 7));

    // --- Prior view state, for the full-sweep restore step ----------------
    const mtbSelect = document.querySelector('select[name="MTBView"]');
    const selectedOpt = mtbSelect ? mtbSelect.querySelector("option[selected]") : null;
    const priorView = (selectedOpt && selectedOpt.value) || "All";

    // --- Mutable session state --------------------------------------------
    let commitments = [];
    let softEvents = [];
    let myShifts = [];
    let myschedStatus = "none";
    let calAgeMs = null;
    let calError = null;
    let lastVisible = null; // domscan's {records, year, month, monthName, source}
    let scanning = null;
    // Does ANY calendar block a shift? Read from config (calRoles /
    // calBlockTitles / ruleUsePattern), never inferred from an empty
    // commitments array — empty is ambiguous (nothing configured vs configured
    // but no events this window). Only the config read disambiguates.
    let anyCalendarBlocks = false;
    let bannerOnLoad = await loadBannerFromLastDiff();

    /**
     * Re-read the three block-config keys and recompute anyCalendarBlocks. No
     * network — just chrome.storage.local, the same store boot already reads in
     * several places. Never throws; on a storage error it leaves the previous
     * value in place rather than flapping the muted state.
     */
    async function refreshBlockingSignal() {
      try {
        const cfg = await chrome.storage.local.get(["calRoles", "calBlockTitles", "ruleUsePattern"]);
        anyCalendarBlocks = anyoneBlocks(cfg.calRoles, cfg.calBlockTitles, cfg.ruleUsePattern);
      } catch (e) {
        console.error("[medic-tradeboard] reading block config failed:", e);
      }
    }

    await refreshBlockingSignal();

    async function loadBannerFromLastDiff() {
      const { lastDiff } = await chrome.storage.local.get("lastDiff");
      if (!lastDiff || lastDiff.first_run) return null;
      if (!(lastDiff.new.length || lastDiff.gone.length || lastDiff.changed.length)) return null;
      return {
        newCount: lastDiff.new.length,
        goneLabels: lastDiff.gone.map(goneLabel),
        changedCount: lastDiff.changed.length,
      };
    }

    async function getStoredSnapshot() {
      const { snapshot } = await chrome.storage.local.get("snapshot");
      return snapshot || null;
    }

    function snapshotKnownIds(snapshot) {
      if (!snapshot) return { exists: false, known: new Set() };
      const known = new Set([
        ...((snapshot.eligible) || []).map((e) => e.w2w_id),
        ...((snapshot.reject_ids) || []),
      ]);
      return { exists: true, known };
    }

    function applyCalResponse(resp) {
      if (resp && resp.ok) {
        commitments = loadCommitments(resp.commitments);
        softEvents = parseTriplets(resp.soft);
        calAgeMs = Date.now() - resp.fetchedAt;
        calError = null;
      } else {
        calError = (resp && resp.error) || "unknown_error";
      }
    }

    function currentMonthLabel() {
      if (!lastVisible) return "";
      return `${MONTH_ABBR[lastVisible.month - 1].toUpperCase()} ${lastVisible.year}`;
    }

    /** Merge each raw record with its evaluate() verdict (JS's evaluate()
     * returns a fresh object, unlike Python's in-place dict-merge pattern),
     * window-filter first (today <= date <= windowEnd, plain string
     * compares -- safe since dates are zero-padded "YYYY-MM-DD"), then
     * rank. */
    function scoreRecords(records) {
      const windowed = records.filter((r) => todayStr <= r.date && r.date <= windowEnd);
      const results = windowed.map((rec) => ({ ...rec, ...evaluate(rec, commitments, myShifts, softEvents) }));
      return rankEligible(results);
    }

    function buildRow(rec, rank, known, snapshotExists) {
      const note = posterNote(rec);
      const base = loc(rec.text);
      return {
        rank,
        w2w_id: rec.w2w_id,
        date: rec.date,
        dateLabel: formatDateLabel(rec.date),
        tour: tourOf(rec.start),
        start: rec.start,
        end: rec.end,
        pos: posShort(rec.position),
        locLine: note ? `${base} · ${note}` : base,
        famLabels: rec.fam || [],
        isNew: snapshotExists && !known.has(rec.w2w_id),
        // Display score is rounded; the TIER is computed on the RAW score
        // (rounding first would promote e.g. 46.6 -> 47 -> t1 wrongly).
        score: Math.round(rec.score),
        tier: tierClass(rec.score),
      };
    }

    /** reject.reason is passed through raw. evaluate() emits fixed, neutral
     * wording ("overlaps a commitment (...)", "no full open tour ... gap)")
     * that never embeds a calendar event's own title, so it is safe to render
     * verbatim. The user's commitment label reaches the UI through chipLabel
     * only — see rejectChipLabel(). */
    function buildReject(rec) {
      return {
        w2w_id: rec.w2w_id,
        date: rec.date,
        start: rec.start,
        end: rec.end,
        dateLabel: formatDateLabel(rec.date),
        tour: tourOf(rec.start),
        pos: posShort(rec.position),
        locLine: loc(rec.text),
        reason: rec.reason,
        // Short label for the reject's board-anchor reason chip (e.g.
        // "✕ Fire Dept", "✕ Medic Shift", "✕ BUFFER 9h") -- badges.js's
        // paintBadges paints this verbatim, it never re-derives it. Keyed off
        // rec.rejectKind/rejectGapHours (structured), plus this user's own
        // commitment label; no prose is string-matched.
        chipLabel: rejectChipLabel(rec, commitmentLabel),
      };
    }

    function buildState({ monthLabel, notice, rows, rejects }) {
      return {
        monthLabel,
        calAgeMs,
        calError,
        myschedStatus,
        banner: bannerOnLoad,
        stats: {
          elig: rows.length,
          rej: rejects.length,
          best: rows.length ? Math.max(...rows.map((r) => r.score)) : null,
          topCount: rows.filter((r) => r.tier === "t1").length,
        },
        rows,
        rejects,
        scanning,
        notice: notice || null,
        anyCalendarBlocks,
      };
    }

    const controller = initDrawer({
      onScanAll: () => {
        runFullSweep().catch((e) => {
          console.error("[medic-tradeboard] full sweep failed:", e);
          scanning = null;
          controller.update(buildState({
            monthLabel: currentMonthLabel(),
            notice: "Full scan failed — see console",
            rows: [], rejects: [],
          }));
        });
      },
      onRowClick: (w2wId) => {
        // badges.js owns the scroll+flash treatment; fall back to a bare
        // scroll if its namespace is somehow absent.
        if (window.MedicBadges && typeof window.MedicBadges.flashAnchor === "function") {
          window.MedicBadges.flashAnchor(w2wId);
        } else {
          const a = window.MedicDomscan.findAnchor(w2wId);
          if (a) a.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      },
      onConnectCalendar: () => {
        connectCalendar().catch((e) => console.error("[medic-tradeboard] connect calendar failed:", e));
      },
      onOpenSetup: () => {
        // A content script can't open the options page itself; the worker owns
        // chrome.runtime.openOptionsPage(). Fire-and-forget: a failure is
        // logged, never thrown out of the click handler.
        sendToSW({ type: "openOptions" })
          .catch((e) => console.error("[medic-tradeboard] open options failed:", e));
      },
    });

    // Last-painted rows, kept so transient repaints (scan progress ticks,
    // failed connects) don't blank a table that was already populated.
    let lastRows = [];
    let lastRejRows = [];

    async function rescoreVisibleAndPaint() {
      const { known, exists } = snapshotKnownIds(await getStoredSnapshot());
      const { eligible, rejects } = scoreRecords(lastVisible.records);
      const rows = eligible.map((rec, i) => buildRow(rec, i + 1, known, exists));
      const rejRows = rejects.map(buildReject);
      lastRows = rows;
      lastRejRows = rejRows;
      paintBadgesSafe(rows, rejRows);
      controller.update(buildState({ monthLabel: currentMonthLabel(), rows, rejects: rejRows }));
    }

    async function connectCalendar() {
      const resp = await askCalendar("interactive");
      applyCalResponse(resp);
      if (resp && resp.ok) {
        await rescoreVisibleAndPaint();
      } else {
        // Keep whatever was already painted — calError in the state drives
        // the status-line CONNECT chip; blanking rows here would throw away
        // a perfectly good cached-data scoring.
        controller.update(buildState({
          monthLabel: currentMonthLabel(), rows: lastRows, rejects: lastRejRows,
        }));
      }
    }

    // Returning from the options page must clear (or raise) the muted state
    // without a manual reload. When any of the three block-config keys change,
    // recompute anyCalendarBlocks and re-pull the calendar: the roles/titles
    // decide how sw.js buckets events into commitments, so a role change needs
    // a fresh, re-bucketed fetch — mode "refresh" bypasses the cache (the sw
    // mutators drop it too). Mirrors connectCalendar's repaint contract so the
    // new signal reaches the drawer even if that fetch fails. Guarded so a
    // storage-event error is logged, never thrown out of the listener.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!("calRoles" in changes || "calBlockTitles" in changes || "ruleUsePattern" in changes)) return;
      (async () => {
        await refreshBlockingSignal();
        const resp = await askCalendar("refresh");
        applyCalResponse(resp);
        if (resp && resp.ok && lastVisible) {
          await rescoreVisibleAndPaint();
        } else {
          controller.update(buildState({
            monthLabel: currentMonthLabel(), rows: lastRows, rejects: lastRejRows,
          }));
        }
      })().catch((e) => console.error("[medic-tradeboard] block-config change refresh failed:", e));
    });

    async function runFullSweep() {
      if (scanning && scanning.active) return; // never run two sweeps at once — server view state is shared
      scanning = { active: true, done: 0, total: months.length };
      controller.update(buildState({ monthLabel: currentMonthLabel(), rows: lastRows, rejects: lastRejRows }));

      const sweep = await window.MedicBoard.fullSweep({
        host, dll, sid, months, expectView: "All", priorView,
        restoreMonth: lastVisible ? { y: lastVisible.year, mo: lastVisible.month } : null,
        onProgress: (done, total) => {
          scanning = { active: true, done, total };
          controller.update(buildState({ monthLabel: currentMonthLabel(), rows: lastRows, rejects: lastRejRows }));
        },
      });
      scanning = null;

      if (sweep.error === "logged_out") {
        controller.update(buildState({
          monthLabel: currentMonthLabel(), notice: "Log in to WhenToWork first", rows: [], rejects: [],
        }));
        return;
      }

      // A month that never validated in 8 attempts means the board is
      // incomplete — running the diff anyway would mark that month's prior
      // shifts GONE and poison the snapshot. A failed month is treated as
      // fatal for this scan: abort with NO storage writes.
      const failed = sweep.monthHtmls.filter((m) => m.html === null);
      if (failed.length) {
        const names = failed.map((m) => `${m.mo}/${m.y}`).join(", ");
        controller.update(buildState({
          monthLabel: currentMonthLabel(),
          notice: `W2W never returned ${names} — scan aborted, nothing saved`,
          rows: lastRows, rejects: lastRejRows,
        }));
        return;
      }

      // Drift handling: abort the sweep, no storage writes, on the first
      // month whose parse looks like schema drift.
      const perMonth = [];
      let drifted = false;
      for (const { y, mo, html } of sweep.monthHtmls) {
        const parsed = parseMonth(html, y, mo);
        if (driftCheck(parsed)) { drifted = true; break; }
        perMonth.push(parsed.records);
      }
      if (drifted) {
        controller.update(buildState({
          monthLabel: currentMonthLabel(), notice: "W2W markup changed — scanner needs an update",
          rows: lastRows, rejects: lastRejRows,
        }));
        return;
      }

      const merged = mergeMonths(perMonth);
      // Reuses the CURRENT commitments/myShifts/softEvents session state
      // (established by the instant-scan flow) rather than re-fetching --
      // fullSweep only re-fetches board HTML from W2W, not calendar or
      // my-schedule data.
      const { eligible, rejects } = scoreRecords(merged);

      const oldSnapshot = await getStoredSnapshot();
      const { known: oldKnown, exists: snapshotExisted } = snapshotKnownIds(oldSnapshot);

      const { diff, historyLine, newSnapshot } = runDiff(
        { eligible, rejects }, { window_end: windowEnd }, oldSnapshot, todayStr
      );

      const { scanHistory } = await chrome.storage.local.get("scanHistory");
      const nextHistory = [...(scanHistory || []), historyLine].slice(-200);
      await chrome.storage.local.set({ snapshot: newSnapshot, scanHistory: nextHistory, lastDiff: diff });

      bannerOnLoad = (diff.new.length || diff.gone.length || diff.changed.length) ? {
        newCount: diff.new.length,
        goneLabels: diff.gone.map(goneLabel),
        changedCount: diff.changed.length,
      } : null;

      const rows = eligible.map((rec, i) => buildRow(rec, i + 1, oldKnown, snapshotExisted));
      const rejRows = rejects.map(buildReject);

      // Badges only target anchors present in the DOM (the currently
      // visible month); the drawer shows the full-window ranking with rank
      // numbers locked to that full-window sort. The sweep scores all four
      // months, so rejects need the same visibleIds filter as eligible rows
      // -- painting a reject whose anchor isn't in the DOM would be a no-op
      // in badges.js anyway (findAnchor returns null), but filtering here
      // keeps the two arrays handled identically and avoids wasted work.
      const visibleIds = new Set((lastVisible ? lastVisible.records : []).map((r) => r.w2w_id));
      paintBadgesSafe(
        rows.filter((r) => visibleIds.has(r.w2w_id)),
        rejRows.filter((r) => visibleIds.has(r.w2w_id))
      );

      controller.update(buildState({ monthLabel: currentMonthLabel(), rows, rejects: rejRows }));
    }

    // --- Instant scan (runs once at boot) ---------------------------------
    const { scanStrategy } = await chrome.storage.local.get("scanStrategy");
    // "dom" (zero-network) is the default scan strategy. Must match
    // domscan.js's own fallback default so a missing storage key behaves
    // the same in both places.
    const strategy = scanStrategy || "dom";

    const visible = await window.MedicDomscan.scanVisibleMonth({ strategy, host, dll, sid });
    if (visible.error) {
      controller.update(buildState({
        monthLabel: "", notice: "Could not read the visible month — reload the tradeboard",
        rows: [], rejects: [],
      }));
      return;
    }
    lastVisible = visible;

    // Step 2: fast "cache" path.
    const cacheResp = await askCalendar("cache");
    applyCalResponse(cacheResp);
    if (cacheResp && cacheResp.ok) {
      await rescoreVisibleAndPaint();
    } else {
      controller.update(buildState({
        monthLabel: currentMonthLabel(),
        notice: calError === "auth_required" ? null : "Connecting to Google Calendar…",
        rows: [], rejects: [],
      }));
    }

    // Step 3: in parallel, a fresh (non-cached) calendar pull and the user's
    // own W2W schedule — each repaints independently as soon as IT resolves,
    // rather than waiting on both.
    askCalendar("refresh").then(async (resp) => {
      applyCalResponse(resp);
      if (resp && resp.ok) await rescoreVisibleAndPaint();
    }).catch((e) => console.error("[medic-tradeboard] calendar refresh failed:", e));

    window.MedicBoard.fetchMysched({ host, dll, sid }).then(async (html) => {
      const parsed = parseMysched(html);
      if (parsed.status === "ok") {
        myShifts = parseTriplets(parsed.schedule);
        myschedStatus = "ok";
      } else {
        // status "unknown" (populated list, unseen format) or
        // "unrecognized" (session drop / markup drift) both degrade to the
        // tradeboard-derived fallback.
        myShifts = parseTriplets(fallbackFromTradeboard(lastVisible.records));
        myschedStatus = "partial";
      }
      await rescoreVisibleAndPaint();
    }).catch((e) => console.error("[medic-tradeboard] mysched fetch failed:", e));
  })().catch((err) => console.error("[medic-tradeboard] boot failed:", err));
})();
