/*
 * Pitwall: the Wall's arithmetic — the pit wall's "wall of doom". Ports of Pocket Pitwall's
 * wall/Strategy.kt (Doom, itself the pure half of the old wall's f1-doom.js) and
 * wall/RingPick.kt. Pure: it runs under jsc in tests/pitwall/.
 *
 * The lap is a ring and one trip round it is one lap of *time*. Every car sits at its gap to
 * the leader, so a car 20 s behind is 20 s of arc behind whatever corner it is in. A pit stop
 * is also a time, so each car's ghost — where it rejoins if it boxes now — is the car moved
 * back round the ring by the pit loss, and whoever the ghost lands beside is who the car
 * comes out beside. Under a safety car the lap stretches and the loss shrinks, so the ghosts
 * pull in towards their cars: that is the cheap stop.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  /** Seconds a rejoining car can have to the car ahead before it is in traffic. */
  var TRAFFIC_S = 1.5;
  /** Close enough behind that fresh tyres make up the gap before the car ahead stops. */
  var UNDERCUT_S = 2.5;
  /** A car whose lap began this many ring-laps ago is not on track. */
  var STALE_LAPS = 2.5;

  function wrap(f) {
    var r = f - Math.floor(f);
    return r >= 1 ? 0 : r;
  }

  /** The shortest signed step from fraction a to fraction b, in laps. */
  function step(a, b) {
    var d = wrap(b - a);
    return d > 0.5 ? d - 1 : d;
  }

  function mod(value, by) {
    var r = value % by;
    return r < 0 ? r + by : r;
  }

  function median(values) {
    if (!values.length) { return null; }
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /*
   * Time behind the leader, in race order: gapToLeader where it is a number; for a lapped car
   * ("+1 LAP"), the intervals summed down from the car in front, which keeps it on the ring at
   * its real distance rather than parked at the leader.
   */
  function timesBehind(drivers) {
    var out = {};
    var previous = null;
    var leaderSeen = false;
    drivers.forEach(function (d) {
      if (d.dnf || d.pos == null) { return; }
      var gap = typeof d.gapToLeader === 'number' ? d.gapToLeader : null;
      var interval = typeof d.interval === 'number' ? d.interval : null;
      var t;
      if (!leaderSeen) {
        leaderSeen = true;
        t = 0;
      } else if (gap != null && gap > 0) {
        t = gap;
      } else if (previous != null && interval != null) {
        t = previous + interval;
      } else {
        t = null;
      }
      out[d.num] = t;
      previous = t;
    });
    return out;
  }

  /*
   * The server's ring lap when it sent one (green pace, stretched under a neutralisation).
   * Otherwise the field's median last lap, capped at the session best plus 4%.
   */
  function ringLap(frame, drivers) {
    if (frame.strategy && frame.strategy.ringLap != null) { return frame.strategy.ringLap; }
    var typical = median(drivers.map(function (d) { return d.lastLap; }).filter(function (v) { return v != null; }));
    var best = frame.best ? frame.best.lap : null;
    if (best != null) { return typical != null ? Math.min(typical, best * 1.04) : best * 1.04; }
    return typical;
  }

  function lapFraction(lapStart, nowMs, lap) {
    var into = (nowMs - lapStart) / 1000;
    if (into < -5 || into > lap * STALE_LAPS) { return null; }
    return wrap(into / lap);
  }

  function Doom(frame, totalLaps) {
    this.frame = frame;
    this.totalLaps = totalLaps;
    /** Running cars, in race order. */
    this.drivers = frame.drivers.filter(function (d) { return !d.dnf; });
    var byNum = this.byNum = {};
    this.drivers.forEach(function (d) { byNum[d.num] = d; });
    /** Seconds behind the leader, per car; null where there is no gap to place it by. */
    var behind = this.behind = timesBehind(this.drivers);
    this.leader = this.drivers.filter(function (d) { return behind[d.num] === 0; })[0] || null;
    /** One trip round the ring, in seconds. */
    this.ringLap = ringLap(frame, this.drivers);
    this.strategy = frame.strategy;
    /** What a stop costs now, under the flag that is out. */
    this.loss = frame.strategy && frame.strategy.pitLoss ? frame.strategy.pitLoss.now : null;
    this.generatedMs = frame.generated != null ? frame.generated : Date.now();
    this.hasLapStart = this.drivers.some(function (d) { return d.lapStart != null; });
  }

  /** Where every car belongs at nowMs, as a fraction of the lap from the line: {num: f}. */
  Doom.prototype.targets = function (nowMs) {
    var t = this.ringLap;
    var out = {};
    if (t == null) { return out; }
    var behind = this.behind;
    var anchor = this.leader && this.leader.lapStart != null ? lapFraction(this.leader.lapStart, nowMs, t) : null;
    this.drivers.forEach(function (d) {
      var gap = behind[d.num];
      var f = null;
      if (anchor != null && gap != null) {
        f = wrap(anchor - gap / t);
      } else if (d.lapStart != null) {
        // No gap to place it by — practice, qualifying, the opening lap — so its own lap.
        f = lapFraction(d.lapStart, nowMs, t);
      }
      if (f != null) { out[d.num] = f; }
    });
    return out;
  };

  /**
   * What happens if num boxes now, all from time behind the leader so it is exactly what the
   * ring shows: the ghost's time is the car's plus the loss, and everything else is who sits
   * either side of that.
   */
  Doom.prototype.project = function (num) {
    var car = this.byNum[num];
    var behind = this.behind;
    if (!car || behind[num] == null || this.loss == null) { return null; }
    var t = behind[num];
    var loss = this.loss;
    var rejoin = t + loss;
    var others = this.drivers.filter(function (d) { return d.num !== num && behind[d.num] != null; });
    var position = 1;
    var ahead = null;
    var after = null;
    var nextBack = null;
    var nextUp = null;
    others.forEach(function (d) {
      var tj = behind[d.num];
      if (tj < rejoin) {
        position += 1;
        if (!ahead || tj > behind[ahead.num]) { ahead = d; }
      } else if (!after || tj < behind[after.num]) {
        after = d;
      }
      if (tj > t && (!nextBack || tj < behind[nextBack.num])) { nextBack = d; }
      if (tj < t && (!nextUp || tj > behind[nextUp.num])) { nextUp = d; }
    });
    // Traffic is physical, not positional: a lapped car the ghost lands on is still in the
    // way, so it is measured round the ring, modulo a lap.
    var traffic = null;
    var lap = this.ringLap;
    if (lap != null) {
      var ghost = mod(rejoin, lap);
      others.forEach(function (d) {
        if (d.inPit) { return; }
        var gapAhead = mod(ghost - mod(behind[d.num], lap), lap);
        if (gapAhead < TRAFFIC_S && (!traffic || gapAhead < traffic.gap)) { traffic = { car: d, gap: gapAhead }; }
      });
    }
    var gapBack = nextBack ? behind[nextBack.num] - t : null;
    var gapUp = nextUp ? t - behind[nextUp.num] : null;
    return {
      car: car,
      from: car.pos,
      position: position,
      ahead: ahead,
      aheadGap: ahead ? rejoin - behind[ahead.num] : null,
      behind: after,
      behindGap: after ? behind[after.num] - rejoin : null,
      traffic: traffic,
      free: gapBack == null || gapBack > loss,
      threat: nextBack && gapBack < UNDERCUT_S ? { car: nextBack, gap: gapBack } : null,
      chance: nextUp && gapUp < UNDERCUT_S ? { car: nextUp, gap: gapUp } : null
    };
  };

  /** Whether each car could stop now without losing a place to the car behind: {num: bool}. */
  Doom.prototype.freeStops = function () {
    var loss = this.loss;
    var out = {};
    if (loss == null) { return out; }
    var behind = this.behind;
    var timed = this.drivers.filter(function (d) { return behind[d.num] != null; });
    timed.forEach(function (d, i) {
      var next = timed[i + 1];
      out[d.num] = !next || behind[next.num] - behind[d.num] > loss;
    });
    return out;
  };

  Doom.TRAFFIC_S = TRAFFIC_S;
  Doom.UNDERCUT_S = UNDERCUT_S;
  Doom.timesBehind = timesBehind;
  Doom.wrap = wrap;
  Doom.step = step;
  Doom.mod = mod;

  // ---------- Picking on the ring ----------

  /*
   * Picking a car on the ring by direction, like turning a dial, rather than by hitting its
   * dot, and stepping through the field in order. shown is {num: fraction}.
   */
  var RingPick = {
    /**
     * The fraction of the lap at the direction (dx, dy) from the ring's centre, screen y
     * pointing down: 0 at twelve o'clock and rising clockwise, the inverse of where the ring
     * draws a fraction.
     */
    fraction: function (dx, dy) {
      return wrap((Math.atan2(dy, dx) + Math.PI / 2) / (2 * Math.PI));
    },

    /** The car drawn nearest fraction f round the ring, across the line either way. */
    nearest: function (shown, f) {
      var best = null;
      var bestD = Infinity;
      Object.keys(shown).forEach(function (k) {
        var d = Math.abs(step(shown[k], f));
        if (d < bestD) {
          bestD = d;
          best = Number(k);
        }
      });
      return best;
    },

    /**
     * The cars within window of the lap either side of f, the one furthest round the ring
     * (furthest up the road) first: the pack under the pointer, for the magnifier.
     */
    near: function (shown, f, window) {
      return Object.keys(shown).map(function (k) { return [Number(k), step(f, shown[k])]; })
        .filter(function (e) { return Math.abs(e[1]) <= window; })
        .sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return e[0]; });
    },

    /**
     * by places on from current in order (race order, leader first), wrapping round at either
     * end. With nothing picked, stepping on starts at the leader and stepping back at the last.
     */
    step: function (order, current, by) {
      if (!order.length) { return null; }
      var i = order.indexOf(current);
      if (i < 0) { return by >= 0 ? order[0] : order[order.length - 1]; }
      return order[mod(i + by, order.length)];
    }
  };

  P.Doom = Doom;
  P.RingPick = RingPick;
}());
