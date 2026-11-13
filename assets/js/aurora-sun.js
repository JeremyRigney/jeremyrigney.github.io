/*
 * jeremy.ie/aurora — the Sun, as GOES-19's SUVI images it, for the last 24 hours.
 *
 * NOAA SWPC lists the day's 171 Angstrom frames (one every 4 minutes, 1280 px PNGs of
 * about 660 KB) at LIST_URL; its own site's animations step through the same files.
 * They are read straight from NOAA, which serves them to any page, but not all of them:
 *   1. the newest first, so the view is never empty;
 *   2. then one an hour across the day (about 16 MB);
 *   3. then, while the Sun view is open, one every 20 minutes (about 48 MB in all),
 *      except on a narrow screen or with Save-Data on.
 * Nothing is fetched until want() is first called, which aurora-sun-view.js does only
 * as the camera heads up from the system view. While the view is open the list is read
 * again every REFRESH and new frames join.
 *
 * Each frame is drawn down to SIZE px square and handed to the view through take(),
 * with a slot in its texture array; the full-size image is dropped. No GL here, so the
 * choosing and the lookup can be tested alone (tests/aurora/sun.test.js).
 *
 * Geometry, from the frames themselves: Sun-centred, 2.5 arcsec a pixel, so the Sun's
 * radius is 959.63 arcsec / (its distance in AU) / 2.5 px, about 387 of 1280. NOAA's
 * caption runs along the bottom from 1.55 radii below the centre.
 */
(function () {
  'use strict';

  var MIN = 60000, HOUR = 60 * MIN;
  var BASE = 'https://services.swpc.noaa.gov';
  var LIST_URL = BASE + '/products/animations/suvi-primary-171.json';
  var CHANNEL = 171; // Angstroms
  var SIZE = 512; // px, each frame as kept
  var SLOTS = 96; // the texture array's depth: a day at 20 minutes is 73, with room for refreshes
  var STEPS = [HOUR, 20 * MIN]; // the passes after the newest
  var SLACK = 2 * MIN; // a frame this near a step's mark will do
  var REFRESH = 10 * MIN;
  var PARALLEL = 3;
  var NARROW = 700; // px: below this, the hourly pass only
  var PLATE_ARCSEC = 2.5, FRAME_PX = 1280, RSUN_ARCSEC_1AU = 959.63;

  // The frame's time from its file name: ..._s20261113T184400Z_...
  function parseTime(url) {
    var m = /_s(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(url || '');
    if (!m) { return null; }
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  // NOAA's list as [{ t, url }], oldest first, without duplicates or unparseable names.
  function parseList(body) {
    var seen = {}, out = [];
    (Array.isArray(body) ? body : []).forEach(function (e) {
      var url = e && e.url, t = parseTime(url);
      if (t === null || seen[t]) { return; }
      seen[t] = true;
      out.push({ t: t, url: url.charAt(0) === '/' ? BASE + url : url });
    });
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  // Indexes into times (oldest first) at one every step, counted back from the newest:
  // each the newest frame at or before its mark, give or take SLACK.
  function every(times, step) {
    var out = [], n = times.length;
    if (!n) { return out; }
    var mark = times[n - 1];
    for (var i = n - 1; i >= 0; i--) {
      if (times[i] <= mark + SLACK) {
        out.push(i);
        mark = Math.min(mark, times[i]) - step;
      }
    }
    return out;
  }

  // The order to load in: the newest, then each pass's new ones, newest first.
  function order(times, opts) {
    var n = times.length;
    if (!n) { return []; }
    var steps = opts && opts.fill === false ? STEPS.slice(0, 1) : STEPS;
    var out = [n - 1], have = {};
    have[n - 1] = true;
    steps.forEach(function (step) {
      every(times, step).forEach(function (i) {
        if (!have[i]) { have[i] = true; out.push(i); }
      });
    });
    return out;
  }

  // Of frames ({ t }, oldest first, only those ready), the two either side of time t
  // and how far between: { a, b, mix, latest, earliest }, or null with none ready.
  function lookup(frames, t) {
    var n = frames.length;
    if (!n) { return null; }
    if (t >= frames[n - 1].t) { return { a: frames[n - 1], b: frames[n - 1], mix: 0, latest: true, earliest: false }; }
    if (t <= frames[0].t) { return { a: frames[0], b: frames[0], mix: 0, latest: false, earliest: t < frames[0].t }; }
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) { lo = mid; } else { hi = mid; }
    }
    var a = frames[lo], b = frames[hi];
    return { a: a, b: b, mix: (t - a.t) / Math.max(1, b.t - a.t), latest: false, earliest: false };
  }

  // The Sun's radius in a frame, as a fraction of its width, at a distance in AU.
  function radiusFrac(au) {
    return RSUN_ARCSEC_1AU / (au || 1) / PLATE_ARCSEC / FRAME_PX;
  }

  /* ---------- Loading ---------- */

  var state = {
    list: [], // NOAA's, as parseList gives it
    frames: [], // ready ones, oldest first: { t, url, slot }
    listedAt: 0,
    failed: false,
    wanted: false
  };
  var bySlot = []; // slot -> frame, or undefined while free
  var loading = {}; // url -> true while out
  var queue = []; // urls still to load, in order
  var pending = []; // { slot, source, t } for the view to upload
  var fill = false;
  var listTimer = null, listing = false;

  function narrow() {
    var c = navigator.connection;
    return window.innerWidth < NARROW || !!(c && c.saveData);
  }

  function emit() {
    try { document.dispatchEvent(new CustomEvent('aurora:sun')); } catch (e) { /* old browsers */ }
  }

  function freeSlot() {
    for (var i = 0; i < SLOTS; i++) { if (!bySlot[i]) { return i; } }
    // Full: give up the oldest frame's.
    var old = state.frames[0];
    if (!old) { return -1; }
    drop(old);
    return old.slot;
  }

  function drop(f) {
    bySlot[f.slot] = undefined;
    state.frames = state.frames.filter(function (g) { return g !== f; });
  }

  function plan() {
    var times = state.list.map(function (e) { return e.t; });
    var keep = {};
    state.list.forEach(function (e) { keep[e.url] = true; });
    // Frames NOAA no longer lists are a day old: let them go.
    state.frames.slice().forEach(function (f) { if (!keep[f.url]) { drop(f); } });
    var have = {};
    state.frames.forEach(function (f) { have[f.url] = true; });
    queue = order(times, { fill: fill && !narrow() }).map(function (i) { return state.list[i]; })
      .filter(function (e) { return !have[e.url] && !loading[e.url]; });
    pump();
  }

  function pump() {
    var out = Object.keys(loading).length;
    while (out < PARALLEL && queue.length) {
      loadFrame(queue.shift());
      out++;
    }
  }

  function loadFrame(e) {
    loading[e.url] = true;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = function () {
      delete loading[e.url];
      var slot = freeSlot();
      if (slot >= 0) {
        var c = document.createElement('canvas');
        c.width = c.height = SIZE;
        var g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, SIZE, SIZE);
        var f = { t: e.t, url: e.url, slot: slot };
        bySlot[slot] = f;
        state.frames.push(f);
        state.frames.sort(function (a, b) { return a.t - b.t; });
        pending.push({ slot: slot, source: c, t: e.t });
        emit();
      }
      img.src = '';
      pump();
    };
    img.onerror = function () {
      delete loading[e.url];
      pump();
    };
    img.src = e.url;
  }

  function list() {
    if (listing) { return; }
    listing = true;
    fetch(LIST_URL, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('SUVI list ' + r.status); }
        return r.json();
      })
      .then(function (body) {
        state.list = parseList(body);
        state.listedAt = Date.now();
        state.failed = false;
        plan();
      })
      .catch(function (err) {
        state.failed = true;
        if (window.console) { console.warn('aurora-sun:', err.message || err); }
      })
      .then(function () {
        listing = false;
        emit();
      });
  }

  // Called each frame the camera is up past the system view. open: the Sun view itself
  // is showing, which allows the 20-minute pass and keeps the list fresh.
  function want(open) {
    if (!state.wanted) {
      state.wanted = true;
      list();
    }
    if (open && !fill && !narrow()) {
      fill = true;
      if (state.list.length) { plan(); }
    }
    if (open && !listTimer) {
      listTimer = setInterval(function () {
        if (!document.hidden) { list(); }
      }, REFRESH);
    }
    if (!open && listTimer) {
      clearInterval(listTimer);
      listTimer = null;
    }
  }

  // Frames ready for upload since the last call; the view takes them and they are gone.
  function take() {
    var out = pending;
    pending = [];
    return out;
  }

  window.AuroraSun = {
    CHANNEL: CHANNEL,
    SIZE: SIZE,
    SLOTS: SLOTS,
    SPAN: 24 * HOUR,
    state: state,
    parseTime: parseTime,
    parseList: parseList,
    every: every,
    order: order,
    lookup: function (t) { return lookup(state.frames, t); },
    lookupIn: lookup,
    radiusFrac: radiusFrac,
    want: want,
    take: take,
    loading: function () { return Object.keys(loading).length + queue.length; }
  };
})();
