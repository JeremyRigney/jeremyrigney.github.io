/*
 * Pitwall: live mode — the server's frames, held back by the chosen delay before they are
 * drawn. A port of Pocket Pitwall's wall/LiveFeed.kt.
 *
 * Frames arrive one of two ways. The stream (/f1/stream) pushes each frame as it changes
 * and, between them, every car's position and telemetry several times a second. Polling
 * (/f1/live every 1.5 s) is the backup: used whenever the stream can't be had — refused,
 * dropped, silent, or nothing on track — and left again as soon as it can.
 *
 * The delay exists because the timing feed runs ahead of every broadcast of it: a wall fed
 * straight from the feed announces the overtake before you see it. Everything is stamped on
 * arrival, not by its own time, so "20s" means twenty seconds behind what this browser
 * knows — immune to clock skew and to however far behind the feed itself is. Frames and car
 * updates share the one queue, so the map, the telemetry and the tower stay in step.
 *
 * The clock, the timers, the fetch and the stream are all handed in, so the tests run it on
 * a virtual clock.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  // Matched to the server's one-second payload cache: faster only fetches the same bytes.
  var POLL_LIVE = 1500;
  var POLL_IDLE = 60000;
  var POLL_ERROR = 10000;
  // Often enough to release the stream's car updates as smoothly as they came.
  var FLUSH_MS = 100;
  var DELAY_MAX = 60;
  /** How long to poll after the stream fails before trying it again. */
  var STREAM_RETRY = 30000;
  /** The least time between two tries of the stream. */
  var STREAM_MIN_GAP = 5000;
  /** Nothing from the stream for this long — not even its 15 s ping — and it's dead. */
  var STREAM_SILENCE = 20000;
  /** No car update drawn for this long: the map and telemetry fall back to the frames. */
  var CARS_STALE = 3000;
  /*
   * The least time one go at the stream takes. The app notices a stream has ended on its
   * watchdog's next one-second tick; the same floor here keeps a server that says "bye" or
   * "idle" at once from being reconnected to in a tight loop.
   */
  var FOLLOW_MIN = 1000;
  /** A page that has been out of sight for a while polls this slowly, and doesn't stream. */
  var POLL_HIDDEN = 30000;
  var RATE_WINDOW = 5000;
  var RATE_EVERY = 2000;
  var NEVER = Infinity;

  function clampDelay(seconds) {
    var s = Math.round(+seconds || 0);
    return Math.min(DELAY_MAX, Math.max(0, s));
  }

  function assign(target, patch) {
    var out = {};
    var k;
    for (k in target) { out[k] = target[k]; }
    for (k in patch) { out[k] = patch[k]; }
    return out;
  }

  /*
   * options:
   *   fetch         () => Promise<frame>, one poll of /f1/live
   *   stream        optional ({onEvent, onEnd}) => {close()}: opens /f1/stream, calls onEvent
   *                 with each decoded event and onEnd(error) once it closes
   *   clock         () => ms
   *   setTimer      (fn, ms) => handle; clearTimer(handle)
   *   initialDelay  the delay set last time, so a race-day setting survives a reload
   */
  function LiveFeed(options) {
    var o = options || {};
    this.fetch = o.fetch;
    this.stream = o.stream || null;
    this.clock = o.clock || function () { return Date.now(); };
    this.setTimer = o.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    this.clearTimer = o.clearTimer || function (handle) { clearTimeout(handle); };

    this.state = {
      /** The last live frame drawn. Kept after the session ends: the final order is worth more than a blank. */
      frame: null,
      status: 'CONNECTING', // CONNECTING, LIVE, NO_SESSION, SESSION_OVER
      /** The server's reason when nothing is running. */
      reason: null,
      /** The drawn frame came from the server's cache after an upstream failure. */
      stale: false,
      /** The last poll failed; what is on screen is the last good frame. */
      failing: false,
      delaySeconds: clampDelay(o.initialDelay),
      transport: 'POLL', // STREAM or POLL
      /** Car updates a second over the last few seconds of the stream; null while polling. */
      carRate: null
    };
    /*
     * Where the cars are and what they're doing, from the stream, held back by the same
     * delay as the frames. fresh goes false a few seconds after the stream stops delivering,
     * so the map and the telemetry fall back to the frames rather than freeze.
     */
    this.cars = { at: null, positions: {}, telemetry: {}, fresh: false };

    this.queue = [];
    this.carsDrawnAt = 0;
    this.carArrivals = [];
    this.rateAt = 0;
    /** When to try the stream next; NEVER until a poll shows a session to stream. */
    this.nextStream = 0;
    this.streamTried = -Infinity;

    this.running = false;
    /** Out of sight for a while: no stream, and slow polls. See setBackground. */
    this.background = false;
    this.listeners = { state: [], cars: [] };
  }

  LiveFeed.prototype.onState = function (fn) { this.listeners.state.push(fn); };
  LiveFeed.prototype.onCars = function (fn) { this.listeners.cars.push(fn); };

  LiveFeed.prototype.update = function (patch) {
    var changed = false;
    for (var k in patch) {
      if (this.state[k] !== patch[k]) { changed = true; }
    }
    if (!changed) { return; }
    this.state = assign(this.state, patch);
    var state = this.state;
    this.listeners.state.forEach(function (fn) { fn(state); });
  };

  LiveFeed.prototype.setCars = function (cars) {
    this.cars = cars;
    this.listeners.cars.forEach(function (fn) { fn(cars); });
  };

  LiveFeed.prototype.setDelay = function (seconds) {
    this.update({ delaySeconds: clampDelay(seconds) });
    // Lowering it catches up now; raising it holds the frame until the queue refills.
    this.flush();
  };

  /*
   * A browser tab can't follow a session in the background the way the app's service does,
   * and an open stream holds one of the server's few stream slots, which the app and other
   * tabs need. So a page out of sight for a while gives its stream up and polls slowly;
   * back in sight, it tries the stream again at once.
   */
  LiveFeed.prototype.setBackground = function (on) {
    if (this.background === on) { return; }
    this.background = on;
    if (on) {
      if (this.connection) { this.connection.close(); }
    } else {
      this.nextStream = 0;
      this.wake();
    }
  };

  LiveFeed.prototype.run = function () {
    if (this.running) { return; }
    this.running = true;
    var self = this;
    (function tick() {
      if (!self.running) { return; }
      self.flush();
      self.flushTimer = self.setTimer(tick, FLUSH_MS);
    }());
    this.loop();
  };

  LiveFeed.prototype.stop = function () {
    this.running = false;
    this.clearTimer(this.flushTimer);
    if (this.connection) { this.connection.close(); }
    this.wake();
  };

  /** Cut the current wait short: the next poll (or stream try) happens now. */
  LiveFeed.prototype.wake = function () {
    if (this.sleeping) { this.sleeping(); }
  };

  LiveFeed.prototype.sleep = function (ms) {
    var self = this;
    return new Promise(function (resolve) {
      var handle = self.setTimer(done, ms);
      function done() {
        self.clearTimer(handle);
        self.sleeping = null;
        resolve();
      }
      self.sleeping = done;
    });
  };

  LiveFeed.prototype.loop = async function () {
    while (this.running) {
      var source = this.background ? null : this.stream;
      if (source && this.clock() >= this.nextStream) {
        this.streamTried = this.clock();
        var end = await this.follow(source);
        var took = this.clock() - this.streamTried;
        if (took < FOLLOW_MIN && this.running) { await this.sleep(FOLLOW_MIN - took); }
        if (!this.running) { return; }
        if (end === 'BYE' && !this.background) { continue; }
        // Given up for the background: try it again as soon as the page is back in sight.
        this.nextStream = this.background ? 0 : end === 'IDLE' ? NEVER : this.clock() + STREAM_RETRY;
        this.update({ transport: 'POLL', carRate: null });
      }
      var wait = await this.poll();
      if (!this.running) { return; }
      if (this.background && wait === POLL_LIVE) { wait = POLL_HIDDEN; }
      // A session on track is the cue to try the stream again — though never sooner than
      // STREAM_MIN_GAP after the last try, whatever the two disagree about.
      if (this.nextStream === NEVER && this.state.status === 'LIVE' && !this.state.failing) {
        this.nextStream = this.streamTried + STREAM_MIN_GAP;
      }
      var untilStream = !source || this.nextStream === NEVER ? wait : Math.max(0, this.nextStream - this.clock());
      await this.sleep(Math.min(wait, untilStream));
    }
  };

  /** Follow the stream until it ends, fails or falls silent; resolves with IDLE, BYE or FAILED. */
  LiveFeed.prototype.follow = function (source) {
    var self = this;
    return new Promise(function (resolve) {
      var end = 'FAILED';
      var heard = self.clock();
      var done = false;
      var connection = null;
      var watch = null;

      function finish() {
        if (done) { return; }
        done = true;
        self.clearTimer(watch);
        self.connection = null;
        if (connection) { connection.close(); }
        resolve(end);
      }

      // A stream that goes quiet is a dead one, whatever the socket thinks.
      function check() {
        if (done) { return; }
        if (self.clock() - heard > STREAM_SILENCE) {
          end = 'FAILED';
          finish();
          return;
        }
        watch = self.setTimer(check, 1000);
      }

      self.connection = { close: finish };
      try {
        connection = source({
          onEvent: function (ev) {
            if (done) { return; }
            heard = self.clock();
            if (ev.type === 'frame') {
              self.accept({ frame: ev.frame });
            } else if (ev.type === 'cars') {
              self.accept({ batch: ev.batch });
            } else if (ev.type === 'idle') {
              // An idle carrying an error is the server failing upstream, not the end of a
              // session: try again shortly rather than wait for one.
              if (ev.frame.error) {
                end = 'FAILED';
              } else {
                self.queueFrame(ev.frame);
                end = 'IDLE';
              }
            } else if (ev.type === 'bye') {
              end = 'BYE';
            }
          },
          onEnd: function (error) {
            if (error) { end = 'FAILED'; }
            finish();
          }
        });
      } catch (e) {
        end = 'FAILED';
        finish();
        return;
      }
      // A stream that ended before it had even been handed back still needs closing.
      if (done) {
        if (connection) { connection.close(); }
        return;
      }
      watch = self.setTimer(check, 1000);
    });
  };

  LiveFeed.prototype.accept = function (item) {
    var now = this.clock();
    this.queue.push([now, item]);
    if (item.batch) {
      this.carArrivals.push(now);
      while (this.carArrivals.length && now - this.carArrivals[0] > RATE_WINDOW) { this.carArrivals.shift(); }
    }
    this.update({ transport: 'STREAM', failing: false });
    this.flush();
  };

  LiveFeed.prototype.queueFrame = function (frame) {
    this.queue.push([this.clock(), { frame: frame }]);
    this.flush();
  };

  /** One request; resolves with how long to wait before the next. */
  LiveFeed.prototype.poll = async function () {
    var frame = null;
    try {
      frame = await this.fetch();
    } catch (e) {
      frame = null;
    }
    // A 502 body ({live: false, error}) is an upstream failure, not the end of a session.
    if (!frame || (!frame.live && frame.error)) {
      this.update({ failing: true });
      return POLL_ERROR;
    }
    this.queue.push([this.clock(), { frame: frame }]);
    this.update({ failing: false });
    this.flush();
    // Cadence follows the frame that just arrived, not the one on screen: a session that
    // has ended polls slowly at once, while its last minute still plays out.
    return frame.live ? POLL_LIVE : POLL_IDLE;
  };

  /*
   * Draw what has come due. Of the frames, only the newest: each is a whole snapshot, so the
   * newest due one already says everything. Car updates are partial — only the cars with
   * something new — so every due one is folded in, oldest first.
   */
  LiveFeed.prototype.flush = function () {
    var delayMs = this.state.delaySeconds * 1000;
    var now = this.clock();
    var due = null;
    var batches = [];
    var rate = null;
    while (this.queue.length && this.queue[0][0] + delayMs <= now) {
      var item = this.queue.shift()[1];
      if (item.frame) { due = item.frame; } else { batches.push(item.batch); }
    }
    if (now - this.rateAt >= RATE_EVERY) {
      this.rateAt = now;
      while (this.carArrivals.length && now - this.carArrivals[0] > RATE_WINDOW) { this.carArrivals.shift(); }
      rate = Math.round(this.carArrivals.length * 10000 / RATE_WINDOW) / 10;
    }
    if (batches.length) {
      this.carsDrawnAt = now;
      var cars = this.cars;
      var positions = assign(cars.positions, {});
      var telemetry = assign(cars.telemetry, {});
      var at = cars.at;
      batches.forEach(function (b) {
        if (b.at != null) { at = b.at; }
        for (var n in b.positions) { positions[n] = b.positions[n]; }
        for (var m in b.telemetry) { telemetry[m] = b.telemetry[m]; }
      });
      this.setCars({ at: at, positions: positions, telemetry: telemetry, fresh: true });
    } else if (this.cars.fresh && now - this.carsDrawnAt > CARS_STALE) {
      this.setCars(assign(this.cars, { fresh: false }));
    }
    if (rate != null && this.state.transport === 'STREAM') { this.update({ carRate: rate }); }

    if (!due) { return; }
    if (due.live) {
      this.update({ frame: due, status: 'LIVE', reason: null, stale: due.stale });
    } else {
      this.update({
        status: this.state.frame ? 'SESSION_OVER' : 'NO_SESSION',
        reason: due.reason,
        stale: false
      });
    }
  };

  LiveFeed.POLL_LIVE = POLL_LIVE;
  LiveFeed.POLL_IDLE = POLL_IDLE;
  LiveFeed.POLL_ERROR = POLL_ERROR;
  LiveFeed.FLUSH_MS = FLUSH_MS;
  LiveFeed.DELAY_MAX = DELAY_MAX;
  LiveFeed.STREAM_RETRY = STREAM_RETRY;
  LiveFeed.STREAM_MIN_GAP = STREAM_MIN_GAP;
  LiveFeed.STREAM_SILENCE = STREAM_SILENCE;
  LiveFeed.CARS_STALE = CARS_STALE;
  LiveFeed.POLL_HIDDEN = POLL_HIDDEN;

  P.LiveFeed = LiveFeed;
}());
