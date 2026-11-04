/*
 * jeremy.ie/aurora — the live data, and everything worked out from it.
 *
 * Every NOAA SWPC feed here allows cross-origin reads, so the browser fetches them
 * directly, each on its own clock. MagIE's magnetometers do not, so they come through
 * the site's Cloud Run relay (magie.py). One feed failing only stales its own
 * readouts; nothing waits on anything else.
 *
 * Cloud comes from Open-Meteo, hourly from a day back to four ahead, for the place the
 * readouts are for. The place is sent rounded to half a degree, which is as fine as
 * "the cloud around here" needs and no finer.
 *
 * The forecast grid is OVATION's: 360 x 181 cells, a whole-number "chance of
 * visible aurora overhead" in each. SWPC makes that number linear in the visible
 * aurora's energy flux, so it can be turned back into light. The slope is not
 * published, so it is fitted, each update and each hemisphere, to SWPC's own
 * hemispheric power for the same time:
 *
 *     k = HP / sum(chance x cell area)          (W m^-2 per percent)
 *
 * On the evening this was built both hemispheres fitted to about 0.1 erg cm^-2 s^-1
 * per percent, so 10% is about 1 erg, and at the usual 1 kR of 557.7 nm per erg
 * cm^-2 s^-1, about the naked-eye threshold. If the power file is missing or the fit
 * is degenerate, that 0.1 stands in. Cells already at 100% are clipped by SWPC, so
 * the very brightest cores read low; nothing here pretends otherwise.
 *
 * The grid goes to the globe upsampled to half a degree with a Catmull-Rom
 * spline, so contours and the glow's edges follow the oval rather than the steps of
 * the 1-degree grid. The readouts are sampled from the original grid.
 *
 * ?demo=storm swaps in a simulated storm, built from the live grid: the oval pushed
 * about 9 degrees toward the equator and four times as bright. The page says so for
 * as long as it is showing.
 */
(function () {
  'use strict';

  var Geo = window.AuroraGeo;
  if (!Geo) { return; }

  var SWPC = 'https://services.swpc.noaa.gov/';

  var API = (function () {
    var override = new URLSearchParams(window.location.search).get('api');
    if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override)) {
      return override.replace(/\/$/, '');
    }
    return 'https://irishrail-api-737590149980.europe-west1.run.app';
  }());

  var DEMO = new URLSearchParams(window.location.search).get('demo') === 'storm';

  var MIN = 60000;

  var FEEDS = {
    ovation: { url: SWPC + 'json/ovation_aurora_latest.json', every: 5 * MIN, staleAfter: 40 * MIN },
    power: { url: SWPC + 'text/aurora-nowcast-hemi-power.txt', every: 5 * MIN, staleAfter: 40 * MIN, text: true },
    kpNow: { url: SWPC + 'json/planetary_k_index_1m.json', every: MIN, staleAfter: 20 * MIN },
    // The forecast product carries the past week observed as well as three days ahead.
    kpForecast: { url: SWPC + 'products/noaa-planetary-k-index-forecast.json', every: 30 * MIN, staleAfter: 24 * 60 * MIN },
    mag: { url: SWPC + 'json/rtsw/rtsw_mag_1m.json', every: 5 * MIN, staleAfter: 20 * MIN },
    wind: { url: SWPC + 'json/rtsw/rtsw_wind_1m.json', every: 5 * MIN, staleAfter: 20 * MIN },
    scales: { url: SWPC + 'products/noaa-scales.json', every: 10 * MIN, staleAfter: 60 * MIN },
    alerts: { url: SWPC + 'products/alerts.json', every: 10 * MIN, staleAfter: 24 * 60 * MIN },
    magie: { url: API + '/magie', every: MIN, staleAfter: 20 * MIN },
    // Null until the page names a place (setPlace).
    weather: { url: weatherUrl, every: 30 * MIN, staleAfter: 3 * 60 * MIN }
  };

  // The weather's place: half-degree cells, so a place is never sent finer than ~50 km.
  var cell = null;

  function weatherUrl() {
    if (!cell) { return null; }
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + cell.lat + '&longitude=' + cell.lon
      + '&hourly=cloud_cover&past_days=1&forecast_days=4&timeformat=unixtime&timezone=GMT';
  }

  // Total cloud cover, percent: under CLEAR is a clear sky, from CLOUDY it is cloudy.
  var CLEAR = 20, CLOUDY = 70;

  // The fallback slope, erg cm^-2 s^-1 per percent (see the header).
  var ERG_PER_PCT = 0.1;
  // 557.7 nm brightness per unit of energy flux: the standard rule of thumb.
  var KR_PER_ERG = 1.0;

  // Where the aurora has to be for a place to see it: its upper curtain, about
  // 200 km up, standing clear of the horizon. Bright aurora is seen from about
  // 1,000 km away, which is where 200 km sits ~6 degrees up.
  var TOP_KM = 200;
  var HORIZON_FROM = 1; // degrees of elevation: invisible below this ...
  var HORIZON_FULL = 8; // ... and counted in full above this

  var W = Geo.GRID_W, H = Geo.GRID_H;

  var state = {
    demo: DEMO,
    ovation: null, // { observed: Date, forecast: Date, prob: Float32Array (percent) }
    power: null, // { north, south, observed: Date, forecast: Date }
    calib: null, // { north, south } erg per percent
    kpNow: null, // { kp, time }
    kpForecast: null, // [{ time, kp, kind: 'observed'|'estimated'|'predicted', scale }], past week and 3 days ahead
    mag: null, // [{ time, bt, bz }] oldest first, active spacecraft only
    wind: null, // [{ time, speed, density }]
    scales: null,
    alerts: null,
    magie: null,
    weather: null, // { times: [ms], cloud: [percent] } hourly, for the place's cell
    fetchedAt: {},
    failed: {}
  };

  /* ---------- Parsing ---------- */

  function utc(s) {
    // SWPC writes "2026-10-25T18:11:00", "2026-10-25 18:11:00" or "2026-10-25_18:11",
    // all UTC and mostly without a zone.
    var t = String(s).trim().replace(' ', 'T').replace('_', 'T');
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) { t += 'Z'; }
    return new Date(t);
  }

  function parseOvation(json) {
    var prob = new Float32Array(W * H);
    var rows = json.coordinates || [];
    for (var i = 0; i < rows.length; i++) {
      var lon = rows[i][0], lat = rows[i][1], v = rows[i][2];
      if (lon < 0 || lon >= W || lat < -90 || lat > 90) { continue; }
      prob[(lat + 90) * W + lon] = v;
    }
    return {
      observed: utc(json['Observation Time']),
      forecast: utc(json['Forecast Time']),
      prob: prob
    };
  }

  function parsePower(text) {
    var rows = [];
    text.split('\n').forEach(function (line) {
      if (!line.trim() || line.charAt(0) === '#') { return; }
      var f = line.trim().split(/\s+/);
      if (f.length < 4) { return; }
      rows.push({ observed: utc(f[0]), forecast: utc(f[1]), north: +f[2], south: +f[3] });
    });
    return rows;
  }

  function parseKpNow(rows) {
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      var kp = r.estimated_kp != null ? +r.estimated_kp : +r.kp_index;
      if (isFinite(kp)) { return { kp: kp, time: utc(r.time_tag) }; }
    }
    return null;
  }

  function parseKp(rows) {
    // Older products came as an array of arrays with a header row; handle both.
    var out = [];
    rows.forEach(function (r, i) {
      if (Array.isArray(r)) {
        if (i === 0) { return; }
        out.push({ time: utc(r[0]), kp: +r[1], kind: r[2] || 'observed', scale: r[3] || null });
      } else {
        out.push({ time: utc(r.time_tag), kp: +(r.Kp != null ? r.Kp : r.kp), kind: r.observed || 'observed', scale: r.noaa_scale || null });
      }
    });
    return out.filter(function (r) { return isFinite(r.kp); });
  }

  // The L1 feeds mix spacecraft; keep the one SWPC marks active, oldest first.
  function parseRtsw(rows, pick) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.active) { continue; }
      var v = pick(r);
      if (v) { v.time = utc(r.time_tag); out.push(v); }
    }
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  function parseMag(rows) {
    return parseRtsw(rows, function (r) {
      if (r.bt == null || r.bz_gsm == null) { return null; }
      return { bt: +r.bt, bz: +r.bz_gsm };
    });
  }

  function parseWind(rows) {
    return parseRtsw(rows, function (r) {
      if (r.proton_speed == null) { return null; }
      return { speed: +r.proton_speed, density: r.proton_density == null ? null : +r.proton_density };
    });
  }

  /*
   * The relay's MagIE payload (magie.py): for each station, a minute series of dH (nT
   * from the quiet-day curve, null where there is no data) over the last 24 hours, and
   * the local K for each 3-hour block in it, the last one possibly still running.
   */
  function parseMagie(body) {
    var t0 = body.start, step = body.step;
    return {
      k9: body.k9,
      stations: body.stations.map(function (s) {
        return {
          id: s.id,
          name: s.name,
          latest: s.latest ? new Date(s.latest) : null,
          rows: s.dH.map(function (v, i) { return { time: new Date(t0 + i * step), dH: v }; }),
          k: s.k.map(function (b) { return { time: new Date(b.start), k: b.k, running: !!b.running }; })
        };
      })
    };
  }

  function parseWeather(body) {
    var h = body.hourly || {};
    var times = [], cloud = [];
    (h.time || []).forEach(function (t, i) {
      var c = h.cloud_cover ? h.cloud_cover[i] : null;
      if (c == null || !isFinite(c)) { return; }
      times.push(t * 1000);
      cloud.push(+c);
    });
    return { times: times, cloud: cloud };
  }

  /*
   * Only the geomagnetic messages: K-index warnings and alerts (WARK, ALTK, EXTK),
   * storm watches (WATA) and sudden impulses (SUD). Most of the feed is radiation
   * and electron flux, which says nothing about aurora.
   */
  var GEOMAG = /^(WAR|ALT|EXT|WAT|SUM|CAN)[A-Z]*(K\d\d|A\d\d|SUD)/;

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // SWPC's "2026 Nov 01 0117 UTC".
  function swpcTime(s) {
    var m = /(\d{4}) (\w{3}) (\d\d) (\d\d)(\d\d) UTC/.exec(s || '');
    return m ? new Date(Date.UTC(+m[1], MONTHS.indexOf(m[2]), +m[3], +m[4], +m[5])) : null;
  }

  function field(msg, name) {
    var m = new RegExp('^' + name + ':\\s*(.*)$', 'mi').exec(msg);
    return m ? m[1].trim() : '';
  }

  /*
   * Each message with what grouping it into episodes needs (aurora-charts.js): its kind,
   * the K or storm level it names, the times it gives, and the serials it extends or
   * cancels. A watch's days come from its "Highest Storm Level Predicted by Day" line.
   */
  function parseAlerts(rows) {
    var out = [];
    rows.forEach(function (r) {
      var msg = String(r.message || '').replace(/\r/g, '');
      var code = (/Space Weather Message Code:\s*(\w+)/.exec(msg) || [])[1] || '';
      if (!GEOMAG.test(code)) { return; }
      // The title is the first line after the header block.
      var lines = msg.split('\n');
      var title = '';
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (!l || /^(Space Weather Message Code|Serial Number|Issue Time|Comment|NOAA)/i.test(l)) { continue; }
        title = l;
        break;
      }
      var time = utc(r.issue_datetime);
      var head = (/^(EXTENDED WARNING|CANCEL WATCH|CANCEL WARNING|WARNING|ALERT|WATCH|SUMMARY)/.exec(title) || [])[1] || '';
      var kind = /^CANCEL/.test(head) ? 'cancel' : /WARNING/.test(head) ? 'warning' : head.toLowerCase();
      var days = [];
      var by = /Highest Storm Level Predicted by Day:\s*\n([^\n]*)/.exec(msg);
      if (by) {
        var re = /(\w{3}) (\d\d):\s*(G\d|None)/g, m;
        while ((m = re.exec(by[1]))) {
          if (m[3] === 'None') { continue; }
          var mo = MONTHS.indexOf(m[1]), y = time.getUTCFullYear();
          if (mo < time.getUTCMonth() - 6) { y++; } // a watch issued in December for January
          days.push(new Date(Date.UTC(y, mo, +m[2])));
        }
      }
      var detail = /(Valid (From|To)|Threshold Reached|Begin Time|Observed|Highest Storm Level Predicted)[^\n]*/.exec(msg);
      out.push({
        time: time,
        code: code,
        title: title || code,
        detail: detail ? detail[0].trim() : '',
        kind: kind,
        k: +((/K-index of (\d)/.exec(title) || [])[1] || 0) || null,
        g: (/Category (G\d)/.exec(title) || [])[1] || null,
        serial: field(msg, 'Serial Number'),
        cancels: field(msg, 'Cancel Serial Number') || null,
        from: swpcTime(field(msg, 'Valid From')),
        to: swpcTime(field(msg, 'Now Valid Until') || field(msg, 'Valid To')),
        reached: swpcTime(field(msg, 'Threshold Reached')),
        impulse: /SUD$/.test(code) && kind === 'summary',
        observed: swpcTime(field(msg, 'Observed')),
        days: days
      });
    });
    return out.sort(function (a, b) { return b.time - a.time; });
  }

  /* ---------- Brightness ---------- */

  var R_EARTH_M = 6.371e6;

  function cellArea(lat) {
    var a = Math.max(-90, lat - 0.5) * Geo.DEG;
    var b = Math.min(90, lat + 0.5) * Geo.DEG;
    return R_EARTH_M * R_EARTH_M * Geo.DEG * (Math.sin(b) - Math.sin(a));
  }

  var AREA = (function () {
    var a = new Float64Array(H);
    for (var j = 0; j < H; j++) { a[j] = cellArea(j - 90); }
    return a;
  })();

  // Hemispheric power (GW) to a slope in erg cm^-2 s^-1 per percent.
  function fitSlope(prob, gw, north) {
    var sum = 0;
    for (var j = north ? 90 : 0; j < (north ? H : 91); j++) {
      var row = 0;
      for (var i = 0; i < W; i++) { row += prob[j * W + i]; }
      sum += row * AREA[j] * (j === 90 ? 0.5 : 1);
    }
    if (!(gw > 0) || !(sum > 0)) { return null; }
    var wPerM2 = gw * 1e9 / sum;
    return wPerM2 / 1e-3; // 1 erg cm^-2 s^-1 = 1 mW m^-2
  }

  function pickPower(rows, forecast) {
    if (!rows || !rows.length) { return null; }
    var best = rows[rows.length - 1];
    if (forecast) {
      var bestGap = Infinity;
      rows.forEach(function (r) {
        var gap = Math.abs(r.forecast - forecast);
        if (gap < bestGap) { bestGap = gap; best = r; }
      });
    }
    return best;
  }

  function calibrate() {
    var ov = state.ovation;
    if (!ov) { return; }
    var p = pickPower(state.powerRows, ov.forecast);
    state.power = p;
    var n = p ? fitSlope(ov.prob, p.north, true) : null;
    var s = p ? fitSlope(ov.prob, p.south, false) : null;
    state.calib = {
      north: n || ERG_PER_PCT,
      south: s || ERG_PER_PCT,
      fitted: !!(n && s)
    };
  }

  /* ---------- The simulated storm ---------- */

  function stormGrid(prob) {
    var out = new Float32Array(W * H);
    var M = Geo.MAG;
    for (var j = 0; j < H; j++) {
      var lat = j - 90;
      for (var i = 0; i < W; i++) {
        var v = Geo.unit(lat, i);
        var m = Geo.toMag(v);
        var colat = Math.acos(Math.max(-1, Math.min(1, Math.abs(m[2]))));
        // Sample the live oval from 30% nearer the pole: it grows outward.
        var src = colat * 0.7;
        var sign = m[2] >= 0 ? 1 : -1;
        var r = Math.hypot(m[0], m[1]) || 1;
        var sx = m[0] / r * Math.sin(src), sy = m[1] / r * Math.sin(src), sz = sign * Math.cos(src);
        var g = [M.x[0] * sx + M.y[0] * sy + M.z[0] * sz,
          M.x[1] * sx + M.y[1] * sy + M.z[1] * sz,
          M.x[2] * sx + M.y[2] * sy + M.z[2] * sz];
        var ll = Geo.latLon(g);
        out[j * W + i] = Math.min(100, Geo.sample(prob, ll[0], ll[1]) * 4);
      }
    }
    return out;
  }

  /* ---------- The texture for the globe ---------- */

  // Catmull-Rom weights for a fraction t.
  function cr(t) {
    var t2 = t * t, t3 = t2 * t;
    return [
      -0.5 * t3 + t2 - 0.5 * t,
      1.5 * t3 - 2.5 * t2 + 1,
      -1.5 * t3 + 2 * t2 + 0.5 * t,
      0.5 * t3 - 0.5 * t2
    ];
  }

  var UP = 2; // samples per degree on the globe
  var TW = W * UP, TH = (H - 1) * UP + 1;

  function upsample(src) {
    // Along longitude (wrapping), then along latitude (clamped).
    var mid = new Float32Array(TW * H);
    var half = cr(0.5);
    for (var j = 0; j < H; j++) {
      for (var i = 0; i < W; i++) {
        var a = src[j * W + (i + W - 1) % W], b = src[j * W + i];
        var c = src[j * W + (i + 1) % W], d = src[j * W + (i + 2) % W];
        mid[j * TW + i * 2] = b;
        mid[j * TW + i * 2 + 1] = a * half[0] + b * half[1] + c * half[2] + d * half[3];
      }
    }
    var out = new Float32Array(TW * TH);
    for (var y = 0; y < TH; y++) {
      var fy = y / UP;
      var j0 = Math.floor(fy), t = fy - j0;
      var wts = cr(t);
      for (var x = 0; x < TW; x++) {
        var acc = 0;
        for (var k = -1; k <= 2; k++) {
          var jj = Math.max(0, Math.min(H - 1, j0 + k));
          acc += mid[jj * TW + x] * wts[k + 1];
        }
        out[y * TW + x] = acc < 0 ? 0 : acc;
      }
    }
    return out;
  }

  function texture() {
    var ov = state.ovation;
    var prob = upsample(ov.prob);
    var values = new Float32Array(TW * TH * 2);
    var kN = state.calib.north * KR_PER_ERG, kS = state.calib.south * KR_PER_ERG;
    var equator = (TH - 1) / 2;
    for (var y = 0; y < TH; y++) {
      var k = y >= equator ? kN : kS;
      for (var x = 0; x < TW; x++) {
        var p = Math.min(100, prob[y * TW + x]);
        values[(y * TW + x) * 2] = p * k;
        values[(y * TW + x) * 2 + 1] = p / 100;
      }
    }
    return { w: TW, h: TH, values: values, power: state.power };
  }

  /* ---------- Readouts for a place ---------- */

  function kRAt(lat, lon) {
    var ov = state.ovation;
    if (!ov || !state.calib) { return null; }
    var p = Geo.sample(ov.prob, lat, lon);
    return p * (lat >= 0 ? state.calib.north : state.calib.south) * KR_PER_ERG;
  }

  // The live grid as a chance-at-a-cell function; the time slider passes its own.
  function liveChance(cl, cLon) {
    return state.ovation.prob[(cl + 90) * W + ((cLon % W) + W) % W];
  }

  /*
   * What a place can see. Overhead is the chance at the place. On the horizon is the
   * best cell within sight, discounted by how low its upper curtain stands: invisible
   * below HORIZON_FROM degrees, counted in full from HORIZON_FULL. chance(lat, lon)
   * defaults to the live grid; the slider passes the model's for its time.
   */
  function seeing(lat, lon, chance) {
    var ov = state.ovation;
    if (!ov) { return null; }
    var at = chance || liveChance;
    var reach = Geo.horizonAngle(TOP_KM) / Geo.DEG; // ~14 degrees
    var best = 0, bestLat = lat, bestLon = lon;
    var cosLat = Math.max(0.05, Math.cos(lat * Geo.DEG));
    for (var dLat = -Math.ceil(reach); dLat <= Math.ceil(reach); dLat++) {
      var cl = Math.round(lat) + dLat;
      if (cl < -90 || cl > 90) { continue; }
      var span = Math.ceil(reach / cosLat);
      for (var dLon = -span; dLon <= span; dLon++) {
        var cLon = Math.round(lon) + dLon;
        var p = at(cl, cLon);
        if (p <= best) { continue; }
        var theta = Geo.angle(lat, lon, cl, cLon);
        var e = Geo.elevation(theta, TOP_KM);
        var wgt = smooth(HORIZON_FROM, HORIZON_FULL, e);
        if (p * wgt > best) { best = p * wgt; bestLat = cl; bestLon = cLon; }
      }
    }
    var overhead = chance ? chance(lat, lon) : Geo.sample(ov.prob, lat, lon);
    var b = Geo.bearing(lat, lon, bestLat, bestLon);
    return {
      overhead: overhead,
      horizon: Math.max(best, overhead),
      bearing: best > overhead + 0.5 ? b : null
    };
  }

  function smooth(a, b, x) {
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // The highest Kp NOAA expects over the coming night at a place.
  function tonight(lat, lon) {
    var rows = state.kpForecast;
    if (!rows) { return null; }
    var now = Date.now();
    var best = null;
    rows.forEach(function (r) {
      if (r.kind === 'observed') { return; }
      var mid = new Date(r.time.getTime() + 90 * MIN);
      if (mid < now - 90 * MIN || mid > now + 24 * 60 * MIN) { return; }
      if (Geo.sunAltitude(mid, lat, lon) > -12) { return; }
      if (!best || r.kp > best.kp) { best = r; }
    });
    return best;
  }

  /*
   * The Kp a place needs before aurora shows low in its sky. OVATION alone can't say:
   * even at Kp 0 its faint fringe sits about 64°N, near enough in plan for Ireland's
   * horizon to count it, though from 1,000 km away it is too low and too dim to see.
   * Across Ireland it takes Kp 5 (NOAA's G1, and where MagIE's alerts start), or Kp 4
   * under a clear sky. Away from Ireland's band of magnetic latitude, the visible edge
   * moves about 2 degrees for each step of Kp, the usual view-line slope.
   */
  var IRELAND = [Geo.magLatLon(51.45, -9.82)[0], Geo.magLatLon(55.38, -7.37)[0]]; // Mizen Head, Malin Head
  var DEG_PER_KP = 2;

  function kpNeeded(lat, lon, clear) {
    var m = Math.abs(Geo.magLatLon(lat, lon)[0]);
    var kp = 5 + Math.max(0, (IRELAND[0] - m) / DEG_PER_KP) - Math.max(0, (m - IRELAND[1]) / DEG_PER_KP);
    return Math.max(0, kp - (clear ? 1 : 0));
  }

  // The cloud at a time: the nearest hour, or null off the ends of the forecast.
  function cloudAt(date) {
    var w = state.weather;
    if (!w || !w.times.length) { return null; }
    var t = date.getTime();
    var best = -1;
    for (var i = 0; i < w.times.length; i++) {
      if (best < 0 || Math.abs(w.times[i] - t) < Math.abs(w.times[best] - t)) { best = i; }
    }
    if (Math.abs(w.times[best] - t) > 90 * MIN) { return null; }
    var pct = w.cloud[best];
    return { pct: pct, key: pct < CLEAR ? 'clear' : pct >= CLOUDY ? 'cloudy' : 'partly' };
  }

  // The readouts' place, for the weather; a new cell fetches its cloud at once.
  function setPlace(lat, lon) {
    var next = { lat: Math.round(lat * 2) / 2, lon: Math.round(lon * 2) / 2 };
    if (cell && cell.lat === next.lat && cell.lon === next.lon) { return; }
    cell = next;
    state.weather = null;
    load('weather');
  }

  /* ---------- The hemispheres ---------- */

  // Peak chance over a hemisphere, and the latitude nearest the equator that reaches
  // 10%. With a chance function (the slider's model) it walks a 2-degree grid, which
  // is plenty for two numbers and keeps playback light.
  function hemisphere(south, chance) {
    var ov = state.ovation;
    if (!ov) { return null; }
    var step = chance ? 2 : 1;
    var at = chance || liveChance;
    var peak = 0, edge = null;
    for (var lat = -90; lat <= 90; lat += step) {
      if (south ? lat > 0 : lat < 0) { continue; }
      for (var lon = 0; lon < W; lon += step) {
        var p = at(lat, lon);
        if (p > peak) { peak = p; }
        if (p >= 10 && (edge === null || Math.abs(lat) < Math.abs(edge))) { edge = lat; }
      }
    }
    return { peak: peak, edge: edge };
  }

  /* ---------- Fetching ---------- */

  var timers = {};

  function emit(name) {
    document.dispatchEvent(new CustomEvent('aurora:data', { detail: { feed: name } }));
  }

  function urlOf(feed) {
    return typeof feed.url === 'function' ? feed.url() : feed.url;
  }

  function load(name) {
    var feed = FEEDS[name];
    var url = urlOf(feed);
    clearTimeout(timers[name]);
    if (!url) { return Promise.resolve(); }
    // The place moved while this was on its way: its own fetch is already out.
    function moved() { return urlOf(feed) !== url; }
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error(name + ' ' + r.status); }
        return feed.text ? r.text() : r.json();
      })
      .then(function (body) {
        if (moved()) { return; }
        accept(name, body);
        state.fetchedAt[name] = Date.now();
        state.failed[name] = false;
        emit(name);
      })
      .catch(function (err) {
        if (moved()) { return; }
        state.failed[name] = true;
        if (window.console && name !== 'magie') { console.warn('aurora-data:', err.message || err); }
        emit(name);
      })
      .then(function () {
        if (!moved() && !document.hidden) { timers[name] = setTimeout(function () { load(name); }, feed.every); }
      });
  }

  var live = null; // the real grid, kept so the storm can be rebuilt from it

  function accept(name, body) {
    switch (name) {
      case 'ovation':
        live = parseOvation(body);
        state.ovation = DEMO
          ? { observed: live.observed, forecast: live.forecast, prob: stormGrid(live.prob) }
          : live;
        calibrate();
        pushGrid();
        break;
      case 'power':
        state.powerRows = parsePower(body);
        if (DEMO) {
          state.powerRows.forEach(function (r) { r.north *= 6; r.south *= 6; });
        }
        calibrate();
        pushGrid();
        break;
      case 'kpNow':
        state.kpNow = parseKpNow(body);
        // The storm's oval sits ~9 degrees nearer the equator: about 4.5 steps of Kp.
        if (DEMO && state.kpNow) { state.kpNow.kp = Math.min(9, state.kpNow.kp + 4.5); }
        break;
      case 'kpForecast': state.kpForecast = parseKp(body); break;
      case 'mag': state.mag = parseMag(body); break;
      case 'wind': state.wind = parseWind(body); break;
      case 'scales': state.scales = body; break;
      case 'alerts': state.alerts = parseAlerts(body); break;
      case 'magie': state.magie = parseMagie(body); break;
      case 'weather': state.weather = parseWeather(body); break;
    }
  }

  var pushed = null;

  function pushGrid() {
    if (!state.ovation || !state.calib) { return; }
    // A power file alone does not need a new texture unless the fit changed.
    var key = state.ovation.forecast.getTime() + ':' + state.calib.north.toFixed(4) + ':' + state.calib.south.toFixed(4);
    if (key === pushed) { return; }
    pushed = key;
    if (window.AuroraGlobe) { window.AuroraGlobe.setGrid(texture()); }
  }

  // Data time for staleness: the feed's own timestamp where it has one.
  function dataTime(name) {
    switch (name) {
      case 'ovation': return state.ovation && state.ovation.observed;
      case 'power': return state.power && state.power.observed;
      case 'kpNow': return state.kpNow && state.kpNow.time;
      case 'mag': return state.mag && state.mag.length && state.mag[state.mag.length - 1].time;
      case 'wind': return state.wind && state.wind.length && state.wind[state.wind.length - 1].time;
      case 'magie': return state.magie && state.magie.stations.reduce(function (a, s) { return s.latest && (!a || s.latest > a) ? s.latest : a; }, null);
      default: return state.fetchedAt[name] ? new Date(state.fetchedAt[name]) : null;
    }
  }

  function isStale(name) {
    var t = dataTime(name);
    if (!t) { return true; }
    return Date.now() - t.getTime() > FEEDS[name].staleAfter;
  }

  function startAll() {
    Object.keys(FEEDS).forEach(function (name) { load(name); });
  }

  // Polling stops while the tab is hidden and catches up when it comes back.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      Object.keys(timers).forEach(function (k) { clearTimeout(timers[k]); });
      return;
    }
    Object.keys(FEEDS).forEach(function (name) {
      var at = state.fetchedAt[name] || 0;
      if (Date.now() - at >= FEEDS[name].every) { load(name); } else {
        clearTimeout(timers[name]);
        timers[name] = setTimeout(function () { load(name); }, FEEDS[name].every - (Date.now() - at));
      }
    });
  });

  window.AuroraData = {
    state: state,
    seeing: seeing,
    tonight: tonight,
    kpNeeded: kpNeeded,
    cloudAt: cloudAt,
    setPlace: setPlace,
    hemisphere: hemisphere,
    kRAt: kRAt,
    isStale: isStale,
    dataTime: dataTime,
    KR_PER_ERG: KR_PER_ERG,
    TOP_KM: TOP_KM
  };

  startAll();
})();
