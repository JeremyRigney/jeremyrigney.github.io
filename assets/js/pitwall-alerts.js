/*
 * Pitwall: what in each drawn frame is news — race control messages worth interrupting
 * for, flag changes worth saying out loud, the track temperature's trend, and team radio
 * clips to play. Ports of Pocket Pitwall's wall/Alerts.kt, wall/Announcer.kt,
 * wall/WeatherHistory.kt and the queue half of wall/Radio.kt. Pure: it runs under jsc in
 * tests/pitwall/, with the audio player handed in.
 *
 * All of them are fed the frames that are *drawn*, after the live delay, so they keep to
 * the wall rather than to the raw feed; and every frame carries the whole recent list, so
 * "new" is derived: a watermark, reset when the frame's own clock runs backwards (a scrub),
 * and primed — not fired — by the first frame of a session, so opening a race at half
 * distance doesn't open with forty banners.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  function raceMs(frame) {
    return frame.raceAt != null ? frame.raceAt : 0;
  }

  function sessionKey(frame) {
    return frame.session ? frame.session.key : null;
  }

  // ---------- Race control ----------

  /** Track-limits deletions are routine and frequent: counted, but not shouted. */
  function worthABanner(event) {
    return event.severity === 'high' || event.type === 'cleared' || event.type === 'weather';
  }

  /** What kind of message it is, as a banner names it: [label, tone], or null for plain. */
  function eventKind(event) {
    switch (event.type) {
      case 'penalty': return ['Penalty', 'alert'];
      case 'investigation': return ['Investigation', 'caution'];
      case 'cleared': return ['No further action', 'good'];
      case 'weather': return ['Weather', 'rain'];
      default: return null;
    }
  }

  function eventMs(e) {
    return e.t != null ? e.t : 0;
  }

  /*
   * Which race control messages are news: the one worth interrupting for (a penalty, an
   * investigation, one cleared, the weather), and how many arrived since the Feed was open.
   */
  function Alerts() {
    this.reset();
  }

  Alerts.prototype.reset = function () {
    this.session = null;
    this.clock = 0;
    this.head = null;
    this.readUpTo = null;
  };

  /** Feed a drawn frame through; returns a newly arrived message worth a banner, if any. */
  Alerts.prototype.sync = function (frame, feedOpen) {
    var events = frame.events || [];
    var newest = events.reduce(function (m, e) { return Math.max(m, eventMs(e)); }, 0);
    var now = raceMs(frame);
    var key = sessionKey(frame);
    var newSession = key !== this.session;
    if (newSession || now < this.clock - 1000) {
      // A new session, or the playhead moved back: start again from here, quietly.
      this.readUpTo = newSession || this.readUpTo == null || feedOpen ? newest : Math.min(this.readUpTo, newest);
      this.session = key;
      this.clock = now;
      this.head = newest;
      return null;
    }
    this.clock = now;
    var since = this.head == null ? newest : this.head;
    this.head = Math.max(since, newest);
    if (feedOpen) { this.readUpTo = newest; }
    var best = null;
    events.forEach(function (e) {
      if (eventMs(e) > since && worthABanner(e) && (!best || eventMs(e) > eventMs(best))) { best = e; }
    });
    return best;
  };

  Alerts.prototype.unread = function (frame) {
    var read = this.readUpTo;
    if (read == null) { return 0; }
    return (frame.events || []).filter(function (e) { return eventMs(e) > read; }).length;
  };

  Alerts.prototype.markRead = function (frame) {
    var events = frame.events || [];
    if (events.length) { this.readUpTo = events.reduce(function (m, e) { return Math.max(m, eventMs(e)); }, 0); }
  };

  // ---------- Saying it out loud ----------

  var KINDS = {
    YELLOW: 'Yellow flag',
    VSC: 'VSC',
    SAFETY_CAR: 'Safety car',
    RED: 'Red flag',
    ENDING: 'Coming in',
    GREEN: 'Green flag',
    CHEQUERED: 'Chequered flag',
    RAIN: 'Rain',
    DRY: 'Rain stops'
  };

  /** A same-kind announcement within this much race time is said once. */
  var REPEAT_MS = 30000;

  function words(kind, state) {
    switch (kind) {
      case 'YELLOW': return 'Yellow flag alert';
      case 'VSC': return 'V S C alert';
      case 'SAFETY_CAR': return 'Safety car alert';
      case 'RED': return 'Red flag alert';
      case 'ENDING': return state === 'VSC' ? 'V S C ending' : 'Safety car in this lap';
      // Not "racing resumes": speech engines read that as the plural of a CV.
      case 'GREEN': return 'Green flag. Back to racing';
      case 'CHEQUERED': return 'Chequered flag';
      case 'RAIN': return 'Rain reported';
      case 'DRY': return 'Rain has stopped';
      default: return '';
    }
  }

  /*
   * Which flag changes are worth saying out loud, for when the screen isn't being watched.
   * Set the wall a second or two ahead of the broadcast and the voice says "Safety car"
   * just before the picture shows it. A local yellow that clears and returns within 30 s of
   * race time is announced once.
   */
  function Announcer() {
    this.reset();
  }

  Announcer.prototype.reset = function () {
    this.session = null;
    this.clock = 0;
    this.state = null;
    this.ending = false;
    this.lastSaid = {};
    this.rainSession = null;
    this.rainClock = 0;
    this.raining = null;
  };

  /**
   * Feed every drawn frame through. Returns {kind, words} to say, or null. allowed is false
   * when speaking would be noise (a replay paused or played too fast); the state is still
   * tracked, so nothing is announced late when it becomes true again.
   */
  Announcer.prototype.next = function (frame, allowed) {
    var flag = frame.flag;
    if (!flag) { return null; }
    var now = raceMs(frame);
    var key = sessionKey(frame);
    if (key !== this.session || this.state == null || now < this.clock - 1000) {
      this.session = key;
      this.clock = now;
      this.state = flag.state;
      this.ending = flag.ending;
      this.lastSaid = {};
      return null;
    }
    this.clock = now;
    var was = this.state;
    var wasEnding = this.ending;
    this.state = flag.state;
    this.ending = flag.ending;

    var kind = null;
    if (flag.state !== was) {
      if (flag.state === 'GREEN') {
        // Back to green matters after a neutralisation; after a local yellow it's noise.
        kind = P.Format.neutralised(was) ? 'GREEN' : null;
      } else {
        kind = flag.state;
      }
    } else if (flag.ending && !wasEnding && P.Format.neutralised(flag.state)) {
      kind = 'ENDING';
    }
    if (!kind) { return null; }
    var last = this.lastSaid[kind];
    if (last != null && now - last < REPEAT_MS) { return null; }
    this.lastSaid[kind] = now;
    if (allowed === false) { return null; }
    return { kind: kind, words: words(kind, flag.state) };
  };

  /**
   * Rain starting or stopping, from the weather feed's rainfall flag, primed and reset the
   * same way as the flags: opening the wall in the rain says nothing.
   */
  Announcer.prototype.rain = function (frame, allowed) {
    var weather = frame.weather;
    if (!weather) { return null; }
    var now = raceMs(frame);
    var key = sessionKey(frame);
    if (key !== this.rainSession || this.raining == null || now < this.rainClock - 1000) {
      this.rainSession = key;
      this.rainClock = now;
      this.raining = weather.rain;
      return null;
    }
    this.rainClock = now;
    var was = this.raining;
    this.raining = weather.rain;
    if (was === weather.rain || allowed === false) { return null; }
    var kind = weather.rain ? 'RAIN' : 'DRY';
    return { kind: kind, words: words(kind, frame.flag ? frame.flag.state : null) };
  };

  Announcer.KINDS = KINDS;
  Announcer.words = words;
  Announcer.REPEAT_MS = REPEAT_MS;

  // ---------- The conditions ----------

  var WEATHER_MAX = 600;
  /** Below this a change in track temperature reads as steady. */
  var STEADY = 0.5;

  /*
   * The session's weather over time, for the conditions card's trend and line. The feed only
   * ever gives the latest reading, so this keeps its own record as frames are drawn: live,
   * from when the page was opened; in replay, over the stretch that has been played. A new
   * session starts it again, and scrubbing backwards drops whatever lies ahead.
   */
  function WeatherHistory() {
    this.session = null;
    this.points = [];
  }

  /** Feed a drawn frame through; true when the record changed. */
  WeatherHistory.prototype.add = function (frame) {
    var w = frame.weather;
    var at = frame.raceAt;
    if (!w || at == null) { return false; }
    var key = sessionKey(frame);
    var changed = false;
    if (key !== this.session) {
      this.session = key;
      this.points = [];
      changed = true;
    }
    var last = this.points[this.points.length - 1];
    if (last && at < last.at - 1000) {
      this.points = this.points.filter(function (p) { return p.at <= at; });
      changed = true;
    }
    var prev = this.points[this.points.length - 1];
    // Readings change about once a minute; one sample per new reading, or per half minute.
    if (!prev || at - prev.at >= 30000 || prev.air !== w.air || prev.track !== w.track) {
      if (!prev || at > prev.at) {
        this.points.push({ at: at, air: w.air, track: w.track });
        if (this.points.length > WEATHER_MAX) { this.points.shift(); }
        changed = true;
      }
    }
    return changed;
  };

  /** How far the track temperature has moved over about the last window minutes: {degrees, minutes} or null. */
  WeatherHistory.prototype.trend = function (window) {
    var now = this.points[this.points.length - 1];
    if (!now || now.track == null) { return null; }
    var from = now.at - (window || 30) * 60000;
    var ref = this.points.filter(function (p) { return p.at >= from && p.track != null; })[0];
    if (!ref) { return null; }
    var minutes = Math.trunc((now.at - ref.at) / 60000);
    if (minutes < 5) { return null; }
    return { degrees: now.track - ref.track, minutes: minutes };
  };

  WeatherHistory.steady = function (t) {
    return Math.abs(t.degrees) < STEADY;
  };

  // ---------- Team radio ----------

  var RADIO_ROWS = 5;
  var QUEUE_MAX = 3;
  var STALE_MS = 120000;
  var CLIP_TIMEOUT_MS = 60000;
  var HOST = 'https://livetiming.formula1.com/';

  /** Remote data going into a player, so it is checked rather than trusted. */
  function safeUrl(url) {
    var out = String(url || '').replace(/^http:\/\//i, 'https://');
    return out.indexOf(HOST) === 0 ? out : null;
  }

  /*
   * Team radio: which clips are new, which play by themselves, one at a time.
   *
   * Followed drivers' clips play by themselves, oldest first, with at most three waiting, in
   * live mode or in replay at 1×; everyone else's are a click away. A clip that has waited
   * two minutes is stale and skipped. A clicked clip preempts whatever is playing, drops the
   * queue, and pauses a replay until it ends.
   *
   * options: player {play(url, done), stop()}, setTimer/clearTimer, follow () => Set,
   * soundOn () => bool, hold () => bool (pause replay; true if it did), release ().
   */
  function Radio(options) {
    var o = options || {};
    this.player = o.player;
    this.setTimer = o.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    this.clearTimer = o.clearTimer || function (h) { clearTimeout(h); };
    this.follow = o.follow || function () { return new Set(); };
    this.soundOn = o.soundOn || function () { return true; };
    this.hold = o.hold || function () { return false; };
    this.release = o.release || function () {};
    this.onChange = o.onChange || function () {};
    this.session = null;
    this.clock = 0;
    this.headMs = null;
    this.seen = new Set();
    this.queue = [];
    this.playing = null;
    this.manual = false;
    this.resume = false;
    this.guard = null;
    /** The newest clips, newest first; null when the server sends no radio at all. */
    this.clips = null;
  }

  function clipMs(clip) {
    return clip.t != null ? clip.t : 0;
  }

  /** Feed every drawn frame through here. */
  Radio.prototype.sync = function (frame, autoplay) {
    var seenKeys = {};
    var clips = frame.radio ? frame.radio.filter(function (c) {
      if (seenKeys[c.key]) { return false; }
      seenKeys[c.key] = true;
      return true;
    }) : null;
    this.clips = clips ? clips.slice(0, RADIO_ROWS) : null;
    if (!clips) { return; }
    var key = sessionKey(frame);
    if (key !== this.session) {
      this.rewind();
      this.session = key;
    }
    var now = frame.raceAt != null ? frame.raceAt : Date.now();
    // A second of slack: the live clock is a server timestamp and can jitter backwards.
    if (now < this.clock - 1000) { this.rewind(); }
    this.clock = now;

    var self = this;
    var fresh = [];
    if (this.headMs != null) {
      clips.forEach(function (c) {
        if (clipMs(c) > self.headMs && !self.seen.has(c.key)) { fresh.push(c); }
      });
    }
    clips.forEach(function (c) {
      self.seen.add(c.key);
      if (self.headMs == null || clipMs(c) > self.headMs) { self.headMs = clipMs(c); }
    });
    if (this.headMs == null) { this.headMs = 0; } // primed on a session with no clips yet
    // The set only matters at the head, so it can be dropped wholesale.
    if (this.seen.size > 800) { this.seen.clear(); }
    // The payload is newest first; play in the order they were said.
    fresh.sort(function (a, b) { return clipMs(a) - clipMs(b); });
    fresh.forEach(function (c) { self.offer(c, autoplay); });
  };

  /** A click preempts whatever is playing and drops the queue behind it. */
  Radio.prototype.playClip = function (clip) {
    var url = safeUrl(clip.url);
    if (!url) { return; }
    this.queue = [];
    this.stopPlayer();
    this.resume = this.hold();
    this.start(clip, url, true);
  };

  Radio.prototype.stopClip = function () {
    this.queue = [];
    this.stopPlayer();
  };

  /** Sound off: nothing plays, and nothing waits. */
  Radio.prototype.silence = function () {
    this.queue = [];
    this.stopPlayer();
  };

  /** A new session or a change of mode: nothing carries over. */
  Radio.prototype.reset = function () {
    this.rewind();
    this.session = null;
    this.clock = 0;
    this.clips = null;
  };

  Radio.prototype.rewind = function () {
    this.queue = [];
    this.stopPlayer();
    this.resume = false;
    this.seen.clear();
    this.headMs = null;
  };

  Radio.prototype.offer = function (clip, autoplay) {
    if (!safeUrl(clip.url) || !this.follow().has(clip.num) || !autoplay || !this.soundOn()) { return; }
    if (this.clock - clipMs(clip) > STALE_MS) { return; }
    this.queue.push(clip);
    while (this.queue.length > QUEUE_MAX) { this.queue.shift(); }
    this.next();
  };

  Radio.prototype.next = function () {
    if (this.playing || !this.soundOn()) { return; }
    while (this.queue.length) {
      var clip = this.queue.shift();
      // Re-checked: a clip can go stale waiting behind two long ones.
      if (this.clock - clipMs(clip) <= STALE_MS) {
        this.start(clip, safeUrl(clip.url), false);
        return;
      }
    }
  };

  Radio.prototype.start = function (clip, url, manual) {
    var self = this;
    this.manual = manual;
    this.playing = clip;
    this.onChange();
    this.player.play(url, function () { self.ended(clip); });
    this.clearTimer(this.guard);
    this.guard = this.setTimer(function () {
      if (self.playing === clip) {
        self.player.stop();
        self.ended(clip);
      }
    }, CLIP_TIMEOUT_MS);
  };

  Radio.prototype.ended = function (clip) {
    if (this.playing !== clip) { return; }
    this.clearTimer(this.guard);
    this.playing = null;
    this.onChange();
    if (this.resume) {
      this.resume = false;
      this.release();
    }
    // A clip the viewer asked for doesn't drag the queue along behind it.
    var manual = this.manual;
    this.manual = false;
    if (!manual) { this.next(); }
  };

  Radio.prototype.stopPlayer = function () {
    this.clearTimer(this.guard);
    var was = this.playing;
    this.playing = null;
    if (was) {
      this.player.stop();
      this.onChange();
    }
    this.manual = false;
  };

  Radio.safeUrl = safeUrl;
  Radio.QUEUE_MAX = QUEUE_MAX;
  Radio.STALE_MS = STALE_MS;

  P.Alerts = Alerts;
  P.Announcer = Announcer;
  P.WeatherHistory = WeatherHistory;
  P.Radio = Radio;
  P.eventKind = eventKind;
  P.worthABanner = worthABanner;
}());
