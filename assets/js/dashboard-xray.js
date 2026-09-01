/*
 * jeremy.ie/dashboard — the X-ray trace behind the opening frame.
 *
 * Written in the same idiom as speaking-map.js: an IIFE, no dependencies, no build
 * step, constants at the top and the render functions under them. The canvas is sized
 * in CSS and painted in device pixels.
 *
 * What it draws is not decoration. It is the real GOES long-channel flux over the last
 * three days — the same series the chart in chapter 02 plots, at a glance and without
 * axes. A page that argues for looking at data should not open on a squiggle.
 *
 * It also owns the fetch. window.goesData is a promise for the raw NOAA payload,
 * created the moment this file evaluates; dashboard-feeds.js awaits the same promise
 * for the chart rather than asking SWPC for the same three days twice.
 */
(function () {
  'use strict';

  /* ---------- Configuration ---------- */

  var FEED = 'https://services.swpc.noaa.gov/json/goes/primary/xrays-3-day.json';

  /*
   * The long channel only. Plotting both here would put two lines a decade apart
   * behind a headline and turn the frame into a chart the visitor is expected to read;
   * the short channel is in the chart below, where there are axes to read it against.
   */
  var CHANNEL = '0.1-0.8nm';

  /*
   * The flare classes, in W/m². The floor is fixed at a decade below A: quiet days sit
   * near 1e-8 and a floor at A itself would clip the background to a flat line along
   * the bottom of the frame.
   */
  var FLUX_FLOOR = 1e-9;
  var CLASSES = [
    { flux: 1e-8, name: 'A' },
    { flux: 1e-7, name: 'B' },
    { flux: 1e-6, name: 'C' },
    { flux: 1e-5, name: 'M' },
    { flux: 1e-4, name: 'X' }
  ];

  /*
   * The ceiling follows the data. A fixed top at X would spend four fifths of the
   * frame on empty sky in the weeks — most of them — when nothing above C happens, and
   * flatten the trace into a line. Held between C and one decade above X so the scale
   * still means something across reloads.
   */
  var HEAD_ROOM = 8;
  var CEIL_MIN = 1e-6;
  var CEIL_MAX = 1e-3;

  /* The band the trace is drawn in, as fractions of the frame height. */
  var PAD_TOP = 0.16;
  var PAD_BOTTOM = 0.08;

  /* The same colour table speaking-map.js uses, in rgba against the coal ground. */
  var GRID = 'rgba(236, 238, 240, 0.05)';
  var LABEL = 'rgba(155, 161, 166, 0.85)';
  var TRACE = 'rgba(126, 156, 137, 0.55)';
  var PEAK = 'rgba(126, 156, 137, 0.9)';
  var LABEL_FONT = '500 9px "Chivo Mono", "Courier New", monospace';

  var GRID_MS = 700;
  var TRACE_MS = 1900;
  var PEAK_MS = 520;

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* The JS twin of --ease in coal.css. */
  function ease(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /* ---------- The shared fetch ---------- */

  /*
   * Created here rather than inside main(), so it is in flight before the DOM is ready
   * and so dashboard-feeds.js can attach to it whether or not this page has a canvas.
   */
  window.goesData = fetch(FEED).then(function (response) {
    if (!response.ok) {
      throw new Error('SWPC ' + response.status);
    }
    return response.json();
  });

  /* ---------- Flare classes ---------- */

  /*
   * A1.0 through X9.9. The letter is the decade and the figure is the mantissa within
   * it, which is why this is a table lookup and not a formatter.
   */
  function flareClass(flux) {
    if (!isFinite(flux) || flux <= 0) {
      return null;
    }
    for (var i = CLASSES.length - 1; i >= 0; i -= 1) {
      if (flux >= CLASSES[i].flux) {
        return CLASSES[i].name + (flux / CLASSES[i].flux).toFixed(1);
      }
    }
    return 'A' + (flux / 1e-8).toFixed(1);
  }

  function parse(rows) {
    var series = [];
    var peak = null;

    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row.energy !== CHANNEL) {
        continue;
      }
      var flux = parseFloat(row.observed_flux);
      var t = Date.parse(row.time_tag);
      if (!isFinite(flux) || flux <= 0 || !isFinite(t)) {
        continue;
      }
      var point = { t: t, flux: flux };
      series.push(point);
      if (!peak || flux > peak.flux) {
        peak = point;
      }
    }

    return { series: series, peak: peak };
  }

  /* ---------- The canvas ---------- */

  function main() {
    var canvas = document.getElementById('xray-trace');
    var frameEl = canvas && canvas.parentNode;
    if (!canvas || !frameEl) {
      return;
    }

    var ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    var w = 0;
    var h = 0;
    var data = null;
    var ceiling = CEIL_MIN;
    var started = 0;
    var running = false;

    /*
     * A device-pixel-ratio-aware resize. The canvas is sized in device pixels and
     * scaled back down in CSS, then the context is scaled so every draw call below can
     * work in CSS pixels and stay readable.
     */
    function size() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      if (!w || !h) {
        return false;
      }
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    /* Time to x across the full frame; the mask, not the geometry, fades the ends. */
    function px(t) {
      var series = data.series;
      var t0 = series[0].t;
      var t1 = series[series.length - 1].t;
      return t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * w;
    }

    /* Log flux to y, inside the padded band. */
    function py(flux) {
      var lo = Math.log10(FLUX_FLOOR);
      var hi = Math.log10(ceiling);
      var f = (Math.log10(Math.max(flux, FLUX_FLOOR)) - lo) / (hi - lo);
      var top = h * PAD_TOP;
      var bottom = h * (1 - PAD_BOTTOM);
      return bottom - clamp01(f) * (bottom - top);
    }

    /*
     * The class gridlines, under everything at the graticule's weight. Only the ones
     * inside the current range are drawn — a labelled X line on a week that peaked at
     * C2 is a line pointing at nothing.
     */
    function drawGrid(alpha) {
      if (alpha <= 0) {
        return;
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.font = LABEL_FONT;
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      for (var i = 0; i < CLASSES.length; i += 1) {
        if (CLASSES[i].flux > ceiling) {
          break;
        }
        var y = py(CLASSES[i].flux);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillText(CLASSES[i].name, 14, y - 7);
      }

      ctx.restore();
    }

    /*
     * The trace, revealed left to right rather than by arc length. A time series reads
     * in one direction and this is how a chart draws itself; the fraction-of-length
     * sweep speaking-map.js uses is for a coastline, which has no reading order.
     */
    function drawTrace(progress) {
      if (!data || progress <= 0 || data.series.length < 2) {
        return;
      }

      var series = data.series;
      var t0 = series[0].t;
      var t1 = series[series.length - 1].t;
      var cut = t0 + (t1 - t0) * progress;

      ctx.save();
      ctx.strokeStyle = TRACE;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px(series[0].t), py(series[0].flux));

      for (var i = 1; i < series.length; i += 1) {
        var point = series[i];
        if (point.t <= cut) {
          ctx.lineTo(px(point.t), py(point.flux));
          continue;
        }
        /* Part-way between two samples, so the line ends mid-stride rather than
           snapping back to the last one it cleared. */
        var prev = series[i - 1];
        var f = (cut - prev.t) / (point.t - prev.t);
        ctx.lineTo(
          px(prev.t + (point.t - prev.t) * f),
          py(prev.flux + (point.flux - prev.flux) * f)
        );
        break;
      }

      ctx.stroke();
      ctx.restore();
    }

    /*
     * The peak, marked once. One label, for the reason speaking-map.js gives about its
     * venues: labelling every local maximum on three days of flux is a word search,
     * and the only figure worth carrying out of this frame is the biggest one.
     */
    function drawPeak(progress) {
      if (!data || !data.peak || progress <= 0) {
        return;
      }

      var x = px(data.peak.t);
      var y = py(data.peak.flux);
      var label = flareClass(data.peak.flux);
      var r = 3.2 * progress;

      ctx.save();

      var halo = ctx.createRadialGradient(x, y, 0, x, y, 16);
      halo.addColorStop(0, 'rgba(126, 156, 137, ' + (0.22 * progress) + ')');
      halo.addColorStop(1, 'rgba(126, 156, 137, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(126, 156, 137, ' + (0.9 * progress) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      if (label) {
        ctx.globalAlpha = progress;
        ctx.font = LABEL_FONT;
        ctx.fillStyle = LABEL;
        ctx.textBaseline = 'middle';
        /* Flip the label inboard near the right edge, as the venue labels do. */
        var pad = 10;
        if (x + pad + ctx.measureText(label).width > w - 8) {
          ctx.textAlign = 'right';
          ctx.fillText(label, x - pad, y);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(label, x + pad, y);
        }
      }

      ctx.restore();
    }

    /* The peak appears as the trace reaches it, not on a clock of its own. */
    function peakStart() {
      if (!data || !data.peak || data.series.length < 2) {
        return TRACE_MS;
      }
      var series = data.series;
      var t0 = series[0].t;
      var t1 = series[series.length - 1].t;
      return TRACE_MS * clamp01((data.peak.t - t0) / (t1 - t0));
    }

    function frame(elapsed) {
      ctx.clearRect(0, 0, w, h);
      drawGrid(ease(clamp01(elapsed / GRID_MS)));
      drawTrace(ease(clamp01(elapsed / TRACE_MS)));
      drawPeak(ease(clamp01((elapsed - peakStart()) / PEAK_MS)));
    }

    function total() {
      return Math.max(GRID_MS, TRACE_MS, peakStart() + PEAK_MS);
    }

    function tick(now) {
      var elapsed = now - started;
      var end = total();
      frame(elapsed);
      if (elapsed < end) {
        requestAnimationFrame(tick);
      } else {
        running = false;
        /* One last frame at exactly the end state, so a dropped final frame can never
           leave the peak disc a pixel short of full size. */
        frame(end);
      }
    }

    function play() {
      if (!size()) {
        return;
      }
      if (reducedMotion) {
        frame(total());
        return;
      }
      started = performance.now();
      running = true;
      requestAnimationFrame(tick);
    }

    /*
     * Resize repaints the finished state rather than replaying: an animation that
     * restarts every time a phone's address bar collapses is a distraction, and on
     * desktop the frame is often resized long after the sequence has ended.
     */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        if (!size()) {
          return;
        }
        if (!running) {
          frame(total());
        }
      }, 150);
    });

    /*
     * The gridlines are the frame's floor: if SWPC never answers, five faint class
     * rules still sit behind the type and the opening does not become a blank
     * rectangle. That is why is-ready and play() are called from both branches.
     */
    window.goesData
      .then(function (rows) {
        data = parse(rows);
        if (!data.series.length) {
          throw new Error('no ' + CHANNEL + ' samples');
        }
        ceiling = Math.min(
          CEIL_MAX,
          Math.max(CEIL_MIN, data.peak.flux * HEAD_ROOM)
        );
        if (window.dashboardReadout) {
          window.dashboardReadout('flare', flareClass(data.peak.flux));
        }
        frameEl.classList.add('is-ready');
        play();
      })
      .catch(function () {
        data = null;
        frameEl.classList.add('is-ready');
        play();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
}());
