/*
 * aurora-sun.js: NOAA's SUVI list read into times, the frames chosen to load and in what
 * order, and the frame shown for a time.
 */
var S = window.AuroraSun;
var MIN = 60000, HOUR = 60 * MIN;

function utcMs(s) { return Date.parse(s + 'Z'); }

// A day of frames every 4 minutes ending at 18:44, as NOAA lists them.
function day() {
  var end = utcMs('2026-11-13T18:44:00'), out = [];
  for (var t = end - 24 * HOUR + 4 * MIN; t <= end; t += 4 * MIN) { out.push(t); }
  return out;
}

test('a frame\'s time is read from its file name', function () {
  eq(S.parseTime('/images/animations/suvi/primary/171/or_suvi-l2-ci171_g19_s20261113T184400Z_e20261113T184800Z_v1-0-2.png'),
    utcMs('2026-11-13T18:44:00'));
  eq(S.parseTime('/images/elsewhere.png'), null);
});

test('the list is sorted, made absolute and rid of repeats and strays', function () {
  var l = S.parseList([
    { url: '/a/or_suvi-l2-ci171_g19_s20261113T184800Z_e.png' },
    { url: '/a/or_suvi-l2-ci171_g19_s20261113T184400Z_e.png' },
    { url: '/a/or_suvi-l2-ci171_g19_s20261113T184400Z_e.png' },
    { url: '/a/thumbnail.png' },
    null
  ]);
  eq(l.length, 2);
  ok(l[0].t < l[1].t, 'oldest first');
  eq(l[0].url.indexOf('https://services.swpc.noaa.gov/a/'), 0, 'absolute');
});

test('one an hour is the newest at or before each hour back from the newest', function () {
  var t = day(), idx = S.every(t, HOUR);
  eq(idx[0], t.length - 1, 'the newest first');
  eq(idx.length, 24, 'a day of hours (the 24th back is a minute short of the list)');
  for (var k = 1; k < idx.length; k++) {
    near(t[idx[k - 1]] - t[idx[k]], HOUR, 4 * MIN, 'an hour apart at ' + k);
  }
});

test('the newest loads first, then the hourly frames, then the 20-minute fill', function () {
  var t = day(), o = S.order(t, { fill: true });
  eq(o[0], t.length - 1);
  var hourly = S.every(t, HOUR).length;
  var fill = S.order(t, { fill: false });
  eq(fill.length, hourly, 'without the fill, just the hours');
  ok(o.length > 70 && o.length <= 73, 'a day at 20 minutes: ' + o.length);
  var seen = {};
  o.forEach(function (i) { ok(!seen[i], 'once each'); seen[i] = true; });
  eq(o.slice(0, hourly).join(), fill.join(), 'the hours before any of the fill');
});

test('a time between two frames shows both, mixed by how far between', function () {
  var f = [{ t: 0 }, { t: 20 * MIN }, { t: 40 * MIN }];
  var l = S.lookupIn(f, 25 * MIN);
  eq(l.a.t, 20 * MIN);
  eq(l.b.t, 40 * MIN);
  near(l.mix, 0.25, 1e-9);
  ok(!l.latest && !l.earliest);
});

test('past the newest frame it stays, marked latest; before the oldest, the oldest', function () {
  var f = [{ t: 0 }, { t: 20 * MIN }];
  var late = S.lookupIn(f, 3 * HOUR);
  eq(late.a.t, 20 * MIN);
  ok(late.latest, 'latest');
  var early = S.lookupIn(f, -HOUR);
  eq(early.a.t, 0);
  ok(early.earliest, 'earliest');
  eq(S.lookupIn([], 0), null, 'nothing ready');
});

test('the Sun\'s radius in a frame is about 387 of 1280 px in November', function () {
  near(S.radiusFrac(0.9893) * 1280, 387.8, 1);
  ok(S.radiusFrac(1.0167) < S.radiusFrac(0.9833), 'smaller at aphelion');
});
