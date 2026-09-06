/*
 * /f1-lab — the development harness for the live timing panel.
 *
 * The panel on /f1 can only be exercised while a session is actually running, which is two
 * hours a fortnight, and even then you cannot go back to the moment a safety car came out to
 * see what the page did. This drives the same panel from a past session instead, with a
 * scrubber over race time.
 *
 * The important property is that this file renders nothing itself. It fetches a composed
 * frame from the server and hands it to `window.f1Live.render` — the very function /f1 calls
 * — so a feature developed here is developed against the real code path rather than a
 * lookalike. The only thing the lab owns is the toolbar and the scrubber.
 *
 * The server does the composing from a cached replay, so scrubbing costs no network at all
 * after the first load and lands in a couple of milliseconds.
 */

(function () {
  'use strict';

  var API = (function () {
    var override = new URLSearchParams(window.location.search).get('api');
    if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override)) {
      return override.replace(/\/$/, '');
    }
    return 'https://irishrail-api-737590149980.europe-west1.run.app';
  }());

  var STEPS = 1000;               // scrubber resolution
  var FRAME_MS = 250;             // how often a frame is requested while playing

  /* Flag colours for the scrubber track. Same values as the --flag tokens in f1.css. */
  var BAND = {
    GREEN: 'rgba(62,207,120,0.30)',
    YELLOW: 'rgba(245,197,24,0.55)',
    VSC: 'rgba(245,197,24,0.75)',
    SAFETY_CAR: 'rgba(245,197,24,0.95)',
    RED: 'rgba(232,17,45,0.85)',
    CHEQUERED: 'rgba(246,247,248,0.35)'
  };

  var season = null;              // the season index, for resolving a circuit to its geoId
  var timeline = null;
  var current = null;             // {key, start, end}
  var playing = false;
  var playTimer = null;
  var inFlight = false;
  var pending = null;             // most recent requested instant while one is in flight

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(text) {
    var node = el('lab-status');
    if (node) {
      node.textContent = text;
    }
  }

  /* ---------- Session list ---------- */

  function loadYears() {
    var select = el('lab-year');
    var now = new Date().getUTCFullYear();
    // OpenF1's free historical data starts in 2023.
    for (var y = now; y >= 2023; y -= 1) {
      var option = document.createElement('option');
      option.value = String(y);
      option.textContent = String(y);
      select.appendChild(option);
    }
    select.value = String(now);
    select.addEventListener('change', function () { loadSessions(select.value); });
    loadSessions(select.value);
  }

  function loadSessions(year) {
    var select = el('lab-session');
    select.innerHTML = '<option value="">Loading…</option>';

    fetch(API + '/f1/replay/sessions?year=' + encodeURIComponent(year))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        select.innerHTML = '';
        var sessions = (data.sessions || []);
        if (!sessions.length) {
          select.innerHTML = '<option value="">Nothing for ' + year + '</option>';
          return;
        }
        var blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Pick a session…';
        select.appendChild(blank);

        sessions.forEach(function (s) {
          var option = document.createElement('option');
          option.value = String(s.key);
          option.textContent = (s.start || '').slice(0, 10) + ' — ' +
            (s.circuit || s.country || '?') + ' · ' + s.name;
          select.appendChild(option);
        });

        // A session pinned on the URL survives a reload, which matters when you are
        // iterating on one particular moment.
        var wanted = new URLSearchParams(window.location.search).get('session');
        if (wanted && select.querySelector('option[value="' + wanted + '"]')) {
          select.value = wanted;
          pick(wanted);
        }
      })
      .catch(function () {
        select.innerHTML = '<option value="">Could not load sessions</option>';
      });

    select.onchange = function () {
      if (select.value) {
        pick(select.value);
      }
    };
  }

  /* ---------- Loading one session ---------- */

  function pick(key) {
    stop();
    setStatus('Loading session ' + key + '…');
    el('lab-play').disabled = true;
    if (window.f1Map) {
      window.f1Map.reset();
    }

    var url = new URL(window.location.href);
    url.searchParams.set('session', key);
    window.history.replaceState({}, '', url);

    fetch(API + '/f1/replay/timeline?session_key=' + encodeURIComponent(key))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          setStatus(data.error);
          return;
        }
        timeline = data;
        current = {
          key: key,
          start: new Date(data.start).getTime(),
          end: new Date(data.end).getTime()
        };
        paintTrack();
        paintJumps();
        pointMap(data.session);
        setStatus((data.session.circuit || '') + ' · ' + (data.session.name || ''));
        el('lab-play').disabled = false;

        // ?t= pins an instant, so a reload comes back to the moment being worked on rather
        // than to lights out.
        var wanted = new URLSearchParams(window.location.search).get('t');
        var at = wanted ? new Date(wanted).getTime() : NaN;
        seek(isNaN(at) ? current.start : at);
      })
      .catch(function (error) { setStatus('Timeline failed: ' + error.message); });
  }

  /*
   * The map needs a circuit file, which is keyed by geoId. The timing feed only knows the
   * circuit's short name, so the season index is the bridge — matched on locality, the same
   * field /f1 already uses to decide whether the lap count belongs to the session.
   */
  function pointMap(session) {
    if (!window.f1Map || !session || !session.circuit) {
      return;
    }
    var wanted = String(session.circuit).toLowerCase();

    function match(index) {
      var rounds = (index && index.rounds) || [];
      for (var i = 0; i < rounds.length; i += 1) {
        var r = rounds[i];
        if (String(r.locality || '').toLowerCase() === wanted
            || String(r.circuitName || '').toLowerCase().indexOf(wanted) >= 0) {
          return r.geoId;
        }
      }
      return null;
    }

    if (season) {
      var found = match(season);
      if (found) {
        window.f1Map.use(found);
      }
      return;
    }
    fetch('assets/data/f1/season-2026.json')
      .then(function (r) { return r.json(); })
      .then(function (index) {
        season = index;
        var found = match(index);
        if (found) {
          window.f1Map.use(found);
        }
      })
      .catch(function () { /* no map for this session; the panel still works */ });
  }

  /* ---------- The scrubber track ---------- */

  function fraction(ms) {
    return (ms - current.start) / Math.max(1, current.end - current.start);
  }

  function paintTrack() {
    var track = el('lab-track');
    track.textContent = '';
    if (!timeline || !current) {
      return;
    }

    (timeline.periods || []).forEach(function (period) {
      var from = new Date(period.from).getTime();
      var to = period.to ? new Date(period.to).getTime() : current.end;
      if (!(to > from)) {
        return;
      }
      var band = document.createElement('i');
      band.className = 'lab-band';
      band.style.left = (fraction(from) * 100) + '%';
      band.style.width = Math.max(0.15, (fraction(to) - fraction(from)) * 100) + '%';
      band.style.background = BAND[period.state] || 'transparent';
      band.title = period.state + ' from ' + period.from.slice(11, 19);
      track.appendChild(band);
    });

    // Notches for the events worth stopping at. Low-severity noise (track limits) is left
    // off — twenty-one deletions would bury the three things that matter.
    (timeline.events || []).forEach(function (event) {
      if (event.severity === 'info' || event.type === 'deletion') {
        return;
      }
      var at = new Date(event.t).getTime();
      var notch = document.createElement('i');
      notch.className = 'lab-notch lab-notch-' + event.severity;
      notch.style.left = (fraction(at) * 100) + '%';
      notch.title = event.t.slice(11, 19) + ' — ' + event.text;
      track.appendChild(notch);
    });
  }

  /* Quick jumps to the start of every non-green period: the moments worth developing against. */
  function paintJumps() {
    var host = el('lab-jumps');
    host.textContent = '';
    if (!timeline) {
      return;
    }
    var interesting = (timeline.periods || []).filter(function (p) {
      return p.state !== 'GREEN';
    });
    if (!interesting.length) {
      host.textContent = 'No safety cars, yellows or red flags in this session.';
      return;
    }

    host.appendChild(document.createTextNode('Jump to: '));
    interesting.forEach(function (period) {
      var at = new Date(period.from).getTime();
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'lab-jump lab-jump-' + period.state.toLowerCase().replace('_', '-');
      button.textContent = period.state.replace('_', ' ').toLowerCase()
        + ' ' + period.from.slice(11, 16);
      button.addEventListener('click', function () {
        stop();
        seek(at);
      });
      host.appendChild(button);
    });
  }

  /* ---------- Driving the panel ---------- */

  function seek(ms) {
    var clamped = Math.max(current.start, Math.min(current.end, ms));
    el('lab-range').value = String(Math.round(fraction(clamped) * STEPS));
    request(clamped);
  }

  function request(ms) {
    if (!current) {
      return;
    }
    el('lab-clock').textContent = new Date(ms).toISOString().slice(11, 19) + ' UTC';

    // One frame in flight at a time. Dragging the scrubber fires continuously, and queueing
    // every intermediate instant would render a backlog of frames nobody asked to see.
    if (inFlight) {
      pending = ms;
      return;
    }
    inFlight = true;

    var url = API + '/f1/live?replay=' + encodeURIComponent(current.key)
      + '&t=' + encodeURIComponent(new Date(ms).toISOString());

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.live && window.f1Live) {
          window.f1Live.render(data);
        }
      })
      .catch(function () { /* a dropped frame; the next scrub will ask again */ })
      .then(function () {
        inFlight = false;
        if (pending !== null) {
          var next = pending;
          pending = null;
          request(next);
        }
      });
  }

  /* ---------- Playback ---------- */

  function currentMs() {
    return current.start
      + (el('lab-range').value / STEPS) * (current.end - current.start);
  }

  function stop() {
    playing = false;
    window.clearInterval(playTimer);
    el('lab-play').textContent = 'Play';
  }

  function play() {
    if (!current) {
      return;
    }
    playing = true;
    el('lab-play').textContent = 'Pause';
    playTimer = window.setInterval(function () {
      var speed = parseFloat(el('lab-speed').value) || 1;
      var next = currentMs() + FRAME_MS * speed;
      if (next >= current.end) {
        seek(current.end);
        stop();
        return;
      }
      seek(next);
    }, FRAME_MS);
  }

  function main() {
    if (!el('lab-range')) {
      return;
    }
    loadYears();

    el('lab-range').addEventListener('input', function () {
      stop();
      if (current) {
        request(currentMs());
      }
    });

    el('lab-play').addEventListener('click', function () {
      if (playing) {
        stop();
      } else {
        play();
      }
    });

    // Arrow keys nudge a frame at a time, which is how you actually pin down the instant a
    // flag changes.
    document.addEventListener('keydown', function (event) {
      if (!current || event.target.tagName === 'SELECT') {
        return;
      }
      var step = event.shiftKey ? 30000 : 5000;
      if (event.key === 'ArrowLeft') {
        stop();
        seek(currentMs() - step);
      } else if (event.key === 'ArrowRight') {
        stop();
        seek(currentMs() + step);
      } else if (event.key === ' ') {
        event.preventDefault();
        if (playing) { stop(); } else { play(); }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
}());
