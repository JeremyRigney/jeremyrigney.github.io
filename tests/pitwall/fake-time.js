/*
 * A virtual clock for the feed's tests: timers fire in time order as the clock is advanced,
 * with the promise jobs each one starts run to completion before the next. Like
 * kotlinx.coroutines.test's advanceTimeBy, which the app's own tests use, advance(ms) runs
 * what is due strictly before the new time, then stops the clock there.
 */
function FakeTime() {
  this.now = 0;
  this.timers = [];
  this.seq = 0;
  var self = this;
  this.clock = function () { return self.now; };
  this.setTimer = function (fn, ms) {
    self.seq += 1;
    self.timers.push({ id: self.seq, due: self.now + Math.max(0, ms || 0), fn: fn });
    return self.seq;
  };
  this.clearTimer = function (id) {
    self.timers = self.timers.filter(function (t) { return t.id !== id; });
  };
}

FakeTime.prototype.advance = function (ms) {
  var target = this.now + ms;
  drainMicrotasks();
  for (var guard = 0; guard < 1000000; guard++) {
    var next = null;
    this.timers.forEach(function (t) {
      if (t.due < target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) { next = t; }
    });
    if (!next) { break; }
    this.timers.splice(this.timers.indexOf(next), 1);
    this.now = next.due;
    next.fn();
    drainMicrotasks();
  }
  this.now = target;
};

/*
 * A stand-in for /f1/stream: sends its events one after another as soon as it's opened,
 * then closes cleanly (end: 'complete'), fails (end: 'error'), or stays open until closed.
 * later: [[ms, event], …] sends more while it stays open, as pings do.
 */
function fakeStream(time, handlers, events, end, later) {
  var closed = false;
  time.setTimer(function () {
    events.forEach(function (ev) { if (!closed) { handlers.onEvent(ev); } });
    if (closed) { return; }
    if (end === 'complete') { handlers.onEnd(null); }
    if (end === 'error') { handlers.onEnd(new Error('HTTP 503')); }
  }, 0);
  (later || []).forEach(function (step) {
    time.setTimer(function () { if (!closed) { handlers.onEvent(step[1]); } }, step[0]);
  });
  return { close: function () { closed = true; } };
}
