/*
 * aurora-wind.js: the magnetosphere's boundaries against the papers' own numbers, the
 * sketches' promises (field lines stay inside, the flow never crosses the magnetopause),
 * the planets against dated events, and the model's lookups on a run small enough to
 * check by hand.
 */
var W = window.AuroraWind;
var Geo = window.AuroraGeo;
var RAD = Math.PI / 180;

function utc(s) { return new Date(s + 'Z'); }

/* ---------- pressure, Mach, boundaries ---------- */

test('dynamic pressure is 2e-6 n v^2', function () {
  near(W.pressure(5, 400), 1.6, 1e-9);
  near(W.pressure(10, 600), 7.2, 1e-9);
});

test('magnetosonic Mach number of an ordinary wind', function () {
  // v 400, n 5, B 5 nT, Tp 1e5 K: Alfven 48.8 km/s, sound 57.5 km/s.
  near(W.mach(400, 5, 5, 1e5), 5.31, 0.02);
  ok(W.mach(700, 5, 5, 1e5) > W.mach(400, 5, 5, 1e5), 'faster wind, higher Mach');
});

test('Shue et al. 1998 at 2 nPa and Bz 0', function () {
  var b = W.boundaries({ pd: 2, bz: 0, mach: 8 });
  near(b.r0, 10.25, 0.02, 'standoff');
  near(b.alpha, 0.5896, 0.001, 'flaring');
  near(W.mpR(b, 0), b.r0, 1e-9, 'the nose is the standoff');
  near(W.mpR(b, Math.PI / 2), b.r0 * Math.pow(2, b.alpha), 1e-9, 'at the terminator');
});

test('pressure pushes the magnetopause in; southward Bz erodes it and flares the tail', function () {
  var quiet = W.boundaries({ pd: 2, bz: 0, mach: 8 });
  var squeezed = W.boundaries({ pd: 8, bz: 0, mach: 8 });
  var south = W.boundaries({ pd: 2, bz: -10, mach: 8 });
  near(squeezed.r0, 8.31, 0.03);
  ok(south.r0 < quiet.r0, 'eroded');
  ok(south.alpha > quiet.alpha, 'flared');
});

test('Farris and Russell standoff, and the shock stays outside the magnetopause', function () {
  var b = W.boundaries({ pd: 2, bz: 0, mach: 8 });
  near(b.bs0 / b.r0, 1.2925, 0.001);
  ok(W.boundaries({ pd: 2, bz: 0, mach: 3 }).bs0 > b.bs0, 'a weaker shock stands further off');
  [{ pd: 0.5, bz: 5 }, { pd: 2, bz: 0 }, { pd: 2, bz: -15 }, { pd: 12, bz: -20 }, { pd: 40, bz: 10 }].forEach(function (up) {
    [3, 8, 20].forEach(function (m) {
      var s = W.boundaries({ pd: up.pd, bz: up.bz, mach: m });
      for (var deg = 0; deg <= 150; deg += 5) {
        ok(W.bsR(s, deg * RAD) > W.mpR(s, deg * RAD), 'shock inside magnetopause at ' + deg + ' deg, pd ' + up.pd + ' bz ' + up.bz + ' M ' + m);
      }
    });
  });
});

test('missing measurements fall back to an ordinary day', function () {
  var b = W.boundaries(null);
  ok(b.r0 > 9 && b.r0 < 12, 'standoff ' + b.r0);
  ok(b.bs0 > b.r0);
});

/* ---------- the field-line sketch ---------- */

function eachLine(b, tilt, fn) {
  W.fieldLines(b, tilt).forEach(function (line) {
    var pts = [];
    for (var i = 0; i < line.pts.length; i += 2) {
      var x = line.pts[i], z = line.pts[i + 1];
      pts.push({ x: x, z: z, r: Math.sqrt(x * x + z * z), t: Math.atan2(Math.abs(z), x) });
    }
    fn(line, pts);
  });
}

test('closed field lines start and end on the Earth and stay inside the magnetopause', function () {
  [0, 0.3, -0.55].forEach(function (tilt) {
    [{ pd: 2, bz: 0 }, { pd: 15, bz: -12 }, { pd: 0.6, bz: 4 }].forEach(function (up) {
      var b = W.boundaries({ pd: up.pd, bz: up.bz, mach: 8 });
      eachLine(b, tilt, function (line, pts) {
        near(pts[0].r, 1, 0.02, 'foot');
        if (!line.open) { near(pts[pts.length - 1].r, 1, 0.02, 'other foot'); }
        pts.forEach(function (p) {
          ok(p.r >= 0.98, 'under the surface');
          ok(p.r <= W.mpR(b, p.t) * 1.0001, 'outside the magnetopause: L ' + line.L + ' tilt ' + tilt + ' pd ' + up.pd);
        });
      });
    });
  });
});

test('near the Earth the lines are the dipole\'s own; the last closed one fits the magnetopause', function () {
  var b = W.boundaries({ pd: 2, bz: 0, mach: 8 });
  var inner = null, outerDay = null, outerNight = null;
  eachLine(b, 0, function (line, pts) {
    var mid = pts[(pts.length - 1) / 2]; // untilted, the middle point is on the Sun-Earth line
    if (!line.open && line.L === 1.6 && line.side === 1) { inner = mid; }
    if (!line.open && line.L === W.FIELD_LMAX) { if (line.side === 1) { outerDay = mid; } else { outerNight = mid; } }
  });
  near(inner.x, 1.6, 0.02, 'L 1.6 crosses the equator at');
  near(inner.z, 0, 1e-9);
  near(outerDay.x, 0.97 * b.r0, 1e-6, 'L max crosses it, on the day side, at');
  ok(outerNight.x < -40, 'and runs far down the tail on the night side: ' + outerNight.x);
});

test('the lobe lines are open, run tailward and end inside the magnetopause', function () {
  var b = W.boundaries({ pd: 2, bz: 0, mach: 8 });
  var open = 0;
  eachLine(b, 0.2, function (line, pts) {
    if (!line.open) { return; }
    open += 1;
    var end = pts[pts.length - 1];
    ok(end.x < 0, 'ends down the tail');
    ok(end.r > 5, 'runs well clear of the Earth');
  });
  eq(open, 8, 'four a hemisphere');
});

test('the cage in three dimensions holds the flat sketch, and stays inside the magnetopause', function () {
  [0, 0.3, -0.55].forEach(function (tilt) {
    [{ pd: 2, bz: 0 }, { pd: 15, bz: -12 }].forEach(function (up) {
      var b = W.boundaries({ pd: up.pd, bz: up.bz, mach: 8 });
      var flat = W.fieldLines(b, tilt).filter(function (l) { return !l.open; });
      var cage = W.fieldLines3(b, tilt);
      // The planes facing the Sun and the tail are the flat sketch's day and night lines.
      flat.forEach(function (line) {
        var twin = cage.filter(function (l) { return !l.open && l.L === line.L && l.phi === (line.side === 1 ? 0 : 180); })[0];
        notNull(twin, 'L ' + line.L);
        for (var i = 0; i < line.pts.length / 2; i += 7) {
          near(twin.pts[i * 3], line.pts[i * 2], 1e-9, 'x');
          near(twin.pts[i * 3 + 1], 0, 1e-9, 'y');
          near(twin.pts[i * 3 + 2], line.pts[i * 2 + 1], 1e-9, 'z');
        }
      });
      cage.forEach(function (line) {
        for (var i = 0; i < line.pts.length; i += 3) {
          var x = line.pts[i], y = line.pts[i + 1], z = line.pts[i + 2];
          var r = Math.sqrt(x * x + y * y + z * z);
          ok(r >= 0.98, 'under the surface');
          ok(r <= W.mpR(b, Math.acos(Math.max(-1, Math.min(1, x / r)))) * 1.0001, 'outside the magnetopause: L ' + line.L + ' phi ' + line.phi);
        }
      });
    });
  });
});

test('the dipole leans toward the Sun in northern summer, away in winter', function () {
  near(W.dipoleTilt([0, 0, 1], [1, 0, 0], [0, 0, 1]), 0, 1e-12);
  ok(W.dipoleTilt([0.5, 0, 0.866], [1, 0, 0], [0, 0, 1]) > 0, 'toward');
  var june = utc('2026-06-21T17:00:00'), dec = utc('2026-12-21T05:00:00');
  // About 17 UT in June the geomagnetic pole (in Canada) is on the Sun's side.
  ok(W.dipoleTilt(Geo.MAG.z, Geo.sun(june).dir, Geo.eclipticPole(june)) > 25 * RAD, 'June');
  ok(W.dipoleTilt(Geo.MAG.z, Geo.sun(dec).dir, Geo.eclipticPole(dec)) < -25 * RAD, 'December');
});

/* ---------- the flow sketch ---------- */

test('the wind runs straight outside the shock and not at all inside the magnetopause', function () {
  var b = W.boundaries({ pd: 2, bz: 0, mach: 8 });
  eq(W.flow(b, 30, 4), [-1, 0]);
  eq(W.flow(b, 0, 60), [-1, 0]);
  isNull(W.flow(b, 5, 0));
  isNull(W.flow(b, -20, 3));
});

test('in the sheath it slows, parts round the Earth and never crosses the magnetopause', function () {
  var b = W.boundaries({ pd: 2, bz: 0, mach: 8 });
  var nose = W.flow(b, b.r0 + 0.3, 0.4);
  ok(Math.sqrt(nose[0] * nose[0] + nose[1] * nose[1]) < 0.5, 'slow at the nose');
  ok(nose[1] > 0, 'turned north, north of the axis');
  var south = W.flow(b, b.r0 + 0.3, -0.4);
  near(south[0], nose[0], 1e-12);
  near(south[1], -nose[1], 1e-12, 'mirrored south of it');
  for (var deg = 2; deg <= 150; deg += 4) {
    var t = deg * RAD, r = W.mpR(b, t) * 1.002;
    var v = W.flow(b, r * Math.cos(t), r * Math.sin(t));
    notNull(v, 'just outside the magnetopause at ' + deg);
    // The magnetopause's outward normal there, from r(t) and its slope.
    var dr = (W.mpR(b, t + 1e-5) - W.mpR(b, t - 1e-5)) / 2e-5;
    var nx = r * Math.cos(t) + dr * Math.sin(t), nz = r * Math.sin(t) - dr * Math.cos(t);
    var len = Math.sqrt(nx * nx + nz * nz);
    ok((v[0] * nx + v[1] * nz) / len > -0.02, 'flows into the magnetopause at ' + deg + ' deg');
    ok(Math.sqrt(v[0] * v[0] + v[1] * v[1]) <= 1.0001, 'faster than the wind at ' + deg);
  }
});

/* ---------- the planets ---------- */

function lonOf(name, when) {
  return W.planets(utc(when)).filter(function (p) { return p.name === name; })[0];
}

test('the Earth sits at longitude 0, at its distance for the date', function () {
  var jan = lonOf('earth', '2025-01-04T13:00:00'), jul = lonOf('earth', '2025-07-03T20:00:00');
  eq(jan.lon, 0);
  near(jan.r, 0.9833, 0.0005, 'perihelion');
  near(jul.r, 1.0167, 0.0005, 'aphelion');
  near(Geo.sunDistance(utc('2025-01-04T13:00:00')), jan.r, 0.0005, 'and aurora-geo agrees');
});

test('Mars is opposite the Sun on its opposition dates', function () {
  near(lonOf('mars', '2025-01-16T02:30:00').lon, 0, 1.0, '2025');
  near(lonOf('mars', '2027-02-19T16:00:00').lon, 0, 1.0, '2027');
  var m = lonOf('mars', '2026-11-11T21:00:00');
  ok(m.r > 1.38 && m.r < 1.67, 'distance ' + m.r);
});

test('Venus and Mercury pass between us and the Sun on their conjunction dates', function () {
  near(lonOf('venus', '2025-03-23T01:00:00').lon, 0, 1.0, 'Venus, March 2025');
  near(lonOf('mercury', '2025-03-24T20:00:00').lon, 0, 1.5, 'Mercury, March 2025');
  near(lonOf('venus', '2025-03-23T01:00:00').r, 0.72, 0.01);
});

test('the Moon is sunward when new, behind us when full, and on the dusk side at first quarter', function () {
  function angle(when) { var m = W.moon(utc(when)); return Math.atan2(m.y, m.x) * 180 / Math.PI; }
  near(angle('2024-01-11T11:57:00'), 0, 1.5, 'new, 11 January 2024');
  near(Math.abs(angle('2024-01-25T17:54:00')), 180, 1.5, 'full, 25 January 2024');
  near(angle('2024-01-18T03:53:00'), 90, 1.5, 'first quarter, 18 January 2024');
  var m = W.moon(utc('2026-11-11T21:00:00'));
  ok(m.r > 55 && m.r < 65, 'distance ' + m.r);
  ok(Math.abs(m.z) < 0.1 * m.r, 'near the ecliptic');
});

/* ---------- the model run ---------- */

// Three frames two hours apart, 4 radii x 4 longitudes; a byte is 4 km/s from 200. Speed
// is 400 + 40 per radial cell, +8 at longitude index 1, and 20 faster each frame.
function tinyRun() {
  var nr = 4, nl = 4, n = 3;
  var ecl = new Uint8Array(n * nr * nl);
  for (var k = 0; k < n; k++) {
    for (var r = 0; r < nr; r++) {
      for (var l = 0; l < nl; l++) { ecl[(k * nr + r) * nl + l] = (400 + 40 * r + (l === 1 ? 8 : 0) + 20 * k - 200) / 4; }
    }
  }
  W.accept({
    version: 2,
    source: { file: 'tiny.nc', modified: '2026-11-11T01:24:00Z', ref: '2026-11-11T00:00:00Z', run_id: 0, cme: false },
    atlas: { file: 'wind.png', cols: 8, tile: [nl, nr], frames: n },
    times: ['2026-11-11T00:00:00Z', '2026-11-11T02:00:00Z', '2026-11-11T04:00:00Z'],
    r: { first: 0.5, step: 0.25, count: nr },
    lon: { first: -135, step: 90, count: nl },
    speed: { min: 200, max: 1220 },
    earth: { r: 1, start: '2026-11-11T00:00:00Z', step_min: 60,
      speed: [400, 420, 440, null, 600], density: [5, 5, 4, null, 2], temperature: [1e5, 1e5, 1e5, null, 2e5], b: [5, 5, 5, null, 6] }
  });
  W.state.ecl = ecl;
}

test('a time is placed among the frames, and held at the ends', function () {
  tinyRun();
  var t0 = Date.parse('2026-11-11T00:00:00Z'), H = 3600000;
  near(W.frameAt(t0).f, 0, 1e-12);
  near(W.frameAt(t0 + H).f, 0.5, 1e-12);
  near(W.frameAt(t0 + 3 * H).f, 1.5, 1e-12);
  eq(W.frameAt(t0 + 4 * H), { f: 2, covered: true });
  eq(W.frameAt(t0 + 9 * H), { f: 2, covered: false });
  eq(W.frameAt(t0 - 9 * H), { f: 0, covered: false });
});

test('speed is read between radii, longitudes and frames, wrapping in longitude', function () {
  tinyRun();
  near(W.speedAt(0.5, -135, 0), 400, 1e-9, 'a cell centre');
  near(W.speedAt(0.625, -135, 0), 420, 1e-9, 'half a radial cell out');
  near(W.speedAt(0.5, -45, 0), 408, 1e-9, 'the faster longitude');
  near(W.speedAt(0.5, -90, 0), 404, 1e-9, 'half way to it');
  near(W.speedAt(0.5, 180, 0), 400, 1e-9, 'between the last longitude and the first');
  near(W.speedAt(0.5, -135, 1.5), 430, 1e-9, 'between frames');
  near(W.speedAt(1.25, -135, 2), 560, 1e-9, 'the last cell and frame');
  isNull(W.speedAt(0.2, 0, 0), 'inside the inner boundary');
  isNull(W.speedAt(1.6, 0, 0), 'beyond the outer');
});

test('the model\'s own edges count as inside it', function () {
  // With the real grid's numbers the inner edge, first - step / 2, comes out in floating
  // point a hair under 0.1. A streak born there must still be given a speed.
  tinyRun();
  var m = W.state.meta;
  m.r = { first: 0.10625, step: 0.0125, count: 4 };
  var rIn = m.r.first - 0.5 * m.r.step, rOut = m.r.first + (m.r.count - 0.5) * m.r.step;
  ok(rIn < 0.1, 'the case this guards: ' + rIn);
  notNull(W.speedAt(rIn, 0, 0), 'at the inner edge');
  notNull(W.speedAt(rOut, 0, 0), 'at the outer edge');
  isNull(W.speedAt(rIn - 0.001, 0, 0), 'inside it');
  isNull(W.speedAt(rOut + 0.001, 0, 0), 'beyond it');
});

test('the series at the Earth is read between its points', function () {
  tinyRun();
  var t0 = Date.parse('2026-11-11T00:00:00Z'), H = 3600000;
  near(W.earthAt(t0 + 0.5 * H).speed, 410, 1e-9);
  near(W.earthAt(t0 + 1.5 * H).density, 4.5, 1e-9);
  near(W.earthAt(t0 + 2.5 * H).speed, 440, 1e-9, 'a gap takes the side it has');
  isNull(W.earthAt(t0 - H));
  isNull(W.earthAt(t0 + 5 * H));
});

test('the outlook names a rise, and when it gets going', function () {
  tinyRun();
  var t0 = Date.parse('2026-11-11T00:00:00Z'), H = 3600000;
  var o = W.outlook(t0);
  eq(o.trend, 'rising');
  near(o.now, 400, 1e-9);
  eq(o.peak, { speed: 600, time: t0 + 4 * H });
  eq(o.onset, t0 + 4 * H, 'the first point at least half way up');
  near(o.hours, 4, 1e-9, 'the run ends four hours on, well short of three days');
  eq(W.outlook(t0 + 4 * H).trend, 'steady', 'nothing ahead of the last point');
  near(W.outlook(t0 + 4 * H).hours, 0, 1e-9);
  isNull(W.outlook(t0 + 9 * H));
});

/* ---------- what reaches the Earth ---------- */

// L1 by the minute for three hours: 500 km/s, so it is 50 minutes upstream. Density and
// Bz step half way through, so which minute was read can be told.
function l1(t0) {
  var wind = [], mag = [];
  for (var i = 0; i <= 180; i++) {
    var late = i >= 90;
    wind.push({ time: new Date(t0 + i * 60000), speed: 500, density: late ? 10 : 4, temp: 1e5 });
    mag.push({ time: new Date(t0 + i * 60000), bt: 6, bz: late ? -5 : 2 });
  }
  return { wind: wind, mag: mag };
}

test('the wind at the Earth is what passed L1 its own travel time ago', function () {
  tinyRun();
  var t0 = Date.parse('2026-11-11T00:00:00Z'), MIN = 60000;
  var data = l1(t0);
  var early = W.upstream(t0 + 120 * MIN, data); // passed L1 at minute 70
  eq(early.source, 'l1');
  near(early.lagMin, 50, 1e-9);
  near(early.n, 4, 1e-9);
  near(early.bz, 2, 1e-9);
  var late = W.upstream(t0 + 160 * MIN, data); // passed at minute 110
  near(late.n, 10, 1e-9);
  near(late.bz, -5, 1e-9);
  near(late.pd, W.pressure(10, 500), 1e-9);
  // 45 minutes past L1's latest reading is still wind L1 has seen.
  eq(W.upstream(t0 + 225 * MIN, data).source, 'l1');
});

test('past what L1 has seen, the model stands in, and says nothing of Bz', function () {
  tinyRun();
  var t0 = Date.parse('2026-11-11T00:00:00Z'), MIN = 60000;
  var up = W.upstream(t0 + 239 * MIN, l1(t0)); // 59 minutes past L1's latest
  eq(up.source, 'model');
  isNull(up.bz);
  near(up.v, 600, 1e-9, 'the series has a gap just before; it takes the side it has');
  isNull(W.upstream(t0 + 20 * 3600000, l1(t0)), 'beyond both');
  eq(W.upstream(t0 + 60 * MIN, null).source, 'model', 'no L1 at all');
});
