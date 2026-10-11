/*
 * jeremy.ie — homepage behaviour.
 *
 * Four jobs, no dependencies and no build step: the header, the mobile nav, the
 * scroll reveals, and the year in the footer. Deliberately not Lenis — /f1 needs a
 * smoothed scroll because a canvas is being driven from it, and this page has no
 * canvas to drive. The loading sequence is in home-intro.js.
 *
 * Everything here is gated on prefers-reduced-motion, read once below: reveals fire
 * immediately instead of on intersection.
 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function byId(id) {
    return document.getElementById(id);
  }

  /* ---------- Header ---------- */

  /*
   * Held off the screen while the opening frame owns the viewport, the same way the
   * circuit page holds it over the scene. 70% of a viewport height rather than the
   * full one, so it has arrived by the time the first chapter rule crosses the top.
   */
  function setupHeader() {
    var header = byId('site-header');
    if (!header) {
      return;
    }

    /*
     * Its ground as well (see setupHeaderGround in site-nav.js): it comes back while the
     * foot of the opening is still under it, so on stone it arrives in mist and turns
     * stone as the frame scrolls away.
     */
    var opening = document.querySelector('.opening');

    function onScroll() {
      var past = window.pageYOffset > window.innerHeight * 0.7;
      header.classList.toggle('is-hidden', !past);
      header.classList.toggle(
        'is-over-opening',
        !!opening && opening.getBoundingClientRect().bottom > header.offsetHeight
      );
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  }

  /* ---------- Mobile nav ---------- */

  function setupNav() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = byId('site-nav');
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
     * sits at the very bottom of the first screen, below the observer's shrunk root,
     * so left to the observer it would stay invisible until the visitor scrolled past
     * the thing it belongs to. Everything inside .opening arrives on load instead —
     * on the next frame, so the transition still has an opacity to move from.
     *
     * While the loading sequence is running (class "intro" on <html>) the wait is for
     * its release event instead, so the headline rises when the numbers leave. The head
     * script marks data-intro-revealed when the event has already gone, and the timer is
     * a last resort for the case where neither happens.
     */
    var opening = document.querySelector('.opening');
    var deferred = [];

    reveals.forEach(function (node) {
      if (opening && opening.contains(node)) {
        deferred.push(node);
      }
    });

    function showOpening() {
      deferred.forEach(show);
    }

    var root = document.documentElement;
    if (root.classList.contains('intro') && !root.hasAttribute('data-intro-revealed')) {
      var released = false;
      var release = function () {
        if (!released) {
          released = true;
          showOpening();
        }
      };
      document.addEventListener('intro:release', release);
      window.setTimeout(release, 10000);
    } else {
      requestAnimationFrame(function () {
        requestAnimationFrame(showOpening);
      });
    }

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
    setupHeader();
    setupNav();
    setupReveals();

    var year = byId('year');
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
