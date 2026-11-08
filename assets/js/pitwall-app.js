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

  var settings = {
    view: VIEWS.indexOf(params.get('view')) >= 0 ? params.get('view') : UI.load('view', 'map'),
    gapMode: UI.load('gap', 'LEADER'),
    followed: new Set(followedAtStart()),
    picked: null
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

  function standbyNote(state) {
    if (demo) { return 'A captured frame'; }
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
    if (!frame && now.state.reason) { UI.text('towerEmpty', 'No session running. The running order fills in by itself when one starts.'); }
    document.title = frame ? F.flagWord(frame.flag ? frame.flag.state : 'GREEN') + ' · Pitwall' : 'Pitwall — live F1 timing';
  }

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

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, select, textarea, [role="slider"]')) { return; }
    var view = { m: 'map', w: 'wall', f: 'feed' }[e.key];
    if (view && !e.shiftKey && !e.target.closest('.row')) {
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
    feed = new P.LiveFeed({ fetch: P.Net.live, initialDelay: UI.load('delay', 0) });
    feed.onState(draw);
    draw();
    feed.run();
    // Back on the page after a while away: poll now rather than at the next tick.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { feed.wake(); }
    });
  }

  loadSeasons().then(function () {
    var name = params.get('demo');
    if (name && DEMOS[name]) { return startDemo(name); }
    startLive();
  });

  P.App = { draw: draw, settings: settings };
}());
