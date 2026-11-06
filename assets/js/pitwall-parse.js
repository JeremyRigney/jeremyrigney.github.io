/*
 * Pitwall: the timing API's JSON into the shapes the wall draws from.
 *
 * A port of Pocket Pitwall's data/Parse.kt. Tolerant by design: a missing or null field
 * becomes null or empty, never an exception, so a server one build behind still draws.
 * Every frame is a whole snapshot, shaped by _compose in f1_live.py. Instants become epoch
 * milliseconds; a gap stays a number of seconds, or text such as "+1 LAP" for a lapped car.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  /*
   * Timestamps arrive as "2026-10-11T12:45:00Z", "…+00:00" and "…12:45:00.378000+00:00".
   * A bare local time is read as UTC, which Date.parse would not do.
   */
  var INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/;

  function instant(text) {
    if (typeof text !== 'string') { return null; }
    var m = INSTANT.exec(text.trim());
    if (!m) { return null; }
    var ms = m[7] ? Math.floor(parseInt((m[7] + '00').slice(0, 3), 10)) : 0;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, ms);
    var zone = m[8];
    if (zone && zone !== 'Z') {
      var sign = zone.charAt(0) === '-' ? -1 : 1;
      var digits = zone.slice(1).replace(':', '');
      t -= sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4), 10)) * 60000;
    }
    return isFinite(t) ? t : null;
  }

  // ---------- JSON, null-safely ----------

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function str(o, key) {
    var v = o ? o[key] : null;
    return typeof v === 'string' && v.length ? v : null;
  }

  function num(o, key) {
    var v = o ? o[key] : null;
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function int(o, key) {
    var v = num(o, key);
    return v == null ? null : Math.trunc(v);
  }

  function bool(o, key) {
    return !!(o && o[key] === true);
  }

  function obj(o, key) {
    return o && isObj(o[key]) ? o[key] : null;
  }

  function arr(o, key) {
    return o && Array.isArray(o[key]) ? o[key] : [];
  }

  function numberAt(a, i) {
    var v = Array.isArray(a) ? a[i] : null;
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function objects(a) {
    return a.filter(isObj);
  }

  function doubles(a) {
    return a.map(function (v) { return typeof v === 'number' && isFinite(v) ? v : null; });
  }

  function ints(a) {
    return a.filter(function (v) { return typeof v === 'number' && isFinite(v); }).map(Math.trunc);
  }

  function strings(a) {
    return a.filter(function (v) { return typeof v === 'string'; });
  }

  function gapOf(o, key) {
    var v = o ? o[key] : null;
    if (typeof v === 'number' && isFinite(v)) { return v; }
    if (typeof v === 'string' && v.trim()) { return v; }
    return null;
  }

  function json(input) {
    return typeof input === 'string' ? JSON.parse(input) : input;
  }

  // ---------- Shapes ----------

  function session(o) {
    return {
      key: int(o, 'key'),
      name: str(o, 'name'),
      type: str(o, 'type'),
      circuit: str(o, 'circuit'),
      circuitKey: int(o, 'circuitKey'),
      location: str(o, 'location'),
      country: str(o, 'country'),
      start: instant(str(o, 'start')),
      end: instant(str(o, 'end')),
      meeting: str(o, 'meeting'),
      meetingKey: int(o, 'meetingKey')
    };
  }

  function flag(o) {
    return {
      state: P.Format.flagState(str(o, 'state')) || 'GREEN',
      since: instant(str(o, 'since')),
      message: str(o, 'message'),
      sectors: ints(arr(o, 'sectors')),
      ending: bool(o, 'ending')
    };
  }

  function driver(o) {
    var number = int(o, 'num');
    if (number == null) { return null; }
    var xy = arr(o, 'xy');
    var x = numberAt(xy, 0);
    var y = numberAt(xy, 1);
    return {
      num: number,
      pos: int(o, 'pos'),
      code: str(o, 'code'),
      name: str(o, 'name'),
      team: str(o, 'team'),
      colour: str(o, 'colour'),
      gapToLeader: gapOf(o, 'gapToLeader'),
      interval: gapOf(o, 'interval'),
      lastLap: num(o, 'lastLap'),
      bestLap: num(o, 'bestLap'),
      sectors: doubles(arr(o, 'sectors')),
      bestSectors: doubles(arr(o, 'bestSectors')),
      speed: int(o, 'speed'),
      lap: int(o, 'lap'),
      lapStart: instant(str(o, 'lapStart')),
      compound: str(o, 'compound'),
      tyreAge: int(o, 'tyreAge'),
      inPit: bool(o, 'inPit'),
      pitStops: int(o, 'pitStops'),
      dnf: bool(o, 'dnf'),
      badges: strings(arr(o, 'badges')),
      penalty: str(o, 'penalty'),
      penaltyServed: bool(o, 'penaltyServed'),
      stints: objects(arr(o, 'stints')).map(function (s) {
        return { compound: str(s, 'compound'), lapStart: int(s, 'lapStart'), lapEnd: int(s, 'lapEnd'), age: int(s, 'age') };
      }),
      xy: x != null && y != null ? [x, y] : null
    };
  }

  function event(o) {
    var text = str(o, 'text');
    if (text == null) { return null; }
    return {
      t: instant(str(o, 't')),
      type: str(o, 'type'),
      severity: str(o, 'severity'),
      drivers: ints(arr(o, 'drivers')),
      lap: int(o, 'lap'),
      text: text,
      penalty: str(o, 'penalty')
    };
  }

  function radio(o) {
    var number = int(o, 'num');
    var url = str(o, 'url');
    if (number == null || url == null) { return null; }
    var t = instant(str(o, 't'));
    return { t: t, num: number, url: url, key: t + '|' + number };
  }

  function strategy(o) {
    var k = obj(o, 'k');
    var p = obj(o, 'pitLoss');
    var samples = obj(p, 'samples');
    return {
      refLap: num(o, 'refLap'),
      ringLap: num(o, 'ringLap'),
      kVsc: num(k, 'vsc'),
      kSc: num(k, 'sc'),
      pitLoss: p ? {
        green: num(p, 'green'),
        vsc: num(p, 'vsc'),
        sc: num(p, 'sc'),
        now: num(p, 'now'),
        seed: num(p, 'seed'),
        basis: str(p, 'basis'),
        samplesGreen: int(samples, 'green') || 0,
        samplesVsc: int(samples, 'vsc') || 0,
        samplesSc: int(samples, 'sc') || 0
      } : null,
      lane: num(o, 'lane'),
      stationary: num(o, 'stationary')
    };
  }

  function notNull(v) {
    return v != null;
  }

  function frame(input) {
    var o = json(input) || {};
    var b = obj(o, 'best');
    var w = obj(o, 'weather');
    var r = obj(o, 'replay');
    var drivers = objects(arr(o, 'drivers')).map(driver).filter(notNull);
    var byNumber = {};
    drivers.forEach(function (d) { byNumber[d.num] = d; });
    var f = {
      live: bool(o, 'live'),
      generated: instant(str(o, 'generated')),
      stale: bool(o, 'stale'),
      reason: str(o, 'reason'),
      error: str(o, 'error'),
      session: obj(o, 'session') ? session(o.session) : null,
      flag: obj(o, 'flag') ? flag(o.flag) : null,
      lap: int(obj(o, 'lap'), 'current'),
      best: b ? { lap: num(b, 'lap'), num: int(b, 'num'), sectors: doubles(arr(b, 'sectors')) } : null,
      weather: w ? {
        air: num(w, 'air'),
        track: num(w, 'track'),
        humidity: num(w, 'humidity'),
        wind: num(w, 'wind'),
        windDir: num(w, 'windDir'),
        pressure: num(w, 'pressure'),
        rain: bool(w, 'rain')
      } : null,
      drivers: drivers,
      byNumber: byNumber,
      events: objects(arr(o, 'events')).map(event).filter(notNull),
      // Null when the server sends no radio key at all: an older build, not "no clips".
      radio: Array.isArray(o.radio) ? objects(o.radio).map(radio).filter(notNull) : null,
      strategy: obj(o, 'strategy') ? strategy(o.strategy) : null,
      replay: r ? {
        sessionKey: int(r, 'session_key'),
        at: instant(str(r, 'at')),
        start: instant(str(r, 'start')),
        end: instant(str(r, 'end'))
      } : null
    };
    /** The race instant this frame stands for: the replay playhead, or the server's clock. */
    f.raceAt = f.replay && f.replay.at != null ? f.replay.at : f.generated;
    return f;
  }

  /** The whole of one past session, for the replay scrubber. Oldest first. */
  function timeline(input) {
    var o = json(input) || {};
    if (str(o, 'error')) { throw new Error(o.error); }
    if (!obj(o, 'session')) { throw new Error('No session in timeline'); }
    var start = instant(str(o, 'start'));
    var end = instant(str(o, 'end'));
    if (start == null) { throw new Error('No start in timeline'); }
    if (end == null) { throw new Error('No end in timeline'); }
    return {
      session: session(o.session),
      start: start,
      end: end,
      periods: objects(arr(o, 'periods')).map(function (p) {
        var state = P.Format.flagState(str(p, 'state'));
        var from = instant(str(p, 'from'));
        return state && from != null ? { state: state, from: from, to: instant(str(p, 'to')) } : null;
      }).filter(notNull),
      events: objects(arr(o, 'events')).map(event).filter(notNull)
    };
  }

  /** One cars event from /f1/stream: {t, c: [[num, x, y]…], tel: [[num, speed, throttle, brake, gear, rpm]…]}. */
  function cars(input) {
    var o = json(input) || {};
    var positions = {};
    var telemetry = {};
    arr(o, 'c').forEach(function (row) {
      var n = numberAt(row, 0);
      var x = numberAt(row, 1);
      var y = numberAt(row, 2);
      if (n != null && x != null && y != null) { positions[Math.trunc(n)] = [x, y]; }
    });
    arr(o, 'tel').forEach(function (row) {
      var n = numberAt(row, 0);
      if (n == null) { return; }
      function at(i) {
        var v = numberAt(row, i);
        return v == null ? null : Math.trunc(v);
      }
      telemetry[Math.trunc(n)] = { speed: at(1), throttle: at(2), brake: at(3), gear: at(4), rpm: at(5) };
    });
    return { at: instant(str(o, 't')), positions: positions, telemetry: telemetry };
  }

  function sessions(input) {
    return objects(arr(json(input) || {}, 'sessions')).map(session);
  }

  P.Parse = {
    instant: instant,
    frame: frame,
    session: session,
    timeline: timeline,
    cars: cars,
    sessions: sessions
  };
}());
