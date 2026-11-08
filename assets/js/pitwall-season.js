/*
 * Pitwall: the season index (assets/data/f1/season-YYYY.json) — which circuit file draws
 * a session's track, and the grand prix's lap count, neither of which the timing feed
 * carries. A port of Pocket Pitwall's data/Season.kt.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  function parse(input) {
    var o = typeof input === 'string' ? JSON.parse(input) : input;
    var year = typeof o.season === 'number' ? o.season : parseInt(o.season, 10) || 0;
    var rounds = (Array.isArray(o.rounds) ? o.rounds : []).map(function (r) {
      var stats = r.stats && typeof r.stats === 'object' ? r.stats : {};
      return {
        round: typeof r.round === 'number' ? r.round : null,
        name: r.name || null,
        circuitName: r.circuitName || null,
        locality: r.locality || null,
        country: r.country || null,
        geoId: r.geoId || null,
        circuitKey: typeof r.circuitKey === 'number' ? r.circuitKey : null,
        laps: typeof stats.laps === 'number' ? stats.laps : null
      };
    });
    return { year: year, rounds: rounds };
  }

  /*
   * Keyed on Formula 1's circuit id where there is one — the short names disagree with our
   * circuit names on a third of the calendar. Then by name, from two sources, because a new
   * circuit (Madring in FP1) can arrive with neither a key nor a short name, and the city is
   * the only identifier left.
   */
  function roundFor(season, session) {
    if (!season || !session) { return null; }
    var i;
    if (session.circuitKey != null) {
      for (i = 0; i < season.rounds.length; i++) {
        if (season.rounds[i].circuitKey === session.circuitKey) { return season.rounds[i]; }
      }
    }
    var names = [session.circuit, session.location];
    for (var n = 0; n < names.length; n++) {
      var wanted = (names[n] || '').toLowerCase();
      if (!wanted) { continue; }
      for (i = 0; i < season.rounds.length; i++) {
        var r = season.rounds[i];
        if ((r.locality || '').toLowerCase() === wanted ||
            (r.circuitName || '').toLowerCase().indexOf(wanted) >= 0 ||
            (r.country || '').toLowerCase() === wanted) {
          return r;
        }
      }
    }
    return null;
  }

  /** The grand prix's distance. Not a sprint's: that is a third of it. */
  function totalLaps(season, session) {
    if (!P.Format.isGrandPrix(session)) { return null; }
    var round = roundFor(season, session);
    return round ? round.laps : null;
  }

  P.Season = {
    parse: parse,
    roundFor: roundFor,
    totalLaps: totalLaps
  };
}());
