/*
 * Pitwall: the wall itself — which view is up, the settings, the live feed, and drawing
 * each frame as it comes due. A port of the orchestration in Pocket Pitwall's
 * wall/WallViewModel.kt and ui/WallScreen.kt.
 */
(function () {
  'use strict';

  var P = window.Pitwall;
  var F = P.Format;
  var UI = P.UI;

  var VIEWS = ['map', 'wall', 'feed'];
  var GAP_MODES = ['LEADER', 'INTERVAL', 'LAST'];
  var DATA_V = '20261106';

  /* ?demo= draws one of the captured frames the tests use, so every flag state can be
     looked at whenever it's wanted, not only when a session happens to be in it. */
  var DEMOS = {
    green: 'frame-race-green.json',
    sc: 'frame-race-sc.json',
    yellow: 'frame-race-yellow.json',
    chequered: 'frame-race-chequered.json',
    quali: 'frame-quali.json',
    idle: 'live-idle.json'
  };

  var params = new URLSearchParams(window.location.search);
  var seasons = {};
  var feed = null;
  var demo = null;

  function iso(t) {
    return new Date(t).toISOString();
  }

  /* Replay: past sessions from the API, composed the same way as live frames. */
  var replay = new P.ReplayFeed({
    source: {
      sessions: function (year) {
        return P.Net.api('/f1/replay/sessions?year=' + year).then(P.Parse.sessions);
      },
      timeline: function (key) {
        return P.Net.api('/f1/replay/timeline?session_key=' + key, P.Net.TIMEOUT_REPLAY).then(P.Parse.timeline);
      },
      frame: function (key, at) {
        return P.Net.api('/f1/live?replay=' + key + '&t=' + encodeURIComponent(iso(at)), P.Net.TIMEOUT_REPLAY).then(P.Parse.frame);
      }
    }
  });

  /*
   * The flags seen so far in the live session, for the dock's progress strip: a sample
   * each time the flag changes, kept per session and trimmed back if time runs backwards.
   */
  var flags = { key: null, samples: [] };

  function record(frame) {
    if (!frame || !frame.session || frame.raceAt == null) { return; }
    if (frame.session.key !== flags.key) { flags = { key: frame.session.key, samples: [] }; }
    var samples = flags.samples;
    var state = frame.flag ? frame.flag.state : 'GREEN';
    while (samples.length && samples[samples.length - 1].t > frame.raceAt) { samples.pop(); }
    var last = samples[samples.length - 1];
    if (!last || last.state !== state) { samples.push({ t: frame.raceAt, state: state }); }
  }

  function seenPeriods() {
    var s = flags.samples;
    return s.map(function (p, i) {
      return { state: p.state, from: p.t, to: i + 1 < s.length ? s[i + 1].t : null };
    });
  }

  /** Out of sight for this long, the page gives up its stream and polls slowly. */
  var HIDDEN_AFTER = 60000;

  var settings = {
    view: VIEWS.indexOf(params.get('view')) >= 0 ? params.get('view') : UI.load('view', 'map'),
    gapMode: UI.load('gap', 'LEADER'),
    followed: new Set(followedAtStart()),
    picked: null,
    keepAwake: UI.load('awake', true) !== false,
    mode: 'live'
  };
  if (VIEWS.indexOf(settings.view) < 0) { settings.view = 'map'; }
  if (GAP_MODES.indexOf(settings.gapMode) < 0) { settings.gapMode = 'LEADER'; }

  /* The drivers followed, as numbers. The old wall kept its own list (f1-wall-radio); the
     first time this page opens, it starts from that one, and keeps its own from then on. */
  function followedAtStart() {
    var saved = UI.load('follow', null);
    if (Array.isArray(saved)) { return saved; }
    try {
      var old = JSON.parse(UI.loadRaw('f1-wall-radio') || 'null');
      if (old && Array.isArray(old.follow)) { return old.follow.filter(function (n) { return typeof n === 'number'; }); }
    } catch (e) {
      // Nothing usable to start from.
    }
    return [];
  }

  // ---------- Seasons ----------

  /** This year's season index, or last year's while this year's isn't built yet. */
  function loadSeasons() {
    var year = new Date().getFullYear();
    function get(y) {
      return P.Net.data('season-' + y + '.json', DATA_V).then(function (json) {
        if (json) { seasons[y] = P.Season.parse(json); }
        return !!json;
      });
    }
    return get(year).then(function (found) { return found || get(year - 1); });
  }

  /** The season a session belongs to: its own year's, or the newest the site has. */
  function seasonFor(session) {
    var year = session && session.start != null ? new Date(session.start).getUTCFullYear() : null;
    if (year != null && seasons[year]) { return seasons[year]; }
    var years = Object.keys(seasons).map(Number).sort(function (a, b) { return b - a; });
    return years.length ? seasons[years[0]] : null;
  }

  // ---------- The badge ----------

  function delayText(seconds) {
    return seconds > 0 ? 'Delay −' + seconds + 's' : '';
  }

  /** Whether the wall is live, as the badge says it. A port of badgeFor in WallScreen.kt. */
  function badgeFor(state, frame) {
    if (demo) {
      return { tag: 'Demo', tone: 'demo', clock: F.clockSeconds(frame && frame.generated), delay: 'A captured frame' };
    }
    if (settings.mode === 'replay') {
      var r = replay.state;
      return {
        tag: 'Replay',
        tone: 'quiet',
        clock: F.clockSeconds(r.at),
        delay: r.timeline ? r.speed + '× · ' + (r.playing ? 'playing' : 'paused') : r.session ? 'Loading' : 'Pick a session'
      };
    }
    var delay = delayText(state.delaySeconds);
    switch (state.status) {
      case 'CONNECTING':
        return state.failing
          ? { tag: 'Offline', tone: 'warn', clock: '', delay: delay || 'Retrying' }
          : { tag: 'Connecting', tone: 'quiet', clock: '', delay: delay };
      case 'NO_SESSION':
        return { tag: 'No session', tone: 'quiet', clock: '', delay: delay };
      case 'SESSION_OVER':
        return { tag: 'Session over', tone: 'quiet', clock: F.clockSeconds(frame && frame.generated), delay: delay };
      default: {
        // The frame dates itself, so a delayed frame shows its own time.
        var time = F.clockSeconds(frame && frame.generated);
        if (state.failing) { return { tag: 'Offline', tone: 'warn', clock: time, delay: delay || 'Retrying' }; }
        if (state.stale) { return { tag: 'Stale', tone: 'warn', clock: time, delay: delay }; }
        return { tag: 'Live', tone: 'live', clock: time, delay: delay };
      }
    }
  }

  /** How live data is reaching the page, for the badge's panel; nothing between sessions. */
  function feedLine(state) {
    if (demo || state.status !== 'LIVE') { return ''; }
    if (state.transport === 'STREAM') {
      return 'Feed: live stream' + (state.carRate != null ? ' · ' + state.carRate.toFixed(1) + ' updates/s' : '');
    }
    return 'Feed: polling (stream unavailable)';
  }

  function standbyNote(state) {
    if (demo) { return 'A captured frame'; }
    if (settings.mode === 'replay') {
      return replay.state.status || (replay.state.session ? 'Loading' : 'Pick a session from the badge’s +');
    }
    if (state.status === 'CONNECTING') { return state.failing ? 'Can’t reach the timing feed — retrying' : 'Connecting to the timing feed'; }
    return 'Fills in by itself when a session starts';
  }

  // ---------- Race control's line ----------

  function ticker(frame) {
    var newest = null;
    (frame ? frame.events : []).forEach(function (e) {
      if (!newest || (e.t || 0) > (newest.t || 0)) { newest = e; }
    });
    var el = document.querySelector('.ticker');
    UI.setAttr(el, 'data-empty', newest ? null : '');
    if (!newest) {
      UI.text('tickerWhen', '');
      UI.text('tickerText', frame ? 'Nothing from race control yet.' : 'Race control’s messages show here.');
      return;
    }
    var codes = {};
    frame.drivers.forEach(function (d) { if (d.code) { codes[d.code] = true; } });
    UI.text('tickerWhen', [F.clock(newest.t), newest.lap != null ? 'Lap ' + newest.lap : null].filter(Boolean).join(' · '));
    UI.text('tickerText', F.sentence(newest.text, codes));
  }

  // ---------- Drawing ----------

  function current() {
    if (demo) { return { frame: demo.live ? demo : null, state: { status: demo.live ? 'LIVE' : 'NO_SESSION', delaySeconds: 0 } }; }
    if (settings.mode === 'replay') {
      var r = replay.state;
      return { frame: r.frame, state: { status: r.frame ? 'LIVE' : 'CONNECTING', delaySeconds: feed ? feed.state.delaySeconds : 0 } };
    }
    var state = feed.state;
    // The final order stays up after a session ends; before one, there's nothing to draw.
    var frame = state.status === 'LIVE' || state.status === 'SESSION_OVER' ? state.frame : null;
    return { frame: frame, state: state };
  }

  function draw() {
    var now = current();
    var frame = now.frame;
    var season = seasonFor(frame && frame.session);
    P.Header.render(frame, {
      totalLaps: frame ? P.Season.totalLaps(season, frame.session) : null,
      badge: badgeFor(now.state, frame),
      standbyNote: standbyNote(now.state)
    });
    P.Tower.render(frame, settings);
    ticker(frame);
    UI.text('delayValue', now.state.delaySeconds + 's');
    var range = document.getElementById('delay-range');
    if (document.activeElement !== range && +range.value !== now.state.delaySeconds) { range.value = now.state.delaySeconds; }
    UI.text('feedLine', feedLine(now.state));
    dock(frame, now.state);
    picker();
    writeUrl();
    syncWake();
    if (!frame && now.state.reason) { UI.text('towerEmpty', 'No session running. The running order fills in by itself when one starts.'); }
    document.title = frame ? F.flagWord(frame.flag ? frame.flag.state : 'GREEN') + ' · Pitwall' : 'Pitwall — live F1 timing';
  }

  // ---------- The dock ----------

  function dock(frame, state) {
    if (settings.mode === 'replay') {
      var r = replay.state;
      P.Timeline.render({
        mode: 'replay',
        timeline: r.timeline,
        at: r.at,
        playing: r.playing,
        speed: r.speed,
        ready: r.ready,
        note: r.status || (r.session ? 'Loading…' : 'Pick a session to replay from the badge’s +')
      });
      return;
    }
    if (frame && state.status === 'LIVE') { record(frame); }
    var session = frame && frame.session;
    var samples = flags.samples;
    var at = frame ? frame.raceAt : null;
    var start = session && session.start != null ? session.start : samples.length ? samples[0].t : null;
    var end = session && session.end != null ? session.end : null;
    // A start hours before the moment on screen isn't this session's (a simulated one keeps
    // the original's times): the strip then begins where the wall began watching.
    if (start != null && at != null && at - start > 6 * 3600000) {
      start = samples.length ? samples[0].t : at - 3600000;
      end = null;
    }
    // A session running past its slot, or one with no end given, stretches to fit.
    if (start != null && at != null && (end == null || end < at)) { end = Math.max(at + 5 * 60000, start + 60 * 60000); }
    P.Timeline.render({
      mode: 'live',
      start: start,
      end: end,
      periods: seenPeriods(),
      at: at,
      note: frame ? '' : 'The session’s timeline shows here once one is on.'
    });
  }

  // ---------- Live or replay ----------

  /*
   * Live follows the feed; replay plays a past session. Only one runs at a time: in replay
   * the live feed stops, so it doesn't hold one of the server's stream slots for nothing,
   * and going back to live starts it again.
   */
  function setMode(mode) {
    if (settings.mode === mode) { return; }
    settings.mode = mode;
    document.documentElement.setAttribute('data-mode', mode);
    modes.pick(mode);
    if (mode === 'replay') {
      if (feed) { feed.stop(); }
      if (!replay.state.sessions) { replay.loadYear(replay.state.year); }
    } else {
      replay.close();
      if (feed) { feed.run(); }
    }
    draw();
  }

  var modes = UI.seg(document.getElementById('mode'), 'data-mode', setMode);

  var thisYear = new Date().getFullYear();
  var years = document.getElementById('years');
  for (var y = thisYear; y >= P.ReplayFeed.FIRST_YEAR; y--) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('data-year', String(y));
    b.setAttribute('aria-checked', y === thisYear ? 'true' : 'false');
    b.tabIndex = y === thisYear ? 0 : -1;
    b.textContent = String(y);
    years.appendChild(b);
  }
  var yearSeg = UI.seg(years, 'data-year', function (year) { replay.loadYear(Number(year)); });

  var dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  var pickerKey = '';

  /** The sessions to replay, grouped by weekend as the server lists them, newest first. */
  function picker() {
    var r = replay.state;
    var key = [r.year, r.sessions ? r.sessions.length : 'loading', r.sessionsError, r.session && r.session.key].join('|');
    if (key === pickerKey) { return; }
    pickerKey = key;
    yearSeg.pick(String(r.year));
    var el = document.getElementById('picker');
    el.innerHTML = '';
    function note(text) {
      var p = document.createElement('p');
      p.className = 'panel-note';
      p.textContent = text;
      el.appendChild(p);
    }
    if (r.sessionsError) { note(r.sessionsError); return; }
    if (!r.sessions) { note('Loading…'); return; }
    if (!r.sessions.length) { note('Nothing to replay for ' + r.year + ' yet.'); return; }
    var groups = [];
    var byKey = {};
    r.sessions.forEach(function (s) {
      var k = s.meetingKey != null ? 'm' + s.meetingKey : s.circuit || s.country || '?';
      if (!byKey[k]) {
        byKey[k] = { title: F.eventAndPlace(s) || s.country || '', sessions: [] };
        groups.push(byKey[k]);
      }
      byKey[k].sessions.push(s);
    });
    groups.forEach(function (g) {
      var section = document.createElement('div');
      section.className = 'picker-weekend';
      var title = document.createElement('p');
      title.className = 'cap-label';
      title.textContent = g.title;
      var list = document.createElement('div');
      list.className = 'picker-list';
      g.sessions.forEach(function (s) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'picker-session';
        if (r.session && r.session.key === s.key) { button.setAttribute('aria-current', 'true'); }
        button.textContent = s.name || 'Session';
        var day = document.createElement('span');
        day.textContent = s.start != null ? dayFormat.format(s.start) : '';
        button.appendChild(day);
        button.addEventListener('click', function () {
          replay.pick(s);
          UI.setMore(document.querySelector('[aria-controls="badge-panel"]'), false);
        });
        list.appendChild(button);
      });
      section.appendChild(title);
      section.appendChild(list);
      el.appendChild(section);
    });
  }

  /*
   * A replay is a link: ?session=…&t=… say which session and when, so a moment can be
   * shared or come back to. Written as it changes, at most once a second.
   */
  var urlWritten = 0;
  var urlTimer = null;

  function writeUrl() {
    var r = replay.state;
    var want = new URLSearchParams(window.location.search);
    if (settings.mode === 'replay' && r.session && r.session.key != null) {
      want.set('session', String(r.session.key));
      if (r.at != null) { want.set('t', iso(Math.floor(r.at / 1000) * 1000).replace('.000Z', 'Z')); }
    } else {
      want.delete('session');
      want.delete('t');
    }
    var next = want.toString();
    // Compared in the same encoding, so ?api=http://… isn't rewritten for nothing.
    if (next === new URLSearchParams(window.location.search).toString()) { return; }
    var wait = 1000 - (Date.now() - urlWritten);
    clearTimeout(urlTimer);
    if (wait > 0) {
      urlTimer = setTimeout(writeUrl, wait);
      return;
    }
    urlWritten = Date.now();
    window.history.replaceState(null, '', next ? '?' + next : window.location.pathname);
  }

  P.Timeline.on({
    onScrub: function (t) { replay.scrub(t); },
    onNudge: function (seconds) { replay.nudge(seconds); },
    onToggle: function () { replay.toggle(); },
    onSpeed: function () {
      var speeds = P.ReplayFeed.SPEEDS;
      replay.setSpeed(speeds[(speeds.indexOf(replay.state.speed) + 1) % speeds.length]);
    },
    onLive: function () { setMode('live'); }
  });

  /* A session opened from a link is known only by its key until its timeline is in; then
     the picker turns to its year. */
  var linked = false;

  replay.onState(function (state) {
    if (linked && state.timeline) {
      linked = false;
      var year = new Date(state.timeline.start).getUTCFullYear();
      if (year !== state.year) { replay.loadYear(year); }
    }
    if (settings.mode === 'replay') { draw(); }
  });

  // ---------- Controls ----------

  function setView(view) {
    settings.view = view;
    document.documentElement.setAttribute('data-view', view);
    UI.save('view', view);
  }

  var views = UI.seg(document.getElementById('views'), 'data-view', setView);
  views.pick(settings.view);
  setView(settings.view);

  P.Tower.on({
    onPick: function (num) {
      settings.picked = settings.picked === num ? null : num;
      draw();
    },
    onFollow: function (num) {
      if (settings.followed.has(num)) { settings.followed.delete(num); } else { settings.followed.add(num); }
      UI.save('follow', Array.from(settings.followed));
      draw();
    },
    onGapMode: function (mode) {
      settings.gapMode = mode;
      UI.save('gap', mode);
      draw();
    }
  });

  // ---------- The delay ----------

  function setDelay(seconds) {
    if (!feed) { return; }
    feed.setDelay(seconds);
    UI.save('delay', feed.state.delaySeconds);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.step'), function (button) {
    button.addEventListener('click', function () {
      if (feed) { setDelay(feed.state.delaySeconds + Number(button.getAttribute('data-step'))); }
    });
  });

  document.getElementById('delay-range').addEventListener('input', function (e) {
    setDelay(Number(e.target.value));
  });

  // ---------- Keeping the screen on ----------

  /*
   * A wall propped up beside the TV shouldn't go to sleep mid-race: the screen stays on
   * while a session is live (as the app keeps it on), if the setting allows. The browser
   * lets the lock go whenever the page is out of sight, so it is asked for again on return.
   */
  var wake = { sentinel: null, pending: false };

  function syncWake() {
    var on = settings.mode === 'replay' ? replay.state.playing : !!feed && feed.state.status === 'LIVE';
    var want = settings.keepAwake && on && document.visibilityState === 'visible';
    if (want && !wake.sentinel && !wake.pending && navigator.wakeLock) {
      wake.pending = true;
      navigator.wakeLock.request('screen').then(function (sentinel) {
        wake.sentinel = sentinel;
        sentinel.addEventListener('release', function () { wake.sentinel = null; });
      }).catch(function () {
        // Refused (battery saver, an iframe): the screen keeps its own timeout.
      }).then(function () {
        wake.pending = false;
        if (wake.sentinel && !settings.keepAwake) { syncWake(); }
      });
    } else if (!want && wake.sentinel) {
      wake.sentinel.release();
      wake.sentinel = null;
    }
  }

  var awake = document.getElementById('keep-awake');
  function drawAwake() {
    awake.setAttribute('aria-pressed', settings.keepAwake ? 'true' : 'false');
    awake.textContent = settings.keepAwake ? 'On' : 'Off';
  }
  drawAwake();
  awake.addEventListener('click', function () {
    settings.keepAwake = !settings.keepAwake;
    UI.save('awake', settings.keepAwake);
    drawAwake();
    syncWake();
  });

  // ---------- Full screen ----------

  var full = document.getElementById('fullscreen');
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  }
  if (document.fullscreenEnabled) {
    full.hidden = false;
    full.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', function () {
      var on = !!document.fullscreenElement;
      full.setAttribute('aria-pressed', on ? 'true' : 'false');
      full.textContent = on ? 'Exit full screen' : 'Full screen';
    });
  }

  document.addEventListener('keydown', function (e) {
    var target = e.target instanceof Element ? e.target : document.body;
    if (e.metaKey || e.ctrlKey || e.altKey || target.closest('input, select, textarea, [role="slider"]')) { return; }
    if (e.key === 'F' && e.shiftKey && document.fullscreenEnabled) {
      toggleFullscreen();
      return;
    }
    if (settings.mode === 'replay') {
      if (e.key === 'l' || e.key === 'L') {
        setMode('live');
        return;
      }
      // Space on a focused button presses that button; the replay keys are for the page.
      if (!(e.key === ' ' && target.closest('button')) && P.Timeline.key(e)) {
        e.preventDefault();
        return;
      }
    }
    var view = { m: 'map', w: 'wall', f: 'feed' }[e.key];
    if (view && !e.shiftKey && !target.closest('.row')) {
      views.pick(view);
      setView(view);
    }
  });

  UI.more();

  // ---------- Start ----------

  function startDemo(name) {
    document.getElementById('demo').hidden = false;
    return fetch('tests/pitwall/fixtures/' + DEMOS[name])
      .then(function (r) { return r.json(); })
      .then(function (json) {
        demo = P.Parse.frame(json);
        draw();
      });
  }

  function startLive() {
    feed = new P.LiveFeed({
      fetch: P.Net.live,
      // ?stream=off: polling alone, as the old wall did — for comparing the two.
      stream: params.get('stream') === 'off' ? null : P.Net.openStream,
      initialDelay: UI.load('delay', 0)
    });
    feed.onState(function () {
      if (settings.mode === 'live') { draw(); }
    });

    // A link to a moment of a past session opens straight onto it.
    var key = parseInt(params.get('session'), 10);
    if (key > 0) {
      linked = true;
      setMode('replay');
      replay.pick({ key: key }, P.Parse.instant(params.get('t')));
    } else {
      feed.run();
    }
    draw();

    /*
     * Out of sight for a minute, the page gives up its stream — one of the server's few,
     * which the app and other tabs need — and polls every 30 s. Back in sight, it polls at
     * once and tries the stream again.
     */
    var hiddenTimer = null;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        hiddenTimer = setTimeout(function () { feed.setBackground(true); }, HIDDEN_AFTER);
      } else {
        clearTimeout(hiddenTimer);
        feed.setBackground(false);
        if (settings.mode === 'live') { feed.wake(); }
      }
      syncWake();
    });
  }

  loadSeasons().then(function () {
    var name = params.get('demo');
    if (name && DEMOS[name]) { return startDemo(name); }
    startLive();
  });

  P.App = { draw: draw, settings: settings, replay: replay };
}());
