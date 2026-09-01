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
   * An observer rather than fixed scroll positions: the panels vary in height with the
   * viewport, the type and — on this page more than the others — with whatever the
   * feeds return, and a library that measures trigger points up front gets them wrong
   * the moment a webfont lands or an abstract arrives and reflows the page.
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
     * left to the observer it would stay invisible until the visitor scrolled past the
     * thing it belongs to. Everything inside .opening arrives on load instead — on the
     * next frame, so the transition still has an opacity to move from.
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
    setupNav();
    setupReveals();

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
}());
