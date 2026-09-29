/*
 * jeremy.ie/galaxy — the model.
 *
 * The same galaxy as the homepage hero (assets/js/home-galaxy.js), built bigger and in
 * more parts, for a page where it can be turned to any angle and looked at closely.
 * This file is data only: no DOM, no WebGL. It says where every point is and what it
 * physically is. It never says what colour anything is drawn in, because that depends
 * on the band being looked at (galaxy-bands.js), and the renderer (galaxy-view.js)
 * only ever connects the two.
 *
 * The physics is the hero's, unchanged:
 *
 *   - A flat rotation curve, v(r) = V_FLAT * r / sqrt(r^2 + R_CORE^2). The core turns
 *     like a solid body and the rest shears.
 *   - Spiral arms that are a density wave, turning rigidly at the pattern speed of the
 *     corotation radius, with stars streaming through them. The arms trail.
 *   - Old stars are only crowded by the wave, never removed: between the arms they are
 *     faint but present. Young hot stars light only on the crest, because they live and
 *     die within one arm crossing.
 *
 * THE TUNABLES BELOW MUST STAY IN STEP WITH home-galaxy.js. They are copied rather than
 * shared so the hero, which is tuned by eye as a Canvas 2D plot, is never disturbed by
 * a change made for this page.
 *
 * What this page adds is parts the hero has no room for, each following from the same
 * wave:
 *
 *   - dust lanes on the inner edge of each arm, where gas runs into the wave and is
 *     compressed. Upstream of the crest inside corotation, and on the other side
 *     outside it, since the gas crosses the arm in the opposite direction there. Near
 *     corotation the gas barely crosses the arm at all, so the lanes fade out.
 *   - HII regions, the pink glow of hydrogen ionised by the youngest stars, just
 *     downstream of the crest where that compressed gas has had time to form stars.
 *   - an unresolved glow of the millions of stars too faint to draw one by one.
 *   - a halo of globular clusters on inclined orbits, which only reads once the disc
 *     has been turned.
 *   - a sparse field of background stars at infinity, for a sense of orientation.
 *
 * Every point carries three vec4s, the same layout for every population, so one shader
 * program draws them all:
 *
 *   orbit  disc:  r, theta0, z, phase0      (phase0 = angle against the arm crest)
 *          halo:  r, theta0, incl, node      (r < 0 for a retrograde orbit)
 *          sky:   direction x, y, z, 0
 *   phys   teff (K), luminosity, light-up threshold, floor (brightness between arms)
 *   extra  offset x, y, z (a star's place in its globular cluster), size multiplier
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
   * Counts, desktop and phone. Only a fraction of the young stars and HII regions are
   * lit at any moment (the ones on a crest), so those populations are generous.
   */
  var COUNTS = {
    disc: [70000, 32000],
    young: [30000, 14000],
    bulge: [9000, 4500],
    bulgeGlow: [4000, 1600],
    diffuse: [24000, 9000],
    hii: [3200, 1500],
    dust: [7000, 3200],
    clusters: [120, 70], // globular clusters, not stars
    clusterStars: [40, 24], // stars per cluster
    sky: [2200, 1100]
  };

  var NAMED_DISC = 110; // catalogue stars that carry a hover card
  var NAMED_YOUNG = 40;

  // Phase offsets from the crest, in radians of phase (an arm repeats every pi).
  var DUST_LEAD = 0.2;
  var HII_LAG = 0.09;

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

  /*
   * Which way gas crosses the arm at radius r: +1 well inside corotation (it overtakes
   * the pattern), -1 well outside (the pattern overtakes it), and near 0 at corotation.
   */
  function crossing(r) {
    var d = (angularSpeed(r) - PATTERN_SPEED) / PATTERN_SPEED;
    return Math.tanh(d * 3);
  }

  function crest(phase) {
    return P.INTERARM + (1 - P.INTERARM)
      * Math.exp(P.ARM_SHARP * (Math.cos(2 * phase) - 1));
  }

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // Exponential disc radius, clipped to r <= max, as the hero draws it.
  function discRadius(scale, min, max) {
    var r;
    do {
      r = -Math.log(1 - rand()) * scale + min;
    } while (r > max);
    return r;
  }

  /* ---------- Populations ---------- */

  function Population(name, n, render) {
    this.name = name;
    this.count = n;
    this.orbit = new Float32Array(n * 4);
    this.phys = new Float32Array(n * 4);
    this.extra = new Float32Array(n * 4);
    /*
     * How a point of this population is drawn, independent of band:
     *   mode      0 disc orbit, 1 halo orbit, 2 sky
     *   extended  false: a point source of fixed pixel size (a star)
     *             true:  a patch of fixed size in the galaxy, in units of the radius
     *   shape     'round', or 'plane' for a patch that lies in the disc and so
     *             foreshortens with it
     *   size      pixels for a star, disc radii for an extended patch
     */
    this.render = render;
  }

  Population.prototype.set = function (i, o0, o1, o2, o3, teff, lum, thr, floor, e0, e1, e2, size) {
    var k = i * 4;
    this.orbit[k] = o0; this.orbit[k + 1] = o1; this.orbit[k + 2] = o2; this.orbit[k + 3] = o3;
    this.phys[k] = teff; this.phys[k + 1] = lum; this.phys[k + 2] = thr; this.phys[k + 3] = floor;
    this.extra[k] = e0; this.extra[k + 1] = e1; this.extra[k + 2] = e2; this.extra[k + 3] = size;
  };

  // A disc point: orbit on the rotation curve, lit by the wave at phase offset `shift`.
  function discPoint(pop, i, r, z, teff, lum, thr, floor, size, shift) {
    var theta = rand() * Math.PI * 2;
    pop.set(i, r, theta, z, theta - crestAngle(r) + (shift || 0),
      teff, lum, thr, floor, 0, 0, 0, size);
  }

  // A bright star is drawn a little larger, as a bright star smears over more pixels.
  function starSize(lum) {
    return Math.min(2.2, Math.max(0.8, 1 + 0.32 * Math.log(lum) / Math.LN10));
  }

  // Log-normal luminosity around `mid`.
  function lumAround(mid, spread) {
    return mid * Math.exp(gauss() * spread);
  }

  function makeDisc(n) {
    var pop = new Population('disc', n, { mode: 0, extended: false, shape: 'round', size: 2.1 });
    for (var i = 0; i < n; i++) {
      var r = discRadius(0.55, 0.05, 1);
      var z = gauss() * 0.022 * (1 + (1 - r) * 0.8);
      var q = rand();
      // Old stars: mostly K and M, with some G and a few F. The inner disc is redder.
      var teff = q < (r < 0.2 ? 0.8 : 0.62) ? between(3500, 5000)
        : q < 0.93 ? between(5200, 6100) : between(6300, 8200);
      var lum = lumAround(teff > 6000 ? 0.9 : 0.55, 0.55);
      discPoint(pop, i, r, z, teff, lum, rand(), 0.1, starSize(lum));
    }
    return pop;
  }

  function makeYoung(n) {
    var pop = new Population('young', n, { mode: 0, extended: false, shape: 'round', size: 2.3 });
    for (var i = 0; i < n; i++) {
      var r = discRadius(0.55, 0.22, 1); // as the hero: no young stars in the core
      var z = gauss() * 0.009;
      var teff = 9000 * Math.exp(Math.pow(rand(), 2) * Math.log(3.6)); // 9,000-32,000 K
      var lum = lumAround(1.2 + teff / 12000, 0.45);
      discPoint(pop, i, r, z, teff, lum, 0.5 + rand() * 0.5, 0, starSize(lum));
    }
    return pop;
  }

  function makeBulge(n) {
    var pop = new Population('bulge', n, { mode: 0, extended: false, shape: 'round', size: 1.9 });
    for (var i = 0; i < n; i++) {
      var r = Math.abs(gauss()) * 0.075;
      var z = gauss() * 0.06;
      var lum = lumAround(0.45, 0.45);
      // thr -1: always lit. The bulge does not take part in the wave.
      discPoint(pop, i, r, z, between(3600, 5100), lum, -1, 1, starSize(lum));
    }
    return pop;
  }

  function makeBulgeGlow(n) {
    var pop = new Population('bulgeGlow', n, { mode: 0, extended: true, shape: 'round', size: 1 });
    for (var i = 0; i < n; i++) {
      var r = Math.abs(gauss()) * 0.08;
      discPoint(pop, i, r, gauss() * 0.05, between(4000, 4700), between(0.7, 1.1), -1, 1,
        between(0.05, 0.09));
    }
    return pop;
  }

  // The light of the stars too faint to draw: an old smooth part and a young arm part.
  function makeDiffuse(n) {
    var pop = new Population('diffuse', n, { mode: 0, extended: true, shape: 'plane', size: 1 });
    for (var i = 0; i < n; i++) {
      var young = rand() < 0.32;
      var r = discRadius(0.5, young ? 0.2 : 0.04, 1);
      var z = gauss() * 0.02;
      if (young) {
        discPoint(pop, i, r, z, between(10000, 16000), between(0.6, 1.2),
          0.3 + rand() * 0.5, 0, between(0.08, 0.14));
      } else {
        discPoint(pop, i, r, z, between(4300, 5600), between(0.6, 1.2),
          rand(), 0.45, between(0.12, 0.2));
      }
    }
    return pop;
  }

  function makeHii(n) {
    var pop = new Population('hii', n, { mode: 0, extended: true, shape: 'plane', size: 1 });
    for (var i = 0; i < n; i++) {
      var r = discRadius(0.5, 0.2, 0.96);
      discPoint(pop, i, r, gauss() * 0.006, 10000, lumAround(1, 0.5),
        0.7 + rand() * 0.3, 0, between(0.006, 0.02), -HII_LAG * crossing(r));
    }
    return pop;
  }

  /*
   * Dust. Its "luminosity" is optical depth: how much of the light behind it a patch
   * takes out. A little lies everywhere (the floor); most of it sits in the lanes.
   */
  function makeDust(n) {
    var pop = new Population('dust', n, { mode: 0, extended: true, shape: 'plane', size: 1 });
    for (var i = 0; i < n; i++) {
      var r = discRadius(0.45, 0.1, 0.95);
      discPoint(pop, i, r, gauss() * 0.004, 0, between(0.4, 1.1),
        0.35 + rand() * 0.65, 0.12, between(0.025, 0.055), DUST_LEAD * crossing(r));
    }
    return pop;
  }

  /*
   * Globular clusters. Each is a tight Plummer sphere of old stars on an orbit of its
   * own, at the rotation curve's speed but in a random plane and either direction: the
   * halo has almost no net rotation. Real clusters are a few parsecs across, far too
   * small to see at this scale, so they are drawn about ten times larger than life.
   */
  function makeClusters(nClusters, perCluster) {
    var n = nClusters * perCluster;
    var pop = new Population('globular', n, { mode: 1, extended: false, shape: 'round', size: 1.9 });
    var i = 0;
    for (var c = 0; c < nClusters; c++) {
      var r = Math.min(1.7, 0.12 + Math.abs(gauss()) * 0.5);
      var dir = rand() < 0.5 ? 1 : -1;
      var theta = rand() * Math.PI * 2;
      var incl = Math.acos(2 * rand() - 1);
      var node = rand() * Math.PI * 2;
      var a = between(0.003, 0.006); // Plummer radius
      for (var s = 0; s < perCluster; s++, i++) {
        var u = Math.max(0.02, rand());
        var d = Math.min(5 * a, a / Math.sqrt(Math.pow(u, -2 / 3) - 1));
        var ct = 2 * rand() - 1;
        var st = Math.sqrt(1 - ct * ct);
        var ph = rand() * Math.PI * 2;
        // Metal-poor and old: a little bluer than the bulge, plus a few horizontal
        // branch stars.
        var teff = rand() < 0.1 ? between(7500, 10500) : between(4600, 6100);
        var lum = lumAround(0.2, 0.5);
        pop.set(i, r * dir, theta, incl, node, teff, lum, -1, 1,
          d * st * Math.cos(ph), d * st * Math.sin(ph), d * ct, starSize(lum));
      }
    }
    return pop;
  }

  function makeSky(n) {
    var pop = new Population('sky', n, { mode: 2, extended: false, shape: 'round', size: 1.6 });
    for (var i = 0; i < n; i++) {
      var ct = 2 * rand() - 1;
      var st = Math.sqrt(1 - ct * ct);
      var ph = rand() * Math.PI * 2;
      var lum = 0.04 * Math.exp(-Math.log(1 - rand()) * 0.9);
      pop.set(i, st * Math.cos(ph), st * Math.sin(ph), ct, 0,
        between(3400, 11000), lum, -1, 1, 0, 0, 0, starSize(lum * 10));
    }
    return pop;
  }

  /* ---------- The catalogue ---------- */

  var CLASS_TEFF = {
    O9: 31500, B1: 25400, B3: 18700, B8: 12000, A0: 9700, A2: 8800,
    F5: 6500, F8: 6150, G0: 5930, G2: 5770, G8: 5350,
    K0: 5250, K1: 5080, K3: 4750, K5: 4400, K7: 4050, M0: 3850, M2: 3550
  };

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
   * nearly always something to point at (as in the hero). Their light-up thresholds
   * and luminosities are adjusted in place, before anything is uploaded.
   */
  function pickNamed(pop, want, serialStart, hot) {
    var pool = [];
    var i;
    for (i = 0; i < pop.count; i++) {
      var r = pop.orbit[i * 4];
      if (r > 0.12 && r < 0.96) { pool.push(i); }
    }
    for (i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool.slice(0, want).map(function (idx, k) {
      var o = idx * 4;
      pop.phys[o + 1] = Math.max(pop.phys[o + 1], hot ? 3 : 1.4);
      pop.phys[o + 2] = Math.min(pop.phys[o + 2], rand() * 0.25);
      pop.extra[o + 3] = starSize(pop.phys[o + 1]);
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

  /*
   * Where disc point i of `pop` is at time t, and how brightly the wave lights it.
   * This is the vertex shader's arithmetic, repeated for the few points the page has
   * to know about (the catalogue, a supernova host). The two must agree.
   */
  function evaluate(pop, i, t, out) {
    var o = i * 4;
    var r = pop.orbit[o];
    var w = angularSpeed(r);
    var a = pop.orbit[o + 1] + w * t;
    var phase = pop.orbit[o + 3] + (w - PATTERN_SPEED) * t;
    var thr = pop.phys[o + 2];
    var floor = pop.phys[o + 3];
    out.x = r * Math.cos(a);
    out.y = r * Math.sin(a);
    out.z = pop.orbit[o + 2];
    out.phase = phase;
    out.light = floor + (1 - floor) * smoothstep(thr - 0.16, thr, crest(phase));
    return out;
  }

  // What a catalogue star's card says about where it is right now.
  function locate(pop, i, t) {
    var o = i * 4;
    var r = pop.orbit[o];
    if (r < 0.16) { return 'Bulge'; }
    var phase = pop.orbit[o + 3] + (angularSpeed(r) - PATTERN_SPEED) * t;
    if (crest(phase) < 0.4) { return 'Inter-arm'; }
    return ARM_NAMES[Math.cos(phase) > 0 ? 0 : 1] + ' arm';
  }

  /* ---------- Build ---------- */

  function build(small) {
    rand = mulberry32(P.SEED);
    var s = small ? 1 : 0;
    var pops = [
      makeSky(COUNTS.sky[s]),
      makeDiffuse(COUNTS.diffuse[s]),
      makeBulgeGlow(COUNTS.bulgeGlow[s]),
      makeDisc(COUNTS.disc[s]),
      makeBulge(COUNTS.bulge[s]),
      makeYoung(COUNTS.young[s]),
      makeClusters(COUNTS.clusters[s], COUNTS.clusterStars[s]),
      makeHii(COUNTS.hii[s]),
      makeDust(COUNTS.dust[s])
    ];
    var byName = {};
    pops.forEach(function (p) { byName[p.name] = p; });

    /*
     * On a phone each population has fewer points, so each carries proportionally more
     * light (or dust): the galaxy is as bright, and its lanes as dark, whatever it is
     * sampled with. The sky is left alone, since there only the count shows.
     */
    if (small) {
      var ratio = {
        disc: COUNTS.disc, young: COUNTS.young, bulge: COUNTS.bulge,
        bulgeGlow: COUNTS.bulgeGlow, diffuse: COUNTS.diffuse, hii: COUNTS.hii,
        dust: COUNTS.dust, globular: COUNTS.clusterStars
      };
      Object.keys(ratio).forEach(function (k) {
        var f = ratio[k][0] / ratio[k][1];
        var pop = byName[k];
        for (var i = 0; i < pop.count; i++) { pop.phys[i * 4 + 1] *= f; }
      });
    }

    var catalogue = pickNamed(byName.disc, NAMED_DISC, 0, false)
      .concat(pickNamed(byName.young, NAMED_YOUNG, NAMED_DISC, true));

    var stars = 0;
    ['disc', 'young', 'bulge', 'globular'].forEach(function (k) { stars += byName[k].count; });

    return {
      populations: pops,
      byName: byName,
      catalogue: catalogue,
      stars: stars
    };
  }

  return {
    params: P,
    PATTERN_SPEED: PATTERN_SPEED,
    build: build,
    evaluate: evaluate,
    locate: locate,
    angularSpeed: angularSpeed,
    circularKms: circularKms,
    thousands: thousands
  };
})();
