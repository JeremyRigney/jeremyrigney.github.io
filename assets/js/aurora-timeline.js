/*
 * jeremy.ie/aurora — the time slider.
 *
 * A track from 24 hours back to three days ahead (or to the end of NOAA's Kp
 * forecast, if that comes sooner). It sets AuroraModel's clock, and everything that
 * shows a time follows: the globe, both layers, the terminator, the readouts and the
 * Kp chart's cursor.
 *
 * The track reads like a day planner and says when to look before you scrub it:
 *   - times along the top, each on a dashed rule: local midnights by day, and the
 *     hours between as room allows;
 *   - a bar for each 3-hour Kp slot, in the Kp chart's storm colours, paler where it
 *     is NOAA's forecast rather than an observation;
 *   - the night at the chosen place (Sun below -12 degrees), shaded behind the bars;
 *   - a solid rule at now. The thumb is a white pill on a white rule.
 *
 * Live is the default and the place the thumb rests. Dragging within SNAP of now
 * lets go back to live; "Live" does the same from anywhere. Play runs at PLAY_RATE,
 * the pace of MagIE's 72-hour video in 24 seconds, and stops at the end; under
 * reduced motion it steps a slot at a time instead of gliding. In the Sun view, which
 * has only the past day's pictures, it plays that day up to now and returns to live.
 */
(function () {
  'use strict';

  var Geo = window.AuroraGeo;
  var Data = window.AuroraData;
  var Model = window.AuroraModel;
  if (!Geo || !Data || !Model) { return; }

  var HOUR = 3600000;
  var MIN = 60000;
  var BACK = 24 * HOUR;
  var AHEAD = 72 * HOUR;
  var SNAP = 15 * MIN;
  var PLAY_RATE = 3 * HOUR; // per second
  var DARK_ALT = -12;

  var root = document.getElementById('timeline');
  if (!root) { return; }
  var track = root.querySelector('.tl-track');
  var canvas = root.querySelector('.tl-canvas');
  var thumb = root.querySelector('.tl-thumb');
  var thumbLabel = root.querySelector('.tl-thumb-label');
  var playBtn = root.querySelector('.tl-play');
  var liveBtn = root.querySelector('.tl-live');
  var ctx = canvas.getContext('2d');

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ICON_PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="2.8" height="9" fill="currentColor"/><rect x="7.2" y="1.5" width="2.8" height="9" fill="currentColor"/></svg>';

  /* ---------- Formatting ---------- */

  function fmt(opts) {
    try { return new Intl.DateTimeFormat(undefined, opts); } catch (err) { return null; }
  }

  var F = {
    hm: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
    day: fmt({ weekday: 'short' }),
    dayNum: fmt({ weekday: 'short', day: 'numeric' }),
    long: fmt({ weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })
  };

  function f(name, t) {
    var d = new Date(t);
    return F[name] ? F[name].format(d) : d.toISOString().slice(0, 16).replace('T', ' ');
  }

  function token(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  var T = {};

  function readTokens() {
    T.ink = token('--ink', '#e8f0f3');
    T.inkSoft = token('--ink-soft', '#a7b4bc');
    T.inkFaint = token('--ink-faint', '#7d8b95');
    T.rule = token('--rule', 'rgba(238,243,246,0.1)');
    T.ruleStrong = token('--rule-strong', 'rgba(238,243,246,0.2)');
    T.shade = token('--inset', 'rgba(238,243,246,0.055)');
    T.quiet = token('--series-quiet', '#6f7f8a');
    T.g1 = token('--g1', '#fab219');
    T.g2 = token('--g2', '#ec835a');
    T.g3 = token('--g3', '#d03b3b');
    T.font = token('--font', '"Figtree", "Helvetica Neue", Arial, sans-serif');
  }

  readTokens();

  // By the rounded Kp: NOAA counts 5- (4.67) as Kp 5.
  function gColor(kp) {
    kp = Math.round(kp);
    return kp >= 7 ? T.g3 : kp >= 6 ? T.g2 : kp >= 5 ? T.g1 : T.quiet;
  }

  /* ---------- Range ---------- */

  var t0 = 0, t1 = 1;

  function range() {
    var now = Date.now();
    t0 = Math.floor((now - BACK) / HOUR) * HOUR;
    t1 = now + AHEAD;
    var rows = Data.state.kpForecast;
    if (rows && rows.length) {
      t1 = Math.min(t1, +rows[rows.length - 1].time + 3 * HOUR);
    }
    t1 = Math.max(t1, now + 3 * HOUR);
  }

  function clampT(t) {
    return Math.max(t0, Math.min(t1, t));
  }

  /* ---------- Drawing ---------- */

  var w = 0, h = 0, dpr = 1;

  function size() {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }

  function x(t) {
    return (t - t0) / (t1 - t0) * w;
  }

  var place = { lat: 55.38, lon: -7.37 };

  // A bar with its top corners rounded, standing on y0 + rh.
  function bar(x0, y0, rw, rh, r) {
    r = Math.max(0, Math.min(r, rw / 2, rh));
    ctx.beginPath();
    ctx.moveTo(x0, y0 + rh);
    ctx.lineTo(x0, y0 + r);
    ctx.arcTo(x0, y0, x0 + r, y0, r);
    ctx.lineTo(x0 + rw - r, y0);
    ctx.arcTo(x0 + rw, y0, x0 + rw, y0 + r, r);
    ctx.lineTo(x0 + rw, y0 + rh);
    ctx.closePath();
  }

  function draw() {
    if (!w) { size(); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Top to bottom: the time labels (and the thumb's pill), then the bars.
    var labelY = 11, ruleTop = 25, barTop = 31, base = h - 4;
    var barH = base - barTop;
    var nowX = x(Date.now());

    // Night at the place.
    ctx.fillStyle = T.shade;
    var step = 10 * MIN, open = null;
    for (var t = t0; t <= t1 + step; t += step) {
      var dark = t <= t1 && Geo.sunAltitude(new Date(t), place.lat, place.lon) < DARK_ALT;
      if (dark && open === null) { open = t; }
      if (!dark && open !== null) {
        var xa0 = x(open), xb0 = x(Math.min(t, t1));
        bar(xa0, ruleTop, xb0 - xa0, h - ruleTop, 6);
        ctx.fill();
        open = null;
      }
    }

    // Times, on dashed rules: every 3, 6 or 12 hours as room allows, always midnight.
    ctx.font = '500 12px ' + T.font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    var perHour = w / ((t1 - t0) / HOUR);
    var every = [3, 6, 12].filter(function (n) { return n * perHour >= 64; })[0] || 24;
    var c = new Date(t0);
    c.setMinutes(0, 0, 0);
    if (+c < t0) { c.setHours(c.getHours() + 1); }
    ctx.setLineDash([2, 3]);
    for (; +c <= t1; c.setHours(c.getHours() + 1)) {
      var hr = c.getHours();
      if (hr % every) { continue; }
      var px = Math.round(x(+c)) + 0.5;
      ctx.strokeStyle = hr === 0 ? T.ruleStrong : T.rule;
      ctx.beginPath();
      ctx.moveTo(px, ruleTop);
      ctx.lineTo(px, h);
      ctx.stroke();
      var s = hr === 0 ? f(perHour * 24 > 110 ? 'dayNum' : 'day', +c) : f('hm', +c);
      var half = ctx.measureText(s).width / 2;
      if (px - half < 0 || px + half > w || Math.abs(px - nowX) < half + 32) { continue; }
      ctx.fillStyle = hr === 0 ? T.inkSoft : T.inkFaint;
      ctx.fillText(s, px, labelY);
    }
    ctx.setLineDash([]);

    // Baseline, then Kp, a bar per slot.
    ctx.fillStyle = T.rule;
    ctx.fillRect(0, base, w, 1);
    var rows = Data.state.kpForecast || [];
    rows.forEach(function (r) {
      var a = +r.time, b = a + 3 * HOUR;
      if (b <= t0 || a >= t1) { return; }
      var xa = Math.max(0, x(a)) + 1.5, xb = Math.min(w, x(b)) - 1.5;
      if (xb <= xa) { return; }
      var bh = Math.max(2, r.kp / 9 * barH);
      ctx.globalAlpha = r.kind === 'predicted' ? 0.45 : r.kind === 'estimated' ? 0.75 : 1;
      ctx.fillStyle = gColor(r.kp);
      bar(xa, base - bh, xb - xa, bh, 3);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // Now: a solid rule, named. The thumb's pill covers the name while live.
    var nx = Math.round(nowX) + 0.5;
    ctx.strokeStyle = T.inkSoft;
    ctx.beginPath();
    ctx.moveTo(nx, ruleTop);
    ctx.lineTo(nx, h);
    ctx.stroke();
    ctx.font = '600 12px ' + T.font;
    ctx.fillStyle = T.ink;
    var nw = ctx.measureText('Now').width / 2;
    ctx.fillText('Now', Math.max(nw, Math.min(w - nw, nx)), labelY);

    placeThumb();
  }

  function placeThumb() {
    var vt = Model.viewTime;
    var t = vt === null ? Date.now() : vt;
    thumb.style.left = x(clampT(t)) + 'px';
    var label = vt === null ? 'Now' : f('dayNum', t) + ' ' + f('hm', t);
    if (thumbLabel.textContent !== label) { thumbLabel.textContent = label; }
    // Keep the label inside the track at either end.
    var lw = thumbLabel.offsetWidth;
    var px = x(clampT(t));
    var shift = Math.max(lw / 2 - px, Math.min(0, w - px - lw / 2));
    thumbLabel.style.transform = 'translateX(calc(-50% + ' + shift + 'px))';

    var hours = Math.round((t - Date.now()) / HOUR);
    track.setAttribute('aria-valuemin', String(Math.round((t0 - Date.now()) / HOUR)));
    track.setAttribute('aria-valuemax', String(Math.round((t1 - Date.now()) / HOUR)));
    track.setAttribute('aria-valuenow', String(vt === null ? 0 : hours));
    track.setAttribute('aria-valuetext', vt === null ? 'Live: NOAA’s current forecast' : valueText(t));
    liveBtn.setAttribute('aria-disabled', vt === null ? 'true' : 'false');
  }

  function valueText(t) {
    var k = Model.kpAt(t);
    var kind = !k ? '' : k.kind === 'observed' ? ', observed Kp ' : ', forecast Kp ';
    return f('long', t) + (k ? kind + k.kp.toFixed(1) : '') + ', modelled';
  }

  /* ---------- Setting the time ---------- */

  function setTime(t) {
    if (t === null || Math.abs(t - Date.now()) < SNAP) {
      Model.setTime(null);
    } else {
      Model.setTime(clampT(t));
    }
    placeThumb();
  }

  function timeAt(clientX) {
    var r = canvas.getBoundingClientRect();
    return t0 + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (t1 - t0);
  }

  var dragId = null;

  track.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) { return; }
    dragId = e.pointerId;
    try { track.setPointerCapture(e.pointerId); } catch (err) { /* released */ }
    pause();
    setTime(timeAt(e.clientX));
    track.focus({ preventScroll: true });
    e.preventDefault();
  });

  track.addEventListener('pointermove', function (e) {
    if (e.pointerId !== dragId) { return; }
    setTime(timeAt(e.clientX));
  });

  function endDrag(e) {
    if (e.pointerId === dragId) { dragId = null; }
  }
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  track.addEventListener('keydown', function (e) {
    var cur = Model.viewTime === null ? Date.now() : Model.viewTime;
    var next = null;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': next = cur - (e.shiftKey ? 3 : 1) * HOUR; break;
      case 'ArrowRight': case 'ArrowUp': next = cur + (e.shiftKey ? 3 : 1) * HOUR; break;
      case 'PageDown': next = cur - 24 * HOUR; break;
      case 'PageUp': next = cur + 24 * HOUR; break;
      case 'Home': next = t0; break;
      case 'End': next = t1; break;
      case 'l': case 'L': pause(); setTime(null); e.preventDefault(); return;
      case ' ': toggle(); e.preventDefault(); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    pause();
    setTime(next);
  });

  liveBtn.addEventListener('click', function () {
    pause();
    setTime(null);
  });

  /* ---------- Play ---------- */

  var playing = false, lastFrame = 0, stepAcc = 0;
  // In the Sun view there are only the past day's pictures: Play from live goes back a
  // day and runs to now, then returns to live, rather than on into the forecast.
  var playEnd = null; // null: the track's end

  function showPlay() {
    playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play through time');
  }

  function play() {
    if (playing) { return; }
    range();
    var cur = Model.viewTime === null ? Date.now() : Model.viewTime;
    playEnd = null;
    if (document.body.getAttribute('data-view') === 'sun' && cur < Date.now() - SNAP) {
      playEnd = Date.now();
      Model.setTime(cur);
    } else if (document.body.getAttribute('data-view') === 'sun') {
      playEnd = Date.now();
      Model.setTime(Math.max(t0, Date.now() - BACK));
    } else {
      if (cur >= t1 - MIN) { cur = Date.now(); }
      Model.setTime(Math.max(cur, Date.now() + SNAP + MIN));
    }
    Model.load().catch(function () { /* stays live */ });
    playing = true;
    lastFrame = 0;
    stepAcc = 0;
    showPlay();
    requestAnimationFrame(advance);
  }

  function pause() {
    if (!playing) { return; }
    playing = false;
    showPlay();
  }

  function toggle() {
    if (playing) { pause(); } else { play(); }
  }

  function advance(now) {
    if (!playing) { return; }
    var dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    var cur = Model.viewTime === null ? Date.now() : Model.viewTime;
    var next;
    if (reducedMotion) {
      // A slot a second, in steps.
      stepAcc += dt;
      if (stepAcc < 1) { requestAnimationFrame(advance); return; }
      stepAcc = 0;
      next = cur + 3 * HOUR;
    } else {
      next = cur + PLAY_RATE * dt;
    }
    if (playEnd !== null && next >= playEnd) {
      Model.setTime(null);
      placeThumb();
      pause();
      return;
    }
    if (next >= t1) {
      Model.setTime(t1);
      placeThumb();
      pause();
      return;
    }
    Model.setTime(next);
    placeThumb();
    requestAnimationFrame(advance);
  }

  playBtn.addEventListener('click', toggle);

  /* ---------- Wiring ---------- */

  // The darkness strip follows the place the readout shows.
  if (window.AuroraHud) { place = window.AuroraHud.place; }
  document.addEventListener('aurora:place', function (e) {
    if (e.detail && isFinite(e.detail.lat) && isFinite(e.detail.lon)) {
      place = { lat: e.detail.lat, lon: e.detail.lon };
      draw();
    }
  });

  // The globe's arrow keys spin it; aimed at the slider, they move time instead.
  track.addEventListener('keydown', function (e) { e.stopPropagation(); }, true);

  document.addEventListener('aurora:data', function (e) {
    if (e.detail && e.detail.feed === 'kpForecast') { range(); draw(); }
  });
  document.addEventListener('aurora:time', placeThumb);

  if (window.ResizeObserver) {
    new ResizeObserver(function () { size(); draw(); }).observe(canvas);
  } else {
    window.addEventListener('resize', function () { size(); draw(); });
  }

  // The range moves with the clock; redraw it once a minute.
  setInterval(function () { range(); draw(); }, MIN);

  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(draw); }

  showPlay();
  range();
  size();
  draw();
})();
