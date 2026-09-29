/*
 * jeremy.ie/dashboard — page behaviour.
 *
 * The chrome only: the mobile nav, the scroll reveals, the one counting readout and
 * the footer year. Every widget on the page is a separate concern and lives in its own
 * file — dashboard-xray.js draws the opening trace and owns the GOES fetch,
 * dashboard-feeds.js runs the chart, the ephemeris, the Moon and the arXiv rows, and
 * dashboard-rail.js runs the Leaflet map.
 *
 * setupNav, setupReveals and setupCounters are lifted from speaking.js unchanged, so
 * the two internal pages reveal identically. Deliberately not home-coal.js: that file
 * also runs the intro overlay and the hide-the-header-over-the-hero behaviour, neither
 * of which belongs on a page you arrive at from a link.
 *
 * Everything is gated on prefers-reduced-motion, read once below.
 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- The readouts ---------- */

  /*
   * Unlike /speaking, none of the four figures at the foot of the opening frame is
   * written in the markup — a flare class, a train count, a day length and a paper
   * count are all things only a feed can know, and the em-dash each one ships with is
   * the honest answer until one answers. That is also what shows with scripting off,
   * or when SWPC is down, which is why nothing below ever clears a value it cannot
   * replace.
   *
   * Rather than have three files each reach into the rail with a selector of their
   * own, they call this.
   */
  var COUNT_MS = 1400;

  /*
   * Counting up only makes sense for a figure that means something part-way there.
   * "17 trains" does; "M1.4" and "14h 22m" do not, so only readouts marked
   * data-counts animate, and the rest simply appear.
   */
  function runCount(node, target) {
    if (!isFinite(target) || reducedMotion) {
      node.textContent = String(target);
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
      node.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) {
        requestAnimationFrame(step);
      }
    }

    node.textContent = '0';
    requestAnimationFrame(step);
  }

  window.dashboardReadout = function (key, value) {
    if (value === null || value === undefined || value === '') {
      return;
    }

    var node = document.querySelector('[data-readout="' + key + '"]');
    if (!node) {
      return;
    }

    if (node.hasAttribute('data-counts')) {
      runCount(node, parseFloat(value));
    } else {
      node.textContent = String(value);
    }
  };

  /* ---------- Boot ---------- */

  function boot() {
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
