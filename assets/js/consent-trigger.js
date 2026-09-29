/*
 * jeremy.ie — quieten the cookie-consent trigger.
 *
 * Usercentrics draws a floating shield button in the bottom-left corner so a visitor can
 * reopen their privacy settings. It has to stay (withdrawing consent must be as easy as
 * giving it), but out of the box it is a saturated, rounded, shadowed disc: the one
 * thing on the site that does not wear the coal system. This restyles it into a small,
 * flat, square hairline button in the page's own colours that sits back at half
 * opacity until it is pointed at or focused.
 *
 * The widget renders inside its own shadow root, so page CSS cannot reach it. Instead
 * this finds the root once the widget appears, and injects a stylesheet into it. The
 * button is found by what it is rather than by class name, which the vendor changes
 * between releases: a small button (or the small fixed box it sits in) pinned to the
 * viewport, outside any dialog. The banner and the settings dialog are left exactly as
 * the vendor draws them.
 *
 * If anything here does not match — a closed shadow root, a new layout — nothing is
 * changed and the vendor's button shows as before. It never hides the button.
 *
 * The cleaner fix, if it is available on the account, is the Usercentrics admin: the
 * privacy trigger's colour, size and position are settings there.
 */
(function () {
  'use strict';

  var MARK = 'data-jr-trigger';
  var STYLE_ID = 'jr-trigger-style';
  var MAX_SIZE = 90; // px: anything bigger is the banner, not the trigger

  var CSS = [
    '[' + MARK + '="box"] {',
    '  left: 14px !important;',
    '  bottom: 14px !important;',
    '  box-shadow: none !important;',
    '}',
    'button[' + MARK + '] {',
    '  width: 30px !important;',
    '  height: 30px !important;',
    '  min-width: 0 !important;',
    '  min-height: 0 !important;',
    '  padding: 0 !important;',
    '  display: inline-flex !important;',
    '  align-items: center !important;',
    '  justify-content: center !important;',
    '  background: rgba(17, 18, 20, 0.78) !important;',
    '  border: 1px solid rgba(236, 238, 240, 0.14) !important;',
    '  border-radius: 0 !important;',
    '  box-shadow: none !important;',
    '  color: #7e9c89 !important;',
    '  opacity: 0.5 !important;',
    '  transition: opacity 200ms ease, border-color 200ms ease !important;',
    '}',
    'button[' + MARK + ']:hover,',
    'button[' + MARK + ']:focus-visible {',
    '  opacity: 1 !important;',
    '  border-color: rgba(126, 156, 137, 0.6) !important;',
    '}',
    'button[' + MARK + ']:focus-visible {',
    '  outline: 1px solid #7e9c89 !important;',
    '  outline-offset: 2px !important;',
    '}',
    'button[' + MARK + '] svg {',
    '  width: 14px !important;',
    '  height: 14px !important;',
    '}',
    // The icon's own fills are hard-coded brand colours; take them over.
    'button[' + MARK + '] svg,',
    'button[' + MARK + '] svg * {',
    '  fill: currentColor !important;',
    '}',
    'button[' + MARK + '] svg [fill="none"] {',
    '  fill: none !important;',
    '}'
  ].join('\n');

  function small(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.width <= MAX_SIZE && r.height <= MAX_SIZE;
  }

  function inDialog(el) {
    return !!(el.closest && el.closest('[role="dialog"], [role="alertdialog"], dialog'));
  }

  // The nearest ancestor (or the element itself) pinned to the viewport, within the root.
  function fixedBox(el, root) {
    for (var n = el; n && n !== root && n.nodeType === 1; n = n.parentNode) {
      if (getComputedStyle(n).position === 'fixed') { return n; }
    }
    return null;
  }

  function mark(root) {
    var buttons = root.querySelectorAll('button');
    var found = false;
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.hasAttribute(MARK)) { found = true; continue; }
      if (inDialog(btn) || !small(btn)) { continue; }
      var box = fixedBox(btn, root);
      if (!box) { continue; }
      // The trigger's fixed box is small too; a small button inside a large fixed box
      // is a control on the banner, and is left alone.
      if (box !== btn && !small(box)) { continue; }

      btn.setAttribute(MARK, '');
      if (box !== btn) { box.setAttribute(MARK, 'box'); }
      found = true;
    }

    if (found && !root.getElementById(STYLE_ID)) {
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      root.appendChild(style);
    }
  }

  /*
   * The widget re-renders its tree whenever consent changes (the banner goes, the
   * trigger comes), so each root is watched for as long as the page lives. Marking is
   * idempotent and the work per mutation is a handful of buttons.
   */
  var watched = [];

  function watchRoot(root) {
    if (watched.indexOf(root) !== -1) { return; }
    watched.push(root);
    var pending = false;
    new MutationObserver(function () {
      if (pending) { return; }
      pending = true;
      // After layout, so sizes and positions are real.
      requestAnimationFrame(function () {
        pending = false;
        mark(root);
      });
    }).observe(root, { childList: true, subtree: true, attributes: true });
    mark(root);
  }

  function scan() {
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.shadowRoot && /usercentrics|uc-/i.test(el.id + ' ' + el.tagName)) {
        watchRoot(el.shadowRoot);
      }
    }
  }

  function start() {
    scan();
    // The loader is async and appends its host element to the body some time later.
    new MutationObserver(scan).observe(document.body, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
