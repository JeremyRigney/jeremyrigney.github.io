/*
 * jeremy.ie/aurora — the Sun, as GOES-19's SUVI images it, for the last 24 hours, and
 * the corona round it, as the same spacecraft's CCOR-1 coronagraph images it.
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
 * with a slot of its own; the full-size image is dropped, but for the newest's, which
 * the view keeps to show live at NOAA's own size. No GL here, so the
 * choosing and the lookup can be tested alone (tests/aurora/sun.test.js).
 *
 * Geometry, from the frames themselves: Sun-centred, 2.5 arcsec a pixel, so the Sun's
 * radius is 959.63 arcsec / (its distance in AU) / 2.5 px, about 387 of 1280. NOAA's
 * caption runs along the bottom from 1.55 radii below the centre.
 *
 * The coronagraph (window.AuroraCorona) is loaded the same way, by its own list, and
 * only once the view asks for it: frames every 15 minutes, JPEGs of about 120 KB, in
 * NOAA's blue for white light. Each is cut to the square CORONA_CUT solar radii either
 * side of the Sun and kept as its brightness alone (the mean of the three channels,
 * which NOAA's colours raise in turn: blue, then green, then red), one byte a pixel.
 * Geometry, from the frames: 1204 px wide, the Sun's centre at (596.7, 598.3), where
 * NOAA draws a circle the Sun's size, 23.11 px in radius in November 2026 (0.9886 AU),
 * so about 42 arcsec a pixel. The occulter covers out to 4.3 radii; the field is
 * clean out to 19.5 (a notch on each diagonal), its captions are in the corners.
 */
(function () {
  'use strict';

  var MIN = 60000, HOUR = 60 * MIN;
  var BASE = 'https://services.swpc.noaa.gov';
  var LIST_URL = BASE + '/products/animations/suvi-primary-171.json';
  var CHANNEL = 171; // Angstroms
  var SIZE = 512; // px, each frame as kept
  var SLOTS = 96; // frames kept at once: a day at 20 minutes is 73, with room for refreshes
  var STEPS = [HOUR, 20 * MIN]; // the passes after the newest
  var CORONA_URL = BASE + '/products/animations/ccor1/ccor1.json';
  var CORONA_SIZE = 768; // px, each frame as kept (one byte a pixel)
  var CORONA_SLOTS = 104; // a day at 15 minutes is 96
  var CORONA_STEPS = [HOUR, 15 * MIN];
  var CORONA_CUT = 23; // solar radii either side of the Sun, as kept
  var CORONA_FRAME = [1204, 596.7, 598.3, 23.11]; // its width, the Sun's centre and radius, px
  var CORONA_AU = 0.9886; // the Sun's distance when that radius was measured
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

  // CCOR-1's: its time_tag, or failing that its file name's 20261119_1730.
  function parseCoronaTime(e) {
    var t = e && e.time_tag ? Date.parse(/Z$/.test(e.time_tag) ? e.time_tag : e.time_tag + 'Z') : NaN;
    if (isFinite(t)) { return t; }
    var m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_ccor1/.exec((e && e.url) || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }

  // NOAA's list as [{ t, url }], oldest first, without duplicates or unparseable names.
  // timeOf reads an entry's time; by default SUVI's, from its file name.
  function parseList(body, timeOf) {
    var seen = {}, out = [];
    (Array.isArray(body) ? body : []).forEach(function (e) {
      var url = e && e.url, t = timeOf ? timeOf(e) : parseTime(url);
      if (t === null || !url || seen[t]) { return; }
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
    var all = (opts && opts.steps) || STEPS;
    var steps = opts && opts.fill === false ? all.slice(0, 1) : all;
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

  // The coronagraph's: kept cut to CORONA_CUT radii either side at 0.9886 AU, its
  // radius is a fixed share of the cut, a little more nearer the Sun.
  function coronaFrac(au) {
    return 0.5 / CORONA_CUT * CORONA_AU / (au || 1);
  }

  // A coronagraph frame (an image or canvas, w px wide) to its brightness alone, cut to
  // the square CORONA_CUT radii either side of the Sun and drawn n px square.
  function coronaBytes(img, w, h, n) {
    var k = w / CORONA_FRAME[0];
    var cx = CORONA_FRAME[1] * k, cy = CORONA_FRAME[2] * k, half = CORONA_FRAME[3] * k * CORONA_CUT;
    var c = document.createElement('canvas');
    c.width = c.height = n;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000';
    g.fillRect(0, 0, n, n);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, cx - half, cy - half, 2 * half, 2 * half, 0, 0, n, n);
    var px = g.getImageData(0, 0, n, n).data, out = new Uint8Array(n * n);
    for (var i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = (px[i] + px[i + 1] + px[i + 2]) / 3;
    }
    return { data: out, size: n };
  }

  /* ---------- Loading ---------- */

  /*
   * One of NOAA's lists of frames, loaded as above. cfg: url, the list; timeOf, an
   * entry's time; slots and steps; event, dispatched as frames come in; keep(img,
   * newest), what goes to the view for a loaded image: { source, full }.
   */
  function feed(cfg) {
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
    var pending = []; // { slot, source, t, full } for the view to upload
    var fill = false;
    var listTimer = null, listing = false;

    function emit() {
      try { document.dispatchEvent(new CustomEvent(cfg.event)); } catch (e) { /* old browsers */ }
    }

    function freeSlot() {
      for (var i = 0; i < cfg.slots; i++) { if (!bySlot[i]) { return i; } }
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
      queue = order(times, { fill: fill && !narrow(), steps: cfg.steps }).map(function (i) { return state.list[i]; })
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
          // The newest also goes up at full size: live, the view shows it sharp.
          var list = state.list, newest = list.length && e.t === list[list.length - 1].t;
          var kept;
          try { kept = cfg.keep(img, newest); } catch (err) { kept = null; }
          if (kept) {
            var f = { t: e.t, url: e.url, slot: slot };
            bySlot[slot] = f;
            state.frames.push(f);
            state.frames.sort(function (a, b) { return a.t - b.t; });
            pending.push({ slot: slot, source: kept.source, t: e.t, full: kept.full || null });
            emit();
          }
        }
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
      fetch(cfg.url, { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) { throw new Error(cfg.event + ' list ' + r.status); }
          return r.json();
        })
        .then(function (body) {
          state.list = parseList(body, cfg.timeOf);
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

    // Called each frame the camera wants these frames. open: their view itself is
    // showing, which allows the fill pass and keeps the list fresh.
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

    return {
      state: state,
      lookup: function (t) { return lookup(state.frames, t); },
      want: want,
      take: take,
      loading: function () { return Object.keys(loading).length + queue.length; }
    };
  }

  function narrow() {
    var c = navigator.connection;
    return window.innerWidth < NARROW || !!(c && c.saveData);
  }

  // SUVI's: drawn down to SIZE, and the newest kept as it came.
  function keepSuvi(img, newest) {
    var c = document.createElement('canvas');
    c.width = c.height = SIZE;
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, SIZE, SIZE);
    return { source: c, full: newest ? img : null };
  }

  // CCOR-1's: its brightness, cut round the Sun; the newest at its own scale too.
  function keepCorona(img, newest) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) { return null; }
    var own = Math.round(2 * CORONA_CUT * CORONA_FRAME[3] * w / CORONA_FRAME[0]);
    return { source: coronaBytes(img, w, h, CORONA_SIZE), full: newest ? coronaBytes(img, w, h, own) : null };
  }

  var suvi = feed({ url: LIST_URL, slots: SLOTS, steps: STEPS, event: 'aurora:sun', keep: keepSuvi });
  var corona = feed({ url: CORONA_URL, timeOf: parseCoronaTime, slots: CORONA_SLOTS, steps: CORONA_STEPS,
    event: 'aurora:corona', keep: keepCorona });

  window.AuroraSun = {
    CHANNEL: CHANNEL,
    SIZE: SIZE,
    SLOTS: SLOTS,
    SPAN: 24 * HOUR,
    state: suvi.state,
    parseTime: parseTime,
    parseList: parseList,
    every: every,
    order: order,
    lookup: suvi.lookup,
    lookupIn: lookup,
    radiusFrac: radiusFrac,
    want: suvi.want,
    take: suvi.take,
    loading: suvi.loading
  };

  window.AuroraCorona = {
    SIZE: CORONA_SIZE,
    CUT: CORONA_CUT,
    state: corona.state,
    parseTime: parseCoronaTime,
    lookup: corona.lookup,
    radiusFrac: coronaFrac,
    want: corona.want,
    take: corona.take,
    loading: corona.loading
  };
})();
