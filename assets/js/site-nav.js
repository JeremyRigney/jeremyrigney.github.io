/*
 * jeremy.ie — shared page chrome.
 *
 * The mobile nav, the scroll reveals and the footer year, for every page that wears the
 * coal design system except the homepage (home-coal.js keeps its own copy: its reveals
 * are sequenced with the intro overlay and the hide-the-header behaviour).
 *
 * This was setupNav / setupReveals, byte-identical in cv.js, speaking.js and
 * dashboard-coal.js. It is one file now so that a change to the chrome is one edit.
 * Everything is gated on prefers-reduced-motion: reveals fire immediately.
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
})();
