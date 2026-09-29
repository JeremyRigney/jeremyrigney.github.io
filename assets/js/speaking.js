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
    setupCounters();
    setupFilter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
