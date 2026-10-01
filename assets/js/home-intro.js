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
 *   3. Adds lines of status text one below the other (PHRASES below).
 *   4. Keeps the galaxy out of focus (a CSS blur on its canvas) until "Focusing telescope",
 *      then racks it into focus as p runs from there to 1.
 *   5. At p = 1 fades the stage out and lets the hero's own reveals start.
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
   * The status text. Each phrase is added below the last when the timeline reaches `at` (ms),
   * fades in, and stays until the stage ends. The timeline stops while the sequence waits on
   * fonts or the galaxy, so a slow load holds the lines already shown.
   */
  var FOCUS_AT_MS = 5300; // the focus pull starts with this line

  var PHRASES = [
    { at: 500, text: 'Building universe' },
    { at: 2900, text: 'Collecting photons' },
    { at: FOCUS_AT_MS, text: 'Focusing telescope' }
  ];

  /* ---------- Timing ---------- */

  var TIMELINE_MS = 7400; // how long p takes to reach 1 when nothing holds it back
  var TIMELINE_POWER = 1.5; // above 1: slow at the start, faster later
  var FONT_CAP_MS = 900;
  var GALAXY_CAP_MS = 1500;
  var CEIL_FONTS = 0.05; // p is held here until the fonts are ready
  var CEIL_GALAXY = 0.5; // and here until the galaxy has drawn a frame
  var HARD_CAP_MS = 9500; // after this the sequence finishes whatever it is waiting for
  var CAP_FINISH_MS = 400;
  var SKIP_FINISH_MS = 250;
  var REVEAL_AT_MS = 250; // into the exit, the hero's own reveals start
  var EXIT_MS = 700;
  var SKIP_SHOW_MS = 700;

  /*
   * Focus. The blur is at its widest until the timeline reaches FOCUS_AT_MS and is gone at
   * p = 1. It follows p, not the clock, so a held timeline holds the blur and Skip snaps the
   * galaxy into focus over its short finish. The width scales with the frame, between
   * BLUR_MIN_PX and BLUR_MAX_PX, so a phone is not smeared to nothing.
   */
  var BLUR_PER_PX = 0.006;
  var BLUR_MIN_PX = 4;
  var BLUR_MAX_PX = 9;
  var DEFOCUS_LIFT = 0.5; // extra brightness at full blur

  /* ---------- Helpers ---------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }

  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
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
  var phraseList = byId('intro-phrases');
  var skipButton = byId('intro-skip');
  var canvas = byId('galaxy-canvas');

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
  var phraseLines = [];
  var focusFrom = 0; // p at FOCUS_AT_MS, set in boot()
  var blurPx = 0;
  var focusText = '';

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

  function buildPhrases() {
    PHRASES.forEach(function (def) {
      var li = document.createElement('li');
      li.className = 'intro-phrase';
      var index = document.createElement('span');
      index.className = 'intro-phrase-index';
      index.textContent = '0' + (phraseLines.length + 1);
      var text = document.createElement('span');
      text.className = 'intro-phrase-text';
      text.textContent = def.text;
      li.appendChild(index);
      li.appendChild(text);
      phraseList.appendChild(li);
      phraseLines.push(li);
    });
  }

  // A line fades in when its time comes. The one before it dims.
  function showPhrases() {
    if (!fontsOpen || finishing) {
      return;
    }
    for (var i = 0; i < PHRASES.length; i++) {
      if (tl >= PHRASES[i].at && !phraseLines[i].classList.contains('is-on')) {
        phraseLines[i].classList.add('is-on', 'is-new');
        if (i > 0) {
          phraseLines[i - 1].classList.remove('is-new');
        }
      }
    }
  }

  /* ---------- Focus ---------- */

  function setFocus() {
    if (!canvas) {
      return;
    }
    var defocus = 1 - smoothstep(focusFrom, 1, p);
    var blur = (defocus * blurPx).toFixed(2);
    if (blur === focusText) {
      return;
    }
    focusText = blur;
    canvas.style.setProperty('--galaxy-defocus', blur + 'px');
    canvas.style.setProperty('--galaxy-defocus-lift', (1 + DEFOCUS_LIFT * defocus).toFixed(3));
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
        '700 1em "Chivo Mono"', '400 1em "Inter"', '300 1em "Fraunces"'
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
   * The cookie card is a sibling of the stage, not inside it, so clicks there never reach
   * the stage. Keys do reach the document, so a key press that started inside the card is
   * ignored.
   */
  function fromConsent(event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      if (path[i] && path[i].id === 'jr-consent') {
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

    setFocus();
    showPhrases();

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
    buildPhrases();

    // Out of focus from the first frame, so the galaxy never shows sharp first.
    focusFrom = pAt(FOCUS_AT_MS);
    var frameWidth = canvas ? canvas.getBoundingClientRect().width : 0;
    blurPx = Math.min(BLUR_MAX_PX, Math.max(BLUR_MIN_PX, frameWidth * BLUR_PER_PX));
    setFocus();

    startWaiting();

    stage.addEventListener('click', skip);
    stage.addEventListener('wheel', skip, { passive: true });
    stage.addEventListener('touchmove', skip, { passive: true });
    document.addEventListener('keydown', onKey);

    window.requestAnimationFrame(frame);
  }

  try {
    if (!stage || !bar || !plotted || !phraseList || !skipButton) {
      throw new Error('stage markup is missing');
    }
    boot();
  } catch (e) {
    fail(e);
  }
})();
