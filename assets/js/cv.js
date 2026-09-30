/*
 * jeremy.ie/cv — page behaviour.
 *
 * The chrome only: the mobile nav, the scroll reveals, the counting readouts and the
 * footer year. The opening timeline is a separate concern and lives in cv-timeline.js.
 *
 * setupNav, setupReveals and setupCounters are lifted from speaking.js unchanged — the
 * same lift dashboard-coal.js makes, and for the same reason: the three internal pages
 * must reveal identically. Deliberately not home-coal.js, which also runs the
 * hide-the-header-over-the-hero behaviour, which does not belong on a page you arrive
 * at from a link.
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
   * The prefix and suffix are preserved separately — "8+" is not eight, and a counter
   * that ate the "+" would be quietly claiming an exact number the page does not have.
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
      var first = text.search(/\d/);
      if (first === -1) {
        return;
      }

      // Everything before the first digit — ">" or "~" or nothing — and everything
      // after the last one, which on this page is the "+" on the Python figure.
      var prefix = text.slice(0, first);
      var suffix = text.slice(text.search(/\d(?!.*\d)/) + 1);
      var grouped = text.indexOf(',') !== -1;

      function write(value) {
        var n = Math.round(value);
        node.textContent = prefix
          + (grouped ? n.toLocaleString('en-IE') : String(n))
          + suffix;
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

  /* ---------- Boot ---------- */

  function boot() {
    setupCounters();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
