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
 *   3. Counts up numbers worked out from the visitor's clock (the DECK below) as p passes a
 *      point set on each row.
 *   4. At p = 1 slides the numbers out and lets the hero's own reveals start.
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

  /* ---------- Numbers ---------- */

  var SUN_KMS = 230; // the Sun's speed around the galaxy, km/s (quoted as 220 to 240)
  var EARTH_KMS = 29.78; // Earth's mean speed around the Sun, km/s
  var AU_KM = 149597870.7;
  var LIGHT_KMS = 299792.458;
  var J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /*
   * The rows of the stage. To add or change one, edit this list.
   *
   *   at      the progress at which the row starts (0 to 1)
   *   prefix  shown before the number as a separate glyph, so a rounded figure is never
   *           shown as an exact one (speaking.js does the same with ">")
   *   sig     the number of significant figures the value is rounded to
   *   value   the number, from the object returned by context()
   *   note    a line under the label
   *
   * A fixed number is a row whose value function returns a constant.
   */
  var DECK = [
    {
      at: 0.01,
      prefix: '~',
      unit: 'km',
      sig: 4,
      label: 'From you to the Sun, today',
      value: function (c) { return c.sunKm; },
      note: function (c) { return 'Sunlight left the Sun ' + c.lightTime + ' ago'; }
    },
    {
      at: 0.20,
      prefix: '~',
      unit: 'km',
      sig: 2,
      label: 'Around the Sun since 1 January',
      value: function (c) { return EARTH_KMS * c.secs; },
      note: function (c) { return 'About ' + c.yearPct + '% of one orbit, at 29.8 km/s'; }
    },
    {
      at: 0.45,
      prefix: '~',
      unit: 'km',
      sig: 2,
      label: 'Around the galaxy since 1 January',
      value: function (c) { return SUN_KMS * c.secs; },
      note: function () { return 'At about 230 km/s. One orbit takes about 230 million years'; }
    }
  ];

  var TICKER_AT = 0.80;
  var TICKER_LABEL = 'Since you arrived';
  var CLOSER_AT = 0.86;
  var CLOSER = '1 unreal website';

  /* ---------- Timing ---------- */

  var TIMELINE_MS = 4600; // how long p takes to reach 1 when nothing holds it back
  var TIMELINE_POWER = 1.5; // above 1: slow at the start, faster later
  var ROW_GAP_MS = 900; // the least time between one row starting and the next
  var COUNT_MS = 1000; // how long a row takes to count up
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

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }

  function thousands(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function roundSig(n, sig) {
    if (!(n > 0)) {
      return 0;
    }
    var unit = Math.pow(10, Math.floor(Math.log(n) / Math.LN10) - sig + 1);
    return Math.round(n / unit) * unit;
  }

  // p as a function of time on the timeline, and the inverse.
  function pAt(ms) {
    return Math.pow(clamp01(ms / TIMELINE_MS), TIMELINE_POWER);
  }

  function msAt(p) {
    return TIMELINE_MS * Math.pow(p, 1 / TIMELINE_POWER);
  }

  /*
   * What the rows are worked out from. The visitor's clock is used as it is between 2024 and
   * 2050. Outside that range the maths uses the nearest end, and the date label is left out,
   * because a clock that far off is more likely wrong than right.
   */
  function context() {
    var lo = Date.UTC(2024, 0, 1);
    var hi = Date.UTC(2050, 11, 31);
    var now = new Date();
    var clamped = false;
    if (now.getTime() < lo) {
      now = new Date(lo);
      clamped = true;
    } else if (now.getTime() > hi) {
      now = new Date(hi);
      clamped = true;
    }

    var ms = now.getTime();
    var yearStart = new Date(now.getFullYear(), 0, 1).getTime();
    var yearEnd = new Date(now.getFullYear() + 1, 0, 1).getTime();

    /*
     * Distance from the Earth to the Sun. A two-term expansion of the orbit in the mean
     * anomaly g. It matches a full Kepler solution to about 2,000 km (0.001%).
     */
    var days = (ms - J2000_MS) / 86400000;
    var g = (357.528 + 0.9856003 * days) * Math.PI / 180;
    var au = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    var sunKm = au * AU_KM;
    var light = Math.round(sunKm / LIGHT_KMS);

    return {
      clamped: clamped,
      date: now,
      secs: (ms - yearStart) / 1000,
      sunKm: sunKm,
      lightTime: Math.floor(light / 60) + ' min ' + (light % 60) + ' s',
      yearPct: Math.round((ms - yearStart) / (yearEnd - yearStart) * 100)
    };
  }

  /* ---------- Release ---------- */

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
  var ticker = byId('intro-ticker');
  var tickerValue = ticker && ticker.querySelector('.intro-ticker-value');
  var closer = byId('intro-closer');
  var skipButton = byId('intro-skip');

  var rows = [];
  var ctx = null;

  var fontsOpen = false;
  var galaxyOpen = false;
  var bootT = performance.now();
  var visibleT = 0; // the first frame the stage was on screen
  var lastT = 0;
  var tl = 0; // position on the timeline, ms
  var p = 0;
  var lastRowT = -1e9;
  var finishing = false;
  var finishFrom = 0;
  var finishT = 0;
  var finishMs = 0;
  var exiting = false;
  var skipShown = false;
  var plottedText = '';
  var tickerText = '';

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

  function buildStage() {
    var today = byId('intro-today');
    if (today && !ctx.clamped) {
      today.textContent = 'Today ' + ctx.date.getDate() + ' '
        + MONTHS[ctx.date.getMonth()] + ' ' + ctx.date.getFullYear();
    }

    var list = byId('intro-rows');
    DECK.forEach(function (def) {
      var li = el('li', 'intro-row');
      var mask = el('span', 'line-mask');
      var figure = el('span', 'intro-figure');
      var value = el('span', 'intro-value', '0');

      figure.appendChild(el('span', 'intro-prefix', def.prefix));
      figure.appendChild(value);
      figure.appendChild(el('span', 'intro-unit', def.unit));
      mask.appendChild(figure);
      li.appendChild(mask);
      li.appendChild(el('span', 'intro-label', def.label));
      li.appendChild(el('span', 'intro-note', def.note(ctx)));
      list.appendChild(li);

      rows.push({
        def: def,
        li: li,
        mask: mask,
        value: value,
        target: roundSig(def.value(ctx), def.sig),
        state: 0, // 0 waiting, 1 counting, 2 done
        start: 0,
        text: '0'
      });
    });

    ticker.querySelector('.intro-ticker-label').textContent = TICKER_LABEL;
    closer.textContent = CLOSER;
  }

  function startRow(row, now) {
    row.state = 1;
    row.start = now;
    lastRowT = now;
    row.li.classList.add('is-on');
    row.mask.classList.add('is-in');
    var i = rows.indexOf(row);
    if (i > 0) {
      rows[i - 1].li.classList.add('is-old');
    }
  }

  /*
   * In a monospace face a comma takes a full character cell, which leaves wide gaps at this
   * size. Each comma goes in an element that CSS makes narrower. The text is only digits and
   * commas.
   */
  function setRowText(row, n) {
    var text = thousands(n);
    if (text !== row.text) {
      row.text = text;
      row.value.innerHTML = text.replace(/,/g, '<i class="intro-comma">,</i>');
    }
  }

  /*
   * The count runs in log space: the number is target^s, with s rising from 0 to 1. The
   * digit count grows at a steady rate and the leading digits settle near the end. A count
   * that rose in a straight line would have its leading digits final almost at once.
   */
  function countRow(row, now) {
    var f = clamp01((now - row.start) / COUNT_MS);
    var s = 1 - Math.pow(1 - f, 3);
    var v = row.target < 10 ? row.target * s : Math.pow(row.target, s) - 1;
    setRowText(row, f >= 1 ? row.target : v);
    if (f >= 1) {
      row.state = 2;
      row.li.classList.add('is-locked');
    }
  }

  function finishRow(row, now) {
    if (row.state === 0) {
      startRow(row, now);
    }
    setRowText(row, row.target);
    row.state = 2;
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
    if (!visibleT) {
      visibleT = now;
    }
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

    var i, row;
    for (i = 0; i < rows.length; i++) {
      row = rows[i];
      if (finishing) {
        if (row.state < 2) {
          finishRow(row, now);
        }
        continue;
      }
      if (row.state === 0) {
        if (fontsOpen && p >= row.def.at && now - lastRowT >= ROW_GAP_MS) {
          startRow(row, now);
        } else {
          break;
        }
      }
      if (row.state === 1) {
        countRow(row, now);
      }
    }

    var tickerOn = finishing || p >= TICKER_AT;
    ticker.classList.toggle('is-on', tickerOn && fontsOpen);
    closer.classList.toggle('is-on', (finishing || p >= CLOSER_AT) && fontsOpen);
    if (tickerOn) {
      // Kilometres carried round the galaxy since the stage first showed, to the nearest 10.
      var kmText = '~' + thousands(Math.round(SUN_KMS * (now - visibleT) / 10000) * 10) + ' km';
      if (kmText !== tickerText) {
        tickerText = kmText;
        tickerValue.textContent = kmText;
      }
    }

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
      var done = true;
      for (i = 0; i < rows.length; i++) {
        done = done && rows[i].state === 2;
      }
      if (done) {
        exit();
      }
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

    ctx = context();
    lockPage();
    buildStage();
    startWaiting();

    stage.addEventListener('click', skip);
    stage.addEventListener('wheel', skip, { passive: true });
    stage.addEventListener('touchmove', skip, { passive: true });
    document.addEventListener('keydown', onKey);

    window.requestAnimationFrame(frame);
  }

  try {
    if (!stage || !bar || !plotted || !ticker || !closer || !skipButton || !byId('intro-rows')) {
      throw new Error('stage markup is missing');
    }
    boot();
  } catch (e) {
    fail(e);
  }
})();
