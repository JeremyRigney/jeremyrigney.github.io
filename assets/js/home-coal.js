/*
 * jeremy.ie — homepage behaviour.
 *
 * Five jobs, no dependencies and no build step: the header, the mobile nav, the
 * scroll reveals, the intro overlay, and the year in the footer. Deliberately not
 * Lenis — /f1 needs a smoothed scroll because a canvas is being driven from it, and
 * this page has no canvas to drive.
 *
 * Everything here is gated on prefers-reduced-motion, read once below: no overlay, no
 * draw-on, and reveals fire immediately instead of on intersection.
 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * How long the outline takes to draw, and the floor under the whole sequence.
   * Shorter than /f1's 3s because nothing here is waiting on the network — the only
   * thing the overlay covers is the webfonts, and a stalled font load must never be
   * able to leave a visitor looking at a blank screen.
   */
  var INTRO_LIMB_MS = 900;
  var INTRO_CRATER_MS = 520;
  var INTRO_CRATER_GAP_MS = 70;
  var INTRO_CRATER_START_MS = 340;
  var INTRO_MAX_MS = 2600;

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

    function onScroll() {
      var past = window.pageYOffset > window.innerHeight * 0.7;
      header.classList.toggle('is-hidden', !past);
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

  /* ---------- Intro overlay ---------- */

  /*
   * Returns a no-op stub under reduced motion, or when the markup is not there, so
   * nothing downstream has to branch on whether the sequence is running.
   */
  function makeIntro() {
    var node = byId('preload');
    var paths = node
      ? Array.prototype.slice.call(node.querySelectorAll('.glyph-draw'))
      : [];
    var bar = byId('preload-bar');
    var done = false;

    if (!node || !paths.length || reducedMotion) {
      return {
        progress: function () {},
        draw: function () { return 0; },
        finish: function () {}
      };
    }

    node.hidden = false;

    var shown = 0;
    var wanted = 0;
    var ticking = false;

    // The counter eases toward the true fraction rather than jumping to it, so a
    // font that resolves instantly from cache still reads as a count rather than a
    // flash of "100%".
    function tick() {
      shown += (wanted - shown) * 0.12;
      if (wanted - shown < 0.005) {
        shown = wanted;
      }
      paint();
      if (shown < wanted) {
        requestAnimationFrame(tick);
      } else {
        ticking = false;
      }
    }

    function paint() {
      var count = byId('preload-count');
      if (count) {
        count.textContent = Math.round(shown * 100) + '%';
      }
      if (bar) {
        bar.style.setProperty('--p', String(shown));
      }
    }

    function progress(fraction, snap) {
      wanted = Math.max(wanted, Math.min(Math.max(fraction, 0), 1));
      // The last step does not ease: the overlay starts fading on the same frame, and
      // easing toward 100 would hide it still showing 90-something.
      if (snap) {
        shown = wanted;
        paint();
        return;
      }
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(tick);
      }
    }

    return {
      progress: progress,

      /*
       * Draw the disc on: the limb first, then each crater rim after it, smallest
       * last. Every length is measured rather than guessed — the same technique the
       * plate annotation used — so a rim of any size runs at its own honest speed
       * instead of every ring taking the same time regardless of circumference.
       */
      draw: function () {
        paths.forEach(function (path, i) {
          var limb = i === 0;
          var length = path.getTotalLength();
          path.style.strokeDasharray = length;
          path.style.strokeDashoffset = length;
          // Force layout so the transition has a start value to move from.
          path.getBoundingClientRect();
          path.style.transition = 'stroke-dashoffset '
            + (limb ? INTRO_LIMB_MS : INTRO_CRATER_MS)
            + 'ms cubic-bezier(0.22, 1, 0.36, 1) '
            + (limb ? 0 : INTRO_CRATER_START_MS + (i - 1) * INTRO_CRATER_GAP_MS)
            + 'ms';
          path.style.strokeDashoffset = '0';
        });

        // How long the whole disc takes, so the caller does not have to re-derive it
        // from the constants every time a crater is added or removed.
        return Math.max(
          INTRO_LIMB_MS,
          INTRO_CRATER_START_MS
            + Math.max(paths.length - 2, 0) * INTRO_CRATER_GAP_MS
            + INTRO_CRATER_MS
        );
      },

      finish: function () {
        if (done) {
          return;
        }
        done = true;
        progress(1, true);
        node.classList.add('is-out');
        // Taken out of the accessibility tree once it has faded, so it is not a
        // focusable, screen-reader-visible layer sitting over the page forever.
        window.setTimeout(function () { node.hidden = true; }, 800);
      }
    };
  }

  function runIntro() {
    var intro = makeIntro();
    // The floor under the whole sequence. Whatever the fonts are doing, the overlay
    // comes down; the page underneath is readable with or without it.
    var failsafe = window.setTimeout(intro.finish, INTRO_MAX_MS);

    function finish() {
      window.clearTimeout(failsafe);
      intro.progress(0.9);
      window.setTimeout(intro.finish, intro.draw());
    }

    intro.progress(0.12);

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        intro.progress(0.6);
        finish();
      }).catch(finish);
    } else {
      finish();
    }
  }

  /* ---------- Boot ---------- */

  function boot() {
    setupHeader();
    setupNav();
    setupReveals();
    runIntro();

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
