/*
 * jeremy.ie/star — the model.
 *
 * A young Sun-like star: a G dwarf of 0.9 solar radii and 5,700 K, about 600 million
 * years old, turning in nine days instead of the Sun's twenty-five. Young stars spin
 * faster, so their dynamos are stronger: more active regions, reaching higher
 * latitudes, and more flares.
 *
 * This file is data only: no DOM, no WebGL. It says where the magnetic field is and
 * what the plasma on it is doing (its temperature and density). It never says what
 * colour anything is, because that depends on the channel being looked at
 * (star-bands.js), and the renderer (star-view.js) only connects the two.
 *
 * The magnetic field is magnetic-charge topology: point sources ("charges") buried a
 * little under the surface, each giving B = q (x - x_q) / |x - x_q|^3, summed. It is
 * a potential field, the coronal field with no currents, and is the standard cheap
 * stand-in for the real one. An active region is a bipole of such sources (two
 * sunspots and the plage around them); a deep pair under the poles gives the polar
 * field, which opens into coronal holes; small shallow bipoles all over the surface
 * are ephemeral regions, whose little loops are the coronal bright points.
 *
 *   - Joy's law: a region's axis is tilted so its leading spot (the one ahead as the
 *     star turns) is nearer the equator, more so at higher latitude.
 *   - Hale's law: leading spots have one polarity in the north and the other in the
 *     south. The polar fields have the polarity of each hemisphere's following spots.
 *   - Regions emerge (the spots rise, grow and draw apart), live a while, and decay
 *     (the spots shrink and their flux spreads out into plage), then are replaced.
 *
 * Coronal loops are field lines, traced from footpoints in the regions through the
 * summed field until they come back down (closed) or leave (open). Each traced line
 * is a strand. A strand is heated in bursts: it jumps to its peak temperature, fills
 * with evaporated plasma, then cools and drains, so it lights up in the hot channels
 * first and the cool ones after (the cooling sequence AIA sees). The longest strands
 * sometimes cool catastrophically and rain back down as cool blobs.
 *
 * Rates are illustrative, as on /galaxy: the star turns in six minutes here, a strand
 * heats every 15 to 60 seconds, a flare runs its course in about 40, a region
 * emerges in about a minute and lives for six or seven. The field turns rigidly with
 * the star. Real stars turn faster at the equator than the poles; this one does not,
 * so its loops are never sheared apart by the turning.
 *
 * Units: lengths in stellar radii (the surface is r = 1), field in gauss, temperature
 * as log10(T / K), time in seconds of the page's clock.
 *
 * Every strand is a fixed slot of POINTS points. The renderer reads slot geometry and
 * parameters from `geom` and `par` (laid out as float textures) and re-uploads only
 * the slots in `dirty`.
 */
window.StarModel = (function () {
  'use strict';

  /* ---------- The star ---------- */

  var P = {
    R_SUN: 0.9, // radius, in solar radii
    TEFF: 5700, // K
    MASS: 0.95, // solar masses
    P_ROT_DAYS: 9,
    AGE_MYR: 600,
    MM_PER_R: 626, // megametres in one stellar radius (0.9 x 696)
    B0: 7 * Math.PI / 180, // the opening view's tilt of the north pole toward us
    SPIN_SECONDS: 360, // one turn of the page's clock
    SEED: 2732055
  };
  var SPIN = 2 * Math.PI / P.SPIN_SECONDS; // rad/s, about +z
  var R_CM = P.R_SUN * 6.957e10;
  var MX_PER_Q = 2 * Math.PI * R_CM * R_CM; // flux through the surface from one unit of charge

  /* ---------- Tunables ---------- */

  var POINTS = 48; // per strand
  var GEOM_STRIDE = 8; // per point: x y z s, tx ty tz 0 (two RGBA texels)
  var PAR_STRIDE = 12; // per strand: three RGBA texels (see writeParams)

  // Strand kinds, as the renderer reads them.
  var KIND = { EMPTY: 0, LOOP: 1, FAN: 2, FLARE: 3, THREAD: 4, ARCH: 5, POINT: 6 };

  var REGION = {
    count: [11, 8], // kept alive: desktop, phone
    lat: [0.09, 0.8], // |latitude|, radians: about 5 to 46 degrees
    sep: [0.055, 0.16], // spot separation when mature
    depth: [0.012, 0.022], // of the main sources: the spot's size goes with it
    peak: [2300, 3300], // G at the centre of the leading umbra when mature
    emerge: [45, 75],
    mature: [150, 280],
    decay: [170, 270],
    strands: [130, 48], // per region of middling size
    minGap: 0.2 // radians between region centres
  };

  // Ephemeral regions: small short-lived bipoles, whose loops are the bright points.
  var EPHEMERAL = {
    count: [90, 36],
    strands: [3, 2],
    sep: [0.008, 0.02],
    depth: [0.004, 0.007],
    peak: [120, 280],
    life: [35, 80]
  };

  // Long loops between regions and over the quiet star.
  var GLOBAL_STRANDS = [220, 80];

  var FLARE = {
    first: [16, 24], // s after load
    gap: [25, 50], // minimum, then an exponential with this mean
    life: [34, 44],
    arcade: [56, 26], // strands
    pool: [72, 32]
  };

  var FILAMENT = {
    count: [3, 2],
    threads: [64, 34],
    height: [0.028, 0.06],
    life: [220, 340]
  };

  var SPICULES = [16000, 6000];

  // The polar field: a buried pair, |q| giving about 12 G at the poles.
  var POLAR_Q = 2.65;
  var POLAR_DEPTH = 0.45;

  /*
   * Coronal temperature and density from a loop's length L and the mean field at its
   * footpoints, B. The shape follows what AIA shows: short loops rooted in strong
   * field (the cores of active regions) are hot, 3 to 4 MK, and shine in 94, 335
   * and 211; long loops out of the same regions (the fans and peripheral loops) are
   * cool, under 1 MK, and are the crisp loops of 171; the quiet corona is about
   * 1.4 MK and shows best in 193. Shared with the renderer's corona volume, which
   * uses the same numbers for the diffuse corona (see coronaT and coronaN).
   */
  var THERMAL = {
    base: 5.94,
    core: 0.5, coreL: [0.34, 0.07], coreB: [80, 600],
    quiet: 0.2, quietB: [25, 120],
    mid: 0.22, midL: [0.6, 0.12],
    nB: 0.15, nL: -0.35, nFloor: 20, // density ~ ((B + floor) / 100)^nB (L / 0.2)^nL
    scatter: 0.05
  };

  /* ---------- Random ---------- */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = mulberry32(P.SEED);

  function between(a, b) { return a + (b - a) * rand(); }

  function gauss() {
    var u = Math.max(1e-9, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  function smooth(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

  /* ---------- Vectors (outside the hot loops) ---------- */

  function norm(v) {
    var l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sph(lat, lon) {
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  }
  function randomDir() {
    var z = 2 * rand() - 1, a = 2 * Math.PI * rand(), s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), s * Math.sin(a), z];
  }
  // A point on the sphere a small step (da along a, db along b) from c.
  function offset(c, a, b, da, db) {
    return norm([c[0] + a[0] * da + b[0] * db, c[1] + a[1] * da + b[1] * db,
      c[2] + a[2] * da + b[2] * db]);
  }
  function latOf(v) { return Math.asin(clamp(v[2], -1, 1)); }
  function lonOf(v) { return Math.atan2(v[1], v[0]); }

  /* ---------- The field ---------- */

  /*
   * Sources are grouped (the polar pair, each active region, each ephemeral region).
   * Far from a group, its sources are summed as one monopole plus a dipole, which is
   * what a compact cluster of charges looks like from a distance; far from an
   * ephemeral region, it is ignored. That keeps a field evaluation to a few dozen
   * terms instead of a few hundred, so tracing fits in a few milliseconds a frame.
   */
  var MAX_SRC = 1024;
  var MAX_GROUPS = 160;
  var GS = 11; // group stride: x0 y0 z0 farR2 mx my mz Q start end extent
  var src = new Float64Array(4 * MAX_SRC);
  var srcCount = 0;
  var groups = new Float64Array(GS * MAX_GROUPS);
  var groupMode = new Uint8Array(MAX_GROUPS); // 0 always exact, 1 far as dipole, 2 far ignored
  var groupCount = 0;
  var fb = new Float64Array(4); // bx, by, bz, distance to the nearest source

  function field(x, y, z) {
    var bx = 0, by = 0, bz = 0, dmin = 1e9;
    for (var g = 0; g < groupCount; g++) {
      var o = g * GS;
      var dx = x - groups[o], dy = y - groups[o + 1], dz = z - groups[o + 2];
      var d2 = dx * dx + dy * dy + dz * dz;
      var mode = groupMode[g];
      if (mode !== 0 && d2 > groups[o + 3]) {
        if (mode === 2) { continue; }
        var d = Math.sqrt(d2);
        var inv3 = 1 / (d2 * d);
        var mx = groups[o + 4], my = groups[o + 5], mz = groups[o + 6], Q = groups[o + 7];
        var mr = 3 * (mx * dx + my * dy + mz * dz) / d2;
        bx += (mr * dx - mx + Q * dx) * inv3;
        by += (mr * dy - my + Q * dy) * inv3;
        bz += (mr * dz - mz + Q * dz) * inv3;
        var gap = d - groups[o + 10];
        if (gap < dmin) { dmin = gap; }
        continue;
      }
      var end = groups[o + 9];
      for (var k = groups[o + 8]; k < end; k++) {
        var s = k * 4;
        var sx = x - src[s], sy = y - src[s + 1], sz = z - src[s + 2];
        var r2 = sx * sx + sy * sy + sz * sz;
        var r = Math.sqrt(r2);
        var f = src[s + 3] / (r2 * r);
        bx += f * sx; by += f * sy; bz += f * sz;
        if (r < dmin) { dmin = r; }
      }
    }
    fb[0] = bx; fb[1] = by; fb[2] = bz; fb[3] = dmin;
  }

  function beginGroup(mode) {
    var o = groupCount * GS;
    groupMode[groupCount] = mode;
    groups[o + 8] = srcCount;
    return groupCount++;
  }

  function addSource(x, y, z, q) {
    if (srcCount >= MAX_SRC) { return; }
    var s = srcCount * 4;
    src[s] = x; src[s + 1] = y; src[s + 2] = z; src[s + 3] = q;
    srcCount++;
  }

  // Closes a group: its centroid, monopole and dipole moment, and how far "far" is.
  function endGroup(g, farFactor) {
    var o = g * GS;
    var start = groups[o + 8], end = srcCount;
    groups[o + 9] = end;
    var cx = 0, cy = 0, cz = 0, n = end - start;
    var k, s;
    for (k = start; k < end; k++) { s = k * 4; cx += src[s]; cy += src[s + 1]; cz += src[s + 2]; }
    cx /= n || 1; cy /= n || 1; cz /= n || 1;
    var mx = 0, my = 0, mz = 0, Q = 0, ext = 0;
    for (k = start; k < end; k++) {
      s = k * 4;
      var q = src[s + 3];
      mx += q * (src[s] - cx); my += q * (src[s + 1] - cy); mz += q * (src[s + 2] - cz);
      Q += q;
      ext = Math.max(ext, Math.hypot(src[s] - cx, src[s + 1] - cy, src[s + 2] - cz));
    }
    groups[o] = cx; groups[o + 1] = cy; groups[o + 2] = cz;
    var far = Math.max(farFactor * ext, 0.06);
    groups[o + 3] = far * far;
    groups[o + 4] = mx; groups[o + 5] = my; groups[o + 6] = mz; groups[o + 7] = Q;
    groups[o + 10] = ext;
  }

  /* ---------- Tracing ---------- */

  var TRACE_MAX = 900;
  var R_OPEN = 2.2;
  var H_MIN = 0.0012;
  var tr = new Float64Array(3 * (TRACE_MAX + 4));
  var trN = 0;

  function push(x, y, z) {
    var o = trN * 3;
    tr[o] = x; tr[o + 1] = y; tr[o + 2] = z;
    trN++;
  }

  /*
   * Follows the field (sign +1) or against it (-1) from a point just above the surface,
   * by the midpoint method, with steps a third of the distance to the nearest source.
   * Returns 1 if it comes back down (closed, the last point on the surface), 2 if it
   * leaves (open), 0 if it never gets off the ground.
   */
  function trace(x, y, z, sign, hmax) {
    trN = 0;
    push(x, y, z);
    var lifted = false, len = 0;
    for (var i = 0; i < TRACE_MAX; i++) {
      field(x, y, z);
      var bm = Math.hypot(fb[0], fb[1], fb[2]);
      if (bm < 1e-9) { return 0; }
      var h = Math.min(hmax, Math.max(H_MIN, 0.32 * fb[3]));
      var k = sign * 0.5 * h / bm;
      var mx = x + k * fb[0], my = y + k * fb[1], mz = z + k * fb[2];
      field(mx, my, mz);
      bm = Math.hypot(fb[0], fb[1], fb[2]);
      if (bm < 1e-9) { return 0; }
      k = sign * h / bm;
      var nx = x + k * fb[0], ny = y + k * fb[1], nz = z + k * fb[2];
      var r = Math.sqrt(nx * nx + ny * ny + nz * nz);
      len += h;
      if (r < 1) {
        if (!lifted) { return 0; }
        var r0 = Math.sqrt(x * x + y * y + z * z);
        var f = (r0 - 1) / Math.max(1e-9, r0 - r);
        var px = x + (nx - x) * f, py = y + (ny - y) * f, pz = z + (nz - z) * f;
        var pl = Math.sqrt(px * px + py * py + pz * pz);
        push(px / pl, py / pl, pz / pl);
        return 1;
      }
      if (r > 1.0012) { lifted = true; }
      x = nx; y = ny; z = nz;
      push(x, y, z);
      if (r > R_OPEN || len > 7) { return 2; }
    }
    return 2;
  }

  /*
   * The traced line, resampled to POINTS points evenly along its length, into a slot.
   * Open lines are cut at r = 1.7, past which the corona is too faint to matter.
   * Returns the length and the height of the top, or null for a line too short to see.
   */
  var cum = new Float64Array(TRACE_MAX + 4);

  function resample(slot, open) {
    var n = trN;
    if (open) {
      for (var c = 1; c < n; c++) {
        var o = c * 3;
        if (Math.hypot(tr[o], tr[o + 1], tr[o + 2]) > 1.7) { n = c + 1; break; }
      }
    }
    if (n < 3) { return null; }
    cum[0] = 0;
    var apex = 0;
    for (var i = 1; i < n; i++) {
      var a = (i - 1) * 3, b = i * 3;
      cum[i] = cum[i - 1] + Math.hypot(tr[b] - tr[a], tr[b + 1] - tr[a + 1], tr[b + 2] - tr[a + 2]);
      apex = Math.max(apex, Math.hypot(tr[b], tr[b + 1], tr[b + 2]) - 1);
    }
    var L = cum[n - 1];
    if (L < 0.004) { return null; }
    var g = model.geom;
    var base = slot * POINTS * GEOM_STRIDE;
    var j = 0;
    for (var p = 0; p < POINTS; p++) {
      var target = L * p / (POINTS - 1);
      while (j < n - 2 && cum[j + 1] < target) { j++; }
      var t = (target - cum[j]) / Math.max(1e-12, cum[j + 1] - cum[j]);
      t = clamp(t, 0, 1);
      var q = j * 3, q1 = (j + 1) * 3, w = base + p * GEOM_STRIDE;
      g[w] = tr[q] + (tr[q1] - tr[q]) * t;
      g[w + 1] = tr[q + 1] + (tr[q1 + 1] - tr[q + 1]) * t;
      g[w + 2] = tr[q + 2] + (tr[q1 + 2] - tr[q + 2]) * t;
      g[w + 3] = p / (POINTS - 1);
    }
    tangents(slot);
    return { length: L, apex: apex };
  }

  function tangents(slot) {
    var g = model.geom;
    var base = slot * POINTS * GEOM_STRIDE;
    for (var p = 0; p < POINTS; p++) {
      var a = base + Math.max(0, p - 1) * GEOM_STRIDE;
      var b = base + Math.min(POINTS - 1, p + 1) * GEOM_STRIDE;
      var tx = g[b] - g[a], ty = g[b + 1] - g[a + 1], tz = g[b + 2] - g[a + 2];
      var l = Math.hypot(tx, ty, tz) || 1;
      var w = base + p * GEOM_STRIDE;
      g[w + 4] = tx / l; g[w + 5] = ty / l; g[w + 6] = tz / l; g[w + 7] = 0;
    }
  }

  function fieldStrength(x, y, z) {
    field(x, y, z);
    return Math.hypot(fb[0], fb[1], fb[2]);
  }

  function radialField(v) {
    field(v[0] * 1.0004, v[1] * 1.0004, v[2] * 1.0004);
    return fb[0] * v[0] + fb[1] * v[1] + fb[2] * v[2];
  }

  /* ---------- Thermal state of a strand ---------- */

  function coronaLogT(L, B) {
    var core = smooth(THERMAL.coreL[0], THERMAL.coreL[1], L) * smooth(THERMAL.coreB[0], THERMAL.coreB[1], B);
    var quiet = 1 - smooth(THERMAL.quietB[0], THERMAL.quietB[1], B);
    return THERMAL.base + THERMAL.core * core + (1 - core) * (THERMAL.quiet * quiet
      + THERMAL.mid * (1 - quiet) * smooth(THERMAL.midL[0], THERMAL.midL[1], L));
  }

  function coronaN(L, B) {
    return Math.pow((B + THERMAL.nFloor) / 100, THERMAL.nB) * Math.pow(Math.max(L, 0.01) / 0.2, THERMAL.nL);
  }

  /*
   * The parameters the renderer reads for a slot, three RGBA texels:
   *   0  heating period (s), phase (s), peak log T, floor log T
   *   1  emission gain, width (R), length (R), apex height (R)
   *   2  kind, born (s), end (s), rain (1) or not (0)
   */
  function writeParams(slot) {
    var m = meta[slot];
    var o = slot * PAR_STRIDE;
    var a = model.par;
    a[o] = m.period; a[o + 1] = m.phase; a[o + 2] = m.logT; a[o + 3] = m.floor;
    a[o + 4] = m.gain; a[o + 5] = m.width; a[o + 6] = m.length; a[o + 7] = m.apex;
    a[o + 8] = m.kind; a[o + 9] = m.born; a[o + 10] = m.end; a[o + 11] = m.rain;
    markDirty(slot);
  }

  // A fresh heating rhythm for a strand: kept across retraces so it never jumps.
  function heating(m) {
    m.period = between(16, 55);
    m.phase = rand() * m.period;
    m.impulsive = rand() < 0.45;
    m.rainProne = rand() < 0.4;
    m.scatter = gauss() * THERMAL.scatter;
    m.widthScale = Math.exp(0.3 * gauss());
  }

  function settle(m, L, apex, B, open) {
    m.length = L;
    m.apex = apex;
    m.B = B;
    var logT = coronaLogT(L, B) + m.scatter;
    if (open) { logT = 5.92 + m.scatter * 0.5; }
    m.logT = logT;
    m.floor = m.impulsive ? (m.rainProne && L > 0.12 && !open ? 4.6 : 5.62) : logT - 0.14;
    m.rain = m.impulsive && m.rainProne && L > 0.12 && !open ? 1 : 0;
    m.gain = coronaN(L, B);
  }

  /* ---------- Slots ---------- */

  var meta = [];
  var freeSlots = [];
  var model = null;

  function newMeta() {
    return {
      kind: KIND.EMPTY, owner: null, period: 30, phase: 0, logT: 6, floor: 5.8, gain: 0,
      width: 0.003, length: 0, apex: 0, born: 0, end: 1e9, rain: 0, B: 0,
      part: -1, offA: 0, offB: 0, sign: 1, foot: null, impulsive: false, rainProne: false,
      scatter: 0, widthScale: 1, life: null
    };
  }

  function allocSlot(owner) {
    var s = freeSlots.pop();
    if (s === undefined) { return -1; }
    var m = newMeta();
    m.owner = owner;
    meta[s] = m;
    return s;
  }

  function freeSlot(s) {
    var m = newMeta();
    meta[s] = m;
    writeParams(s);
    freeSlots.push(s);
  }

  // Fades a slot out over a couple of seconds, then frees it.
  function retire(s, now) {
    var m = meta[s];
    if (!m || m.kind === KIND.EMPTY) { freeSlot(s); return; }
    m.end = Math.min(m.end, now + 2);
    m.retiring = true;
    writeParams(s);
    retiring.push(s);
  }
  var retiring = [];

  var dirtyFlag = null;

  function markDirty(s) {
    if (!dirtyFlag[s]) { dirtyFlag[s] = 1; model.dirty.push(s); }
  }

  function setEmpty(s) {
    var m = meta[s];
    m.kind = KIND.EMPTY;
    writeParams(s);
  }

  /* ---------- Active regions ---------- */

  var regions = [];
  var regionSerial = 0;
  var LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  function regionFrame(reg) {
    var c = sph(reg.lat, reg.lon);
    var east = [-Math.sin(reg.lon), Math.cos(reg.lon), 0]; // toward increasing longitude: ahead as it turns
    var north = [-Math.sin(reg.lat) * Math.cos(reg.lon), -Math.sin(reg.lat) * Math.sin(reg.lon), Math.cos(reg.lat)];
    // Joy's law: the leading end is nearer the equator.
    var s = reg.lat >= 0 ? -1 : 1;
    var ct = Math.cos(reg.tilt), st = Math.sin(reg.tilt) * s;
    var a = norm([east[0] * ct + north[0] * st, east[1] * ct + north[1] * st, east[2] * ct + north[2] * st]);
    var b = cross(c, a);
    return { c: c, a: a, b: b };
  }

  /*
   * A region's sources, in its own frame: u along the axis (+ toward the leading
   * end), v across it, both in units of the spot separation. w is the relative
   * charge, df the depth relative to the main spots', spot whether it is a sunspot
   * (or plage). Charges are set from the peak field wanted at each umbra, then the
   * negative ones are scaled so the region carries no net flux.
   */
  function makeParts(reg) {
    var parts = [];
    function add(u, v, w, df, spot) { parts.push({ u: u, v: v, w: w, df: df, spot: spot }); }
    add(0.5, 0, 1, 1, true);
    add(-0.5, 0.06, -0.62, 1.12, true);
    add(-0.66, -0.1, -0.4, 0.9, true);
    var i;
    // Plage: weaker, deeper sources strewn around each polarity, wider than the spots.
    for (i = 0; i < 7; i++) {
      add(0.5 + gauss() * 0.36, gauss() * 0.42, 0.13, 2.0 + rand() * 0.8, false);
      add(-0.55 + gauss() * 0.4, gauss() * 0.46, -0.13, 2.0 + rand() * 0.8, false);
    }
    if (reg.complexity !== 'b') {
      add(0.08, 0.3, -0.24, 0.95, true);
      add(-0.12, -0.28, 0.24, 0.95, true);
    }
    if (reg.complexity === 'bgd') {
      // A delta spot: opposite polarity squeezed against the leading umbra.
      add(0.33, 0.12, -0.6, 0.85, true);
    }
    var pos = 0, neg = 0;
    parts.forEach(function (p) {
      var d = reg.depth * p.df;
      p.q = p.w * reg.peak * d * d;
      if (p.q > 0) { pos += p.q; } else { neg -= p.q; }
    });
    parts.forEach(function (p) { if (p.q < 0) { p.q *= pos / neg; } p.q *= reg.hale; });
    return parts;
  }

  function spawnRegion(age, now) {
    var size = Math.pow(rand(), 1.5);
    var reg = {
      id: regionSerial,
      letter: LETTERS.charAt(regionSerial % LETTERS.length),
      size: size,
      sep: REGION.sep[0] + (REGION.sep[1] - REGION.sep[0]) * size,
      depth: REGION.depth[0] + (REGION.depth[1] - REGION.depth[0]) * size,
      peak: between(REGION.peak[0], REGION.peak[1]) * (0.88 + 0.12 * size),
      complexity: rand() < 0.1 + 0.32 * size ? (rand() < 0.45 ? 'bgd' : 'bg') : 'b',
      emerge: between(REGION.emerge[0], REGION.emerge[1]),
      mature: between(REGION.mature[0], REGION.mature[1]) * (0.7 + 0.6 * size),
      decay: between(REGION.decay[0], REGION.decay[1]),
      age: age,
      slots: [],
      cursor: 0,
      flares: 0,
      lat: 0, lon: 0, tilt: 0, hale: 1,
      e: 0, k: 0
    };
    regionSerial++;
    // Where: in the activity belts, half the time near a region already there
    // (activity nests), never on top of one.
    var tries = 0, ok = false;
    while (!ok && tries++ < 60) {
      var hemi = rand() < 0.5 ? 1 : -1;
      reg.lat = hemi * between(REGION.lat[0], REGION.lat[1]) * (0.75 + 0.25 * rand());
      if (regions.length && rand() < 0.5) {
        var near = regions[Math.floor(rand() * regions.length)];
        reg.lon = near.lon + gauss() * 0.45;
      } else {
        reg.lon = rand() * 2 * Math.PI;
      }
      var c = sph(reg.lat, reg.lon);
      ok = regions.every(function (o) {
        return Math.acos(clamp(dot(c, sph(o.lat, o.lon)), -1, 1)) > REGION.minGap + 0.6 * (o.sep + reg.sep);
      });
    }
    reg.hale = reg.lat >= 0 ? 1 : -1;
    reg.tilt = Math.max(0, 0.45 * Math.abs(reg.lat) + gauss() * 0.14);
    reg.frame = regionFrame(reg);
    // The rest of the region (its sources and strands) from a stream of its own, so
    // where the regions are does not change when what is in them does.
    var mainRand = rand;
    rand = mulberry32(Math.floor(mainRand() * 4294967296));
    reg.parts = makeParts(reg);
    regions.push(reg);
    updateRegionState(reg);

    var want = Math.round(REGION.strands[small ? 1 : 0] * (0.6 + 0.8 * size));
    for (var i = 0; i < want; i++) {
      var s = allocSlot(reg);
      if (s < 0) { break; }
      reg.slots.push(s);
      var m = meta[s];
      heating(m);
      pickRegionFoot(reg, m);
      // Traced at load: shown at once. Later ones fade in as they come up.
      m.born = now === undefined ? -1e9 : now;
      queueTrace(s, now === undefined ? 2 : 1);
    }
    rand = mainRand;
    return reg;
  }

  // How far a region has come: e (emerged, 0-1) and k (decayed, 0-1).
  function updateRegionState(reg) {
    var a = reg.age;
    reg.e = smooth(0, reg.emerge, a);
    reg.k = smooth(reg.emerge + reg.mature, reg.emerge + reg.mature + reg.decay, a);
    reg.stage = reg.e < 0.98 ? 'Emerging' : reg.k > 0.04 ? 'Decaying' : 'Stable';
    var f = reg.frame;
    reg.eff = reg.parts.map(function (p) {
      var e = reg.e, k = reg.k, ps, qs, ds;
      if (p.spot) {
        ps = (0.35 + 0.65 * e) * (1 + 0.45 * k);
        qs = Math.pow(e, 1.5) * Math.pow(1 - k, 1.6);
        ds = (0.5 + 0.5 * e) * (1 + 0.9 * k);
      } else {
        ps = (0.35 + 0.65 * e) * (1 + 1.3 * k);
        qs = e * (1 + 1.4 * k) * (1 - 0.8 * k);
        ds = 1 + 0.6 * k;
      }
      var dir = offset(f.c, f.a, f.b, p.u * reg.sep * ps, p.v * reg.sep * ps);
      var d = reg.depth * p.df * ds;
      return { dir: dir, q: p.q * qs, d: d, spot: p.spot };
    });
  }

  // A footpoint: a positive source (or, a third of the time, a negative one to trace
  // backwards from), weighted by its charge, and a scatter around it as wide as it is deep.
  function pickRegionFoot(reg, m) {
    var want = rand() < 0.68 ? 1 : -1;
    var total = 0, i;
    var w = reg.parts.map(function (p) {
      var x = p.q * reg.hale * want > 0 ? Math.pow(Math.abs(p.q), 0.7) * (p.spot ? 1 : 1.5) : 0;
      total += x;
      return x;
    });
    var r = rand() * total;
    for (i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) { break; } }
    m.part = Math.min(i, w.length - 1);
    var p = reg.parts[m.part];
    var spread = reg.depth * p.df * (p.spot ? 0.9 : 0.75);
    m.offA = gauss() * spread;
    m.offB = gauss() * spread;
    m.sign = (p.q > 0 ? 1 : -1);
  }

  /* ---------- Ephemeral regions ---------- */

  var ephemerals = [];

  function spawnEphemeral(now, age) {
    var c = randomDir();
    var tangent = norm(cross(c, randomDir()));
    var b = cross(c, tangent);
    var sep = between(EPHEMERAL.sep[0], EPHEMERAL.sep[1]);
    var d = between(EPHEMERAL.depth[0], EPHEMERAL.depth[1]);
    var q = between(EPHEMERAL.peak[0], EPHEMERAL.peak[1]) * d * d;
    var life = between(EPHEMERAL.life[0], EPHEMERAL.life[1]);
    var er = {
      c: c, a: tangent, b: b, sep: sep, d: d, q: q,
      born: now - (age || 0), life: life, slots: []
    };
    er.pos = offset(c, tangent, b, sep / 2, 0);
    er.neg = offset(c, tangent, b, -sep / 2, 0);
    ephemerals.push(er);
    return er;
  }

  function ephemeralStrands(er) {
    var n = EPHEMERAL.strands[small ? 1 : 0];
    for (var i = 0; i < n; i++) {
      var s = allocSlot(er);
      if (s < 0) { return; }
      er.slots.push(s);
      var m = meta[s];
      heating(m);
      m.impulsive = false;
      m.offA = gauss() * er.d * 0.8;
      m.offB = gauss() * er.d * 0.8;
      m.born = er.born + 2;
      m.end = er.born + er.life;
      queueTrace(s, 1);
    }
  }

  /* ---------- Rebuilding the source list ---------- */

  function rebuildSources(gpu) {
    srcCount = 0;
    groupCount = 0;
    var g = beginGroup(0);
    addSource(0, 0, 1 - POLAR_DEPTH, -POLAR_Q * northSign);
    addSource(0, 0, -(1 - POLAR_DEPTH), POLAR_Q * northSign);
    endGroup(g, 1);
    regions.forEach(function (reg) {
      var gg = beginGroup(1);
      reg.eff.forEach(function (p) {
        if (Math.abs(p.q) < 1e-7) { return; }
        var r = 1 - p.d;
        addSource(p.dir[0] * r, p.dir[1] * r, p.dir[2] * r, p.q);
      });
      endGroup(gg, 4);
    });
    // Everything above goes to the GPU too; the ephemeral regions only shape the
    // bright points, and are left to the tracer.
    if (gpu !== false) {
      // The GPU gets the same sources and groups, as two rows of a float texture.
      var a = model.sources;
      for (var i = 0; i < srcCount * 4; i++) { a[i] = src[i]; }
      var gg2 = model.groups;
      for (var j = 0; j < groupCount; j++) {
        var o = j * GS, w = j * 12;
        gg2[w] = groups[o]; gg2[w + 1] = groups[o + 1]; gg2[w + 2] = groups[o + 2]; gg2[w + 3] = groups[o + 3];
        gg2[w + 4] = groups[o + 4]; gg2[w + 5] = groups[o + 5]; gg2[w + 6] = groups[o + 6]; gg2[w + 7] = groups[o + 7];
        gg2[w + 8] = groups[o + 8]; gg2[w + 9] = groups[o + 9]; gg2[w + 10] = groups[o + 10]; gg2[w + 11] = groupMode[j];
      }
      model.sourceCount = srcCount;
      model.groupCount = groupCount;
      model.sourcesVersion++;
    }
    ephemerals.forEach(function (er) {
      var ge = beginGroup(2);
      var rp = 1 - er.d;
      addSource(er.pos[0] * rp, er.pos[1] * rp, er.pos[2] * rp, er.q);
      addSource(er.neg[0] * rp, er.neg[1] * rp, er.neg[2] * rp, -er.q);
      endGroup(ge, 5);
    });
  }
  var northSign = -1; // the north polar field has the northern following spots' polarity

  /* ---------- The retrace queue ---------- */

  // Three priorities: 0 flares, 1 new strands and changing regions, 2 the rest.
  var queues = [[], [], []];
  var queued = null;

  function queueTrace(s, pri) {
    if (queued[s]) { return; }
    queued[s] = 1;
    queues[pri].push(s);
  }

  function nextQueued() {
    for (var p = 0; p < 3; p++) {
      while (queues[p].length) {
        var s = queues[p].shift();
        queued[s] = 0;
        return s;
      }
    }
    return -1;
  }

  // Footpoint of a slot, from what owns it, on the surface as it is now.
  function footOf(s) {
    var m = meta[s];
    var o = m.owner;
    if (!o) { return null; }
    if (o.kind === 'global') { return m.foot; }
    if (o.parts) {
      var p = o.eff[m.part];
      var f = o.frame;
      return offset(p.dir, f.a, f.b, m.offA, m.offB);
    }
    if (o.pos) { return offset(o.pos, o.a, o.b, m.offA, m.offB); }
    if (o.ribbon) { return m.foot; }
    return null;
  }

  function retrace(s, now) {
    var m = meta[s];
    if (!m || !m.owner || m.retiring) { return; }
    var o = m.owner;
    if (o.ribbon || o.spine) { return; } // flares and filaments lay their own strands
    var foot = footOf(s);
    if (!foot) { setEmpty(s); return; }
    var sign = o.pos ? 1 : m.sign;
    if (o.kind === 'global') { sign = m.sign; }
    var x = foot[0] * 1.0004, y = foot[1] * 1.0004, z = foot[2] * 1.0004;
    var B0 = fieldStrength(x, y, z);
    var hmax = o.pos ? 0.004 : 0.03;
    var res = trace(x, y, z, sign, hmax);
    if (res === 0) {
      // Pointing into the surface: try a fresh footpoint next time round.
      if (o.parts) { pickRegionFoot(o, m); }
      if (o.kind === 'global') { m.foot = null; }
      setEmpty(s);
      return;
    }
    var open = res === 2;
    if (open && o.pos) { setEmpty(s); return; } // a bright point that got away
    var last = (trN - 1) * 3;
    var B1 = open ? B0 : fieldStrength(tr[last] * 1.0004, tr[last + 1] * 1.0004, tr[last + 2] * 1.0004);
    var geo = resample(s, open);
    if (!geo) { setEmpty(s); return; }
    var B = 0.5 * (B0 + B1);
    var wasEmpty = m.kind === KIND.EMPTY;
    settle(m, geo.length, geo.apex, B, open);
    if (o.parts) {
      // Emerging flux: low, cool arches (the arch filament system) until it is half up.
      if (o.e < 0.55 && !open && geo.apex < 0.03) {
        m.kind = KIND.ARCH;
        m.logT = 4.85; m.floor = 4.85; m.rain = 0;
        m.gain = 0.6;
      } else {
        m.kind = open ? KIND.FAN : KIND.LOOP;
        // Flux still coming up has barely filled its loops.
        m.gain *= 0.3 + 0.7 * smooth(0.3, 0.8, o.e);
      }
      m.width = (open ? 0.0042 : 0.0029) * m.widthScale;
    } else if (o.pos) {
      m.kind = KIND.POINT;
      m.logT = 6.22 + m.scatter;
      m.floor = m.logT - 0.12;
      m.gain = coronaN(geo.length, B) * 1.6;
      m.width = 0.0022 * m.widthScale;
    } else {
      m.kind = open ? KIND.FAN : KIND.LOOP;
      m.width = (open ? 0.006 : 0.0055) * m.widthScale;
      m.gain *= 0.55;
    }
    if (wasEmpty && m.born > -1e8 && !o.pos) { m.born = now; }
    writeParams(s);
  }

  /* ---------- Global strands ---------- */

  var globalOwner = { kind: 'global', slots: [] };

  function pickGlobalFoot(m) {
    for (var t = 0; t < 30; t++) {
      var v = randomDir();
      var br = radialField(v);
      if (Math.abs(br) > 2.5) {
        m.foot = v;
        m.sign = br > 0 ? 1 : -1;
        return true;
      }
    }
    return false;
  }

  /* ---------- Filaments ---------- */

  var filaments = [];

  // The polarity inversion line through a point, as a list of points along B_r = 0.
  function inversionLine(start, maxLen, step) {
    function grad(v) {
      var t1 = norm(cross(v, Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
      var t2 = cross(v, t1);
      var e = 0.002;
      var g1 = (radialField(offset(v, t1, t2, e, 0)) - radialField(offset(v, t1, t2, -e, 0))) / (2 * e);
      var g2 = (radialField(offset(v, t1, t2, 0, e)) - radialField(offset(v, t1, t2, 0, -e))) / (2 * e);
      return [t1[0] * g1 + t2[0] * g2, t1[1] * g1 + t2[1] * g2, t1[2] * g1 + t2[2] * g2];
    }
    function snap(v) {
      for (var i = 0; i < 4; i++) {
        var br = radialField(v);
        var g = grad(v);
        var g2 = dot(g, g);
        if (g2 < 1e-6) { return v; }
        v = norm([v[0] - g[0] * br / g2, v[1] - g[1] * br / g2, v[2] - g[2] * br / g2]);
      }
      return v;
    }
    var p0 = snap(start);
    var line = [p0];
    [1, -1].forEach(function (dirSign) {
      var p = p0, len = 0, prevT = null;
      while (len < maxLen / 2) {
        var g = grad(p);
        var t = norm(cross(p, g));
        if (prevT && dot(t, prevT) < 0) { t = [-t[0], -t[1], -t[2]]; }
        if (!prevT) { t = [t[0] * dirSign, t[1] * dirSign, t[2] * dirSign]; }
        prevT = t;
        var q = snap(norm([p[0] + t[0] * step, p[1] + t[1] * step, p[2] + t[2] * step]));
        // Filaments keep out of the strongest field, between the umbrae of a compact pair.
        if (fieldStrength(q[0] * 1.0004, q[1] * 1.0004, q[2] * 1.0004) > 1500) { break; }
        if (Math.abs(radialField(q)) > 25) { break; }
        p = q;
        len += step;
        if (dirSign > 0) { line.push(p); } else { line.unshift(p); }
      }
    });
    return line;
  }

  function spawnFilament(now, preset) {
    // Mostly on decaying regions, where the field has spread and weakened, as quiet
    // filaments do; failing those, an active-region filament on a mature one.
    var cands = regions.filter(function (r) {
      return (!r.filament || (r.filament.failed && now - r.filament.failed > 60)) && r.e > 0.97;
    });
    if (!cands.length) { return null; }
    cands.sort(function (a, b) { return b.k - a.k; });
    var reg = cands[Math.floor(rand() * Math.min(3, cands.length))];
    var f = reg.frame;
    // Between the polarities, nudged off the axis so it finds the long inversion line.
    var start = offset(f.c, f.a, f.b, -0.05 * reg.sep, 0.1 * reg.sep * (rand() - 0.5));
    var spine = inversionLine(start, between(0.14, 0.26), 0.006);
    if (spine.length < 8) { reg.filament = { failed: Math.max(now, 1e-3) }; return null; }
    var fil = {
      region: reg, spine: spine, born: now, end: now + between(FILAMENT.life[0], FILAMENT.life[1]),
      height: between(FILAMENT.height[0], FILAMENT.height[1]), slots: []
    };
    reg.filament = fil;
    filaments.push(fil);
    layThreads(fil, now, preset);
    return fil;
  }

  /*
   * A filament is a hedgerow: near-vertical threads standing along the inversion line,
   * tallest in the middle, with a few threads lying along it and feet (barbs) out to
   * the side. Seen from above it is a dark thread across the disc; seen side-on at the
   * limb it is a prominence.
   */
  function layThreads(fil, now, preset) {
    var n = FILAMENT.threads[small ? 1 : 0];
    var spine = fil.spine;
    var g = model.geom;
    for (var i = 0; i < n; i++) {
      var s = allocSlot(fil);
      if (s < 0) { return; }
      fil.slots.push(s);
      var m = meta[s];
      var kindOf = i < n * 0.72 ? 'post' : i < n * 0.9 ? 'rail' : 'barb';
      var u = rand();
      var at = Math.min(spine.length - 2, Math.floor(u * (spine.length - 1)));
      var p = spine[at], q = spine[at + 1];
      var along = norm([q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
      var side = cross(p, along);
      var envelope = Math.pow(Math.sin(Math.PI * clamp(u, 0.02, 0.98)), 0.6);
      var H = fil.height * envelope * (0.55 + 0.45 * rand());
      var base = s * POINTS * GEOM_STRIDE;
      var lean = gauss() * 0.15;
      var drift = gauss() * 0.004;
      var railH = H * between(0.3, 0.85);
      var across = gauss() * 0.0035;
      var out = rand() < 0.5 ? -1 : 1;
      for (var k = 0; k < POINTS; k++) {
        var t = k / (POINTS - 1);
        var r, pos;
        if (kindOf === 'post') {
          r = 1.002 + H * t;
          pos = offset(p, side, along, across + lean * H * t + 0.0015 * Math.sin(9 * t + i), drift * t);
        } else if (kindOf === 'rail') {
          var j = clamp(u + (t - 0.5) * 0.3, 0, 0.999);
          var idx = Math.min(spine.length - 2, Math.floor(j * (spine.length - 1)));
          var fr = j * (spine.length - 1) - idx;
          var a0 = spine[idx], a1 = spine[idx + 1];
          pos = norm([a0[0] + (a1[0] - a0[0]) * fr, a0[1] + (a1[1] - a0[1]) * fr, a0[2] + (a1[2] - a0[2]) * fr]);
          r = 1.002 + railH * (1 - 0.15 * Math.sin(Math.PI * t));
        } else {
          pos = offset(p, side, along, out * 0.02 * t, 0);
          r = 1.002 + H * 0.5 * (1 - t) * (1 - t);
        }
        var w = base + k * GEOM_STRIDE;
        g[w] = pos[0] * r; g[w + 1] = pos[1] * r; g[w + 2] = pos[2] * r; g[w + 3] = t;
      }
      tangents(s);
      m.kind = KIND.THREAD;
      m.logT = 4.85; m.floor = 4.85;
      m.period = between(14, 30); m.phase = rand() * 30;
      m.gain = between(0.7, 1.3);
      m.width = kindOf === 'post' ? 0.0024 : 0.003;
      m.length = H; m.apex = H;
      m.born = preset ? -1e9 : now + rand() * 4;
      m.end = fil.end;
      m.rain = 0;
      writeParams(s);
    }
  }

  /* ---------- Flares ---------- */

  var flare = null;
  var nextFlare = 0;
  var flareOwner = { ribbon: true, slots: [] };

  function goesClass(flux) {
    var letter = flux >= 1e-4 ? 'X' : flux >= 1e-5 ? 'M' : 'C';
    var base = letter === 'X' ? 1e-4 : letter === 'M' ? 1e-5 : 1e-6;
    return letter + (flux / base).toFixed(1);
  }

  function pickFlareRegion() {
    var total = 0;
    var w = regions.map(function (r) {
      var x = (r.complexity === 'bgd' ? 8 : r.complexity === 'bg' ? 2.5 : 1)
        * (0.4 + r.size) * (r.e < 0.98 ? 0.5 : 1) * (1 - 0.7 * r.k);
      total += x;
      return x;
    });
    var u = rand() * total;
    for (var i = 0; i < regions.length; i++) { u -= w[i]; if (u <= 0) { return regions[i]; } }
    return regions[0] || null;
  }

  /*
   * A flare over a region's main inversion line (the delta spot's, if it has one).
   * The ribbons, two bright strips either side of the line, are drawn by the renderer
   * from the frame given here; the arcade over them is traced here, a few strands a
   * second as the ribbons move apart, each one heated to 10-20 MK and left to cool.
   */
  function startFlare(now, reg) {
    reg = reg || pickFlareRegion();
    if (!reg) { return null; }
    var pos = null, neg = null;
    reg.eff.forEach(function (p) {
      if (!p.spot) { return; }
      var q = p.q * reg.hale;
      if (q > 0 && (!pos || Math.abs(p.q) > Math.abs(pos.q))) { pos = p; }
      if (q < 0 && (!neg || Math.abs(p.q) > Math.abs(neg.q))) { neg = p; }
    });
    if (reg.complexity === 'bgd') { neg = reg.eff[reg.eff.length - 1]; }
    if (!pos || !neg) { return null; }
    var P1 = pos.q > 0 ? pos : neg, N1 = pos.q > 0 ? neg : pos; // by the actual sign
    var c = norm([P1.dir[0] + N1.dir[0], P1.dir[1] + N1.dir[1], P1.dir[2] + N1.dir[2]]);
    var d = [P1.dir[0] - N1.dir[0], P1.dir[1] - N1.dir[1], P1.dir[2] - N1.dir[2]];
    var dist = Math.hypot(d[0], d[1], d[2]);
    var across = norm([d[0] - c[0] * dot(d, c), d[1] - c[1] * dot(d, c), d[2] - c[2] * dot(d, c)]);
    var along = cross(c, across);
    var u = Math.max(1e-6, rand());
    var flux = Math.min(2.2e-4, 1e-6 * Math.pow(u, -1 / 0.9));
    flare = {
      region: reg,
      t0: now,
      life: between(FLARE.life[0], FLARE.life[1]),
      flux: flux,
      cls: goesClass(flux),
      strength: Math.pow(flux / 1e-5, 0.35),
      c: c, across: across, along: along,
      half: clamp(dist * (0.6 + 0.25 * Math.log10(flux / 1e-6)), 0.012, 0.06),
      sep0: Math.min(0.006, dist * 0.18),
      spread: 0.00045 + 0.0002 * Math.log10(flux / 1e-6),
      laid: 0
    };
    reg.flares++;
    return flare;
  }

  // Ribbon separation from the inversion line, at t seconds into the flare.
  function ribbonSep(f, t) {
    return f.sep0 + f.spread * Math.pow(Math.max(0, t), 0.85);
  }

  function stepFlare(now) {
    if (!flare) { return; }
    var t = now - flare.t0;
    var want = FLARE.arcade[small ? 1 : 0];
    // The arcade grows over the first 22 s, a strand at the ribbons' current spread.
    var due = Math.min(want, Math.floor(want * smooth(0.6, 22, t) + (t > 0.6 ? 1 : 0)));
    while (flare.laid < due) {
      flare.laid++;
      var s = allocSlot(flareOwner);
      if (s < 0) { break; }
      var m = meta[s];
      var sep = ribbonSep(flare, t);
      var along = (rand() * 2 - 1) * flare.half * 0.85;
      var foot = offset(flare.c, flare.across, flare.along, sep, along);
      var res = trace(foot[0] * 1.0004, foot[1] * 1.0004, foot[2] * 1.0004, 1, 0.004);
      if (res !== 1) { freeSlot(s); continue; }
      var geo = resample(s, false);
      if (!geo || geo.apex > 0.25) { freeSlot(s); continue; }
      flareOwner.slots.push(s);
      m.kind = KIND.FLARE;
      m.logT = 7.05 + 0.1 * rand() + 0.08 * Math.log10(flare.flux / 1e-5);
      m.floor = 4.6;
      m.period = 1;
      m.phase = 0;
      m.gain = 2.2 * flare.strength * (0.7 + 0.6 * rand());
      m.width = 0.0026 * Math.exp(0.25 * gauss());
      m.length = geo.length; m.apex = geo.apex;
      m.born = now;
      m.end = now + between(24, 32);
      m.rain = 1;
      writeParams(s);
    }
    if (t > flare.life + 2) {
      flare.region = null;
      flare = null;
    }
  }

  // Flare strands are freed once they have cooled and rained out.
  function sweepFlareSlots(now) {
    flareOwner.slots = flareOwner.slots.filter(function (s) {
      if (meta[s].end + 1 < now) { freeSlot(s); return false; }
      return true;
    });
  }

  /* ---------- Spicules ---------- */

  // Root direction and length, then a lean (a tangent vector) and a phase. They are
  // drawn only close up, at the limb; see the renderer.
  function makeSpicules(n) {
    var a = new Float32Array(n * 8);
    for (var i = 0; i < n; i++) {
      var d = randomDir();
      var t = norm(cross(d, randomDir()));
      var lean = Math.abs(gauss()) * 0.28;
      var o = i * 8;
      a[o] = d[0]; a[o + 1] = d[1]; a[o + 2] = d[2];
      a[o + 3] = between(0.006, 0.016) * (rand() < 0.15 ? 1.5 : 1);
      a[o + 4] = t[0] * lean; a[o + 5] = t[1] * lean; a[o + 6] = t[2] * lean;
      a[o + 7] = rand();
    }
    return a;
  }

  /* ---------- Region descriptions for the cards ---------- */

  var HALE = { b: 'β', bg: 'βγ', bgd: 'βγδ' };

  function describe(reg) {
    var area = 0, peakB = 0, flux = 0, bigSpot = 0;
    reg.eff.forEach(function (p) {
      var b = Math.abs(p.q) / (p.d * p.d);
      if (p.q > 0) { flux += p.q; }
      if (!p.spot) { return; }
      peakB = Math.max(peakB, b);
      if (b > 800) {
        var rp = p.d * Math.sqrt(Math.pow(b / 800, 2 / 3) - 1);
        area += Math.PI * rp * rp;
        bigSpot = Math.max(bigSpot, rp);
      }
    });
    var msh = area / (2 * Math.PI) * 1e6;
    var extentDeg = reg.sep * (0.35 + 0.65 * reg.e) * (1 + 0.45 * reg.k) * 180 / Math.PI + 2;
    var penumbra = peakB < 1500 ? 'x' : peakB < 1800 ? 'r' : 0;
    var diamDeg = 2 * bigSpot * 180 / Math.PI;
    var z;
    if (peakB < 1500) { z = reg.k > 0.6 ? 'A' : 'B'; } else if (reg.k > 0.75) { z = 'H'; } else if (reg.e < 0.6) { z = 'C'; } else {
      z = extentDeg < 10 ? 'D' : extentDeg < 15 ? 'E' : 'F';
    }
    if (!penumbra) {
      penumbra = diamDeg > 2.5 ? (reg.complexity === 'b' ? 'h' : 'k') : (reg.complexity === 'b' ? 's' : 'a');
    }
    var compact = z === 'A' || z === 'H' ? 'x' : reg.complexity === 'bgd' ? 'c' : reg.complexity === 'bg' ? 'i' : 'o';
    var tmin = 9, tmax = 0;
    reg.slots.forEach(function (s) {
      var m = meta[s];
      if (m.kind === KIND.LOOP || m.kind === KIND.FAN) {
        tmin = Math.min(tmin, m.logT);
        tmax = Math.max(tmax, m.logT);
      }
    });
    return {
      name: 'Region ' + reg.letter,
      hale: z === 'A' || z === 'H' ? 'α' : HALE[reg.complexity],
      mcintosh: z + (z === 'A' || z === 'B' ? 'x' : penumbra) + (z === 'A' ? 'x' : compact),
      area: Math.round(msh / 10) * 10,
      peakB: Math.round(peakB / 50) * 50,
      flux: flux * MX_PER_Q,
      stage: flare && flare.region === reg ? 'Flaring' : reg.stage,
      tmin: tmax > 0 ? Math.pow(10, tmin) / 1e6 : 0,
      tmax: tmax > 0 ? Math.pow(10, tmax) / 1e6 : 0
    };
  }

  /* ---------- Build and step ---------- */

  var small = false;
  var timeAcc = 0;
  var lastSourceRebuild = -1;

  function build(isSmall, seed) {
    small = !!isSmall;
    rand = mulberry32(seed || P.SEED);
    var nSlots = REGION.strands[small ? 1 : 0] * (REGION.count[small ? 1 : 0] + 3)
      + EPHEMERAL.count[small ? 1 : 0] * EPHEMERAL.strands[small ? 1 : 0]
      + GLOBAL_STRANDS[small ? 1 : 0]
      + FLARE.pool[small ? 1 : 0]
      + FILAMENT.count[small ? 1 : 0] * FILAMENT.threads[small ? 1 : 0] * 2;
    model = {
      params: P,
      SPIN: SPIN,
      KIND: KIND,
      THERMAL: THERMAL,
      POINTS: POINTS,
      GEOM_STRIDE: GEOM_STRIDE,
      PAR_STRIDE: PAR_STRIDE,
      slots: nSlots,
      geom: new Float32Array(nSlots * POINTS * GEOM_STRIDE),
      par: new Float32Array(nSlots * PAR_STRIDE),
      dirty: [],
      sources: new Float32Array(4 * 512),
      sourceCount: 0,
      groups: new Float32Array(12 * 64),
      groupCount: 0,
      sourcesVersion: 0,
      spicules: makeSpicules(SPICULES[small ? 1 : 0]),
      spiculeCount: SPICULES[small ? 1 : 0],
      time: 0,
      regions: regions,
      filaments: filaments,
      flare: null,
      step: step,
      triggerFlare: function () { if (!flare) { startFlare(model.time); model.flare = flare; } },
      describe: describe,
      ribbonSep: ribbonSep,
      dirtyFlagClear: function (s) { dirtyFlag[s] = 0; },
      pending: pending,
      strandCount: strandCount
    };
    dirtyFlag = new Uint8Array(nSlots);
    queued = new Uint8Array(nSlots);
    meta = new Array(nSlots);
    freeSlots = [];
    for (var s = nSlots - 1; s >= 0; s--) { meta[s] = newMeta(); freeSlots.push(s); }

    // A star caught mid-life: regions at every age, a couple still coming up.
    var count = REGION.count[small ? 1 : 0];
    for (var i = 0; i < count; i++) {
      var age;
      if (i < 2) {
        age = between(10, 40);
      } else {
        var reg0 = { emerge: 60, mature: 210, decay: 210 };
        age = reg0.emerge + rand() * (reg0.mature + reg0.decay * 0.75);
      }
      spawnRegion(age);
    }
    var ne = EPHEMERAL.count[small ? 1 : 0];
    for (var j = 0; j < ne; j++) { spawnEphemeral(0, rand() * 60); }
    rebuildSources();
    ephemerals.forEach(ephemeralStrands);
    var ng = GLOBAL_STRANDS[small ? 1 : 0];
    for (var k = 0; k < ng; k++) {
      var gs = allocSlot(globalOwner);
      if (gs < 0) { break; }
      globalOwner.slots.push(gs);
      var gm = meta[gs];
      heating(gm);
      gm.impulsive = false;
      gm.born = -1e9;
      if (pickGlobalFoot(gm)) { queueTrace(gs, 2); }
    }
    for (var f = 0; filaments.length < FILAMENT.count[small ? 1 : 0] && f < 8; f++) { spawnFilament(0, true); }
    nextFlare = between(FLARE.first[0], FLARE.first[1]);
    return model;
  }

  function pending() {
    return queues[0].length + queues[1].length + queues[2].length;
  }

  function strandCount() {
    var n = 0;
    for (var s = 0; s < meta.length; s++) {
      var k = meta[s].kind;
      if (k === KIND.LOOP || k === KIND.FAN || k === KIND.POINT || k === KIND.FLARE || k === KIND.ARCH) { n++; }
    }
    return n;
  }

  /*
   * Advances the star by dt seconds and traces for at most `budget` milliseconds.
   * opts.flares: schedule flares on their own (off for reduced motion).
   */
  function step(dt, budget, opts) {
    var now = model.time + dt;
    model.time = now;
    timeAcc += dt;
    var changed = false;

    // Regions age; the dead are replaced.
    for (var i = regions.length - 1; i >= 0; i--) {
      var reg = regions[i];
      reg.age += dt;
      var total = reg.emerge + reg.mature + reg.decay;
      if (reg.age >= total) {
        reg.slots.forEach(function (s) { retire(s, now); });
        if (reg.filament && reg.filament.slots) {
          reg.filament.end = Math.min(reg.filament.end, now + 3);
        }
        regions.splice(i, 1);
        changed = true;
        continue;
      }
      if (reg.e < 1 || reg.k > 0) {
        updateRegionState(reg);
        changed = true;
      }
    }
    while (regions.length < REGION.count[small ? 1 : 0]) {
      spawnRegion(0, now);
      changed = true;
    }

    // The field changes continuously while regions grow or decay; the sources are
    // rebuilt a few times a second, and the strands of the changing regions retraced.
    if (changed && now - lastSourceRebuild > 0.25) {
      lastSourceRebuild = now;
      rebuildSources();
      regions.forEach(function (r) {
        if (r.e < 1 || r.k > 0) {
          for (var c = 0; c < 8 && r.slots.length; c++) {
            r.cursor = (r.cursor + 1) % r.slots.length;
            queueTrace(r.slots[r.cursor], 1);
          }
        }
      });
      if (globalOwner.slots.length) {
        for (var gq = 0; gq < 3; gq++) {
          globalCursor = (globalCursor + 1) % globalOwner.slots.length;
          var gs = globalOwner.slots[globalCursor];
          if (!meta[gs].foot) { pickGlobalFoot(meta[gs]); }
          if (meta[gs].foot) { queueTrace(gs, 2); }
        }
      }
    }

    // Ephemeral regions come and go.
    for (var e = ephemerals.length - 1; e >= 0; e--) {
      var er = ephemerals[e];
      if (now > er.born + er.life) {
        er.slots.forEach(function (s) { freeSlot(s); });
        ephemerals.splice(e, 1);
        var fresh = spawnEphemeral(now, 0);
        rebuildSourcesSoon = true;
        pendingEphemerals.push(fresh);
      }
    }
    if (rebuildSourcesSoon) {
      rebuildSourcesSoon = false;
      rebuildSources(false);
      pendingEphemerals.forEach(ephemeralStrands);
      pendingEphemerals = [];
    }

    // Filaments.
    for (var fi = filaments.length - 1; fi >= 0; fi--) {
      var fil = filaments[fi];
      if (now > fil.end + 1) {
        fil.slots.forEach(function (s) { freeSlot(s); });
        if (fil.region) { fil.region.filament = null; }
        filaments.splice(fi, 1);
      }
    }
    if (filaments.length < FILAMENT.count[small ? 1 : 0] && Math.floor(now) % 7 === 0
      && Math.floor(now - dt) % 7 !== 0) {
      spawnFilament(now, false);
    }

    // Flares.
    if (opts && opts.flares && !flare && now >= nextFlare) {
      startFlare(now);
      nextFlare = now + between(FLARE.gap[0], FLARE.gap[0] + 10) - Math.log(1 - rand() * 0.999) * FLARE.gap[1];
    }
    stepFlare(now);
    model.flare = flare;
    sweepFlareSlots(now);

    // Retiring slots are freed once faded.
    retiring = retiring.filter(function (s) {
      if (meta[s].end + 0.5 < now) { freeSlot(s); return false; }
      return true;
    });

    // Trace within the budget.
    var t0 = performance.now();
    var n = 0;
    while (performance.now() - t0 < budget) {
      var s = nextQueued();
      if (s < 0) { break; }
      retrace(s, now);
      n++;
    }
    return n;
  }
  var globalCursor = 0;
  var rebuildSourcesSoon = false;
  var pendingEphemerals = [];

  function thousands(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return {
    params: P,
    SPIN: SPIN,
    KIND: KIND,
    THERMAL: THERMAL,
    build: build,
    thousands: thousands
  };
})();
