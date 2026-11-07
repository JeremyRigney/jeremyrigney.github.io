/*
 * Pitwall: how the wall writes its figures, names its sessions and colours its teams.
 *
 * A port of Pocket Pitwall's wall/Format.kt, the helpers on data/Models.kt's Session and
 * Flag, and ui/theme/TeamColours.kt. Pure: nothing here touches the page, so it runs under
 * jsc in tests/pitwall/. Times are epoch milliseconds throughout; times of day are local
 * unless a zone is given.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var DASH = '—';

  // ---------- Flags ----------

  /* label: what race control calls it; word: what the wall says, short enough to read at a
     glance; mark: the lettering on the flag block; pulse: the urgent states' cadence (ms),
     red breathing slowly, as on the app. */
  var FLAGS = {
    GREEN: { label: 'Green flag', word: 'Green flag', mark: null, pulse: 0 },
    YELLOW: { label: 'Yellow flag', word: 'Yellow flag', mark: null, pulse: 1100 },
    VSC: { label: 'Virtual safety car', word: 'Virtual SC', mark: 'VSC', pulse: 1600 },
    SAFETY_CAR: { label: 'Safety car', word: 'Safety car', mark: 'SC', pulse: 1600 },
    RED: { label: 'Red flag', word: 'Red flag', mark: null, pulse: 3400 },
    CHEQUERED: { label: 'Chequered flag', word: 'Chequered', mark: null, pulse: 0 }
  };

  function flagState(name) {
    return Object.prototype.hasOwnProperty.call(FLAGS, name) ? name : null;
  }

  /** The states whose word pulses and whose wash breathes. Green and chequered sit still. */
  function urgent(state) {
    return state === 'YELLOW' || state === 'VSC' || state === 'SAFETY_CAR' || state === 'RED';
  }

  function neutralised(state) {
    return state === 'VSC' || state === 'SAFETY_CAR' || state === 'RED';
  }

  function flagWord(state) {
    return state && FLAGS[state] ? FLAGS[state].word : 'Standby';
  }

  /**
   * The line under the flag word: "In this lap" while the safety car is coming in, the
   * flagged sectors, or race control's own message — unless it just repeats the label.
   */
  function flagNote(flag) {
    if (!flag) { return ''; }
    if (flag.ending) { return 'In this lap'; }
    if (flag.sectors && flag.sectors.length) {
      return (flag.sectors.length > 1 ? 'Sectors ' : 'Sector ') + flag.sectors.join(', ');
    }
    var message = flag.message;
    if (message && message.trim()) {
      var text = message.slice(0, 1) + message.slice(1).toLowerCase();
      var label = FLAGS[flag.state] ? FLAGS[flag.state].label : '';
      return text.toLowerCase() === label.toLowerCase() ? '' : text;
    }
    return '';
  }

  // ---------- Sessions ----------

  /** The weekend's name, or the circuit's from a server that sends no meetings. */
  function event(session) {
    return session ? (session.meeting || session.circuit || null) : null;
  }

  /** The same, short enough for one line of a bar: "Bahrain GP". */
  function eventShort(session) {
    var name = event(session);
    return name ? name.replace('Grand Prix', 'GP') : null;
  }

  /**
   * Where, when the name doesn't already say: "Kuala Lumpur" for the 2026 Bahrain Grand
   * Prix, "Monza" for the Italian, nothing for Singapore's.
   */
  function place(session) {
    if (!session || !session.circuit || !session.meeting) { return null; }
    return session.meeting.toLowerCase().indexOf(session.circuit.toLowerCase()) >= 0 ? null : session.circuit;
  }

  /** The weekend's name with where it is: "Bahrain Grand Prix · Kuala Lumpur". */
  function eventAndPlace(session) {
    var parts = [event(session), place(session)].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }

  /** A grand prix or a sprint: OpenF1 gives both the type "Race". */
  function isRace(session) {
    return !!session && session.type === 'Race';
  }

  /** The grand prix alone — the only session the season's lap count belongs to. */
  function isGrandPrix(session) {
    return !!session && session.name === 'Race';
  }

  /** A session's name for one line of a bar: "FP1" for "Practice 1", the rest as given. */
  function sessionShort(name) {
    if (name == null) { return null; }
    var m = /^Practice (\d)$/.exec(name);
    if (m) { return 'FP' + m[1]; }
    return name === 'Sprint Qualifying' ? 'Sprint quali' : name;
  }

  // ---------- Figures ----------

  function fixed3(n) {
    return (Math.round(n * 1000) / 1000).toFixed(3);
  }

  function lapTime(seconds) {
    if (seconds == null) { return DASH; }
    var minutes = Math.floor(seconds / 60);
    var rest = seconds - minutes * 60;
    var text = fixed3(rest);
    // 59.9996 rounds up to "60.000"; carry it into the minute as Kotlin's %.3f can't.
    if (text === '60.000') { minutes += 1; text = '0.000'; }
    return minutes + ':' + (parseFloat(text) < 10 ? '0' : '') + text;
  }

  /** Sector splits are inside one lap, so they never need the minute. */
  function sectorTime(seconds) {
    return seconds == null ? '' : fixed3(seconds);
  }

  /**
   * A gap is seconds, or text such as "+1 LAP" for a lapped car. The leader's own gap is a
   * literal zero, which is noise in a column, so it reads as a dash.
   */
  function gap(value) {
    if (value == null) { return DASH; }
    if (typeof value === 'string') { return value.toLowerCase(); }
    return value === 0 ? DASH : '+' + fixed3(value);
  }

  /**
   * A figure as [faint, strong]: the part that hardly changes and the part the eye should
   * land on — the minute of a lap time, the plus on a gap.
   */
  function splitLap(seconds) {
    var text = lapTime(seconds);
    var colon = text.indexOf(':');
    return colon < 0 ? ['', text] : [text.slice(0, colon + 1), text.slice(colon + 1)];
  }

  function splitGap(value) {
    var text = gap(value);
    return typeof value === 'number' && text.charAt(0) === '+' ? ['+', text.slice(1)] : ['', text];
  }

  /**
   * "S 1-14 · M 15-32 · H 33-" — the whole race on one line. Up to currentLap only: a
   * replay's stints already know where they end, and showing that would give the strategy
   * away early. The stint the car is on is left open-ended.
   */
  function stintSummary(stints, currentLap) {
    var now = currentLap == null ? null : currentLap;
    return (stints || []).filter(function (s) {
      return now == null || s.lapStart == null || s.lapStart <= now;
    }).map(function (s) {
      var letter = s.compound ? s.compound.charAt(0).toUpperCase() : '?';
      var end = s.lapEnd != null && (now == null || s.lapEnd < now) ? s.lapEnd : null;
      var span = s.lapStart == null ? '' : ' ' + s.lapStart + '-' + (end == null ? '' : end);
      return letter + span;
    }).join(' · ');
  }

  function tyre(compound, age) {
    if (!compound) { return DASH; }
    var letter = compound.charAt(0).toUpperCase();
    return age == null ? letter : letter + ' ' + age;
  }

  /** The compound's colour role: soft, medium, hard, inter, wet, or none. */
  function tyreRole(compound) {
    switch (compound ? compound.charAt(0).toUpperCase() : '') {
      case 'S': return 'soft';
      case 'M': return 'medium';
      case 'H': return 'hard';
      case 'I': return 'inter';
      case 'W': return 'wet';
      default: return 'none';
    }
  }

  var clockFormats = {};

  function clockParts(t, zone, seconds) {
    var key = (zone || '') + (seconds ? 's' : '');
    if (!clockFormats[key]) {
      var options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
      if (seconds) { options.second = '2-digit'; }
      if (zone) { options.timeZone = zone; }
      clockFormats[key] = new Intl.DateTimeFormat('en-GB', options);
    }
    return clockFormats[key].format(t);
  }

  function clock(t, zone) {
    return t == null ? '' : clockParts(t, zone, false);
  }

  function clockSeconds(t, zone) {
    return t == null ? '' : clockParts(t, zone, true);
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * Time to go, for a countdown: "2d 04:12:33" with days to go, "04:12:33" within a day,
   * "41:07" within the hour. With seconds false, to the minute: "2d 04:12", "4h 12m", "41m".
   */
  function countdown(ms, seconds) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(total / 86400);
    var h = Math.floor(total % 86400 / 3600);
    var m = Math.floor(total % 3600 / 60);
    var s = total % 60;
    if (seconds !== false) {
      if (d > 0) { return d + 'd ' + pad2(h) + ':' + pad2(m) + ':' + pad2(s); }
      if (h > 0) { return pad2(h) + ':' + pad2(m) + ':' + pad2(s); }
      return pad2(m) + ':' + pad2(s);
    }
    if (d > 0) { return d + 'd ' + pad2(h) + ':' + pad2(m); }
    if (h > 0) { return h + 'h ' + m + 'm'; }
    return m + 'm';
  }

  /** m:ss for a clip's elapsed time. */
  function minutesSeconds(seconds) {
    var whole = Math.max(0, Math.floor(seconds));
    return Math.floor(whole / 60) + ':' + pad2(whole % 60);
  }

  function degrees(value) {
    return value == null ? DASH : Math.round(value) + '°';
  }

  /** Where the wind blows from, as eight points: "NE" for 40°. */
  function compass(deg) {
    var points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return points[((Math.trunc((deg + 22.5) / 45) % 8) + 8) % 8];
  }

  // ---------- Race control's capitals ----------

  var KEEP_UPPER = { FIA: 1, VSC: 1, SC: 1, DRS: 1, DSQ: 1, DNF: 1, DNS: 1, NC: 1, TV: 1, CCTV: 1, FP1: 1, FP2: 1, FP3: 1 };

  /**
   * Race control writes in capitals. Read from across a room, a sentence in ordinary case
   * is quicker to take in, so it is lowered — except driver codes, the acronyms race
   * control uses, and the first letter of each sentence.
   */
  function sentence(text, codes) {
    var keep = codes || {};
    var lowered = String(text).replace(/[A-Za-z][A-Za-z0-9']*/g, function (w) {
      var upper = w.toUpperCase();
      if (KEEP_UPPER[upper] || keep[w] || (w.length === 3 && w === upper && /^[A-Z]+$/.test(w) && text.indexOf('(' + w + ')') >= 0)) {
        return w;
      }
      return w.toLowerCase();
    });
    var out = '';
    var start = true;
    for (var i = 0; i < lowered.length; i++) {
      var c = lowered.charAt(i);
      if (start && /\p{L}/u.test(c)) {
        out += c.toUpperCase();
        start = false;
        continue;
      }
      if (c === '.' || c === '!' || c === '?') {
        start = true;
      } else if (/[\p{L}\p{N}]/u.test(c)) {
        start = false;
      }
      out += c;
    }
    return out;
  }

  /** "Max VERSTAPPEN" → "Max Verstappen". */
  function titleCase(name) {
    return String(name).split(' ').map(function (part) {
      return part.length > 1 && part === part.toUpperCase() ? part.charAt(0) + part.slice(1).toLowerCase() : part;
    }).join(' ');
  }

  function driverLabel(driver) {
    return driver.code || '#' + driver.num;
  }

  /** Lap and sector times are compared to a thousandth, finer than timing is published. */
  function same(a, b) {
    return a != null && b != null && Math.abs(a - b) < 0.0005;
  }

  // ---------- Team colours ----------

  /*
   * Team colours arrive as bare hex digits. Several teams run a navy or a deep green that
   * all but disappears on this ground, so a colour darker than LIFT_L in OKLab has its
   * lightness raised to it, keeping its hue and as much chroma as sRGB can show. A light
   * colour comes back exactly as it went in. After Björn Ottosson's OKLab reference; the
   * same arithmetic as the app's TeamColours and the old wall's liftColour.
   */
  var LIFT_L = 0.62;
  var liftCache = {};

  function toLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function fromLinear(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function oklabToLinear(lightness, a, b) {
    var l = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = Math.pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
  }

  function outOfGamut(rgb) {
    return rgb.some(function (c) { return c < 0 || c > 1; });
  }

  function toHex(rgb) {
    return '#' + rgb.map(function (c) {
      var v = Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255);
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  }

  function liftColour(hex) {
    var rgb = [0, 2, 4].map(function (i) { return toLinear(parseInt(hex.substr(i, 2), 16) / 255); });
    var l = Math.cbrt(0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2]);
    var m = Math.cbrt(0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2]);
    var s = Math.cbrt(0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2]);
    var lightness = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    if (lightness >= LIFT_L) { return '#' + hex; }
    var a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    // Lighter at the same chroma can fall outside sRGB; give up chroma a little at a time
    // until it fits, rather than clipping a channel and shifting the hue.
    var out = oklabToLinear(LIFT_L, a, b);
    for (var i = 0; i < 24 && outOfGamut(out); i++) {
      a *= 0.94;
      b *= 0.94;
      out = oklabToLinear(LIFT_L, a, b);
    }
    return toHex(out);
  }

  /** A team colour as it should be drawn on the ground: "#rrggbb", or null for anything
      that is not six hex digits. */
  function teamColour(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{6}$/.test(hex)) { return null; }
    var key = hex.toLowerCase();
    if (!liftCache[key]) { liftCache[key] = liftColour(key); }
    return liftCache[key];
  }

  P.Format = {
    DASH: DASH,
    FLAGS: FLAGS,
    flagState: flagState,
    urgent: urgent,
    neutralised: neutralised,
    flagWord: flagWord,
    flagNote: flagNote,
    event: event,
    eventShort: eventShort,
    place: place,
    eventAndPlace: eventAndPlace,
    isRace: isRace,
    isGrandPrix: isGrandPrix,
    sessionShort: sessionShort,
    lapTime: lapTime,
    sectorTime: sectorTime,
    gap: gap,
    splitLap: splitLap,
    splitGap: splitGap,
    stintSummary: stintSummary,
    tyre: tyre,
    tyreRole: tyreRole,
    clock: clock,
    clockSeconds: clockSeconds,
    countdown: countdown,
    minutesSeconds: minutesSeconds,
    degrees: degrees,
    compass: compass,
    sentence: sentence,
    driverLabel: driverLabel,
    titleCase: titleCase,
    same: same,
    teamColour: teamColour
  };
}());
