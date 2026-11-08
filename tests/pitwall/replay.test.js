/*
 * Replay on a virtual clock. The app has no unit tests for ReplayFeed itself, so these
 * pin the rules its comments state: one request in flight with the latest instant
 * waiting, replies from an earlier pick dropped, play paced to the wall clock at the chosen
 * speed, a speed change that doesn't leap, a hand on the playhead that stops play, and the
 * session's bounds. Then the jumps, from the app's ReplayBar.
 */
(function () {
  var ReplayFeed = Pitwall.ReplayFeed;
  var timeline = Pitwall.Parse.timeline(fixture('timeline-11388.json'));
  var sessions = Pitwall.Parse.sessions(fixture('sessions-2026.json'));
  var race = sessions.filter(function (s) { return s.key === 11388; })[0];

  /* A source that answers after a network's worth of delay, and records what it was asked. */
  function harness(options) {
    var o = options || {};
    var h = { time: new FakeTime(), asked: [], timelines: 0 };
    function later(ms, value, fail) {
      return new Promise(function (resolve, reject) {
        h.time.setTimer(function () { if (fail) { reject(new Error(fail)); } else { resolve(value); } }, ms);
      });
    }
    h.replay = new ReplayFeed({
      source: {
        sessions: function () { return later(100, sessions); },
        timeline: function (key) {
          h.timelines += 1;
          return later(100, key === 11388 ? timeline : { session: { key: key, name: 'Race' }, start: 0, end: 3600000, periods: [], events: [] });
        },
        frame: function (key, at) {
          h.asked.push([key, at]);
          return later(o.frameMs || 200, { live: true, generated: at, replay: { sessionKey: key, at: at } });
        }
      },
      clock: h.time.clock,
      setTimer: h.time.setTimer,
      clearTimer: h.time.clearTimer
    });
    h.time.now = Date.UTC(2026, 10, 6, 20, 0, 0);
    return h;
  }

  test('a pick loads the timeline, then the first frame from the start', function () {
    var h = harness();
    h.replay.pick(race);
    // This fixture is from before the server named meetings, so the event is the circuit.
    eq(h.replay.state.status, 'Loading Singapore · Race…');
    h.time.advance(150);
    eq(h.replay.state.status, 'Loading positions — the first frame takes a few seconds');
    eq(h.replay.state.at, timeline.start);
    no(h.replay.state.ready);
    h.time.advance(300);
    ok(h.replay.state.ready);
    isNull(h.replay.state.status);
    eq(h.replay.state.frame.generated, timeline.start);
  });

  test('a session known only by its key takes its name from the timeline', function () {
    var h = harness();
    h.replay.pick({ key: 11388 });
    h.time.advance(150);
    eq(h.replay.state.session.name, 'Race');
    eq(h.replay.state.session.key, 11388);
  });

  test('one request in flight; a fast scrub lands where it stopped', function () {
    var h = harness();
    h.replay.pick(race);
    h.time.advance(400);
    var asked = h.asked.length;
    h.replay.scrub(timeline.start + 60000);
    h.replay.scrub(timeline.start + 120000);
    h.replay.scrub(timeline.start + 180000);
    // The first went out; the two after it replaced each other while it was in flight.
    eq(h.asked.length, asked + 1);
    h.time.advance(250);
    eq(h.asked.length, asked + 2);
    eq(h.asked[h.asked.length - 1][1], timeline.start + 180000);
    h.time.advance(250);
    eq(h.replay.state.frame.generated, timeline.start + 180000);
  });

  test('a reply for an earlier pick is dropped', function () {
    var h = harness({ frameMs: 1000 });
    h.replay.pick(race);
    h.time.advance(150);
    // The first frame of 11388 is on its way when another session is picked.
    h.replay.pick({ key: 99, name: 'Practice 1' });
    h.time.advance(2000);
    eq(h.replay.state.session.key, 99);
    eq(h.replay.state.frame.replay.sessionKey, 99);
  });

  test('play is paced to the wall clock at the chosen speed', function () {
    var h = harness();
    h.replay.pick(race);
    h.time.advance(400);
    h.replay.setSpeed(10);
    h.replay.play();
    ok(h.replay.state.playing);
    h.time.advance(10000);
    // Ten seconds of wall time at 10× is about a hundred seconds of race, give or take a frame.
    near(h.replay.state.at - timeline.start, 100000, 3000);
  });

  test('a speed change mid-play does not leap', function () {
    var h = harness();
    h.replay.pick(race);
    h.time.advance(400);
    h.replay.setSpeed(1);
    h.replay.play();
    h.time.advance(5000);
    var before = h.replay.state.at;
    h.replay.setSpeed(60);
    h.time.advance(300);
    // At most a frame's worth on from where it was, at the new speed: no jump to 60× of the time already played.
    ok(h.replay.state.at - before < 60 * 600, 'moved ' + (h.replay.state.at - before));
    h.time.advance(5000);
    near(h.replay.state.at - before, 60 * 5300, 60 * 700);
  });

  test('a hand on the playhead stops play; nudges keep to the session', function () {
    var h = harness();
    h.replay.pick(race);
    h.time.advance(400);
    h.replay.play();
    h.replay.nudge(30);
    no(h.replay.state.playing);
    eq(h.replay.state.at, timeline.start + 30000);
    h.replay.nudge(-120);
    eq(h.replay.state.at, timeline.start);
    h.replay.scrub(timeline.end + 600000);
    eq(h.replay.state.at, timeline.end);
  });

  test('play stops at the end', function () {
    var h = harness();
    h.replay.pick(race);
    h.time.advance(400);
    h.replay.scrub(timeline.end - 10000);
    h.time.advance(400);
    h.replay.setSpeed(60);
    h.replay.play();
    h.time.advance(2000);
    no(h.replay.state.playing);
    eq(h.replay.state.at, timeline.end);
    // And won't start again from the very end.
    h.replay.play();
    no(h.replay.state.playing);
  });

  test('play waits for the first frame', function () {
    var h = harness();
    h.replay.pick(race);
    h.time.advance(150);
    h.replay.play();
    no(h.replay.state.playing);
  });

  test('the picker lists only sessions that have started', function () {
    var h = harness();
    h.time.now = Date.UTC(2026, 9, 1);
    h.replay.loadYear(2026);
    isNull(h.replay.state.sessions);
    h.time.advance(200);
    ok(h.replay.state.sessions.length > 0);
    ok(h.replay.state.sessions.length < sessions.length, 'some of 2026 is still to come on 1 Oct');
    ok(h.replay.state.sessions.every(function (s) { return s.start == null || s.start <= h.time.now; }));
  });

  test('jumps: one per spell of a flag', function () {
    var t = 1800000000000;
    var jumps = Pitwall.Replay.jumps({
      periods: [
        { state: 'GREEN', from: t, to: t + 60000 },
        { state: 'YELLOW', from: t + 60000, to: t + 90000 },
        { state: 'GREEN', from: t + 90000, to: t + 100000 },
        // The same yellow back within two minutes: the same spell.
        { state: 'YELLOW', from: t + 100000, to: t + 130000 },
        { state: 'SAFETY_CAR', from: t + 300000, to: t + 600000 },
        // A yellow well after the first: a jump of its own.
        { state: 'YELLOW', from: t + 900000, to: t + 920000 }
      ]
    });
    eq(jumps.map(function (j) { return j.state; }), ['YELLOW', 'SAFETY_CAR', 'YELLOW']);
    ok(Pitwall.Replay.jumps(timeline).some(function (j) { return j.state === 'SAFETY_CAR'; }));
  });

  test('jumps: none from before the session starts', function () {
    var t = 1800000000000;
    // The 2026 Mexico City race's timeline carried a yellow from more than two hours before its start.
    var jumps = Pitwall.Replay.jumps({
      start: t,
      end: t + 7200000,
      periods: [
        { state: 'YELLOW', from: t - 8000000, to: t - 7900000 },
        { state: 'GREEN', from: t, to: t + 240000 },
        { state: 'YELLOW', from: t + 240000, to: t + 260000 }
      ]
    });
    eq(jumps.map(function (j) { return j.from; }), [t + 240000]);
  });
}());
