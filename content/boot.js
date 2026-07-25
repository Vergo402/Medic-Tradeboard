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
      const controller = initDrawer({ onRowClick() {}, onOpenSetup() {} });
      controller.update(emptyState("Log in to WhenToWork first"));
      return;
    }

    // --- Page identity ---------------------------------------------------
    const tag = document.querySelector("script[data-sid][data-w2w]");
    if (!tag || !tag.dataset.sid || !tag.dataset.w2w) {
      const { initDrawer } = await import(chrome.runtime.getURL("ui/drawer.js"));
      const controller = initDrawer({ onRowClick() {}, onOpenSetup() {} });
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
    const { driftCheck } = parseMod;
    const { parseCivil, toEpoch, addDays, civilFromEpoch } = nytime;
    const { loadCommitments, evaluate, rankEligible } = scoreMod;
    const { runDiff } = diffMod;
    const { parseMysched, fallbackFromTradeboard } = myschedMod;
    const {
      loc, posShort, tierClass, goneLabel, posterNote, tourOf, rejectChipLabel,
    } = rowshape;
    const { anyoneBlocks } = blocksMod;
    const { initDrawer } = uiMod;

    // The word for "I am already committed" is now PER FEED, resolved in sw.js
    // when the commitment triplet is built and carried here as rec.rejectLabel
    // (see rejectChipLabel). Nothing to read from storage: core/score.js still
    // never sees it — it emits a neutral reason plus a structured rejectKind,
    // and the label is applied HERE, in the display layer.

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

    // --- Mutable session state --------------------------------------------
    let commitments = [];
    let softEvents = [];
    let myShifts = [];
    let myschedStatus = "none";
    let calAgeMs = null;
    let calError = null;
    let lastVisible = null; // domscan's {records, anchors, year, month, monthName, source}
    let calendarLoaded = false; // a calendar read has SUCCEEDED at least once this load
    // Ids known BEFORE this page load's snapshot write, frozen by
    // runDiffForVisibleMonth. Null until the diff runs.
    let baseline = null;
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

    /** Both reject shapes are read: current snapshots carry
     * `rejects: [{w2w_id, date}]` (the date is what makes core/diff.js's
     * window-scoped merge possible), legacy ones a bare `reject_ids` id list.
     * Reading only one shape would show NEW pills on already-seen rejects. */
    function snapshotKnownIds(snapshot) {
      if (!snapshot) return { exists: false, known: new Set() };
      const known = new Set([
        ...((snapshot.eligible) || []).map((e) => e.w2w_id),
        ...((snapshot.rejects) || []).map((r) => r.w2w_id),
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
        calendarLoaded = true;
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
     * wording ("overlaps a commitment (...)", "only Xh after a commitment
     * (needs N)") that never embeds a calendar event's own title, so it is safe
     * to render verbatim. The user's commitment label reaches the UI through
     * chipLabel only — see rejectChipLabel(). */
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
        // The overlapping commitment's per-event "show as" override (or
        // undefined/""). It reaches here through scoreRecords' spread of the
        // evaluate() result onto rec, and rejectChipLabel reads it below; kept
        // on the reject row too so the field's path to the chip is explicit.
        rejectLabel: rec.rejectLabel,
        // Short label for the reject's board-anchor reason chip (e.g.
        // "✕ Fire Dept", "✕ Drill", "✕ Medic Shift", "✕ BUFFER 9h") --
        // badges.js's paintBadges paints this verbatim, it never re-derives it.
        // Keyed off rec.rejectKind/rejectGapHours/rejectLabel (structured), plus
        // this user's own commitment label; no prose is string-matched.
        chipLabel: rejectChipLabel(rec),
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
        notice: notice || null,
        anyCalendarBlocks,
      };
    }

    const controller = initDrawer({
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
      // Once the diff has run, NEW pills come from `baseline` (the ids known
      // before this load's snapshot write). Re-reading storage here would hand
      // back the snapshot we just wrote and blank every pill on the next
      // repaint (e.g. the storage.onChanged refresh below).
      const { known, exists } = baseline || snapshotKnownIds(await getStoredSnapshot());
      const { eligible, rejects } = scoreRecords(lastVisible.records);
      const rows = eligible.map((rec, i) => buildRow(rec, i + 1, known, exists));
      const rejRows = rejects.map(buildReject);
      lastRows = rows;
      lastRejRows = rejRows;
      paintBadgesSafe(rows, rejRows);
      controller.update(buildState({ monthLabel: currentMonthLabel(), rows, rejects: rejRows }));
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
      // `feeds` is watched too: adding or removing a feed changes what can block
      // a shift just as much as changing a role does, and without it the board
      // would keep scoring against a feed the user just deleted.
      if (!("feeds" in changes || "calRoles" in changes
        || "calBlockTitles" in changes || "ruleUsePattern" in changes)) return;
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

    // --- Scan window: the visible month, clipped to the scoring window -----
    // Must mirror scoreRecords' own filter (todayStr <= date <= windowEnd)
    // intersected with the month actually on screen — this pair is what
    // core/diff.js is allowed to call GONE and to replace in the snapshot, so
    // it has to be exactly the range this scan can speak for. An empty range
    // (the user paged to a month entirely behind today) means this load
    // scanned nothing diffable: no storage writes at all.
    const monthStart = `${visible.year}-${pad2(visible.month)}-01`;
    const monthEnd = civilDateStr({
      y: visible.year, mo: visible.month,
      d: new Date(Date.UTC(visible.year, visible.month, 0)).getUTCDate(),
    });
    const scanStart = monthStart > todayStr ? monthStart : todayStr;
    const scanEnd = monthEnd < windowEnd ? monthEnd : windowEnd;

    // Schema drift on the scanned HTML: anchors present but nothing parsed.
    // Both fields come from domscan's single parse of the HTML it actually
    // scanned, so this never pairs one source's records with another's anchors.
    const drifted = driftCheck({ records: visible.records, anchors: visible.anchors });
    if (drifted) {
      controller.update(buildState({
        monthLabel: currentMonthLabel(), notice: "W2W markup changed — scanner needs an update",
        rows: [], rejects: [],
      }));
      return; // NO storage writes on a drifted parse — a poisoned snapshot outlives the page
    }

    /**
     * The snapshot/diff write for this load's visible month. Runs ONCE, after
     * both async pulls settle (see the call site) so the scoring it freezes
     * into the snapshot is the same scoring the user is looking at.
     */
    async function runDiffForVisibleMonth() {
      const oldSnapshot = await getStoredSnapshot();
      const { known: oldKnown, exists: snapshotExisted } = snapshotKnownIds(oldSnapshot);
      baseline = { known: oldKnown, exists: snapshotExisted }; // freeze before the write

      const { eligible, rejects } = scoreRecords(lastVisible.records);
      const { diff, historyLine, newSnapshot } = runDiff(
        { eligible, rejects },
        { window_end: windowEnd, scan_start: scanStart, scan_end: scanEnd },
        oldSnapshot, todayStr
      );

      const { scanHistory } = await chrome.storage.local.get("scanHistory");
      const nextHistory = [...(scanHistory || []), historyLine].slice(-200);
      await chrome.storage.local.set({ snapshot: newSnapshot, scanHistory: nextHistory, lastDiff: diff });

      // Banner shows THIS scan's fresh diff, replacing the prior lastDiff one
      // loaded at boot — lastDiff was just overwritten, so the pre-scan banner
      // would describe changes no longer in storage (same choice the deleted
      // full sweep made).
      bannerOnLoad = (diff.new.length || diff.gone.length || diff.changed.length) ? {
        newCount: diff.new.length,
        goneLabels: diff.gone.map(goneLabel),
        changedCount: diff.changed.length,
      } : null;

      const rows = eligible.map((rec, i) => buildRow(rec, i + 1, oldKnown, snapshotExisted));
      const rejRows = rejects.map(buildReject);
      lastRows = rows;
      lastRejRows = rejRows;
      paintBadgesSafe(rows, rejRows);
      controller.update(buildState({ monthLabel: currentMonthLabel(), rows, rejects: rejRows }));
    }

    // Step 2: fast "cache" path.
    const cacheResp = await askCalendar("cache");
    applyCalResponse(cacheResp);
    if (cacheResp && cacheResp.ok) {
      await rescoreVisibleAndPaint();
    } else {
      // "no_cache" on a cold start is expected, not a failure — the refresh
      // below is already on its way. A real feed failure is NOT swallowed here:
      // it reaches the drawer as calError and raises the loud banner.
      controller.update(buildState({
        monthLabel: currentMonthLabel(),
        notice: calError && calError !== "no_cache" ? null : "Reading your calendar feeds…",
        rows: [], rejects: [],
      }));
    }

    // Step 3: in parallel, a fresh (non-cached) calendar pull and the user's
    // own W2W schedule — each repaints independently as soon as IT resolves,
    // rather than waiting on both.
    const calRefreshDone = askCalendar("refresh").then(async (resp) => {
      applyCalResponse(resp);
      if (resp && resp.ok) await rescoreVisibleAndPaint();
    }).catch((e) => console.error("[medic-tradeboard] calendar refresh failed:", e));

    const myschedDone = window.MedicBoard.fetchMysched({ host, dll, sid }).then(async (html) => {
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

    // Step 4: ONE diff/snapshot write per page load, after BOTH pulls settle.
    // Running it earlier (on the cache path) would freeze a snapshot scored
    // with myShifts still empty, so every shift overlapping the user's own W2W
    // schedule would land as `pass` and flip to `reject` on the next load —
    // phantom changes in the banner on every visit. allSettled, not all: a
    // rejected pull must not skip the write silently, the guards below decide.
    await Promise.allSettled([calRefreshDone, myschedDone]);
    // Empty range: the visible month lies entirely behind the scoring window,
    // so this load scanned nothing the snapshot could speak for.
    const diffable = scanStart <= scanEnd;
    // Without real calendar data every shift scores `pass`; writing that would
    // poison the snapshot exactly as a failed month did in the deleted full
    // sweep. Same rule as drift above: on a failed scan, write nothing.
    const scoringTrusted = calendarLoaded && !calError;
    if (diffable && scoringTrusted) {
      await runDiffForVisibleMonth();
    } else if (diffable) {
      console.warn("[medic-tradeboard] calendar unavailable — diff/snapshot write skipped");
    }
  })().catch((err) => console.error("[medic-tradeboard] boot failed:", err));
})();
