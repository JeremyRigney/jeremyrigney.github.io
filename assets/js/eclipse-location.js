/*
 * Viewing-location control for the eclipse page.
 *
 * Builds the "Use my location" control into the cover-line stack, computes the
 * local circumstances with eclipse-besselian.js, and rewrites every
 * location-dependent figure on the page. Publishes to window.eclipseLocation so
 * the countdown, the scroll scene, the coverage stat and the map all follow.
 *
 * Privacy: coordinates are used in the browser and stored in localStorage only.
 * Nothing is sent anywhere — there is no backend and no geocoding service.
 *
 * Payload published to eclipseLocation.set():
 *   { lat, lon, latlng, label, coordsLabel, timeZone, source,
 *     circ,               local circumstances from EclipseLocal.circumstances
 *     mapMeta,            one-line summary for the map popup
 *     formatTime(date) }  render a Date in this location's timezone
 */
(function () {
  'use strict';

  if (!window.EclipseLocal) {
    return;
  }

  var STORAGE_KEY = 'eclipse2026.location';

  // Fallback picker. Irish towns first — the page's subject — then the wider
  // region where the eclipse is worth travelling for. Timezones are carried
  // explicitly so a reader in Dublin can look up Madrid and still see CEST.
  var PLACES = [
    { group: 'Ireland', items: [
      { name: 'Dublin', lat: 53.3498, lon: -6.2603, tz: 'Europe/Dublin' },
      { name: 'Cork', lat: 51.8985, lon: -8.4756, tz: 'Europe/Dublin' },
      { name: 'Galway', lat: 53.2707, lon: -9.0568, tz: 'Europe/Dublin' },
      { name: 'Limerick', lat: 52.6638, lon: -8.6267, tz: 'Europe/Dublin' },
      { name: 'Waterford', lat: 52.2593, lon: -7.1101, tz: 'Europe/Dublin' },
      { name: 'Sligo', lat: 54.2766, lon: -8.4761, tz: 'Europe/Dublin' },
      { name: 'Donegal', lat: 54.6539, lon: -8.1105, tz: 'Europe/Dublin' },
      { name: 'Killarney', lat: 52.0599, lon: -9.5044, tz: 'Europe/Dublin' },
      { name: 'Wexford', lat: 52.3369, lon: -6.4633, tz: 'Europe/Dublin' },
      { name: 'Athlone', lat: 53.4239, lon: -7.9407, tz: 'Europe/Dublin' },
      // Birr Castle: the Leviathan of Parsonstown and I-LOFAR — the obvious
      // place in the midlands to be standing for this.
      { name: 'Birr, Co. Offaly', lat: 53.0969, lon: -7.9107, tz: 'Europe/Dublin' },
      { name: 'Valentia Island', lat: 51.9200, lon: -10.3400, tz: 'Europe/Dublin' }
    ] },
    { group: 'Northern Ireland & Britain', items: [
      { name: 'Belfast', lat: 54.5973, lon: -5.9301, tz: 'Europe/London' },
      { name: 'Derry', lat: 54.9966, lon: -7.3086, tz: 'Europe/London' },
      { name: 'Glasgow', lat: 55.8642, lon: -4.2518, tz: 'Europe/London' },
      { name: 'Edinburgh', lat: 55.9533, lon: -3.1883, tz: 'Europe/London' },
      { name: 'Manchester', lat: 53.4808, lon: -2.2426, tz: 'Europe/London' },
      { name: 'Cardiff', lat: 51.4816, lon: -3.1791, tz: 'Europe/London' },
      { name: 'London', lat: 51.5072, lon: -0.1276, tz: 'Europe/London' }
    ] },
    { group: 'In or near the path of totality', items: [
      { name: 'Reykjavík, Iceland', lat: 64.1466, lon: -21.9426, tz: 'Atlantic/Reykjavik' },
      { name: 'A Coruña, Spain', lat: 43.3623, lon: -8.4115, tz: 'Europe/Madrid' },
      { name: 'Oviedo, Spain', lat: 43.3619, lon: -5.8494, tz: 'Europe/Madrid' },
      { name: 'Burgos, Spain', lat: 42.3439, lon: -3.6969, tz: 'Europe/Madrid' },
      { name: 'Zaragoza, Spain', lat: 41.6488, lon: -0.8891, tz: 'Europe/Madrid' },
      { name: 'Valencia, Spain', lat: 39.4699, lon: -0.3763, tz: 'Europe/Madrid' },
      { name: 'Palma, Mallorca', lat: 39.5696, lon: 2.6502, tz: 'Europe/Madrid' }
    ] },
    { group: 'Elsewhere in Europe', items: [
      { name: 'Madrid, Spain', lat: 40.4168, lon: -3.7038, tz: 'Europe/Madrid' },
      { name: 'Lisbon, Portugal', lat: 38.7223, lon: -9.1393, tz: 'Europe/Lisbon' },
      { name: 'Paris, France', lat: 48.8566, lon: 2.3522, tz: 'Europe/Paris' },
      { name: 'Amsterdam, Netherlands', lat: 52.3676, lon: 4.9041, tz: 'Europe/Amsterdam' },
      { name: 'Berlin, Germany', lat: 52.5200, lon: 13.4050, tz: 'Europe/Berlin' },
      { name: 'Rome, Italy', lat: 41.9028, lon: 12.4964, tz: 'Europe/Rome' }
    ] }
  ];

  var DUBLIN = PLACES[0].items[0];

  /* ---------- formatting helpers ---------- */

  function timeFormatter(tz) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      });
    } catch (err) {
      // Unknown IANA zone (very old browser): fall back to the device zone.
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  }

  /*
   * Zone abbreviations for 12 August 2026 (every European zone here is on
   * summer time that day).
   *
   * Intl's own "short" name is locale-dependent and unhelpfully inconsistent:
   * en-GB renders Europe/Dublin as "GMT+1" because CLDR avoids "IST", which
   * collides with India and Israel, while en-IE renders it as "IST" but then
   * gives "GMT+1" for London. No single locale gets the whole set right, so the
   * zones this page actually cares about are named explicitly and everywhere
   * else falls back to Intl's offset form, which is at least unambiguous.
   */
  var ZONE_ABBREV = {
    'Europe/Dublin': 'IST',
    'Europe/London': 'BST',
    'Atlantic/Reykjavik': 'GMT',
    'Europe/Lisbon': 'WEST',
    'Europe/Madrid': 'CEST',
    'Europe/Paris': 'CEST',
    'Europe/Brussels': 'CEST',
    'Europe/Amsterdam': 'CEST',
    'Europe/Berlin': 'CEST',
    'Europe/Rome': 'CEST',
    'Europe/Zurich': 'CEST',
    'Europe/Vienna': 'CEST',
    'Europe/Oslo': 'CEST',
    'Europe/Stockholm': 'CEST',
    'Europe/Copenhagen': 'CEST'
  };

  function zoneAbbrev(tz, date) {
    if (ZONE_ABBREV[tz]) {
      return ZONE_ABBREV[tz];
    }
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, timeZoneName: 'short', hour: '2-digit'
      }).formatToParts(date);
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].type === 'timeZoneName') {
          return parts[i].value;
        }
      }
    } catch (err) { /* fall through */ }
    return '';
  }

  function formatCoords(lat, lon) {
    return Math.abs(lat).toFixed(2) + '°' + (lat >= 0 ? 'N' : 'S') + ', '
      + Math.abs(lon).toFixed(2) + '°' + (lon >= 0 ? 'E' : 'W');
  }

  function formatDuration(minutes) {
    var total = Math.round(minutes);
    var h = Math.floor(total / 60);
    var m = total % 60;
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  /*
   * Sunset, to the nearest five minutes.
   *
   * The Sun's position here comes from the eclipse's own Besselian elements
   * rather than a dedicated solar-position routine, which is good to roughly
   * plus or minus five minutes against a published sunset table — fine for
   * "the Sun sets partway through", but not worth printing to the minute.
   * Whether the Sun sets during the eclipse at all is decided by a sign rather
   * than by these minutes, so that part of the copy is robust.
   */
  function roughTime(date, loc, abbrev) {
    var rounded = new Date(Math.round(date.getTime() / 300000) * 300000);
    return loc.formatTime(rounded) + (abbrev ? ' ' + abbrev : '');
  }

  function deviceTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (err) {
      return 'UTC';
    }
  }

  /*
   * Timezone for a detected position.
   *
   * Geolocation gives coordinates but no timezone, and there is no zone
   * database in the browser, so the device's own zone is the only available
   * answer — and the right one, since "here" is where the reader is. It is
   * wrong only when the clock disagrees with the position (a device left on
   * home time while travelling), and then it is silently wrong: New York
   * coordinates labelled IST.
   *
   * Compare the device's UTC offset against the position's mean solar offset
   * (longitude / 15). Political zones stray a couple of hours from solar time
   * quite legitimately — Spain runs about two hours ahead of its sun — so only
   * a gap beyond four hours is treated as a mismatch, and then times are shown
   * in UTC rather than under a label that is confidently wrong.
   */
  function timeZoneForPosition(lonDeg) {
    var tz = deviceTimeZone();
    try {
      var probe = new Date(Date.UTC(2026, 7, 12, 18, 0, 0));
      var asZone = new Date(probe.toLocaleString('en-US', { timeZone: tz }));
      var asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
      var deviceOffsetHours = (asZone - asUtc) / 3600000;
      if (Math.abs(deviceOffsetHours - lonDeg / 15) > 4) {
        return 'UTC';
      }
    } catch (err) { /* keep the device zone if the probe fails */ }
    return tz;
  }

  /* ---------- DOM plumbing ---------- */

  function byId(id) {
    return document.getElementById(id);
  }

  // Every element the location can rewrite carries data-default, so resetting is
  // just putting back what the page shipped with rather than a second copy of
  // the Dublin figures maintained in here.
  function setText(id, value) {
    var el = byId(id);
    if (!el) {
      return;
    }
    if (value === null) {
      el.innerHTML = el.getAttribute('data-default') || el.innerHTML;
    } else {
      el.textContent = value;
    }
  }

  function setHref(id, value) {
    var el = byId(id);
    if (!el) {
      return;
    }
    el.setAttribute('href', value === null ? (el.getAttribute('data-default') || el.href) : value);
  }

  /*
   * Offset for the occulting disc in the "maximum eclipse" figure. The Sun is
   * drawn at r=118 and the Moon at r=122; the gap between their centres is what
   * reads as the crescent, so it has to be solved for the real obscuration
   * rather than left at the value the illustration was drawn with.
   */
  function crescentOffset(percent) {
    var rSun = 118;
    var rMoon = 122;
    var goal = Math.max(0, Math.min(100, percent)) / 100;

    function covered(d) {
      if (d >= rSun + rMoon) {
        return 0;
      }
      if (d <= Math.abs(rMoon - rSun)) {
        return 1;
      }
      var a = 2 * Math.acos((d * d + rSun * rSun - rMoon * rMoon) / (2 * d * rSun));
      var b = 2 * Math.acos((d * d + rMoon * rMoon - rSun * rSun) / (2 * d * rMoon));
      return (0.5 * rSun * rSun * (a - Math.sin(a)) + 0.5 * rMoon * rMoon * (b - Math.sin(b)))
        / (Math.PI * rSun * rSun);
    }

    var lo = 0;
    var hi = rSun + rMoon;
    for (var i = 0; i < 48; i += 1) {
      var mid = (lo + hi) / 2;
      if (covered(mid) > goal) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  }

  /* ---------- applying a location to the page ---------- */

  function describe(circ, tz, fmt) {
    if (!circ.visible) {
      return 'The eclipse is not visible from here.';
    }
    var abbrev = zoneAbbrev(tz, circ.maxEclipse);
    var pct = circ.obscuration >= 99.95
      ? circ.obscuration.toFixed(2)
      : Math.round(circ.obscuration);
    if (circ.isTotal) {
      return 'Totality — ' + Math.round(circ.centralDurationSeconds) + ' s, maximum '
        + fmt.format(circ.maxEclipse) + ' ' + abbrev;
    }
    return pct + '% covered · maximum ' + fmt.format(circ.maxEclipse) + ' ' + abbrev;
  }

  function apply(place) {
    var lat = place.lat;
    var lon = place.lon;
    var tz = place.tz || deviceTimeZone();
    var circ = window.EclipseLocal.circumstances(lat, lon, place.alt || 0);
    var fmt = timeFormatter(tz);
    var coords = formatCoords(lat, lon);
    var label = place.name || coords;

    function formatTime(date) {
      return fmt.format(date);
    }

    var payload = {
      lat: lat,
      lon: lon,
      latlng: [lat, lon],
      label: label,
      coordsLabel: coords,
      timeZone: tz,
      source: place.source || 'picker',
      circ: circ,
      tzAbbrev: circ.maxEclipse ? zoneAbbrev(tz, circ.maxEclipse) : '',
      mapMeta: describe(circ, tz, fmt),
      formatTime: formatTime
    };

    updateCopy(payload);
    window.eclipseLocation.set(payload);
    return payload;
  }

  function updateCopy(loc) {
    var circ = loc.circ;
    var abbrev = zoneAbbrev(loc.timeZone, circ.maxEclipse);

    setText('issue-location', loc.label);
    setText('telemetry-coords', loc.coordsLabel);
    setText('t-place', loc.label);

    var tad = 'https://www.timeanddate.com/eclipse/map/2026-august-12?n=%40'
      + loc.lat.toFixed(5) + '%2C' + loc.lon.toFixed(5);
    setHref('tad-link', tad);
    setHref('tad-card-link', tad);

    var verdict = byId('totality-verdict');

    if (!circ.visible) {
      // Nothing to report: blank the figures rather than show numbers that do
      // not describe anything the reader could go outside and see.
      setText('t-kind', 'no eclipse is visible — the Moon\'s shadow never reaches here, and the event runs from');
      setText('t-first', '—');
      setText('t-last', '—');
      setText('t-max', '—');
      setText('t-direction', 'horizon');
      setText('phase-max-copy', 'Maximum — the eclipse is not visible from this location.');
      setText('stat-caption', 'The eclipse is not visible from ' + loc.label + '. Pick a location in Europe, the North Atlantic or the Americas to see local figures.');
      setText('stat-duration', '—');
      if (verdict) {
        verdict.hidden = false;
        verdict.textContent = 'From ' + loc.label + ', the Sun is not eclipsed at all — this eclipse is confined to the Arctic, the North Atlantic, Europe and the Americas.';
      }
      return;
    }

    var pctRounded = Math.round(circ.obscuration);
    var pctText = circ.obscuration >= 99.95 && !circ.isTotal
      ? circ.obscuration.toFixed(2) + '%'
      : pctRounded + '%';

    setText('t-kind', circ.isTotal ? 'the total eclipse' : 'the partial eclipse');
    setText('t-first', loc.formatTime(circ.firstContact));
    setText('t-last', loc.formatTime(circ.lastContact) + (abbrev ? ' ' + abbrev : ''));
    setText('t-max', loc.formatTime(circ.maxEclipse));
    setText('t-direction', circ.direction);

    setText('phase-max-copy', circ.isTotal
      ? 'Maximum — totality, ' + Math.round(circ.centralDurationSeconds) + ' seconds of it from this viewpoint.'
      : 'Maximum — roughly ' + pctText + ' coverage from this viewpoint.');

    setText('stat-caption', circ.isTotal
      ? 'Total obscuration from ' + loc.label + ' — the Sun disappears completely for '
        + Math.round(circ.centralDurationSeconds) + ' seconds.'
      : 'Maximum obscuration over ' + loc.label + ' — a '
        + (circ.obscuration > 90 ? 'wafer-thin' : 'shrinking') + ' crescent of sunlight remains.');

    setText('stat-duration', formatDuration(circ.durationMinutes));

    setText('max-figcaption', 'Maximum eclipse — '
      + (circ.isTotal
        ? 'the Sun completely hidden'
        : 'the Sun cut to a crescent at roughly ' + pctText + ' obscuration')
      + ', around ' + loc.formatTime(circ.maxEclipse) + (abbrev ? ' ' + abbrev : '') + '.');

    var moon = byId('me-moon');
    if (moon) {
      moon.setAttribute('cy', (200 + crescentOffset(circ.obscuration)).toFixed(1));
    }
    var svg = byId('max-eclipse-svg');
    if (svg) {
      svg.setAttribute('aria-label', circ.isTotal
        ? 'The Sun at maximum eclipse, completely covered by the Moon'
        : 'The Sun at maximum eclipse, reduced to a thin crescent as the Moon covers about '
          + pctRounded + ' percent of its face');
    }

    if (verdict) {
      verdict.hidden = false;
      if (circ.isTotal) {
        verdict.textContent = 'You are inside the band. From ' + loc.label + ' the Sun is totally eclipsed for '
          + Math.round(circ.centralDurationSeconds) + ' seconds, with the Sun '
          + Math.round(circ.sunAltitudeDeg) + '° above the ' + circ.direction + ' horizon.';
      } else if (circ.obscuration >= 99) {
        verdict.textContent = 'From ' + loc.label + ' you are just outside the band — ' + pctText
          + ' covered, but no totality. The difference is not a matter of degree: only inside the band does the corona appear.';
      } else {
        verdict.textContent = 'From ' + loc.label + ' the eclipse is partial: ' + pctText
          + ' of the Sun covered at maximum, with the Sun ' + Math.round(circ.sunAltitudeDeg)
          + '° above the ' + circ.direction + ' horizon.';
      }
    }

    /*
     * Horizon caveats. Obscuration is a geometric figure and stays true even
     * when the Sun has set, so these do not replace the numbers — they say how
     * much of the event is actually above the horizon to be watched.
     */
    var horizonNote = '';
    var setsAt = circ.horizonCrossing ? roughTime(circ.horizonCrossing, loc, abbrev) : '';
    if (circ.sunAltitudeAtFirstDeg !== null && circ.sunAltitudeAtFirstDeg <= 0 && !circ.sunUp) {
      horizonNote = 'The Sun is already below the horizon here for the whole eclipse — these are the figures for an unobstructed view, not for what you could see.';
    } else if (!circ.sunUp && circ.horizonCrossing) {
      horizonNote = 'The Sun sets here around ' + setsAt
        + ', before maximum — you would see the eclipse begin, then lose the Sun below the horizon partway through.';
    } else if (circ.sunUp && circ.horizonCrossing) {
      horizonNote = 'The Sun sets here around ' + setsAt
        + ', so the closing stages happen below the horizon.';
    } else if (circ.sunAltitudeDeg < 5) {
      horizonNote = 'The Sun is only ' + Math.round(circ.sunAltitudeDeg)
        + '° up at maximum, so you need a genuinely flat ' + circ.direction + ' horizon.';
    }

    if (horizonNote && verdict) {
      verdict.textContent += ' ' + horizonNote;
    }
  }

  function resetToDefaults() {
    ['issue-location', 'telemetry-coords', 't-place', 't-kind', 't-first', 't-last',
      't-max', 't-direction', 'phase-max-copy', 'stat-caption', 'stat-duration',
      'max-figcaption'].forEach(function (id) {
      setText(id, null);
    });
    setHref('tad-link', null);
    setHref('tad-card-link', null);

    var moon = byId('me-moon');
    if (moon) {
      moon.setAttribute('cy', moon.getAttribute('data-default-cy') || '216.8');
    }
    var verdict = byId('totality-verdict');
    if (verdict) {
      verdict.hidden = true;
      verdict.textContent = '';
    }
  }

  /* ---------- the control ---------- */

  function build() {
    var host = document.querySelector('.coverlines');
    if (!host) {
      return;
    }

    var wrap = document.createElement('div');
    wrap.className = 'location-control';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'location-btn';
    button.textContent = 'Use my location';

    var select = document.createElement('select');
    select.className = 'location-select';
    select.id = 'location-select';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'or choose a place…';
    select.appendChild(placeholder);

    PLACES.forEach(function (group) {
      var og = document.createElement('optgroup');
      og.label = group.group;
      group.items.forEach(function (item) {
        var opt = document.createElement('option');
        opt.value = item.name;
        opt.textContent = item.name;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });

    var label = document.createElement('label');
    label.className = 'u-visually-hidden';
    label.setAttribute('for', 'location-select');
    label.textContent = 'Choose a viewing location';

    var status = document.createElement('p');
    status.className = 'location-status';
    status.setAttribute('role', 'status');

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'location-reset';
    reset.textContent = 'Reset to Dublin';
    reset.hidden = true;

    var note = document.createElement('p');
    note.className = 'location-note';
    note.textContent = 'Worked out in your browser. Your coordinates are never sent anywhere.';

    wrap.appendChild(button);
    wrap.appendChild(label);
    wrap.appendChild(select);
    wrap.appendChild(status);
    wrap.appendChild(reset);
    wrap.appendChild(note);
    host.appendChild(wrap);

    function findPlace(name) {
      for (var i = 0; i < PLACES.length; i += 1) {
        for (var j = 0; j < PLACES[i].items.length; j += 1) {
          if (PLACES[i].items[j].name === name) {
            return PLACES[i].items[j];
          }
        }
      }
      return null;
    }

    function announce(place) {
      var loc = apply(place);
      status.textContent = loc.circ.visible
        ? loc.label + ' — ' + loc.mapMeta
        : loc.label + ' — the eclipse is not visible from there.';
      reset.hidden = false;
      return loc;
    }

    function remember(place) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          name: place.name || null,
          lat: place.lat,
          lon: place.lon,
          tz: place.tz || null,
          source: place.source || 'picker'
        }));
      } catch (err) { /* private mode, quota — not worth surfacing */ }
    }

    button.addEventListener('click', function () {
      if (!navigator.geolocation) {
        status.textContent = 'This browser cannot share a location — choose a place below instead.';
        select.focus();
        return;
      }
      button.disabled = true;
      button.textContent = 'Locating…';
      status.textContent = '';

      navigator.geolocation.getCurrentPosition(function (pos) {
        button.disabled = false;
        button.textContent = 'Use my location';
        var place = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          alt: pos.coords.altitude || 0,
          tz: timeZoneForPosition(pos.coords.longitude),
          source: 'geolocation'
        };
        select.value = '';
        announce(place);
        remember(place);
      }, function (err) {
        button.disabled = false;
        button.textContent = 'Use my location';
        status.textContent = err && err.code === 1
          ? 'Location permission declined — choose a place below instead.'
          : 'Could not get a location — choose a place below instead.';
        select.focus();
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    });

    select.addEventListener('change', function () {
      var place = findPlace(select.value);
      if (!place) {
        return;
      }
      var chosen = {
        name: place.name, lat: place.lat, lon: place.lon, tz: place.tz, source: 'picker'
      };
      announce(chosen);
      remember(chosen);
    });

    reset.addEventListener('click', function () {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch (err) { /* ignore */ }
      select.value = '';
      status.textContent = '';
      reset.hidden = true;
      resetToDefaults();
      apply({
        name: DUBLIN.name, lat: DUBLIN.lat, lon: DUBLIN.lon, tz: DUBLIN.tz, source: 'default'
      });
    });

    /* Restore a previous choice, if there is one. */
    var saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    } catch (err) {
      saved = null;
    }
    if (saved && typeof saved.lat === 'number' && typeof saved.lon === 'number') {
      if (saved.name) {
        select.value = saved.name;
      }
      announce(saved);
    } else {
      // No stored choice: publish Dublin so the other modules start from the
      // same computed numbers the page ships with, without prompting for
      // anything or changing what the reader sees.
      apply({
        name: DUBLIN.name, lat: DUBLIN.lat, lon: DUBLIN.lon, tz: DUBLIN.tz, source: 'default'
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
