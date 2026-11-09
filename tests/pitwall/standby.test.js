/* WeekendTest, RemindersTest and BackdropsTest from Pocket Pitwall; the calendar and .ics are the page's own. */
(function () {
  var Weekend = Pitwall.Weekend;
  var Reminders = Pitwall.Reminders;
  var Backdrops = Pitwall.Backdrops;
  var Calendar = Pitwall.Calendar;
  var Ics = Pitwall.Ics;
  var F = Pitwall.Format;
  var at = Pitwall.Parse.instant;

  function session(key, name, type, start, more) {
    var s = { key: key, name: name, type: type, circuit: null, circuitKey: null, location: null, country: null,
      start: at(start), end: null, meeting: null, meetingKey: null };
    for (var k in more || {}) { s[k] = more[k]; }
    return s;
  }

  // ---------- The weekend strip ----------

  // The 2026 Mexico City weekend, in UTC.
  function mexico(key, name, start) {
    return session(key, name, null, start, { circuit: 'Mexico City', circuitKey: 65, meeting: 'Mexico City Grand Prix', meetingKey: 1300 });
  }
  var weekend = [
    mexico(5, 'Race', '2026-11-01T20:00:00Z'),
    mexico(1, 'Practice 1', '2026-10-30T18:30:00Z'),
    mexico(2, 'Practice 2', '2026-10-30T22:00:00Z'),
    mexico(3, 'Practice 3', '2026-10-31T17:30:00Z'),
    mexico(4, 'Qualifying', '2026-10-31T21:00:00Z')
  ];
  function states(chips) { return chips.map(function (c) { return c.state; }); }

  test('session names are shortened for a chip', function () {
    eq(['Practice 1', 'Practice 2', 'Practice 3', 'Qualifying', 'Sprint Qualifying', 'Sprint Shootout', 'Sprint', 'Race', 'Day 1', null].map(Weekend.short),
      ['FP1', 'FP2', 'FP3', 'Quali', 'SQ', 'SQ', 'Sprint', 'Race', 'Day 1', 'Session']);
  });

  test('the strip runs in order with what has run ticked and only the next lit', function () {
    var raceDay = Weekend.strip(weekend, at('2026-11-01T17:40:00Z'));
    eq(raceDay.map(function (c) { return c.label; }), ['FP1', 'FP2', 'FP3', 'Quali', 'Race']);
    eq(states(raceDay), ['DONE', 'DONE', 'DONE', 'DONE', 'NEXT']);
    var friday = Weekend.strip(weekend, at('2026-10-30T20:00:00Z'));
    eq(states(friday), ['DONE', 'NEXT', 'LATER', 'LATER', 'LATER']);
  });

  test('a session counts as run the moment it starts', function () {
    var lightsOut = Weekend.strip(weekend, at('2026-11-01T20:00:00Z'));
    eq(lightsOut[lightsOut.length - 1].state, 'DONE');
    eq(states(lightsOut).indexOf('NEXT'), -1);
  });

  // ---------- What's next ----------

  test('the next session and its whole weekend, from both years, each once', function () {
    var abuDhabi = session(9, 'Race', 'Race', '2026-12-06T13:00:00Z', { meetingKey: 1302 });
    var testing = session(10, 'Day 1', 'Practice', '2027-02-24T07:00:00Z', { meetingKey: 1400 });
    var listed = weekend.concat([abuDhabi, testing, weekend[0], session(11, 'Race', 'Race', null)]);
    var plan = Calendar.upcoming(listed, at('2026-10-31T19:00:00Z'));
    eq(plan.next.key, 4);
    eq(plan.weekend.map(function (s) { return s.key; }), [1, 2, 3, 4, 5]);
    eq(plan.sessions.map(function (s) { return s.key; }), [4, 5, 9, 10]);
    // A session with no meeting stands alone.
    var bare = Calendar.upcoming([session(12, 'Race', 'Race', '2027-03-07T05:00:00Z')], at('2027-01-01T00:00:00Z'));
    eq(bare.weekend.length, 1);
    isNull(Calendar.upcoming(weekend, at('2026-11-02T00:00:00Z')).next);
  });

  test('the calendar is read again as the next session starts, at least every 6 h', function () {
    var now = at('2026-11-01T19:00:00Z');
    eq(Calendar.recheckIn(weekend[0], now), 3600000 + 60000);
    eq(Calendar.recheckIn(weekend[0], at('2026-11-01T20:00:30Z')), 60000);
    eq(Calendar.recheckIn(weekend[1], now - 30 * 86400000), 6 * 3600000);
    eq(Calendar.recheckIn(null, now), 6 * 3600000);
  });

  test('the live wall needs signing in from a day before a session to an hour after it', function () {
    eq(Calendar.liveSoon(weekend, at('2026-10-29T18:00:00Z')), false);
    eq(Calendar.liveSoon(weekend, at('2026-10-29T18:30:00Z')), true);
    // Between Friday and Saturday, the next session is under a day off.
    eq(Calendar.liveSoon(weekend, at('2026-10-31T03:00:00Z')), true);
    // No end listed: three hours after the start, and an hour more.
    eq(Calendar.liveSoon(weekend, at('2026-11-01T23:59:00Z')), true);
    eq(Calendar.liveSoon(weekend, at('2026-11-02T00:01:00Z')), false);
    var ended = [session(1, 'Race', 'Race', '2026-11-01T20:00:00Z', { end: at('2026-11-01T21:40:00Z') })];
    eq(Calendar.liveSoon(ended, at('2026-11-01T22:39:00Z')), true);
    eq(Calendar.liveSoon(ended, at('2026-11-01T22:41:00Z')), false);
    eq(Calendar.liveSoon([], at('2026-11-01T20:00:00Z')), false);
    eq(Calendar.liveSoon(null, at('2026-11-01T20:00:00Z')), false);
  });

  // ---------- Reminders ----------

  // The 2026 US GP weekend, in UTC as OpenF1 lists it.
  function austin(key, name, type, start) {
    return session(key, name, type, start, { circuit: 'Austin', circuitKey: 9, meeting: 'United States Grand Prix' });
  }
  var us = [
    austin(1, 'Practice 1', 'Practice', '2026-10-23T17:30:00Z'),
    austin(2, 'Sprint Qualifying', 'Qualifying', '2026-10-23T21:30:00Z'),
    austin(3, 'Sprint', 'Race', '2026-10-24T17:00:00Z'),
    austin(4, 'Qualifying', 'Qualifying', '2026-10-24T21:00:00Z'),
    austin(5, 'Race', 'Race', '2026-10-25T20:00:00Z')
  ];
  var all = new Set(Object.keys(Reminders.KINDS));

  test('sessions are sorted into kinds', function () {
    eq(us.map(Reminders.kindOf), ['PRACTICE', 'QUALIFYING', 'SPRINT', 'QUALIFYING', 'RACE']);
    eq(Reminders.kindOf(session(9, 'Day 1', 'Practice', '2027-02-24T07:00:00Z')), 'PRACTICE');
    eq(Reminders.kindOf(session(9, 'Sprint Shootout', 'Qualifying', '2023-04-29T10:30:00Z')), 'QUALIFYING');
  });

  test('the next reminder is the first of a wanted kind still to come', function () {
    eq(Reminders.due(us, at('2026-10-22T12:00:00Z'), all).key, 1);
    // Within FP1's hour its reminder has passed: the next is sprint qualifying's.
    eq(Reminders.due(us, at('2026-10-23T16:45:00Z'), all).key, 2);
    // Only races and qualifying wanted.
    eq(Reminders.due(us, at('2026-10-23T22:00:00Z'), new Set(['RACE', 'QUALIFYING'])).key, 4);
    isNull(Reminders.due(us, at('2026-10-25T19:30:00Z'), all));
  });

  test('the words give the start in the reader’s own time', function () {
    var race = us[4];
    // Irish clocks go back that very morning, so the race is at 20:00 in Dublin, not 21:00.
    eq(Reminders.words(race, 'Europe/Dublin'), ['Race in 1 hour', 'United States Grand Prix · Austin — starts 20:00']);
    // Practice on the Friday is still on Irish summer time.
    eq(Reminders.words(us[0], 'Europe/Dublin')[1], 'United States Grand Prix · Austin — starts 18:30');
    // The same race, for someone at the track.
    eq(Reminders.words(race, 'America/Chicago')[1], 'United States Grand Prix · Austin — starts 15:00');
  });

  test('countdowns', function () {
    var s = 1000;
    eq(F.countdown((2 * 86400 + 4 * 3600 + 12 * 60 + 33) * s), '2d 04:12:33');
    eq(F.countdown((4 * 3600 + 12 * 60 + 33) * s), '04:12:33');
    eq(F.countdown((41 * 60 + 7) * s), '41:07');
    eq(F.countdown(-5 * s), '00:00');
    eq(F.countdown((2 * 86400 + 4 * 3600 + 12 * 60 + 33) * s, false), '2d 04:12');
    eq(F.countdown((4 * 3600 + 12 * 60 + 33) * s, false), '4h 12m');
    eq(F.countdown(41 * 60 * s, false), '41m');
  });

  // ---------- Backdrops ----------

  var backdrops = Backdrops.parse(asset('backdrops.json'));

  function venue(key, circuit, country) {
    return session(1, 'Race', 'Race', null, { circuit: circuit, circuitKey: key, location: circuit, country: country });
  }

  test('every venue on the 2026 calendar has one', function () {
    // OpenF1's circuit keys for the 24 venues of 2026, pre-season testing included.
    [63, 10, 49, 46, 151, 23, 22, 15, 19, 2, 7, 4, 55, 39, 153, 144, 12, 61, 9, 65, 14, 152, 150, 70].forEach(function (key) {
      notNull(backdrops.byKey[key], 'circuit ' + key);
    });
  });

  test('the 2027 newcomers are found by key or by name', function () {
    eq(Backdrops.find(backdrops, venue(149, 'Jeddah', 'Saudi Arabia')).id, '149');
    // Portimão and Istanbul Park now have keys (147 and 59) the file doesn't carry.
    eq(Backdrops.find(backdrops, venue(147, 'Portimão', 'Portugal')).id, 'portimao');
    eq(Backdrops.find(backdrops, venue(59, 'Istanbul', 'Türkiye')).id, 'istanbul');
    // And with no key or an unknown one, however the name is spelled.
    eq(Backdrops.find(backdrops, venue(null, 'Portimao', 'Portugal')).id, 'portimao');
    eq(Backdrops.find(backdrops, venue(9999, 'Istanbul', 'Turkiye')).id, 'istanbul');
  });

  test('names only match venues listed by name', function () {
    // A country with several venues never matches by name: an unknown US circuit gets nothing.
    isNull(Backdrops.find(backdrops, venue(null, 'Somewhere New', 'United States')));
    eq(Backdrops.find(backdrops, venue(null, 'Algarve International Circuit', 'Portugal')).id, 'portimao');
  });

  test('each is freely licensed, credited and framed', function () {
    var free = /^(CC0|Public domain|CC BY(-SA)? [0-9.]+)$/i;
    eq(backdrops.all.length, 27);
    backdrops.all.forEach(function (b) {
      ok(free.test(b.licence), b.id + ' licence ' + b.licence);
      ok(b.credit.trim().length > 0, b.id + ' credit');
      ok(b.url.indexOf('https://') === 0, b.id + ' url');
      ok(b.page && b.page.indexOf('https://commons.wikimedia.org/') === 0, b.id + ' page');
      ok(b.focus >= 0 && b.focus <= 1 && b.focusY >= 0 && b.focusY <= 1, b.id + ' focus');
    });
  });

  test('the caption says where and whose', function () {
    eq(backdrops.byKey[9].caption, 'Austin, Texas · Photo: Steve, CC BY-SA 2.0');
    // The app's horizontal framing is kept; a tall picture is framed for a wide screen too.
    eq(backdrops.byKey[150].focus, 0.27);
    eq(backdrops.byKey[12].focusY, 0.35);
    eq(backdrops.byKey[9].focusY, 0.5);
  });

  // ---------- The weekend as an .ics file ----------

  test('a calendar file of the weekend', function () {
    var text = Ics.build([us[4], austin(6, 'Sprint', 'Race', null)], { now: at('2026-10-20T09:30:15Z'), url: 'https://jeremy.ie/f1-wall.html' });
    var lines = text.split('\r\n');
    eq(lines[0], 'BEGIN:VCALENDAR');
    eq(lines[lines.length - 2], 'END:VCALENDAR');
    eq(lines[lines.length - 1], '');
    // Only sessions with a start; in UTC, two hours for a grand prix when the end isn't known.
    eq(text.split('BEGIN:VEVENT').length - 1, 1);
    ok(lines.indexOf('UID:openf1-session-5@jeremy.ie') > 0, 'uid');
    ok(lines.indexOf('DTSTAMP:20261020T093015Z') > 0, 'stamp');
    ok(lines.indexOf('DTSTART:20261025T200000Z') > 0, 'start');
    ok(lines.indexOf('DTEND:20261025T220000Z') > 0, 'end');
    ok(lines.indexOf('SUMMARY:F1 Race · United States Grand Prix') > 0, 'summary');
    ok(lines.indexOf('TRIGGER:-PT1H') > 0, 'alarm');
    ok(lines.indexOf('URL:https://jeremy.ie/f1-wall.html') > 0, 'url');
  });

  test('the server’s own end is used, and text is escaped', function () {
    var quali = austin(4, 'Qualifying', 'Qualifying', '2026-10-24T21:00:00Z');
    quali.end = at('2026-10-24T22:00:00Z');
    quali.country = 'United States';
    var lines = Ics.build([quali], { now: 0 }).split('\r\n');
    ok(lines.indexOf('DTEND:20261024T220000Z') > 0, 'end');
    ok(lines.indexOf('LOCATION:Austin\\, United States') > 0, 'location');
    eq(lines.filter(function (l) { return l.indexOf('URL:') === 0; }).length, 0);
  });

  test('long lines fold at 75 octets, never inside a character', function () {
    var long = session(7, 'Race', 'Race', '2027-04-25T13:00:00Z', {
      meeting: 'Grande Prémio de Portugal da Fórmula 1 no Autódromo Internacional do Algarve, Portimão',
      circuit: 'Portimão'
    });
    var text = Ics.build([long], { now: 0 });
    text.split('\r\n').forEach(function (line) {
      var bytes = unescape(encodeURIComponent(line)).length;
      ok(bytes <= 75, 'line of ' + bytes + ' octets: ' + line);
    });
    var unfolded = text.replace(/\r\n /g, '');
    ok(unfolded.indexOf('SUMMARY:F1 Race · Grande Prémio de Portugal da Fórmula 1 no Autódromo Internacional do Algarve\\, Portimão') >= 0, 'unfolds whole');
    eq(Ics.fileName(long), 'f1-grande-premio-de-portugal-da-formula-1-no-autodromo-internacional-do-algarve-portimao.ics');
    eq(Ics.fileName(weekend[0]), 'f1-mexico-city-grand-prix.ics');
  });
}());
