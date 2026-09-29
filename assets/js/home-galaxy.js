/*
 * jeremy.ie — the galaxy in the opening frame.
 *
 * A survey plot of a barred-spiral-ish disc: a few thousand stars on two logarithmic
 * arms around a warm bulge, drawn in the page's sage with a teal accent for the young
 * hot stars in the arms. A faint chart graticule (dashed rings, kpc labels) and a live
 * readout in the corner give it the look of an instrument display rather than a
 * screensaver.
 *
 * Everything moves on two clocks, and the pointer only ever touches the second.
 *
 * The first is the galaxy's own rotation: a slow, mildly differential spin (the inner
 * disc turns a little faster than the rim), which never stops and never needs the
 * pointer. The second is the viewing angle. Pointer y tips the disc toward or away
 * from the viewer, pointer x turns it a few degrees either way and rolls it a hair
 * about the line of sight. All three ease toward their targets, so a fast flick of the
 * mouse is a lazy drift on screen, and the whole range is small on purpose.
 *
 * About a hundred of the brighter stars are "catalogue" stars. Bring the pointer near
 * one and a reticle and a data card pick it out. The data is synthetic: it is dressed
 * as a survey catalogue but generated from a fixed seed, so a given star always shows
 * the same card and nobody should cite it.
 *
 * Cost: one pass over ~4,000 points to project them and one fillRect each, bucketed by
 * colour and brightness so fillStyle changes a dozen times a frame rather than four
 * thousand. That is well inside a frame on anything recent, and the loop degrades on
 * its own if it turns out not to be (see FRAME_BUDGET_MS).
 *
 * Loaded separately from home-coal.js on purpose, as its predecessor was: this is
 * decoration, and if it throws, the header, the nav, the reveals and the intro overlay
 * all have to carry on without it. All of it is hidden from assistive tech.
 */
(function () {
  'use strict';

  /* ---------- Tunables ---------- */

  // Overall opacity lives in CSS as --galaxy-strength; everything here shapes the disc.

  var STAR_COUNT = 4200;
  var STAR_COUNT_SMALL = 2400; // narrow screens: fewer points, same look at that size
  var NAMED_COUNT = 90; // stars that carry a hover card

  var BULGE_SHARE = 0.1; // fraction of stars in the central bulge
  var DISC_SHARE = 0.13; // fraction spread through the disc between the arms
  var GALAXY_KPC = 15; // what a radius of 1 stands for in the labels

  /*
   * Viewing geometry, in radians. BASE_TILT is the inclination from face-on: 0 is a
   * flat disc seen from above, pi/2 is edge-on. Around 1 rad shows the arms clearly
   * while still reading as a disc in space.
   */
  var BASE_TILT = 0.85;
  var TILT_RANGE = 0.16; // pointer y, either way from BASE_TILT
  var SPIN_RANGE = 0.34; // pointer x turns the disc this far either way (about 19 deg)
  var ROLL_RANGE = 0.09; // and rolls it this far about the line of sight

  // How quickly the view eases toward the pointer, per second.
  var EASE_RATE = 3.2;

  /*
   * Rotation speed in radians per second, with a mild falloff toward the rim. Full
   * differential rotation would wind the arms visibly tighter within a minute; this
   * keeps them coherent for as long as anyone reads a title page.
   */
  var SPIN_RATE = 0.012;
  var SHEAR = 0.6;

  // The build-up on load: the disc swells from 70% of its size and fades in.
  var REVEAL_MS = 2200;

  // How close the pointer has to be to a catalogue star to pick it out, in CSS pixels.
  var HOVER_RADIUS = 22;

  /*
   * If the smoothed frame time sits above this once the loop has warmed up, half of
   * the faintest stars stop being drawn. They are the least visible and the most
   * numerous, so it is the cheapest saving there is.
   */
  var FRAME_BUDGET_MS = 26;

  var MAX_PIXELS = 3500000;

  /* ---------- Colour ---------- */

  // Overridable from CSS so the palette stays in one place. Fallbacks match coal.css.
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

  var SAGE = readRgb('--accent-rgb', [110, 138, 120]);
  var SAGE_SOFT = [142, 172, 152];
  var TEAL = readRgb('--galaxy-teal-rgb', [72, 190, 176]);
  var WARM = [226, 222, 208];

  // Star colour classes. The index is what a star stores.
  var COLOURS = [SAGE, SAGE_SOFT, TEAL, WARM];
  var C_SAGE = 0, C_SOFT = 1, C_TEAL = 2, C_WARM = 3;

  // Brightness tiers: [size in px, alpha]. Tier 2 also gets a soft halo.
  var TIERS = [[1.1, 0.34], [1.5, 0.62], [2.2, 0.9]];

  function rgb(c) { return c[0] + ',' + c[1] + ',' + c[2]; }

  /* ---------- Setup ---------- */

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var canvas = document.getElementById('galaxy-canvas');
  var frame = canvas && canvas.closest('.opening');
  if (!canvas || !frame || !canvas.getContext) {
    return;
  }
  var ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  var card = frame.querySelector('.galaxy-card');
  var reticle = frame.querySelector('.galaxy-reticle');
  var hud = frame.querySelector('.galaxy-hud');
  var cardId = card && card.querySelector('.galaxy-card-id');
  var cardTag = card && card.querySelector('.galaxy-card-tag');
  var cardRows = card && card.querySelectorAll('.galaxy-card-row');

  /* ---------- Deterministic randomness ---------- */

  // Fixed seed: the same galaxy, and the same catalogue, on every load.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = mulberry32(19840611);

  function gauss() {
    var u = 1 - rand();
    var v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------- The galaxy ---------- */

  var count = 0;
  var rad, th0, zed, omega, colour, tier, arm; // per-star, typed arrays
  var px, py; // projected positions this frame, CSS pixels
  var buckets = []; // [colour * 3 + tier] -> Int32Array of star indices
  var named = []; // indices of catalogue stars
  var catalogue = {}; // index -> card data

  var CLASS_TEFF = {
    O9: 31500, B1: 25400, B3: 18700, B8: 12000, A0: 9700, A2: 8800,
    F5: 6500, F8: 6150, G0: 5930, G2: 5770, G8: 5350,
    K0: 5250, K1: 5080, K3: 4750, K5: 4400, K7: 4050, M0: 3850, M2: 3550
  };
  var CLASSES = {};
  CLASSES[C_TEAL] = ['O9', 'B1', 'B3', 'B8', 'A0', 'A2'];
  CLASSES[C_SAGE] = ['F5', 'F8', 'G0', 'G2', 'G8', 'K0'];
  CLASSES[C_SOFT] = ['G8', 'K1', 'K3', 'K5'];
  CLASSES[C_WARM] = ['K5', 'K7', 'M0', 'M2'];

  var ARM_NAMES = ['Perseus', 'Scutum–Centaurus'];

  function pick(list) {
    return list[Math.floor(rand() * list.length)];
  }

  function thousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function describe(i, serial) {
    var cls = pick(CLASSES[colour[i]]);
    var teff = CLASS_TEFF[cls];
    var hot = colour[i] === C_TEAL;
    var mag = (hot ? 7.6 : 9.4) + rand() * 4.2;
    var where;
    if (rad[i] < 0.16) {
      where = 'Bulge';
    } else if (arm[i] < 0) {
      where = 'Inter-arm';
    } else {
      where = ARM_NAMES[arm[i]] + ' arm';
    }
    return {
      id: 'SVY-' + String(1000 + ((serial * 613 + 271) % 9000)),
      cls: cls + ' V',
      teff: thousands(teff) + ' K',
      mag: 'V ' + mag.toFixed(1),
      radius: (rad[i] * GALAXY_KPC).toFixed(1) + ' kpc',
      where: where,
      hot: hot
    };
  }

  function generate(n) {
    count = n;
    rad = new Float32Array(n);
    th0 = new Float32Array(n);
    zed = new Float32Array(n);
    omega = new Float32Array(n);
    colour = new Uint8Array(n);
    tier = new Uint8Array(n);
    arm = new Int8Array(n);
    px = new Float32Array(n);
    py = new Float32Array(n);

    for (var i = 0; i < n; i++) {
      var r, theta, z, a = -1;
      var roll = rand();

      if (roll < BULGE_SHARE) {
        // Bulge: a round, dense knot with real vertical extent.
        r = Math.abs(gauss()) * 0.075;
        theta = rand() * Math.PI * 2;
        z = gauss() * 0.06;
      } else {
        // Exponential disc, clipped to the frame of the plot.
        do {
          r = -Math.log(1 - rand()) * 0.3 + 0.04;
        } while (r > 1);

        if (roll < BULGE_SHARE + DISC_SHARE) {
          theta = rand() * Math.PI * 2;
        } else {
          // Logarithmic spiral. Scatter is roughly constant across the arm, so it is
          // a wide angle near the centre and a tight one at the rim.
          a = rand() < 0.5 ? 0 : 1;
          var spread = Math.min(0.8, 0.04 / Math.max(r, 0.06) + 0.07);
          theta = a * Math.PI + 2.9 * Math.log(1 + 6 * r) + gauss() * spread;
        }
        z = gauss() * 0.022 * (1 + (1 - r) * 0.8);
      }

      rad[i] = r;
      th0[i] = theta;
      zed[i] = z;
      arm[i] = a;
      omega[i] = SPIN_RATE * Math.max(0.35, 1.3 - SHEAR * r);

      // Colour: the bulge is old and warm, the arms carry the young hot stars.
      var c;
      var q = rand();
      if (r < 0.2 && a < 0) {
        c = q < 0.7 ? C_WARM : C_SOFT;
      } else if (a >= 0 && r > 0.22 && q < 0.24) {
        c = C_TEAL;
      } else {
        c = q < 0.6 ? C_SAGE : C_SOFT;
      }
      colour[i] = c;

      var b = rand();
      // The core is crowded, so it is kept dimmer or it clips to a white blob.
      // Arm stars run a little brighter, which is what makes the arms read as arms.
      var lift = a >= 0 ? 0.06 : 0;
      tier[i] = r < 0.12
        ? (b < 0.97 ? 0 : 1)
        : (b < 0.78 - lift ? 0 : (b < 0.95 - lift * 0.5 ? 1 : 2));
    }

    // Bucket by colour and tier so the draw loop changes fillStyle once per bucket.
    var lists = [];
    var b2;
    for (b2 = 0; b2 < COLOURS.length * 3; b2++) {
      lists.push([]);
    }
    for (i = 0; i < n; i++) {
      lists[colour[i] * 3 + tier[i]].push(i);
    }
    buckets = lists.map(function (l) { return Int32Array.from(l); });

    // Catalogue stars: bright ones that are not buried in the core.
    var pool = [];
    for (i = 0; i < n; i++) {
      if (tier[i] >= 1 && rad[i] > 0.12 && rad[i] < 0.96) {
        pool.push(i);
      }
    }
    // Deterministic shuffle, then take the first NAMED_COUNT.
    for (i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    named = pool.slice(0, NAMED_COUNT);
    catalogue = {};
    named.forEach(function (idx, serial) {
      catalogue[idx] = describe(idx, serial);
      // Named stars are drawn at full tier so there is always something to point at.
      tier[idx] = Math.max(tier[idx], 1);
    });
  }

  /* ---------- Sprites ---------- */

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

  var haloSprites = [];
  var coreSprite, hazeSprite;

  function buildSprites() {
    haloSprites = COLOURS.map(function (c) {
      return makeSprite(32, [
        [0, 'rgba(' + rgb(c) + ',0.55)'],
        [0.35, 'rgba(' + rgb(c) + ',0.16)'],
        [1, 'rgba(' + rgb(c) + ',0)']
      ]);
    });
    coreSprite = makeSprite(256, [
      [0, 'rgba(' + rgb(WARM) + ',0.42)'],
      [0.18, 'rgba(' + rgb(WARM) + ',0.18)'],
      [0.55, 'rgba(' + rgb(SAGE) + ',0.08)'],
      [1, 'rgba(' + rgb(SAGE) + ',0)']
    ]);
    hazeSprite = makeSprite(256, [
      [0, 'rgba(' + rgb(SAGE) + ',0.16)'],
      [0.6, 'rgba(' + rgb(SAGE) + ',0.05)'],
      [1, 'rgba(' + rgb(SAGE) + ',0)']
    ]);
  }

  /* ---------- Sizing ---------- */

  var w = 0, h = 0, dpr = 1;
  var cx = 0, cy = 0, R = 0;
  var narrow = false;

  function resize() {
    var rect = frame.getBoundingClientRect();
    w = Math.max(1, Math.round(rect.width));
    h = Math.max(1, Math.round(rect.height));

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    while (dpr > 1 && w * h * dpr * dpr > MAX_PIXELS) {
      dpr -= 0.25;
    }
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    var wasNarrow = narrow;
    narrow = w < 700;

    if (w >= 900) {
      cx = w * 0.7; cy = h * 0.52; R = Math.min(w * 0.32, h * 0.55);
    } else if (!narrow) {
      cx = w * 0.62; cy = h * 0.56; R = Math.min(w * 0.4, h * 0.5);
    } else {
      cx = w * 0.5; cy = h * 0.72; R = Math.min(w * 0.55, h * 0.3);
    }

    // Crossing the phone breakpoint changes how many stars the plot wants.
    if (!count || wasNarrow !== narrow) {
      rand = mulberry32(19840611);
      generate(narrow ? STAR_COUNT_SMALL : STAR_COUNT);
      hovered = -1;
      hideCard();
    }
  }

  /* ---------- Projection ---------- */

  var cT = 1, sT = 0, cRl = 1, sRl = 0, scale = 1;
  var projX = 0, projY = 0;

  function setView(tilt, roll, size) {
    cT = Math.cos(tilt); sT = Math.sin(tilt);
    cRl = Math.cos(roll); sRl = Math.sin(roll);
    scale = size;
  }

  // Disc coordinates (x, y in the plane, z up) to screen, through tilt then roll.
  function project(x, y, z) {
    var yp = y * cT - z * sT;
    var zp = y * sT + z * cT;
    var rx = x * cRl - yp * sRl;
    var ry = x * sRl + yp * cRl;
    var persp = 1 + zp * 0.22; // mild: the near side is a touch larger
    projX = cx + rx * persp * scale;
    projY = cy + ry * persp * scale;
  }

  /* ---------- Drawing ---------- */

  var clock = 0; // the galaxy's own rotation, seconds
  var revealMs = 0;
  var spin = 0, tiltOff = 0, roll = 0; // eased view
  var spinTarget = 0, tiltTarget = 0, rollTarget = 0;
  var lastHud = 0;
  var skipFaint = false;

  function easeOut(t) {
    t = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - t, 3);
  }

  function render(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var rev = reducedMotion ? 1 : easeOut(revealMs / REVEAL_MS);
    var tilt = BASE_TILT + tiltOff;
    setView(tilt, roll, R * (0.7 + 0.3 * rev));

    ctx.globalCompositeOperation = 'lighter';

    // Haze and core. Both are squashed and turned with the disc.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(roll);
    ctx.scale(1, cT);
    ctx.globalAlpha = rev;
    var hz = scale * 2.3;
    ctx.drawImage(hazeSprite, -hz / 2, -hz / 2, hz, hz);
    var cs = scale * 0.95;
    ctx.drawImage(coreSprite, -cs / 2, -cs / 2, cs, cs);
    ctx.restore();

    drawGraticule(rev);

    // Project every star once, then draw them a bucket at a time.
    var a0 = clock, i, a, r, x, y;
    for (i = 0; i < count; i++) {
      r = rad[i];
      a = th0[i] + omega[i] * a0 + spin;
      x = r * Math.cos(a);
      y = r * Math.sin(a);
      project(x, y, zed[i]);
      px[i] = projX;
      py[i] = projY;
    }

    var b, list, n, size, half, k, alpha;
    for (b = 0; b < buckets.length; b++) {
      list = buckets[b];
      n = list.length;
      if (!n) { continue; }
      var t = b % 3;
      size = TIERS[t][0];
      half = size / 2;
      alpha = TIERS[t][1] * rev;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgb(' + rgb(COLOURS[(b / 3) | 0]) + ')';
      var step = t === 0 && skipFaint ? 2 : 1;
      for (k = 0; k < n; k += step) {
        i = list[k];
        ctx.fillRect(px[i] - half, py[i] - half, size, size);
      }
    }

    // Soft halos on the brightest stars and the catalogue.
    ctx.globalAlpha = 0.85 * rev;
    for (b = 0; b < buckets.length; b++) {
      if (b % 3 !== 2) { continue; }
      list = buckets[b];
      var sprite = haloSprites[(b / 3) | 0];
      for (k = 0; k < list.length; k++) {
        i = list[k];
        ctx.drawImage(sprite, px[i] - 8, py[i] - 8, 16, 16);
      }
    }
    ctx.globalAlpha = 0.6 * rev;
    for (k = 0; k < named.length; k++) {
      i = named[k];
      ctx.drawImage(haloSprites[colour[i]], px[i] - 7, py[i] - 7, 14, 14);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    updateHover();
    updateHud(now);
  }

  var KPC_LABELS = [1 / 3, 2 / 3, 1];

  function drawGraticule(rev) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(' + rgb(SAGE) + ',' + (0.16 * rev).toFixed(3) + ')';
    ctx.fillStyle = 'rgba(' + rgb(SAGE_SOFT) + ',' + (0.5 * rev).toFixed(3) + ')';
    ctx.setLineDash([2, 7]);
    ctx.font = '9px "Chivo Mono", "Courier New", monospace';
    ctx.textBaseline = 'middle';

    var s, j, ang;
    for (s = 0; s < KPC_LABELS.length; s++) {
      var rr = KPC_LABELS[s];
      ctx.beginPath();
      for (j = 0; j <= 96; j++) {
        ang = (j / 96) * Math.PI * 2;
        project(rr * Math.cos(ang), rr * Math.sin(ang), 0);
        if (j === 0) { ctx.moveTo(projX, projY); } else { ctx.lineTo(projX, projY); }
      }
      ctx.stroke();
    }

    // Labels sit on a fixed bearing in the disc, so they tip with it but do not spin.
    ctx.setLineDash([]);
    for (s = 0; s < KPC_LABELS.length; s++) {
      var rl = KPC_LABELS[s];
      project(rl * Math.cos(-0.75), rl * Math.sin(-0.75), 0);
      ctx.fillText(Math.round(rl * GALAXY_KPC) + ' kpc', projX + 6, projY);
    }
    ctx.restore();
  }

  /* ---------- Hover ---------- */

  var pointerX = -1, pointerY = -1, pointerIn = false;
  var hovered = -1;
  var cardW = 0, cardH = 0;

  function eligible(i) {
    // Stars behind the headline are dimmed by the mask; do not offer cards there.
    return narrow || px[i] >= w * 0.34;
  }

  function nearest() {
    var limit = HOVER_RADIUS * HOVER_RADIUS;
    var best = -1;
    var bestD = limit;
    var i, dx, dy, d;

    // Hysteresis: hold the current star until the pointer is clearly off it.
    if (hovered >= 0) {
      dx = px[hovered] - pointerX;
      dy = py[hovered] - pointerY;
      if (dx * dx + dy * dy <= limit * 2.2) {
        return hovered;
      }
    }
    for (var k = 0; k < named.length; k++) {
      i = named[k];
      if (!eligible(i)) { continue; }
      dx = px[i] - pointerX;
      dy = py[i] - pointerY;
      d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function showCard(i) {
    var data = catalogue[i];
    if (!data || !card) { return; }
    cardId.textContent = data.id;
    cardTag.textContent = data.hot ? 'Young / hot' : 'Field';
    card.classList.toggle('is-hot', data.hot);
    reticle.classList.toggle('is-hot', data.hot);
    cardRows[0].textContent = data.cls + ' · ' + data.teff;
    cardRows[1].textContent = data.mag + ' · R ' + data.radius;
    cardRows[2].textContent = data.where;
    card.classList.add('is-on');
    reticle.classList.add('is-on');
    cardW = card.offsetWidth;
    cardH = card.offsetHeight;
  }

  function hideCard() {
    if (!card) { return; }
    card.classList.remove('is-on');
    reticle.classList.remove('is-on');
  }

  function updateHover() {
    if (!card) { return; }
    var next = pointerIn ? nearest() : -1;
    if (next !== hovered) {
      hovered = next;
      if (hovered >= 0) { showCard(hovered); } else { hideCard(); }
    }
    if (hovered < 0) { return; }

    var sx = px[hovered];
    var sy = py[hovered];
    reticle.style.transform = 'translate3d(' + (sx - 11).toFixed(1) + 'px,' + (sy - 11).toFixed(1) + 'px,0)';

    // Sit to the right of the star, flipping to the left near the edge.
    var cxp = sx + 20;
    if (cxp + cardW > w - 12) { cxp = sx - 20 - cardW; }
    var cyp = Math.min(Math.max(12, sy - cardH / 2), h - cardH - 12);
    card.style.transform = 'translate3d(' + cxp.toFixed(1) + 'px,' + cyp.toFixed(1) + 'px,0)';
  }

  /* ---------- Readout ---------- */

  function signed(deg) {
    return (deg >= 0 ? '+' : '−') + Math.abs(deg).toFixed(1) + '°';
  }

  function updateHud(now) {
    if (!hud) { return; }
    // Text changes ~7 times a second at most; anything faster is unreadable anyway.
    if (now && now - lastHud < 140) { return; }
    lastHud = now || 0;
    hud.textContent =
      'INCL ' + ((BASE_TILT + tiltOff) * 180 / Math.PI).toFixed(1) + '°'
      + '  ·  PA ' + signed(spin * 180 / Math.PI)
      + '  ·  N ' + thousands(count);
  }

  /* ---------- Loop ---------- */

  var running = false;
  var visible = true;
  var lastTime = 0;
  var frames = 0;
  var smoothed = 16;

  function tick(now) {
    if (!running) { return; }

    var dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 1 / 60;
    lastTime = now;

    clock += dt;
    revealMs += dt * 1000;

    var k = 1 - Math.exp(-EASE_RATE * dt);
    spin += (spinTarget - spin) * k;
    tiltOff += (tiltTarget - tiltOff) * k;
    roll += (rollTarget - roll) * k;

    var t0 = performance.now();
    render(now);

    // Warm up before judging, then drop the faintest half once if it is struggling.
    smoothed += ((performance.now() - t0) - smoothed) * 0.05;
    frames++;
    if (!skipFaint && frames > 90 && smoothed > FRAME_BUDGET_MS) {
      skipFaint = true;
    }

    requestAnimationFrame(tick);
  }

  function start() {
    if (running || reducedMotion) { return; }
    running = true;
    lastTime = 0;
    requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
  }

  /* ---------- Pointer ---------- */

  function clear() {
    pointerIn = false;
    if (reducedMotion) {
      updateHover();
    }
  }

  function onPointer(event) {
    // The listener is on the window, so ignore it while the frame is scrolled away.
    if (!visible) { return; }

    var rect = frame.getBoundingClientRect();
    if (rect.height <= 0) { return; }

    var nx = (event.clientX - rect.left) / rect.width;
    var ny = (event.clientY - rect.top) / rect.height;
    var touch = event.pointerType === 'touch';

    if (!touch) {
      // Clamped: past the edge of the frame the view holds at its limit.
      var ux = Math.max(-1, Math.min(1, (nx - 0.5) * 2));
      var uy = Math.max(-1, Math.min(1, (ny - 0.5) * 2));
      spinTarget = ux * SPIN_RANGE;
      rollTarget = ux * ROLL_RANGE;
      tiltTarget = uy * TILT_RANGE;
    }

    pointerX = event.clientX - rect.left;
    pointerY = event.clientY - rect.top;

    // Links, buttons and the header are not part of the plot.
    var target = event.target;
    var overUi = target && target.closest && target.closest('a, button, nav, header');
    pointerIn = !overUi && nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;

    if (reducedMotion) {
      // No loop running: positions are from the last (only) render, so just re-pick.
      updateHover();
    }
  }

  function onLeave() {
    pointerIn = false;
    spinTarget = tiltTarget = rollTarget = 0;
    if (reducedMotion) { updateHover(); }
  }

  /* ---------- Boot ---------- */

  function build() {
    buildSprites();
    resize();

    if (reducedMotion) {
      // One finished frame: no loop, no drift, and the view stays at its default.
      render(0);
      frame.classList.add('is-ready');
      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('pointerdown', onPointer, { passive: true });
      document.documentElement.addEventListener('mouseleave', onLeave);
    } else {
      render(0);
      frame.classList.add('is-ready');

      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) {
          visible = entries[0].isIntersecting;
          if (visible) { start(); } else { stop(); }
        }).observe(frame);
      } else {
        start();
      }

      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('pointerdown', onPointer, { passive: true });
      document.documentElement.addEventListener('mouseleave', onLeave);
    }

    /*
     * Only a width change or a big height change is worth reacting to. On a phone the
     * URL bar collapsing changes 100svh constantly.
     */
    var lastWidth = window.innerWidth;
    var lastHeight = window.innerHeight;
    var pending = null;

    window.addEventListener('resize', function () {
      var dw = window.innerWidth !== lastWidth;
      var dh = Math.abs(window.innerHeight - lastHeight) > 180;
      if (!dw && !dh) { return; }
      lastWidth = window.innerWidth;
      lastHeight = window.innerHeight;

      window.clearTimeout(pending);
      pending = window.setTimeout(function () {
        resize();
        if (reducedMotion) { render(0); }
      }, 150);
    });
  }

  // Deferred past first paint: nothing is waiting for it and the intro overlay is up.
  function defer() {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(build, { timeout: 1200 });
    } else {
      window.setTimeout(build, 0);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', defer);
  } else {
    defer();
  }
})();
