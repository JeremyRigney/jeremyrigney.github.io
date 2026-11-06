/*
 * Pitwall: the dock's timeline — the session as a track, in /aurora's idiom. A port of the
 * scrubber and mini-player in Pocket Pitwall's ui/ReplayBar.kt.
 *
 * The track reads like a day planner: times along the top on dashed rules, the session's
 * flag periods laid down as bands (the app's BAND strengths), a red notch over it for each
 * serious race-control message, and the thumb as an ink rule with its time in a pill.
 *
 * In replay it is a slider: click or drag to scrub, or use the keys (arrows step 5 s, with
 * Shift 30 s; Home and End; Space plays and pauses; L goes back to live). Live, it is a
 * progress strip: the session so far, with the flags the wall has seen, and the thumb at
 * the moment on screen.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var F = P.Format;
  var UI = P.UI;

  var MIN = 60000;
  var TOP = 26;        // room above the track for the time labels and the thumb's pill
  var BAR = 8;         // the track's own height
  var STEPS = [5, 10, 15, 30, 60, 120, 240].map(function (m) { return m * MIN; });

  var ICON_PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="2.8" height="9" fill="currentColor"/><rect x="7.2" y="1.5" width="2.8" height="9" fill="currentColor"/></svg>';

  var dock = document.getElementById('dock');
  var track = document.getElementById('tl-track');
  var canvas = track.querySelector('canvas');
  var thumb = track.querySelector('.tl-thumb');
  var thumbLabel = track.querySelector('.tl-thumb-label');
  var playBtn = document.getElementById('tl-play');
  var speedBtn = document.getElementById('tl-speed');
  var liveBtn = document.getElementById('tl-live');
  var jumpsEl = document.getElementById('jumps');
  var ctx = canvas.getContext('2d');

  var handlers = {};
  var view = null;   // what was last drawn: {mode, start, end, periods, notches, at, ...}
  var drawnKey = '';
  var jumpsKey = '';

  // ---------- Geometry ----------

  function size() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var w = Math.max(1, Math.round(track.clientWidth * dpr));
    var h = Math.max(1, Math.round(track.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      drawnKey = '';
    }
    return dpr;
  }

  function fraction(t) {
    if (!view || view.end <= view.start) { return 0; }
    return Math.min(1, Math.max(0, (t - view.start) / (view.end - view.start)));
  }

  function instantAt(clientX) {
    var rect = track.getBoundingClientRect();
    var f = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return view.start + f * (view.end - view.start);
  }

  // ---------- Drawing ----------

  function draw() {
    var dpr = size();
    var key = view ? [view.mode, view.start, view.end, view.periods.length, view.periodsEnd, view.notches.length, canvas.width].join('|') : 'none';
    if (key === drawnKey) { return; }
    drawnKey = key;
    var w = canvas.width / dpr;
    var h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!view) { return; }

    var barTop = Math.max(TOP + 6, h - BAR - 10);
    var faint = UI.token('--ink-faint');

    // Times along the top, each on a dashed rule, as many as fit.
    var span = view.end - view.start;
    // Longer than the steps allow for (a day or more), there are no times along the top.
    var step = STEPS.filter(function (s) { return span / s * 64 <= w; })[0];
    ctx.font = '600 13px Figtree, "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = faint;
    ctx.strokeStyle = faint;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    var offset = new Date(view.start).getTimezoneOffset() * MIN;
    for (var t = step ? Math.ceil((view.start - offset) / step) * step + offset : Infinity; t < view.end; t += step) {
      var x = Math.round(fraction(t) * w) + 0.5;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(x, 18);
      ctx.lineTo(x, barTop - 3);
      ctx.stroke();
      var label = F.clock(t);
      var lw = ctx.measureText(label).width;
      if (x - lw / 2 > 0 && x + lw / 2 < w) {
        ctx.globalAlpha = 1;
        ctx.fillText(label, x - lw / 2, 1);
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // The track, then each flag's period over it.
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(0, barTop, w, BAR, BAR / 2); } else { ctx.rect(0, barTop, w, BAR); }
    ctx.clip();
    ctx.fillStyle = UI.token('--row');
    ctx.fillRect(0, barTop, w, BAR);
    view.periods.forEach(function (p) {
      var band = P.Replay.BANDS[p.state];
      if (!band) { return; }
      var from = fraction(p.from) * w;
      var to = fraction(p.to != null ? p.to : view.periodsEnd) * w;
      if (to <= from) { return; }
      ctx.globalAlpha = band.alpha;
      ctx.fillStyle = UI.token(band.token);
      ctx.fillRect(from, barTop, Math.max(2, to - from), BAR);
    });
    ctx.restore();
    ctx.globalAlpha = 1;

    // A notch over the track for each serious message from race control.
    ctx.fillStyle = UI.token('--alert-soft');
    view.notches.forEach(function (t) {
      ctx.beginPath();
      ctx.arc(fraction(t) * w, barTop - 6, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function placeThumb() {
    var at = view && view.at;
    thumb.hidden = at == null;
    if (at == null) { return; }
    var f = fraction(at);
    thumb.style.left = (f * 100) + '%';
    var label = F.clockSeconds(at);
    if (thumbLabel.textContent !== label) { thumbLabel.textContent = label; }
    // Keep the pill inside the track at either end.
    var half = thumbLabel.offsetWidth / 2;
    var x = f * track.clientWidth;
    var shift = x < half ? half - x : x > track.clientWidth - half ? track.clientWidth - half - x : 0;
    thumbLabel.style.transform = 'translateX(calc(-50% + ' + shift + 'px))';
    UI.setAttr(track, 'aria-valuenow', Math.round(f * 100));
    UI.setAttr(track, 'aria-valuetext', label);
  }

  function drawJumps(timeline) {
    var key = timeline ? timeline.session.key + '|' + timeline.periods.length : '';
    if (key === jumpsKey) { return; }
    jumpsKey = key;
    jumpsEl.innerHTML = '';
    var list = timeline ? P.Replay.jumps(timeline) : [];
    if (!list.length) {
      jumpsEl.innerHTML = '<p class="panel-note">No flags but green in this session.</p>';
      return;
    }
    list.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-jump';
      b.setAttribute('data-flag-state', p.state);
      b.textContent = P.Replay.JUMP_LABELS[p.state] + '  ' + F.clock(p.from);
      b.addEventListener('click', function () {
        if (handlers.onScrub) { handlers.onScrub(p.from); }
      });
      jumpsEl.appendChild(b);
    });
  }

  /*
   * Draw the dock.
   *   replay: {mode: 'replay', timeline, at, playing, speed, ready}
   *   live:   {mode: 'live', start, end, periods (seen so far), at}
   */
  function render(state) {
    dock.setAttribute('data-mode', state.mode);
    if (state.mode === 'replay') {
      var tl = state.timeline;
      view = tl ? {
        mode: 'replay',
        start: tl.start,
        end: tl.end,
        periods: tl.periods,
        periodsEnd: tl.end,
        notches: tl.events.filter(function (e) { return e.severity === 'high' && e.t != null; }).map(function (e) { return e.t; }),
        at: state.at
      } : null;
      playBtn.disabled = !state.ready;
      var label = state.playing ? 'Pause' : 'Play';
      if (playBtn.getAttribute('aria-label') !== label) {
        playBtn.setAttribute('aria-label', label);
        playBtn.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
      }
      if (speedBtn.textContent !== state.speed + '×') { speedBtn.textContent = state.speed + '×'; }
      liveBtn.setAttribute('aria-disabled', 'false');
      track.removeAttribute('aria-readonly');
      drawJumps(tl);
    } else {
      view = state.start != null && state.end != null ? {
        mode: 'live',
        start: state.start,
        end: state.end,
        periods: state.periods,
        periodsEnd: state.at,
        notches: [],
        at: state.at
      } : null;
      liveBtn.setAttribute('aria-disabled', 'true');
      track.setAttribute('aria-readonly', 'true');
    }
    UI.text('tlNote', view ? '' : state.note || '');
    draw();
    placeThumb();
  }

  // ---------- Input ----------

  function scrubbing() {
    return view && view.mode === 'replay';
  }

  var dragging = false;
  track.addEventListener('pointerdown', function (e) {
    if (!scrubbing() || e.button !== 0) { return; }
    dragging = true;
    track.setPointerCapture(e.pointerId);
    if (handlers.onScrub) { handlers.onScrub(instantAt(e.clientX)); }
  });
  track.addEventListener('pointermove', function (e) {
    if (dragging && scrubbing() && handlers.onScrub) { handlers.onScrub(instantAt(e.clientX)); }
  });
  ['pointerup', 'pointercancel'].forEach(function (type) {
    track.addEventListener(type, function () { dragging = false; });
  });

  /** The replay keys, from the track or anywhere on the page that isn't a control. */
  function key(e) {
    if (!scrubbing()) { return false; }
    var step = e.shiftKey ? 30 : 5;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': handlers.onNudge(-step); return true;
      case 'ArrowRight': case 'ArrowUp': handlers.onNudge(step); return true;
      case 'Home': handlers.onScrub(view.start); return true;
      case 'End': handlers.onScrub(view.end); return true;
      case ' ': handlers.onToggle(); return true;
      default: return false;
    }
  }

  track.addEventListener('keydown', function (e) {
    if (key(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  playBtn.addEventListener('click', function () { if (handlers.onToggle) { handlers.onToggle(); } });
  speedBtn.addEventListener('click', function () { if (handlers.onSpeed) { handlers.onSpeed(); } });
  liveBtn.addEventListener('click', function () {
    if (liveBtn.getAttribute('aria-disabled') !== 'true' && handlers.onLive) { handlers.onLive(); }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.nudge'), function (b) {
    b.addEventListener('click', function () { handlers.onNudge(Number(b.getAttribute('data-nudge'))); });
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () {
      draw();
      placeThumb();
    }).observe(track);
  }

  P.Timeline = {
    render: render,
    key: key,
    on: function (h) { handlers = h; },
    ICON_PLAY: ICON_PLAY
  };
}());
