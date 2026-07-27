/**
 * Classic (non-module) content script. Paints read-only score/NEW/FAM chips
 * next to eligible-shift anchors, and a crossed-off-with-reason treatment
 * (strikethrough anchor + muted reason chip) next to rejected ones, on the
 * live W2W tradeboard. Also exposes a scroll-and-flash helper the drawer's
 * row-click handler can call.
 *
 * Loaded by manifest.json alongside content/board.js, content/domscan.js,
 * content/boot.js in the SAME isolated world. Everything here is wrapped in
 * an IIFE so no helper name (findAnchor, escapeRegExp, ...) can collide with
 * top-level bindings declared by those sibling scripts.
 *
 * Exposes: window.MedicBadges = { paintBadges, clearBadges, flashAnchor }
 */
(function () {
  "use strict";

  // Mirrors ui/drawer.css :host tokens (documented duplication -- this is a
  // classic script painting into W2W's page, so it can't read the drawer's
  // shadow-scoped CSS vars; keep in sync with drawer.css when tokens change).
  var THEME = {
    t1: "#3fd68f", t2: "#ffb428", t3: "#8b98ab",
    amber: "#ffb428", green: "#3fd68f", purple: "#b48cff", panel: "#161b23",
    rejectBorder: "#6b7686", rejectInk: "#8b98ab",
  };
  var CHIP_FONT = '500 10px "IBM Plex Mono", ui-monospace, Menlo, monospace';
  var CHIP_SELECTOR = "a[onclick*=\"CCL(this,\"]";
  var FLASH_MS = 2000;

  // Reject-anchor treatment (approved mockup "B -- crossed off, with
  // reason"), applied via an injected stylesheet + marker class
  // rather than direct inline-style writes. See injectRejectStyle()'s doc
  // comment for why the stylesheet approach replaced the old inline
  // save/restore mechanism.
  var STYLE_ID = "medic-reject-style";
  var REJECT_CLASS = "medic-rejected";

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Locates the board anchor for w2wId among CCL(this,'...') anchors.
   *
   * Real markup (see test/fixtures/board-minimal.html) is
   * CCL(this,'<marker><digits>') where <marker> is one of
   * * # ! $ -- there is always exactly one marker character between the
   * opening quote and the id, so a literal `'${id}'` (quote immediately
   * followed by the id) never matches, and a naive `id + "'"` check has a
   * real false-positive risk (id "234" is a substring of id "1234" followed
   * by the closing quote). We anchor on both sides -- the marker class on
   * the left, the closing quote on the right -- which keeps a simple
   * two-step approach (gather CCL anchors, then match by id) but makes the
   * match exact.
   * @param {NodeListOf<Element>|Element[]} anchors
   * @param {string} w2wId
   * @returns {Element|null}
   */
  function findAnchor(anchors, w2wId) {
    var pattern = new RegExp("CCL\\(this,'[*#!$]" + escapeRegExp(String(w2wId)) + "'\\)");
    for (var i = 0; i < anchors.length; i++) {
      var onclick = anchors[i].getAttribute("onclick") || "";
      if (pattern.test(onclick)) return anchors[i];
    }
    return null;
  }

  function makeChip(text, color, extraStyle) {
    var span = document.createElement("span");
    span.className = "medic-chip";
    span.textContent = text;
    span.style.cssText =
      "display:inline-block;background:" + THEME.panel + ";border:1px solid " + color + ";" +
      "color:" + color + ";border-radius:6px;font:" + CHIP_FONT + ";" +
      "padding:1px 6px;line-height:1.6;" + (extraStyle || "");
    return span;
  }

  /**
   * Lazily injects the `<style>` element that paints the "crossed off, with
   * reason" reject treatment, guarded by STYLE_ID so repeated calls (this
   * runs on every paintBadges() pass) are a no-op after the first. Injected
   * into document.head here -- NOT at IIFE top level -- because document.head
   * may not exist yet when this script first executes, depending on the
   * manifest's run_at setting.
   *
   * WHY a stylesheet + marker class instead of writing inline styles onto
   * the anchor (the previous mechanism):
   * 1. The board anchor already carries a per-anchor, server-set inline
   *    `style="color:#RRGGBB"` whose value the CSS class does NOT encode --
   *    verified against real board markup (see test/fixtures/*.anon.html),
   *    where `class="shiftUnassigned"` anchors appear with multiple distinct
   *    inline colours (e.g. #FF00FF, #006400, #0000FF). A teardown bug that nulled
   *    style.color used to risk unrecoverable data loss on the user's real
   *    scheduling site. An `!important` class rule beats that
   *    non-important inline declaration under the cascade, so this
   *    mechanism never reads, stashes, or writes the anchor's own inline
   *    style at all -- the whole failure class is gone, not just guarded
   *    against.
   * 2. flashAnchor() below snapshots anchor.style.backgroundColor and
   *    restores it on a 2000ms timer. Under the old inline-style mechanism,
   *    a repaint that tore down a reject treatment while a flash timer was
   *    still pending could let that timer write a stale grey background
   *    back onto an anchor nobody had marked -- a permanent, unrecoverable
   *    leak. (No UI path flashes a reject today, but the trap was latent.)
   *    A class-based treatment can never be captured by that snapshot,
   *    because it never touches the style attribute in the first place.
   * 3. Teardown collapses to classList.remove() (see clearBadges), so the
   *    verdict-flip case -- a shift rejected on boot pass 1, eligible by
   *    pass 3 -- self-heals instead of depending on correct six-property
   *    restore bookkeeping.
   *
   * `!important` on color is load-bearing, not defensive: the corpus never
   * uses `!important` in its own inline styles, so a non-important class
   * rule would lose to the anchor's inline color and silently do nothing.
   * text-decoration-line (not the `text-decoration` shorthand) is used so
   * this rule doesn't reset -color/-thickness/-style and fight W2W's own
   * rules unpredictably. background-color deliberately overrides W2W's own
   * `.shiftUnassigned { background-color:#ffff64 }` yellow -- without it a
   * rejected OPEN shift would still read as "available" at a glance.
   */
  function injectRejectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "a." + REJECT_CLASS + " {\n" +
      "  color: #7a8493 !important;\n" +
      "  background-color: #e4e7ec !important;\n" +
      "  text-decoration-line: line-through !important;\n" +
      "}\n";
    document.head.appendChild(style);
  }

  /**
   * Removes every previously-injected chip container AND the REJECT_CLASS
   * marker from any anchors carrying the reject treatment. Safe to call
   * anytime, including when nothing is currently painted.
   *
   * WHY the anchor teardown matters: rescoreVisibleAndPaint() in boot.js
   * runs up to three times during boot as calendar and my-schedule data
   * arrive asynchronously, and a shift's verdict can genuinely flip between
   * passes -- e.g. rejected on pass 1 (no calendar data yet), eligible by
   * pass 3 once a conflicting commitment turns out not to apply. paintBadges
   * calls clearBadges() first on every pass, so a flipped shift must lose
   * its reject look here. Because the treatment lives entirely in the
   * injected stylesheet keyed off REJECT_CLASS (see injectRejectStyle),
   * removing the marker class is the entire teardown -- there is no inline
   * style to read back or restore, so there is no bookkeeping that can ever
   * drift out of sync with W2W's own original markup.
   */
  function clearBadges() {
    var nodes = document.querySelectorAll(".medic-chips");
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();

    var rejected = document.querySelectorAll("." + REJECT_CLASS);
    for (var j = 0; j < rejected.length; j++) {
      rejected[j].classList.remove(REJECT_CLASS);
    }
  }

  /**
   * Marks a rejected shift's board anchor with REJECT_CLASS; the injected
   * stylesheet (see injectRejectStyle) does the actual painting, so this is
   * the entire "apply the treatment" step.
   *
   * No double-mark guard: the previous version bailed out early if the
   * anchor already carried REJECT_CLASS, because re-marking would have
   * stashed our OWN grey/strikethrough as the "previous" inline value and
   * made the treatment permanent on restore. That risk doesn't exist here
   * -- classList.add() of a class the element already has is a no-op -- so
   * the guard has been dropped as unnecessary.
   * @param {Element} anchor
   */
  function markRejectedAnchor(anchor) {
    anchor.classList.add(REJECT_CLASS);
  }

  /**
   * Paints chips (and, for rejects, an anchor-level crossed-off treatment)
   * after the board anchor for each row.
   *
   * `rows` are ELIGIBLE rows and get the existing score/NEW/FAM chip stack,
   * untouched by this change. `rejects` (optional, defaults to an empty
   * array so a caller passing only `rows` behaves exactly as before) are
   * OPEN, coworker-post, AND the user's-own-shift rows alike that evaluate()
   * rejected -- each gets its board anchor struck through and greyed
   * (approved mockup "B") plus a single muted-grey reason chip
   * built from `chipLabel`. Rejects get ONLY that reason chip -- no score,
   * no NEW, no FAM.
   *
   * Always calls clearBadges() first, exactly once, before painting
   * anything -- see clearBadges()'s doc comment for why that teardown (not
   * just the chip removal, but the REJECT_CLASS removal too) is load-
   * bearing: a shift's verdict can flip between the up-to-three repaint
   * passes boot.js runs, and without it a shift that flips back to eligible
   * would keep a stale strikethrough forever. Also calls injectRejectStyle()
   * once before the reject loop -- see its doc comment for why the reject
   * treatment lives in an injected stylesheet rather than inline styles.
   * @param {Array<{w2w_id:string, score:number, tier:"t1"|"t2"|"t3",
   *   isNew?:boolean, famLabels?:string[]}>} rows
   * @param {Array<{w2w_id:string, chipLabel:string}>} [rejects]
   */
  function paintBadges(rows, rejects) {
    clearBadges();
    rejects = rejects || [];
    if ((!rows || !rows.length) && !rejects.length) return;
    var anchors = document.querySelectorAll(CHIP_SELECTOR);

    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      var anchor = findAnchor(anchors, row.w2w_id);
      if (!anchor) continue;

      var container = document.createElement("span");
      container.className = "medic-chips";
      container.style.cssText = "display:block;margin-top:2px;";

      var scoreColor = THEME[row.tier] || THEME.t3;
      var line1 = document.createElement("span");
      line1.style.cssText = "display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap;";
      line1.appendChild(makeChip(Math.round(row.score) + "h", scoreColor));
      if (row.isNew) line1.appendChild(makeChip("NEW", THEME.green));
      container.appendChild(line1);

      if (row.famLabels && row.famLabels.length) {
        var famChip = makeChip(
          row.famLabels.join(" · "),
          THEME.purple,
          "white-space:normal;max-width:100%;margin-top:2px;"
        );
        container.appendChild(famChip);
      }

      anchor.insertAdjacentElement("afterend", container);
    }

    if (rejects.length) injectRejectStyle();
    for (var k = 0; k < rejects.length; k++) {
      var rej = rejects[k];
      var rejAnchor = findAnchor(anchors, rej.w2w_id);
      if (!rejAnchor) continue;

      markRejectedAnchor(rejAnchor);

      // INLINE, unlike the eligible container's `display:block` above --
      // this is a deliberate asymmetry and it is load-bearing. Eligible
      // rows were already paying a line of height for their chip stack
      // before rejects were decorated at all, so their layout cost is
      // unchanged. Rejects are the common case on a full board, and giving
      // each one its own chip line made the whole month grid 34% taller
      // (measured: +463px over a 20-anchor board), pushing the calendar off
      // screen. Sitting the chip beside the struck-through anchor text
      // instead costs +35px for the same board -- the reason stays visible
      // without the grid growing. In the narrowest columns the chip still
      // wraps to its own line, which is fine; it's the aggregate height
      // that matters.
      var rejContainer = document.createElement("span");
      rejContainer.className = "medic-chips";
      rejContainer.style.cssText = "display:inline-block;margin-left:4px;vertical-align:middle;";
      rejContainer.appendChild(makeChip(rej.chipLabel, THEME.rejectBorder, "color:" + THEME.rejectInk + ";"));
      rejAnchor.insertAdjacentElement("afterend", rejContainer);
    }
  }

  /**
   * Scrolls the anchor for w2wId into view and applies a temporary amber
   * outline/background flash. Used by the drawer's row-click -> board path.
   * @param {string} w2wId
   */
  function flashAnchor(w2wId) {
    var anchors = document.querySelectorAll(CHIP_SELECTOR);
    var anchor = findAnchor(anchors, w2wId);
    if (!anchor) return;

    anchor.scrollIntoView({ behavior: "smooth", block: "center" });

    var prevOutline = anchor.style.outline;
    var prevBackground = anchor.style.backgroundColor;
    var prevTransition = anchor.style.transition;

    anchor.style.transition = "outline-color .2s ease, background-color .2s ease";
    anchor.style.outline = "2px solid " + THEME.amber;
    anchor.style.backgroundColor = "rgba(255,180,40,.25)";

    setTimeout(function () {
      anchor.style.outline = prevOutline;
      anchor.style.backgroundColor = prevBackground;
      anchor.style.transition = prevTransition;
    }, FLASH_MS);
  }

  window.MedicBadges = {
    paintBadges: paintBadges,
    clearBadges: clearBadges,
    flashAnchor: flashAnchor,
  };
})();
