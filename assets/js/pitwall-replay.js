/*
 * Pitwall: replay — a past session played back against the wall clock. A port of Pocket
 * Pitwall's wall/ReplayFeed.kt (itself a port of the site's f1-lab.js), with the jumps and
 * the scrubber's bands from ui/ReplayBar.kt.
 *
 * Frames are composed by the server from a cached copy of the session, so after the first
 * (slow) load scrubbing costs a couple of milliseconds a frame. Only one request is ever in
 * flight; asking again meanwhile replaces the waiting instant, so a fast scrub lands on
 * where the pointer stopped rather than replaying every point it passed.
 *
 * The source, the clock and the timers are handed in, so the tests run it on a virtual
 * clock. Instants are epoch milliseconds.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  /** Floor between playback frames, so it cannot spin. */
  var FRAME_MS = 60;
  var SPEEDS = [1, 5, 10, 60, 300];
  /** OpenF1's free historical data starts here. */
  var FIRST_YEAR = 2023;
  /** A spell of the same flag that clears and returns within this long is one jump. */
  var JUMP_MERGE_MS = 120000;

  /** The scrubber's bands: each flag's colour token and how strongly it is laid down. */
  var BANDS = {
    GREEN: { token: '--flag-green', alpha: 0.30 },
    YELLOW: { token: '--flag-yellow', alpha: 0.55 },
    VSC: { token: '--flag-yellow', alpha: 0.75 },
    SAFETY_CAR: { token: '--flag-yellow', alpha: 0.95 },
    RED: { token: '--flag-red', alpha: 0.85 },
    CHEQUERED: { token: '--flag-chequered', alpha: 0.35 }
  };

  var JUMP_LABELS = {
    YELLOW: 'Yellow',
    VSC: 'VSC',
    SAFETY_CAR: 'Safety car',
    RED: 'Red flag',
    CHEQUERED: 'Chequered',
    GREEN: 'Green'
  };

  /**
   * One jump per spell: a yellow that clears and returns within two minutes is one jump.
   * Only spells that begin within the session count: the server's timeline can carry flags
   * from before it starts, and a jump there would only land on the start.
   */
  function jumps(timeline) {
    var kept = [];
    timeline.periods.forEach(function (p) {
      if (p.state === 'GREEN') { return; }
      if (timeline.start != null && (p.from < timeline.start || p.from > timeline.end)) { return; }
      var last = kept[kept.length - 1];
      if (last && last.state === p.state && p.from - last.from < JUMP_MERGE_MS) { return; }
      kept.push(p);
    });
    return kept;
  }

  function assign(target, patch) {
    var out = {};
    var k;
    for (k in target) { out[k] = target[k]; }
    for (k in patch) { out[k] = patch[k]; }
    return out;
  }

  function clamp(t, min, max) {
    return t < min ? min : t > max ? max : t;
  }

  /*
   * options:
   *   source   {sessions(year), timeline(key), frame(key, at)}, each returning a promise
   *   clock    () => ms
   *   setTimer, clearTimer
   */
  function ReplayFeed(options) {
    var o = options || {};
    this.source = o.source;
    this.clock = o.clock || function () { return Date.now(); };
    this.setTimer = o.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    this.clearTimer = o.clearTimer || function (handle) { clearTimeout(handle); };
    this.state = {
      year: new Date(this.clock()).getUTCFullYear(),
      /** The picker's list for year; null while loading. */
      sessions: null,
      sessionsError: null,
      session: null,
      timeline: null,
      /** What the replay is doing, when that is worth saying ("Loading…"). */
      status: null,
      at: null,
      frame: null,
      /** The first frame has landed, so the server's copy is warm and Play can start. */
      ready: false,
      playing: false,
      speed: 5
    };
    this.inFlight = false;
    this.pending = null;
    this.anchor = null; // [wall ms, race ms]
    this.generation = 0; // bumps on every pick, to drop stale replies
    this.yearGeneration = 0;
    this.tickTimer = null;
    this.listeners = [];
  }

  ReplayFeed.prototype.onState = function (fn) { this.listeners.push(fn); };

  ReplayFeed.prototype.update = function (patch) {
    this.state = assign(this.state, patch);
    var state = this.state;
    this.listeners.forEach(function (fn) { fn(state); });
  };

  ReplayFeed.prototype.loadYear = function (year) {
    var self = this;
    var mine = ++this.yearGeneration;
    this.update({ year: year, sessions: null, sessionsError: null });
    return this.source.sessions(year).then(function (list) {
      if (mine !== self.yearGeneration) { return; }
      // Only sessions that have started can be replayed; the list includes the future.
      var now = self.clock();
      self.update({ sessions: list.filter(function (s) { return s.start == null || s.start <= now; }) });
    }, function (e) {
      if (mine !== self.yearGeneration) { return; }
      self.update({ sessions: [], sessionsError: 'Couldn’t load ' + year + ': ' + (e && e.message ? e.message : e) });
    });
  };

  /**
   * Replay a session, from at or its start. A session known only by its key (from a link)
   * takes the rest of its name from the timeline.
   */
  ReplayFeed.prototype.pick = function (session, at) {
    var key = session && session.key;
    if (key == null) { return Promise.resolve(); }
    var self = this;
    this.stop();
    var mine = ++this.generation;
    this.inFlight = false;
    this.pending = null;
    var name = [P.Format.eventShort(session), session.name].filter(Boolean).join(' · ');
    this.update({
      session: session,
      timeline: null,
      frame: null,
      at: null,
      ready: false,
      status: 'Loading ' + (name || 'session') + '…'
    });
    return this.source.timeline(key).then(function (timeline) {
      if (mine !== self.generation) { return; }
      self.update({
        timeline: timeline,
        session: session.name ? session : timeline.session,
        status: 'Loading positions — the first frame takes a few seconds'
      });
      self.seek(at != null ? at : timeline.start);
    }, function (e) {
      if (mine === self.generation) {
        self.update({ status: 'Timeline failed: ' + (e && e.message ? e.message : e) });
      }
    });
  };

  /** Leave replay: nothing more is asked for, and replies still on their way are dropped. */
  ReplayFeed.prototype.close = function () {
    this.stop();
    this.generation += 1;
    this.inFlight = false;
    this.pending = null;
  };

  /** Move the playhead, clamped to the session. Does not stop playback by itself. */
  ReplayFeed.prototype.seek = function (at) {
    var timeline = this.state.timeline;
    if (!timeline) { return; }
    var clamped = clamp(at, timeline.start, timeline.end);
    this.update({ at: clamped });
    this.request(clamped);
  };

  /** A scrub or a nudge: a hand on the playhead stops playback. */
  ReplayFeed.prototype.scrub = function (at) {
    this.stop();
    this.seek(at);
  };

  ReplayFeed.prototype.nudge = function (seconds) {
    if (this.state.at == null) { return; }
    this.scrub(this.state.at + seconds * 1000);
  };

  ReplayFeed.prototype.play = function () {
    var s = this.state;
    if (!s.ready || s.at == null || !s.timeline) { return; }
    if (s.at >= s.timeline.end) { return; }
    this.anchor = [this.clock(), s.at];
    this.update({ playing: true });
    this.advance();
  };

  ReplayFeed.prototype.stop = function () {
    this.anchor = null;
    this.clearTimer(this.tickTimer);
    if (this.state.playing) { this.update({ playing: false }); }
  };

  ReplayFeed.prototype.toggle = function () {
    if (this.state.playing) { this.stop(); } else { this.play(); }
  };

  /** Changing speed mid-play re-bases the clock, so the playhead does not leap. */
  ReplayFeed.prototype.setSpeed = function (speed) {
    this.update({ speed: speed });
    if (this.state.playing && this.state.at != null) { this.anchor = [this.clock(), this.state.at]; }
  };

  ReplayFeed.prototype.advance = function () {
    if (!this.anchor || !this.state.timeline) { return; }
    var timeline = this.state.timeline;
    var next = this.anchor[1] + (this.clock() - this.anchor[0]) * this.state.speed;
    if (next >= timeline.end) {
      this.seek(timeline.end);
      this.stop();
    } else {
      this.seek(next);
    }
  };

  ReplayFeed.prototype.request = function (at) {
    var key = this.state.session && this.state.session.key;
    if (key == null) { return; }
    if (this.inFlight) {
      this.pending = at;
      return;
    }
    this.inFlight = true;
    var self = this;
    var mine = this.generation;
    this.source.frame(key, at).then(function (frame) {
      if (mine === self.generation && frame && frame.live) {
        self.update({ frame: frame, ready: true, status: null });
      }
    }, function () {
      // A dropped frame; the next scrub or tick asks again.
      if (mine === self.generation && !self.state.ready) {
        self.update({ status: 'Couldn’t load that moment — try again' });
      }
    }).then(function () {
      if (mine !== self.generation) { return; }
      self.inFlight = false;
      var next = self.pending;
      if (next != null) {
        self.pending = null;
        self.request(next);
      } else if (self.state.playing) {
        self.tickTimer = self.setTimer(function () { self.advance(); }, FRAME_MS);
      }
    });
  };

  ReplayFeed.FRAME_MS = FRAME_MS;
  ReplayFeed.SPEEDS = SPEEDS;
  ReplayFeed.FIRST_YEAR = FIRST_YEAR;

  P.ReplayFeed = ReplayFeed;
  P.Replay = {
    BANDS: BANDS,
    JUMP_LABELS: JUMP_LABELS,
    jumps: jumps
  };
}());
