/*
 * Pitwall: the Feed — race control's messages, the conditions and team radio. Ports of
 * Pocket Pitwall's ui/Feed.kt and ui/Conditions.kt.
 *
 * Race control reads newest first, each message in ordinary case and shaded by its kind; a
 * message opened from the ticker is lit for a moment. The conditions card puts the track
 * temperature large, with which way it has moved over the last half hour (▲ amber, ▼ blue,
 * or Steady within half a degree) and a line of track and air temperatures; when the feed
 * reports rain the card turns blue. Team radio lists the newest clips: click one to play it.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var F = P.Format;
  var UI = P.UI;

  var list = document.getElementById('rc-list');
  var cond = document.getElementById('conditions');
  var spark = cond.querySelector('canvas');
  var clips = document.getElementById('radio-clips');
  var soundBtn = document.getElementById('sound');
  var handlers = {};
  var lit = null;
  var litTimer = null;
  var listKey = '';

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function set(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  function key(e) {
    return e.t + '|' + e.text;
  }

  // ---------- Race control ----------

  function drawList(frame) {
    var events = frame ? frame.events.slice().sort(function (a, b) { return (b.t || 0) - (a.t || 0); }) : [];
    var k = events.length + '|' + (events[0] ? key(events[0]) : '') + '|' + lit;
    if (k === listKey) { return; }
    listKey = k;
    if (!events.length) {
      set(list, '<li class="rc-empty">' + (frame ? 'Nothing from race control yet.' : 'Race control’s messages show here during a session.') + '</li>');
      return;
    }
    var codes = {};
    frame.drivers.forEach(function (d) { if (d.code) { codes[d.code] = true; } });
    set(list, events.map(function (e) {
      var kind = P.eventKind(e);
      var drivers = e.drivers.map(function (n) { return frame.byNumber[n]; }).filter(Boolean).slice(0, 3).map(function (d) {
        return '<span class="rc-driver" style="--team:' + (F.teamColour(d.colour) || '') + '">' + esc(F.driverLabel(d)) + '</span>';
      }).join('');
      return '<li class="rc-row"' + (kind ? ' data-tone="' + kind[1] + '"' : '') + (key(e) === lit ? ' data-lit' : '') + ' data-key="' + esc(key(e)) + '">' +
        '<p class="rc-when">' + esc([F.clock(e.t), e.lap != null ? 'Lap ' + e.lap : null].filter(Boolean).join(' · ')) +
        (kind ? ' <span class="rc-kind">' + kind[0] + '</span>' : '') + drivers + '</p>' +
        '<p class="rc-text">' + esc(F.sentence(e.text, codes)) + '</p></li>';
    }).join(''));
    if (lit) {
      var row = list.querySelector('[data-lit]');
      if (row) { row.scrollIntoView({ block: 'center', behavior: UI.calm ? 'auto' : 'smooth' }); }
    }
  }

  /** Light one message for a moment: the one opened from the ticker. */
  function highlight(e) {
    lit = key(e);
    listKey = '';
    clearTimeout(litTimer);
    litTimer = setTimeout(function () {
      lit = null;
      listKey = '';
      var row = list.querySelector('[data-lit]');
      if (row) { row.removeAttribute('data-lit'); }
    }, 2600);
  }

  // ---------- The conditions ----------

  function sparkline(points) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var w = spark.clientWidth;
    var h = spark.clientHeight;
    spark.width = Math.max(1, Math.round(w * dpr));
    spark.height = Math.max(1, Math.round(h * dpr));
    var ctx = spark.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (points.length < 3) { return; }
    var t0 = points[0].at;
    var t1 = points[points.length - 1].at;
    var vals = [];
    points.forEach(function (p) {
      if (p.track != null) { vals.push(p.track); }
      if (p.air != null) { vals.push(p.air); }
    });
    var lo = Math.min.apply(null, vals) - 0.5;
    var hi = Math.max.apply(null, vals) + 0.5;
    function line(field, colour, width) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      var started = false;
      points.forEach(function (p) {
        if (p[field] == null) { return; }
        var x = (p.at - t0) / Math.max(1, t1 - t0) * (w - 4) + 2;
        var y = h - 3 - (p[field] - lo) / (hi - lo) * (h - 6);
        if (started) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); started = true; }
      });
      ctx.stroke();
    }
    line('air', UI.token('--ink-faint'), 2);
    line('track', UI.token('--caution'), 3);
  }

  function drawConditions(frame, history) {
    var w = frame && frame.weather;
    cond.hidden = !w;
    if (!w) { return; }
    cond.toggleAttribute('data-rain', !!w.rain);
    UI.text('trackTemp', w.track != null ? Math.round(w.track * 10) / 10 + '°' : F.DASH);
    var trend = history.trend();
    var trendEl = UI.node('trackTrend');
    if (!trend) {
      UI.text('trackTrend', history.points.length ? 'Trend after five minutes' : '');
      UI.setAttr(trendEl, 'data-tone', 'quiet');
    } else if (P.WeatherHistory.steady(trend)) {
      UI.text('trackTrend', 'Steady · ' + trend.minutes + ' min');
      UI.setAttr(trendEl, 'data-tone', 'quiet');
    } else {
      var up = trend.degrees > 0;
      UI.text('trackTrend', (up ? '▲ ' : '▼ ') + Math.abs(trend.degrees).toFixed(1) + '° in ' + trend.minutes + ' min');
      UI.setAttr(trendEl, 'data-tone', up ? 'warm' : 'cool');
    }
    UI.text('rainState', w.rain ? 'Rain' : 'Dry');
    UI.text('airTemp', F.degrees(w.air));
    UI.text('humidity', w.humidity != null ? Math.round(w.humidity) + '%' : F.DASH);
    UI.text('windLabel', w.windDir != null ? 'Wind from ' + F.compass(w.windDir) : 'Wind');
    UI.text('windValue', w.wind != null ? w.wind.toFixed(1) + ' m/s' : F.DASH);
    UI.text('pressure', w.pressure != null ? Math.round(w.pressure) + ' hPa' : F.DASH);
    sparkline(history.points);
  }

  // ---------- Team radio ----------

  function drawRadio(frame, radio, c) {
    var card = document.getElementById('radio');
    card.hidden = !frame || radio.clips == null;
    soundBtn.setAttribute('aria-pressed', c.soundOn ? 'true' : 'false');
    soundBtn.textContent = c.soundOn ? 'Sound on' : 'Sound off';
    var follow = frame ? frame.drivers.filter(function (d) { return c.followed.has(d.num); }).map(F.driverLabel) : [];
    UI.text('radioNote', !c.unlocked && c.soundOn ? 'Click anywhere on the page to let it play sound.' :
      !follow.length ? 'Hold a driver in the tower to follow them: their radio plays by itself.' :
      'Following ' + follow.join(', '));
    if (!frame || !radio.clips) { return; }
    if (!radio.clips.length) {
      set(clips, '<li class="rc-empty">No team radio yet.</li>');
      return;
    }
    set(clips, radio.clips.map(function (clip) {
      var d = frame.byNumber[clip.num];
      var playing = radio.playing && radio.playing.key === clip.key;
      return '<li><button type="button" class="clip" data-clip="' + esc(clip.key) + '"' + (playing ? ' aria-pressed="true"' : '') + '>' +
        '<span class="clip-icon" aria-hidden="true">' + (playing ? '■' : '▶') + '</span>' +
        '<b style="--team:' + (d && F.teamColour(d.colour) || '') + '">' + esc(d ? F.driverLabel(d) : '#' + clip.num) + '</b>' +
        '<span class="clip-when">' + esc(F.clock(clip.t)) + '</span></button></li>';
    }).join(''));
  }

  clips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-clip]');
    if (b && handlers.onClip) { handlers.onClip(b.getAttribute('data-clip')); }
  });
  soundBtn.addEventListener('click', function () {
    if (handlers.onSound) { handlers.onSound(); }
  });

  /*
   * Draw the Feed. c: {weather: WeatherHistory, radio: Radio, followed: Set, soundOn,
   * unlocked, mode, shown}. The radio card is drawn whatever the view, since the badge's
   * note about following lives there too.
   */
  function render(frame, c) {
    if (c.shown) {
      drawList(frame);
      drawConditions(frame, c.weather);
    }
    drawRadio(frame, c.radio, c);
  }

  P.Feed = {
    render: render,
    highlight: highlight,
    on: function (h) { handlers = h; }
  };
}());
