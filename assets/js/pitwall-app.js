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

  var VIEWS = ['tower', 'map', 'wall', 'feed'];

  /* On a narrow screen the running order is a view of its own; on a wide one it's always
     beside the stage, so its view falls back to the map. */
  var narrow = window.matchMedia('(max-width: 900px)');
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
    /** The car whose card is open, if any. */
    open: null,
    keepAwake: UI.load('awake', true) !== false,
    sound: UI.load('sound', true) !== false,
    voice: {
      on: UI.load('voice.on', true) !== false,
      // Stored as the kinds switched off, so a new kind starts on.
      off: new Set(UI.load('voice.off', [])),
      name: UI.load('voice.name', null)
    },
    mode: 'live'
  };
  if (VIEWS.indexOf(settings.view) < 0 || (settings.view === 'tower' && !narrow.matches)) { settings.view = 'map'; }
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

  /*
   * On a wide screen the ticker is the banner: a message worth interrupting for (a penalty,
   * an investigation, one cleared, the weather) lights it in the shade of its kind for 12 s
   * if serious, 8 s otherwise. The rest of the time it shows the newest message, plain.
   */
  var banner = { event: null, timer: null };
  var tickerShows = null;

  function raiseBanner(event) {
    clearTimeout(banner.timer);
    banner.event = event;
    banner.timer = setTimeout(function () {
      banner.event = null;
      draw();
    }, event.severity === 'high' ? 12000 : 8000);
  }

  function ticker(frame) {
    var newest = null;
    (frame ? frame.events : []).forEach(function (e) {
      if (!newest || (e.t || 0) > (newest.t || 0)) { newest = e; }
    });
    var shown = banner.event || newest;
    tickerShows = shown;
    var el = document.querySelector('.ticker');
    UI.setAttr(el, 'data-empty', shown ? null : '');
    var kind = banner.event ? P.eventKind(banner.event) : null;
    UI.setAttr(el, 'data-tone', banner.event ? (kind ? kind[1] : 'plain') : null);
    UI.show('tickerKind', !!kind);
    UI.text('tickerKind', kind ? kind[0] : '');
    if (!shown) {
      UI.text('tickerWhen', '');
      UI.text('tickerText', frame ? 'Nothing from race control yet.' : 'Race control’s messages show here.');
      return;
    }
    var codes = {};
    (frame ? frame.drivers : []).forEach(function (d) { if (d.code) { codes[d.code] = true; } });
    UI.text('tickerWhen', [F.clock(shown.t), shown.lap != null ? 'Lap ' + shown.lap : null].filter(Boolean).join(' · '));
    UI.text('tickerText', F.sentence(shown.text, codes));
  }

  /* Clicking the ticker opens the feed at that message, lit for a moment. */
  document.querySelector('.ticker').addEventListener('click', function () {
    if (tickerShows) { P.Feed.highlight(tickerShows); }
    banner.event = null;
    views.pick('feed');
    setView('feed');
  });

  // ---------- What's news in each drawn frame ----------

  var alerts = new P.Alerts();
  var announcer = new P.Announcer();
  var weather = new P.WeatherHistory();
  var processed = null;
  var unread = 0;

  /** Pause a replay while a clicked clip plays; true if it did. */
  function holdReplay() {
    if (settings.mode === 'replay' && replay.state.playing) {
      replay.stop();
      return true;
    }
    return false;
  }

  var radio = new P.Radio({
    player: P.Audio.player,
    follow: function () { return settings.followed; },
    soundOn: function () { return settings.sound; },
    hold: holdReplay,
    release: function () { replay.play(); },
    onChange: function () { draw(); }
  });

  /** Whether flag changes may be said: live, or a replay playing at 10× or slower. */
  function mayAnnounce() {
    if (demo) { return false; }
    if (settings.mode === 'replay') { return replay.state.playing && replay.state.speed <= 10; }
    return true;
  }

  /** Whether followed drivers' radio plays by itself: live, or a replay playing at 1×. */
  function mayAutoplay() {
    if (demo) { return false; }
    if (settings.mode === 'replay') { return replay.state.playing && replay.state.speed <= 1; }
    return true;
  }

  function speak(a) {
    if (!a || !settings.voice.on || settings.voice.off.has(a.kind)) { return; }
    P.Audio.say(a.words, settings.voice.name);
  }

  /** A newly drawn frame: banners, the voice, the conditions' record, team radio. */
  function process(frame) {
    if (!frame || frame === processed) { return; }
    processed = frame;
    var feedOpen = settings.view === 'feed';
    var news = alerts.sync(frame, feedOpen);
    if (news && !feedOpen) { raiseBanner(news); }
    var allowed = mayAnnounce();
    speak(announcer.next(frame, allowed));
    var rain = announcer.rain(frame, allowed);
    speak(rain);
    // Rain starting or stopping is news on the ticker too, said in the wall's own words.
    if (rain && !feedOpen) {
      raiseBanner({ t: frame.raceAt, type: 'weather', severity: 'info', lap: frame.lap, drivers: [], text: rain.words });
    }
    weather.add(frame);
    radio.sync(frame, mayAutoplay());
    unread = feedOpen ? 0 : alerts.unread(frame);
  }

  /** A new mode or session: nothing carries over. */
  function forget() {
    alerts.reset();
    announcer.reset();
    weather = new P.WeatherHistory();
    radio.reset();
    processed = null;
    unread = 0;
    clearTimeout(banner.timer);
    banner.event = null;
  }

  function feedView(frame) {
    if (settings.view === 'feed' && frame) {
      alerts.markRead(frame);
      unread = 0;
    }
    UI.show('unread', unread > 0);
    UI.text('unread', unread > 9 ? '9+' : unread);
    var feedTab = document.querySelector('#views [data-view="feed"]');
    var label = unread > 0 ? 'Feed, ' + unread + ' new' : 'Feed';
    if (feedTab.getAttribute('aria-label') !== label) { feedTab.setAttribute('aria-label', label); }
    P.Feed.render(frame, {
      weather: weather,
      radio: radio,
      followed: settings.followed,
      soundOn: settings.sound,
      unlocked: P.Audio.unlocked(),
      mode: settings.mode,
      shown: settings.view === 'feed'
    });
  }

  P.Feed.on({
    onClip: function (key) {
      var clip = (radio.clips || []).filter(function (c) { return c.key === key; })[0];
      if (!clip) { return; }
      if (radio.playing && radio.playing.key === key) { radio.stopClip(); } else { radio.playClip(clip); }
    },
    onSound: function () {
      settings.sound = !settings.sound;
      UI.save('sound', settings.sound);
      if (!settings.sound) { radio.silence(); }
      draw();
    }
  });

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
    process(frame);
    P.Tower.render(frame, settings);
    map(frame, season);
    ring(frame, season, now.state);
    ticker(frame);
    feedView(frame);
    driverCard(frame, season);
    standby(frame, now.state);
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

  // ---------- The map ----------

  /** Live, the stream's car positions move the map between frames; in replay the frames do. */
  function streamed() {
    return settings.mode === 'live' && feed && !demo ? feed.cars : null;
  }

  function map(frame, season) {
    var session = frame && frame.session;
    var round = P.Season.roundFor(season, session);
    P.Map.render(frame, {
      geoId: round ? round.geoId : null,
      circuit: session ? session.circuit || session.location : null,
      followed: settings.followed,
      shown: settings.view === 'map',
      streamed: streamed(),
      streamRate: feed && feed.state.carRate
    });
  }

  P.Map.on({
    onCar: function (num) { pickAndOpen(num); }
  });

  // ---------- One car in full ----------

  function driverCard(frame, season) {
    var live = settings.mode === 'live' && !demo;
    P.Driver.render(frame, {
      open: settings.open,
      followed: settings.followed,
      // The ghost belongs to races with a pit loss to project from.
      canGhost: !!(frame && P.Format.isRace(frame.session) && frame.strategy && frame.strategy.pitLoss),
      live: live,
      cars: live && feed ? feed.cars : null,
      totalLaps: frame ? P.Season.totalLaps(season, frame.session) : null
    });
  }

  P.Driver.on({
    /** Closing keeps the pick: the car stays ringed in the tower and on the Wall. */
    onClose: function () {
      settings.open = null;
      draw();
    },
    onFollow: function (num) {
      if (settings.followed.has(num)) { settings.followed.delete(num); } else { settings.followed.add(num); }
      UI.save('follow', Array.from(settings.followed));
      draw();
    },
    /** The ghost is on the Wall: go there with the car picked. */
    onGhost: function (num) {
      settings.picked = num;
      settings.open = null;
      views.pick('wall');
      setView('wall');
    }
  });

  // ---------- Between sessions ----------

  /** What's coming, from this year's sessions and next year's once they're listed. */
  var calendar = { sessions: [], next: null, weekend: [] };
  var calendarTimer = null;
  var backdrops = null;

  /* Read again a minute after the next session starts, so the poster moves along, and at
     least every 6 h; with nothing to go on yet, in a minute. */
  function loadCalendar() {
    clearTimeout(calendarTimer);
    var year = new Date().getUTCFullYear();
    return Promise.all([year, year + 1].map(function (y) {
      return P.Net.api('/f1/replay/sessions?year=' + y).then(P.Parse.sessions).catch(function () { return null; });
    })).then(function (lists) {
      var now = Date.now();
      var got = lists.filter(Boolean);
      if (got.length) {
        calendar = P.Calendar.upcoming([].concat.apply([], got), now);
        scheduleReminder();
        if (feed || demo) { draw(); }
      }
      calendarTimer = setTimeout(loadCalendar, calendar.next ? P.Calendar.recheckIn(calendar.next, now) : 60000);
    });
  }

  /** Live with nothing on: the poster, once the calendar says what's next. */
  function standby(frame, state) {
    var on = !frame && settings.mode === 'live' && !!calendar.next && (demo ? !demo.live : state.status === 'NO_SESSION');
    P.Standby.render({
      shown: on,
      next: calendar.next,
      weekend: calendar.weekend,
      backdrop: on ? P.Backdrops.find(backdrops, calendar.next) : null,
      remind: { on: remindersOn(), note: remindNote(true) }
    });
  }

  /* Adds the weekend's sessions still to come to whatever calendar opens the file. */
  function downloadWeekend() {
    var now = Date.now();
    var ahead = calendar.weekend.filter(function (s) { return s.start > now; });
    if (!calendar.next) { return; }
    var text = P.Ics.build(ahead.length ? ahead : [calendar.next], { now: now, url: window.location.origin + window.location.pathname });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
    link.download = P.Ics.fileName(calendar.next);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 10000);
  }

  P.Standby.on({
    onReplay: function () {
      modes.pick('replay');
      setMode('replay');
      // After this click has finished, or the + would take it for a click elsewhere and close.
      setTimeout(function () { UI.setMore(document.querySelector('[aria-controls="badge-panel"]'), true); }, 0);
    },
    onIcs: downloadWeekend,
    onRemind: function () { setReminders(!remindersOn()); }
  });

  // ---------- Reminders ----------

  /*
   * A notification an hour before each session of the kinds picked, while the page is open:
   * one timer at a time, for the next reminder due, checked again at least every 6 h (a
   * timer can't wait weeks, and a laptop sleeps). Waking late, a reminder still comes if
   * its session hasn't started. Each is tagged with its session, so two tabs show one.
   */
  var canNotify = 'Notification' in window;
  var reminders = {
    on: UI.load('remind.on', false) === true,
    off: new Set(UI.load('remind.off', [])),
    timer: null,
    sent: null
  };

  var remindDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

  function permission() {
    return canNotify ? window.Notification.permission : 'denied';
  }

  function remindersOn() {
    return reminders.on && permission() === 'granted';
  }

  function remindKinds() {
    return new Set(Object.keys(P.Reminders.KINDS).filter(function (k) { return !reminders.off.has(k); }));
  }

  function nextReminder() {
    return P.Reminders.due(calendar.sessions, Date.now(), remindKinds());
  }

  /** What the reminders are doing, in a line; on the poster, nothing while they're off. */
  function remindNote(poster) {
    if (!canNotify) { return 'This browser can’t show notifications.'; }
    if (reminders.on && permission() === 'denied') { return 'Notifications are blocked for this page in the browser’s settings.'; }
    if (!remindersOn()) { return poster ? '' : 'Off.'; }
    var next = nextReminder();
    if (!next) { return 'Nothing to remind you of on the calendar yet.'; }
    var at = next.start - P.Reminders.LEAD;
    return 'Next: ' + (next.name || 'Session') + ', reminded ' + remindDay.format(at) + ' ' + F.clock(at) + '. Keep this page open in a tab.';
  }

  function notify(session) {
    var w = P.Reminders.words(session);
    try {
      var n = new window.Notification(w[0], { body: w[1], tag: 'pitwall-' + session.key });
      n.onclick = function () {
        window.focus();
        n.close();
      };
    } catch (e) {
      // A browser that only notifies from a service worker: the reminder is lost, not the page.
    }
  }

  function scheduleReminder() {
    clearTimeout(reminders.timer);
    if (!remindersOn()) { return; }
    var next = nextReminder();
    if (!next) { return; }
    var at = next.start - P.Reminders.LEAD;
    reminders.timer = setTimeout(function () {
      var now = Date.now();
      if (now >= at - 1000 && next.start > now && reminders.sent !== next.key) {
        reminders.sent = next.key;
        notify(next);
      }
      scheduleReminder();
    }, Math.min(Math.max(0, at - Date.now()), 6 * 3600000));
  }

  /* Turning them on asks the browser's leave first; that has to come from a click. */
  function setReminders(on) {
    if (on && canNotify && permission() === 'default') {
      window.Notification.requestPermission().then(function (answer) { setReminders(answer === 'granted'); });
      return;
    }
    reminders.on = on;
    UI.save('remind.on', on);
    scheduleReminder();
    drawReminders();
    if (feed || demo) { draw(); }
  }

  var remindOn = document.getElementById('remind-on');
  var remindKindsEl = document.getElementById('remind-kinds');
  var remindTest = document.getElementById('remind-test');

  Object.keys(P.Reminders.KINDS).forEach(function (kind) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = P.Reminders.KINDS[kind];
    b.setAttribute('data-kind', kind);
    b.addEventListener('click', function () {
      if (reminders.off.has(kind)) { reminders.off.delete(kind); } else { reminders.off.add(kind); }
      UI.save('remind.off', Array.from(reminders.off));
      scheduleReminder();
      drawReminders();
      if (feed || demo) { draw(); }
    });
    remindKindsEl.appendChild(b);
  });

  function drawReminders() {
    var on = remindersOn();
    remindOn.setAttribute('aria-pressed', on ? 'true' : 'false');
    remindOn.textContent = on ? 'On' : 'Off';
    remindOn.disabled = !canNotify;
    Array.prototype.forEach.call(remindKindsEl.children, function (b) {
      b.setAttribute('aria-pressed', on && !reminders.off.has(b.getAttribute('data-kind')) ? 'true' : 'false');
      b.disabled = !on;
    });
    remindTest.disabled = !on || !calendar.next;
    UI.text('remindNote', remindNote(false));
  }

  remindOn.addEventListener('click', function () { setReminders(!remindersOn()); });
  remindTest.addEventListener('click', function () {
    if (calendar.next) { notify(calendar.next); }
  });
  // Opening the settings shows the reminder's time as it stands, the calendar having moved on.
  document.querySelector('[aria-controls="settings-panel"]').addEventListener('click', drawReminders);
  drawReminders();

  // ---------- The Wall ----------

  /*
   * How fast race time runs between frames, so the ring keeps turning: 1 live, the replay's
   * speed while it plays, still when paused, stale or failing.
   */
  function raceRate(state) {
    if (demo) { return 0; }
    if (settings.mode === 'replay') { return replay.state.playing ? replay.state.speed : 0; }
    return state.status === 'LIVE' && !state.stale && !state.failing ? 1 : 0;
  }

  function ring(frame, season, state) {
    P.Ring.render(frame, {
      totalLaps: frame ? P.Season.totalLaps(season, frame.session) : null,
      picked: settings.picked,
      followed: settings.followed,
      shown: settings.view === 'wall',
      rate: raceRate(state)
    });
  }

  P.Ring.on({
    /** A click: picks the car, or lets go of the one already picked. */
    onPick: function (num) {
      settings.picked = settings.picked === num ? null : num;
      draw();
    },
    /** A drag round the ring, a step, or opening on a followed driver: picks outright. */
    onSelect: function (num) {
      if (settings.picked === num) { return; }
      settings.picked = num;
      draw();
    }
  });

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
    forget();
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
    if (view === 'feed') {
      clearTimeout(banner.timer);
      banner.event = null;
    }
    if (feed || demo) { draw(); }
  }

  // ---------- The voice's settings ----------

  var voiceOn = document.getElementById('voice-on');
  var voiceKinds = document.getElementById('voice-kinds');
  var voicePick = document.getElementById('voice-pick');

  Object.keys(P.Announcer.KINDS).forEach(function (kind) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = P.Announcer.KINDS[kind];
    b.setAttribute('data-kind', kind);
    b.addEventListener('click', function () {
      if (settings.voice.off.has(kind)) { settings.voice.off.delete(kind); } else { settings.voice.off.add(kind); }
      UI.save('voice.off', Array.from(settings.voice.off));
      drawVoice();
    });
    voiceKinds.appendChild(b);
  });

  function drawVoice() {
    var v = settings.voice;
    voiceOn.setAttribute('aria-pressed', v.on ? 'true' : 'false');
    voiceOn.textContent = v.on ? 'On' : 'Off';
    Array.prototype.forEach.call(voiceKinds.children, function (b) {
      b.setAttribute('aria-pressed', v.on && !v.off.has(b.getAttribute('data-kind')) ? 'true' : 'false');
      b.disabled = !v.on;
    });
    var list = P.Audio.voices();
    var names = list.map(function (x) { return x.name; }).join('|');
    if (voicePick.__names !== names) {
      voicePick.__names = names;
      voicePick.innerHTML = '';
      list.forEach(function (x, i) {
        var o = document.createElement('option');
        o.value = x.name;
        o.textContent = 'Voice ' + String.fromCharCode(65 + i) + ' — ' + x.name;
        voicePick.appendChild(o);
      });
    }
    if (v.name && list.some(function (x) { return x.name === v.name; })) { voicePick.value = v.name; }
    voicePick.hidden = !list.length;
    UI.text('voiceNote', !P.Audio.canSpeak ? 'This browser can’t speak, so the alerts stay on the screen.' :
      !list.length ? 'No UK English voice that runs on this computer; the browser’s own voice is used.' :
      !P.Audio.unlocked() ? 'The browser lets the page speak after one click anywhere on it.' : '');
  }

  voiceOn.addEventListener('click', function () {
    settings.voice.on = !settings.voice.on;
    UI.save('voice.on', settings.voice.on);
    drawVoice();
  });
  voicePick.addEventListener('change', function () {
    settings.voice.name = voicePick.value;
    UI.save('voice.name', settings.voice.name);
    P.Audio.say('Safety car alert', settings.voice.name);
  });
  document.getElementById('voice-test').addEventListener('click', function () {
    P.Audio.say('Safety car alert', settings.voice.name);
  });
  P.Audio.onChange(function () {
    drawVoice();
    if (feed || demo) { draw(); }
  });
  drawVoice();

  var views = UI.seg(document.getElementById('views'), 'data-view', setView);
  views.pick(settings.view);
  setView(settings.view);
  narrow.addEventListener('change', function () {
    if (!narrow.matches && settings.view === 'tower') {
      views.pick('map');
      setView('map');
    }
  });

  /** A click on a car in the tower or on the map: pick it and open its card, or let go of it. */
  function pickAndOpen(num) {
    settings.picked = settings.picked === num ? null : num;
    settings.open = settings.picked;
    draw();
  }

  P.Tower.on({
    onPick: pickAndOpen,
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
    var on = settings.mode === 'replay' ? replay.state.playing : !!feed && feed.state.status === 'LIVE' && !demo;
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
    var view = { t: narrow.matches ? 'tower' : null, m: 'map', w: 'wall', f: 'feed' }[e.key];
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
    // The stream's car updates, several a second, move the map alone.
    feed.onCars(function (cars) {
      if (settings.mode === 'live') {
        P.Map.stream(cars);
        P.Driver.telemetry(cars);
      }
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

  P.Net.data('backdrops.json', DATA_V).then(function (json) {
    backdrops = json ? P.Backdrops.parse(json) : null;
    if (feed || demo) { draw(); }
  });
  loadCalendar();

  loadSeasons().then(function () {
    var name = params.get('demo');
    if (name && DEMOS[name]) { return startDemo(name); }
    startLive();
  });

  P.App = { draw: draw, settings: settings, replay: replay };
}());
