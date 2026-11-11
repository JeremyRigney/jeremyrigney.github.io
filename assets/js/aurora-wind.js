/*
 * jeremy.ie/aurora — the solar wind: NOAA's model of it from the Sun out past the
 * Earth, and what it meets on arrival. Everything here is numbers; aurora-wind-view.js
 * draws them.
 *
 * THE MODEL. WSA-Enlil is what NOAA's Space Weather Prediction Center forecasts the
 * solar wind with. A run is 130 MB, so tools/build-aurora-wind.py reduces each one to
 * two files and a scheduled workflow publishes them to this repository's aurora-data
 * branch (see that script's header for the format):
 *
 *   wind.json   the run, its frame times and axes, and the series at the Earth;
 *   wind.png    radial speed, a byte a value, a tile a frame: the cut through the
 *               Earth's latitude, which seen from the north is the pinwheel.
 *
 * The json is small and fetched at once, then every half hour. The png is fetched when
 * the page is idle, or sooner if the reader scrolls toward the views that draw it, and
 * again only when the run changes. The model's coordinates keep the Earth at longitude
 * 0, so the Sun's rotation carries the spiral past it.
 *
 * AT THE EARTH. What the wind does to the magnetosphere is worked out from what is
 * measured at L1, an hour upstream (aurora-data.js already has it), carried forward by
 * its own speed. Beyond what L1 has seen, the model's series at the Earth stands in,
 * with Bz taken as zero: no model forecasts Bz.
 *
 *   Magnetopause   Shue et al. (1998): r = r0 (2 / (1 + cos t))^a, t the angle from the
 *                  Sun-Earth line, with r0 = (10.22 + 1.29 tanh(0.184 (Bz + 8.14)))
 *                  Pd^(-1/6.6) Earth radii and a = (0.58 - 0.007 Bz)(1 + 0.024 ln Pd),
 *                  Bz in nT and Pd the dynamic pressure in nPa.
 *   Bow shock      Its nose stands off the magnetopause's by Farris and Russell (1994):
 *                  1 + 1.1 ((g - 1) M^2 + 2) / ((g + 1)(M^2 - 1)), M the magnetosonic
 *                  Mach number and g = 5/3. Its shape is the magnetopause's own form
 *                  with BS_FLARE more flare. On a quiet day that puts it where Farris et
 *                  al.'s (1991) conic (eccentricity 0.81) does at the terminator, 1.8
 *                  times the nose; unlike that ellipse it never closes behind the Earth,
 *                  and it cannot cross the magnetopause however that flares in a storm.
 *   Pressure       2e-6 n v^2 nPa, n per cm^3 and v in km/s: OMNI's convention, which
 *                  allows for the wind's helium.
 *
 * The field lines are a sketch, not a field model: a dipole at the day's true tilt,
 * deformed until its last closed line (FIELD_LMAX, from 74.5 degrees) just fits inside
 * that magnetopause. Two deformations, both growing with distance so that near the
 * Earth the lines stay the dipole's own: radially, squeezed on the day side and
 * stretched on the night side; and in angle, swept back toward the tail. Lines from
 * nearer the pole than the last closed one run back to the tail's magnetopause and are
 * left open. Each deformation is one-to-one, so no two lines cross, and none leaves
 * the magnetopause, whatever the wind is doing.
 *
 * The flow through the sheath is a sketch too, but one that conserves what it carries.
 * It comes from a stream function: the wind's own (its height above the Sun-Earth
 * line) outside the shock, zero on the magnetopause, and between them falling in
 * proportion to depth, so a streamline that meets the shock at some height carries on
 * from there and drapes round the magnetopause without ever crossing it. Behind the
 * shock the wind is taken as SHEATH_DENSITY times denser, about what a strong shock
 * gives, and slower by as much: streaks drawn along this flow bunch and slow at the
 * shock, stall at the nose and quicken round the sides to nearly the wind's own speed,
 * as the real sheath does. Far down the flanks the real sheath thins out again and
 * this one doesn't, so there it runs slow.
 *
 * THE PLANETS are placed from JPL's approximate elements (Standish, valid 1800-2050),
 * good to a few arcminutes, as longitudes from the Earth's.
 *
 * ?wind=http://localhost:PORT reads the two files from a local server instead.
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : this;
  var DEG = Math.PI / 180;

  /* ---------- At the Earth: pressure, boundaries, field, flow ---------- */

  var L1_KM = 1.5e6;
  var GAMMA = 5 / 3;
  var BS_FLARE = 0.28; // the shock's flaring exponent over the magnetopause's
  var TE_K = 1.4e5; // electron temperature, which L1 doesn't report: the usual 1 AU value
  var TP_K = 1.0e5; // proton temperature when none is given

  function clamp(x, a, b) {
    return Math.max(a, Math.min(b, x));
  }

  function smooth(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function tanh(x) {
    var e = Math.exp(2 * x);
    return (e - 1) / (e + 1);
  }

  // Dynamic pressure, nPa.
  function pressure(n, v) {
    return 2e-6 * n * v * v;
  }

  // Magnetosonic Mach number: the wind's speed over what a compression travels at.
  function mach(v, n, bt, tempK) {
    var alfven = n > 0 ? 21.81 * (bt || 0) / Math.sqrt(n) : 0; // km/s
    var sound = 0.1173 * Math.sqrt((tempK > 0 ? tempK : TP_K) + TE_K); // km/s
    return v / Math.sqrt(alfven * alfven + sound * sound);
  }

  // Both boundaries for the conditions upstream: { v, n, bz, bt, temp } or with pd and
  // mach already worked out. Missing values fall back to an ordinary day's.
  function boundaries(up) {
    up = up || {};
    var v = up.v > 0 ? up.v : 420, n = up.n > 0 ? up.n : 5;
    var bz = isFinite(up.bz) ? up.bz : 0;
    var pd = clamp(up.pd > 0 ? up.pd : pressure(n, v), 0.2, 80);
    var m = clamp(up.mach > 0 ? up.mach : mach(v, n, up.bt, up.temp), 1.6, 40);
    var r0 = (10.22 + 1.29 * tanh(0.184 * (bz + 8.14))) * Math.pow(pd, -1 / 6.6);
    var alpha = (0.58 - 0.007 * bz) * (1 + 0.024 * Math.log(pd));
    var off = 1 + 1.1 * ((GAMMA - 1) * m * m + 2) / ((GAMMA + 1) * (m * m - 1));
    return { r0: r0, alpha: alpha, bs0: r0 * off, bsAlpha: alpha + BS_FLARE, pd: pd, mach: m, bz: bz };
  }

  // The magnetopause's distance at angle t (radians) from the Sun-Earth line, and how
  // fast that grows with t. Even in t; unbounded straight down the tail.
  function mpR(b, t) {
    return b.r0 * Math.pow(2 / (1 + Math.cos(t)), b.alpha);
  }

  function mpDr(b, t) {
    return mpR(b, t) * b.alpha * Math.sin(t) / (1 + Math.cos(t));
  }

  function bsR(b, t) {
    return b.bs0 * Math.pow(2 / (1 + Math.cos(t)), b.bsAlpha);
  }

  function bsDr(b, t) {
    return bsR(b, t) * b.bsAlpha * Math.sin(t) / (1 + Math.cos(t));
  }

  /*
   * The field lines, in the plane of the Sun-Earth line and the ecliptic's north: x
   * toward the Sun, z north, Earth radii. tilt is the dipole axis's lean from z toward
   * the Sun, radians. Returns [{ pts: [x0, z0, x1, z1, ...], open: bool }]; an open
   * line runs from the polar cap to the magnetopause and should be drawn fading out.
   */
  var FIELD_LMAX = 14; // the last closed line's equatorial distance before squeezing
  var FIELD_FIT = 0.97; // it sits this far out to the magnetopause
  var FIELD_TAIL = 70; // and no further down the tail than this
  var FIELD_CLOSED = [1.6, 2.4, 3.4, 4.6, 6, 7.5, 9, 10.5, 12, 13.2, 14];
  var FIELD_OPEN = [77, 80, 83.5, 87]; // footpoint latitudes of the lobe lines, degrees
  var FIELD_STEPS = 96;

  var FIELD_SWEEP = 0.55; // how far toward the tail the outermost points are turned

  // Where the dipole's point at distance rho and angle t from the Sun-Earth line goes:
  // [distance, angle]. Its angle first, in two turns, neither touching the day side
  // and both growing with distance. The hinge: the night side is turned back by the
  // dipole's tilt, so the tail trails straight down the wind however the dipole leans,
  // as the real one does beyond about ten Earth radii. The sweep: what is left is
  // drawn toward the tail's axis. Then its distance, so that rho = FIELD_LMAX lands
  // just inside the magnetopause in every direction. Where that is a stretch it grows
  // as the cube of distance; where it is a squeeze it saturates, so a magnetopause
  // pushed inside the dipole's own lines still holds them all.
  function deform(b, rho, t, tilt) {
    var u = Math.min(1, rho / FIELD_LMAX);
    var hinged = t + tilt * smooth(0.2, 0.8, u) * smooth(60 * DEG, 150 * DEG, Math.abs(t));
    if (hinged > Math.PI) { hinged -= 2 * Math.PI; } else if (hinged < -Math.PI) { hinged += 2 * Math.PI; }
    var at = Math.abs(hinged);
    var turned = at + FIELD_SWEEP * u * u * smooth(50 * DEG, 100 * DEG, at) * (Math.PI - at);
    t = hinged;
    var c = FIELD_FIT * Math.min(mpR(b, turned), FIELD_TAIL) / FIELD_LMAX;
    var r;
    if (c >= 1) {
      r = rho * (1 + u * u * u * (c - 1));
    } else {
      var k3 = (1 / (c * c * c) - 1) * u * u * u; // (k rho)^3, with k set by rho = FIELD_LMAX
      r = rho / Math.pow(1 + k3, 1 / 3);
    }
    return [r, t < 0 ? -turned : turned];
  }

  function fieldLines(b, tilt) {
    var ax = Math.sin(tilt), az = Math.cos(tilt); // the dipole axis
    var ex = Math.cos(tilt), ez = -Math.sin(tilt); // its equator, toward the Sun
    var lines = [];

    function point(L, lat, side, out) {
      var rho = L * Math.cos(lat) * Math.cos(lat);
      var qx = side * Math.cos(lat) * ex + Math.sin(lat) * ax;
      var qz = side * Math.cos(lat) * ez + Math.sin(lat) * az;
      var p = deform(b, rho, Math.atan2(qz, qx), tilt);
      out.push(p[0] * Math.cos(p[1]), p[0] * Math.sin(p[1]));
    }

    FIELD_CLOSED.forEach(function (L) {
      var foot = Math.acos(Math.sqrt(1 / L));
      [1, -1].forEach(function (side) {
        var pts = [];
        for (var i = 0; i <= FIELD_STEPS; i++) {
          // Even steps in latitude would spend most of the points near the feet, where
          // the line hardly moves, and leave corners on the far loop. Crowd them there.
          var s = i / FIELD_STEPS * 2 - 1;
          point(L, foot * s * (0.3 + 0.7 * Math.abs(s)), side, pts);
        }
        lines.push({ pts: pts, open: false, L: L, side: side });
      });
    });

    // The lobes: from each polar cap back into the tail, as far as the magnetopause.
    FIELD_OPEN.forEach(function (footDeg) {
      var foot = footDeg * DEG;
      var L = 1 / (Math.cos(foot) * Math.cos(foot));
      var end = Math.acos(Math.sqrt(FIELD_LMAX / L));
      [1, -1].forEach(function (hemi) {
        var pts = [];
        for (var i = 0; i <= FIELD_STEPS; i++) {
          var k = i / FIELD_STEPS;
          point(L, hemi * (foot + (end - foot) * k * k), -1, pts);
        }
        lines.push({ pts: pts, open: true, L: L, side: -1 });
      });
    });
    return lines;
  }

  // The dipole's lean toward the Sun, radians, from the geomagnetic pole, the Sun and
  // the ecliptic's north, all in globe coordinates. What leans out of the plane is dropped.
  function dipoleTilt(magPole, sun, pole) {
    var x = magPole[0] * sun[0] + magPole[1] * sun[1] + magPole[2] * sun[2];
    var z = magPole[0] * pole[0] + magPole[1] * pole[1] + magPole[2] * pole[2];
    return Math.atan2(x, z);
  }

  /*
   * The wind's velocity at (x, z), as a fraction of its speed upstream: [vx, vz], or
   * null inside the magnetopause, where there is none. x toward the Sun, so the
   * undisturbed wind is [-1, 0].
   */
  var SHEATH_DENSITY = 3.5; // behind the shock, against the free wind's
  var FLOW_H = 0.02; // Earth radii: the step the stream function is differenced over

  // The stream function, in units of the upstream speed times an Earth radius: z in the
  // free wind, 0 on and inside the magnetopause, odd in z.
  function stream(b, x, z) {
    var r = Math.sqrt(x * x + z * z);
    var t = Math.atan2(Math.abs(z), x); // 0 at the nose, pi down the tail
    var mp = mpR(b, t), bs = bsR(b, t);
    if (!(r < bs)) { return z; }
    if (r <= mp) { return 0; }
    var k = (r - mp) / (bs - mp); // 0 on the magnetopause, 1 on the shock
    var zShock = bs * Math.sin(t);
    return (z < 0 ? -1 : 1) * k * zShock;
  }

  function flow(b, x, z) {
    var r = Math.sqrt(x * x + z * z);
    var t = Math.atan2(Math.abs(z), x);
    if (r < mpR(b, t)) { return null; }
    if (!(r < bsR(b, t))) { return [-1, 0]; }
    // The wind runs along lines of constant stream function, toward -x where it is free.
    var dz = (stream(b, x, z + FLOW_H) - stream(b, x, z - FLOW_H)) / (2 * FLOW_H);
    var dx = (stream(b, x + FLOW_H, z) - stream(b, x - FLOW_H, z)) / (2 * FLOW_H);
    return [-dz / SHEATH_DENSITY, dx / SHEATH_DENSITY];
  }

  /* ---------- The planets ---------- */

  // a (AU), e, I, L, long. of perihelion, long. of node (degrees) at J2000, and each
  // one's change per century.
  var ELEMENTS = {
    mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
    venus: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
      0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
    earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0,
      0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
    mars: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]
  };

  // Heliocentric distance (AU) and ecliptic longitude (degrees) of a planet at a time.
  function planet(name, date) {
    var el = ELEMENTS[name];
    var T = (date.getTime() / 86400000 - 10957.5) / 36525;
    var a = el[0] + el[6] * T, e = el[1] + el[7] * T, inc = (el[2] + el[8] * T) * DEG;
    var L = el[3] + el[9] * T, peri = el[4] + el[10] * T, node = el[5] + el[11] * T;
    var M = (((L - peri) % 360) + 540) % 360 - 180;
    var E = M * DEG;
    for (var i = 0; i < 8; i++) { E -= (E - e * Math.sin(E) - M * DEG) / (1 - e * Math.cos(E)); }
    var xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    var w = (peri - node) * DEG, O = node * DEG;
    var cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(inc);
    var x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;
    var y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;
    return { r: Math.sqrt(xp * xp + yp * yp), lon: ((Math.atan2(y, x) / DEG) + 360) % 360 };
  }

  // The inner planets as the model's frame has them: longitude from the Earth's.
  function planets(date) {
    var earth = planet('earth', date);
    return ['mercury', 'venus', 'earth', 'mars'].map(function (name) {
      var p = name === 'earth' ? earth : planet(name, date);
      return { name: name, r: p.r, lon: (((p.lon - earth.lon) % 360) + 540) % 360 - 180 };
    });
  }

  /* ---------- The model run ---------- */

  var state = {
    meta: null, // wind.json
    times: null, // frame times, ms
    ecl: null, // Uint8Array, [frame][r][lon]: speed at the Earth's latitude
    run: null, // the run the arrays came from (source.file + source.modified)
    atlasMeta: null, // and that run's wind.json, which the arrays are laid out by
    fetchedAt: 0,
    failed: false
  };

  var HOUR = 3600000;
  var STALE_AFTER = 40 * HOUR; // a run comes daily; this is a day and a half without one

  function iso(s) {
    return Date.parse(s);
  }

  function accept(meta) {
    if (!meta || meta.version !== 2 || !meta.atlas || !meta.times) { throw new Error('wind.json: not a format this page knows'); }
    state.meta = meta;
    state.times = meta.times.map(iso);
    var e = meta.earth;
    e.t0 = iso(e.start);
    e.dt = e.step_min * 60000;
  }

  function runKey(meta) {
    return meta.source.file + '@' + meta.source.modified;
  }

  // Bytes to km/s.
  function speedOf(byte) {
    var s = state.meta.speed;
    return s.min + byte / 255 * (s.max - s.min);
  }

  // Where a time falls among the frames: a fractional index, held at either end, and
  // whether the run covers that time at all.
  function frameAt(t) {
    var ts = state.times;
    if (!ts || !ts.length) { return null; }
    if (t <= ts[0]) { return { f: 0, covered: t >= ts[0] - HOUR }; }
    var last = ts.length - 1;
    if (t >= ts[last]) { return { f: last, covered: t <= ts[last] + HOUR }; }
    var lo = 0, hi = last;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (ts[mid] <= t) { lo = mid; } else { hi = mid; }
    }
    return { f: lo + (t - ts[lo]) / (ts[hi] - ts[lo]), covered: true };
  }

  // The model's speed in the ecliptic at (r AU, longitude degrees) and a frame, km/s;
  // null outside the model.
  function speedAt(r, lon, f) {
    var m = state.meta, a = state.ecl;
    if (!m || !a) { return null; }
    var nr = m.r.count, nl = m.lon.count;
    var fr = (r - m.r.first) / m.r.step;
    if (fr < -0.5 || fr > nr - 0.5) { return null; }
    fr = clamp(fr, 0, nr - 1);
    var fl = (lon - m.lon.first) / m.lon.step;
    fl = ((fl % nl) + nl) % nl;
    var r0 = Math.floor(fr), r1 = Math.min(nr - 1, r0 + 1), wr = fr - r0;
    var l0 = Math.floor(fl), l1 = (l0 + 1) % nl, wl = fl - l0;
    var k0 = Math.floor(f), k1 = Math.min(state.times.length - 1, k0 + 1), wk = f - k0;
    function at(k) {
      var base = k * nr * nl;
      var top = a[base + r0 * nl + l0] * (1 - wl) + a[base + r0 * nl + l1] * wl;
      var bot = a[base + r1 * nl + l0] * (1 - wl) + a[base + r1 * nl + l1] * wl;
      return top * (1 - wr) + bot * wr;
    }
    return speedOf(wk > 0 ? at(k0) * (1 - wk) + at(k1) * wk : at(k0));
  }

  // The model's series at the Earth at a time: { speed, density, temperature, b }, or null.
  function earthAt(t) {
    var m = state.meta;
    if (!m) { return null; }
    var e = m.earth;
    var x = (t - e.t0) / e.dt;
    var n = e.speed.length;
    if (x < 0 || x > n - 1) { return null; }
    var i = Math.min(n - 2, Math.floor(x)), w = x - i;
    function lerp(arr) {
      var p = arr[i], q = arr[i + 1];
      if (p == null || q == null) { return p == null ? q : p; }
      return p + (q - p) * w;
    }
    var speed = lerp(e.speed);
    return speed == null ? null : { speed: speed, density: lerp(e.density), temperature: lerp(e.temperature), b: lerp(e.b) };
  }

  function stale() {
    var m = state.meta;
    if (!m) { return true; }
    var now = Date.now();
    return now - iso(m.source.modified) > STALE_AFTER || now > state.times[state.times.length - 1];
  }

  /*
   * What the next days hold at the Earth, by the model: where the speed is now, and its
   * highest and lowest over the span ahead, each with its time. Null without a run that
   * covers now.
   */
  var OUTLOOK_H = 72;
  var RISE = 75; // km/s: less of a change than this over the span is "steady"

  function outlook(now) {
    var here = earthAt(now);
    if (!here) { return null; }
    var e = state.meta.earth;
    var peak = { speed: here.speed, time: now }, low = { speed: here.speed, time: now };
    for (var i = 0; i < e.speed.length; i++) {
      var t = e.t0 + i * e.dt;
      if (t < now || t > now + OUTLOOK_H * HOUR || e.speed[i] == null) { continue; }
      if (e.speed[i] > peak.speed) { peak = { speed: e.speed[i], time: t }; }
      if (e.speed[i] < low.speed) { low = { speed: e.speed[i], time: t }; }
    }
    // When a rise gets going: the first time ahead it is halfway from now to the peak.
    var onset = null;
    if (peak.speed - here.speed >= RISE) {
      for (i = 0; i < e.speed.length; i++) {
        t = e.t0 + i * e.dt;
        if (t >= now && t <= peak.time && e.speed[i] != null && e.speed[i] >= (here.speed + peak.speed) / 2) { onset = t; break; }
      }
    }
    return { now: here.speed, peak: peak, low: low, onset: onset,
      trend: onset !== null ? 'rising' : here.speed - low.speed >= RISE ? 'easing' : 'steady' };
  }

  /* ---------- What reaches the Earth, and when ---------- */

  function median(values) {
    if (!values.length) { return null; }
    var s = values.slice().sort(function (a, b) { return a - b; });
    var h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  // The median of pick(row) over rows (oldest first) timed within span of end.
  function windowed(rows, end, span, pick) {
    var out = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var t = +rows[i].time;
      if (t > end) { continue; }
      if (t < end - span) { break; }
      var v = pick(rows[i]);
      if (v != null && isFinite(v)) { out.push(v); }
    }
    return median(out);
  }

  var WINDOW = 10 * 60000; // L1 is read as a ten-minute median: a minute's reading jitters

  /*
   * The wind at the Earth at time t: { v, n, bz, bt, temp, pd, mach, source, lagMin, seen }.
   * From L1 where L1 has seen it (source 'l1'; seen is when it passed L1), otherwise the
   * model's series ('model', Bz 0). Null when neither has anything.
   * l1 is { wind: [{ time, speed, density, temp }], mag: [{ time, bt, bz }] }, oldest first.
   */
  function upstream(t, l1) {
    var wind = l1 && l1.wind, mag = l1 && l1.mag;
    if (wind && wind.length) {
      var latest = +wind[wind.length - 1].time;
      // The travel time, from the speed about when this wind would have passed L1.
      var guess = windowed(wind, Math.min(latest, t - 50 * 60000), 30 * 60000, function (r) { return r.speed; });
      if (guess > 0) {
        var lag = L1_KM / guess * 1000;
        var seen = t - lag;
        if (seen <= latest + 5 * 60000 && seen >= +wind[0].time) {
          var v = windowed(wind, seen, WINDOW, function (r) { return r.speed; });
          var n = windowed(wind, seen, WINDOW, function (r) { return r.density; });
          if (v > 0 && n > 0) {
            var temp = windowed(wind, seen, WINDOW, function (r) { return r.temp; });
            var bz = mag && mag.length ? windowed(mag, seen, WINDOW, function (r) { return r.bz; }) : null;
            var bt = mag && mag.length ? windowed(mag, seen, WINDOW, function (r) { return r.bt; }) : null;
            return { v: v, n: n, bz: bz, bt: bt, temp: temp, pd: pressure(n, v), mach: mach(v, n, bt, temp),
              source: 'l1', lagMin: lag / 60000, seen: seen };
          }
        }
      }
    }
    var e = earthAt(t);
    if (e && e.speed > 0 && e.density > 0) {
      return { v: e.speed, n: e.density, bz: null, bt: e.b, temp: e.temperature, pd: pressure(e.density, e.speed),
        mach: mach(e.speed, e.density, e.b, e.temperature), source: 'model', lagMin: null, seen: null };
    }
    return null;
  }

  var api = {
    state: state,
    // at the Earth
    pressure: pressure,
    mach: mach,
    boundaries: boundaries,
    mpR: mpR,
    bsR: bsR,
    fieldLines: fieldLines,
    dipoleTilt: dipoleTilt,
    flow: flow,
    upstream: upstream,
    L1_KM: L1_KM,
    FIELD_LMAX: FIELD_LMAX,
    // the planets
    planet: planet,
    planets: planets,
    // the model
    accept: accept,
    frameAt: frameAt,
    speedAt: speedAt,
    speedOf: speedOf,
    earthAt: earthAt,
    outlook: outlook,
    stale: stale,
    ready: function () { return !!(state.meta && state.ecl); },
    want: function () {}
  };
  root.AuroraWind = api;

  /* ---------- Fetching (in a page only) ---------- */

  if (typeof document === 'undefined' || typeof fetch === 'undefined') { return; }

  var BASE = (function () {
    var override = new URLSearchParams(window.location.search).get('wind');
    if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[\w\-./]*)?$/.test(override)) {
      return override.replace(/\/?$/, '/');
    }
    return 'https://raw.githubusercontent.com/JeremyRigney/jeremyrigney.github.io/aurora-data/';
  }());

  var EVERY = 30 * 60000;
  var timer = null;
  var wanted = false; // whether the png has been asked for yet
  var loadingRun = null;

  function emit() {
    document.dispatchEvent(new CustomEvent('aurora:wind'));
  }

  function loadMeta() {
    clearTimeout(timer);
    return fetch(BASE + 'wind.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('wind.json ' + r.status); }
        return r.json();
      })
      .then(function (meta) {
        accept(meta);
        state.fetchedAt = Date.now();
        state.failed = false;
        emit();
        if (wanted) { loadAtlas(); }
      })
      .catch(function (err) {
        state.failed = true;
        if (window.console) { console.warn('aurora-wind:', err.message || err); }
        emit();
      })
      .then(function () {
        if (!document.hidden) { timer = setTimeout(loadMeta, EVERY); }
      });
  }

  function decode(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  // The png's tiles, unpacked into the array the shader and the streaks read.
  function unpack(img, meta) {
    var c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    var px = ctx.getImageData(0, 0, c.width, c.height).data;
    var tw = meta.atlas.tile[0], th = meta.atlas.tile[1], cols = meta.atlas.cols, n = meta.atlas.frames;
    var nl = meta.lon.count;
    if (th !== meta.r.count || tw !== nl || c.width < cols * tw || c.height < Math.ceil(n / cols) * th) {
      throw new Error('wind.png does not match wind.json');
    }
    var ecl = new Uint8Array(n * th * nl);
    for (var k = 0; k < n; k++) {
      var ox = (k % cols) * tw, oy = Math.floor(k / cols) * th;
      for (var y = 0; y < th; y++) {
        var row = ((oy + y) * c.width + ox) * 4;
        var e0 = (k * th + y) * nl;
        for (var x = 0; x < nl; x++) { ecl[e0 + x] = px[row + x * 4]; }
      }
    }
    return ecl;
  }

  function loadAtlas() {
    var meta = state.meta;
    if (!meta) { return; }
    var key = runKey(meta);
    if (state.run === key || loadingRun === key) { return; }
    loadingRun = key;
    fetch(BASE + meta.atlas.file + '?v=' + encodeURIComponent(meta.source.modified))
      .then(function (r) {
        if (!r.ok) { throw new Error(meta.atlas.file + ' ' + r.status); }
        return r.blob();
      })
      .then(decode)
      .then(function (img) {
        state.ecl = unpack(img, meta);
        if (img.close) { img.close(); }
        state.run = key;
        state.atlasMeta = meta;
        emit();
      })
      .catch(function (err) {
        if (window.console) { console.warn('aurora-wind:', err.message || err); }
      })
      .then(function () { loadingRun = null; });
  }

  // Ask for the png now: the views that draw it are near.
  api.want = function () {
    if (wanted) { return; }
    wanted = true;
    loadAtlas();
  };

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimeout(timer); return; }
    if (Date.now() - state.fetchedAt >= EVERY) { loadMeta(); } else {
      clearTimeout(timer);
      timer = setTimeout(loadMeta, EVERY - (Date.now() - state.fetchedAt));
    }
  });

  loadMeta();

  // Otherwise once the page has settled, unless the reader has asked to save data.
  var saving = navigator.connection && navigator.connection.saveData;
  if (!saving) {
    if (window.requestIdleCallback) { window.requestIdleCallback(api.want, { timeout: 6000 }); } else { setTimeout(api.want, 4000); }
  }
})();
