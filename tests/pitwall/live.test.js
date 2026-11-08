/* LiveFeedTest from Pocket Pitwall: polling, the delay buffer and failures. */
(function () {
  var LiveFeed = Pitwall.LiveFeed;

  function harness(initialDelay) {
    var h = { now: 0, replies: [] };
    h.feed = new LiveFeed({
      fetch: function () {
        var reply = h.replies.shift();
        return Promise.resolve().then(reply);
      },
      clock: function () { return h.now; },
      initialDelay: initialDelay
    });
    return h;
  }

  function live(second) {
    return { live: true, generated: second * 1000, stale: false };
  }

  var idle = { live: false, generated: null, reason: 'no session running' };

  test('draws at once with no delay', async function () {
    var h = harness();
    h.replies.push(function () { return live(1); });
    eq(await h.feed.poll(), LiveFeed.POLL_LIVE);
    eq(h.feed.state.status, 'LIVE');
    eq(h.feed.state.frame.generated, 1000);
  });

  test('the delay holds frames back, then draws only the newest due', async function () {
    var h = harness();
    h.feed.setDelay(10);
    h.replies.push(function () { return live(1); });
    await h.feed.poll();
    isNull(h.feed.state.frame);

    h.now = 1500; h.replies.push(function () { return live(2); }); await h.feed.poll();
    h.now = 3000; h.replies.push(function () { return live(3); }); await h.feed.poll();
    h.now = 11600; h.feed.flush();
    // Frames stamped at 0 and 1.5 s are due; the newest of them is drawn.
    eq(h.feed.state.frame.generated, 2000);

    // Lowering the delay catches up immediately.
    h.feed.setDelay(0);
    eq(h.feed.state.frame.generated, 3000);
  });

  test('starts with the remembered delay', async function () {
    var h = harness(23);
    eq(h.feed.state.delaySeconds, 23);
    h.replies.push(function () { return live(1); });
    await h.feed.poll();
    // Held back by the remembered delay from the very first frame.
    isNull(h.feed.state.frame);
    eq(harness(90).feed.state.delaySeconds, LiveFeed.DELAY_MAX);
  });

  test('the delay is clamped', function () {
    var h = harness();
    h.feed.setDelay(90);
    eq(h.feed.state.delaySeconds, LiveFeed.DELAY_MAX);
    h.feed.setDelay(-4);
    eq(h.feed.state.delaySeconds, 0);
  });

  test('idle before and after a session', async function () {
    var h = harness();
    h.replies.push(function () { return idle; });
    eq(await h.feed.poll(), LiveFeed.POLL_IDLE);
    eq(h.feed.state.status, 'NO_SESSION');

    h.replies.push(function () { return live(5); });
    await h.feed.poll();
    h.replies.push(function () { return idle; });
    await h.feed.poll();
    // Ended: say so, and keep the final order on screen.
    eq(h.feed.state.status, 'SESSION_OVER');
    eq(h.feed.state.frame.generated, 5000);
  });

  test('failures keep the last frame', async function () {
    var h = harness();
    h.replies.push(function () { return live(1); });
    await h.feed.poll();
    h.replies.push(function () { throw new Error('offline'); });
    eq(await h.feed.poll(), LiveFeed.POLL_ERROR);
    ok(h.feed.state.failing);
    eq(h.feed.state.status, 'LIVE');

    // A 502 body is a failure too, not the end of the session.
    h.replies.push(function () { return { live: false, generated: null, error: 'upstream' }; });
    eq(await h.feed.poll(), LiveFeed.POLL_ERROR);
    eq(h.feed.state.status, 'LIVE');

    h.replies.push(function () { return live(2); });
    await h.feed.poll();
    eq(h.feed.state.failing, false);
  });
}());
