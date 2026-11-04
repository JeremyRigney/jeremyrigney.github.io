/*
 * jeremy.ie/aurora — the geometry everything else shares.
 *
 * Globe coordinates are Earth-centred and Earth-fixed, in Earth radii: +z through
 * the north pole, +x through 0°N 0°E, +y through 0°N 90°E. aurora-globe.js draws in
 * these, aurora-data.js samples the forecast grid in them, and the two agree because
 * both call unit() and latLon() from here.
 *
 *   sun(date)        The subsolar point, from NOAA's low-precision solar position
 *                    (good to a few hundredths of a degree this century, far finer
 *                    than a terminator line needs).
 *   sunAltitude()    The Sun's altitude from a place, for "is it dark there?".
 *   MAG / toMag()    A centred dipole from IGRF-14 at 2025.0: g10, g11, h11 put the
 *                    geomagnetic north pole at 80.79°N 72.76°W. The aurora's arcs run
 *                    along magnetic latitude, so the shader builds them in these
 *                    coordinates. A dipole is a few degrees off the real field over
 *                    the South Atlantic, but the oval itself comes from the forecast
 *                    grid; the dipole only orients the fine structure inside it.
 *   sample()         Bilinear lookup in a 360x181 grid laid out as OVATION's is, with
 *                    longitude wrapping.
 *   elevation()      How high above the horizon a layer at a given height stands, seen
 *                    from a given ground distance. Used for "can I see it from here?".
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var EARTH_KM = 6371;

  function unit(latDeg, lonDeg) {
    var la = latDeg * DEG;
    var lo = lonDeg * DEG;
    var c = Math.cos(la);
    return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
  }

  function latLon(v) {
    var r = Math.hypot(v[0], v[1], v[2]) || 1;
    return [Math.asin(v[2] / r) / DEG, Math.atan2(v[1], v[0]) / DEG];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function normalize(v) {
    var l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  // Great-circle angle between two places, in radians.
  function angle(lat1, lon1, lat2, lon2) {
    var d = dot(unit(lat1, lon1), unit(lat2, lon2));
    return Math.acos(Math.max(-1, Math.min(1, d)));
  }

  // Initial bearing from 1 to 2, degrees clockwise from north.
  function bearing(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / DEG + 360) % 360;
  }

  function compass(deg) {
    var names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round(deg / 22.5) % 16];
  }

  /* ---------- The Sun ---------- */

  // Declination and equation of time, from NOAA's general solar position formulae.
  function solar(date) {
    var start = Date.UTC(date.getUTCFullYear(), 0, 1);
    var dayOfYear = (date.getTime() - start) / 86400000; // fractional, from 0
    var hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    var g = 2 * Math.PI / 365 * (dayOfYear - hours / 24 + (hours - 12) / 24);
    var eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
      - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g)); // minutes
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
      - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
      - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g); // radians
    return { decl: decl, eqTime: eqTime, hours: hours };
  }

  // The point where the Sun is overhead.
  function sun(date) {
    var s = solar(date);
    var lon = -15 * (s.hours - 12 + s.eqTime / 60);
    lon = ((lon + 540) % 360) - 180;
    return { lat: s.decl / DEG, lon: lon, dir: unit(s.decl / DEG, lon) };
  }

  // Altitude of the Sun's centre from a place, degrees, without refraction.
  function sunAltitude(date, latDeg, lonDeg) {
    var s = sun(date);
    return 90 - angle(latDeg, lonDeg, s.lat, s.lon) / DEG;
  }

  // The sky by the Sun's altitude, the way an aurora watcher would put it.
  function sky(altDeg) {
    if (altDeg > -0.833) { return { key: 'day', label: 'Daylight' }; }
    if (altDeg > -6) { return { key: 'civil', label: 'Twilight' }; }
    if (altDeg > -12) { return { key: 'nautical', label: 'Late twilight' }; }
    if (altDeg > -18) { return { key: 'astro', label: 'Dark' }; }
    return { key: 'night', label: 'Fully dark' };
  }

  /* ---------- Geomagnetic coordinates ---------- */

  // IGRF-14, 2025.0, nT.
  var G10 = -29350.0, G11 = -1410.3, H11 = 4545.5;

  var MAG = (function () {
    var b0 = Math.hypot(G10, G11, H11);
    var poleLat = 90 - Math.acos(-G10 / b0) / DEG;
    var poleLon = Math.atan2(-H11, -G11) / DEG;
    var z = unit(poleLat, poleLon);
    var y = normalize(cross([0, 0, 1], z));
    var x = cross(y, z);
    // Rows are the magnetic axes in globe coordinates, so m = M * v.
    return { poleLat: poleLat, poleLon: poleLon, x: x, y: y, z: z,
      matrix: [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]] };
  })();

  function toMag(v) {
    return [dot(MAG.x, v), dot(MAG.y, v), dot(MAG.z, v)];
  }

  function magLatLon(latDeg, lonDeg) {
    return latLon(toMag(unit(latDeg, lonDeg)));
  }

  /* ---------- The forecast grid ---------- */

  var GRID_W = 360;
  var GRID_H = 181;

  // grid[(lat + 90) * 360 + lon], lon 0..359 east, lat -90..90: OVATION's own steps.
  function sample(grid, latDeg, lonDeg) {
    var x = ((lonDeg % 360) + 360) % 360;
    var y = Math.max(0, Math.min(GRID_H - 1, latDeg + 90));
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var x1 = (x0 + 1) % GRID_W, y1 = Math.min(GRID_H - 1, y0 + 1);
    var fx = x - x0, fy = y - y0;
    var a = grid[y0 * GRID_W + x0], b = grid[y0 * GRID_W + x1];
    var c = grid[y1 * GRID_W + x0], d = grid[y1 * GRID_W + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /* ---------- Seeing it from the ground ---------- */

  // Elevation in degrees of a point at heightKm, at ground angle theta (radians).
  function elevation(theta, heightKm) {
    var k = EARTH_KM / (EARTH_KM + heightKm);
    return Math.atan2(Math.cos(theta) - k, Math.sin(theta)) / DEG;
  }

  // Ground angle at which a layer at heightKm sits on the horizon.
  function horizonAngle(heightKm) {
    return Math.acos(EARTH_KM / (EARTH_KM + heightKm));
  }

  window.AuroraGeo = {
    DEG: DEG,
    EARTH_KM: EARTH_KM,
    GRID_W: GRID_W,
    GRID_H: GRID_H,
    unit: unit,
    latLon: latLon,
    dot: dot,
    cross: cross,
    normalize: normalize,
    angle: angle,
    bearing: bearing,
    compass: compass,
    sun: sun,
    sunAltitude: sunAltitude,
    sky: sky,
    MAG: MAG,
    toMag: toMag,
    magLatLon: magLatLon,
    sample: sample,
    elevation: elevation,
    horizonAngle: horizonAngle
  };
})();
