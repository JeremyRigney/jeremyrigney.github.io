/*
 * jeremy.ie — the sky below the title page.
 *
 * A few objects dotted down the homepage's chapters: open clusters (loose knots of
 * young, blue stars, some of them minis of a dozen or so), globular clusters (dense,
 * old balls of hundreds), and a few bright nearby stars with diffraction spikes. The
 * galaxy in the opening frame is the main feature, so nothing here goes near it.
 *
 * Everything is static. Each object is its own small canvas, painted once and placed
 * inside a chapter, so it scrolls with the page and costs nothing per frame. A single
 * page-sized canvas was the alternative, and at 5,000px tall it is a lot of buffer for
 * a dozen small things.
 *
 * Placement keeps coal.css's rule that atmosphere never sits behind body copy. Every
 * chapter opens with a tall empty padding band above its heading, which is text-free
 * at every width, and on wide screens there are side gutters outside the 1180px
 * column. Objects only ever go in those two places.
 *
 * Loaded separately from home-coal.js and home-galaxy.js on purpose: it is decoration,
 * and if it throws, nothing else may go with it. For the same reason the handful of
 * small helpers at the top are copies of the galaxy's, not shared with it.
 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- The sky ---------- */

  /*
   * One entry per object. place 'band' sits in the empty band above the chapter's
   * heading, at `at` across the text column (0 left, 1 right). place 'gutter' sits
   * outside the column on `side`, at `at` down the chapter, and only exists on screens
   * wide enough to have a gutter. `phone` marks the few that are kept on a phone.
   */
  var SKY = [
    { chapter: 'about', place: 'band', at: 0.92, type: 'open', size: 150, seed: 11, phone: true },
    { chapter: 'about', place: 'gutter', side: 'l', at: 0.55, type: 'star', size: 120, seed: 12, tint: 'warm' },

    { chapter: 'work', place: 'band', at: 0.08, type: 'mini', size: 90, seed: 21, phone: true },
    { chapter: 'work', place: 'gutter', side: 'r', at: 0.45, type: 'globular', size: 150, seed: 22 },

    { chapter: 'education', place: 'band', at: 0.78, type: 'mini', size: 80, seed: 31, phone: true },
    { chapter: 'education', place: 'band', at: 0.9, type: 'mini', size: 70, seed: 32 },
    { chapter: 'education', place: 'gutter', side: 'l', at: 0.5, type: 'star', size: 110, seed: 33, tint: 'teal' },

    { chapter: 'contact', place: 'band', at: 0.1, type: 'globular', size: 110, seed: 41, phone: true },
    { chapter: 'contact', place: 'gutter', side: 'r', at: 0.35, type: 'mini', size: 90, seed: 42 },
    { chapter: 'contact', place: 'gutter', side: 'l', at: 0.75, type: 'star', size: 100, seed: 43, tint: 'white' }
  ];

  var GUTTER_MIN = 120; // px of gutter before gutter objects appear

  /* ---------- Helpers (copied from home-galaxy.js; see the header) ---------- */

  function readRgb(name, fallback) {
    var raw = '';
    try {
      raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    } catch (e) { /* fall through */ }
    var parts = String(raw).split(',').map(function (s) { return parseInt(s, 10); });
    return parts.length === 3 && parts.every(function (n) { return n >= 0 && n <= 255; })
      ? parts
      : fallback;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeSprite(size, stops) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(function (s) { grad.addColorStop(s[0], s[1]); });
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function rgb(c) { return c[0] + ',' + c[1] + ',' + c[2]; }

  var SAGE = readRgb('--accent-rgb', [110, 138, 120]);
  var SAGE_SOFT = [142, 172, 152];
  var TEAL = readRgb('--galaxy-teal-rgb', [72, 190, 176]);
  var WARM = [226, 222, 208];
  var WHITE = [246, 247, 248];
  var TINTS = { warm: [236, 214, 176], teal: [196, 236, 230], white: WHITE };

  function halo(c, a) {
    return makeSprite(64, [
      [0, 'rgba(' + rgb(c) + ',' + a + ')'],
      [0.3, 'rgba(' + rgb(c) + ',' + (a * 0.3) + ')'],
      [1, 'rgba(' + rgb(c) + ',0)']
    ]);
  }

  /* ---------- Painting ---------- */

  // Draw a star: a square point, plus a soft halo if it is a bright one.
  function star(g, x, y, size, c, alpha, glow) {
    if (glow) {
      g.globalAlpha = alpha * 0.8;
      g.drawImage(halo(c, 0.6), x - glow / 2, y - glow / 2, glow, glow);
    }
    g.globalAlpha = alpha;
    g.fillStyle = 'rgb(' + rgb(c) + ')';
    g.fillRect(x - size / 2, y - size / 2, size, size);
  }

  // A sprinkle of faint background stars, so no object floats in a void.
  function field(g, rand, S, n) {
    for (var i = 0; i < n; i++) {
      star(g, rand() * S, rand() * S, 1, rand() < 0.5 ? SAGE : SAGE_SOFT, 0.12 + rand() * 0.2);
    }
  }

  function gauss(rand) {
    var u = 1 - rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  /*
   * An open cluster: a loose, irregular knot of young stars, mostly blue-white (teal
   * here), with a few bright members standing out. Minis are the same with fewer and
   * closer members, like the small associations dotted along a spiral arm.
   */
  function paintOpen(g, rand, S, mini) {
    var c = S / 2;
    field(g, rand, S, mini ? 8 : 16);
    var n = mini ? 9 + Math.floor(rand() * 7) : 22 + Math.floor(rand() * 14);
    var spread = S * (mini ? 0.13 : 0.17);
    // A slight elongation, since real open clusters are rarely round.
    var stretch = 0.7 + rand() * 0.6, tilt = rand() * Math.PI;
    for (var i = 0; i < n; i++) {
      var dx = gauss(rand) * spread * stretch, dy = gauss(rand) * spread / stretch;
      var x = c + dx * Math.cos(tilt) - dy * Math.sin(tilt);
      var y = c + dx * Math.sin(tilt) + dy * Math.cos(tilt);
      var q = rand();
      var col = q < 0.55 ? TEAL : (q < 0.85 ? SAGE_SOFT : WHITE);
      var bright = rand() < (mini ? 0.3 : 0.18);
      star(g, x, y, bright ? 2.4 : 1.6, col, bright ? 1 : 0.7 + rand() * 0.3, bright ? 16 : 0);
    }
  }

  /*
   * A globular cluster: hundreds of old stars on a Plummer profile, so the core is too
   * crowded to resolve and reads as a glow, while the outskirts break up into points.
   */
  function paintGlobular(g, rand, S) {
    var c = S / 2;
    field(g, rand, S, 12);
    var core = S * 0.045, limit = S * 0.46;

    g.globalAlpha = 0.55;
    var glow = makeSprite(128, [
      [0, 'rgba(' + rgb(WARM) + ',0.8)'],
      [0.2, 'rgba(' + rgb(WARM) + ',0.3)'],
      [0.6, 'rgba(' + rgb(SAGE) + ',0.06)'],
      [1, 'rgba(' + rgb(SAGE) + ',0)']
    ]);
    g.drawImage(glow, c - S * 0.3, c - S * 0.3, S * 0.6, S * 0.6);

    var n = 260 + Math.floor(rand() * 140);
    for (var i = 0; i < n; i++) {
      // Plummer radius, truncated at the edge of the canvas.
      var u = Math.max(1e-4, rand());
      var r = core / Math.sqrt(Math.pow(u, -2 / 3) - 1);
      if (r > limit) { i--; continue; }
      var a = rand() * Math.PI * 2;
      var col = rand() < 0.6 ? WARM : SAGE_SOFT;
      var bright = rand() < 0.04;
      star(g, c + r * Math.cos(a), c + r * Math.sin(a), bright ? 1.8 : 1.1, col,
        bright ? 0.9 : 0.35 + rand() * 0.4, bright ? 8 : 0);
    }
  }

  /*
   * A bright nearby star: saturated core, soft halo, and the four diffraction spikes a
   * reflecting telescope's secondary-mirror supports put on anything that bright.
   */
  function paintStar(g, rand, S, tint) {
    var c = S / 2;
    var col = TINTS[tint] || WHITE;
    field(g, rand, S, 10);

    g.globalAlpha = 0.5;
    g.drawImage(halo(col, 0.5), c - S * 0.28, c - S * 0.28, S * 0.56, S * 0.56);

    var len = S * 0.44;
    g.lineWidth = 1;
    [[1, 0], [0, 1]].forEach(function (d) {
      var grad = g.createLinearGradient(c - d[0] * len, c - d[1] * len, c + d[0] * len, c + d[1] * len);
      grad.addColorStop(0, 'rgba(' + rgb(col) + ',0)');
      grad.addColorStop(0.5, 'rgba(' + rgb(col) + ',0.75)');
      grad.addColorStop(1, 'rgba(' + rgb(col) + ',0)');
      g.globalAlpha = 1;
      g.strokeStyle = grad;
      g.beginPath();
      g.moveTo(c - d[0] * len, c - d[1] * len);
      g.lineTo(c + d[0] * len, c + d[1] * len);
      g.stroke();
    });

    g.globalAlpha = 1;
    g.drawImage(halo(WHITE, 1), c - 6, c - 6, 12, 12);
    g.fillStyle = 'rgb(' + rgb(WHITE) + ')';
    g.fillRect(c - 1.25, c - 1.25, 2.5, 2.5);
  }

  function paint(spec, size) {
    var cv = document.createElement('canvas');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = cv.height = Math.round(size * dpr);
    cv.className = 'sky-object';
    cv.setAttribute('aria-hidden', 'true');
    cv.style.width = cv.style.height = size + 'px';

    var g = cv.getContext('2d');
    if (!g) { return null; }
    g.scale(dpr, dpr);
    g.globalCompositeOperation = 'lighter';
    var rand = mulberry32(spec.seed * 7919);

    if (spec.type === 'globular') { paintGlobular(g, rand, size); }
    else if (spec.type === 'star') { paintStar(g, rand, size, spec.tint); }
    else { paintOpen(g, rand, size, spec.type === 'mini'); }
    return cv;
  }

  /* ---------- Placement ---------- */

  var placed = [];
  var observer = null;

  function clear() {
    placed.forEach(function (cv) { cv.remove(); });
    placed = [];
    if (observer) { observer.disconnect(); }
  }

  function layout() {
    clear();

    var phone = window.innerWidth < 700;
    if ('IntersectionObserver' in window && !reducedMotion) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('is-seen');
            observer.unobserve(e.target);
          }
        });
      }, { rootMargin: '0px 0px -10% 0px' });
    } else {
      observer = null;
    }

    SKY.forEach(function (spec) {
      if (phone && !spec.phone) { return; }
      var section = document.getElementById(spec.chapter);
      var wrap = section && section.querySelector(':scope > .wrap');
      if (!section || !wrap) { return; }
      section.classList.add('has-sky');

      var cs = getComputedStyle(wrap);
      var colLeft = wrap.offsetLeft + parseFloat(cs.paddingLeft);
      var colRight = wrap.offsetLeft + wrap.offsetWidth - parseFloat(cs.paddingRight);
      var gutter = wrap.offsetLeft; // the section spans the page; the wrap is centred
      var size, cv;

      if (spec.place === 'gutter') {
        if (phone || gutter < GUTTER_MIN) { return; }
        size = Math.min(spec.size, gutter - 24);
        cv = paint(spec, size);
        if (!cv) { return; }
        var x = spec.side === 'l'
          ? (gutter - size) / 2
          : wrap.offsetLeft + wrap.offsetWidth + (gutter - size) / 2;
        cv.style.left = x + 'px';
        cv.style.top = (spec.at * 100) + '%';
        cv.classList.add('is-gutter');
      } else {
        // The band is the chapter's padding-top; keep a little clear of both edges.
        var band = parseFloat(getComputedStyle(section).paddingTop);
        size = Math.min(phone ? spec.size * 0.8 : spec.size, band - 12);
        if (size < 40) { return; }
        cv = paint(spec, size);
        if (!cv) { return; }
        cv.style.left = (colLeft + spec.at * (colRight - colLeft - size)) + 'px';
        cv.classList.add('is-band');
      }

      section.appendChild(cv);
      placed.push(cv);
      if (observer) { observer.observe(cv); } else { cv.classList.add('is-seen'); }
    });
  }

  /* ---------- Boot ---------- */

  function start() {
    layout();

    // Placement depends on width only; a phone's URL bar changing the height is
    // absorbed by the CSS centring in the band.
    var lastWidth = window.innerWidth;
    var pending = null;
    window.addEventListener('resize', function () {
      if (window.innerWidth === lastWidth) { return; }
      lastWidth = window.innerWidth;
      window.clearTimeout(pending);
      pending = window.setTimeout(layout, 200);
    });
  }

  // Nothing here is urgent: wait for an idle moment after load.
  function defer() {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(start, { timeout: 2000 });
    } else {
      window.setTimeout(start, 200);
    }
  }

  if (document.readyState === 'complete') {
    defer();
  } else {
    window.addEventListener('load', defer);
  }
})();
