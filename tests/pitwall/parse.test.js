/* ParseTest from Pocket Pitwall. */
(function () {
  var Parse = Pitwall.Parse;

  test('race frame under green', function () {
    var frame = Parse.frame(fixture('frame-race-green.json'));
    ok(frame.live);
    eq(frame.session.name, 'Race');
    eq(frame.session.circuitKey, 61);
    eq(frame.flag.state, 'GREEN');
    eq(frame.lap, 26);
    eq(frame.drivers.length, 22);

    var leader = frame.drivers[0];
    eq(leader.pos, 1);
    eq(leader.gapToLeader, 0);
    notNull(leader.lapStart);
    eq(leader.sectors.length, 3);
    notNull(leader.xy);

    // Every driver row is sorted by position, nulls last.
    var positions = frame.drivers.map(function (d) { return d.pos; }).filter(function (p) { return p != null; });
    eq(positions, positions.slice().sort(function (a, b) { return a - b; }));

    near(frame.strategy.ringLap, 98.359, 1e-9);
    near(frame.strategy.pitLoss.now, 24.5, 1e-9);
    eq(frame.strategy.pitLoss.basis, 'calibrated');

    notNull(frame.radio);
    ok(frame.radio.every(function (c) { return c.url.indexOf('https://livetiming.formula1.com/') === 0; }));
    notNull(frame.best.lap);
    notNull(frame.weather.air);
    eq(frame.raceAt, Date.UTC(2026, 9, 11, 12, 45, 0));
  });

  test('lapped cars keep their text gap', function () {
    var frame = Parse.frame(fixture('frame-race-chequered.json'));
    eq(frame.flag.state, 'CHEQUERED');
    ok(frame.drivers.some(function (d) { return d.dnf; }));
    ok(frame.drivers.some(function (d) { return d.gapToLeader != null; }));
  });

  test('safety car note names the sectors', function () {
    var frame = Parse.frame(fixture('frame-race-sc.json'));
    eq(frame.flag.state, 'SAFETY_CAR');
    eq(Pitwall.Format.flagNote(frame.flag), 'Sectors 13, 14');
    ok(Pitwall.Format.urgent(frame.flag.state));
  });

  test('qualifying has no gaps or strategy', function () {
    var frame = Parse.frame(fixture('frame-quali.json'));
    eq(frame.session.name, 'Qualifying');
    isNull(frame.strategy);
    ok(frame.drivers.every(function (d) { return d.gapToLeader == null; }));
    notNull(frame.drivers[0].bestLap);
    // A lapStart with microseconds and an offset still parses.
    notNull(frame.drivers[0].lapStart);
  });

  test('idle frame', function () {
    var frame = Parse.frame(fixture('live-idle.json'));
    no(frame.live);
    eq(frame.reason, 'no session running');
    eq(frame.drivers.length, 0);
    isNull(frame.radio);
  });

  test('an older server still parses', function () {
    // The shape the stale Cloud Run build sent: no strategy, radio, sectors or weather.
    var frame = Parse.frame('{"live":true,"generated":"2026-10-11T12:45:00Z","flag":{"state":"GREEN","sectors":[]},' +
      '"lap":{"current":26},"drivers":[{"num":3,"pos":1,"code":"VER","gapToLeader":0.0,' +
      '"stints":[{"compound":"SOFT","lapStart":1,"lapEnd":32,"age":0}]}],"events":[]}');
    isNull(frame.radio);
    isNull(frame.strategy);
    isNull(frame.weather);
    eq(frame.drivers[0].sectors.length, 0);
    isNull(frame.drivers[0].lapStart);
  });

  test('timeline and sessions', function () {
    var timeline = Parse.timeline(fixture('timeline-11388.json'));
    eq(timeline.session.key, 11388);
    ok(timeline.periods.some(function (p) { return p.state === 'SAFETY_CAR'; }));
    ok(timeline.events.length > 0);

    var sessions = Parse.sessions(fixture('sessions-2026.json'));
    ok(sessions.some(function (s) { return s.key === 11388 && Pitwall.Format.isGrandPrix(s); }));
    var sprint = sessions.filter(function (s) { return s.name === 'Sprint'; })[0];
    ok(Pitwall.Format.isRace(sprint));
    no(Pitwall.Format.isGrandPrix(sprint));
  });

  test('timestamps in every shape', function () {
    var z = Parse.instant('2026-10-11T12:45:00Z');
    eq(Parse.instant('2026-10-11T12:45:00+00:00'), z);
    eq(Parse.instant('2026-10-11T12:45:00'), z);
    eq(Parse.instant('2026-10-11T12:45:00.378000+00:00'), Date.UTC(2026, 9, 11, 12, 45, 0, 378));
    eq(Parse.instant('2026-10-11T13:45:00+01:00'), z);
    isNull(Parse.instant('nonsense'));
    isNull(Parse.instant(null));
  });

  test('a cars event from the stream', function () {
    var batch = Parse.cars('{"t":"2026-10-04T09:10:00.2Z","c":[[4,123.0,-45.5],[81,null,3]],"tel":[[4,301,100,0,8,11800]]}');
    eq(batch.at, Date.UTC(2026, 9, 4, 9, 10, 0, 200));
    eq(batch.positions, { 4: [123, -45.5] });
    eq(batch.telemetry[4], { speed: 301, throttle: 100, brake: 0, gear: 8, rpm: 11800 });
  });
}());
