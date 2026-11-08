/*
 * AlertsTest, AnnouncerTest and WeatherTest from Pocket Pitwall, then the team radio queue,
 * which the app tests only through its UI: these pin the rules Radio.kt's comments state.
 */
(function () {
  var Alerts = Pitwall.Alerts;
  var Announcer = Pitwall.Announcer;
  var WeatherHistory = Pitwall.WeatherHistory;
  var Radio = Pitwall.Radio;
  var session = { key: 1, name: 'Race', type: 'Race', circuit: 'Singapore', circuitKey: 61 };

  // ---------- AlertsTest ----------

  function event(second, severity, type) {
    return { t: second * 1000, type: type || 'penalty', severity: severity || 'high', drivers: [], lap: 1, text: 'CAR 1 - 5 SECOND TIME PENALTY' };
  }

  function frame(at) {
    var events = Array.prototype.slice.call(arguments, 1).sort(function (a, b) { return b.t - a.t; });
    return { live: true, generated: at * 1000, raceAt: at * 1000, session: session, events: events, drivers: [] };
  }

  test('the first frame primes quietly', function () {
    var alerts = new Alerts();
    isNull(alerts.sync(frame(100, event(50), event(60)), false));
    eq(alerts.unread(frame(100, event(50), event(60))), 0);
  });

  test('a new penalty is shouted and counted', function () {
    var alerts = new Alerts();
    alerts.sync(frame(100, event(50)), false);
    var next = frame(105, event(50), event(103), event(104, 'low', 'deletion'));
    // The penalty is shouted; the deletion only counted.
    eq(alerts.sync(next, false).t, 103000);
    eq(alerts.unread(next), 2);
    alerts.markRead(next);
    eq(alerts.unread(next), 0);
    // The same frame again is not news twice.
    isNull(alerts.sync(next, false));
  });

  test('a rewind is not news', function () {
    var alerts = new Alerts();
    alerts.sync(frame(100, event(50)), false);
    alerts.sync(frame(200, event(50), event(150)), false);
    // Scrub back before 150 and play through it again: it's news again, as it was the first time.
    isNull(alerts.sync(frame(120, event(50)), false));
    eq(alerts.sync(frame(200, event(50), event(150)), false).t, 150000);
  });

  test('the feed open keeps the count at zero', function () {
    var alerts = new Alerts();
    alerts.sync(frame(100, event(50)), true);
    var next = frame(105, event(50), event(103));
    alerts.sync(next, true);
    eq(alerts.unread(next), 0);
  });

  // ---------- AnnouncerTest ----------

  function flagFrame(second, state, ending) {
    return { live: true, generated: second * 1000, raceAt: second * 1000, session: session, flag: { state: state, ending: !!ending, sectors: [] } };
  }

  function kind(a) {
    return a ? a.kind : null;
  }

  test('the first frame is quiet, even under a safety car', function () {
    isNull(new Announcer().next(flagFrame(100, 'SAFETY_CAR')));
  });

  test('a safety car from start to finish', function () {
    var a = new Announcer();
    a.next(flagFrame(100, 'GREEN'));
    eq(kind(a.next(flagFrame(110, 'SAFETY_CAR'))), 'SAFETY_CAR');
    eq(Announcer.words('SAFETY_CAR', 'SAFETY_CAR'), 'Safety car alert');
    isNull(a.next(flagFrame(112, 'SAFETY_CAR')));
    var coming = a.next(flagFrame(300, 'SAFETY_CAR', true));
    eq(kind(coming), 'ENDING');
    eq(coming.words, 'Safety car in this lap');
    eq(kind(a.next(flagFrame(400, 'GREEN'))), 'GREEN');
  });

  test('a flickering yellow is said once', function () {
    var a = new Announcer();
    a.next(flagFrame(100, 'GREEN'));
    eq(kind(a.next(flagFrame(110, 'YELLOW'))), 'YELLOW');
    // Clears, then comes back within thirty seconds: no second announcement, and no "green
    // flag" for a local yellow.
    isNull(a.next(flagFrame(120, 'GREEN')));
    isNull(a.next(flagFrame(125, 'YELLOW')));
    a.next(flagFrame(130, 'GREEN'));
    eq(kind(a.next(flagFrame(200, 'YELLOW'))), 'YELLOW');
  });

  test('not allowed still tracks the state', function () {
    var a = new Announcer();
    a.next(flagFrame(100, 'GREEN'));
    isNull(a.next(flagFrame(110, 'VSC'), false));
    // Already in the VSC: nothing to say on the next frame either.
    isNull(a.next(flagFrame(112, 'VSC'), true));
  });

  test('a rewind primes again', function () {
    var a = new Announcer();
    a.next(flagFrame(100, 'GREEN'));
    a.next(flagFrame(200, 'RED'));
    isNull(a.next(flagFrame(150, 'GREEN')));
    eq(kind(a.next(flagFrame(200, 'RED'))), 'RED');
  });

  test('the real Singapore safety car', function () {
    var a = new Announcer();
    a.next(Pitwall.Parse.frame(fixture('frame-race-green.json')));
    // The fixture under the safety car is later in the same race.
    eq(kind(a.next(Pitwall.Parse.frame(fixture('frame-race-sc.json')))), 'SAFETY_CAR');
  });

  // ---------- WeatherTest ----------

  function weatherFrame(minute, track, rain) {
    return { live: true, generated: minute * 60000, raceAt: minute * 60000, session: session, weather: { air: 30, track: track, rain: !!rain } };
  }

  test('records and reports the trend', function () {
    var h = new WeatherHistory();
    for (var m = 0; m <= 40; m++) { h.add(weatherFrame(m, 38 + m * 0.1)); }
    var t = h.trend();
    eq(t.minutes, 30);
    near(t.degrees, 3, 1e-6);
  });

  test('too short for a trend', function () {
    var h = new WeatherHistory();
    h.add(weatherFrame(0, 40));
    h.add(weatherFrame(2, 41));
    isNull(h.trend());
  });

  test('a rewind drops what lies ahead', function () {
    var h = new WeatherHistory();
    for (var m = 0; m <= 20; m++) { h.add(weatherFrame(m, 40)); }
    h.add(weatherFrame(10, 40));
    ok(h.points.every(function (p) { return p.at <= 10 * 60000; }));
  });

  test('rain starting and stopping', function () {
    var a = new Announcer();
    isNull(a.rain(weatherFrame(0, 40, false)));
    eq(kind(a.rain(weatherFrame(1, 40, true))), 'RAIN');
    eq(Announcer.words('RAIN', null), 'Rain reported');
    isNull(a.rain(weatherFrame(2, 40, true)));
    eq(kind(a.rain(weatherFrame(3, 40, false))), 'DRY');
  });

  test('opening in the rain says nothing', function () {
    isNull(new Announcer().rain(weatherFrame(0, 40, true)));
  });

  // ---------- Team radio ----------

  function clip(second, num) {
    return { t: second * 1000, num: num, url: 'https://livetiming.formula1.com/static/' + num + '-' + second + '.mp3', key: (second * 1000) + '|' + num };
  }

  function radioFrame(at) {
    var clips = Array.prototype.slice.call(arguments, 1).sort(function (a, b) { return b.t - a.t; });
    return { live: true, raceAt: at * 1000, session: session, radio: clips };
  }

  function harness(follow) {
    var h = { played: [], stopped: 0, done: null, time: new FakeTime(), held: 0, released: 0 };
    h.radio = new Radio({
      player: {
        play: function (url, done) { h.played.push(url); h.done = done; },
        stop: function () { h.stopped += 1; }
      },
      setTimer: h.time.setTimer,
      clearTimer: h.time.clearTimer,
      follow: function () { return new Set(follow || [4]); },
      hold: function () { h.held += 1; return true; },
      release: function () { h.released += 1; }
    });
    return h;
  }

  test('radio: the first frame primes; a followed driver’s new clip plays', function () {
    var h = harness([4]);
    h.radio.sync(radioFrame(100, clip(90, 4)), true);
    eq(h.played.length, 0);
    h.radio.sync(radioFrame(110, clip(90, 4), clip(105, 4), clip(106, 1)), true);
    // Only the followed driver's, and only the new one.
    eq(h.played.length, 1);
    ok(/4-105\.mp3$/.test(h.played[0]));
  });

  test('radio: no autoplay in a fast replay, or with the sound off', function () {
    var h = harness([4]);
    h.radio.sync(radioFrame(100), true);
    h.radio.sync(radioFrame(110, clip(105, 4)), false);
    eq(h.played.length, 0);
  });

  test('radio: one at a time, at most three waiting, oldest first', function () {
    var h = harness([4]);
    h.radio.sync(radioFrame(100), true);
    h.radio.sync(radioFrame(120, clip(101, 4), clip(102, 4), clip(103, 4), clip(104, 4), clip(105, 4)), true);
    eq(h.played.length, 1);
    ok(/4-101\.mp3$/.test(h.played[0]));
    // Five arrived: one plays, three wait, the oldest waiting one was dropped.
    eq(h.radio.queue.map(function (c) { return c.t / 1000; }), [103, 104, 105]);
    h.done();
    ok(/4-103\.mp3$/.test(h.played[1]));
  });

  test('radio: a stale clip is skipped', function () {
    var h = harness([4]);
    h.radio.sync(radioFrame(100), true);
    // Said more than two minutes before the moment on screen.
    h.radio.sync(radioFrame(300, clip(150, 4)), true);
    eq(h.played.length, 0);
  });

  test('radio: a click preempts, pauses the replay, and doesn’t drain the queue', function () {
    var h = harness([4]);
    h.radio.sync(radioFrame(100), true);
    h.radio.sync(radioFrame(120, clip(101, 4), clip(102, 4)), true);
    h.radio.playClip(clip(110, 16));
    eq(h.stopped, 1);
    eq(h.held, 1);
    eq(h.radio.queue.length, 0);
    h.done();
    eq(h.released, 1);
    eq(h.played.length, 2);
  });

  test('radio: a clip that never ends is let go after a minute', function () {
    var h = harness([4]);
    h.radio.sync(radioFrame(100), true);
    h.radio.sync(radioFrame(110, clip(105, 4)), true);
    notNull(h.radio.playing);
    h.time.advance(61000);
    isNull(h.radio.playing);
  });

  test('radio: only Formula 1’s own clips', function () {
    eq(Radio.safeUrl('http://livetiming.formula1.com/static/a.mp3'), 'https://livetiming.formula1.com/static/a.mp3');
    isNull(Radio.safeUrl('https://example.com/a.mp3'));
    isNull(Radio.safeUrl(null));
  });
}());
