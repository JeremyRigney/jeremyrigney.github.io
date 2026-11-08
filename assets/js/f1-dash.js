/*
 * /f1-wall — the whole race in one window.
 *
 * This is a second view onto exactly the same composed frame /f1 and /f1-lab render. It
 * does not fetch anything itself: it exposes `window.f1Live.render`, which is the function
 * the lab's scrubber already calls, so f1-lab.js drives this page without knowing it is a
 * different page. That is the whole trick — the harness, the replay engine and the server
 * are shared, and only the drawing differs.
 *
 * Where /f1's panel is an editorial strip you scroll through, this is a fixed grid you read
 * at a glance from across a room: the map is the hero, the running order is a full-height
 * column, and nothing but the two feeds ever scrolls. The type is deliberately two or three
 * steps larger than the panel's throughout.
 *
 * Everything new the server sends — sector splits, the speed trap, weather, the parsed
 * penalty, the session bests — is treated as optional. The default API is the deployed one,
 * which will not have those fields until it is redeployed, and a wall that breaks when it
 * meets an older server is worse than one that quietly shows less.
 */

(function () {
  'use strict';

  var host = document.getElementById('live');
  if (!host) {
    return;
  }

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Cache-buster for assets/data, kept in step with f1-lab.js. */
  var DATA_V = '20261004';

  var FLAG_SLUG = {
    GREEN: 'green',
    YELLOW: 'yellow',
    VSC: 'vsc',
    SAFETY_CAR: 'safety-car',
    RED: 'red',
    CHEQUERED: 'chequered'
  };

  var FLAG_LABEL = {
    GREEN: 'Green flag',
    YELLOW: 'Yellow flag',
    VSC: 'Virtual safety car',
    SAFETY_CAR: 'Safety car',
    RED: 'Red flag',
    CHEQUERED: 'Chequered flag'
  };

  /* The same values as the --flag tokens in f1.css, for the one thing CSS cannot paint. */
  var FLAG_COLOUR = {
    green: '#3ecf78',
    yellow: '#f5c518',
    vsc: '#f5c518',
    'safety-car': '#f5c518',
    red: '#e8112d',
    chequered: '#f6f7f8'
  };

  /*
   * Race-control state that attaches to a car, for the wordings the penalty parser did not
   * recognise. When it did, the chip carries the actual penalty instead and these are the
   * fallback — see `marks()`.
   */
  var BADGE = {
    investigation: { mark: '!', label: 'Under investigation' },
    penalty: { mark: 'P', label: 'Penalty' },
    deletion: { mark: 'D', label: 'Lap time deleted' }
  };

  /*
   * The flag's cloth, as three frames of one wave. Each is the same shape — a top edge and
   * a parallel bottom edge 26 units below it, both one cubic — with the crest in a different
   * place, so SMIL can tween between them; the frames must keep identical commands for that.
   */
  var CLOTH = [
    'M4 4 C16 0 30 8 46 4 L46 30 C30 34 16 26 4 30 Z',
    'M4 4 C16 6 30 2 46 6 L46 32 C30 28 16 32 4 30 Z',
    'M4 4 C16 8 30 0 46 4 L46 30 C30 26 16 34 4 30 Z'
  ];

  /* What the safety car boards say, painted on the cloth. */
  var FLAG_MARK = {
    VSC: 'VSC',
    SAFETY_CAR: 'SC'
  };

  /* ---------- The markup ---------- */

  var TEMPLATE =
    '<div class="wall-status">' +
      '<div class="ws-flag">' +
        // The flag itself, waving beside the word. Coloured by --flag like everything else;
        // the chequered one swaps in the pattern, and the safety cars carry their board's
        // lettering, since in plain yellow they would read as one more yellow flag. Hidden
        // from screen readers: the word next to it already says all of this.
        '<svg class="ws-flag-icon" id="live-flag-icon" viewBox="0 0 48 40" aria-hidden="true">' +
          '<defs>' +
            '<pattern id="ws-checker" width="8" height="8" patternUnits="userSpaceOnUse">' +
              '<rect width="8" height="8" fill="#f6f7f8"/>' +
              '<rect width="4" height="4" fill="#111214"/>' +
              '<rect x="4" y="4" width="4" height="4" fill="#111214"/>' +
            '</pattern>' +
          '</defs>' +
          '<line class="ws-flag-pole" x1="3" y1="2" x2="3" y2="39"/>' +
          '<path class="ws-cloth" d="' + CLOTH[0] + '">' +
            '<animate attributeName="d" dur="1.4s" repeatCount="indefinite" ' +
              'values="' + CLOTH.concat(CLOTH[0]).join(';') + '"/>' +
          '</path>' +
          '<text class="ws-cloth-mark" id="live-flag-mark" x="25" y="17"></text>' +
        '</svg>' +
        '<div class="ws-flag-text">' +
          '<p class="ws-flag-word" id="live-state">—</p>' +
          '<p class="ws-flag-note" id="live-state-note"></p>' +
        '</div>' +
      '</div>' +
      '<div class="ws-tile">' +
        '<p class="ws-label">Lap</p>' +
        '<p class="ws-value" id="live-lap">—</p>' +
        // Laps to go, in a race whose length is known. The Wall's ring used to carry this
        // in its centre; it lives here so both tabs have it and the ring has room.
        '<p class="ws-sub" id="live-lap-sub" hidden></p>' +
      '</div>' +
      '<div class="ws-tile" id="ws-fastest" hidden>' +
        '<p class="ws-label">Fastest lap</p>' +
        '<p class="ws-value is-purple" id="live-fastest">—</p>' +
        '<p class="ws-sub" id="live-fastest-who"></p>' +
      '</div>' +
      '<div class="ws-tile" id="ws-weather" hidden>' +
        '<p class="ws-label">Air / track</p>' +
        '<p class="ws-value" id="live-weather">—</p>' +
        '<p class="ws-sub" id="live-weather-sub"></p>' +
      '</div>' +
      // Live mode only, and unhidden there. The timing feed runs ahead of every broadcast
      // of it, by a margin that depends on what you are watching on the day; typing that
      // margin in here holds the whole wall back to match, so it stops spoiling what is
      // about to happen on screen. Sits beside the session because the toolbar it would
      // otherwise belong to is hidden in live mode.
      '<div class="ws-tile ws-delay" id="ws-delay" hidden>' +
        '<p class="ws-label">Delay</p>' +
        '<label class="ws-delay-field">' +
          '<input id="live-delay" type="number" min="0" max="60" step="1" value="0" ' +
            'inputmode="numeric" aria-label="Delay in seconds" />' +
          '<span class="lab-unit">s</span>' +
        '</label>' +
      '</div>' +
      '<div class="ws-tile ws-session">' +
        '<p class="ws-label">Session</p>' +
        '<p class="ws-value-sm" id="live-session">Pick a session</p>' +
        // Live mode only; the replay clock in the toolbar says the same thing there.
        '<p class="ws-live" id="live-badge" hidden></p>' +
      '</div>' +
    '</div>' +

    '<div class="wall-body">' +
      '<div class="wall-left">' +
        // Map or Wall. The Wall replaces the map and the feed together — it carries the
        // latest race control in a corner card — and the timing tower stays either way.
        '<div class="wall-tabs" role="tablist" aria-label="View">' +
          '<button class="wall-tab" id="tab-map" type="button" role="tab" data-view="map" ' +
            'aria-selected="true" aria-controls="panel-map">Map</button>' +
          '<button class="wall-tab" id="tab-wall" type="button" role="tab" data-view="wall" ' +
            'aria-selected="false" aria-controls="panel-doom">Wall</button>' +
          '<button class="doom-ghosts" id="doom-ghosts" type="button" aria-pressed="false">' +
            'All ghosts</button>' +
          '<button class="doom-ghosts doom-stints" id="doom-stints" type="button" ' +
            'aria-expanded="false" aria-controls="stint-drawer">Stints</button>' +
        '</div>' +
        '<section class="panel panel-map" id="panel-map" role="tabpanel" aria-labelledby="tab-map">' +
          '<canvas class="wall-map" id="live-map" data-fill role="img" ' +
            'aria-label="Track map showing the current position of every car"></canvas>' +
          // Team radio, docked in the corner of the map. Stays hidden until a payload
          // actually carries a `radio` key, so an older server leaves no empty box behind.
          '<aside class="radio-dock" id="radio-dock" hidden aria-labelledby="radio-title">' +
            '<h2 class="radio-title visually-hidden" id="radio-title">Team radio</h2>' +
            '<div class="radio-head">' +
              '<button class="radio-arm" id="radio-arm" type="button" aria-pressed="false">' +
                '<i class="radio-dot" aria-hidden="true"></i>' +
                '<span id="radio-arm-label">Radio off</span>' +
              '</button>' +
              '<span class="radio-follow" id="radio-follow"></span>' +
              // Folds the recent clips away so the dock stops covering the track.
              '<button class="radio-toggle" id="radio-toggle" type="button" ' +
                'aria-expanded="false" aria-controls="radio-rows" ' +
                'aria-label="Show recent radio"><i aria-hidden="true"></i></button>' +
            '</div>' +
            // aria-hidden: the elapsed time ticks twice a second, which no screen reader
            // should be made to read. #radio-say announces each clip once instead.
            '<p class="radio-now" id="radio-now" aria-hidden="true" hidden></p>' +
            '<ol class="radio-rows" id="radio-rows"></ol>' +
            '<p class="visually-hidden" id="radio-say" aria-live="polite"></p>' +
          '</aside>' +
        '</section>' +
        '<section class="panel panel-feed">' +
          '<p class="panel-label">Race control</p>' +
          '<ol class="feed-rows" id="feed-rows"></ol>' +
        '</section>' +
        // The wall of doom: f1-doom.js draws the ring and fills the centre and the strip.
        '<section class="panel panel-doom" id="panel-doom" role="tabpanel" ' +
            'aria-labelledby="tab-wall">' +
          '<div class="doom-stage">' +
            '<canvas class="doom-ring" id="live-doom" role="img" aria-label="Every car ' +
              'placed round one lap by its gap to the leader, with where each would ' +
              'rejoin after a pit stop"></canvas>' +
            '<div class="doom-centre" id="doom-centre" aria-live="off"></div>' +
            // One card to a corner, filled by f1-doom.js; each stays hidden until it has
            // something true to say.
            '<div class="doom-cards" id="doom-cards">' +
              '<section class="doom-card dk-tl" id="doom-loss" hidden></section>' +
              '<section class="doom-card dk-tr" id="doom-free" hidden></section>' +
              '<section class="doom-card dk-bl" id="doom-legend" hidden></section>' +
              '<section class="doom-card dk-br" id="doom-feed" hidden></section>' +
            '</div>' +
          '</div>' +
          // Behind the Stints button: reference, not the focus of the tab.
          '<div class="stint-drawer" id="stint-drawer" hidden>' +
            '<p class="stint-head"><span>Tyre stints</span>' +
              '<button class="stint-close" type="button" aria-label="Close tyre stints">' +
              'Close</button></p>' +
            '<ol class="stint-strip" id="live-stints" aria-label="Tyre stints"></ol>' +
          '</div>' +
        '</section>' +
      '</div>' +

      '<section class="panel panel-timing">' +
        '<div class="timing-head" aria-hidden="true">' +
          '<span>Pos</span><span></span><span>Driver</span><span></span>' +
          '<span>Leader</span><span>Last lap</span><span></span><span>Tyre</span>' +
        '</div>' +
        '<ol class="timing-rows" id="timing-rows"></ol>' +
      '</section>' +
    '</div>';

  host.innerHTML = TEMPLATE;

  function el(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var node = el(id);
    if (node) {
      node.textContent = value;
    }
  }

  /* ---------- Formatting ---------- */

  function lapTime(seconds) {
    if (seconds === null || seconds === undefined) {
      return '—';
    }
    var minutes = Math.floor(seconds / 60);
    var rest = seconds - minutes * 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest.toFixed(3);
  }

  /* Sector splits are seconds inside one lap, so they never need the minute. */
  function sectorTime(seconds) {
    return (seconds === null || seconds === undefined) ? '' : seconds.toFixed(3);
  }

  /*
   * Gaps are floats, except when a car is lapped and they arrive as '+1 LAP'. The leader's
   * own gap is a literal zero, which is noise in a column of numbers, so it reads as a dash.
   */
  function gap(value) {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (value === 0) {
      return '—';
    }
    return '+' + value.toFixed(3);
  }

  /*
   * The same two figures as [faint, strong]: the part that hardly changes, and the part
   * the eye should land on. The minute of a lap time; the plus on a gap. Anything else —
   * a dash, a lapped car's '+1 LAP' — is all strong, since none of it is routine.
   */
  function splitLap(seconds) {
    var text = lapTime(seconds);
    var colon = text.indexOf(':');
    return colon < 0 ? ['', text] : [text.slice(0, colon + 1), text.slice(colon + 1)];
  }

  function splitGap(value) {
    var text = gap(value);
    return typeof value === 'number' && text.charAt(0) === '+'
      ? ['+', text.slice(1)] : ['', text];
  }

  /*
   * Writes a split figure into a node as a dimmed span and plain text. Skips the write when
   * nothing changed, and says whether it wrote — which is how a caller knows a value is new.
   */
  function writeSplit(node, parts) {
    if (!node) {
      return false;
    }
    if (node.textContent === parts[0] + parts[1] &&
        node.childElementCount === (parts[0] ? 1 : 0)) {
      return false;
    }
    node.textContent = '';
    if (parts[0]) {
      var dim = document.createElement('span');
      dim.className = 'dim';
      dim.textContent = parts[0];
      node.appendChild(dim);
    }
    node.appendChild(document.createTextNode(parts[1]));
    return true;
  }

  /*
   * Team colours arrive as bare hex digits and go straight into a style; check them.
   *
   * Then lift the dark ones. Several teams run a navy or a deep green that all but
   * disappears on this ground, so a colour darker than LIFT_L in OKLCH has its lightness
   * raised to it, keeping its hue and as much of its chroma as the screen can show. A light
   * colour comes back exactly as it went in. Everything team-coloured on the wall comes
   * through here — the tower's bar, the chips, and the map's dots via f1Live.teamColour —
   * so the correction is one place.
   */
  var LIFT_L = 0.62;
  var liftedColours = {};

  function teamColour(value) {
    if (!/^[0-9a-fA-F]{6}$/.test(value || '')) {
      return null;
    }
    var key = value.toLowerCase();
    if (!liftedColours[key]) {
      liftedColours[key] = liftColour(key);
    }
    return liftedColours[key];
  }

  /* sRGB <-> OKLab, after Björn Ottosson's reference implementation. */
  function toLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function fromLinear(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function oklabToLinear(L, a, b) {
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
  }

  function liftColour(hex) {
    var rgb = [0, 2, 4].map(function (i) {
      return toLinear(parseInt(hex.slice(i, i + 2), 16) / 255);
    });
    var l = Math.cbrt(0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2]);
    var m = Math.cbrt(0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2]);
    var s = Math.cbrt(0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2]);
    var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    if (L >= LIFT_L) {
      return '#' + hex;
    }
    var a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

    // Lighter at the same chroma can fall outside what sRGB can show; give up chroma a
    // little at a time until it fits, rather than clipping a channel and shifting the hue.
    var out = oklabToLinear(LIFT_L, a, b);
    for (var i = 0; i < 24 && out.some(function (c) { return c < 0 || c > 1; }); i += 1) {
      a *= 0.94;
      b *= 0.94;
      out = oklabToLinear(LIFT_L, a, b);
    }
    return '#' + out.map(function (c) {
      var byte = Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255);
      return (byte < 16 ? '0' : '') + byte.toString(16);
    }).join('');
  }

  /*
   * Lap and sector times are floats that came from the same source on both sides of the
   * comparison, so they ought to match exactly — but "ought to" is not worth a wrong purple,
   * and a thousandth is finer than timing is published to anyway.
   */
  function same(a, b) {
    return a !== null && a !== undefined && b !== null && b !== undefined
      && Math.abs(a - b) < 0.0005;
  }

  /* "S 1-14 · M 15-32 · H 33-" — the whole race on one line, hung off the tyre chip. */
  function stintSummary(stints) {
    if (!stints || !stints.length) {
      return '';
    }
    return stints.map(function (s) {
      var letter = (s.compound || '?').charAt(0).toUpperCase();
      var span = s.lapStart === null || s.lapStart === undefined ? '' :
        (' ' + s.lapStart + '-' + (s.lapEnd === null || s.lapEnd === undefined ? '' : s.lapEnd));
      return letter + span;
    }).join(' · ');
  }

  /* ---------- The flag ---------- */

  var currentFlag = null;

  function renderFlag(flag) {
    var state = (flag && flag.state) || 'GREEN';
    var slug = FLAG_SLUG[state] || 'green';

    if (slug !== currentFlag) {
      currentFlag = slug;
      // The whole page reads this: the perimeter glow, the flag word, the scrubber. See
      // the [data-flag] tokens in f1.css, which this page reuses rather than redefining.
      document.documentElement.setAttribute('data-flag', slug);

      var theme = document.querySelector('meta[name="theme-color"]');
      if (theme) {
        theme.setAttribute('content', slug === 'green' ? '#111214' : FLAG_COLOUR[slug]);
      }

      setText('live-flag-mark', FLAG_MARK[state] || '');

      // The cloth waves for the same states the word pulses for. Green is the race's
      // resting state and stays still, as does everything under reduced motion.
      var icon = el('live-flag-icon');
      if (icon && icon.pauseAnimations) {
        if (reducedMotion || slug === 'green') {
          icon.pauseAnimations();
        } else {
          icon.unpauseAnimations();
        }
      }
    }

    setText('live-state', FLAG_LABEL[state] || state);

    var note = '';
    if (flag && flag.ending) {
      // What a timing screen says while the safety car is called in but the race has not
      // yet gone green. The state itself deliberately does not change until it does.
      note = 'In this lap';
    } else if (flag && flag.sectors && flag.sectors.length) {
      note = 'Sector' + (flag.sectors.length > 1 ? 's ' : ' ') + flag.sectors.join(', ');
    } else if (flag && flag.message) {
      note = flag.message.charAt(0) + flag.message.slice(1).toLowerCase();
      // Race control's wording is often exactly the label already sitting beside it
      // ("RED FLAG"), and printing it twice says nothing.
      if (note.toUpperCase() === (FLAG_LABEL[state] || '').toUpperCase()) {
        note = '';
      }
    }
    setText('live-state-note', note);
  }

  /* ---------- The running order ---------- */

  var rows = {};       // driver number -> <li>
  var listNode = el('timing-rows');

  function buildRow() {
    var node = document.createElement('li');
    node.className = 'trow';
    node.innerHTML =
      '<span class="t-pos"></span>' +
      '<i class="t-bar"></i>' +
      // A button rather than a <b>: clicking a code follows that driver's radio. The CSS
      // resets it back to exactly what the <b> looked like, so the grid is unchanged.
      '<button class="t-code" type="button" aria-pressed="false"></button>' +
      '<span class="t-marks"></span>' +
      '<span class="t-gap"></span>' +
      '<span class="t-last"></span>' +
      '<span class="t-sectors"><i></i><i></i><i></i></span>' +
      '<span class="t-tyre"></span>';
    return node;
  }

  /*
   * The penalty chip, and the badges that did not become one.
   *
   * `penalty` is the parsed wording ("+5s", "DT") and is worth its own chip beside the code.
   * The bare "P" badge is then redundant and is dropped — but only when something has
   * actually replaced it, because an unfamiliar wording leaves the chip empty and the "P"
   * is then the only sign the driver has one at all.
   *
   * A penalty race control has said was served is not owed any more, so it drops off
   * entirely. The badge alone cannot express that — its contents are unchanged /f1
   * behaviour — which is why the server sends `penaltyServed` beside it.
   */
  function marks(node, driver) {
    node.textContent = '';

    if (driver.penalty) {
      var chip = document.createElement('i');
      chip.className = 'chip chip-penalty';
      chip.textContent = driver.penalty;
      chip.title = 'Penalty: ' + driver.penalty;
      node.appendChild(chip);
    }

    (driver.badges || []).forEach(function (name) {
      if (name === 'penalty' && (driver.penalty || driver.penaltyServed)) {
        return;
      }
      var spec = BADGE[name];
      if (!spec) {
        return;
      }
      var mark = document.createElement('i');
      mark.className = 'badge badge-' + name;
      mark.textContent = spec.mark;
      mark.title = spec.label;
      node.appendChild(mark);
    });
  }

  /*
   * The three sector bars.
   *
   * Purple for the session's best, green for the driver's own, plain otherwise — the
   * reading every timing screen uses. Both comparisons come off the payload, so a sector
   * only colours once the server has actually seen a faster one.
   */
  function sectors(node, driver, best) {
    var mine = driver.sectors || [];
    var myBest = driver.bestSectors || [];
    var sessionBest = (best && best.sectors) || [];
    var bars = node.children;

    for (var i = 0; i < 3; i += 1) {
      var value = mine[i];
      var bar = bars[i];
      bar.className = '';
      if (value === null || value === undefined) {
        bar.title = '';
        continue;
      }
      if (same(value, sessionBest[i])) {
        bar.className = 'is-purple';
      } else if (same(value, myBest[i])) {
        bar.className = 'is-green';
      } else {
        bar.className = 'is-set';
      }
      bar.title = 'Sector ' + (i + 1) + ' ' + sectorTime(value);
    }
  }

  function fillRow(node, driver, best) {
    node.querySelector('.t-pos').textContent = driver.pos === null ? '—' : driver.pos;

    var codeNode = node.querySelector('.t-code');
    codeNode.textContent = driver.code || ('#' + driver.num);
    markFollow(codeNode, driver.num, driver.code || ('#' + driver.num));

    var gapNode = node.querySelector('.t-gap');
    writeSplit(gapNode, splitGap(driver.gapToLeader));
    // The interval to the car ahead does not earn a column of its own at this width, but it
    // is the natural second question, so it hangs off the gap.
    gapNode.title = driver.name
      ? driver.name + ' — ' + (driver.team || '') + '\nInterval: ' + gap(driver.interval)
      : 'Interval: ' + gap(driver.interval);

    var lastNode = node.querySelector('.t-last');
    writeSplit(lastNode, splitLap(driver.lastLap));
    // Purple beats green: a session best is also a personal best, and only one can show.
    lastNode.classList.toggle('is-purple',
      !!(best && same(driver.lastLap, best.lap)));
    lastNode.classList.toggle('is-green',
      !(best && same(driver.lastLap, best.lap)) && same(driver.lastLap, driver.bestLap));

    var tyreNode = node.querySelector('.t-tyre');
    var compound = (driver.compound || '').charAt(0).toUpperCase();
    tyreNode.textContent = compound
      ? compound + (driver.tyreAge === null || driver.tyreAge === undefined
          ? '' : ' ' + driver.tyreAge)
      : '—';
    tyreNode.className = 't-tyre' + (compound ? ' tyre-' + compound.toLowerCase() : '');
    tyreNode.title = stintSummary(driver.stints);

    marks(node.querySelector('.t-marks'), driver);
    sectors(node.querySelector('.t-sectors'), driver, best);

    var colour = teamColour(driver.colour);
    node.querySelector('.t-bar').style.background = colour || 'transparent';

    node.classList.toggle('is-pit', !!driver.inPit);
    node.classList.toggle('is-out', !!driver.dnf);
    node.classList.toggle('is-fastest', !!(best && best.num === driver.num));
  }

  /*
   * Rows are built once and then reordered, never rebuilt: an overtake should read as two
   * cars swapping, not as the whole table blinking. Positions are animated with FLIP —
   * measure where each row is, move it, then transform it back to where it was and let the
   * transition carry it to its new home. Carried over from f1-live.js unchanged; it is the
   * best thing the original panel does.
   */
  function renderRows(drivers, best) {
    if (!listNode) {
      return;
    }

    var before = {};
    if (!reducedMotion) {
      Object.keys(rows).forEach(function (num) {
        before[num] = rows[num].getBoundingClientRect().top;
      });
    }

    drivers.forEach(function (driver) {
      var node = rows[driver.num];
      if (!node) {
        node = rows[driver.num] = buildRow();
        // Stamped once, so the delegated follow listener can read the driver back off a
        // row without reverse-mapping the `rows` dict on every click.
        node.dataset.num = driver.num;
      }
      fillRow(node, driver, best);
      // appendChild moves a node that is already in the list, so appending each row in the
      // new running order is all the reordering this needs.
      listNode.appendChild(node);
    });

    if (reducedMotion) {
      return;
    }

    Object.keys(rows).forEach(function (num) {
      var node = rows[num];
      var delta = before[num] === undefined ? 0 : before[num] - node.getBoundingClientRect().top;
      if (!delta) {
        return;
      }
      node.style.transition = 'none';
      node.style.transform = 'translateY(' + delta + 'px)';
      // Two frames: one to let the un-transitioned transform take, one to animate it away.
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          node.style.transition = '';
          node.style.transform = '';
        });
      });
    });
  }

  /* ---------- Race control ---------- */

  var feedShown = '';

  function renderFeed(events, byNumber) {
    var list = el('feed-rows');
    if (!list) {
      return;
    }

    // Rebuilt only when the newest entry changes — this list is static between events, and
    // re-rendering it on every scrubbed frame would fight text selection.
    var newest = (events && events.length) ? (events[0].t + '|' + events.length) : 'empty';
    if (newest === feedShown) {
      return;
    }
    feedShown = newest;
    list.textContent = '';

    if (!events || !events.length) {
      var empty = document.createElement('li');
      empty.className = 'feed-empty';
      empty.textContent = 'Nothing from race control yet.';
      list.appendChild(empty);
      return;
    }

    events.forEach(function (event) {
      var row = document.createElement('li');
      row.className = 'feed-row feed-' + event.severity
        + (event.type ? ' feed-type-' + event.type : '');

      var when = document.createElement('span');
      when.className = 'feed-time';
      when.textContent = event.t ? event.t.slice(11, 16) : '';
      if (event.lap) {
        when.title = 'Lap ' + event.lap;
      }

      var what = document.createElement('span');
      what.className = 'feed-text';

      // The cars a message names, as chips in their own team colours. The server has
      // shipped `drivers` on every event all along; nothing rendered it until now.
      (event.drivers || []).forEach(function (num) {
        var driver = byNumber[num];
        var chip = document.createElement('i');
        chip.className = 'feed-driver';
        chip.textContent = (driver && driver.code) || ('#' + num);
        var colour = driver && teamColour(driver.colour);
        if (colour) {
          chip.style.borderColor = colour;
        }
        what.appendChild(chip);
      });

      // textContent, not innerHTML: this is race control's prose arriving over the wire.
      what.appendChild(document.createTextNode(event.text));

      row.appendChild(when);
      row.appendChild(what);
      list.appendChild(row);
    });

    // Newest first, so the top is where the news is.
    list.scrollTop = 0;
  }

  /* ---------- Team radio ---------- */

  /*
   * Radio clips, docked in the corner of the map.
   *
   * Three things are going on here, and they are deliberately separate:
   *
   *   - the list, which is just a render of data.radio and follows renderFeed's rules;
   *   - the follow set, a stored preference about which drivers play by themselves;
   *   - the player, one <audio> element and a short queue in front of it.
   *
   * The hard part is none of those. It is that render() is called with a *whole snapshot*
   * every frame, and in replay the playhead can jump backwards, so "a new clip arrived"
   * has to be derived rather than observed. See radioSync.
   */

  // The clips the dock shows. Five, fixed: this is a "what did they just say" dock, and a
  // scrolling history in the corner of a map is not a thing anyone reads.
  var RADIO_ROWS = 5;
  // Clips allowed to wait behind the one playing. A burst longer than this loses its
  // oldest members — on a wall, freshness beats completeness, and what is dropped is still
  // sitting in the list a click away.
  var RADIO_QUEUE_MAX = 3;
  // Older than this when its turn comes and a clip is listed but not played. Comfortably
  // past the worst live latency (a 30s background poll plus a 60s delay setting).
  var RADIO_STALE_MS = 120000;
  // A clip that never reports itself finished must not wedge the queue behind it.
  var RADIO_TIMEOUT_MS = 60000;
  var RADIO_HOST = 'https://livetiming.formula1.com/';
  var RADIO_PREFS = 'f1-wall-radio';
  // A single silent sample. Playing this under a real click is what unlocks the element for
  // every later src, without any audible artefact.
  var RADIO_SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

  var radioSession = null;   // the session.key the state below belongs to
  var radioClock = 0;        // data.generated of the last frame, as ms
  var radioHeadMs = null;    // newest clip already considered; null means "not primed"
  var radioSeen = {};        // clip key -> 1
  var radioSeenN = 0;
  var radioShown = '';       // renderFeed's dedupe idiom, for the list DOM
  var radioQueue = [];       // waiting clips, oldest first
  var radioNow = null;       // the clip playing, or null
  var radioManual = false;   // the current clip came from a click
  var radioResume = false;   // replay playback was paused to play it
  var radioAudio = null;
  var radioState = 'off';    // 'off' | 'armed' | 'blocked'
  var radioTick = null;
  var radioGuard = null;
  var radioClips = [];       // the last payload, so a click can find a clip by key
  var radioDrivers = {};     // the frame's byNumber, for codes and colours

  /* ---------- Stored preferences ---------- */

  /*
   * Driver *numbers*, not codes: numbers are what every payload keys on, and a code only
   * exists for drivers entered in the session being watched. Kept globally rather than per
   * session — following Verstappen is a standing preference, not a fact about one race.
   */
  function loadPrefs() {
    // `open` is whether the dock's clip list is unfolded. Folded is the default: the list
    // sits over the track, and the head says enough to know radio is there.
    var blank = { v: 1, follow: [], audio: false, open: false };
    try {
      var raw = window.localStorage.getItem(RADIO_PREFS);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.follow)) {
        return blank;
      }
      return {
        v: 1,
        follow: parsed.follow.filter(function (n) { return typeof n === 'number'; }),
        audio: parsed.audio === true,
        open: parsed.open === true
      };
    } catch (error) {
      // Private browsing, disabled storage, or something else's key under ours.
      return blank;
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(RADIO_PREFS, JSON.stringify(prefs));
    } catch (error) {
      // Safari in private browsing throws on setItem. The preference is then good for
      // this page view only, which is better than the page falling over.
    }
  }

  var prefs = loadPrefs();

  function isFollowed(num) {
    return prefs.follow.indexOf(num) !== -1;
  }

  function markFollow(codeNode, num, code) {
    var on = isFollowed(num);
    codeNode.classList.toggle('is-followed', on);
    codeNode.setAttribute('aria-pressed', on ? 'true' : 'false');
    codeNode.title = (on ? 'Unfollow ' : 'Follow ') + code + '’s team radio';
  }

  function toggleFollow(num) {
    if (isFollowed(num)) {
      prefs.follow = prefs.follow.filter(function (n) { return n !== num; });
    } else {
      prefs.follow.push(num);
    }
    savePrefs();

    // Repainted here rather than left to the next frame: in paused replay there is no next
    // frame, and the click would look like it did nothing.
    Object.keys(rows).forEach(function (n) {
      var node = rows[n];
      var codeNode = node.querySelector('.t-code');
      markFollow(codeNode, Number(n), codeNode.textContent);
    });
    radioPaintHead();
  }

  /* ---------- The player ---------- */

  /*
   * One element for the whole page, and never a `crossorigin` attribute on it.
   *
   * The clips are served by Formula 1's own CDN with no Access-Control-Allow-Origin, so a
   * media element can play them only as an opaque resource. Setting crossorigin asks for a
   * CORS check that cannot succeed and turns every clip into a load error. It also means
   * there is no Web Audio route to these files at all, and no duration until metadata
   * arrives over the wire.
   */
  function radioElement() {
    if (!radioAudio) {
      radioAudio = document.createElement('audio');
      radioAudio.preload = 'none';
      radioAudio.setAttribute('playsinline', '');
      radioAudio.addEventListener('ended', radioEnded);
      radioAudio.addEventListener('error', radioEnded);
      radioAudio.addEventListener('loadedmetadata', radioPaintNow);
    }
    return radioAudio;
  }

  /*
   * Remote data going straight into a media src, so it is checked rather than trusted —
   * the same instinct as teamColour's hex test and apiBase's loopback rule.
   *
   * The http:// rewrite matters: such a URL is blocked as mixed content on the deployed
   * site but works fine over plain localhost, which is exactly the shape of bug that only
   * ever appears in production.
   */
  function radioSafeUrl(url) {
    var out = String(url || '').replace(/^http:\/\//i, 'https://');
    return out.indexOf(RADIO_HOST) === 0 ? out : null;
  }

  function clipKey(clip) {
    return clip.t + '|' + clip.num;
  }

  function clipMs(clip) {
    return Date.parse(clip.t) || 0;
  }

  /* Replay speed, read off the toolbar. Live mode has no toolbar, hence the short-circuit
   * first: the select is only display:none there, and it still reads 5x. */
  function replaySpeed() {
    var node = el('lab-speed');
    return node ? (parseFloat(node.value) || 1) : 1;
  }

  function autoplayAllowed() {
    return liveMode || replaySpeed() <= 1;
  }

  function radioSay(text) {
    setText('radio-say', text);
  }

  /* ---------- Arming ---------- */

  /*
   * Browsers will not play audio until the page has been interacted with, and a wall is a
   * page you open and walk away from. So arming is explicit, and it is done by playing a
   * silent sample inside the click: once this element has played once under a gesture,
   * later src swaps need no further permission.
   */
  function radioArm() {
    var audio = radioElement();
    audio.src = RADIO_SILENCE;
    var attempt;
    try {
      attempt = audio.play();
    } catch (error) {
      attempt = Promise.reject(error);
    }

    Promise.resolve(attempt).then(function () {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      radioState = 'armed';
      prefs.audio = true;
      savePrefs();
      radioPaintHead();
    }, function () {
      radioState = 'blocked';
      radioPaintHead();
    });
  }

  function radioDisarm() {
    radioStop();
    radioQueue.length = 0;
    radioState = 'off';
    prefs.audio = false;
    savePrefs();
    radioPaintHead();
  }

  /*
   * A wall reloaded overnight wants its sound back without anyone hunting for the button,
   * so a remembered preference arms on the first interaction of any kind. Only installed
   * when sound was actually wanted — silence stays silent until asked otherwise.
   */
  function radioAutoArm() {
    if (!prefs.audio) {
      return;
    }
    var once = function () {
      document.removeEventListener('pointerdown', once, true);
      document.removeEventListener('keydown', once, true);
      if (radioState === 'off') {
        radioArm();
      }
    };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('keydown', once, true);
  }

  /* ---------- Playback ---------- */

  function radioStart(clip, manual) {
    var url = radioSafeUrl(clip.url);
    if (!url) {
      return;
    }

    var audio = radioElement();
    radioNow = clip;
    radioManual = !!manual;
    audio.src = url;

    Promise.resolve(audio.play()).catch(function (error) {
      /*
       * Two very different failures arrive down this one path, and conflating them is a
       * trap: NotAllowedError is the browser refusing to play at all, which the dock has
       * to report and stop for. Anything else — overwhelmingly NotSupportedError from a
       * clip whose URL 404s — is one bad file, and must not take the radio down with it.
       * Treating a dead MP3 as a policy block silently ends autoplay for the rest of the
       * session.
       */
      if (error && error.name === 'NotAllowedError') {
        radioState = 'blocked';
        radioQueue.length = 0;
      }
      radioEnded();
    });

    window.clearTimeout(radioGuard);
    radioGuard = window.setTimeout(radioEnded, RADIO_TIMEOUT_MS);
    window.clearInterval(radioTick);
    radioTick = window.setInterval(radioPaintNow, 500);

    radioSay('Team radio, ' + radioCode(clip.num));
    radioPaintNow();
    radioMarkPlaying();
    radioPaintHead();
  }

  function radioStop() {
    if (!radioAudio) {
      return;
    }
    radioAudio.pause();
    try {
      radioAudio.removeAttribute('src');
      radioAudio.load();
    } catch (error) {
      // Nothing to unload.
    }
  }

  function radioEnded() {
    window.clearTimeout(radioGuard);
    window.clearInterval(radioTick);
    radioGuard = null;
    radioTick = null;

    var wasManual = radioManual;
    radioNow = null;
    radioManual = false;
    radioReleasePlayback();
    radioPaintNow();
    radioMarkPlaying();

    // A clip the user asked for does not drag the queue along behind it.
    if (!wasManual) {
      radioNext();
    } else {
      radioPaintHead();
    }
  }

  function radioNext() {
    if (radioNow || radioState !== 'armed') {
      return;
    }
    while (radioQueue.length) {
      var clip = radioQueue.shift();
      // Re-checked here as well as on arrival: a clip can go stale waiting behind two
      // long ones, and playing it then would be answering a question nobody still has.
      if (radioClock - clipMs(clip) <= RADIO_STALE_MS) {
        radioStart(clip, false);
        return;
      }
    }
    radioPaintHead();
  }

  function radioOffer(clip) {
    if (!radioSafeUrl(clip.url)) {
      return;
    }
    if (!isFollowed(clip.num) || !autoplayAllowed() || radioState !== 'armed') {
      return;
    }
    if (radioClock - clipMs(clip) > RADIO_STALE_MS) {
      return;
    }

    radioQueue.push(clip);
    while (radioQueue.length > RADIO_QUEUE_MAX) {
      radioQueue.shift();
    }
    radioNext();
  }

  /*
   * A click preempts whatever is playing and empties the queue.
   *
   * Resuming a backlog of auto clips after the one the user actually asked for would read
   * as the dock ignoring them, so the queue is dropped rather than held.
   */
  function radioPlayClip(clip) {
    radioQueue.length = 0;
    window.clearTimeout(radioGuard);
    radioStop();
    radioNow = null;

    // A click is a gesture, so it can arm the element as a side effect of using it.
    if (radioState !== 'armed') {
      radioState = 'armed';
      prefs.audio = true;
      savePrefs();
    }

    radioHoldPlayback();
    radioStart(clip, true);
  }

  /* ---------- Replay playback, held while a clip plays ---------- */

  /*
   * f1-lab.js owns the playhead; the only thing wanted from it is "are you playing", which
   * it publishes as data-playing on the play button. Clicking that button is then both the
   * pause and the resume, and its play() re-anchors from the current position, so a
   * twenty-second clip does not make the race leap when it ends.
   */
  function labPlaying() {
    var node = el('lab-play');
    return !!node && !node.disabled && node.dataset.playing === '1';
  }

  function radioHoldPlayback() {
    if (liveMode || !labPlaying()) {
      return;
    }
    radioResume = true;
    el('lab-play').click();
  }

  function radioReleasePlayback() {
    if (!radioResume) {
      return;
    }
    radioResume = false;
    var node = el('lab-play');
    if (node && !node.disabled && node.dataset.playing !== '1') {
      node.click();
    }
  }

  /* ---------- Painting ---------- */

  function radioCode(num) {
    var driver = radioDrivers[num];
    return (driver && driver.code) || ('#' + num);
  }

  function radioPaintHead() {
    var button = el('radio-arm');
    if (!button) {
      return;
    }

    var armed = radioState === 'armed';
    button.setAttribute('aria-pressed', armed ? 'true' : 'false');
    button.classList.toggle('is-blocked', radioState === 'blocked');
    setText('radio-arm-label',
      radioState === 'blocked' ? 'Audio blocked'
        : armed ? 'Radio on' : 'Radio off');
    button.title = radioState === 'blocked'
      ? 'The browser refused to play audio. Click a clip to try again.'
      : armed ? 'Mute followed drivers' : 'Play followed drivers automatically';

    var names = prefs.follow.map(radioCode);
    var summary = names.length
      ? (names.length > 2 ? names.slice(0, 2).join(' ') + ' +' + (names.length - 2)
          : names.join(' '))
      : 'Follow a code';
    // Said plainly rather than hidden: the toolbar starts at 5x, so in replay the honest
    // answer to "why is nothing playing" is usually the speed.
    if (armed && names.length && !autoplayAllowed()) {
      summary += ' · 1× only';
    }
    setText('radio-follow', summary);

    var dock = el('radio-dock');
    var toggle = el('radio-toggle');
    if (dock && toggle) {
      dock.classList.toggle('is-open', prefs.open);
      toggle.setAttribute('aria-expanded', prefs.open ? 'true' : 'false');
      toggle.setAttribute('aria-label', prefs.open ? 'Hide recent radio' : 'Show recent radio');
      toggle.title = prefs.open ? 'Hide recent radio' : 'Show recent radio';
    }
  }

  function radioPaintNow() {
    var node = el('radio-now');
    if (!node) {
      return;
    }
    if (!radioNow) {
      node.hidden = true;
      node.textContent = '';
      return;
    }

    var at = radioAudio ? radioAudio.currentTime : 0;
    var text = '▶ ' + radioCode(radioNow.num) + ' · ' + clock(at);
    // Duration is unknown until the file's metadata lands, and for a dead URL it never
    // does, so it is appended only once it is a real number.
    if (radioAudio && isFinite(radioAudio.duration) && radioAudio.duration > 0) {
      text += ' / ' + clock(radioAudio.duration);
    }
    node.hidden = false;
    node.textContent = text;
  }

  function clock(seconds) {
    var whole = Math.max(0, Math.floor(seconds || 0));
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }

  /* Cheap, and deliberately outside the list's rebuild guard, so the playing row can
   * change without the list being torn down under the pointer. */
  function radioMarkPlaying() {
    var list = el('radio-rows');
    if (!list) {
      return;
    }
    var key = radioNow ? clipKey(radioNow) : null;
    Array.prototype.forEach.call(list.children, function (row) {
      row.classList.toggle('is-playing', !!key && row.dataset.key === key);
    });
  }

  function radioBuildList(clips, byNumber) {
    var list = el('radio-rows');
    if (!list) {
      return;
    }
    list.textContent = '';

    if (!clips.length) {
      var empty = document.createElement('li');
      empty.className = 'radio-empty';
      empty.textContent = 'No radio yet.';
      list.appendChild(empty);
      return;
    }

    clips.slice(0, RADIO_ROWS).forEach(function (clip) {
      var row = document.createElement('li');
      row.className = 'radio-row';
      row.dataset.key = clipKey(clip);

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'radio-clip';

      var driver = byNumber[clip.num];
      var chip = document.createElement('i');
      chip.className = 'radio-code';
      chip.textContent = (driver && driver.code) || ('#' + clip.num);
      var colour = driver && teamColour(driver.colour);
      if (colour) {
        chip.style.borderColor = colour;
      }

      var when = document.createElement('span');
      when.className = 'radio-time';
      when.textContent = clip.t ? clip.t.slice(11, 16) : '';

      button.appendChild(chip);
      button.appendChild(when);
      button.title = 'Play team radio — '
        + ((driver && driver.name) || chip.textContent);
      row.appendChild(button);
      list.appendChild(row);
    });
  }

  /* ---------- Keeping up with the playhead ---------- */

  function radioReset(key) {
    radioRewind();
    radioSession = key;
    radioShown = '';
  }

  function radioRewind() {
    radioQueue.length = 0;
    window.clearTimeout(radioGuard);
    radioStop();
    radioNow = null;
    radioManual = false;
    radioResume = false;
    radioSeen = {};
    radioSeenN = 0;
    radioHeadMs = null;
    radioPaintNow();
  }

  /*
   * Which clips are new.
   *
   * Every frame carries the whole feed, so novelty is a watermark plus a seen set, not an
   * event. Two things make that harder than it sounds:
   *
   *   - the playhead can move backwards, by a scrub or a jump. That is detected on
   *     data.generated, which the server sets to the replay instant, rather than on the
   *     clips themselves — a rewind over a quiet stretch moves no clip at all but must
   *     still reset, or scrubbing forward again would replay everything in between.
   *   - the first frame of a session arrives with a full history behind it. It primes the
   *     watermark and plays nothing; otherwise loading a race at half distance would open
   *     with forty clips queued.
   */
  function radioSync(clips, data) {
    var key = (data.session && data.session.key) || null;
    if (key !== radioSession) {
      radioReset(key);
    }

    var now = Date.parse(data.generated) || Date.now();
    // A second of slack: the live clock is a server timestamp and can jitter backwards
    // between polls. A real rewind is always seconds.
    if (now < radioClock - 1000) {
      radioRewind();
    }
    radioClock = now;

    var fresh = [];
    if (radioHeadMs !== null) {
      clips.forEach(function (clip) {
        if (clipMs(clip) > radioHeadMs && !radioSeen[clipKey(clip)]) {
          fresh.push(clip);
        }
      });
    }

    clips.forEach(function (clip) {
      var id = clipKey(clip);
      if (!radioSeen[id]) {
        radioSeen[id] = 1;
        radioSeenN += 1;
      }
      var ms = clipMs(clip);
      if (radioHeadMs === null || ms > radioHeadMs) {
        radioHeadMs = ms;
      }
    });

    if (radioHeadMs === null) {
      radioHeadMs = 0;   // primed on a session with no clips yet
    }

    // The set only does work at the head — the watermark covers everything behind it — so
    // it can be dropped wholesale rather than pruned.
    if (radioSeenN > 800) {
      radioSeen = {};
      radioSeenN = 0;
    }

    // The payload is newest first; played in the order they were said.
    fresh.sort(function (a, b) { return clipMs(a) - clipMs(b); });
    fresh.forEach(radioOffer);
  }

  function renderRadio(clips, byNumber, data) {
    var dock = el('radio-dock');
    if (!dock) {
      return;
    }
    // An older server sends no `radio` key at all. Nothing appears, rather than an empty
    // box appearing over the map.
    if (!clips) {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;
    radioDrivers = byNumber;
    radioClips = clips;

    radioSync(clips, data);

    // renderFeed's rule: rebuild only when the head of the list actually moves, so the
    // list is not torn down under a pointer on every scrubbed frame.
    var stamp = clips.length ? (clips[0].t + '|' + clips.length) : 'empty';
    if (stamp !== radioShown) {
      radioShown = stamp;
      radioBuildList(clips, byNumber);
    }
    radioMarkPlaying();
    radioPaintHead();
  }

  /* ---------- Wiring ---------- */

  function radioBind() {
    var dock = el('radio-dock');
    if (dock) {
      dock.addEventListener('click', function (event) {
        var button = event.target.closest && event.target.closest('.radio-clip');
        if (button) {
          var key = button.parentNode.dataset.key;
          var clip = null;
          radioClips.forEach(function (c) {
            if (clipKey(c) === key) { clip = c; }
          });
          if (clip) {
            radioPlayClip(clip);
          }
          return;
        }
        if (event.target.closest && event.target.closest('#radio-arm')) {
          if (radioState === 'armed') {
            radioDisarm();
          } else {
            radioArm();
          }
          return;
        }
        if (event.target.closest && event.target.closest('#radio-toggle')) {
          prefs.open = !prefs.open;
          savePrefs();
          radioPaintHead();
        }
      });
      dock.addEventListener('keydown', radioSwallowKeys);
    }

    if (listNode) {
      // Delegated, because rows are reused and reordered by FLIP and never rebuilt — a
      // listener bound per row would have to be rebound on every overtake.
      listNode.addEventListener('click', function (event) {
        var code = event.target.closest && event.target.closest('.t-code');
        if (!code) {
          // Anywhere else on a row picks that car for the Wall's pit projection.
          var chosen = event.target.closest && event.target.closest('.trow');
          if (chosen && view === 'wall' && window.f1Doom) {
            window.f1Doom.select(Number(chosen.dataset.num));
          }
          return;
        }
        var row = code.closest('.trow');
        var num = row && Number(row.dataset.num);
        if (num || num === 0) {
          toggleFollow(num);
        }
      });
      listNode.addEventListener('keydown', radioSwallowKeys);
    }

    radioPaintHead();
    radioAutoArm();
  }

  /*
   * f1-lab.js binds keydown on document and only steps aside for a <select>, so Space on a
   * focused button here would both press it and toggle replay playback. This runs first on
   * the way up and stops that.
   */
  function radioSwallowKeys(event) {
    if (event.key !== ' ' && event.key !== 'Enter') {
      return;
    }
    if (event.target.closest && event.target.closest('button')) {
      event.stopPropagation();
    }
  }

  /* ---------- The status bar ---------- */

  /*
   * Total laps, which the timing feed does not carry.
   *
   * f1-circuit.js publishes window.f1Round on /f1, but neither the lab nor this page loads
   * it, so the count would show with no denominator. The season index has the number, and
   * f1-lab.js has already fetched that file for the map, so this is a cache hit.
   *
   * Matched on Formula 1's own circuit id rather than the name — the short names disagree
   * with our circuit names on a third of the calendar — and applied only to a race, since a
   * sprint is a third of the distance and would take the grand prix's lap count as a wrong
   * denominator.
   */
  var season = null;
  var seasonAsked = false;
  var lastLap = null;        // the last {session, current} drawn, so the count can be redrawn

  function loadSeason() {
    if (seasonAsked) {
      return;
    }
    seasonAsked = true;
    fetch('assets/data/f1/season-2026.json?v=' + DATA_V)
      .then(function (r) { return r.json(); })
      .then(function (index) {
        season = index;
        // The index lands after the first frame has already drawn, and scrubbing to one
        // instant draws exactly one frame — so without redrawing here the denominator
        // never appeared at all unless you happened to move the scrubber again.
        if (lastLap) {
          renderLap(lastLap.session, lastLap.current);
        }
        // The Wall's centre carries the same count, and is just as stuck without this.
        if (lastFrame) {
          renderDoom(lastFrame);
        }
      })
      .catch(function () { /* no denominator; the lap count still shows on its own */ });
  }

  /*
   * The season round this session is being run at.
   *
   * Keyed on Formula 1's own circuit id where there is one, because the short names
   * disagree with our circuit names on a third of the calendar. But `circuitKey` is not
   * always there: Madring is null in both the season index and the OpenF1 session, so a
   * key-only match loses the round entirely — and with it the lap count *and* the map. The
   * name fallback mirrors pointMap() in f1-lab.js:224-288 and is what resolves it.
   */
  function roundFor(session) {
    if (!season || !session) {
      return null;
    }
    var rounds = season.rounds || [];
    var i;

    if (session.circuitKey) {
      for (i = 0; i < rounds.length; i += 1) {
        if (rounds[i].circuitKey === session.circuitKey) {
          return rounds[i];
        }
      }
    }

    /*
     * Two name sources, because on a new circuit OpenF1 may carry neither. Madring during
     * FP1 reported `circuit_short_name` AND `circuit_key` as null, leaving `location` — the
     * city — as the only identifier on the session at all. Trying both costs nothing and is
     * the difference between drawing the track and reporting no geometry for it.
     */
    var names = [session.circuit, session.location];
    for (var n = 0; n < names.length; n += 1) {
      var wanted = String(names[n] || '').toLowerCase();
      if (!wanted) {
        continue;
      }
      for (i = 0; i < rounds.length; i += 1) {
        var round = rounds[i];
        if (String(round.locality || '').toLowerCase() === wanted
            || String(round.circuitName || '').toLowerCase().indexOf(wanted) >= 0
            || String(round.country || '').toLowerCase() === wanted) {
          return round;
        }
      }
    }
    return null;
  }

  /*
   * Only for a race: OpenF1 reports a sprint as session_type "Race", and a sprint is a
   * third of the distance, so the grand prix's lap count is the wrong denominator for it.
   */
  function totalLaps(session) {
    if (!session || session.name !== 'Race') {
      return null;
    }
    var round = roundFor(session);
    return (round && round.stats && round.stats.laps) || null;
  }

  /*
   * Point the map at this session's circuit.
   *
   * On the replay side f1-lab.js does this in pointMap(); in live mode that file is not
   * running at all, so without this the map would load no geometry and sit blank. Only
   * fires when the circuit actually changes — f1Map.use guards duplicates, but re-pointing
   * on every three-second poll is pointless work.
   */
  var pointedAt = null;

  function pointMap(session) {
    if (!window.f1Map || !session || !season) {
      return;
    }
    var round = roundFor(session);
    var geoId = round && round.geoId;
    if (geoId === pointedAt) {
      return;
    }
    pointedAt = geoId || null;

    if (geoId) {
      window.f1Map.use(geoId);
    } else if (typeof window.f1Map.unavailable === 'function') {
      // Only circuits on the current calendar ship geometry.
      window.f1Map.unavailable(session.circuit || 'this circuit');
    }
  }

  function renderLap(session, current) {
    lastLap = { session: session, current: current };
    var total = totalLaps(session);
    setText('live-lap', current ? (current + (total ? ' / ' + total : '')) : '—');

    // "Final lap" rather than "0 to go", and nothing once the leader is past the flag.
    var sub = el('live-lap-sub');
    if (sub) {
      var left = current && total ? total - current : -1;
      sub.hidden = left < 0;
      sub.textContent = left > 0 ? left + ' to go' : left === 0 ? 'Final lap' : '';
    }
  }

  function renderFastest(best, byNumber) {
    var tile = el('ws-fastest');
    if (!tile) {
      return;
    }
    if (!best || !best.lap) {
      tile.hidden = true;
      return;
    }
    tile.hidden = false;
    writeSplit(el('live-fastest'), splitLap(best.lap));
    var driver = byNumber[best.num];
    setText('live-fastest-who', driver ? (driver.code || ('#' + best.num)) : '');
  }

  function renderWeather(weather) {
    var tile = el('ws-weather');
    if (!tile) {
      return;
    }
    if (!weather || (weather.air === null && weather.track === null)) {
      tile.hidden = true;
      return;
    }
    tile.hidden = false;

    function deg(value) {
      return (value === null || value === undefined) ? '—' : Math.round(value) + '°';
    }
    setText('live-weather', deg(weather.air) + ' / ' + deg(weather.track));

    var parts = [];
    if (weather.wind !== null && weather.wind !== undefined) {
      parts.push('wind ' + weather.wind.toFixed(1));
    }
    parts.push(weather.rain ? 'rain' : 'dry');
    setText('live-weather-sub', parts.join(' · '));
  }

  /* ---------- Render ---------- */

  var shown = false;

  function reveal() {
    if (shown) {
      return;
    }
    shown = true;
    host.hidden = false;
    host.classList.add('is-live');
  }

  var lastFrame = null;

  function renderDoom(data) {
    if (!window.f1Doom) {
      return;
    }
    window.f1Doom.render(data, {
      totalLaps: totalLaps(data.session),
      // How fast the race clock runs until the next frame, so the ring turns between
      // polls: real time live, the replay speed while playing, still while paused.
      rate: liveMode ? 1 : (labPlaying() ? replaySpeed() : 0)
    });
  }

  function render(data) {
    reveal();
    loadSeason();

    var session = data.session || {};
    var best = data.best || null;

    // A lookup the feed and the fastest-lap tile both need, built once per frame.
    var byNumber = {};
    (data.drivers || []).forEach(function (driver) {
      byNumber[driver.num] = driver;
    });

    setText('live-session',
      (session.name || 'Session') + (session.circuit ? ' — ' + session.circuit : ''));

    renderLap(session, data.lap && data.lap.current);
    renderFlag(data.flag);
    renderFastest(best, byNumber);
    renderWeather(data.weather);
    renderRows(data.drivers || [], best);
    renderFeed(data.events || [], byNumber);
    // Not defaulted to []: an absent key means an older server, which the dock answers by
    // staying hidden rather than by showing an empty one.
    renderRadio(data.radio, byNumber, data);

    if (window.f1Map) {
      // Replay has f1-lab.js to point the map; live mode has nobody else to do it.
      pointMap(session);
      window.f1Map.render(data);
    }

    lastFrame = data;
    renderDoom(data);

    if (liveMode) {
      renderLiveBadge(data);
    }
  }

  /* ---------- Live mode ---------- */

  /*
   * `?live=1` turns the wall from a replay viewer into a live one.
   *
   * The two drivers are mutually exclusive rather than cooperative, and they are separated
   * without a line of change to f1-lab.js: that file opens main() with
   * `if (!el('lab-range')) { return; }`, and f1-wall.html loads this script *before* it, so
   * removing the scrubber here is enough to make the whole harness no-op. Everything below
   * is then the only thing asking the server for frames.
   *
   * Cadences are f1-live.js's, for the same reasons documented there: the server caches a
   * composed payload for two seconds, so polling faster only adds noise.
   */
  // Matched to the server's COMPOSE_TTL: polling faster than the payload cache just fetches
  // the same bytes again. This costs the server nothing upstream — the OpenF1 call rate is
  // set by the per-stream TTL table in f1_live.py, not by how often the page asks.
  var POLL_LIVE = 1500;
  var POLL_HIDDEN = 30000;     // tab in the background: keep the state warm, cheaply
  var POLL_IDLE = 60000;       // nothing running; just checking whether that has changed
  var POLL_ERROR = 10000;

  // The delay queue. Checked far more often than frames arrive, so a frame comes off it
  // when its time is up rather than when the next poll happens to land — which is what
  // keeps the delay honest after the cadence backs off to POLL_HIDDEN or POLL_IDLE.
  var FLUSH_MS = 500;
  var DELAY_MAX = 60;

  var DEFAULT_API = 'https://irishrail-api-737590149980.europe-west1.run.app';

  var liveMode = new URLSearchParams(window.location.search).get('live') === '1';
  var sawLive = false;

  /*
   * A local API override, for developing against a Flask server on this machine. Restricted
   * to loopback on purpose: an arbitrary origin here would let a crafted link feed the page
   * its content from somewhere else entirely. Same rule as f1-live.js and f1-lab.js.
   */
  function apiBase() {
    var override = new URLSearchParams(window.location.search).get('api');
    if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override)) {
      return override.replace(/\/$/, '');
    }
    return DEFAULT_API;
  }

  function renderLiveBadge(data) {
    var node = el('live-badge');
    if (!node) {
      return;
    }
    node.hidden = false;
    var stamp = data && data.generated ? new Date(data.generated) : new Date();
    // `generated` is the frame's own time, so a delayed frame dates itself correctly with
    // no arithmetic here. The margin is still worth naming: a wall deliberately held a
    // minute behind looks exactly like a wall that has stopped updating.
    node.textContent = 'LIVE · ' + stamp.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) + (delayMs > 0 ? ' · −' + Math.round(delayMs / 1000) + 's' : '');
    node.classList.toggle('is-stale', !!(data && data.stale));
  }

  /*
   * Nothing on track. Said plainly and then polled for slowly, so a page left open before a
   * session picks it up on its own rather than needing a reload — which is the whole point
   * of leaving it open on a Friday morning. Any frame already drawn is left underneath: the
   * final order of the session that just ended is worth more than a blank page.
   */
  function renderIdle(data) {
    var node = el('live-badge');
    if (node) {
      node.hidden = false;
      node.textContent = sawLive ? 'SESSION OVER' : 'NO SESSION RUNNING';
      node.classList.remove('is-stale');
    }
    if (!sawLive) {
      reveal();
      setText('live-session', (data && data.reason) ? String(data.reason) : 'Waiting for a session');
      setText('live-state', 'Standby');
      setText('live-state-note', 'The panel will fill in by itself when one starts');
    }
  }

  /* ---------- The delay queue ---------- */

  /*
   * Every frame the server hands over is parked here for `delayMs` before it is drawn. The
   * point is the broadcast: the timing feed is ahead of any picture of it, so a wall fed
   * straight from the feed announces the overtake before you see it. Held back by however
   * much your stream is behind, it stops doing that.
   *
   * Frames are stamped on arrival rather than by their own `generated`, which makes the
   * delay mean "this many seconds behind what this browser knows". That is the thing being
   * matched against a picture on another screen, and it stays true regardless of clock skew
   * between here and the server, or of how far behind the feed itself is running. Delaying
   * by `generated` would instead double up the server's own lag and drift with the clock.
   */
  var queue = [];        // { at, data, idle }, oldest first
  var delayMs = 0;

  /*
   * Draw everything whose time has come, but only the last of them. Skipped frames cost
   * nothing: a payload is a snapshot of the latest value of every stream rather than a
   * delta — driver rows carry no timestamp of their own, and `events` is a rolling window —
   * so the newest eligible frame already contains everything the ones behind it said. This
   * is also what the page has always done whenever a poll was slow.
   */
  function flush() {
    var due = null;
    var now = Date.now();
    while (queue.length && queue[0].at + delayMs <= now) {
      due = queue.shift();
    }
    if (!due) {
      return;
    }
    if (due.idle) {
      renderIdle(due.data);
    } else {
      render(due.data);
    }
  }

  function setDelay(seconds) {
    var value = Math.round(Number(seconds));
    if (!isFinite(value) || value < 0) {
      value = 0;                                   // blank, negative or not a number
    }
    delayMs = Math.min(value, DELAY_MAX) * 1000;
    // Lowering it should catch up now, not at the next poll. Raising it leaves the frame on
    // screen until the queue has filled to the new depth, which the badge accounts for.
    flush();
  }

  function schedule(ms) {
    window.setTimeout(tick, ms);
  }

  function tick() {
    fetch(apiBase() + '/f1/live', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok && response.status !== 502) {
          throw new Error('HTTP ' + response.status);
        }
        return response.json();
      })
      .then(function (data) {
        var live = !!(data && data.live);
        queue.push({ at: Date.now(), data: data, idle: !live });
        flush();
        // Cadence follows the frame that just arrived, not the one being drawn: a session
        // that has ended should start polling slowly straight away, even while the last of
        // it is still playing out on screen.
        if (live) {
          sawLive = true;
          schedule(document.hidden ? POLL_HIDDEN : POLL_LIVE);
        } else {
          schedule(document.hidden ? POLL_HIDDEN : POLL_IDLE);
        }
      })
      .catch(function () {
        // Keep whatever is on screen; a dropped poll is not worth blanking the order for.
        schedule(POLL_ERROR);
      });
  }

  if (liveMode) {
    document.documentElement.setAttribute('data-live', '1');
    // The scrubber's removal is what switches f1-lab.js off. Must happen before that file
    // runs, which the script order in f1-wall.html guarantees.
    var range = el('lab-range');
    if (range) {
      range.parentNode.removeChild(range);
    }
    loadSeason();

    // The delay tile. Hidden in the markup so replay mode never shows a control that
    // would do nothing there.
    var delayTile = el('ws-delay');
    if (delayTile) {
      delayTile.hidden = false;
    }
    var delayInput = el('live-delay');
    if (delayInput) {
      setDelay(delayInput.value);
      delayInput.addEventListener('input', function () {
        setDelay(delayInput.value);
      });
    }
    window.setInterval(flush, FLUSH_MS);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        tick();
      }
    });
    tick();
  }

  /* ---------- Map or Wall ---------- */

  /*
   * Which view the left of the wall shows. `?view=wall` wins, so a link can open straight
   * onto it; otherwise the last choice made in this browser, then the map.
   */
  var VIEW_PREF = 'f1-wall-view';
  var view = 'map';
  var picked = null;       // the car the Wall is projecting a stop for, mirrored on its row

  function setView(next, remember) {
    view = next === 'wall' ? 'wall' : 'map';
    host.setAttribute('data-view', view);
    ['map', 'wall'].forEach(function (name) {
      var tab = el('tab-' + name);
      if (tab) {
        tab.setAttribute('aria-selected', name === view ? 'true' : 'false');
      }
    });
    if (remember) {
      try {
        window.localStorage.setItem(VIEW_PREF, view);
      } catch (error) { /* private window: the choice lasts for this page only */ }
    }
    if (window.f1Doom) {
      window.f1Doom.show(view === 'wall');
    }
    // The map's canvas was display:none and kept its old size; tell it to measure again.
    if (view === 'map') {
      window.dispatchEvent(new Event('resize'));
    }
    Object.keys(rows).forEach(function (num) {
      rows[num].classList.toggle('is-picked', view === 'wall' && Number(num) === picked);
    });
  }

  if (window.f1Doom) {
    window.f1Doom.onSelect(function (num) {
      picked = num;
      Object.keys(rows).forEach(function (key) {
        rows[key].classList.toggle('is-picked', view === 'wall' && Number(key) === num);
      });
    });
  }

  (function () {
    var tabs = host.querySelector('.wall-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (event) {
        var tab = event.target.closest && event.target.closest('.wall-tab');
        if (tab) {
          setView(tab.dataset.view, true);
        }
      });
      // Space on a focused tab would otherwise also toggle replay playback.
      tabs.addEventListener('keydown', radioSwallowKeys);
    }
    var wanted = new URLSearchParams(window.location.search).get('view');
    if (!wanted) {
      try {
        wanted = window.localStorage.getItem(VIEW_PREF);
      } catch (error) { /* no storage: default below */ }
    }
    setView(wanted);
  }());

  // Down here rather than beside its own section: radioPaintHead asks autoplayAllowed
  // whether this is live mode, and `liveMode` is not assigned until well below it.
  radioBind();

  /*
   * The same contract f1-live.js publishes. f1-lab.js calls `render` and nothing else, so
   * satisfying this is all it takes for the lab's scrubber, session picker, flag bands and
   * jump buttons to drive this page without a line of change in that file.
   */
  window.f1Live = {
    render: render,
    reveal: reveal,
    lapTime: lapTime,
    gap: gap,
    teamColour: teamColour
  };
}());
