/*
 * jeremy.ie/aurora — the time slider's model, and the one clock the page shows.
 *
 * NOAA's OVATION grid is a nowcast: it says where the aurora is for the next 30-90
 * minutes and nothing else. Every other time on the slider is modelled the way
 * MagIE's 3-day animation and SWPC's "tonight" maps are: OVATION-Prime 2010 driven
 * by Kp instead of by the solar wind. tools/build-aurora-model.py prepares it:
 *
 *   model.json   Kp -> coupling (the median Newell dPhi/dt at each Kp, from 14
 *                years of NASA OMNI data), and the table layouts.
 *   op2010.bin   electron energy flux for 4 seasons x 16 coupling levels, on
 *                OVATION's own grid of magnetic latitude and magnetic local time,
 *                one log-scaled byte per value.
 *   aacgm.bin    where each 1-degree cell of the globe sits in AACGM coordinates,
 *                and the MLT of magnetic longitude 0 for every UT hour of the year.
 *
 * For a time t, Kp(t) comes from NOAA's Kp product (observed behind now, forecast
 * ahead), eased across the 3-hour slot edges so playback doesn't step; Kp gives
 * the coupling; the season weights come from the day of year (365 - doy in the
 * south, as OP2010 does); and the flux at a cell is a lookup in (magnetic latitude,
 * MLT, coupling). The globe does the same lookup per pixel in its shaders; fluxAt()
 * here repeats it on the CPU for the readouts.
 *
 * Joining the live grid: at the live grid's forecast time the model's hemispheric
 * power is scaled to NOAA's, and that correction relaxes over ANCHOR_H hours either
 * side. Within the live window the page shows NOAA's grid untouched; outside it,
 * the model takes over across BLEND_H hours. Live is exactly what it was before the
 * slider existed.
 *
 * The clock: viewTime is null while the page follows live data, or a time the
 * slider has chosen. Every change fires aurora:time.
 */
(function () {
  'use strict';

  var Geo = window.AuroraGeo;
  var Data = window.AuroraData;
  if (!Geo || !Data) { return; }

  var BASE = 'assets/data/aurora/';
  var V = '20261028b';
  var HOUR = 3600000;
  var MIN = 60000;

  var ANCHOR_H = 3; // e-folding of the correction to NOAA's power, hours
  var BLEND_H = 2; // hours outside the live window over which the model takes over
  var LIVE_PAD = 30 * MIN; // the live grid counts as current this long either side of its window
  var SLOT_EASE = 45 * MIN; // Kp eases into the next 3-hour slot over this long each side

  var meta = null, op = null, ag = null, mlt0 = null;
  var levels = null, nLat = 80, nMlt = 96, nLev = 16;
  var loading = null;

  var viewTime = null;

  /* ---------- Loading ---------- */

  function load() {
    if (loading) { return loading; }
    function bin(name) {
      return fetch(BASE + name + '?v=' + V).then(function (r) {
        if (!r.ok) { throw new Error(name + ' ' + r.status); }
        return r.arrayBuffer();
      });
    }
    loading = fetch(BASE + 'model.json?v=' + V)
      .then(function (r) {
        if (!r.ok) { throw new Error('model.json ' + r.status); }
        return r.json();
      })
      .then(function (json) {
        meta = json;
        return Promise.all([bin(json.op2010.file), bin(json.aacgm.file)]);
      })
      .then(function (bufs) {
        // One log-scaled byte per value; decoded once into erg cm^-2 s^-1.
        var raw = new Uint8Array(bufs[0]);
        var lut = new Float32Array(256);
        var lo = Math.log10(meta.op2010.min);
        for (var c = 1; c < 256; c++) { lut[c] = Math.pow(10, lo + (c - 1) * meta.op2010.step); }
        op = new Float32Array(raw.length);
        for (var i = 0; i < raw.length; i++) { op[i] = lut[raw[i]]; }
        var cells = 181 * 360;
        ag = new Int16Array(bufs[1], 0, cells * 2);
        mlt0 = new Uint16Array(bufs[1], cells * 4, 366 * 24);
        levels = meta.op2010.dF;
        nLev = levels.length;
        nLat = meta.op2010.mlat[2];
        nMlt = meta.op2010.mlt[2];
        combinedCache = {};
        document.dispatchEvent(new CustomEvent('aurora:model'));
      })
      .catch(function (err) {
        loading = null;
        if (window.console) { console.warn('aurora-model:', err.message || err); }
        throw err;
      });
    return loading;
  }

  function ready() {
    return !!(op && ag && mlt0);
  }

  /* ---------- Time pieces ---------- */

  function dayOfYear(t) {
    var d = new Date(t);
    return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  }

  // OVATION-Prime's season weights: each season peaks at its solstice or equinox.
  function seasonWeights(doy) {
    var w = { winter: 0, spring: 0, summer: 0, fall: 0 };
    if (doy >= 79 && doy < 171) {
      w.summer = 1 - (171 - doy) / 92;
      w.spring = 1 - w.summer;
    } else if (doy >= 171 && doy < 263) {
      w.fall = 1 - (263 - doy) / 92;
      w.summer = 1 - w.fall;
    } else if (doy >= 263 && doy < 354) {
      w.winter = 1 - (354 - doy) / 91;
      w.fall = 1 - w.winter;
    } else {
      var d0 = doy >= 354 ? doy - 365 : doy;
      w.spring = 1 - (79 - d0) / 90;
      w.winter = 1 - w.spring;
    }
    return meta.op2010.seasons.map(function (s) { return w[s]; });
  }

  // MLT of magnetic longitude 0 at t, from the hourly table.
  function mltRef(t) {
    var d = new Date(t);
    var doy = Math.min(366, dayOfYear(t));
    var h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    var i0 = (doy - 1) * 24 + Math.floor(h);
    var i1 = Math.min(mlt0.length - 1, i0 + 1);
    var a = mlt0[i0] / 1000, b = mlt0[i1] / 1000;
    if (b < a - 12) { b += 24; }
    return ((a + (b - a) * (h - Math.floor(h))) % 24 + 24) % 24;
  }

  /* ---------- Kp and coupling ---------- */

  // Kp at t from NOAA's 3-hourly product, eased across slot edges.
  function kpAt(t) {
    var rows = Data.state.kpForecast;
    if (!rows || !rows.length) { return null; }
    var i = -1;
    for (var k = 0; k < rows.length; k++) {
      if (+rows[k].time <= t) { i = k; } else { break; }
    }
    if (i < 0) { i = 0; }
    var r = rows[i];
    var kp = r.kp;
    var start = +r.time, end = start + 3 * HOUR;
    var next = rows[i + 1], prev = rows[i - 1];
    if (next && t > end - SLOT_EASE) {
      kp += (next.kp - r.kp) * 0.5 * (t - (end - SLOT_EASE)) / SLOT_EASE;
    } else if (prev && t < start + SLOT_EASE) {
      kp += (prev.kp - r.kp) * 0.5 * ((start + SLOT_EASE) - t) / SLOT_EASE;
    }
    return { kp: kp, kind: r.kind, slot: r };
  }

  function couplingFor(kp) {
    var c = meta.coupling;
    if (kp <= c.kp[0]) { return c.dF[0]; }
    for (var i = 1; i < c.kp.length; i++) {
      if (kp <= c.kp[i]) {
        var f = (kp - c.kp[i - 1]) / (c.kp[i] - c.kp[i - 1]);
        return c.dF[i - 1] + (c.dF[i] - c.dF[i - 1]) * f;
      }
    }
    return c.dF[c.dF.length - 1];
  }

  // Fractional index into the coupling levels.
  function levelOf(dF) {
    if (dF <= levels[0]) { return 0; }
    for (var i = 1; i < nLev; i++) {
      if (dF <= levels[i]) { return i - 1 + (dF - levels[i - 1]) / (levels[i] - levels[i - 1]); }
    }
    return nLev - 1;
  }

  /* ---------- Tables ---------- */

  var combinedCache = {};

  // The season-weighted table for one hemisphere and day: Float32 [level][mlat][mlt].
  function combined(south, doy) {
    var key = (south ? 'S' : 'N') + doy;
    if (combinedCache[key]) { return combinedCache[key]; }
    var w = seasonWeights(south ? Math.max(1, 365 - doy) : doy);
    var per = nLev * nLat * nMlt;
    var out = new Float32Array(per);
    for (var s = 0; s < w.length; s++) {
      if (!w[s]) { continue; }
      var off = s * per, ws = w[s];
      for (var k = 0; k < per; k++) { out[k] += op[off + k] * ws; }
    }
    // Keep only a few days: playback crosses one or two.
    var keys = Object.keys(combinedCache);
    if (keys.length > 6) { delete combinedCache[keys[0]]; }
    combinedCache[key] = out;
    return out;
  }

  function powerAt(south, doy, dF) {
    var w = seasonWeights(south ? Math.max(1, 365 - doy) : doy);
    var f = levelOf(dF);
    var i0 = Math.floor(f), i1 = Math.min(nLev - 1, i0 + 1), t = f - i0;
    var gw = 0;
    meta.op2010.power.forEach(function (row, s) {
      gw += w[s] * (row[i0] + (row[i1] - row[i0]) * t);
    });
    return gw;
  }

  /* ---------- Joining the live grid ---------- */

  function liveWindow() {
    var ov = Data.state.ovation;
    if (!ov) { return null; }
    return { from: +ov.observed - LIVE_PAD, to: +ov.forecast + LIVE_PAD, at: +ov.forecast };
  }

  // NOAA's power over the model's at the live time, per hemisphere: [north, south].
  function anchorRatio() {
    var lw = liveWindow();
    var p = Data.state.power;
    var k = lw && kpAt(lw.at);
    if (!lw || !p || !k) { return [1, 1]; }
    var dF = couplingFor(k.kp), doy = dayOfYear(lw.at);
    function ratio(noaa, model) {
      if (!(noaa > 0) || !(model > 0)) { return 1; }
      return Math.max(0.25, Math.min(4, noaa / model));
    }
    return [ratio(p.north, powerAt(false, doy, dF)), ratio(p.south, powerAt(true, doy, dF))];
  }

  // Everything the shaders and readouts need for a time.
  function frame(t) {
    var lw = liveWindow();
    var out = { t: t, modelMix: 0, kp: null, kind: null, live: true };
    if (!ready() || !lw) { return out; }
    var k = kpAt(t);
    if (!k) { return out; }
    var outside = t < lw.from ? lw.from - t : t > lw.to ? t - lw.to : 0;
    var x = Math.min(1, outside / (BLEND_H * HOUR));
    out.modelMix = x * x * (3 - 2 * x);
    out.live = out.modelMix === 0;
    out.kp = k.kp;
    out.kind = k.kind;
    out.dF = couplingFor(k.kp);
    out.level = levelOf(out.dF);
    out.doy = dayOfYear(t);
    out.mltRef = mltRef(t);
    var r = anchorRatio();
    var decay = Math.exp(-Math.abs(t - lw.at) / (ANCHOR_H * HOUR));
    out.anchor = [1 + (r[0] - 1) * decay, 1 + (r[1] - 1) * decay];
    out.power = [powerAt(false, out.doy, out.dF) * out.anchor[0], powerAt(true, out.doy, out.dF) * out.anchor[1]];
    var c = Data.state.calib || { north: 0.1, south: 0.1 };
    out.slope = [c.north, c.south];
    return out;
  }

  /* ---------- Point lookups for the readouts ---------- */

  function aacgmAt(lat, lon) {
    var y = Math.max(0, Math.min(180, lat + 90));
    var x = ((lon + 180) % 360 + 360) % 360;
    var y0 = Math.floor(y), x0 = Math.floor(x);
    var y1 = Math.min(180, y0 + 1), x1 = (x0 + 1) % 360;
    var fy = y - y0, fx = x - x0;
    var cells = 181 * 360;
    var mlat = 0, c = 0, s = 0, wsum = 0;
    [[y0, x0, (1 - fx) * (1 - fy)], [y0, x1, fx * (1 - fy)], [y1, x0, (1 - fx) * fy], [y1, x1, fx * fy]].forEach(function (q) {
      var i = q[0] * 360 + q[1];
      var la = ag[i], lo = ag[cells + i];
      if (la === meta.aacgm.noData || !q[2]) { return; }
      var r = lo / 100 * Geo.DEG;
      mlat += la / 100 * q[2];
      c += Math.cos(r) * q[2];
      s += Math.sin(r) * q[2];
      wsum += q[2];
    });
    if (!wsum) { return null; }
    return { mlat: mlat / wsum, mlon: Math.atan2(s, c) / Geo.DEG };
  }

  // Model flux (erg cm^-2 s^-1) at a place, for a frame from frame().
  function modelFlux(lat, lon, f) {
    var a = aacgmAt(lat, lon);
    if (!a || Math.abs(a.mlat) < 50) { return 0; }
    var south = a.mlat < 0;
    var tab = combined(south, f.doy);
    var mlt = ((f.mltRef + a.mlon / 15) % 24 + 24) % 24;
    var y = (Math.abs(a.mlat) - 50) / 0.5 - 0.5;
    var x = mlt / 0.25 - 0.5;
    var y0 = Math.max(0, Math.min(nLat - 1, Math.floor(y))), y1 = Math.min(nLat - 1, y0 + 1);
    var fy = Math.max(0, Math.min(1, y - y0));
    var x0 = ((Math.floor(x) % nMlt) + nMlt) % nMlt, x1 = (x0 + 1) % nMlt;
    var fx = x - Math.floor(x);
    var l0 = Math.floor(f.level), l1 = Math.min(nLev - 1, l0 + 1), fl = f.level - l0;
    function at(l) {
      var base = l * nLat * nMlt;
      var a0 = tab[base + y0 * nMlt + x0], b0 = tab[base + y0 * nMlt + x1];
      var a1 = tab[base + y1 * nMlt + x0], b1 = tab[base + y1 * nMlt + x1];
      return (a0 * (1 - fx) + b0 * fx) * (1 - fy) + (a1 * (1 - fx) + b1 * fx) * fy;
    }
    var flux = at(l0) * (1 - fl) + at(l1) * fl;
    return flux * f.anchor[south ? 1 : 0];
  }

  // Chance of aurora overhead (percent) at a place and time: the live grid, the
  // model, or the blend between them, exactly as the globe shows it.
  function chanceAt(lat, lon, f) {
    var ov = Data.state.ovation;
    var live = ov ? Geo.sample(ov.prob, lat, lon) : 0;
    if (!f || !f.modelMix) { return live; }
    var model = Math.min(100, modelFlux(lat, lon, f) / f.slope[lat >= 0 ? 0 : 1]);
    return live * (1 - f.modelMix) + model * f.modelMix;
  }

  /* ---------- The clock ---------- */

  function setTime(t) {
    var next = t == null ? null : +t;
    if (next === viewTime) { return; }
    viewTime = next;
    if (next !== null && !ready()) { load().catch(function () { /* stays live */ }); }
    document.dispatchEvent(new CustomEvent('aurora:time', { detail: { time: viewTime } }));
  }

  // The time being shown: the chosen one, or now.
  function shownTime() {
    return viewTime === null ? Date.now() : viewTime;
  }

  // ?t=H opens the page H hours from now (negative for the past): a debugging link.
  var openAt = parseFloat(new URLSearchParams(window.location.search).get('t'));

  // Load quietly once the page has settled, so the first scrub is instant.
  function idleLoad() {
    var go = function () {
      load().then(function () {
        if (isFinite(openAt) && viewTime === null) { setTime(Date.now() + openAt * HOUR); }
      }).catch(function () { /* the slider stays live-only */ });
    };
    if (window.requestIdleCallback) { window.requestIdleCallback(go, { timeout: 8000 }); } else { setTimeout(go, 3000); }
  }

  window.AuroraModel = {
    load: load,
    ready: ready,
    frame: frame,
    kpAt: kpAt,
    chanceAt: chanceAt,
    modelFlux: modelFlux,
    combined: combined,
    setTime: setTime,
    shownTime: shownTime,
    get viewTime() { return viewTime; },
    get meta() { return meta; },
    get aacgmGrid() { return ag; },
    dims: function () { return { nLat: nLat, nMlt: nMlt, nLev: nLev }; }
  };

  if (document.readyState === 'complete') { idleLoad(); } else { window.addEventListener('load', idleLoad); }
})();
