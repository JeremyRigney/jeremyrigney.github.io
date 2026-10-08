/*
 * jeremy.ie — coal or stone.
 *
 * Loaded in the <head> of every coal page, before the stylesheets and without defer,
 * so data-theme is on <html> before anything is painted and the page never flashes the
 * wrong ground. The tokens it switches between live in assets/css/coal.css.
 *
 * Which theme: the visitor's own choice if they have made one (localStorage
 * "jr-theme"), otherwise their system's prefers-color-scheme, followed live for as long
 * as they have not chosen. A choice is made with any [data-theme-toggle], which the
 * header and the footer both carry.
 *
 * Anything drawn rather than styled — the galaxy, the sky, the maps, the charts —
 * cannot follow a custom property on its own. Each of those scripts listens for
 * "jr:themechange" on document and repaints. The event carries { theme }.
 *
 * Eclipse, F1 and Galaxy do not load this. They are off-palette by their own design
 * and stay dark whatever is chosen here.
 */
(function () {
  'use strict';

  var KEY = 'jr-theme';
  var GROUND = { dark: '#111214', light: '#e7e5e0' };
  var HERO = '#dfe6dd'; // --hero: on stone, the mist the opening frames are set on

  var root = document.documentElement;
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function system() {
    return query && query.matches ? 'light' : 'dark';
  }

  function current() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  /*
   * The browser chrome on a phone, and the aria-label on every toggle. The chrome runs
   * on from the top of the page, so on stone it takes the mist where the page opens on
   * an opening frame. That frame has not been parsed when this first runs in the head;
   * the DOMContentLoaded pass below picks it up.
   */
  function sync() {
    var theme = current();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var hero = theme === 'light' && document.querySelector('.opening');
      meta.setAttribute('content', hero ? HERO : GROUND[theme]);
    }
    var label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    var toggles = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].setAttribute('aria-label', label);
    }
  }

  function apply(theme) {
    if (theme === current() && root.hasAttribute('data-theme')) {
      return;
    }
    root.setAttribute('data-theme', theme);
    sync();
    try {
      document.dispatchEvent(new CustomEvent('jr:themechange', { detail: { theme: theme } }));
    } catch (e) { /* no CustomEvent: nothing drawn will repaint, and nothing breaks */ }
  }

  /*
   * A switch the visitor asked for. Colours that carry a transition (links, rules) would
   * otherwise fade on their own clock while the ground snaps, so every transition is
   * held off for two frames. Where the browser has view transitions the whole page
   * cross-fades instead, which is the one place the change is allowed to be seen.
   */
  function set(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* the choice lasts this page */ }

    var reduced = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The hold is lifted from the swap itself: a view transition runs the swap a frame
    // or so later, and lifting it on a clock of its own could beat it there.
    root.classList.add('theme-switching');
    var swap = function () {
      apply(theme);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          root.classList.remove('theme-switching');
        });
      });
    };
    if (document.startViewTransition && !reduced) {
      try {
        document.startViewTransition(swap);
      } catch (e) {
        swap();
      }
    } else {
      swap();
    }
  }

  apply(stored() || system());

  if (query) {
    var follow = function () {
      if (!stored()) {
        apply(system());
      }
    };
    if (query.addEventListener) {
      query.addEventListener('change', follow);
    } else if (query.addListener) {
      query.addListener(follow);
    }
  }

  // Another tab made a choice.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) {
      apply(stored() || system());
    }
  });

  // Delegated, so it works for toggles parsed after this runs.
  document.addEventListener('click', function (e) {
    var toggle = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!toggle) {
      return;
    }
    e.preventDefault();
    set(current() === 'light' ? 'dark' : 'light');
  });

  // The theme-color meta and the toggles may not have been parsed yet.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sync);
  } else {
    sync();
  }

  window.jrTheme = {
    get: current,
    set: set
  };
})();
