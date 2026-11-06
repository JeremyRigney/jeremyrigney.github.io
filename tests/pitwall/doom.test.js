/* DoomTest and RingPickTest from Pocket Pitwall. */
(function () {
  var Doom = Pitwall.Doom;
  var RingPick = Pitwall.RingPick;
  var lapStart = Date.UTC(2026, 9, 11, 12, 45, 0);

  function car(num, pos, gap, interval, inPit) {
    return { num: num, pos: pos, code: 'C' + num, gapToLeader: gap, interval: interval, inPit: !!inPit, dnf: false, lapStart: lapStart, stints: [] };
  }

  function frame(drivers, loss, ring) {
    var l = loss == null ? 20 : loss;
    return {
      live: true,
      generated: Date.UTC(2026, 9, 11, 12, 45, 30),
      drivers: drivers,
      best: null,
      strategy: {
        refLap: 90, ringLap: ring == null ? 90 : ring, kVsc: 1.3, kSc: 1.45,
        pitLoss: { green: l, vsc: 12, sc: 10, now: l, seed: 22, basis: 'seed', samplesGreen: 0, samplesVsc: 0, samplesSc: 0 },
        lane: null, stationary: null
      }
    };
  }

  test('lapped cars sum intervals from the car ahead', function () {
    var behind = Doom.timesBehind([car(1, 1, 0, 0), car(2, 2, 30, 30), car(3, 3, '+1 LAP', 70)]);
    near(behind[1], 0, 1e-9);
    near(behind[2], 30, 1e-9);
    near(behind[3], 100, 1e-9);
  });

  test('the ring places cars by their gap', function () {
    var doom = new Doom(frame([car(1, 1, 0, null), car(2, 2, 9, 9)]), null);
    // The leader is 30 s into a 90 s lap: a third of the way round. Car 2 is 9 s (a tenth) behind.
    var at = doom.targets(Date.UTC(2026, 9, 11, 12, 45, 30));
    near(at[1], 1 / 3, 1e-9);
    near(at[2], 1 / 3 - 0.1, 1e-9);
  });

  test('pit-now projection', function () {
    var doom = new Doom(frame([
      car(1, 1, 0, null),
      car(2, 2, 5, 5),
      car(3, 3, 7, 2),
      car(4, 4, 24.5, 17.5),
      car(5, 5, 40, 15.5)
    ], 20), null);
    var p = doom.project(2);
    // 5 + 20 = 25 s: behind car 4 (24.5), ahead of car 5 (40).
    eq(p.position, 4);
    eq(p.ahead.num, 4);
    near(p.aheadGap, 0.5, 1e-9);
    eq(p.behind.num, 5);
    no(p.free);                 // car 3 is only 2 s behind
    eq(p.threat.car.num, 3);    // and inside undercut range
    eq(p.traffic.car.num, 4);   // rejoins 0.5 s behind car 4
    isNull(p.chance);           // car 1 is 5 s up the road

    var free = doom.freeStops();
    eq(free[4], false);         // car 5 is 15.5 s back: less than the 20 s loss
    eq(free[5], true);          // nobody behind the last car
  });

  test('a real frame under the safety car', function () {
    var f = Pitwall.Parse.frame(fixture('frame-race-sc.json'));
    var doom = new Doom(f, 62);
    notNull(doom.leader);
    ok(doom.hasLapStart);
    near(doom.ringLap, f.strategy.ringLap, 1e-9);
    var targets = doom.targets(f.generated);
    ok(Object.keys(targets).length >= 15, 'placed ' + Object.keys(targets).length);
    ok(Object.keys(targets).every(function (k) { return targets[k] >= 0 && targets[k] <= 1; }));
    notNull(doom.project(doom.drivers[1].num));
  });

  test('the ring lap without strategy falls back to pace', function () {
    var f = Pitwall.Parse.frame(fixture('frame-quali.json'));
    var doom = new Doom(f, null);
    isNull(doom.strategy);
    notNull(doom.ringLap);
    ok(doom.ringLap <= f.best.lap * 1.04 + 1e-9);
  });

  test('wrap and step', function () {
    near(Doom.wrap(-0.1), 0.9, 1e-9);
    near(Doom.step(0.9, 0.1), 0.2, 1e-9);
    near(Doom.step(0.1, 0.9), -0.2, 1e-9);
    near(Doom.mod(-85, 90), 5, 1e-9);
  });

  // ---------- RingPickTest ----------

  /** Where the ring draws fraction f of the lap, relative to its middle. */
  function drawnAt(f) {
    var theta = -Math.PI / 2 + f * Math.PI * 2;
    return [Math.cos(theta) * 100, Math.sin(theta) * 100];
  }

  test('a direction from the middle is the fraction drawn there', function () {
    [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999].forEach(function (f) {
      var d = drawnAt(f);
      near(RingPick.fraction(d[0], d[1]), f, 1e-6);
    });
    // Twelve o'clock, three o'clock (screen y points down).
    near(RingPick.fraction(0, -1), 0, 1e-9);
    near(RingPick.fraction(1, 0), 0.25, 1e-9);
  });

  test('the nearest car is found across the line', function () {
    var shown = { 1: 0.02, 44: 0.40, 16: 0.97 };
    eq(RingPick.nearest(shown, 0.99), 16);
    eq(RingPick.nearest(shown, 0.005), 1);
    eq(RingPick.nearest(shown, 0.30), 44);
    isNull(RingPick.nearest({}, 0.5));
  });

  test('the magnifier lists the pack under the pointer, front first', function () {
    // A train across the line: 81 furthest round, then 4, 44 behind them; 1 is far off.
    var shown = { 4: 0.995, 81: 0.01, 44: 0.98, 1: 0.50 };
    eq(RingPick.near(shown, 0, 0.04), [81, 4, 44]);
  });

  test('stepping goes through the order and wraps round', function () {
    var order = [1, 81, 4, 44];
    eq(RingPick.step(order, 81, 1), 4);
    eq(RingPick.step(order, 81, -1), 1);
    eq(RingPick.step(order, 44, 1), 1);
    eq(RingPick.step(order, 1, -1), 44);
    // Nothing picked: on from the leader, back from the last car.
    eq(RingPick.step(order, null, 1), 1);
    eq(RingPick.step(order, null, -1), 44);
    isNull(RingPick.step([], 4, 1));
  });
}());
