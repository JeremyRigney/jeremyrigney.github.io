/*
 * Pitwall: the season index (assets/data/f1/season-YYYY.json) — which circuit file draws
 * a session's track, and the grand prix's lap count, neither of which the timing feed
 * carries. A port of Pocket Pitwall's data/Season.kt.
 *
 * And the calendar between sessions, for the standby poster: what's next and its weekend
 * (wall/Weekend.kt), the photograph of where it is (data/Backdrops.kt), which sessions to
 * be reminded of and when (the pure half of wall/Reminders.kt), and the weekend as an
 * .ics file for any calendar, which the app has no need of.
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

  // ---------- What's next ----------

  /** How often the calendar is read again at most, and at least. */
  var CALENDAR_EVERY = 6 * 3600000;
  var CALENDAR_SOONEST = 60000;

  /**
   * What's coming, from every session the server lists (this year's and next): those still
   * to start, in order; the first of them; and every session of its weekend, those already
   * run too, for the poster's strip.
   */
  function upcoming(all, now) {
    var seen = {};
    var dated = all.filter(function (s) {
      if (!s || s.start == null || s.key == null || seen[s.key]) { return false; }
      seen[s.key] = true;
      return true;
    }).sort(function (a, b) { return a.start - b.start; });
    var ahead = dated.filter(function (s) { return s.start > now; });
    var next = ahead[0] || null;
    var weekend = !next ? [] : next.meetingKey == null ? [next] :
      dated.filter(function (s) { return s.meetingKey === next.meetingKey; });
    return { sessions: ahead, next: next, weekend: weekend };
  }

  /** When to read the calendar again: a minute after the next session starts, so it moves along; at least every 6 h. */
  function recheckIn(next, now) {
    var until = next ? next.start - now + 60000 : CALENDAR_EVERY;
    return Math.min(CALENDAR_EVERY, Math.max(CALENDAR_SOONEST, until));
  }

  // ---------- The weekend strip ----------

  /** "FP1", "Quali", "SQ"…: OpenF1's session names, short enough for a chip. */
  function short(name) {
    if (name == null) { return 'Session'; }
    if (name.indexOf('Practice ') === 0) { return 'FP' + name.slice(9).trim(); }
    if (name === 'Sprint Qualifying' || name === 'Sprint Shootout') { return 'SQ'; }
    if (name === 'Qualifying') { return 'Quali'; }
    return name;
  }

  /**
   * The meeting's sessions in order, each DONE once started, the first still to come NEXT,
   * and the rest LATER.
   */
  function strip(sessions, now) {
    var nextGiven = false;
    return sessions.filter(function (s) { return s.start != null; })
      .sort(function (a, b) { return a.start - b.start; })
      .map(function (s) {
        var state = 'LATER';
        if (s.start <= now) {
          state = 'DONE';
        } else if (!nextGiven) {
          state = 'NEXT';
          nextGiven = true;
        }
        return { label: short(s.name), state: state, start: s.start, key: s.key };
      });
  }

  // ---------- Backdrops ----------

  /** Lower case without accents, so "Türkiye" meets "Turkiye" and "Portimão" "Portimao". */
  function fold(name) {
    return String(name).normalize('NFD').replace(/[\u0300-\u036f]+/g, '').toLowerCase().trim();
  }

  function unit(v) {
    return typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  }

  /*
   * assets/data/f1/backdrops.json: a photograph of each venue, chosen by hand from Wikimedia
   * Commons (tools/build-f1-backdrops.py). Most are keyed by OpenF1's circuit key; a circuit
   * back on the calendar from before OpenF1's records begin is found by the names its
   * sessions are likely to carry instead.
   */
  function parseBackdrops(input) {
    var o = typeof input === 'string' ? JSON.parse(input) : input;
    var all = o && o.backdrops && typeof o.backdrops === 'object' ? o.backdrops : {};
    var byKey = {};
    var named = [];
    var list = [];
    Object.keys(all).forEach(function (id) {
      var b = all[id];
      if (!b || typeof b.url !== 'string') { return; }
      var backdrop = {
        id: id,
        place: b.place || '',
        url: b.url,
        page: typeof b.page === 'string' ? b.page : null,
        credit: b.credit || 'Unknown',
        licence: b.licence || '',
        // Where across and down the picture (0 to 1) a screen's slice of it centres.
        focus: unit(b.focus),
        focusY: unit(b.focusY)
      };
      /** What you're looking at, and the credit its licence asks for. */
      backdrop.caption = backdrop.place + ' · Photo: ' + backdrop.credit + ', ' + backdrop.licence;
      list.push(backdrop);
      if (/^\d+$/.test(id)) { byKey[id] = backdrop; }
      var match = (Array.isArray(b.match) ? b.match : []).filter(function (n) { return typeof n === 'string'; }).map(fold);
      if (match.length) { named.push({ names: match, backdrop: backdrop }); }
    });
    return { byKey: byKey, named: named, all: list };
  }

  /** The picture for a session's venue: by its circuit key, else by its circuit, place or country. */
  function findBackdrop(backdrops, session) {
    if (!backdrops || !session) { return null; }
    if (session.circuitKey != null && backdrops.byKey[session.circuitKey]) { return backdrops.byKey[session.circuitKey]; }
    var names = [session.circuit, session.location, session.country].filter(Boolean).map(fold);
    for (var i = 0; i < backdrops.named.length; i++) {
      var entry = backdrops.named[i];
      if (entry.names.some(function (n) { return names.indexOf(n) >= 0; })) { return entry.backdrop; }
    }
    return null;
  }

  // ---------- Reminders ----------

  /** How long before a session its reminder comes. */
  var LEAD = 3600000;

  /** What sort of session it is, for choosing which to be reminded of. */
  var KINDS = { RACE: 'Race', SPRINT: 'Sprint', QUALIFYING: 'Qualifying', PRACTICE: 'Practice' };

  function kindOf(session) {
    var name = session.name || '';
    if (P.Format.isGrandPrix(session)) { return 'RACE'; }
    if (name === 'Sprint') { return 'SPRINT'; }
    if (name.indexOf('Qualifying') >= 0 || name.indexOf('Shootout') >= 0) { return 'QUALIFYING'; }
    if (session.type === 'Practice') { return 'PRACTICE'; }
    return null;
  }

  /** The first session of a wanted kind (a Set of KINDS keys) whose reminder is still to come. */
  function due(sessions, now, kinds) {
    var best = null;
    sessions.forEach(function (s) {
      if (s.start == null || s.key == null || !kinds.has(kindOf(s)) || s.start - LEAD <= now) { return; }
      if (!best || s.start < best.start) { best = s; }
    });
    return best;
  }

  /** ["Qualifying in 1 hour", "United States Grand Prix · Austin — starts 22:00"], in the zone given (the browser's own without one). */
  function words(session, zone) {
    var start = session.start != null ? P.Format.clock(session.start, zone) : null;
    return [
      (session.name || 'Session') + ' in 1 hour',
      [P.Format.eventAndPlace(session), start ? 'starts ' + start : null].filter(Boolean).join(' — ')
    ];
  }

  // ---------- The weekend as an .ics file ----------

  /** How long a session runs when the server doesn't say: two hours for a grand prix, else one. */
  function endOf(session) {
    if (session.end != null && session.end > session.start) { return session.end; }
    return session.start + (P.Format.isGrandPrix(session) ? 2 : 1) * 3600000;
  }

  function stamp(t) {
    return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  function escapeText(t) {
    return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  function utf8Length(ch) {
    var c = ch.codePointAt(0);
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }

  /** A content line folded at 75 octets, as RFC 5545 asks, never inside a character. */
  function fold75(line) {
    var out = '';
    var used = 0;
    Array.from(line).forEach(function (ch) {
      var n = utf8Length(ch);
      if (used + n > 75) {
        out += '\r\n ';
        used = 1;
      }
      out += ch;
      used += n;
    });
    return out;
  }

  /**
   * Sessions as a calendar file any calendar app imports: each with its start and end in
   * UTC, so it lands at the right local time wherever it's opened, and an alert an hour
   * before. Each keeps the same UID however often it's added, so adding the weekend again
   * updates it rather than doubling it.
   */
  function ics(sessions, options) {
    var o = options || {};
    var now = o.now != null ? o.now : Date.now();
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//jeremy.ie//Pitwall//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];
    sessions.filter(function (s) { return s.start != null && s.key != null; }).forEach(function (s) {
      var name = s.name || 'Session';
      var event = P.Format.event(s);
      lines.push(
        'BEGIN:VEVENT',
        'UID:openf1-session-' + s.key + '@jeremy.ie',
        'DTSTAMP:' + stamp(now),
        'DTSTART:' + stamp(s.start),
        'DTEND:' + stamp(endOf(s)),
        'SUMMARY:' + escapeText('F1 ' + name + (event ? ' · ' + event : '')),
        'LOCATION:' + escapeText([s.circuit, s.country].filter(Boolean).join(', '))
      );
      if (o.url) {
        lines.push('DESCRIPTION:' + escapeText('Live timing: ' + o.url), 'URL:' + o.url);
      }
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:' + escapeText(name + ' in 1 hour'),
        'TRIGGER:-PT1H',
        'END:VALARM',
        'END:VEVENT'
      );
    });
    lines.push('END:VCALENDAR');
    return lines.map(fold75).join('\r\n') + '\r\n';
  }

  /** "f1-mexico-city-grand-prix.ics" */
  function icsName(session) {
    var slug = fold(P.Format.event(session) || 'weekend').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'f1-' + (slug || 'weekend') + '.ics';
  }

  P.Calendar = {
    upcoming: upcoming,
    recheckIn: recheckIn
  };

  P.Weekend = {
    short: short,
    strip: strip
  };

  P.Backdrops = {
    parse: parseBackdrops,
    find: findBackdrop,
    fold: fold
  };

  P.Reminders = {
    LEAD: LEAD,
    KINDS: KINDS,
    kindOf: kindOf,
    due: due,
    words: words
  };

  P.Ics = {
    build: ics,
    fileName: icsName
  };
}());
