/*
 * /f1 — live timing, for the two hours a fortnight when there is something to say.
 *
 * The page this attaches to is otherwise entirely precomputed. This file is the only part
 * of it that knows about a session in progress: it polls one endpoint on the same Cloud Run
 * service /dashboard uses, and that endpoint does all the composing — the running order,
 * the flag state, the lap count — so what arrives here is already the shape the page draws.
 * See f1_live.py for why that work is server-side (in short: the upstream feed needs
 * credentials that cannot ship in a browser).
 *
 * Nothing here runs unless #live is in the document, and nothing is shown unless a session
 * is actually running. On a Tuesday the page is exactly what it was before.
 *
 * The flag colour deliberately does not touch --accent: that is the circuit's own colour,
 * set per-round by f1-circuit.js and read by the canvas every frame. Flags get their own
 * --flag token and a data-flag attribute on <html>.
 */

(function () {
  'use strict';

  var host = document.getElementById('live');
  if (!host) {
    return;
  }

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var DEFAULT_API = 'https://irishrail-api-737590149980.europe-west1.run.app';

  /* Poll cadences. The server caches for 2s, so polling faster than that only adds noise. */
  var POLL_LIVE = 3000;
  var POLL_HIDDEN = 30000;     // tab in the background: keep the state warm, cheaply
  var POLL_IDLE = 60000;       // nothing running; just checking whether that has changed
  var POLL_ERROR = 10000;

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

  /*
   * The same values as the --flag tokens in f1.css. Duplicated here only for the two things
   * CSS cannot paint: the tab icon and the browser chrome's theme-colour.
   */
  var FLAG_COLOUR = {
    green: '#3ecf78',
    yellow: '#f5c518',
    vsc: '#f5c518',
    'safety-car': '#f5c518',
    red: '#e8112d',
    chequered: '#f6f7f8'
  };

  /*
   * A local API override, for developing against a Flask server on this machine. Restricted
   * to loopback on purpose: an arbitrary origin here would let a crafted link feed the page
   * its content from somewhere else entirely.
   */
  function apiBase() {
    var override = new URLSearchParams(window.location.search).get('api');
    if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override)) {
      return override.replace(/\/$/, '');
    }
    return DEFAULT_API;
  }

  /* A replay pinned on the page URL is passed straight through to the server, for testing. */
  function endpoint() {
    var params = new URLSearchParams(window.location.search);
    var url = apiBase() + '/f1/live';
    var replay = params.get('replay');
    if (replay) {
      url += '?replay=' + encodeURIComponent(replay);
      if (params.get('t')) {
        url += '&t=' + encodeURIComponent(params.get('t'));
      }
    }
    return url;
  }

  /*
   * The section's own markup, injected rather than written into the page.
   *
   * It lives here because two pages render it — /f1 and the development lab — and 36 lines
   * of duplicated scaffolding across two files would drift apart, which would defeat the
   * point of a lab that is supposed to be showing you the real thing. Both pages carry only
   * `<section class="chapter" id="live" hidden></section>`.
   */
  var TEMPLATE =
    '<div class="wrap">' +
      '<div class="chapter-head reveal">' +
        '<p class="chapter-index"><b>00</b> / Live</p>' +
        '<h2 class="chapter-title"><span class="line-mask"><span>On track now</span></span></h2>' +
        '<p class="chapter-lead" id="live-session">Session in progress.</p>' +
      '</div>' +
      '<div class="live-status" aria-live="polite">' +
        '<p class="live-state" id="live-state">—</p>' +
        '<p class="live-state-note" id="live-state-note"></p>' +
        '<p class="live-lap" id="live-lap"></p>' +
      '</div>' +
      '<canvas class="live-map" id="live-map" role="img" ' +
        'aria-label="Track map showing the current position of every car"></canvas>' +
      '<div class="timing-head" aria-hidden="true">' +
        '<span>Pos</span><span>Driver</span><span>Leader</span>' +
        '<span>Ahead</span><span>Last lap</span><span>Tyre</span>' +
      '</div>' +
      '<ol class="timing-rows" id="timing-rows"></ol>' +
      '<div class="live-feed" id="live-feed" hidden>' +
        '<p class="live-feed-head">Race control</p>' +
        '<ol class="feed-rows" id="feed-rows"></ol>' +
      '</div>' +
      '<p class="live-foot" id="live-foot"></p>' +
    '</div>';

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

  function tyre(compound, age) {
    if (!compound) {
      return '—';
    }
    var letter = compound.charAt(0).toUpperCase();
    return age === null || age === undefined ? letter : letter + ' ' + age;
  }

  /* Team colours arrive as bare hex digits and go straight into a style; check them. */
  function teamColour(value) {
    return /^[0-9a-fA-F]{6}$/.test(value || '') ? '#' + value : null;
  }

  /* ---------- The flag ---------- */

  var currentFlag = null;

  function renderFlag(flag) {
    var state = (flag && flag.state) || 'GREEN';
    var slug = FLAG_SLUG[state] || 'green';

    if (slug !== currentFlag) {
      currentFlag = slug;
      document.documentElement.setAttribute('data-flag', slug);

      // The tab icon and the mobile browser chrome, neither of which CSS can reach.
      // faviconDataUri lives in f1-circuit.js and is reused rather than reimplemented, so
      // there is only one copy of the icon's path data on the page.
      var icon = el('favicon');
      if (icon && typeof window.f1Favicon === 'function') {
        icon.href = window.f1Favicon(FLAG_COLOUR[slug]);
      }
      var theme = document.querySelector('meta[name="theme-color"]');
      if (theme) {
        theme.setAttribute('content', slug === 'green' ? '#111214' : FLAG_COLOUR[slug]);
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

  // Built before anything looks an id up, since every id below lives in the template.
  host.innerHTML = TEMPLATE;

  var rows = {};       // driver number -> <li>
  var listNode = el('timing-rows');

  /*
   * Race-control state that attaches to a car. The mark is a single letter so the column
   * stays narrow — the full wording is in the title attribute and in the feed below.
   */
  var BADGE = {
    investigation: { mark: '!', label: 'Under investigation' },
    penalty: { mark: 'P', label: 'Penalty' },
    deletion: { mark: 'D', label: 'Lap time deleted' }
  };

  function buildRow(driver) {
    var node = document.createElement('li');
    node.className = 'timing-row';
    node.innerHTML =
      '<span class="t-pos"></span>' +
      '<span class="t-driver"><i class="t-bar"></i><b class="t-code"></b>' +
      '<span class="t-name"></span><span class="t-badges"></span></span>' +
      '<span class="t-gap"></span>' +
      '<span class="t-int"></span>' +
      '<span class="t-last"></span>' +
      '<span class="t-tyre"></span>';
    return node;
  }

  function fillRow(node, driver) {
    node.querySelector('.t-pos').textContent = driver.pos === null ? '—' : driver.pos;
    node.querySelector('.t-code').textContent = driver.code || ('#' + driver.num);
    node.querySelector('.t-name').textContent = driver.team || '';
    node.querySelector('.t-gap').textContent = gap(driver.gapToLeader);
    node.querySelector('.t-int').textContent = gap(driver.interval);
    node.querySelector('.t-last').textContent = lapTime(driver.lastLap);

    var tyreNode = node.querySelector('.t-tyre');
    tyreNode.textContent = tyre(driver.compound, driver.tyreAge);
    // The stint history is not shown as a column of its own — it would not earn the width —
    // but it is the natural thing to want when you look at a tyre, so it hangs off it.
    tyreNode.title = stintSummary(driver.stints);

    var colour = teamColour(driver.colour);
    node.querySelector('.t-bar').style.background = colour || 'transparent';

    var badges = node.querySelector('.t-badges');
    badges.textContent = '';
    (driver.badges || []).forEach(function (name) {
      var spec = BADGE[name];
      if (!spec) {
        return;
      }
      var mark = document.createElement('i');
      mark.className = 'badge badge-' + name;
      mark.textContent = spec.mark;
      mark.title = spec.label;
      badges.appendChild(mark);
    });

    node.classList.toggle('is-pit', !!driver.inPit);
    node.classList.toggle('is-out', !!driver.dnf);
    tyreNode.classList.toggle('is-pit', !!driver.inPit);
  }

  /* "S 1-14 · M 15-32 · H 33-" — the whole race on one line. */
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

  /*
   * Rows are built once and then reordered, never rebuilt: an overtake should read as two
   * cars swapping, not as the whole table blinking. Positions are animated with FLIP —
   * measure where each row is, move it, then transform it back to where it was and let the
   * transition carry it to its new home.
   */
  function renderRows(drivers) {
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
        node = rows[driver.num] = buildRow(driver);
      }
      fillRow(node, driver);
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
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          node.style.transition = '';
          node.style.transform = '';
        });
      });
    });
  }

  /* ---------- Race control feed ---------- */

  var feedShown = '';

  function renderFeed(events) {
    var host = el('live-feed');
    var list = el('feed-rows');
    if (!host || !list) {
      return;
    }
    if (!events || !events.length) {
      host.hidden = true;
      return;
    }

    // Rebuilt only when the newest entry changes — this list is static between events, and
    // re-rendering it every three seconds would fight text selection.
    var newest = events[0].t + '|' + events.length;
    if (newest === feedShown) {
      return;
    }
    feedShown = newest;
    host.hidden = false;
    list.textContent = '';

    events.forEach(function (event) {
      var row = document.createElement('li');
      row.className = 'feed-row feed-' + event.severity;

      var when = document.createElement('span');
      when.className = 'feed-time';
      when.textContent = event.t ? event.t.slice(11, 16) : '';

      var what = document.createElement('span');
      what.className = 'feed-text';
      // textContent, not innerHTML: this is race control's prose arriving over the wire.
      what.textContent = event.text;

      row.appendChild(when);
      row.appendChild(what);
      list.appendChild(row);
    });
  }

  /* ---------- Poll ---------- */

  var shown = false;
  var finished = false;

  function reveal() {
    if (shown) {
      return;
    }
    shown = true;
    host.hidden = false;

    var nav = el('nav-live');
    if (nav) {
      nav.hidden = false;
    }

    /*
     * The page's reveal observer (f1-circuit.js) started while this section was hidden, so
     * it never claimed these. Without is-in the masked chapter title stays translated a
     * full line down and is simply invisible. On the next frame, so the transition has a
     * start value to move from rather than snapping.
     */
    requestAnimationFrame(function () {
      var masked = host.querySelectorAll('.reveal, .line-mask');
      Array.prototype.forEach.call(masked, function (node) {
        node.classList.add('is-in');
      });
    });
  }

  function render(data) {
    reveal();

    var session = data.session || {};
    var name = session.name || 'Session';
    var where = session.circuit ? ' at ' + session.circuit : '';
    setText('live-session', name + where);

    // Total laps comes from the season data the page has already loaded — the timing feed
    // does not carry it. Missing simply means the count shows without a denominator.
    //
    // Keyed on the session's name, not its type: OpenF1 reports a Sprint as session_type
    // "Race", and a sprint is a third of the distance, so the grand prix's lap count is the
    // wrong denominator for it.
    // The round on screen and the session being timed are the same race in normal use, but
    // not under a replay of another weekend, where a borrowed denominator is simply a wrong
    // number on the page. So the count is only shown when the round the page is built
    // around is demonstrably the circuit being timed.
    var round = window.f1Round;
    var total = null;
    if (round && round.stats && session.name === 'Race' && session.circuit
        && String(round.locality || '').toLowerCase() === String(session.circuit).toLowerCase()) {
      total = round.stats.laps;
    }
    var current = data.lap && data.lap.current;
    setText('live-lap', current ? ('Lap ' + current + (total ? ' / ' + total : '')) : '');

    renderFlag(data.flag);
    renderRows(data.drivers || []);
    renderFeed(data.events || []);

    if (window.f1Map) {
      // On /f1 the round on screen is the session being timed, so its geometry is already
      // the right one. The lab points the map itself, because it can be replaying anywhere.
      if (round && round.geoId) {
        window.f1Map.use(round.geoId);
      }
      window.f1Map.render(data);
    }

    var stamp = data.generated ? new Date(data.generated) : new Date();
    setText('live-foot', (data.stale ? 'Last good update ' : 'Updated ')
      + stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + ' — timing by OpenF1, about three seconds behind the track.');

    if (data.session && data.session.type === 'Race' && data.flag
        && data.flag.state === 'CHEQUERED') {
      finished = true;
    }
  }

  function idle(data) {
    // Nothing running. If the panel was never shown, leave the page exactly as it was.
    if (!shown) {
      return;
    }
    setText('live-foot', 'Session over. The timings above are the final ones received.');
  }

  function schedule(ms) {
    window.setTimeout(tick, ms);
  }

  function tick() {
    if (finished) {
      // The race is done; stop asking. A reload is the way back in.
      return;
    }

    fetch(endpoint(), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok && response.status !== 502) {
          throw new Error('HTTP ' + response.status);
        }
        return response.json();
      })
      .then(function (data) {
        if (data && data.live) {
          render(data);
          schedule(document.hidden ? POLL_HIDDEN : POLL_LIVE);
        } else {
          idle(data);
          schedule(document.hidden ? POLL_HIDDEN : POLL_IDLE);
        }
      })
      .catch(function () {
        // Keep whatever is on screen; a dropped poll is not worth blanking the order for.
        schedule(POLL_ERROR);
      });
  }

  /*
   * The lab drives the panel itself: it holds the scrubber, so it decides which instant is
   * on screen and there is nothing to poll for. Exposing render rather than duplicating it
   * is what keeps the lab showing the real page instead of a copy of it.
   */
  window.f1Live = {
    render: render,
    reveal: reveal,
    lapTime: lapTime,
    gap: gap,
    teamColour: teamColour
  };

  if (document.body.hasAttribute('data-f1-lab')) {
    reveal();
    return;
  }

  // Coming back to the tab should feel immediate rather than waiting out a background poll.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !finished) {
      tick();
    }
  });

  tick();
}());
