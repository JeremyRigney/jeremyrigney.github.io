/*
 * jeremy.ie/aurora — the Drivers view: solar wind, Kp, Ireland's magnetometers and
 * SWPC's geomagnetic alerts.
 *
 * Plain 2D canvas at the device's pixel ratio, so a 1-px rule is one pixel. The solar
 * wind and the magnetometers are half-hour columns standing from a baseline: zero for
 * Bz and dH, the past year's normal for speed and density. A column is grey unless it
 * stands 3 sigma or more beyond the past year's background in the direction that drives
 * aurora (south for Bz, up for speed and density, either way for dH), and it reaches the
 * event colour at 5 sigma. That colour means nothing else on the page. The background
 * is assets/data/aurora/background.json (tools/build-aurora-background.py).
 *
 * Kp is grey columns over NOAA's storm bands (G1, G2, G3+, muted), so the band a column
 * reaches names the storm. Text is Figtree in the ink colours, never a series colour, and
 * never under 13 px. One y-axis per strip; the solar wind is three strips on one time
 * axis, never a dual axis.
 *
 * Every chart has a hover readout and a Table switch holding the same values. Behind each
 * chart's + are the scientific views of the same series: gauges of now against the year,
 * and heat strips.
 */
(function () {
  'use strict';

  var Data = window.AuroraData;
  if (!Data) { return; }

  var MIN = 60000;
  var HOUR = 60 * MIN;
  var HALF = 30 * MIN;
  var SPAN = 24 * HOUR;
  var MINUS = '−';
  var FONT_PX = 13; // the floor for any chart text

  var T = {};

  function token(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function readTokens() {
    T.ink = token('--ink', '#ece9e2');
    T.inkSoft = token('--ink-soft', '#aeaaa2');
    T.inkFaint = token('--ink-faint', '#8c8981');
    T.night = token('--card-solid', '#18181d');
    T.grid = token('--grid', 'rgba(236,233,226,0.07)');
    T.axis = token('--axis', 'rgba(236,233,226,0.2)');
    T.quiet = token('--series-quiet', '#77757c');
    T.event = token('--event', '#d95926');
    T.g1 = token('--g1', '#fab219');
    T.g2 = token('--g2', '#ec835a');
    T.g3 = token('--g3', '#d03b3b');
    T.font = token('--font', '"Figtree", "Helvetica Neue", Arial, sans-serif');
  }

  /* ---------- Formatting ---------- */

  function fmt(opts) {
    try { return new Intl.DateTimeFormat(undefined, opts); } catch (err) { return null; }
  }

  var F = {
    hm: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
    day: fmt({ weekday: 'short', day: 'numeric' }),
    date: fmt({ weekday: 'short', day: 'numeric', month: 'short' }),
    full: fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
    month: fmt({ day: 'numeric', month: 'short', year: 'numeric' }),
    dateUtc: fmt({ weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }), // a watch's days are UT days
    dayUtc: fmt({ weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
    zone: fmt({ timeZoneName: 'short' })
  };

  function f(name, d) {
    d = d instanceof Date ? d : new Date(d);
    return F[name] ? F[name].format(d) : d.toISOString().slice(0, 16).replace('T', ' ');
  }

  function zoneName() {
    if (!F.zone || !F.zone.formatToParts) { return ''; }
    var part = F.zone.formatToParts(new Date()).filter(function (p) { return p.type === 'timeZoneName'; })[0];
    return part ? part.value : '';
  }

  function num(v, digits) {
    if (v == null || !isFinite(v)) { return '–'; }
    var s = Math.abs(v).toFixed(digits);
    return (v < 0 && +s !== 0 ? MINUS : '') + s;
  }

  function signed(v, digits) {
    if (v == null || !isFinite(v)) { return '–'; }
    var s = Math.abs(v).toFixed(digits);
    return (+s === 0 ? '' : v < 0 ? MINUS : '+') + s;
  }

  function niceCeil(v) {
    if (!(v > 0)) { return 1; }
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * p >= v) { return steps[i] * p; }
    }
    return 10 * p;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Index of the sample nearest t in a time-sorted array.
  function nearest(rows, t) {
    var lo = 0, hi = rows.length - 1;
    if (hi < 0) { return -1; }
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (rows[mid].time < t) { lo = mid; } else { hi = mid; }
    }
    return Math.abs(rows[lo].time - t) <= Math.abs(rows[hi].time - t) ? lo : hi;
  }

  /* ---------- The background ---------- */

  // The past year's level and sigma for each series; until it loads, columns are grey.
  var BG = null;
  var EVENT_FROM = 3, EVENT_FULL = 5;

  // Which way a series drives aurora: Bz south, speed and density up, dH either way.
  var DRIVE = { bz: -1, speed: 1, density: 1, dun: 0, val: 0 };
  var DRIVE_WORDS = { bz: ['north', 'south'], speed: ['slower', 'faster'], density: ['thinner', 'denser'] };

  // How far v stands from the year's level, in sigma; positive is toward aurora.
  function sigmas(name, v) {
    var b = BG && BG[name];
    if (!b || v == null || !isFinite(v) || !(b.sigma > 0)) { return null; }
    var d = (v - b.level) / b.sigma;
    return DRIVE[name] === 0 ? Math.abs(d) : d * DRIVE[name];
  }

  // The same, in words, for readouts: "2.4σ south of normal", "1.0σ slower than normal".
  function sigmaWords(name, v) {
    var b = BG && BG[name];
    if (!b || v == null || !isFinite(v)) { return ''; }
    var d = (v - b.level) / b.sigma;
    var words = DRIVE_WORDS[name];
    var side = name === 'bz' ? (d < 0 ? 'south of' : 'north of')
      : words ? words[d > 0 ? 1 : 0] + ' than' : (d > 0 ? 'above' : 'below');
    return Math.abs(d).toFixed(1) + 'σ ' + side + ' normal';
  }

  function rgbOf(c) {
    var r = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(c);
    if (r) { return [+r[1], +r[2], +r[3]]; }
    var m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) { return [128, 128, 128]; }
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, k) {
    var p = rgbOf(a), q = rgbOf(b);
    return 'rgb(' + p.map(function (v, i) { return Math.round(v + (q[i] - v) * k); }).join(',') + ')';
  }

  // Grey below 3 sigma, into the event colour by 5.
  function eventColor(z) {
    if (z == null || z < EVENT_FROM) { return T.quiet; }
    return mix(T.quiet, T.event, Math.min(1, (z - EVENT_FROM) / (EVENT_FULL - EVENT_FROM)));
  }

  function loadBackground() {
    if (!window.fetch) { return; }
    fetch('assets/data/aurora/background.json?v=20261103a')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json || !json.series) { return; }
        BG = json.series;
        renderAll();
      })
      .catch(function () {});
  }

  /* ---------- The chart frame ---------- */

  /*
   * One figure: a canvas and a table, sized to its .chart-body and redrawn on resize, on
   * new data and on hover. spec.draw(ctx, w, h, hoverX) returns a message when there is
   * nothing to draw. There is no hover box: under the pointer, the chart itself reads
   * out (the heads show that half hour's values, the axis its time), so nothing covers
   * the data. A body that's hidden (behind a +) sizes to nothing and draws when it opens.
   */
  function Chart(body, spec) {
    if (!body) { return null; }
    var fig = body.closest('.chart');
    var toggle = spec.table && fig ? fig.querySelector('.chart-table-toggle') : null;
    var canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', spec.label);
    var ctx = canvas.getContext('2d');
    var empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.hidden = true;
    var tableBox = document.createElement('div');
    tableBox.className = 'chart-table';
    tableBox.hidden = true;
    body.appendChild(canvas);
    body.appendChild(empty);
    body.appendChild(tableBox);

    var w = 0, h = 0, dpr = 1, hoverX = null, showTable = false;

    function size() {
      w = body.clientWidth;
      h = body.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    }

    function render() {
      if (!w || !h) { size(); }
      if (!w || !h) { return; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '400 ' + FONT_PX + 'px ' + T.font;
      var out = spec.draw(ctx, w, h, showTable ? null : hoverX);
      if (out && out.message) {
        empty.textContent = out.message;
        empty.hidden = false;
        canvas.style.visibility = 'hidden';
      } else {
        empty.hidden = true;
        canvas.style.visibility = showTable ? 'hidden' : '';
      }
      if (showTable) { tableBox.innerHTML = spec.table() || ''; }
    }

    if (spec.hover !== false) {
      canvas.addEventListener('pointermove', function (e) {
        var r = canvas.getBoundingClientRect();
        hoverX = e.clientX - r.left;
        render();
      });
      canvas.addEventListener('pointerleave', function () {
        hoverX = null;
        render();
      });
    }

    if (toggle) {
      toggle.addEventListener('click', function () {
        showTable = !showTable;
        toggle.setAttribute('aria-pressed', showTable ? 'true' : 'false');
        tableBox.hidden = !showTable;
        render();
      });
    }

    if (window.ResizeObserver) {
      new ResizeObserver(function () { size(); render(); }).observe(body);
    } else {
      window.addEventListener('resize', function () { size(); render(); });
    }

    size();
    return { render: render };
  }

  /* ---------- Drawing helpers ---------- */

  function font(ctx, weight, px) {
    ctx.font = weight + ' ' + Math.max(FONT_PX, px) + 'px ' + T.font;
  }

  function label(ctx, s, x, y, color, align, base) {
    ctx.fillStyle = color || T.inkFaint;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = base || 'middle';
    ctx.fillText(s, x, y);
  }

  function hline(ctx, x0, x1, y, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var yy = Math.round(y) + 0.5;
    ctx.moveTo(x0, yy);
    ctx.lineTo(x1, yy);
    ctx.stroke();
  }

  function vline(ctx, x, y0, y1, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var xx = Math.round(x) + 0.5;
    ctx.moveTo(xx, y0);
    ctx.lineTo(xx, y1);
    ctx.stroke();
  }

  // A rectangle with rounded corners: all four, or only the top two (a bar on a baseline).
  function rounded(ctx, x, y, w, h, r, topOnly) {
    r = Math.max(0, Math.min(r, w / 2, topOnly ? h : h / 2));
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    if (topOnly) {
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
    } else {
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
    }
    ctx.closePath();
  }

  function waiting(feed, what) {
    return { message: Data.state.failed[feed] ? what + ' didn’t load. Retrying.' : 'Waiting for ' + what + '…' };
  }

  // Half-hour medians of a time-sorted series over [t0, t1), with each half hour's range.
  function halfHours(rows, key, t0, t1) {
    var out = [], i = 0;
    while (i < rows.length && rows[i].time < t0) { i++; }
    for (var t = t0; t < t1; t += HALF) {
      var vs = [];
      while (i < rows.length && rows[i].time < t + HALF) {
        var v = rows[i][key];
        if (v != null && isFinite(v)) { vs.push(v); }
        i++;
      }
      vs.sort(function (a, b) { return a - b; });
      out.push(vs.length >= 3
        ? { t: t, v: vs[vs.length >> 1], lo: vs[0], hi: vs[vs.length - 1] }
        : { t: t, v: null });
    }
    return out;
  }

  // The 24 hours the solar wind and magnetometer charts show: whole half hours, ending
  // with the one still running.
  function window24(latest) {
    var t1 = Math.ceil((latest + 1) / HALF) * HALF;
    return { t0: t1 - SPAN, t1: t1 };
  }

  /*
   * One strip of half-hour columns: the name, and the latest value with its unit, over
   * it; the columns either side of the baseline, each coloured by how far it stands from
   * the year. Under the pointer, that half hour's column lights and the head shows its
   * value instead. o: { name, unit, key (background), bins, base, half (scale either
   * side), digits, now, x0, x1, top, h, hover (bin index or -1) }.
   */
  var STRIP_HEAD = 26;

  function strip(ctx, o) {
    var y0 = o.top + STRIP_HEAD, y1 = o.top + o.h;
    var mid = (y0 + y1) / 2;
    function y(v) { return mid - (v - o.base) / o.half * (y1 - y0) / 2; }

    // Head: the name on the left, the value on the right.
    font(ctx, 600, 15);
    label(ctx, o.name, o.x0, o.top + 9, T.ink);
    var nameW = ctx.measureText(o.name).width;
    var shown = o.hover >= 0 ? o.bins[o.hover].v : o.now;
    var nowText = shown == null ? '–' : (o.signed ? signed(shown, o.digits) : num(shown, o.digits));
    font(ctx, 400, 13);
    var unitW = ctx.measureText(' ' + o.unit).width;
    label(ctx, ' ' + o.unit, o.x1, o.top + 10, T.inkSoft, 'right');
    font(ctx, 700, 20);
    var valueW = ctx.measureText(nowText).width;
    label(ctx, nowText, o.x1 - unitW, o.top + 9, T.ink, 'right');
    font(ctx, 400, 13);
    // The baseline in words, as much of it as fits between the name and the value.
    var room = o.x1 - unitW - valueW - 16 - (o.x0 + nameW + 10);
    var note = (o.notes || []).filter(function (n) { return ctx.measureText(n).width <= room; })[0];
    if (note) { label(ctx, note, o.x0 + nameW + 10, o.top + 10, T.inkFaint); }

    // The scale: its two ends and the baseline, at the left.
    hline(ctx, o.x0, o.x1, y(o.base), T.axis);
    label(ctx, o.baseLabel, o.x0 - 8, y(o.base), T.inkFaint, 'right');
    label(ctx, o.topLabel, o.x0 - 8, y0 + 6, T.inkFaint, 'right');
    label(ctx, o.bottomLabel, o.x0 - 8, y1 - 6, T.inkFaint, 'right');

    var slot = (o.x1 - o.x0) / o.bins.length;
    var bw = Math.max(1, slot - 2);
    o.bins.forEach(function (b, i) {
      if (b.v == null) { return; }
      var bx = o.x0 + i * slot + (slot - bw) / 2;
      var a = y(o.base), e = y(Math.max(o.base - o.half, Math.min(o.base + o.half, b.v)));
      ctx.fillStyle = i === o.hover ? T.ink : eventColor(sigmas(o.key, b.v));
      rounded(ctx, bx, Math.min(a, e), bw, Math.max(1, Math.abs(e - a)), 2);
      ctx.fill();
    });
    return { y0: y0, y1: y1, y: y };
  }

  // Hours along the foot, every three, and "now" at the end. Under the pointer, the
  // hovered time stands on the axis in their place: hx is its x, text what it says.
  function timeAxis(ctx, t0, t1, x0, x1, y, hx, text) {
    function x(t) { return x0 + (t - t0) / (t1 - t0) * (x1 - x0); }
    var every = (x1 - x0) / 8 < 52 ? 6 : 3;
    var clear = hx == null ? null : ctx.measureText(text).width / 2 + 34;
    for (var t = Math.ceil(t0 / (every * HOUR)) * every * HOUR; t < t1; t += every * HOUR) {
      if (x(t) > x1 - 56) { break; } // leave room for "now"
      if (clear !== null && Math.abs(x(t) - hx) < clear) { continue; }
      vline(ctx, x(t), y - 14, y - 10, T.axis);
      label(ctx, f('hm', t), x(t), y, T.inkFaint, 'center');
    }
    if (clear === null || x1 - hx > clear + 10) { label(ctx, 'now', x1, y, T.inkSoft, 'right'); }
    if (hx != null) { hoverLabel(ctx, text, hx, x0, x1, y); }
  }

  // The hovered time on an axis: a tick up to the plot and the time under it, in ink.
  function hoverLabel(ctx, text, hx, x0, x1, y) {
    vline(ctx, hx, y - 16, y - 9, T.ink);
    font(ctx, 600, 13);
    var half = ctx.measureText(text).width / 2;
    label(ctx, text, Math.max(x0 + half, Math.min(x1 - half, hx)), y, T.ink, 'center');
    font(ctx, 400, 13);
  }

  // The strip's half-height: the furthest column from the baseline, or the floor, rounded
  // up finely enough that a quiet day still fills most of it.
  function scaleOf(bins, base, floor) {
    var m = floor;
    bins.forEach(function (b) { if (b.v != null) { m = Math.max(m, Math.abs(b.v - base)); } });
    var p = Math.pow(10, Math.floor(Math.log10(m)));
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * p >= m) { return steps[i] * p; }
    }
    return 10 * p;
  }

  function hoverIndex(hoverX, x0, x1, n) {
    if (hoverX === null || hoverX < x0 || hoverX > x1) { return -1; }
    return Math.max(0, Math.min(n - 1, Math.floor((hoverX - x0) / (x1 - x0) * n)));
  }

  /* ---------- Solar wind ---------- */

  var WIND = [
    { key: 'bz', feed: 'mag', name: 'Bz', unit: 'nT', digits: 1, signed: true, floor: 5, h: 1.4 },
    { key: 'speed', feed: 'wind', name: 'Speed', unit: 'km/s', digits: 0, floor: 50, h: 1 },
    { key: 'density', feed: 'wind', name: 'Density', unit: '/cm³', digits: 1, floor: 2, h: 1 }
  ];

  function windData() {
    var mag = Data.state.mag || [], wind = Data.state.wind || [];
    var latest = Math.max(mag.length ? +mag[mag.length - 1].time : 0, wind.length ? +wind[wind.length - 1].time : 0);
    var win = window24(latest);
    return WIND.map(function (s) {
      var rows = s.feed === 'mag' ? mag : wind;
      var bins = halfHours(rows, s.key, win.t0, win.t1);
      var last = null;
      for (var i = rows.length - 1; i >= 0; i--) { if (rows[i][s.key] != null && isFinite(rows[i][s.key])) { last = rows[i][s.key]; break; } }
      // Speed and density stand from the year's normal; until it loads, from today's.
      var base = 0;
      if (s.key !== 'bz') {
        if (BG && BG[s.key]) { base = BG[s.key].level; } else {
          var vs = bins.filter(function (b) { return b.v != null; }).map(function (b) { return b.v; }).sort(function (a, b) { return a - b; });
          base = vs.length ? vs[vs.length >> 1] : 0;
        }
      }
      return { s: s, bins: bins, now: last, base: base, t0: win.t0, t1: win.t1 };
    });
  }

  function drawWind(ctx, W, H, hoverX) {
    if (!Data.state.mag || !Data.state.wind) { return waiting(Data.state.mag ? 'wind' : 'mag', 'the solar wind'); }
    var rows = windData();
    if (!rows[0].bins.some(function (b) { return b.v != null; })) { return { message: 'No recent solar wind data from L1.' }; }

    var x0 = 52, x1 = W - 4, axisH = 26, gap = 22;
    var units = rows.reduce(function (a, r) { return a + r.s.h; }, 0);
    var avail = H - axisH - gap * (rows.length - 1);
    var hi = hoverIndex(hoverX, x0, x1, rows[0].bins.length);
    var top = 0;
    rows.forEach(function (r) {
      var s = r.s, h = avail * s.h / units;
      var half = scaleOf(r.bins, r.base, s.floor);
      strip(ctx, {
        name: s.name, unit: s.unit, key: s.key, bins: r.bins, base: r.base, half: half, digits: s.digits,
        signed: s.signed, now: r.now, x0: x0, x1: x1, top: top, h: h, hover: hi,
        notes: s.key === 'bz' ? [] : ['from the year’s normal, ' + num(r.base, s.digits === 0 ? 0 : 1), 'normal ' + num(r.base, s.digits === 0 ? 0 : 1)],
        baseLabel: s.key === 'bz' ? '0' : num(r.base, s.digits === 0 ? 0 : 1),
        topLabel: s.key === 'bz' ? '+' + half : num(r.base + half, s.digits === 0 ? 0 : 1),
        bottomLabel: s.key === 'bz' ? MINUS + half : num(Math.max(0, r.base - half), s.digits === 0 ? 0 : 1)
      });
      top += h + gap;
    });
    var n = rows[0].bins.length;
    timeAxis(ctx, rows[0].t0, rows[0].t1, x0, x1, H - 8,
      hi < 0 ? null : x0 + (hi + 0.5) * (x1 - x0) / n, hi < 0 ? '' : f('hm', rows[0].bins[hi].t));
    return {};
  }

  function tableWind() {
    if (!Data.state.mag || !Data.state.wind) { return ''; }
    var rows = windData();
    var body = [];
    for (var i = rows[0].bins.length - 1; i >= 0; i--) {
      var t = rows[0].bins[i].t;
      body.push('<tr><td>' + escapeHtml(f('hm', t)) + '</td>' + rows.map(function (r) {
        var b = r.bins[i], z = b.v == null ? null : sigmas(r.s.key, b.v);
        return '<td>' + (r.s.signed ? signed(b.v, r.s.digits) : num(b.v, r.s.digits)) + '</td><td>' + (z == null ? '–' : z.toFixed(1)) + '</td>';
      }).join('') + '</tr>');
    }
    return '<table><thead><tr><th>' + escapeHtml(zoneName() || 'Time') + '</th><th>Bz nT</th><th>σ south</th><th>km/s</th><th>σ faster</th><th>/cm³</th><th>σ denser</th></tr></thead><tbody>'
      + body.join('') + '</tbody></table>';
  }

  /* ---------- Kp ---------- */

  // Kp comes in thirds and NOAA counts 5− (4.67) as Kp 5, so levels go by the rounded value.
  function gOf(kp) {
    var k = Math.round(kp);
    return k >= 7 ? 3 : k >= 6 ? 2 : k >= 5 ? 1 : 0;
  }

  function gWords(kp) {
    var k = Math.round(kp);
    var g = k >= 9 ? 5 : k >= 8 ? 4 : gOf(kp);
    if (g) { return 'G' + g + ' ' + ['', 'minor', 'moderate', 'strong', 'severe', 'extreme'][g] + ' storm'; }
    return k >= 4 ? 'Active' : k >= 3 ? 'Unsettled' : 'Quiet';
  }

  var KIND_WORDS = { observed: 'observed', estimated: 'estimated, still running', predicted: 'NOAA forecast' };

  // NOAA's storm bands, muted into the card (solid, so nothing shows through).
  function bands() {
    return [[5, 6, T.g1, 'G1', 0.15], [6, 7, T.g2, 'G2', 0.17], [7, 9, T.g3, 'G3+', 0.19]];
  }

  // A small marker above the plot: a downward notch and its word.
  function marker(ctx, x, y, color, word) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 6);
    ctx.lineTo(x + 5, y - 6);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    if (word) { label(ctx, word, x + 9, y - 4, color); }
  }

  function drawKp(ctx, W, H, hoverX) {
    var rows = Data.state.kpForecast;
    if (!rows || !rows.length) { return waiting('kpForecast', 'NOAA’s Kp'); }

    var pad = { l: 22, r: 40, t: 50, b: 26 };
    var plotW = Math.max(10, W - pad.l - pad.r);
    var t0 = +rows[0].time, t1 = +rows[rows.length - 1].time + 3 * HOUR;
    function x(t) { return pad.l + (t - t0) / (t1 - t0) * plotW; }
    function y(kp) { return pad.t + (9 - kp) / 9 * (H - pad.t - pad.b); }
    var slot = plotW * 3 * HOUR / (t1 - t0);
    var barW = Math.max(1, Math.min(22, slot - 2));

    bands().forEach(function (b) {
      ctx.fillStyle = mix(T.night, b[2], b[4]);
      ctx.fillRect(pad.l, y(b[1]), plotW, y(b[0]) - y(b[1]));
      label(ctx, b[3], pad.l + plotW + 8, (y(b[0]) + y(b[1])) / 2, T.inkSoft);
    });
    hline(ctx, pad.l, pad.l + plotW, y(0), T.axis);
    label(ctx, '0', pad.l - 8, y(0), T.inkFaint, 'right');
    label(ctx, '5', pad.l - 8, y(5), T.inkFaint, 'right');
    label(ctx, '9', pad.l - 8, y(9), T.inkFaint, 'right');

    var hover = null;
    var hoverT = hoverX !== null && hoverX >= pad.l && hoverX <= pad.l + plotW ? t0 + (hoverX - pad.l) / plotW * (t1 - t0) : null;
    rows.forEach(function (r) {
      var cx = x(+r.time + 1.5 * HOUR);
      var top = y(Math.max(r.kp, 0.15));
      var bx = Math.round(cx - barW / 2), bw = Math.max(1, Math.round(barW));
      var on = hoverT !== null && hoverT >= +r.time && hoverT < +r.time + 3 * HOUR;
      if (on) { hover = { x: cx, y: top, r: r }; }
      if (r.kind === 'predicted') {
        ctx.strokeStyle = on ? T.ink : T.inkFaint;
        ctx.lineWidth = 1;
        rounded(ctx, bx + 0.5, top + 0.5, bw - 1, y(0) - top - 0.5, 3, true);
        ctx.stroke();
      } else {
        ctx.fillStyle = on ? T.ink : r.kind === 'estimated' ? mix(T.night, T.inkFaint, 0.7) : T.inkFaint;
        rounded(ctx, bx, top, bw, y(0) - top, 3, true);
        ctx.fill();
      }
    });

    // The readout, top left: the latest Kp, or under the pointer, that block's. Whole
    // numbers, as the storm levels go.
    var now = Date.now(), latest = null;
    rows.forEach(function (r) { if (r.kind !== 'predicted' && +r.time <= now) { latest = r; } });
    var read = hover ? hover.r : latest;
    if (read) {
      font(ctx, 700, 22);
      var kpText = 'Kp ' + Math.round(read.kp);
      label(ctx, kpText, pad.l, 12, T.ink);
      var kw = ctx.measureText(kpText).width;
      font(ctx, 400, 13);
      label(ctx, gWords(read.kp) + (read.kind === 'predicted' ? ', forecast' : ''), pad.l + kw + 10, 13, T.inkSoft);
    }

    // Now, and the time the globe is showing when the slider has moved it: markers over
    // the plot rather than lines through it, so neither reads as a column. Where the
    // columns turn from solid to outlined says the same.
    if (now > t0 && now < t1) { marker(ctx, x(now), pad.t - 8, T.ink, 'now'); }
    var shownT = window.AuroraModel && window.AuroraModel.viewTime;
    if (shownT && shownT > t0 && shownT < t1) {
      marker(ctx, x(shownT), pad.t - 8, T.inkSoft, Math.abs(x(shownT) - x(now)) > 60 ? 'shown' : '');
    }

    // Days, at local midnight; under the pointer, the block's own day and time instead.
    var dayW = plotW * 24 * HOUR / (t1 - t0);
    var every = dayW < 52 ? 2 : 1;
    var hoverText = hover ? f('day', hover.r.time) + ', ' + f('hm', hover.r.time) : '';
    var clear = hover ? ctx.measureText(hoverText).width / 2 + 40 : null;
    var d = new Date(t0);
    d.setHours(24, 0, 0, 0);
    for (var k = 0; +d < t1; k++) {
      var px = x(+d);
      vline(ctx, px, y(0), y(0) + 4, T.axis);
      var lx = px + 3 + ctx.measureText(f('day', d)).width / 2;
      if (k % every === 0 && px < pad.l + plotW - 30 && (clear === null || Math.abs(lx - hover.x) > clear)) {
        label(ctx, f('day', d), px + 3, y(0) + 16, T.inkFaint);
      }
      d.setDate(d.getDate() + 1);
    }
    if (hover) { hoverLabel(ctx, hoverText, hover.x, pad.l, pad.l + plotW, y(0) + 16); }
    return {};
  }

  function tableKp() {
    var rows = Data.state.kpForecast;
    if (!rows) { return ''; }
    return '<table><thead><tr><th>From (' + escapeHtml(zoneName() || 'local') + ')</th><th>Kp</th><th>Level</th><th>Source</th></tr></thead><tbody>'
      + rows.slice().reverse().map(function (r) {
        return '<tr><td>' + escapeHtml(f('full', r.time)) + '</td><td>' + r.kp.toFixed(2) + '</td><td>' + escapeHtml(gWords(r.kp))
          + '</td><td>' + escapeHtml(KIND_WORDS[r.kind] || r.kind) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- MagIE ---------- */

  /*
   * dH a minute from the relay (magie.py): how far the horizontal field at each station
   * stands from its quiet-day curve. Both stations share one scale, so they compare at a
   * glance; each is coloured against its own year.
   */
  function blockAt(s, t) {
    for (var i = 0; i < s.k.length; i++) {
      var b = s.k[i];
      if (t >= +b.time && t < +b.time + 3 * HOUR) { return b; }
    }
    return null;
  }

  function kText(b) {
    if (!b || b.k == null) { return '–'; }
    return b.k + (b.running ? '…' : '');
  }

  function magieData() {
    var m = Data.state.magie;
    var latest = 0;
    m.stations.forEach(function (s) {
      for (var i = s.rows.length - 1; i >= 0; i--) { if (s.rows[i].dH != null) { latest = Math.max(latest, +s.rows[i].time); break; } }
    });
    var win = window24(latest);
    return m.stations.map(function (s) {
      var last = null;
      for (var i = s.rows.length - 1; i >= 0; i--) { if (s.rows[i].dH != null) { last = s.rows[i]; break; } }
      // The latest block with a K: a block only gets one after its first half hour.
      var k = null;
      s.k.forEach(function (b) { if (b.k != null) { k = b; } });
      return { s: s, key: s.id, bins: halfHours(s.rows, 'dH', win.t0, win.t1), now: last ? last.dH : null,
        k: k, t0: win.t0, t1: win.t1 };
    });
  }

  function drawMagie(ctx, W, H, hoverX) {
    var m = Data.state.magie;
    if (!m) {
      return {
        message: Data.state.failed.magie
          ? 'Ireland’s magnetometers come through this site’s own relay, which isn’t answering. Retrying.'
          : 'Waiting for MagIE…'
      };
    }
    if (!m.stations.length || !m.stations[0].rows.length) { return { message: 'No recent data from MagIE.' }; }

    var rows = magieData();
    var x0 = 44, x1 = W - 4, axisH = 26, gap = 20;
    var h = (H - axisH - gap * (rows.length - 1)) / rows.length;
    var half = 0;
    rows.forEach(function (r) { half = Math.max(half, scaleOf(r.bins, 0, 10)); });
    var hi = hoverIndex(hoverX, x0, x1, rows[0].bins.length);
    var hoverT = hi < 0 ? null : rows[0].bins[hi].t;
    rows.forEach(function (r, i) {
      strip(ctx, {
        name: r.s.name, unit: 'nT · K ' + kText(hoverT === null ? r.k : blockAt(r.s, hoverT)), key: r.key, bins: r.bins, base: 0, half: half, digits: 1, signed: true,
        now: r.now, x0: x0, x1: x1, top: i * (h + gap), h: h, hover: hi,
        baseLabel: '0', topLabel: '+' + half, bottomLabel: MINUS + half
      });
    });
    var n = rows[0].bins.length;
    timeAxis(ctx, rows[0].t0, rows[0].t1, x0, x1, H - 8,
      hi < 0 ? null : x0 + (hi + 0.5) * (x1 - x0) / n, hi < 0 ? '' : f('hm', hoverT));
    return {};
  }

  function tableMagie() {
    var m = Data.state.magie;
    if (!m || !m.stations.length) { return ''; }
    var rows = magieData();
    var head = '<th>' + escapeHtml(zoneName() || 'Time') + '</th>'
      + rows.map(function (r) { return '<th>' + escapeHtml(r.s.name) + ' ΔH nT</th><th>σ</th><th>K</th>'; }).join('');
    var body = [];
    for (var i = rows[0].bins.length - 1; i >= 0; i--) {
      var t = rows[0].bins[i].t;
      body.push('<tr><td>' + escapeHtml(f('hm', t)) + '</td>' + rows.map(function (r) {
        var b = r.bins[i], z = b.v == null ? null : sigmas(r.key, b.v);
        return '<td>' + signed(b.v, 1) + '</td><td>' + (z == null ? '–' : z.toFixed(1)) + '</td><td>' + kText(blockAt(r.s, t)) + '</td>';
      }).join('') + '</tr>');
    }
    return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body.join('') + '</tbody></table>';
  }

  /* ---------- Behind the +: gauges and heat strips ---------- */

  /*
   * A gauge: the scale with the year's bands (typical, then 3 and 5 sigma toward aurora),
   * the last 24 hours as a pale bar and now as a white mark, with now's sigma in words.
   */
  function gauge(ctx, top, W, g) {
    var x0 = 196, x1 = W - 6, by0 = top + 10, by1 = top + 38;
    function x(v) { return x0 + (Math.max(g.lo, Math.min(g.hi, v)) - g.lo) / (g.hi - g.lo) * (x1 - x0); }
    font(ctx, 600, 15);
    label(ctx, g.name, 0, top + 14, T.ink);
    font(ctx, 400, 13);
    label(ctx, g.sub || '', 0, top + 34, T.inkSoft);
    font(ctx, 700, 24);
    label(ctx, g.value, x0 - 18, top + 22, T.ink, 'right');
    font(ctx, 400, 13);
    g.bands.forEach(function (b) {
      ctx.fillStyle = mix(T.night, b[2], b[3]);
      ctx.fillRect(x(b[0]), by0, Math.max(0, x(b[1]) - x(b[0]) - 2), by1 - by0);
      if (b[4]) { label(ctx, b[4], x(b[0]) + 6, by1 + 14, T.inkFaint); }
    });
    if (g.range) {
      ctx.fillStyle = mix(T.night, T.ink, 0.45);
      var a = x(g.range[0]), e = x(g.range[1]);
      rounded(ctx, a, by0 + 9, Math.max(4, e - a), 10, 5);
      ctx.fill();
    }
    if (g.now != null) {
      ctx.fillStyle = T.ink;
      rounded(ctx, x(g.now) - 2, by0 - 6, 4, by1 - by0 + 12, 2);
      ctx.fill();
    }
  }

  // Bands for a background series: typical within 3 sigma, then 3-5 and 5+ toward aurora.
  function sigmaBands(key, lo, hi) {
    var b = BG && BG[key];
    if (!b) { return [[lo, hi, T.ink, 0.06, '']]; }
    var s = b.sigma, L = b.level, d = DRIVE[key];
    var e3 = mix(T.quiet, T.event, 0.5);
    var out = [];
    if (d === -1) {
      out.push([lo, L - 5 * s, T.event, 0.42, '5σ'], [L - 5 * s, L - 3 * s, e3, 0.34, '3σ'], [L - 3 * s, hi, T.ink, 0.07, 'typical']);
    } else if (d === 1) {
      out.push([lo, L + 3 * s, T.ink, 0.07, 'typical'], [L + 3 * s, L + 5 * s, e3, 0.34, '3σ'], [L + 5 * s, hi, T.event, 0.42, '5σ']);
    } else {
      out.push([lo, L - 5 * s, T.event, 0.42, ''], [L - 5 * s, L - 3 * s, e3, 0.34, ''], [L - 3 * s, L + 3 * s, T.ink, 0.07, 'typical'],
        [L + 3 * s, L + 5 * s, e3, 0.34, '3σ'], [L + 5 * s, hi, T.event, 0.42, '5σ']);
    }
    return out.filter(function (q) { return q[1] > lo && q[0] < hi; }).map(function (q) {
      return [Math.max(lo, q[0]), Math.min(hi, q[1]), q[2], q[3], q[4]];
    });
  }

  function gaugeSpan(key, rows, now) {
    var b = BG && BG[key];
    var vals = rows.filter(function (q) { return q.v != null; }).map(function (q) { return q.v; });
    if (now != null) { vals.push(now); }
    var L = b ? b.level : 0, s = b ? b.sigma : 1;
    var lo = Math.min(L - 6.5 * s, Math.min.apply(null, vals));
    var hi = Math.max(L + 6.5 * s, Math.max.apply(null, vals));
    if (DRIVE[key] === 1) { lo = Math.max(0, Math.min(L - 3.5 * s, Math.min.apply(null, vals))); }
    return [lo, hi];
  }

  function rangeOf(bins) {
    var v = bins.filter(function (q) { return q.v != null; }).map(function (q) { return q.v; });
    return v.length ? [Math.min.apply(null, v), Math.max.apply(null, v)] : null;
  }

  function yearWords() {
    var b = BG && (BG.bz || BG.dun);
    return b ? f('month', b.from) + ' to ' + f('month', b.to) : 'the past year';
  }

  function drawWindGauges(ctx, W, H) {
    if (!Data.state.mag || !Data.state.wind) { return waiting('mag', 'the solar wind'); }
    var rows = windData();
    rows.forEach(function (r, i) {
      var span = gaugeSpan(r.s.key, r.bins, r.now);
      gauge(ctx, i * 74, W, {
        name: r.s.name + ' ' + r.s.unit, value: r.s.signed ? signed(r.now, r.s.digits) : num(r.now, r.s.digits),
        sub: sigmaWords(r.s.key, r.now), lo: span[0], hi: span[1], bands: sigmaBands(r.s.key, span[0], span[1]),
        range: rangeOf(r.bins), now: r.now
      });
    });
    label(ctx, 'Pale bar: the last 24 hours. White mark: now. Bands from ' + yearWords() + '.', 0, H - 8, T.inkFaint);
    return {};
  }

  function drawMagieGauges(ctx, W, H) {
    if (!Data.state.magie) { return waiting('magie', 'MagIE'); }
    var rows = magieData();
    rows.forEach(function (r, i) {
      var span = gaugeSpan(r.key, r.bins, r.now);
      gauge(ctx, i * 74, W, {
        name: r.s.name + ' nT', value: signed(r.now, 1), sub: sigmaWords(r.key, r.now),
        lo: span[0], hi: span[1], bands: sigmaBands(r.key, span[0], span[1]), range: rangeOf(r.bins), now: r.now
      });
    });
    label(ctx, 'Pale bar: the last 24 hours. White mark: now. Bands from ' + yearWords() + '.', 0, H - 8, T.inkFaint);
    return {};
  }

  function drawKpGauge(ctx, W, H) {
    var rows = Data.state.kpForecast;
    if (!rows || !rows.length) { return waiting('kpForecast', 'NOAA’s Kp'); }
    var now = Date.now(), last = null, lo = 9, hi = 0;
    rows.forEach(function (r) {
      if (r.kind === 'predicted' || +r.time > now) { return; }
      last = r;
      if (+r.time >= now - SPAN) { lo = Math.min(lo, r.kp); hi = Math.max(hi, r.kp); }
    });
    if (!last) { return {}; }
    var bandsK = [[0, 4, T.ink, 0.06, 'Quiet'], [4, 5, T.ink, 0.12, '']].concat(bands().map(function (b) { return [b[0], b[1], b[2], b[4] + 0.2, b[3]]; }));
    gauge(ctx, 0, W, { name: 'Kp', value: last.kp.toFixed(1), sub: gWords(last.kp), lo: 0, hi: 9, bands: bandsK, range: lo <= hi ? [lo, hi] : null, now: last.kp });
    label(ctx, 'Pale bar: the last 24 hours. White mark: now.', 0, H - 8, T.inkFaint);
    return {};
  }

  // Heat strips: each half hour as a cell, grey for how far it stands within 3 sigma,
  // then into the event colour as the columns are.
  function heat(ctx, top, W, x0, x1, name, nowText, key, bins) {
    var hgt = 34, slot = (x1 - x0) / bins.length;
    font(ctx, 600, 15);
    label(ctx, name, 0, top + hgt / 2, T.ink);
    font(ctx, 700, 18);
    label(ctx, nowText, W - 4, top + hgt / 2, T.ink, 'right');
    font(ctx, 400, 13);
    bins.forEach(function (b, i) {
      if (b.v == null) { return; }
      var z = sigmas(key, b.v);
      var bg = BG && BG[key];
      var raw = bg ? Math.abs(b.v - bg.level) / bg.sigma : 0;
      ctx.fillStyle = z != null && z >= EVENT_FROM ? eventColor(z) : mix(T.night, T.ink, 0.05 + 0.4 * Math.min(1, raw / EVENT_FROM));
      ctx.fillRect(x0 + i * slot, top, slot + 0.4, hgt);
    });
  }

  function drawWindHeat(ctx, W, H) {
    if (!Data.state.mag || !Data.state.wind) { return waiting('mag', 'the solar wind'); }
    var rows = windData(), x0 = 96, x1 = W - 84;
    rows.forEach(function (r, i) {
      heat(ctx, i * 50, W, x0, x1, r.s.name, (r.s.signed ? signed(r.now, r.s.digits) : num(r.now, r.s.digits)), r.s.key, r.bins);
    });
    timeAxis(ctx, rows[0].t0, rows[0].t1, x0, x1, H - 8);
    return {};
  }

  function drawMagieHeat(ctx, W, H) {
    if (!Data.state.magie) { return waiting('magie', 'MagIE'); }
    var rows = magieData(), x0 = 96, x1 = W - 84;
    rows.forEach(function (r, i) { heat(ctx, i * 50, W, x0, x1, r.s.name, signed(r.now, 1), r.key, r.bins); });
    timeAxis(ctx, rows[0].t0, rows[0].t1, x0, x1, H - 8);
    return {};
  }

  /* ---------- Alerts ---------- */

  /*
   * SWPC's geomagnetic messages for the past week, grouped into episodes: messages less
   * than 12 hours apart belong together. Each episode is one line in plain words, led by
   * the highest K it reached (or was warned of, or the storm level watched for). The
   * messages themselves, in sentence case, are behind the +.
   */
  var EPISODE_GAP = 12 * HOUR;

  function episodes(alerts) {
    var week = Date.now() - 7 * 24 * HOUR;
    var list = alerts.filter(function (a) { return +a.time >= week; }).slice().sort(function (a, b) { return a.time - b.time; });
    var out = [];
    list.forEach(function (a) {
      var ep = out[out.length - 1];
      // An extended warning belongs to the storm it extends, however long after.
      var gap = /^EXTENDED/.test(a.title) ? 2 * EPISODE_GAP : EPISODE_GAP;
      if (!ep || +a.time - ep.end > gap) { ep = { start: +a.time, end: +a.time, items: [] }; out.push(ep); }
      ep.items.push(a);
      ep.end = Math.max(ep.end, +a.time);
    });
    // A watch supersedes the ones before it, so only the latest watch-only episode stays.
    var eps = out.reverse().map(summarise).filter(Boolean);
    var watchSeen = false;
    return eps.filter(function (e) {
      if (!e.watchOnly) { return true; }
      if (watchSeen) { return false; }
      watchSeen = true;
      return true;
    });
  }

  var G_NAMES = ['', 'minor', 'moderate', 'strong', 'severe', 'extreme'];

  function summarise(ep) {
    var alertK = 0, alertAt = null, warnK = 0, warnFrom = null, warnTo = null, watch = null, impulse = null, cancelled = {};
    ep.items.forEach(function (a) { if (a.cancels) { cancelled[a.cancels] = true; } });
    ep.items.forEach(function (a) {
      if (a.kind === 'alert' && a.k > alertK) { alertK = a.k; alertAt = a.reached || a.time; }
      if (a.kind === 'warning' && a.k) {
        if (a.k > warnK) { warnK = a.k; warnFrom = a.from || a.time; }
        if (a.k === warnK && a.to) { warnTo = a.to; }
      }
      if (a.kind === 'watch' && a.g && !cancelled[a.serial]) { watch = a; }
      if (a.impulse) { impulse = a; }
    });
    var e = { start: ep.start, end: ep.end, items: ep.items };
    if (alertK) {
      var g = gOf(alertK);
      e.level = 'K' + alertK;
      e.g = g;
      e.text = g ? 'G' + g + ' ' + G_NAMES[g] + ' storm' : 'Kp ' + alertK + ' reached';
      e.at = +alertAt;
    } else if (warnK) {
      e.level = 'K' + warnK;
      e.g = gOf(warnK);
      e.outline = true;
      e.text = 'Kp ' + warnK + ' expected';
      e.at = +warnFrom;
    } else if (watch) {
      var gw = +watch.g.slice(1);
      e.level = watch.g;
      e.g = gw;
      e.outline = true;
      e.text = 'G' + gw + ' storm forecast' + (watch.days && watch.days.length
        ? ' for ' + watch.days.map(function (d) { return f('dayUtc', d); }).join(' and ') : '');
      e.at = +watch.time;
      e.watchOnly = true;
    } else if (impulse) {
      e.level = 'SI';
      e.g = 0;
      e.text = 'Sudden impulse';
      e.at = +(impulse.observed || impulse.time);
    } else {
      return null;
    }
    return e;
  }

  // What's in force now: an unexpired warning, or a watch for today or later.
  function inForce(alerts) {
    var now = Date.now(), warn = null, watch = null, cancelled = {};
    alerts.forEach(function (a) { if (a.cancels) { cancelled[a.cancels] = true; } });
    alerts.forEach(function (a) {
      if (a.kind === 'warning' && a.to && +a.to > now && (!warn || a.k > warn.k)) { warn = a; }
      if (a.kind === 'watch' && a.g && !cancelled[a.serial] && a.days) {
        var ahead = a.days.filter(function (d) { return +d + 24 * HOUR > now; });
        if (ahead.length && (!watch || +a.time > +watch.time)) { watch = { a: a, days: ahead }; }
      }
    });
    var out = [];
    if (warn) { out.push('Kp ' + warn.k + ' warning in force to ' + f('full', warn.to) + '.'); }
    if (watch) { out.push(watch.a.g + ' watch for ' + watch.days.map(function (d) { return f('dateUtc', d); }).join(' and ') + '.'); }
    return out.length ? out.join(' ') : 'Nothing in force now.';
  }

  // A message's times in local time, in words.
  function messageDetail(a) {
    if (a.reached) { return 'Reached ' + f('full', a.reached); }
    if (a.impulse && a.observed) { return 'Observed ' + f('full', a.observed); }
    if (a.from || a.to) {
      return (a.from ? 'From ' + f('full', a.from) : 'In force') + (a.to ? ' to ' + f('full', a.to) : '');
    }
    if (a.days && a.days.length) { return 'For ' + a.days.map(function (d) { return f('dateUtc', d); }).join(' and '); }
    return a.detail || '';
  }

  function sentenceCase(title) {
    return title.replace(/^([A-Z ]+):/, function (m, p) {
      return p.charAt(0) + p.slice(1).toLowerCase() + ':';
    }).replace(/Geomagnetic/, 'geomagnetic');
  }

  function renderAlerts() {
    var list = document.querySelector('[data-bind="alerts"]');
    var nowEl = document.querySelector('[data-bind="alerts-now"]');
    var full = document.querySelector('[data-bind="alerts-full"]');
    if (!list) { return; }
    var alerts = Data.state.alerts;
    if (!alerts) {
      list.innerHTML = '<li class="alerts-none">' + (Data.state.failed.alerts ? 'SWPC’s alerts didn’t load. Retrying.' : 'Waiting for SWPC…') + '</li>';
      if (nowEl) { nowEl.textContent = ''; }
      return;
    }
    var eps = episodes(alerts).slice(0, 4);
    if (!eps.length) {
      list.innerHTML = '<li class="alerts-none">No geomagnetic warnings, watches or alerts in the past week.</li>';
    } else {
      // When it was issued leads; then the level, and a few words.
      list.innerHTML = eps.map(function (e) {
        return '<li class="episode">'
          + '<time class="ep-when" datetime="' + new Date(e.at).toISOString() + '"><b>' + escapeHtml(f('date', e.at)) + '</b>'
          + '<span>' + escapeHtml(f('hm', e.at)) + '</span></time>'
          + '<span class="ep-level' + (e.outline ? ' ep-outline' : '') + '" data-g="' + (e.g || 0) + '">' + escapeHtml(e.level) + '</span>'
          + '<span class="ep-text">' + escapeHtml(e.text) + '</span>'
          + '</li>';
      }).join('');
    }
    if (nowEl) { nowEl.textContent = inForce(alerts); }
    if (full) {
      var week = Date.now() - 7 * 24 * HOUR;
      full.innerHTML = alerts.filter(function (a) { return +a.time >= week; }).map(function (a) {
        return '<li><time datetime="' + a.time.toISOString() + '">' + escapeHtml(f('full', a.time)) + '</time>'
          + '<b>' + escapeHtml(sentenceCase(a.title)) + '</b>'
          + '<span>' + escapeHtml(messageDetail(a)) + '</span></li>';
      }).join('') || '<li>None in the past week.</li>';
    }
  }

  /* ---------- Boot ---------- */

  readTokens();

  function body(sel) { return document.querySelector(sel); }

  var charts = {
    wind: Chart(body('#chart-wind > .chart-body'), { label: 'Solar wind at L1 over the last 24 hours, as half-hour medians: Bz in nanotesla, speed in km/s and proton density, each against the past year.', draw: drawWind, table: tableWind }),
    kp: Chart(body('#chart-kp > .chart-body'), { label: 'Planetary Kp, three-hourly, for the past week and NOAA’s three-day forecast, over NOAA’s storm bands.', draw: drawKp, table: tableKp }),
    magie: Chart(body('#chart-magie > .chart-body'), { label: 'The horizontal magnetic field at Dunsink and Valentia over the last 24 hours, as half-hour medians in nanotesla from a quiet day.', draw: drawMagie, table: tableMagie }),
    windGauges: Chart(body('[data-extra="wind-gauges"]'), { label: 'The solar wind now against the past year.', draw: drawWindGauges, hover: false }),
    windHeat: Chart(body('[data-extra="wind-heat"]'), { label: 'The solar wind over the last 24 hours as heat strips.', draw: drawWindHeat, hover: false }),
    kpGauge: Chart(body('[data-extra="kp-gauge"]'), { label: 'Kp now against NOAA’s storm bands.', draw: drawKpGauge, hover: false }),
    magieGauges: Chart(body('[data-extra="magie-gauges"]'), { label: 'Ireland’s magnetometers now against the past year.', draw: drawMagieGauges, hover: false }),
    magieHeat: Chart(body('[data-extra="magie-heat"]'), { label: 'Ireland’s magnetometers over the last 24 hours as heat strips.', draw: drawMagieHeat, hover: false })
  };

  var FEED_CHART = { mag: ['wind', 'windGauges', 'windHeat'], wind: ['wind', 'windGauges', 'windHeat'],
    kpForecast: ['kp', 'kpGauge'], magie: ['magie', 'magieGauges', 'magieHeat'] };

  document.addEventListener('aurora:data', function (e) {
    var name = e.detail && e.detail.feed;
    if (name === 'alerts') { renderAlerts(); return; }
    (FEED_CHART[name] || []).forEach(function (k) { if (charts[k]) { charts[k].render(); } });
  });

  // The Kp chart's cursor follows the slider, at most five times a second.
  var kpPending = null;
  document.addEventListener('aurora:time', function () {
    if (kpPending || !charts.kp) { return; }
    kpPending = setTimeout(function () {
      kpPending = null;
      charts.kp.render();
    }, 200);
  });

  function renderAll() {
    Object.keys(charts).forEach(function (k) { if (charts[k]) { charts[k].render(); } });
    renderAlerts();
  }

  // The "now" line and relative times move on their own.
  setInterval(renderAll, 60000);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(renderAll);
  }

  loadBackground();
  renderAll();
})();
