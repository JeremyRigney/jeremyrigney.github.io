/* FormatTest, SentenceCaseTest, TeamColoursTest and MeetingTest from Pocket Pitwall. */
(function () {
  var F = Pitwall.Format;

  test('lap times', function () {
    eq(F.lapTime(97.623), '1:37.623');
    eq(F.lapTime(65.0), '1:05.000');
    eq(F.lapTime(null), '—');
    eq(F.splitLap(97.623), ['1:', '37.623']);
  });

  test('gaps', function () {
    eq(F.gap(0), '—');
    eq(F.gap(1.2344), '+1.234');
    eq(F.gap('+1 LAP'), '+1 lap');
    eq(F.gap(null), '—');
    eq(F.splitGap(12.5), ['+', '12.500']);
    eq(F.splitGap('+1 LAP'), ['', '+1 lap']);
  });

  test('stints', function () {
    var stints = [
      { compound: 'SOFT', lapStart: 1, lapEnd: 14, age: 0 },
      { compound: 'MEDIUM', lapStart: 15, lapEnd: 32, age: 0 },
      { compound: 'HARD', lapStart: 33, lapEnd: null, age: 0 }
    ];
    eq(F.stintSummary(stints), 'S 1-14 · M 15-32 · H 33-');
    // Replaying lap 20: the medium's end and the hard are still in the future.
    eq(F.stintSummary(stints, 20), 'S 1-14 · M 15-');
    eq(F.tyre('SOFT', 12), 'S 12');
    eq(F.tyre(null, 3), '—');
  });

  test('local clock', function () {
    var t = Date.UTC(2026, 9, 11, 12, 45, 7);
    eq(F.clock(t, 'Europe/Dublin'), '13:45');
    eq(F.clockSeconds(t, 'Europe/Dublin'), '13:45:07');
    eq(F.minutesSeconds(65.9), '1:05');
  });

  test('race control reads in ordinary case', function () {
    eq(F.sentence('TURN 1 INCIDENT INVOLVING CAR 44 (HAM) NOTED - LEAVING THE TRACK AND GAINING AN ADVANTAGE'),
      'Turn 1 incident involving car 44 (HAM) noted - leaving the track and gaining an advantage');
    eq(F.sentence('VSC DEPLOYED'), 'VSC deployed');
    eq(F.sentence('FIA STEWARDS: CAR 4 (NOR) 5 SECOND TIME PENALTY'), 'FIA stewards: car 4 (NOR) 5 second time penalty');
  });

  // Expected values are the old wall's liftColour(), as the app's test has them.
  test('team colours match the website', function () {
    var expected = {
      '4781D7': '#4b85dc',
      'F47600': '#f47600',
      '229971': '#279c74',
      'E8002D': '#f42038',
      '27F4D2': '#27f4d2',
      '1868DB': '#3481f7',
      '00594F': '#4e9589',
      '000000': '#868686',
      'ffffff': '#ffffff'
    };
    Object.keys(expected).forEach(function (input) {
      eq(F.teamColour(input), expected[input], input);
    });
  });

  test('team colours reject anything but six hex digits', function () {
    isNull(F.teamColour(null));
    isNull(F.teamColour('#ffffff'));
    isNull(F.teamColour('fff'));
    isNull(F.teamColour('red; x'));
  });

  var sessions = Pitwall.Parse.sessions(fixture('sessions-meetings.json'));
  function session(key) {
    return sessions.filter(function (s) { return s.key === key; })[0];
  }

  test('weekends are named by their meeting', function () {
    // OpenF1 files the 2026 Bahrain Grand Prix under the circuit it was held at.
    var kl = session(11731);
    eq(F.event(kl), 'Bahrain Grand Prix');
    eq(kl.meetingKey, 1308);
    eq(F.eventShort(kl), 'Bahrain GP');
    eq(F.eventAndPlace(kl), 'Bahrain Grand Prix · Kuala Lumpur');
  });

  test('the place is left out when the name says it', function () {
    isNull(F.place(session(11388)));
    eq(F.eventAndPlace(session(11388)), 'Singapore Grand Prix');
    eq(F.eventAndPlace(session(11468)), 'Pre-Season Testing · Sakhir');
  });

  test('an older server falls back to the circuit', function () {
    var monza = session(11000);
    isNull(monza.meeting);
    eq(F.event(monza), 'Monza');
    isNull(F.place(monza));
    eq(F.eventAndPlace(monza), 'Monza');
  });

  test('session names shorten for the bar', function () {
    eq(F.sessionShort('Practice 1'), 'FP1');
    eq(F.sessionShort('Practice 3'), 'FP3');
    eq(F.sessionShort('Sprint Qualifying'), 'Sprint quali');
    eq(F.sessionShort('Race'), 'Race');
    eq(F.sessionShort('Day 3'), 'Day 3');
    isNull(F.sessionShort(null));
  });

  test('names in title case', function () {
    eq(F.titleCase('Max VERSTAPPEN'), 'Max Verstappen');
    eq(F.titleCase('Kimi ANTONELLI'), 'Kimi Antonelli');
    eq(F.titleCase('Oliver BEARMAN'), 'Oliver Bearman');
    eq(F.titleCase('A B'), 'A B');
  });

  test('wind from the compass', function () {
    eq(F.compass(0), 'N');
    eq(F.compass(22), 'N');
    eq(F.compass(23), 'NE');
    eq(F.compass(180), 'S');
    eq(F.compass(350), 'N');
    eq(F.compass(290), 'W');
  });

  test('flag words and notes', function () {
    eq(F.flagWord('VSC'), 'Virtual SC');
    eq(F.flagWord(null), 'Standby');
    eq(F.flagNote({ state: 'SAFETY_CAR', ending: true, sectors: [] }), 'In this lap');
    eq(F.flagNote({ state: 'YELLOW', sectors: [7] }), 'Sector 7');
    // Race control's message is the ticker's, never the note's.
    eq(F.flagNote({ state: 'RED', sectors: [], message: 'RED FLAG' }), '');
    eq(F.flagNote({ state: 'GREEN', sectors: [], message: 'CLEAR IN TRACK SECTOR 12' }), '');
  });
}());
