/*
 * jeremy.ie/speaking — page behaviour.
 *
 * Four jobs, no dependencies and no build step: the mobile nav, the scroll reveals,
 * the counting rail, and the filter on the full record. The map is a separate concern
 * and lives in speaking-map.js.
 *
 * Deliberately not home-coal.js. That file also runs the intro overlay and the
 * hide-the-header-over-the-hero behaviour, neither of which belongs on an internal
 * page; setupNav and setupReveals below are lifted from it unchanged so the two pages
 * reveal identically.
 *
 * Everything is gated on prefers-reduced-motion, read once below: reveals fire
 * immediately instead of on intersection, and the counters snap to their final values.
 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Mobile nav ---------- */

  function setupNav() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('site-nav');
    if (!toggle || !nav) {
      return;
    }

    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });

    // Anchor links scroll the page underneath an open panel otherwise.
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open menu');
      }
    });
  }

  /* ---------- Reveals ---------- */

  /*
   * An observer rather than fixed scroll positions: the chapters vary in height with
   * the viewport and the type, and a library that measures trigger points up front
   * gets them wrong the moment a webfont lands and reflows the page.
   */
  function setupReveals() {
    var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

    // A stagger index per direct child, so a group arrives as a sequence rather than
    // all at once. Set at reveal time so nothing has to be measured up front.
    function stagger(node) {
      var children = node.children;
      for (var i = 0; i < children.length; i += 1) {
        if (!children[i].style.getPropertyValue('--d')) {
          children[i].style.setProperty('--d', String(i));
        }
      }
    }

    function show(node) {
      stagger(node);
      node.classList.add('is-in');
    }

    if (reducedMotion || !('IntersectionObserver' in window)) {
      reveals.forEach(show);
      return;
    }

    /*
     * The opening frame presents itself; it is never scrolled into. Its readout rail
     * sits at the bottom of the first screen, below the observer's shrunk root, so
     * left to the observer it would stay invisible until the visitor scrolled past
     * the thing it belongs to. Everything inside .opening arrives on load instead —
     * on the next frame, so the transition still has an opacity to move from.
     */
    var opening = document.querySelector('.opening');
    var deferred = [];

    reveals.forEach(function (node) {
      if (opening && opening.contains(node)) {
        deferred.push(node);
      }
    });

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        deferred.forEach(show);
      });
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          show(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -12% 0px' });

    reveals.forEach(function (node) {
      if (deferred.indexOf(node) === -1) {
        observer.observe(node);
      }
    });
  }

  /* ---------- The counting rail ---------- */

  /*
   * The final values are in the markup, not in here: with no JavaScript the rail
   * reads correctly, and there is only ever one place a figure is written down. This
   * only re-renders the number that is already there, counting up to it.
   *
   * The prefix is preserved separately — three of the four figures are written ">60",
   * ">3,500" and so on, and a counter that eats the ">" would be quietly claiming an
   * exact number the page does not have.
   */
  var COUNT_MS = 1400;

  function setupCounters() {
    var nodes = Array.prototype.slice.call(
      document.querySelectorAll('[data-count]')
    );
    if (!nodes.length) {
      return;
    }

    function run(node) {
      var target = parseFloat(node.getAttribute('data-count'));
      if (!isFinite(target)) {
        return;
      }

      var text = node.textContent.trim();
      // Everything before the first digit — ">" or "~" or nothing.
      var prefix = text.slice(0, text.search(/\d/));
      var grouped = text.indexOf(',') !== -1;

      function write(value) {
        var n = Math.round(value);
        node.textContent = prefix
          + (grouped ? n.toLocaleString('en-IE') : String(n));
      }

      if (reducedMotion) {
        return;
      }

      var start = null;

      function step(now) {
        if (start === null) {
          start = now;
        }
        var t = Math.min((now - start) / COUNT_MS, 1);
        // The same cubic-out the rest of the site eases on, so the count decelerates
        // into its final value rather than stopping dead.
        write(target * (1 - Math.pow(1 - t, 3)));
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          // Restore the authored string exactly, so any formatting the markup carries
          // that toLocaleString would not reproduce survives the count.
          node.textContent = text;
        }
      }

      write(0);
      requestAnimationFrame(step);
    }

    if (reducedMotion || !('IntersectionObserver' in window)) {
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          run(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });

    nodes.forEach(function (node) {
      observer.observe(node);
    });
  }

  /* ---------- The record filter ---------- */

  /*
   * Chips that hide rows by category. The filtering is a class on the list plus one
   * attribute selector per category in speaking.css, rather than a style write per
   * row: 30 inline styles is 30 layout invalidations, and this way the CSS owns what
   * "hidden" means and the no-JS case is simply the class never being set.
   */
  function setupFilter() {
    var rail = document.querySelector('.filter-rail');
    var list = document.getElementById('record-list');
    if (!rail || !list) {
      return;
    }

    var chips = Array.prototype.slice.call(rail.querySelectorAll('.filter-chip'));
    var count = document.getElementById('record-count');
    var total = list.querySelectorAll('.record-item').length;

    rail.hidden = false;

    function apply(value) {
      list.setAttribute('data-filter', value);

      chips.forEach(function (chip) {
        var on = chip.getAttribute('data-filter') === value;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });

      if (count) {
        var shown = value === 'all'
          ? total
          : list.querySelectorAll('.record-item[data-cat="' + value + '"]').length;
        count.textContent = shown === total
          ? total + ' talks'
          : shown + ' of ' + total;
      }
    }

    rail.addEventListener('click', function (event) {
      var chip = event.target.closest('.filter-chip');
      if (chip) {
        apply(chip.getAttribute('data-filter'));
      }
    });

    apply('all');
  }

  /* ---------- Boot ---------- */

  function boot() {
    setupNav();
    setupReveals();
    setupCounters();
    setupFilter();

    var year = document.getElementById('year');
    if (year) {
      year.textContent = String(new Date().getFullYear());
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
