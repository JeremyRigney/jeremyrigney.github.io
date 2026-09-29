/*
 * jeremy.ie/galaxy — the model.
 *
 * The same galaxy as the homepage hero (assets/js/home-galaxy.js), built out in three
 * dimensions for a page where it can be turned to any angle and looked at closely.
 * This file is data only: no DOM, no WebGL. It says where every star is and what it
 * physically is (its temperature, its brightness). It never says what colour anything
 * is drawn in, because that depends on the band being looked at (galaxy-bands.js),
 * and the renderer (galaxy-view.js) only ever connects the two.
 *
 * The physics is the hero's:
 *
 *   - A flat rotation curve, v(r) = V_FLAT * r / sqrt(r^2 + R_CORE^2). The core turns
 *     like a solid body and the rest shears.
 *   - Spiral arms that are a density wave, turning rigidly at the pattern speed of the
 *     corotation radius, with stars streaming through them. The arms trail.
 *   - Old stars are brightest on the crest and faint between the arms, but never
 *     gone. Young hot stars light only on the crest, because they live and die within
 *     one arm crossing.
 *
 * THE TUNABLES BELOW MUST STAY IN STEP WITH home-galaxy.js. They are copied rather than
 * shared so the hero, which is tuned by eye as a Canvas 2D plot, is never disturbed by
 * a change made for this page.
 *
 * What this page adds, because it can be turned and zoomed:
 *
 *   - Crowding. In a real density wave the arms are not only brighter but denser: a
 *     star slows as it climbs into the crest and speeds up leaving it, so stars pile
 *     up there like traffic at a bottleneck. Each star's phase against the wave is
 *     remapped so it spends longer near the crest (see "jam" below). The hero only
 *     lights its stars by the wave; here they gather too.
 *   - A disc that thins out rather than stops: exponential, with a soft taper past
 *     the old edge instead of a clip at radius 1.
 *   - Depth: a thin disc and a thicker, older one; a disc that flares and bends (a
 *     gentle warp, which most spiral discs have) past the old edge; a round bulge; a
 *     sparse stellar halo on orbits in every plane.
 *   - Company: two small satellite galaxies on orbits of their own, and far behind
 *     everything a field of distant galaxies, for a sense of how far away the rest of
 *     the universe is.
 *   - Dust, as numbers rather than points: DUST describes a thin layer in the midplane,
 *     densest in lanes on the inner edge of each arm, and the renderer works out how
 *     much of it lies between the camera and each star.
 *   - Faint stars that only come out as the view zooms in, as a longer exposure would
 *     show them.
 *
 * Every point carries three vec4s, the same layout for every population, so one shader
 * program draws them all:
 *
 *   orbit  disc:  r, theta0, z, phase0      (phase0 = angle against the arm crest)
 *          halo:  r, theta0, incl, node      (r < 0 for a retrograde orbit)
 *          sky:   direction x, y, z, 0       (stars and distant galaxies alike)
 *   phys   teff (K), brightness (0-1), light-up threshold, floor (brightness off-arm)
 *          distant galaxies: teff, brightness, axis ratio, nucleus (0-1)
 *   extra  offset x, y, z (a star's place in its satellite galaxy), size (CSS px)
 *          distant galaxies: the major axis as a direction on the sky, size
 */
window.GalaxyModel = (function () {
  'use strict';

  /* ---------- Tunables shared with home-galaxy.js ---------- */

  var P = {
    V_FLAT_KMS: 220,
    V_ROT: 0.02, // rad/s at r = 1, at the flat part of the curve
    R_CORE: 0.15, // where the curve turns over, in units of the disc radius
    CO_RADIUS: 0.6, // corotation: the radius that turns at the pattern speed
    ARM_WINDING: 2.9, // how tightly the logarithmic spiral is wound
    ARM_SHARP: 4.5, // how narrow the crest is
    INTERARM: 0.05, // share of the disc that stays lit between the arms
    GALAXY_KPC: 15, // what a radius of 1 stands for
    SEED: 19840611
  };

  /* ---------- This page's own ---------- */

  /*
   * Crowding into the arms. A star's phase against the wave, psi, is drawn at
   * psi - (jam / 2) * sin(2 psi): it lingers on the crest and hurries between arms.
   * The density on the crest is then 1 / (1 - jam) of the average and between the
   * arms 1 / (1 + jam), so 0.42 is about 2.4 times denser on the crest than between.
   * Old stars respond mildly; young stars (and the gas they formed from) sharply.
   */
  var JAM_OLD = 0.42;
  var JAM_YOUNG = 0.6;

  /*
   * The warp: past WARP_R0 the disc bends up on one side and down on the other, up to
   * WARP_AMP (about 1.4 kpc) by WARP_R1. It is fixed in space and the stars orbit
   * through it, as the Milky Way's do through its own.
   */
  var WARP = { amp: 0.09, r0: 0.8, r1: 1.6, node: 0.9 };

  /*
   * The dust layer. tau is the optical depth straight through it, face-on, on a lane
   * at radius 0; the lanes sit `lead` radians of phase upstream of the stellar crest,
   * on the side gas enters the arm from (inside corotation, where gas overtakes the
   * pattern; the other side outside it; neither near it), and are `sharp` narrower
   * than the arms. scale is its exponential radius; inner and outer where it ends.
   */
  var DUST = { tau: 1.2, lead: 0.2, sharp: 6, scale: 0.45, inner: 0.07, outer: 1.3 };

  /*
   * The stellar disc: the hero's exponential (scale 0.55 from 0.05), but tapering off
   * past `edge` over about `taper` instead of stopping dead at radius 1.
   */
  var DISC = { scale: 0.55, min: 0.05, edge: 0.92, taper: 0.3, max: 1.8 };

  /*
   * Counts, desktop and phone. About a third of the disc is lit at full strength at
   * any moment and only a fraction of the young stars (the ones on a crest), so what
   * reads on screen is far fewer. The faint population is only drawn zoomed in.
   */
  var COUNTS = {
    disc: [23000, 10200],
    faint: [40500, 15800],
    young: [10000, 5100],
    bulge: [1800, 600],
    halo: [900, 450],
    // Both of these cover the whole sphere, and the view only ever sees a few percent
    // of it: 3,000 distant galaxies is about a hundred on screen.
    sky: [2400, 1300],
    distant: [3000, 1600]
  };

  /*
   * The two satellites, placed so that both are in the opening view on a desktop,
   * one either side above the disc (both a little behind it). `at` is where each
   * starts, in disc radii; `incl` tips its orbit out of the disc's plane, and `dir`
   * is which way round it goes. Their orbits are at the rotation curve's speed, as
   * everything else's is, so the outer one takes about ten minutes a lap.
   *
   *   dE    a compact dwarf elliptical, as M32 is to Andromeda: old, round and dense.
   *   dIrr  a dwarf irregular, as the Magellanic Clouds are to the Milky Way: looser,
   *         lopsided along a short bar, and still forming stars.
   */
  var SATELLITES = [
    { kind: 'dE', stars: [900, 450], at: [1.1, -1.04, -0.14], incl: 0.95, dir: 1,
      size: [0.04, 0.04, 0.03], turn: [0.4, 0.9, 0.2], young: 0 },
    { kind: 'dIrr', stars: [1400, 700], at: [-1.08, -1.4, -0.07], incl: 2.1, dir: -1,
      size: [0.095, 0.036, 0.03], turn: [0.2, 0, 0.35], young: 0.22 }
  ];

  var NAMED_DISC = 110; // catalogue stars that carry a hover card
  var NAMED_YOUNG = 40;

  var ARM_NAMES = ['N', 'S']; // as home-galaxy.js: by the side of the nucleus

  /* ---------- Deterministic randomness ---------- */

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = mulberry32(P.SEED);

  function gauss() {
    var u = 1 - rand();
    var v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function between(a, b) {
    return a + (b - a) * rand();
  }

  function pick(list) {
    return list[Math.floor(rand() * list.length)];
  }

  /* ---------- The rotation curve and the wave (as home-galaxy.js) ---------- */

  function circularKms(r) {
    return P.V_FLAT_KMS * r / Math.sqrt(r * r + P.R_CORE * P.R_CORE);
  }

  function angularSpeed(r) {
    return P.V_ROT / Math.sqrt(r * r + P.R_CORE * P.R_CORE);
  }

  // The crest of arm 0 at radius r. Decreasing outward, so the arms trail.
  function crestAngle(r) {
    return -P.ARM_WINDING * Math.log(1 + 6 * r);
  }

  var PATTERN_SPEED = angularSpeed(P.CO_RADIUS);

  function crest(phase) {
    return P.INTERARM + (1 - P.INTERARM)
      * Math.exp(P.ARM_SHARP * (Math.cos(2 * phase) - 1));
  }

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function warpZ(r, a) {
    return WARP.amp * smoothstep(WARP.r0, WARP.r1, r) * Math.sin(a - WARP.node);
  }

  /* ---------- Star classes (as home-galaxy.js) ---------- */

  var CLASS_TEFF = {
    O9: 31500, B1: 25400, B3: 18700, B8: 12000, A0: 9700, A2: 8800,
    F5: 6500, F8: 6150, G0: 5930, G2: 5770, G8: 5350,
    K0: 5250, K1: 5080, K3: 4750, K5: 4400, K7: 4050, M0: 3850, M2: 3550
  };

  // The hero's four colour classes, as the spectral types they stand for.
  var CLASSES = {
    hot: ['O9', 'B1', 'B3', 'B8', 'A0', 'A2'],
    field: ['F5', 'F8', 'G0', 'G2', 'G8', 'K0'],
    soft: ['G8', 'K1', 'K3', 'K5'],
    warm: ['K5', 'K7', 'M0', 'M2']
  };

  function classTeff(kind) {
    return CLASS_TEFF[pick(CLASSES[kind])];
  }

  /*
   * Brightness tiers, as the hero's: [size in CSS px, brightness]. The top tier also
   * gets a soft halo when lit. The core is crowded, so it is kept dimmer or it clips.
   */
  var TIERS = [[1.2, 0.46], [1.6, 0.7], [2.3, 0.92]];

  function tier(r) {
    var b = rand();
    if (r < 0.12) { return b < 0.97 ? 0 : 1; }
    return b < 0.78 ? 0 : (b < 0.95 ? 1 : 2);
  }

  /* ---------- Populations ---------- */

  function Population(name, n, render) {
    this.name = name;
    this.count = n;
    this.orbit = new Float32Array(n * 4);
    this.phys = new Float32Array(n * 4);
    this.extra = new Float32Array(n * 4);
    /*
     * How the renderer moves a point of this population, independent of band:
     *   mode    0 disc orbit, 1 orbit in its own plane (halo, satellites), 2 a star at
     *           infinity, 4 a distant galaxy at infinity
     *   jam     how strongly it crowds into the arms (disc orbits only)
     *   reveal  [from, to]: fades in between these zooms, if given
     */
    this.render = render;
  }

  Population.prototype.set = function (i, o0, o1, o2, o3, teff, lum, thr, floor, e0, e1, e2, size) {
    var k = i * 4;
    this.orbit[k] = o0; this.orbit[k + 1] = o1; this.orbit[k + 2] = o2; this.orbit[k + 3] = o3;
    this.phys[k] = teff; this.phys[k + 1] = lum; this.phys[k + 2] = thr; this.phys[k + 3] = floor;
    this.extra[k] = e0; this.extra[k + 1] = e1; this.extra[k + 2] = e2; this.extra[k + 3] = size;
  };

  // A disc point: an orbit on the rotation curve, lit by the wave.
  function discPoint(pop, i, r, z, teff, lum, thr, floor, size) {
    var theta = rand() * Math.PI * 2;
    pop.set(i, r, theta, z, theta - crestAngle(r), teff, lum, thr, floor, 0, 0, 0, size);
  }

  /*
   * An exponential radius that thins out past `edge` instead of stopping there: beyond
   * it, a star is kept with a probability that falls off as a Gaussian in the overshoot.
   */
  function discRadius(scale, min, edge, taper, max) {
    for (;;) {
      var r = -Math.log(1 - rand()) * scale + min;
      if (r > max) { continue; }
      if (r > edge) {
        var t = (r - edge) / taper;
        if (rand() > Math.exp(-t * t)) { continue; }
      }
      return r;
    }
  }

  /*
   * Height above the midplane. A thin disc, a little thicker toward the bulge (as the
   * hero's), flaring past the edge where the disc's own gravity no longer holds it
   * flat; and one star in ten in the thick disc, older and puffier.
   */
  function discZ(r, h) {
    var s = rand() < 0.1 ? 0.055 : h * (1 + (1 - Math.min(r, 1)) * 0.6);
    return gauss() * s * (1 + 1.8 * Math.max(0, r - 0.9));
  }

  function makeDisc(n) {
    var pop = new Population('disc', n, { mode: 0, jam: JAM_OLD });
    for (var i = 0; i < n; i++) {
      var r = discRadius(DISC.scale, DISC.min, DISC.edge, DISC.taper, DISC.max);
      var q = rand();
      // As the hero: the inner disc is old and warm, the rest sage and soft.
      var teff = r < 0.14 ? classTeff(q < 0.7 ? 'warm' : 'soft')
        : classTeff(q < 0.6 ? 'field' : 'soft');
      var t = TIERS[tier(r)];
      discPoint(pop, i, r, discZ(r, 0.02), teff, t[1], rand(), 0.1, t[0]);
    }
    return pop;
  }

  // Stars too faint to show until the view is zoomed in: the same disc, sampled deeper.
  function makeFaint(n) {
    var pop = new Population('faint', n, { mode: 0, jam: JAM_OLD, reveal: [1.25, 2.6] });
    for (var i = 0; i < n; i++) {
      var r = discRadius(DISC.scale, DISC.min, DISC.edge, DISC.taper, DISC.max);
      var q = rand();
      var teff = r < 0.14 ? classTeff(q < 0.7 ? 'warm' : 'soft')
        : classTeff(q < 0.5 ? 'field' : q < 0.85 ? 'soft' : 'warm');
      discPoint(pop, i, r, discZ(r, 0.02), teff, between(0.26, 0.42), rand(), 0.12, 0.9);
    }
    return pop;
  }

  function makeYoung(n) {
    var pop = new Population('young', n, { mode: 0, jam: JAM_YOUNG });
    for (var i = 0; i < n; i++) {
      // As the hero: none in the core. Their disc also ends sooner than the old one.
      var r = discRadius(0.5, 0.2, 1.0, 0.25, 1.6);
      var z = gauss() * 0.008 * (1 + 1.8 * Math.max(0, r - 0.9));
      var t = TIERS[tier(r)];
      discPoint(pop, i, r, z, classTeff('hot'), t[1], 0.5 + rand() * 0.5, 0, t[0]);
    }
    return pop;
  }

  function makeBulge(n) {
    var pop = new Population('bulge', n, { mode: 0, jam: 0 });
    for (var i = 0; i < n; i++) {
      // As the hero: a round, dense knot with real vertical extent, always lit.
      var r = Math.abs(gauss()) * 0.075;
      var z = gauss() * 0.06;
      var t = TIERS[tier(r)];
      discPoint(pop, i, r, z, classTeff(rand() < 0.7 ? 'warm' : 'soft'), t[1], -1, 1, t[0]);
    }
    return pop;
  }

  /*
   * The stellar halo: a thin spray of old stars on orbits in every plane, falling off
   * as a power of radius. Few, and faint, but it is what makes the space around the
   * disc read as a volume once the disc is turned.
   */
  function makeHalo(n) {
    var pop = new Population('halo', n, { mode: 1 });
    for (var i = 0; i < n; i++) {
      var r;
      do { r = 0.12 * Math.pow(1 - rand(), -0.9); } while (r > 1.9);
      pop.set(i, rand() < 0.5 ? r : -r, rand() * Math.PI * 2, Math.acos(2 * rand() - 1),
        rand() * Math.PI * 2, classTeff(rand() < 0.6 ? 'warm' : 'soft'),
        between(0.3, 0.46), -1, 1, 0, 0, 0, 1.1);
    }
    return pop;
  }

  /*
   * The orbit, in the shader's terms (radius, starting angle, inclination, node), that
   * passes through the point p at t = 0 with the given inclination.
   */
  function orbitThrough(p, incl) {
    var r = Math.hypot(p[0], p[1], p[2]);
    var si = Math.sin(incl);
    var a = Math.asin(Math.max(-1, Math.min(1, p[2] / (r * si))));
    var node = Math.atan2(p[1], p[0]) - Math.atan2(r * Math.sin(a) * Math.cos(incl), r * Math.cos(a));
    return { r: r, theta: a, node: node };
  }

  /*
   * The satellite galaxies. Each is a cloud of stars moving as one on its orbit round
   * the host: a squashed Gaussian, turned by `turn` (three angles, about x, y and z)
   * so the irregular's bar lies across the opening view rather than end-on. Dwarf
   * galaxies like these hold together by the random motions of their stars rather
   * than by rotating, so the cloud keeps its shape and only its place changes.
   */
  function makeSatellites(small) {
    var s = small ? 1 : 0;
    var n = 0;
    SATELLITES.forEach(function (g) { n += g.stars[s]; });
    var pop = new Population('satellites', n, { mode: 1 });
    var i = 0;
    SATELLITES.forEach(function (g) {
      var o = orbitThrough(g.at, g.incl);
      var ax = g.turn[0], ay = g.turn[1], az = g.turn[2];
      var cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
      var cz = Math.cos(az), sz = Math.sin(az);
      for (var k = 0; k < g.stars[s]; k++, i++) {
        var x = gauss() * g.size[0], y = gauss() * g.size[1], z = gauss() * g.size[2];
        if (g.kind === 'dIrr' && rand() < 0.3) {
          // Lopsided: a second, looser knot off one end of the bar.
          x = g.size[0] * 1.3 + gauss() * g.size[0] * 0.5;
          y = g.size[1] * 0.9 + gauss() * g.size[1] * 0.8;
        }
        var y1 = y * cx - z * sx, z1 = y * sx + z * cx;
        var x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
        var x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
        var hot = rand() < g.young;
        var t = TIERS[hot ? tier(1) : (rand() < 0.9 ? 0 : 1)];
        var teff = hot ? classTeff('hot')
          : classTeff(g.kind === 'dE' ? (rand() < 0.6 ? 'warm' : 'soft')
            : (rand() < 0.5 ? 'soft' : 'field'));
        pop.set(i, o.r * g.dir, o.theta, g.incl, o.node, teff,
          t[1] * (g.kind === 'dE' ? 0.8 : 1), -1, 1, x3, y3, z2, t[0]);
      }
    });
    return pop;
  }

  // A sparse field of background stars at infinity, for a sense of which way is up.
  function makeSky(n) {
    var pop = new Population('sky', n, { mode: 2 });
    for (var i = 0; i < n; i++) {
      var ct = 2 * rand() - 1;
      var st = Math.sqrt(1 - ct * ct);
      var ph = rand() * Math.PI * 2;
      pop.set(i, st * Math.cos(ph), st * Math.sin(ph), ct, 0,
        classTeff(pick(['field', 'soft', 'warm', 'hot'])), between(0.12, 0.34), -1, 1,
        0, 0, 0, 1);
    }
    return pop;
  }

  /*
   * Distant galaxies: faint smudges at infinity, each a small ellipse at a random
   * angle, most of them tiny. Reddish ellipticals, and bluer spirals seen at every
   * tilt. They turn with the sky and never get closer, which is the point: they are
   * what "far" looks like next to a galaxy you can hold.
   */
  function makeDistant(n) {
    var pop = new Population('distant', n, { mode: 4 });
    for (var i = 0; i < n; i++) {
      var ct = 2 * rand() - 1;
      var st = Math.sqrt(1 - ct * ct);
      var ph = rand() * Math.PI * 2;
      var d = [st * Math.cos(ph), st * Math.sin(ph), ct];
      // A major axis on the sky: any direction at right angles to d.
      var q = [gauss(), gauss(), gauss()];
      var k = q[0] * d[0] + q[1] * d[1] + q[2] * d[2];
      var t = [q[0] - k * d[0], q[1] - k * d[1], q[2] - k * d[2]];
      var tl = Math.hypot(t[0], t[1], t[2]) || 1;
      var elliptical = rand() < 0.45;
      pop.set(i, d[0], d[1], d[2], 0,
        classTeff(elliptical ? (rand() < 0.6 ? 'warm' : 'soft') : pick(['field', 'soft', 'hot'])),
        between(0.22, 0.5),
        elliptical ? between(0.55, 1) : between(0.22, 0.9),
        elliptical ? between(0.5, 1) : between(0, 0.5),
        t[0] / tl, t[1] / tl, t[2] / tl,
        // Mostly tiny, a few larger: sizes fall off steeply, as counts of galaxies do.
        3.5 + 12 * Math.pow(rand(), 3));
    }
    return pop;
  }

  /* ---------- The catalogue ---------- */

  function spectralClass(teff) {
    var best = 'G2', bestD = Infinity;
    Object.keys(CLASS_TEFF).forEach(function (k) {
      var d = Math.abs(Math.log(CLASS_TEFF[k] / teff));
      if (d < bestD) { bestD = d; best = k; }
    });
    return best;
  }

  function thousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /*
   * Catalogue stars: bright ones outside the core, lit most of the time so there is
   * nearly always something to point at (as in the hero). Their tiers and light-up
   * thresholds are adjusted in place, before anything is uploaded.
   */
  function pickNamed(pop, want, serialStart, hot) {
    var pool = [];
    var i;
    for (i = 0; i < pop.count; i++) {
      var r = pop.orbit[i * 4];
      if (r > 0.12 && r < 0.96 && pop.extra[i * 4 + 3] >= TIERS[1][0]) { pool.push(i); }
    }
    for (i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool.slice(0, want).map(function (idx, k) {
      var o = idx * 4;
      pop.phys[o + 2] = Math.min(pop.phys[o + 2], rand() * 0.25);
      var teff = pop.phys[o];
      var serial = serialStart + k;
      var cls = spectralClass(teff);
      var mag = (hot ? 7.6 : 9.4) + rand() * 4.2;
      var rr = pop.orbit[o];
      return {
        pop: pop.name,
        index: idx,
        id: 'SVY-' + String(1000 + ((serial * 613 + 271) % 9000)),
        cls: cls + ' V',
        teff: thousands(CLASS_TEFF[cls]) + ' K',
        mag: 'V ' + mag.toFixed(1),
        radius: (rr * P.GALAXY_KPC).toFixed(1) + ' kpc',
        height: (pop.orbit[o + 2] * P.GALAXY_KPC * 1000).toFixed(0) + ' pc',
        vc: Math.round(circularKms(rr)) + ' km/s',
        hot: hot
      };
    });
  }

  /* ---------- Evaluating a point on the CPU ---------- */

  // A star's phase against the wave at time t, after crowding. See JAM_OLD.
  function jammedPhase(pop, i, t) {
    var o = i * 4;
    var psi = pop.orbit[o + 3] + (angularSpeed(pop.orbit[o]) - PATTERN_SPEED) * t;
    var jam = pop.render.jam || 0;
    return { psi: psi, phase: psi - 0.5 * jam * Math.sin(2 * psi) };
  }

  /*
   * Where disc point i of `pop` is at time t, and how brightly the wave lights it.
   * This is the vertex shader's arithmetic, repeated for the few points the page has
   * to know about (the catalogue, a supernova host). The two must agree.
   */
  function evaluate(pop, i, t, out) {
    var o = i * 4;
    var r = pop.orbit[o];
    var jp = jammedPhase(pop, i, t);
    var a = pop.orbit[o + 1] + angularSpeed(r) * t + (jp.phase - jp.psi);
    var thr = pop.phys[o + 2];
    var floor = pop.phys[o + 3];
    out.x = r * Math.cos(a);
    out.y = r * Math.sin(a);
    out.z = pop.orbit[o + 2] + warpZ(r, a);
    out.light = floor + (1 - floor) * smoothstep(thr - 0.16, thr, crest(jp.phase));
    return out;
  }

  // What a catalogue star's card says about where it is right now.
  function locate(pop, i, t) {
    if (pop.orbit[i * 4] < 0.16) { return 'Bulge'; }
    var phase = jammedPhase(pop, i, t).phase;
    if (crest(phase) < 0.4) { return 'Inter-arm'; }
    return ARM_NAMES[Math.cos(phase) > 0 ? 0 : 1] + ' arm';
  }

  /* ---------- Build ---------- */

  function build(small) {
    rand = mulberry32(P.SEED);
    var s = small ? 1 : 0;
    // The galaxy first and the background last, so the background's counts can change
    // without reshuffling a single star of the galaxy.
    var pops = [
      makeFaint(COUNTS.faint[s]),
      makeDisc(COUNTS.disc[s]),
      makeBulge(COUNTS.bulge[s]),
      makeYoung(COUNTS.young[s]),
      makeHalo(COUNTS.halo[s]),
      makeSatellites(small),
      makeSky(COUNTS.sky[s]),
      makeDistant(COUNTS.distant[s])
    ];
    var byName = {};
    pops.forEach(function (p) { byName[p.name] = p; });

    var catalogue = pickNamed(byName.disc, NAMED_DISC, 0, false)
      .concat(pickNamed(byName.young, NAMED_YOUNG, NAMED_DISC, true));

    return {
      populations: pops,
      byName: byName,
      catalogue: catalogue
    };
  }

  return {
    params: P,
    warp: WARP,
    dust: DUST,
    PATTERN_SPEED: PATTERN_SPEED,
    build: build,
    evaluate: evaluate,
    locate: locate,
    thousands: thousands
  };
})();
