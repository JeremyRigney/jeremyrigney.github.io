/* SeasonTest from Pocket Pitwall, against the site's own season index. */
(function () {
  var Season = Pitwall.Season;
  var season = Season.parse(asset('season-2026.json'));

  function session(fields) {
    var s = { key: null, name: null, type: null, circuit: null, circuitKey: null, location: null };
    for (var k in fields) { s[k] = fields[k]; }
    return s;
  }

  test('matches on circuit key', function () {
    var race = session({ key: 11388, name: 'Race', type: 'Race', circuit: 'Singapore', circuitKey: 61 });
    eq(Season.roundFor(season, race).geoId, 'sg-2008');
    eq(Season.totalLaps(season, race), 62);
  });

  test('falls back to the city when there is no key', function () {
    // Madring in FP1: no circuit key and no short name, only the city.
    var fp1 = session({ key: 1, name: 'Practice 1', type: 'Practice', location: 'Madrid' });
    eq(Season.roundFor(season, fp1).geoId, 'es-2026');
  });

  test('no lap count for a sprint', function () {
    var sprint = session({ key: 11383, name: 'Sprint', type: 'Race', circuit: 'Singapore', circuitKey: 61 });
    isNull(Season.totalLaps(season, sprint));
  });

  test('year is read', function () {
    eq(season.year, 2026);
  });
}());
