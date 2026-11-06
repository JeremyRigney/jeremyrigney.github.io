/*
 * SseTest and LiveFeedStreamTest from Pocket Pitwall: the stream's framing, and the stream
 * and its backup — which is used when, and that both go through the one delay. Then the
 * web's own addition, the background mode.
 */
(function () {
  var Sse = Pitwall.Sse;
  var LiveFeed = Pitwall.LiveFeed;

  function events(text) {
    var parser = new Sse.Parser();
    return text.split('\n').map(function (line) { return parser.feed(line); }).filter(Boolean);
  }

  test('frames events and ignores the rest', function () {
    var got = events(
      'retry: 3000\n\n' +
      'event: cars\ndata: {"t":"2026-10-04T09:10:00Z","c":[[1,10,20]],"tel":[]}\n\n' +
      ': a comment\n' +
      'event: ping\ndata: {}\n\n' +
      'event: bye\ndata: {}\r\n\r\n'
    );
    eq(got.map(function (e) { return e[0]; }), ['cars', 'ping', 'bye']);
    eq(got[2][1], '{}');
  });

  test('joins multi-line data', function () {
    var got = events('event: frame\ndata: {"a":\ndata: 1}\n\n');
    eq(got.length, 1);
    eq(got[0][1], '{"a":\n1}');
  });

  test('decodes the events the wall uses', function () {
    eq(Sse.decode('ping', '{}').type, 'ping');
    eq(Sse.decode('bye', '{}').type, 'bye');
    isNull(Sse.decode('something-new', '{}'));
    var idle = Sse.decode('idle', '{"live":false,"reason":"no session running"}');
    eq(idle.type, 'idle');
    eq(idle.frame.reason, 'no session running');
  });

  test('cars carry positions and telemetry', function () {
    var batch = Pitwall.Parse.cars('{"t":"2026-10-04T09:10:00.25+00:00","c":[[1,1579,-956],[44,-20.5,7]],' +
      '"tel":[[1,287,100,0,7,11250],[44,92,0,100,3,null]]}');
    eq(batch.positions[1], [1579, -956]);
    eq(batch.positions[44], [-20.5, 7]);
    var ver = batch.telemetry[1];
    eq([ver.speed, ver.throttle, ver.brake, ver.gear, ver.rpm], [287, 100, 0, 7, 11250]);
    eq(batch.telemetry[44].brake, 100);
    isNull(batch.telemetry[44].rpm);
    eq(batch.at, Date.UTC(2026, 9, 4, 9, 10, 0, 250));
  });

  test('chunks split anywhere still frame whole events', function () {
    var parser = new Sse.Parser();
    var text = 'event: frame\ndata: {"live":true}\n\nevent: ping\ndata: {}\r\n\r\n';
    var got = [];
    for (var i = 0; i < text.length; i += 3) {
      got = got.concat(parser.push(text.slice(i, i + 3)));
    }
    eq(got, [['frame', '{"live":true}'], ['ping', '{}']]);
  });

  // ---------- The stream and its backup ----------

  function live(second) {
    return { live: true, generated: second * 1000, stale: false };
  }

  var idle = { live: false, generated: null, reason: 'no session running' };
  var batch = { at: 1000, positions: { 1: [10, 20] }, telemetry: { 1: { speed: 287, throttle: 100, brake: 0, gear: 7, rpm: 11250 } } };

  /* stream(handlers, attempt) opens one go at the stream. fetch defaults to a live frame. */
  function harness(stream, options) {
    var o = options || {};
    var h = { time: new FakeTime(), attempts: 0, polls: 0 };
    h.feed = new LiveFeed({
      fetch: o.fetch ? function () { h.polls += 1; return Promise.resolve().then(o.fetch); } : function () {
        h.polls += 1;
        return Promise.resolve(live(100 + h.polls));
      },
      stream: stream ? function (handlers) {
        h.attempts += 1;
        return stream(handlers, h.attempts, h.time);
      } : null,
      clock: h.time.clock,
      setTimer: h.time.setTimer,
      clearTimer: h.time.clearTimer,
      initialDelay: o.delay
    });
    h.feed.run();
    return h;
  }

  test('frames and cars share the delay', function () {
    var h = harness(function (handlers, n, time) {
      return fakeStream(time, handlers, [{ type: 'frame', frame: live(1) }, { type: 'cars', batch: batch }]);
    }, { delay: 10 });
    h.time.advance(5000);
    eq(h.feed.state.transport, 'STREAM');
    isNull(h.feed.state.frame);
    no(h.feed.cars.fresh);

    h.time.advance(5200);
    eq(h.feed.state.frame.generated, 1000);
    ok(h.feed.cars.fresh);
    eq(h.feed.cars.positions[1], [10, 20]);
    eq(h.feed.cars.telemetry[1].speed, 287);
    eq(h.polls, 0);
  });

  test('a refused stream falls back to polling and is retried', function () {
    var h = harness(function (handlers, n, time) { return fakeStream(time, handlers, [], 'error'); });
    h.time.advance(2000);
    eq(h.attempts, 1);
    eq(h.feed.state.transport, 'POLL');
    eq(h.feed.state.status, 'LIVE');
    ok(h.polls >= 1, 'polls ' + h.polls);

    h.time.advance(28000);
    eq(h.attempts, 1);
    h.time.advance(3000);
    eq(h.attempts, 2);
  });

  test('nothing on track waits for a poll to show a session', function () {
    var replies = [idle, idle, live(5)];
    var h = harness(function (handlers, n, time) {
      return n === 1
        ? fakeStream(time, handlers, [{ type: 'idle', frame: idle }], 'complete')
        : fakeStream(time, handlers, [{ type: 'frame', frame: live(7) }]);
    }, { fetch: function () { return replies.length ? replies.shift() : live(6); } });
    h.time.advance(2000);
    eq(h.attempts, 1);
    eq(h.feed.state.status, 'NO_SESSION');

    // Idle polls are a minute apart; the third finds a session and the stream is tried again.
    h.time.advance(119000);
    eq(h.attempts, 1);
    h.time.advance(3000);
    eq(h.attempts, 2);
    eq(h.feed.state.transport, 'STREAM');
  });

  test('a stream and a poll that disagree do not hammer the server', function () {
    // The stream says nothing's on; polls say a session is. Retries stay STREAM_MIN_GAP apart.
    var h = harness(function (handlers, n, time) {
      return fakeStream(time, handlers, [{ type: 'idle', frame: idle }], 'complete');
    });
    h.time.advance(30000);
    ok(h.attempts >= 5 && h.attempts <= 7, 'attempts ' + h.attempts);
  });

  test('bye reconnects at once without polling', function () {
    var h = harness(function (handlers, n, time) {
      return fakeStream(time, handlers, [{ type: 'frame', frame: live(1) }, { type: 'bye' }], 'complete');
    }, { fetch: function () { throw new Error('should not poll'); } });
    h.time.advance(3500);
    ok(h.attempts >= 3, 'attempts ' + h.attempts);
    eq(h.polls, 0);
  });

  test('a silent stream is dropped for polling', function () {
    var h = harness(function (handlers, n, time) {
      return fakeStream(time, handlers, [{ type: 'frame', frame: live(1) }]);
    });
    h.time.advance(15000);
    eq(h.feed.state.transport, 'STREAM');
    eq(h.polls, 0);

    h.time.advance(8000);
    eq(h.feed.state.transport, 'POLL');
    ok(h.polls >= 1, 'polls ' + h.polls);
  });

  test('pings keep a quiet stream alive', function () {
    var h = harness(function (handlers, n, time) {
      return fakeStream(time, handlers, [{ type: 'frame', frame: live(1) }], null,
        [[15000, { type: 'ping' }], [30000, { type: 'ping' }], [45000, { type: 'ping' }], [60000, { type: 'ping' }]]);
    });
    h.time.advance(59000);
    eq(h.feed.state.transport, 'STREAM');
    eq(h.polls, 0);
  });

  test('cars go stale when the stream stops delivering', function () {
    var h = harness(function (handlers, n, time) {
      return fakeStream(time, handlers, [{ type: 'cars', batch: batch }]);
    });
    h.time.advance(1000);
    ok(h.feed.cars.fresh);
    h.time.advance(3500);
    no(h.feed.cars.fresh);
  });

  test('the car rate is measured while streaming', function () {
    var h = harness(function (handlers, n, time) {
      var later = [];
      for (var t = 200; t < 9000; t += 200) { later.push([t, { type: 'cars', batch: batch }]); }
      return fakeStream(time, handlers, [{ type: 'frame', frame: live(1) }], null, later);
    });
    h.time.advance(8500);
    near(h.feed.state.carRate, 5, 0.3);
  });

  // ---------- The web's own: stopped for replay, and out of sight ----------

  test('stopped and started again, it runs one loop, not two', function () {
    var h = harness(null, { fetch: function () { return live(1); } });
    h.time.advance(100);
    h.feed.stop();
    h.feed.run();
    var polls = h.polls;
    h.time.advance(15000);
    // One loop polls about ten times in 15 s; two would poll about twenty.
    ok(h.polls - polls <= 11, 'polls ' + (h.polls - polls));
  });

  test('out of sight, the stream is given up and polls slow down', function () {
    var h = harness(function (handlers, n, time) {
      return fakeStream(time, handlers, [{ type: 'frame', frame: live(1) }]);
    });
    h.time.advance(2000);
    eq(h.feed.state.transport, 'STREAM');

    h.feed.setBackground(true);
    h.time.advance(2000);
    eq(h.feed.state.transport, 'POLL');
    var polls = h.polls;
    h.time.advance(59000);
    // A poll every 30 s rather than every 1.5 s, and no new go at the stream.
    ok(h.polls - polls <= 2, 'polls ' + (h.polls - polls));
    eq(h.attempts, 1);

    // Back in sight: the stream at once.
    h.feed.setBackground(false);
    h.time.advance(100);
    eq(h.attempts, 2);
    h.time.advance(1000);
    eq(h.feed.state.transport, 'STREAM');
  });
}());
