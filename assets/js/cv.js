/*
 * jeremy.ie/cv — page behaviour.
 *
 * The chrome only: the mobile nav, the scroll reveals, the counting readouts and the
 * footer year. The opening timeline is a separate concern and lives in cv-timeline.js.
 *
 * setupNav, setupReveals and setupCounters are lifted from speaking.js unchanged — the
 * same lift dashboard-coal.js makes, and for the same reason: the three internal pages
 * must reveal identically. Deliberately not home-coal.js, which also runs the intro
 * overlay and the hide-the-header-over-the-hero behaviour, neither of which belongs on
 * a page you arrive at from a link.
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
    setupNav();
    setupReveals();
    setupCounters();

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
