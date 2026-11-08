/*
 * Pitwall: the page's small pieces of machinery — saved settings, data-bind, the
 * segmented switches and the round + — shared by every part of the wall.
 *
 * The + is /aurora's (aurora-hud.js), generalised: it names what it opens in
 * aria-controls (one id or several); a panel whose CSS gives it a --close-ms closes in two
 * steps, marked closing so it can animate back into its bar, then hidden. Unlike aurora's,
 * Escape and a click elsewhere close it, and focus goes back to the + that opened it.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var PREFIX = 'pitwall.';

  // ---------- Settings, per browser ----------

  /* Browser storage can be missing or refuse (a private window, blocked site data), so
     every read and write is guarded and the wall works without it. */
  function load(key, fallback) {
    try {
      var raw = window.localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
      // Not saved; the setting still holds until the page is closed.
    }
  }

  function loadRaw(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  // ---------- data-bind ----------

  var bound = {};

  function node(name) {
    if (!bound[name]) { bound[name] = document.querySelector('[data-bind="' + name + '"]'); }
    return bound[name];
  }

  /** Set a bound element's text, touching the page only when it changes. */
  function text(name, value) {
    var el = node(name);
    var v = value == null ? '' : String(value);
    if (el && el.textContent !== v) { el.textContent = v; }
    return el;
  }

  function show(name, visible) {
    var el = node(name);
    if (el && el.hidden === !!visible) { el.hidden = !visible; }
    return el;
  }

  function setAttr(el, name, value) {
    if (!el) { return; }
    if (value == null) {
      if (el.hasAttribute(name)) { el.removeAttribute(name); }
    } else if (el.getAttribute(name) !== String(value)) {
      el.setAttribute(name, value);
    }
  }

  // ---------- Segmented switches ----------

  /** A radiogroup of buttons: click or arrow keys to pick; onPick(value) after each change. */
  function seg(group, attribute, onPick) {
    var buttons = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]'));

    function pick(value, focus) {
      buttons.forEach(function (b) {
        var on = b.getAttribute(attribute) === value;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        if (on && focus) { b.focus(); }
      });
    }

    buttons.forEach(function (b, i) {
      b.addEventListener('click', function () {
        pick(b.getAttribute(attribute));
        onPick(b.getAttribute(attribute));
      });
      b.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) { return; }
        e.preventDefault();
        var next = buttons[(i + step + buttons.length) % buttons.length];
        pick(next.getAttribute(attribute), true);
        onPick(next.getAttribute(attribute));
      });
    });

    return { pick: pick };
  }

  // ---------- The round + ----------

  var calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function showPanel(el, open) {
    clearTimeout(el.closeTimer);
    el.removeAttribute('data-closing');
    if (open) {
      el.hidden = false;
      return;
    }
    var ms = parseFloat(getComputedStyle(el).getPropertyValue('--close-ms')) || 0;
    if (el.hidden || !ms || calm) {
      el.hidden = true;
      return;
    }
    el.setAttribute('data-closing', '');
    el.closeTimer = setTimeout(function () {
      el.hidden = true;
      el.removeAttribute('data-closing');
    }, ms);
  }

  function panelsOf(button) {
    return (button.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean).map(function (id) {
      return document.getElementById(id);
    }).filter(Boolean);
  }

  function setMore(button, open, refocus) {
    if ((button.getAttribute('aria-expanded') === 'true') === open) { return; }
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    panelsOf(button).forEach(function (el) { showPanel(el, open); });
    if (!open && refocus) { button.focus(); }
  }

  /*
   * Wire every .more under root that opens a panel and isn't wired yet; safe to call again
   * after adding one. A round button that only closes its own card (the driver's, the
   * stints') names no panel, stays an x, and is left to its card.
   */
  function more(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('.more[aria-controls]:not([data-wired])'), function (button) {
      button.setAttribute('data-wired', '');
      button.addEventListener('click', function () {
        setMore(button, button.getAttribute('aria-expanded') !== 'true');
      });
    });
  }

  function openMores() {
    return Array.prototype.slice.call(document.querySelectorAll('.more[aria-controls][aria-expanded="true"]'));
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') { return; }
    openMores().forEach(function (b) { setMore(b, false, true); });
  });

  document.addEventListener('pointerdown', function (e) {
    openMores().forEach(function (b) {
      var inside = b.contains(e.target) || panelsOf(b).some(function (p) { return p.contains(e.target); });
      if (!inside) { setMore(b, false); }
    });
  });

  // ---------- Tokens ----------

  /** A colour token as the page has it now, for drawing on a canvas. Always #rrggbb. */
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  P.UI = {
    load: load,
    save: save,
    loadRaw: loadRaw,
    text: text,
    show: show,
    node: node,
    setAttr: setAttr,
    seg: seg,
    more: more,
    setMore: setMore,
    token: token,
    calm: calm
  };
}());
