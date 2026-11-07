/*
 * Pitwall: one car in full. A port of Pocket Pitwall's ui/DriverSheet.kt and ui/Telemetry.kt.
 *
 * A card over the stage's right edge, opened by clicking a car in the tower or on the map:
 * headed by the car's code in its team colour on a shade of it, then (live) its telemetry
 * several times a second (speed and gear large, throttle and brake as bars, the revs as a
 * thin one), its gaps and laps, its sectors, its tyres and stints, and two actions: follow
 * the driver, and show their pit ghost on the Wall. It reads the frame on screen, so it keeps
 * updating while open, and the telemetry keeps to the same delay as everything else.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var F = P.Format;
  var UI = P.UI;

  /** Revs at which the bar is full. The 2026 power units run to about 12,000. */
  var RPM_FULL = 12500;

  var card = document.getElementById('driver');
  var top = card.querySelector('.driver-top');
  var body = card.querySelector('.driver-body');
  var tel = card.querySelector('.telemetry');
  var handlers = {};
  var shown = null;
  /** What had the keyboard's focus when the card opened, to give it back on closing. */
  var opener = null;

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function set(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  function split(parts, cls) {
    return (parts[0] ? '<span class="faint">' + esc(parts[0]) + '</span>' : '') + '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(parts[1]) + '</span>';
  }

  function figure(label, value) {
    return '<div class="fig"><p class="cap-label">' + label + '</p><p class="fig-value">' + value + '</p></div>';
  }

  /** The car's tyre history along the race distance, never past the lap it's on. */
  function stintBar(driver, currentLap, totalLaps) {
    var upTo = currentLap || driver.stints.reduce(function (m, s) { return Math.max(m, s.lapEnd || s.lapStart || 0); }, 0);
    if (!upTo) { return ''; }
    var distance = Math.max(totalLaps || upTo, upTo);
    var at = 1;
    var bars = driver.stints.map(function (st) {
      var start = Math.max(st.lapStart || at, at);
      var end = Math.min(st.lapEnd != null ? st.lapEnd : upTo, upTo);
      if (end < start) { return ''; }
      at = end + 1;
      return '<i data-tyre="' + F.tyreRole(st.compound) + '" style="left:' + ((start - 1) / distance * 100).toFixed(2) + '%;width:calc(' + ((end - start + 1) / distance * 100).toFixed(2) + '% - 2px)"></i>';
    }).join('');
    return '<div class="stint-bar">' + bars + '</div>';
  }

  function render(frame, c) {
    var driver = frame && c.open != null ? frame.byNumber[c.open] : null;
    var was = shown;
    var inside = card.contains(document.activeElement);
    card.hidden = !driver;
    shown = driver ? driver.num : null;
    if (!driver) {
      // Closed with the keyboard inside it: focus goes back where it came from.
      if (was != null && opener && inside) { opener.focus(); }
      if (was != null) { opener = null; }
      return;
    }
    if (was == null) {
      // Opened from the keyboard (Enter on a row), it takes the focus; a click leaves it be.
      var from = document.activeElement;
      opener = from && from.matches && from.matches(':focus-visible') ? from : null;
      if (opener) { setTimeout(function () { card.querySelector('.driver-close').focus(); }, 0); }
    }
    var team = F.teamColour(driver.colour) || UI.token('--ink-soft');
    card.style.setProperty('--team', team);
    var best = frame.best;
    var lastCls = F.same(driver.lastLap, best && best.lap) ? 'is-best' : F.same(driver.lastLap, driver.bestLap) ? 'is-personal' : '';
    var bestCls = F.same(driver.bestLap, best && best.lap) ? 'is-best' : '';
    var note = driver.dnf ? 'Out of the session' : driver.inPit ? 'In the pit lane' : '';
    var sectors = '';
    if (driver.sectors.length) {
      sectors = '<div class="tile"><p class="cap-label">Sectors, last lap</p><div class="driver-sectors">' + [0, 1, 2].map(function (i) {
        var v = driver.sectors[i];
        var cls = v == null ? 'is-none' : best && F.same(v, best.sectors[i]) ? 'is-best' : F.same(v, driver.bestSectors[i]) ? 'is-personal' : '';
        return '<div class="' + cls + '"><i></i><b>' + esc(F.sectorTime(v) || F.DASH) + '</b></div>';
      }).join('') + '</div></div>';
    }
    var facts = [
      driver.pitStops != null ? (driver.pitStops === 1 ? '1 stop' : driver.pitStops + ' stops') : null,
      driver.penalty ? 'Penalty ' + driver.penalty + (driver.penaltyServed ? ' (served)' : '') : null,
      driver.badges.indexOf('investigation') >= 0 ? 'Under investigation' : null
    ].filter(Boolean).join(' · ');
    var tyre = driver.inPit ? '<span class="tyre-pit">Pit</span>' : driver.compound ?
      '<span class="tyre-ring" data-tyre="' + F.tyreRole(driver.compound) + '"></span><b>' + esc(driver.compound.charAt(0) + driver.compound.slice(1).toLowerCase()) +
      (driver.tyreAge != null ? '</b><span class="tyre-age">' + driver.tyreAge + ' laps</span>' : '</b>') : '<span class="tyre-age">' + F.DASH + '</span>';
    var lap = driver.lap || frame.lap;
    set(top,
      '<div class="driver-head">' +
        '<div><p class="driver-code">' + esc(F.driverLabel(driver)) + '</p>' +
        '<p class="driver-name">' + esc([driver.name ? F.titleCase(driver.name) : null, driver.team].filter(Boolean).join(' · ')) + '</p></div>' +
        '<div class="driver-pos"><b class="' + (best && best.num === driver.num ? 'is-best' : '') + '">' + (driver.pos == null ? F.DASH : driver.pos) + '</b><span class="cap-label">Position</span></div>' +
      '</div>' +
      (note ? '<p class="driver-note">' + note + '</p>' : ''));
    set(body,
      '<div class="driver-figs">' +
        figure('Gap to leader', esc(F.gap(driver.gapToLeader))) +
        figure('Interval', esc(F.gap(driver.interval))) +
        figure('Last lap', split(F.splitLap(driver.lastLap), lastCls)) +
        figure('Best lap', split(F.splitLap(driver.bestLap), bestCls)) +
      '</div>' + sectors +
      '<div class="tile"><p class="driver-tyre">' + tyre + '</p>' +
        (facts ? '<p class="ring-hint">' + esc(facts) + '</p>' : '') +
        (driver.stints.length ? stintBar(driver, lap, c.totalLaps) + '<p class="ring-hint">' + esc(F.stintSummary(driver.stints, lap)) + '</p>' : '') +
      '</div>');
    var follow = card.querySelector('.driver-follow');
    var on = c.followed.has(driver.num);
    follow.setAttribute('aria-pressed', on ? 'true' : 'false');
    follow.textContent = on ? 'Following' : 'Follow driver';
    var ghost = card.querySelector('.driver-ghost');
    ghost.hidden = !c.canGhost;
    tel.hidden = !c.live;
    telemetry(c.cars);
  }

  /** Live telemetry: several times a second, from the stream; it says so when there's none. */
  function telemetry(cars) {
    if (shown == null || tel.hidden) { return; }
    var t = cars && cars.fresh ? cars.telemetry[shown] : null;
    tel.toggleAttribute('data-none', !t);
    if (!t) { return; }
    UI.text('telSpeed', t.speed == null ? F.DASH : t.speed);
    UI.text('telGear', t.gear == null ? F.DASH : t.gear === 0 ? 'N' : t.gear);
    UI.text('telRpm', t.rpm == null ? 'rpm' : t.rpm.toLocaleString('en-GB') + ' rpm');
    function level(name, v) {
      card.querySelector('[data-level="' + name + '"]').style.transform = 'scaleX(' + Math.min(1, Math.max(0, v || 0)) + ')';
    }
    level('throttle', (t.throttle || 0) / 100);
    level('brake', (t.brake || 0) / 100);
    level('rpm', (t.rpm || 0) / RPM_FULL);
  }

  card.querySelector('.driver-close').addEventListener('click', function () {
    if (handlers.onClose) { handlers.onClose(); }
  });
  card.querySelector('.driver-follow').addEventListener('click', function () {
    if (handlers.onFollow && shown != null) { handlers.onFollow(shown); }
  });
  card.querySelector('.driver-ghost').addEventListener('click', function () {
    if (handlers.onGhost && shown != null) { handlers.onGhost(shown); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !card.hidden && handlers.onClose) { handlers.onClose(); }
  });

  P.Driver = {
    render: render,
    telemetry: telemetry,
    on: function (h) { handlers = h; }
  };
}());
