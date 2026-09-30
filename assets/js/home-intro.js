/*
 * jeremy.ie: homepage loading sequence.
 *
 * Runs only when the inline script in the head of index.html has put the class "intro" on
 * <html>. That script leaves it off under prefers-reduced-motion, with ?intro=0, and on back
 * and forward navigation, so none of those see any of this.
 *
 * The stage sits over the real hero galaxy, which does not move. This file:
 *   1. Waits for the fonts the stage uses and for the galaxy's first frame (home-galaxy.js),
 *      each with a time limit.
 *   2. Runs a progress value p from 0 to 1 and passes it to the galaxy, which switches its
 *      stars on as p rises. p follows a fixed timeline. Until the two waits are over it is
 *      held at a ceiling, and the timeline stops with it.
 *   3. Fades a line of status text in and out, one phrase after another (PHRASES below).
 *   4. At p = 1 fades the stage out and lets the hero's own reveals start.
 *
 * It fails open. If this file throws, or the page is left waiting, the watchdogs in the head
 * script remove the stage and unlock the page (jrIntro.end in index.html).
 *
 * ES5, no dependencies, like the rest of the site.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  if (!root.classList.contains('intro')) {
    return;
  }

  /*
   * The status text. Each phrase starts at `at` ms on the timeline and shows for SHOW_MS:
   * FADE_MS to fade in, the rest held, and the last FADE_MS fading out. The timeline stops
   * while the sequence waits on fonts or the galaxy, so a slow load holds the current phrase.
   */
  var PHRASES = [
    { at: 300, text: 'Building universe' },
    { at: 1700, text: 'Collecting photons' },
    { at: 3100, text: 'Focusing telescope' }
  ];
  var SHOW_MS = 1300;
  var FADE_MS = 400;

  /* ---------- Timing ---------- */

  var TIMELINE_MS = 4600; // how long p takes to reach 1 when nothing holds it back
  var TIMELINE_POWER = 1.5; // above 1: slow at the start, faster later
  var FONT_CAP_MS = 900;
  var GALAXY_CAP_MS = 1500;
  var CEIL_FONTS = 0.05; // p is held here until the fonts are ready
  var CEIL_GALAXY = 0.5; // and here until the galaxy has drawn a frame
  var HARD_CAP_MS = 6000; // after this the sequence finishes whatever it is waiting for
  var CAP_FINISH_MS = 400;
  var SKIP_FINISH_MS = 250;
  var REVEAL_AT_MS = 250; // into the exit, the hero's own reveals start
  var EXIT_MS = 700;
  var SKIP_SHOW_MS = 700;

  /* ---------- Helpers ---------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }

  function thousands(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // p as a function of time on the timeline, and the inverse.
  function pAt(ms) {
    return Math.pow(clamp01(ms / TIMELINE_MS), TIMELINE_POWER);
  }

  function msAt(p) {
    return TIMELINE_MS * Math.pow(p, 1 / TIMELINE_POWER);
  }

  /*
   * The head script owns release, so the watchdogs and this file end the sequence the same
   * way. The stub is for the case where it is missing, which should not happen.
   */
  function jr() {
    return window.jrIntro || {
      reveal: function () {
        try {
          document.dispatchEvent(new CustomEvent('intro:release'));
        } catch (e) { /* nothing listens without it */ }
      },
      end: function () {
        root.classList.remove('intro', 'intro-out');
      }
    };
  }

  /* ---------- State ---------- */

  var stage = byId('preload');
  var bar = byId('intro-bar');
  var plotted = byId('intro-plotted');
  var phrase = byId('intro-phrase');
  var skipButton = byId('intro-skip');

  var fontsOpen = false;
  var galaxyOpen = false;
  var bootT = performance.now();
  var lastT = 0;
  var tl = 0; // position on the timeline, ms
  var p = 0;
  var finishing = false;
  var finishFrom = 0;
  var finishT = 0;
  var finishMs = 0;
  var exiting = false;
  var skipShown = false;
  var plottedText = '';
  var phraseIndex = -1;

  /* ---------- Stage ---------- */

  function lockPage() {
    var targets = document.querySelectorAll('#site-header, main, .site-footer');
    for (var i = 0; i < targets.length; i++) {
      targets[i].setAttribute('inert', '');
      targets[i].setAttribute('data-intro-inert', '');
    }
    var main = document.querySelector('main');
    if (main) {
      main.setAttribute('aria-busy', 'true');
    }
  }

  /*
   * The words change while the line is faded out: each phrase starts at least FADE_MS after
   * the one before it has begun to fade.
   */
  function showPhrase() {
    var index = -1;
    var on = false;
    if (fontsOpen && !finishing) {
      for (var i = 0; i < PHRASES.length; i++) {
        if (tl >= PHRASES[i].at && tl < PHRASES[i].at + SHOW_MS) {
          index = i;
          on = tl < PHRASES[i].at + SHOW_MS - FADE_MS;
        }
      }
    }
    if (index !== phraseIndex && index !== -1) {
      phrase.textContent = PHRASES[index].text;
    }
    phraseIndex = index;
    phrase.classList.toggle('is-on', on);
  }

  /* ---------- Waiting ---------- */

  function openFonts() {
    if (!fontsOpen) {
      fontsOpen = true;
      stage.classList.add('fonts-ready');
    }
  }

  function openGalaxy() {
    galaxyOpen = true;
  }

  function startWaiting() {
    window.setTimeout(openFonts, FONT_CAP_MS);
    try {
      var faces = [
        '400 1em "Chivo Mono"', '500 1em "Chivo Mono"', '600 1em "Chivo Mono"',
        '700 1em "Chivo Mono"', '400 1em "Inter"'
      ];
      Promise.all(faces.map(function (face) {
        return document.fonts.load(face);
      })).then(openFonts, openFonts);
    } catch (e) {
      openFonts();
    }

    if (window.JRGalaxy && window.JRGalaxy.ready) {
      openGalaxy();
    } else {
      document.addEventListener('galaxy:ready', openGalaxy);
      window.setTimeout(openGalaxy, GALAXY_CAP_MS);
    }
  }

  /* ---------- Skip ---------- */

  function startFinish(now, ms) {
    if (finishing || exiting) {
      return;
    }
    finishing = true;
    finishFrom = p;
    finishT = now;
    finishMs = ms;
  }

  function skip() {
    startFinish(performance.now(), SKIP_FINISH_MS);
  }

  /*
   * The cookie banner is in its own root. Clicks there never reach the stage. Keys do reach
   * the document, so a key press that started inside the banner is ignored.
   */
  function fromConsent(event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      if (path[i] && path[i].id && /usercentrics/i.test(path[i].id)) {
        return true;
      }
    }
    return false;
  }

  function onKey(event) {
    var key = event.key;
    if (key !== 'Escape' && key !== 'Enter' && key !== ' ' && key !== 'Spacebar') {
      return;
    }
    if (!fromConsent(event)) {
      skip();
    }
  }

  /* ---------- Exit ---------- */

  function exit() {
    exiting = true;
    root.classList.add('intro-out');
    window.setTimeout(function () {
      jr().reveal();
    }, REVEAL_AT_MS);
    window.setTimeout(end, EXIT_MS);
  }

  function end() {
    var hadFocus = stage.contains(document.activeElement);
    jr().end();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('galaxy:ready', openGalaxy);

    // Focus was on the Skip button, which is gone now. Put it at the top of the page.
    var title = document.querySelector('.opening-title');
    if (hadFocus && title) {
      title.setAttribute('tabindex', '-1');
      try {
        title.focus({ preventScroll: true });
      } catch (e) {
        title.focus();
      }
    }
  }

  function fail(error) {
    try {
      if (window.console && console.error) {
        console.error('home-intro:', error);
      }
    } catch (e) { /* nothing to do */ }
    exiting = true;
    jr().end();
  }

  /* ---------- Loop ---------- */

  function step(now) {
    var galaxy = window.JRGalaxy;
    var dt = lastT ? Math.min(50, now - lastT) : 16;
    lastT = now;

    if (galaxy && galaxy.ready) {
      galaxyOpen = true;
    }
    if (!finishing && !exiting && now - bootT >= HARD_CAP_MS) {
      startFinish(now, CAP_FINISH_MS);
    }

    if (finishing) {
      p = finishFrom + (1 - finishFrom) * clamp01((now - finishT) / finishMs);
    } else {
      // The timeline stops while p is held at a ceiling, so there is no jump when it lifts.
      tl += dt;
      var ceiling = galaxyOpen ? 1 : CEIL_GALAXY;
      if (!fontsOpen) {
        ceiling = Math.min(ceiling, CEIL_FONTS);
      }
      if (pAt(tl) > ceiling) {
        tl = msAt(ceiling);
      }
      p = pAt(tl);
    }
    if (galaxy && galaxy.setProgress) {
      galaxy.setProgress(p);
    }

    showPhrase();

    bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    if (galaxy && galaxy.count) {
      var text = 'Plotted ' + thousands(galaxy.lit()) + ' / ' + thousands(galaxy.count);
      if (text !== plottedText) {
        plottedText = text;
        plotted.textContent = text;
      }
    }

    if (!skipShown && now - bootT >= SKIP_SHOW_MS) {
      skipShown = true;
      skipButton.classList.add('is-on');
    }

    if (p >= 1 && !exiting) {
      exit();
    }
  }

  function frame(now) {
    // Something else ended the sequence: the watchdogs, or the exit.
    if (exiting || !root.classList.contains('intro')) {
      return;
    }
    try {
      step(now);
    } catch (e) {
      fail(e);
      return;
    }
    window.requestAnimationFrame(frame);
  }

  /* ---------- Boot ---------- */

  function boot() {
    // First, so the head script's check sees it as early as possible.
    root.setAttribute('data-intro-alive', '1');

    lockPage();
    startWaiting();

    stage.addEventListener('click', skip);
    stage.addEventListener('wheel', skip, { passive: true });
    stage.addEventListener('touchmove', skip, { passive: true });
    document.addEventListener('keydown', onKey);

    window.requestAnimationFrame(frame);
  }

  try {
    if (!stage || !bar || !plotted || !phrase || !skipButton) {
      throw new Error('stage markup is missing');
    }
    boot();
  } catch (e) {
    fail(e);
  }
})();
