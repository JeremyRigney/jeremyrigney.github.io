/*
 * TrackTest, BasemapTest, ProjectorZoomTest, MapMotionTest and TurnCalloutsTest from Pocket
 * Pitwall, against the site's own circuit files (the app's copies are byte-identical).
 */
(function () {
  var Track = Pitwall.Track;
  var Mercator = Pitwall.Mercator;
  var Projector = Pitwall.Projector;
  var MapMotion = Pitwall.MapMotion;
  var Callouts = Pitwall.Callouts;

  function track(id) {
    return new Track(id, asset(id + '.json'));
  }

  var sg = track('sg-2008');

  // ---------- TrackTest ----------

  test('lies along its long axis', function () {
    ok(sg.maxX - sg.minX >= sg.maxY - sg.minY);
    notNull(sg.startIndex);
    ok(sg.hasTransform);
  });

  test('cars land on the track', function () {
    // Most cars in a mid-race frame are on the racing line, well inside the pit-lane cut.
    var frame = Pitwall.Parse.frame(fixture('frame-race-green.json'));
    var distances = frame.drivers.map(function (d) {
      if (!d.xy) { return null; }
      var p = sg.place(d.xy[0], d.xy[1]);
      return p ? sg.nearest(p[0], p[1], null).distance : null;
    }).filter(function (d) { return d != null; }).sort(function (a, b) { return a - b; });
    ok(distances.length >= 18, 'placed ' + distances.length);
    var median = distances[distances.length >> 1];
    ok(median < 15, 'median ' + median + ' m');
  });

  test('sector arcs wrap', function () {
    var arc = sg.sectorArc(1);
    notNull(arc);
    // Sector 1 starts near the end of the lap and runs over the line.
    ok(arc[0] > arc[1], 'arc ' + arc);
  });

  test('ring delta', function () {
    near(Track.ringDelta(99, 1, 100), 2, 1e-9);
    near(Track.ringDelta(1, 99, 100), -2, 1e-9);
  });

  test('hairpin needles are laid flat', function () {
    // Sepang's outline runs up to 40 m past T14 and T15 and folds back. Round those corners
    // every point of the drawn line should now be where the cars actually drove.
    var sepang = track('my-1999');
    var cars = JSON.parse(fixture('sepang-cars.json')).xy.map(function (p) { return sepang.place(p[0], p[1]); });
    var worst = 0;
    var corners = [];
    for (var i = 265; i <= 285; i++) { corners.push(i); }
    for (var j = 330; j <= 358; j++) { corners.push(j); }
    corners.forEach(function (i) {
      var best = Infinity;
      cars.forEach(function (c) { best = Math.min(best, Math.hypot(sepang.xs[i] - c[0], sepang.ys[i] - c[1])); });
      worst = Math.max(worst, best);
    });
    ok(worst < 15, 'worst ' + worst + ' m');
  });

  test('real hairpins keep their shape', function () {
    // Monaco's Grand Hotel hairpin has legs only 13 m apart, but turns over several points
    // rather than flipping at one, so it is no needle: it should stay about 65 m deep.
    var monaco = track('mc-1929');
    var midX = (monaco.xs[20] + monaco.xs[30]) / 2;
    var midY = (monaco.ys[20] + monaco.ys[30]) / 2;
    var depth = Math.hypot(monaco.xs[25] - midX, monaco.ys[25] - midY);
    ok(depth > 55, 'depth ' + depth + ' m');
  });

  test('glide keeps an even speed', function () {
    // Over the lap's closing gap, 115 m at Sepang, as on any 15 m step: half the time, half
    // the distance.
    var sepang = track('my-1999');
    var lap = sepang.perimeter;
    function metres(a, b) { return ((sepang.distanceAt(b) - sepang.distanceAt(a)) % lap + lap) % lap; }
    var from = sepang.size - 6;
    var to = 4;
    var total = metres(from, to);
    [0.25, 0.5, 0.75].forEach(function (t) { near(metres(from, sepang.glide(from, to, t)), total * t, 0.01); });
    near(sepang.glide(from, to, 1), to, 1e-6);
    near(sepang.glide(from, to, 0), from, 1e-6);
    // And backwards, the short way, for a car the feed puts a little behind.
    var back = metres(sepang.glide(to, from, 0.5), to);
    ok(back >= total * 0.49 && back <= total * 0.51, 'back ' + back);
  });

  test('official turns are read in lap order', function () {
    // Singapore's 19 official corners, numbered upward from the start line round the lap.
    eq(sg.turns.length, 19);
    var start = sg.startIndex;
    var round = sg.turns.slice().sort(function (a, b) {
      return ((a.index - start) % sg.size + sg.size) % sg.size - ((b.index - start) % sg.size + sg.size) % sg.size;
    }).map(function (t) { return t.number; });
    eq(round, round.slice().sort(function (a, b) { return a - b; }));
    eq(sg.turns.reduce(function (m, t) { return t.number < m.number ? t : m; }).label, 'T1');
  });

  test('lettered corners keep their letter', function () {
    ok(track('hu-1986').turns.some(function (t) { return t.label === 'T1A'; }));
  });

  test('provisional turns are not shown', function () {
    // Madring and Sepang only have the build's curvature guesses, not official numbers.
    eq(track('es-2026').turns.length, 0);
    eq(track('my-1999').turns.length, 0);
  });

  test('turn labels keep off the track on every circuit', function () {
    // Pushed out the way chosen for it, from 20 to 90 m, no label comes within 30 m of another
    // stretch of track: the spiral at Shanghai, Baku's old town and the Grand Hotel hairpin
    // included. Every circuit the season index names.
    var ids = Pitwall.Season.parse(asset('season-2026.json')).rounds.map(function (r) { return r.geoId; })
      .filter(function (id, i, all) { return id && all.indexOf(id) === i; });
    ok(ids.length >= 20, ids.length + ' circuits');
    var bad = [];
    ids.forEach(function (id) {
      var t = track(id);
      t.turns.forEach(function (turn) {
        turn.ways.forEach(function (way) {
          var clear = Track.clearance(t.xs, t.ys, turn.index, way, t.step);
          if (clear < 30) { bad.push(id + ' ' + turn.label + ' clears ' + Math.round(clear) + ' m'); }
        });
      });
    });
    eq(bad, []);
  });

  // ---------- BasemapTest ----------

  test('Mercator round-trips', function () {
    var z = 15;
    near(Mercator.lon(Mercator.x(103.8598, z), z), 103.8598, 1e-9);
    near(Mercator.lat(Mercator.y(1.2914, z), z), 1.2914, 1e-9);
  });

  test('a known tile', function () {
    // Marina Bay at z15 is tile 25837/16266 in the standard grid.
    eq(Math.floor(Mercator.x(103.8598, 15)), 25837);
    eq(Math.floor(Mercator.y(1.2914, 15)), 16266);
  });

  test('zoom draws about one to one', function () {
    // A map at ~2 m per pixel near the equator wants the high-teens zooms.
    var z = Mercator.zoomFor(2, 1.3);
    ok(z >= 15 && z <= 16, 'zoom ' + z);
  });

  test('the track frame matches the circuit outline', function () {
    // A raw lon/lat point of the outline lands within a few metres of where the path is drawn
    // (the path is lightly smoothed, so not exactly on it).
    var first = JSON.parse(asset('sg-2008.json')).path[0];
    var p = sg.local(first[0], first[1]);
    var nearest = Infinity;
    for (var i = 0; i < sg.size; i++) { nearest = Math.min(nearest, Math.hypot(sg.xs[i] - p[0], sg.ys[i] - p[1])); }
    ok(nearest < 5, nearest + ' m');
    // And back again.
    var back = sg.lonLat(p[0], p[1]);
    near(back[0], first[0], 1e-9);
    near(back[1], first[1], 1e-9);
  });

  // ---------- ProjectorZoomTest ----------

  var base = new Projector(0.5, 540, 1100, true);
  var centre = [540, 1000];

  function nearPoint(actual, expected) {
    near(actual[0], expected[0], 0.01);
    near(actual[1], expected[1], 0.01);
  }

  test('at one times nothing moves', function () {
    var same = base.zoomed(1, [0, 0], centre);
    [[0, 0], [300, -120], [-800, 450]].forEach(function (p) {
      nearPoint(same.project(p[0], p[1]), base.project(p[0], p[1]));
    });
  });

  test('zooming keeps the point in the middle where it is', function () {
    var m = base.unproject(centre[0], centre[1]);
    nearPoint(base.zoomed(3, [0, 0], centre).project(m[0], m[1]), centre);
    // And everything else moves out from it k times as far.
    var p = base.project(200, 100);
    var out = [centre[0] + (p[0] - centre[0]) * 3, centre[1] + (p[1] - centre[1]) * 3];
    nearPoint(base.zoomed(3, [0, 0], centre).project(200, 100), out);
    // A pan shifts the lot.
    nearPoint(base.zoomed(3, [-40, 25], centre).project(200, 100), [out[0] - 40, out[1] + 25]);
  });

  test('pan is held so the middle stays over the circuit', function () {
    var box = [100, 300, 980, 1700];
    eq(Projector.clampPan([500, -500], 1, box, centre), [0, 0]);
    // At 2×, the box spans c + (box − c)·2 + pan: the middle may go as far as its edges.
    nearPoint(Projector.clampPan([5000, -5000], 2, box, centre), [-(box[0] - centre[0]) * 2, -(box[3] - centre[1]) * 2]);
    eq(Projector.clampPan([120, -80], 2, box, centre), [120, -80]);
  });

  // ---------- MapMotionTest ----------

  var frame = Pitwall.Parse.frame(fixture('frame-race-green.json'));
  var placed = frame.drivers.filter(function (d) { return d.xy; });

  test('streamed positions win over the frames', function () {
    var motion = new MapMotion(sg);
    motion.update(frame, 0);
    var car = placed[0];
    var elsewhere = placed[placed.length - 1].xy;
    var positions = {};
    positions[car.num] = elsewhere;
    motion.update(frame, 1000, true, positions);
    var p = sg.place(elsewhere[0], elsewhere[1]);
    eq(motion.cars.get(car.num).to, sg.nearest(p[0], p[1], null).index);
  });

  test('the glide settles to the stream’s pace', function () {
    // Fixes four times a second: each glide should last about one interval, a little over.
    var motion = new MapMotion(sg);
    var car = placed[0];
    var now = 0;
    motion.update(frame, now);
    for (var i = 0; i < 30; i++) {
      now += 250;
      var positions = {};
      positions[car.num] = i % 2 === 0 ? placed[1].xy : placed[2].xy;
      motion.update(frame, now, true, positions);
    }
    var travel = motion.cars.get(car.num).travel;
    ok(travel >= 280 && travel <= 380, 'travel ' + travel + ' ms');
  });

  test('a motion made mid-stream glides at the stream’s pace from the start', function () {
    // Its first glide, after one fix 250 ms on: the stream's pace, not a slow three seconds.
    function firstTravel(motion) {
      var car = placed[0];
      motion.update(frame, 1000000);
      var positions = {};
      positions[car.num] = placed[1].xy;
      motion.update(frame, 1000250, true, positions);
      return motion.cars.get(car.num).travel;
    }
    ok(firstTravel(new MapMotion(sg, 250)) < 400);
    ok(firstTravel(new MapMotion(sg)) > 2000);
  });

  // ---------- TurnCalloutsTest ----------

  test('named turns are found in race control’s wording', function () {
    eq(Callouts.labels('CAR 87 (BEA) TIME 1:44.025 DELETED - TRACK LIMITS AT TURN 12 LAP 22 17:18:07'), ['T12']);
    eq(Callouts.labels('INCIDENT INVOLVING CARS 4 (NOR) AND 1 (VER) NOTED - TURN 1'), ['T1']);
    eq(Callouts.labels('DOUBLE YELLOW AT TURNS 6 AND 7'), ['T6', 'T7']);
    eq(Callouts.labels('YELLOW FLAG TURNS 6-7'), ['T6', 'T7']);
    eq(Callouts.labels('Debris at turns 6, 7 and 8'), ['T6', 'T7', 'T8']);
    eq(Callouts.labels('TRACK LIMITS AT TURN 11A'), ['T11A']);
    eq(Callouts.labels('CAR 16 (LEC) OFF AT T4'), ['T4']);
  });

  test('other numbers are not turns', function () {
    eq(Callouts.labels('DOUBLE YELLOW IN TRACK SECTOR 5'), []);
    eq(Callouts.labels('CAR 12 (ANT) TIME 1:43.354 DELETED'), []);
    eq(Callouts.labels('RISK OF RAIN FOR THE F1 RACE IS 90%'), []);
  });

  test('only the last thirty seconds count', function () {
    var now = Date.UTC(2026, 9, 11, 13, 0, 0);
    function event(secondsAgo, text) { return { t: now - secondsAgo * 1000, type: 'note', severity: 'info', drivers: [], lap: 30, text: text }; }
    var events = [
      event(10, 'TRACK LIMITS AT TURN 12'),
      event(45, 'TRACK LIMITS AT TURN 3'),
      event(-5, 'INCIDENT AT TURN 7') // not yet: after the drawn moment
    ];
    eq(Object.keys(Callouts.named(events, now)), ['T12']);
    eq(Object.keys(Callouts.named(events, null)), []);
  });
}());
