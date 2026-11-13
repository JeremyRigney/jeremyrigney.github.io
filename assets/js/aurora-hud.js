/*
 * jeremy.ie/aurora — the readouts, the layer switch and the place.
 *
 * Everything here is DOM. It listens for aurora:data from aurora-data.js and
 * redraws whatever it binds; a 30-second clock keeps the relative times, the sky
 * and the staleness marks honest between updates. Values are written into
 * [data-bind] elements, so the markup decides where a number appears and this file
 * only decides what it says.
 *
 * Staleness never moves anything: a readout whose feed has gone quiet fades and
 * keeps its last value, so the eye still finds it where it was.
 *
 * The place starts at Malin Head, Ireland's northern tip and the usual Irish aurora
 * spot. "Use my location" asks the browser once; the coordinates are kept in
 * localStorage (aurora.location) and used here, in the page. The only thing that
 * leaves it is the place rounded to half a degree, for the cloud (aurora-data.js).
 *
 * The verdict asks for everything an aurora watcher would: a dark sky, OVATION putting
 * aurora in view, enough Kp for the place (Data.kpNeeded) and no blanket of cloud.
 *
 * The two views from space have a segment each in the top capsule, written from
 * aurora-wind.js: the wind arriving at the Earth and what it is doing to the
 * magnetosphere, and what NOAA's model has coming over the next three days. In those
 * views the time beside them says what that wind's time is and where it comes from.
 */
(function () {
  'use strict';

  var Geo = window.AuroraGeo;
  var Data = window.AuroraData;
  if (!Geo || !Data) { return; }

  var DEFAULT_PLACE = { lat: 55.38, lon: -7.37, name: 'Malin Head, Ireland', label: 'Malin Head', source: 'default' };
  var STORAGE_KEY = 'aurora.location';

  var place = DEFAULT_PLACE;
  var layer = 'seen';

  /* ---------- Binding ---------- */

  function each(name, fn) {
    var els = document.querySelectorAll('[data-bind="' + name + '"]');
    for (var i = 0; i < els.length; i++) { fn(els[i]); }
  }

  function text(name, value) {
    each(name, function (el) { el.textContent = value; });
  }

  function html(name, value) {
    each(name, function (el) { el.innerHTML = value; });
  }

  function stale(name, isStale) {
    each(name, function (el) {
      var target = el.closest('.gauge, .place-figures > div, .view-times') || el;
      target.setAttribute('data-stale', isStale ? 'true' : 'false');
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------- Formatting ---------- */

  var MINUS = '−';

  function signed(v, digits) {
    var s = Math.abs(v).toFixed(digits);
    if (+s === 0) { return s; }
    return (v < 0 ? MINUS : '+') + s;
  }

  var timeFmt = (function () {
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
    } catch (err) {
      return null;
    }
  })();

  // Some locales name Irish winter time "GMT+0"; it is plain GMT.
  function clock(d) {
    if (!d || isNaN(d)) { return '–'; }
    if (!timeFmt) { return d.toISOString().slice(11, 16) + ' UTC'; }
    return timeFmt.format(d).replace(/\bGMT\+0\b/, 'GMT');
  }

  // The same as markup, the zone in a span of its own so it can be set smaller.
  function clockHtml(s) {
    var m = /^(.*\d{2}:\d{2})\s+(\S.*)$/.exec(s);
    return m ? escapeHtml(m[1]) + '<span class="tz"> ' + escapeHtml(m[2]) + '</span>' : escapeHtml(s);
  }

  var dayFmt = (function () {
    try { return new Intl.DateTimeFormat(undefined, { weekday: 'short' }); } catch (err) { return null; }
  })();

  // A time, with its weekday when it isn't today.
  function when(d) {
    var today = new Date();
    var sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return (sameDay || !dayFmt ? '' : dayFmt.format(d) + ' ') + clock(d);
  }

  function relative(d) {
    var min = Math.round((d.getTime() - Date.now()) / 60000);
    if (Math.abs(min) < 1) { return 'now'; }
    var span = Math.abs(min) < 90 ? Math.abs(min) + ' min' : Math.round(Math.abs(min) / 60) + ' h';
    return min > 0 ? 'in ' + span : span + ' ago';
  }

  // The slider's frame, when it is showing something other than live.
  function shownFrame() {
    var M = window.AuroraModel;
    if (!M || M.viewTime === null || !M.ready()) { return null; }
    var f = M.frame(M.viewTime);
    return f.kp === null ? null : f;
  }

  function modelChance(f) {
    return function (lat, lon) { return window.AuroraModel.chanceAt(lat, lon, f); };
  }

  var KIND = { observed: 'observed Kp', estimated: 'NOAA’s estimated Kp', predicted: 'NOAA’s forecast Kp' };

  function coords(lat, lon) {
    return Math.abs(lat).toFixed(2) + '°' + (lat >= 0 ? 'N' : 'S') + ' '
      + Math.abs(lon).toFixed(2) + '°' + (lon >= 0 ? 'E' : 'W');
  }

  var WORDS = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };

  function direction(deg) {
    var eight = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
    return WORDS[eight];
  }

  // NOAA's G-scale from Kp: G1 at Kp 5 through G5 at Kp 9. Kp comes in thirds and NOAA
  // counts 5- (4.67) as Kp 5, so levels go by the rounded value.
  function gLevel(kp) {
    kp = Math.round(kp);
    if (kp >= 9) { return 5; }
    if (kp >= 8) { return 4; }
    if (kp >= 7) { return 3; }
    if (kp >= 6) { return 2; }
    if (kp >= 5) { return 1; }
    return 0;
  }

  var G_WORDS = ['', 'G1 minor storm', 'G2 moderate storm', 'G3 strong storm', 'G4 severe storm', 'G5 extreme storm'];

  function kpWords(kp) {
    var g = gLevel(kp);
    if (g) { return G_WORDS[g]; }
    kp = Math.round(kp);
    if (kp >= 4) { return 'Active'; }
    if (kp >= 3) { return 'Unsettled'; }
    return 'Quiet';
  }

  /* ---------- The verdict ---------- */

  // Kp comes in thirds and NOAA counts 5- as 5, so a third short still counts.
  var KP_THIRD = 0.34;

  // The Kp the verdict goes by: the slider's when it is modelling, else the live
  // estimate, else NOAA's 3-hour block for now. Null when there is none at all.
  function kpInForce(f) {
    if (f && f.modelMix > 0) { return f.kp; }
    var s = Data.state;
    if (s.kpNow && !Data.isStale('kpNow')) { return s.kpNow.kp; }
    var now = Date.now(), block = null;
    (s.kpForecast || []).forEach(function (r) {
      if (r.time.getTime() <= now && now < r.time.getTime() + 180 * 60000) { block = r; }
    });
    return block ? block.kp : s.kpNow ? s.kpNow.kp : null;
  }

  /*
   * at is null for now, or the slider's time. kp is the Kp in force, need what this
   * place needs for aurora low in its sky (eased when the sky is clear), hope what it
   * needs on a clear night. cloud is the cover then, or null.
   */
  function verdict(see, sky, night, at, kp, need, hope, cloud) {
    if (!see) { return 'Waiting for NOAA’s forecast…'; }
    var o = see.overhead, h = see.horizon;
    var dir = see.bearing != null ? direction(see.bearing) : 'north';
    var lead = at ? 'At ' + when(at) + ': ' : '';
    var expect = !at && night && night.kp >= Math.max(1, hope) - KP_THIRD
      ? ' NOAA expects Kp ' + night.kp.toFixed(1) + ' at its height tonight.'
      : '';

    if (sky.key === 'day') {
      return at
        ? lead + 'daylight here, so nothing to see.'
        : 'Daylight here, so nothing to see yet.' + (expect || ' Check back after dark.');
    }

    // OVATION's faint fringe reaches the horizon at any Kp, so low in the sky also
    // waits for the Kp the place needs. Overhead at the place is a storm already.
    var low = kp === null || kp >= need - KP_THIRD;
    var line, tip = '.';
    if (o >= 30) { line = 'Aurora likely overhead'; }
    else if (o >= 10) { line = 'Aurora possible overhead'; }
    else if (low && h >= 30) { line = 'Aurora likely, low in the ' + dir; }
    else if (low && h >= 10) { line = 'Possible low in the ' + dir; tip = ' — a phone camera will catch it before your eyes do.'; }
    else { return at ? lead + 'unlikely from here.' : 'Unlikely from here right now.' + expect; }

    if (cloud && cloud.key === 'cloudy') {
      line += ', but cloud is in the way.';
    } else {
      line += tip;
      if (sky.key === 'civil' || sky.key === 'nautical') { line += ' Better once it’s darker.'; }
    }
    return at ? lead + line.charAt(0).toLowerCase() + line.slice(1) : line;
  }

  // What the place needs, in the place's own words, under its +.
  function kpRule(lat, need, hope, kp, at) {
    var side = lat >= 0 ? 'north' : 'south';
    var rule = Math.round(hope) < 1
      ? 'From here, aurora can show at any Kp once it’s dark and clear.'
      : 'From here, aurora usually shows low in the ' + side + ' from about <b>Kp ' + Math.round(need)
        + '</b>, or <b>Kp ' + Math.round(hope) + '</b> under a clear sky.';
    return kp === null ? rule : rule + ' Kp is <b>' + kp.toFixed(1) + '</b> ' + (at ? 'then' : 'now') + '.';
  }

  /* ---------- Rendering ---------- */

  function renderTimes() {
    var f0 = shownFrame();
    var note = document.querySelector('.legend-model');
    if (note) { note.hidden = !(f0 && f0.modelMix > 0); }
    var v = view();
    if (v === 'sun') {
      renderGoesTime();
      return;
    }
    if (Wind && (v === 'wind' || v === 'l1' || v === 'system')) {
      renderSpaceTimes(v);
      return;
    }
    var ov = Data.state.ovation;
    if (!ov) {
      html('times', Data.state.failed.ovation
        ? '<span class="stale-note">NOAA’s forecast didn’t load. Retrying.</span>'
        : '<span class="stale-note">Waiting for NOAA…</span>');
      return;
    }
    var M = window.AuroraModel;
    var f = shownFrame();
    if (f && f.modelMix > 0) {
      var at = new Date(f.t);
      html('times', '<span class="tag tag-model">Modelled</span><span class="times-main"><span class="times-lead">For </span><b>' + clockHtml(when(at)) + '</b></span>'
        + '<span class="times-rel">' + escapeHtml(relative(at)) + '</span>'
        + '<span class="times-src">OVATION-Prime from ' + escapeHtml(KIND[f.kind] || 'Kp') + ' ' + f.kp.toFixed(1) + '</span>');
      stale('times', false);
      return;
    }
    if (M && M.viewTime !== null && !M.ready()) {
      html('times', '<span class="stale-note">Loading the model…</span>');
      return;
    }
    var tag = Data.state.demo ? '<span class="tag tag-demo">Simulated</span>' : '<span class="tag">Live</span>';
    html('times', tag + '<span class="times-main"><span class="times-lead">Forecast for </span><b>' + clockHtml(clock(ov.forecast)) + '</b></span>'
      + '<span class="times-rel">' + escapeHtml(relative(ov.forecast)) + '</span>'
      + '<span class="times-src">from data at ' + escapeHtml(clock(ov.observed)) + '</span>');
    stale('times', Data.isStale('ovation'));
  }

  // Kp as nine steps, each in the storm colour of the Kp range it covers (step 6 is
  // Kp 5 to 6, G1), lit up to the value; the step it is part-way through is part-lit.
  function kpMeter(kp) {
    var out = '';
    for (var i = 1; i <= 9; i++) {
      var fill = Math.max(0, Math.min(1, kp - (i - 1)));
      out += '<i data-g="' + gLevel(i - 0.5) + '" style="--fill:' + Math.round(fill * 100) + '%"></i>';
    }
    return out;
  }

  // Away from live, Kp and the hemispheric power are the model's for that time; the
  // solar wind has no forecast, so its readouts keep the live values, faded.
  function renderGauges() {
    var s = Data.state;
    var f = shownFrame();
    var modelled = !!(f && f.modelMix > 0);

    if (modelled) {
      text('kp', f.kp.toFixed(1));
      html('kp-meter', kpMeter(f.kp));
      html('kp-scale', '<span class="scale-chip" data-g="' + gLevel(f.kp) + '">' + escapeHtml(kpWords(f.kp))
        + '</span> &middot; ' + (f.kind === 'observed' ? 'observed' : 'forecast'));
      stale('kp', false);
    } else {
      if (s.kpNow) {
        text('kp', s.kpNow.kp.toFixed(1));
        html('kp-meter', kpMeter(s.kpNow.kp));
        html('kp-scale', '<span class="scale-chip" data-g="' + gLevel(s.kpNow.kp) + '">' + escapeHtml(kpWords(s.kpNow.kp)) + '</span>');
      }
      stale('kp', Data.isStale('kpNow'));
    }

    if (s.mag && s.mag.length) { text('bz', signed(s.mag[s.mag.length - 1].bz, 1)); }
    stale('bz', modelled || Data.isStale('mag'));

    if (s.wind && s.wind.length) { text('speed', Math.round(s.wind[s.wind.length - 1].speed)); }
    stale('speed', modelled || Data.isStale('wind'));

    if (modelled) {
      text('hp-north', Math.round(f.power[0]));
      text('hp-south', Math.round(f.power[1]));
      stale('hp-north', false);
      stale('hp-south', false);
    } else {
      if (s.power) {
        text('hp-north', Math.round(s.power.north));
        text('hp-south', Math.round(s.power.south));
      }
      stale('hp-north', Data.isStale('power'));
      stale('hp-south', Data.isStale('power'));
    }

    var south = Data.hemisphere(true, modelled ? modelChance(f) : null);
    if (south) {
      text('peak-south', Math.round(south.peak));
      text('edge-south', south.edge === null ? '–' : Math.abs(south.edge));
    }
    stale('peak-south', !modelled && Data.isStale('ovation'));
    stale('edge-south', !modelled && Data.isStale('ovation'));
  }

  function renderPlace() {
    text('place-name', place.name);
    text('place-coords', coords(place.lat, place.lon));

    var f = shownFrame();
    var at = f ? new Date(f.t) : null;
    var see = Data.seeing(place.lat, place.lon, f && f.modelMix > 0 ? modelChance(f) : null);
    var alt = Geo.sunAltitude(at || new Date(), place.lat, place.lon);
    var sky = Geo.sky(alt);
    var night = Data.tonight(place.lat, place.lon);
    // The cloud for the time it sits beside: the slider's, or live, NOAA's forecast time.
    var ov = Data.state.ovation;
    var cloudTime = at || (ov ? ov.forecast : new Date());
    var cloud = Data.cloudAt(cloudTime);
    var kp = kpInForce(f);
    var base = Data.kpNeeded(place.lat, place.lon, false);
    var hope = Data.kpNeeded(place.lat, place.lon, true);
    var need = cloud && cloud.key === 'clear' ? hope : base;

    text('verdict', verdict(see, sky, night, at, kp, need, hope, cloud));
    html('kp-rule', kpRule(place.lat, base, hope, kp, at));
    text('sky', sky.label);
    if (see) {
      text('overhead', Math.round(see.overhead));
      text('horizon', Math.round(see.horizon));
      text('bearing', see.bearing != null ? Geo.compass(see.bearing) : '');
    }
    var old = Data.isStale('ovation');
    stale('overhead', old);
    stale('horizon', old);
    renderCloud(cloudTime, sky, cloud);
  }

  /*
   * The cloud at the place for the time shown, beside that time: a glyph and the
   * percentage. The Sun or Moon goes by the sky there; for partly cloudy, the cloud is
   * cut out of the one behind it, so the glyph needs no background colour.
   */
  var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.75 1.75M16.95 16.95l1.75 1.75M5.3 18.7l1.75-1.75M16.95 7.05l1.75-1.75"/>';
  var MOON = '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/>';
  var CLOUD = 'M6.5 19h11a4 4 0 0 0 .5-7.97 6 6 0 0 0-11.6-1A4.5 4.5 0 0 0 6.5 19z';

  function glyph(key, dark) {
    var body = dark ? MOON : SUN;
    var inner;
    if (key === 'clear') {
      inner = body;
    } else if (key === 'cloudy') {
      inner = '<path d="' + CLOUD + '"/>';
    } else {
      // Scaled parts carry their own stroke widths, so every line draws at 1.6.
      var small = 'transform="translate(-1.5 4.2) scale(0.82)"';
      inner = '<mask id="cloud-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">'
        + '<rect width="24" height="24" fill="#fff"/>'
        + '<path ' + small + ' d="' + CLOUD + '" fill="#000" stroke="#000" stroke-width="4.4"/></mask>'
        + '<g mask="url(#cloud-cut)"><g transform="translate(9.2 -0.6) scale(0.62)" stroke-width="2.6">' + body + '</g></g>'
        + '<path ' + small + ' stroke-width="1.95" d="' + CLOUD + '"/>';
    }
    return '<svg class="cloud-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }

  var COVER = { clear: 'clear', partly: 'partly cloudy', cloudy: 'cloudy' };

  function renderCloud(at, sky, cloud) {
    each('cloud', function (el) {
      el.hidden = !cloud;
      if (!cloud) { return; }
      var pct = Math.round(cloud.pct);
      el.innerHTML = glyph(cloud.key, sky.key !== 'day')
        + '<span class="cloud-pct">' + pct + '<span class="unit">%</span></span>';
      el.setAttribute('aria-label', 'Cloud at ' + when(at) + ' around '
        + (place.source === 'geolocation' ? 'you' : place.name) + ': ' + pct + '%, ' + COVER[cloud.key]);
    });
    stale('cloud', Data.isStale('weather'));
  }

  /* ---------- The views from space ---------- */

  var Wind = window.AuroraWind;

  function view() {
    return document.body.getAttribute('data-view') || 'north';
  }

  // The time the page shows: the slider's, or now.
  function shownTime() {
    var M = window.AuroraModel;
    return M && M.viewTime !== null ? M.viewTime : Date.now();
  }

  function isLive() {
    var M = window.AuroraModel;
    return !M || M.viewTime === null;
  }

  function lowerFirst(s) {
    return s.charAt(0).toLowerCase() + s.slice(1);
  }

  // The wind reaching the Earth at the time shown: L1's, carried forward, or the model's.
  function upstream() {
    return Wind.upstream(shownTime(), { wind: Data.state.wind, mag: Data.state.mag });
  }

  function speedWord(v) {
    return v < 350 ? 'Slow' : v < 500 ? 'Moderate' : v < 650 ? 'Fast' : 'Very fast';
  }

  // What the wind is doing, as the place's verdict says what the sky is. Bz decides it:
  // south, the wind's energy gets in; north, even a fast wind mostly blows by.
  function windVerdict(up, at) {
    if (!up) { return at ? 'Nothing measured or modelled for this time.' : 'Waiting for the wind at L1…'; }
    var w = speedWord(up.v) + ' wind';
    var line;
    if (up.source === 'model') { line = w + ', by NOAA’s model. Bz can’t be forecast.'; }
    else if (up.bz === null) { line = w + '. Bz isn’t reporting.'; }
    else if (up.bz <= -5) { line = w + ' and Bz well south: the aurora is being fed.'; }
    else if (up.bz <= -1.5) { line = w + ', Bz south: some of its energy is getting in.'; }
    else if (up.v >= 500) { line = w + ', but Bz is north: little of it gets in.'; }
    else { line = w + ', Bz north: quiet.'; }
    return at ? 'At ' + when(at) + ': ' + lowerFirst(line) : line;
  }

  function renderWind() {
    if (!Wind) { return; }
    var live = isLive();
    var up = upstream();
    var b = Wind.boundaries(up);
    text('wind-verdict', windVerdict(up, live ? null : new Date(shownTime())));
    text('up-speed', up ? Math.round(up.v) : '–');
    text('up-density', up ? up.n.toFixed(1) : '–');
    text('up-pressure', up ? up.pd.toFixed(1) : '–');
    text('mp-standoff', up ? b.r0.toFixed(1) : '–');
    text('bs-standoff', up ? b.bs0.toFixed(1) : '–');
    text('up-mach', up ? b.mach.toFixed(1) : '–');
    text('up-source', !up ? 'Neither L1 nor NOAA’s model has this time.'
      : up.source === 'l1'
        ? 'Measured at L1 at ' + clock(new Date(up.seen)) + ', ' + Math.round(up.lagMin) + ' minutes before it arrives. Bz '
          + (up.bz === null ? 'isn’t reporting, and is taken as zero.' : signed(up.bz, 1) + ' nT.')
        : 'From NOAA’s WSA-Enlil model at the Earth: L1 hasn’t seen this wind yet. Bz is taken as zero.');
    var old = live && (!up || up.source !== 'l1') ? false : live && Data.isStale('wind');
    ['wind-verdict', 'up-speed', 'up-density', 'up-pressure', 'mp-standoff', 'bs-standoff', 'up-mach'].forEach(function (n) { stale(n, old); });
  }

  // What the model has coming at the Earth, from its outlook over the next three days.
  function sunVerdict(o, meta, at) {
    if (!meta) { return Wind.state.failed ? 'NOAA’s model didn’t load. Retrying.' : 'Waiting for NOAA’s model…'; }
    if (!o) { return 'NOAA’s run doesn’t reach this time.'; }
    var line;
    if (o.trend === 'rising') {
      line = 'Faster wind arrives ' + when(new Date(o.onset)) + ', up to ' + Math.round(o.peak.speed) + ' km/s.';
    } else if (o.trend === 'easing') {
      line = 'Easing to ' + Math.round(o.low.speed) + ' km/s by ' + when(new Date(o.low.time)) + '.';
    } else {
      // As far ahead as the run goes, which near its end is less than three days.
      var span = o.hours >= 66 ? 'for three days' : o.hours >= 40 ? 'for two days' : o.hours >= 18 ? 'for a day' : 'to the end of this run';
      line = 'Steady near ' + Math.round(o.now) + ' km/s ' + span + '.';
    }
    return at ? 'From ' + when(at) + ': ' + lowerFirst(line) : line;
  }

  function renderSun() {
    if (!Wind) { return; }
    var m = Wind.state.meta;
    var t = shownTime();
    var o = m ? Wind.outlook(t) : null;
    text('sun-verdict', sunVerdict(o, m, isLive() ? null : new Date(t)));
    text('sun-now', o ? Math.round(o.now) : '–');
    text('sun-peak', o ? Math.round(o.peak.speed) : '–');
    text('sun-low', o ? Math.round(o.low.speed) : '–');
    if (m) {
      html('sun-run', 'The run of ' + escapeHtml(when(new Date(m.source.ref))) + ', out ' + escapeHtml(when(new Date(m.source.modified)))
        + '. WSA ' + escapeHtml(String(m.source.wsa).replace(/^A_V/, '')) + ', Enlil ' + escapeHtml(m.source.enlil) + '.'
        + (Wind.stale() ? ' <span class="stale-note">No newer run has come since.</span>' : ''));
      text('sun-cme', m.source.cme
        ? 'This run was made for a coronal mass ejection, so that is in the picture.'
        : 'This is the daily run of the background wind. A coronal mass ejection only appears here once NOAA’s forecasters have run the model for it.');
    }
    var old = !m || Wind.stale();
    ['sun-verdict', 'sun-now', 'sun-peak', 'sun-low'].forEach(function (n) { stale(n, !!m && old); });
  }

  // The time beside those segments: whose wind this is, and for when.
  function renderSpaceTimes(v) {
    var t = shownTime(), live = isLive(), at = new Date(t);
    var main = '<span class="times-main"><b>' + clockHtml(live ? clock(at) : when(at)) + '</b></span>';
    function line(tag, rel, src) {
      html('times', tag + main + '<span class="times-rel">' + escapeHtml(rel) + '</span>'
        + '<span class="times-src">' + escapeHtml(src) + '</span>');
    }
    if (v === 'wind' || v === 'l1') {
      var up = upstream();
      if (!up) {
        html('times', '<span class="stale-note">' + (live ? 'Waiting for the wind at L1…' : 'Nothing for this time.') + '</span>');
        return;
      }
      if (up.source === 'model') {
        line('<span class="tag tag-model">Modelled</span>', live ? 'arriving now' : relative(at), 'WSA-Enlil at the Earth');
        stale('times', Wind.stale());
      } else {
        line(live ? '<span class="tag">Live</span>' : '<span class="tag tag-model">Measured</span>',
          live ? 'arriving now' : relative(at), 'passed L1 at ' + clock(new Date(up.seen)));
        stale('times', live && Data.isStale('wind'));
      }
      return;
    }
    var m = Wind.state.meta;
    if (!m) {
      html('times', '<span class="stale-note">' + (Wind.state.failed ? 'NOAA’s model didn’t load. Retrying.' : 'Waiting for NOAA’s model…') + '</span>');
      return;
    }
    var fr = Wind.frameAt(t);
    line('<span class="tag tag-model">Model</span>', live ? 'now' : relative(at),
      fr && fr.covered ? 'WSA-Enlil run of ' + when(new Date(m.source.ref)) : 'beyond this WSA-Enlil run');
    stale('times', Wind.stale());
  }

  // The Sun view: the time shown, and which of NOAA's pictures stands for it.
  function renderGoesTime() {
    var S = window.AuroraSun;
    var t = shownTime(), live = isLive(), at = new Date(t);
    var l = S ? S.lookup(t) : null;
    var src = l ? (l.latest ? 'latest picture, ' : 'picture of ') + clock(new Date(l.a.t))
      : S && S.state.failed ? 'NOAA’s pictures didn’t load' : 'loading NOAA’s pictures…';
    html('times', '<span class="tag">GOES-19</span><span class="times-main"><b>' + clockHtml(live ? clock(at) : when(at)) + '</b></span>'
      + '<span class="times-rel">' + escapeHtml(live ? 'now' : relative(at)) + '</span>'
      + '<span class="times-src">' + escapeHtml(src) + '</span>');
    stale('times', !!(S && S.state.failed));
  }

  // Its card: what the picture shows now, and how much of the day is in.
  function renderGoes() {
    var S = window.AuroraSun;
    if (!S) { return; }
    var st = S.state, n = st.frames.length, t = shownTime();
    var l = S.lookup(t);
    var verdict;
    if (!n) {
      verdict = st.failed ? 'NOAA’s pictures didn’t load. Retrying.' : 'Loading NOAA’s pictures…';
    } else if (l.latest && t - l.a.t > 30 * 60000) {
      verdict = 'No picture this far ahead: the latest, from ' + when(new Date(l.a.t)) + '.';
    } else if (l.earliest) {
      verdict = 'Before NOAA’s day of pictures: the earliest, from ' + when(new Date(l.a.t)) + '.';
    } else {
      verdict = 'The corona at 171 Å, about 600,000 K, at ' + when(new Date(l.a.t)) + '.';
    }
    text('goes-verdict', verdict);
    var left = S.loading();
    text('goes-frames', n ? n + ' of NOAA’s ' + st.list.length + ' pictures for the day loaded'
      + (left ? ', ' + left + ' more on the way.' : '.') : ' ');
  }

  // The legend from space: what the colours are of, and what the streaks are.
  function renderWindLegend() {
    var V = window.AuroraWindView, G = window.AuroraGlobe;
    if (!V) { return; }
    var sun = view() === 'system';
    text('wind-legend-of', sun ? 'by NOAA’s WSA-Enlil' : 'measured at L1');
    if (sun) {
      text('wind-legend-note', 'The model’s radial speed in the plane of the Earth’s orbit. The streaks move at that speed where they are, '
        + V.HELIO_HOURS_PER_S + ' hours of travel a second.');
    } else {
      var px = G && G.pxPerReAt ? G.pxPerReAt('wind') : 0;
      var times = px > 0 ? Math.round(V.speedup(px) / 10) * 10 : 0;
      text('wind-legend-note', 'The streaks are the wind measured at L1, carried to the Earth: their colour and speed follow its speed (a warm white when slow, through gold to red when fast), their number its density.'
        + (times ? ' They run about ' + times + ' times faster than life.' : ''));
    }
  }

  // The amplification is the globe's constant; the page only ever repeats it. The
  // bar runs 0.1 to ~32 kR on a log scale, in the colours the globe draws them.
  var legendBuilt = false;

  function renderLegend() {
    var G = window.AuroraGlobe;
    if (!G || !G.gain) { return; }
    var s = Math.round(G.gain).toLocaleString('en-IE');
    text('gain-text', s);
    if (G.LIFT) { text('lift-text', String(G.LIFT)); }
    var gainEl = document.getElementById('layer-gain');
    if (gainEl) { gainEl.textContent = '×' + s; }

    if (legendBuilt || !G.swatch) { return; }
    var bar = document.querySelector('.legend-bar-seen');
    if (!bar) { return; }
    var stops = [];
    // Fine enough steps to show the eye's floor fading in around 1 kR.
    for (var i = 0; i <= 25; i++) {
      var kR = Math.pow(10, -1 + 2.5 * i / 25);
      stops.push(G.swatch(kR) + ' ' + (i * 4) + '%');
    }
    bar.style.background = 'linear-gradient(90deg, ' + stops.join(', ') + ')';
    legendBuilt = true;
  }

  function renderAll() {
    renderTimes();
    renderGauges();
    renderPlace();
    renderLegend();
    renderWind();
    renderSun();
    renderGoes();
    renderWindLegend();
  }

  /* ---------- The layer switch ---------- */

  var toggle = document.getElementById('layer-toggle');
  var buttons = toggle ? Array.prototype.slice.call(toggle.querySelectorAll('button')) : [];
  var legendSeen = document.querySelector('.legend-seen');
  var legendProb = document.querySelector('.legend-prob');

  function setLayer(name, keepUrl) {
    layer = name === 'probability' ? 'probability' : 'seen';
    buttons.forEach(function (b) {
      var on = b.getAttribute('data-layer') === layer;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    if (legendSeen) { legendSeen.hidden = layer !== 'seen'; }
    if (legendProb) { legendProb.hidden = layer === 'seen'; }
    document.body.setAttribute('data-layer', layer);
    if (window.AuroraGlobe) { window.AuroraGlobe.setLayer(layer); }
    if (!keepUrl && window.history && history.replaceState) {
      var url = location.pathname + location.search + (layer === 'probability' ? '#probability' : '');
      history.replaceState(null, '', url);
    }
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () { setLayer(b.getAttribute('data-layer')); });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setLayer(layer === 'seen' ? 'probability' : 'seen');
        var on = toggle.querySelector('[aria-checked="true"]');
        if (on) { on.focus(); }
      }
    });
  });

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) { return; }
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { return; }
    if (e.key === 'p' || e.key === 'P') { setLayer(layer === 'seen' ? 'probability' : 'seen'); }
  });

  /* ---------- More ---------- */

  // A round + beside a card's title opens what the card doesn't need to say at first.
  // It names what it opens in aria-controls (one id or several); those start hidden.
  // A panel whose CSS gives it a --close-ms is closed in two steps: marked closing, so
  // it can animate back into its bar, and hidden once that's done.
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function showPanel(el, open) {
    clearTimeout(el.closeTimer);
    el.removeAttribute('data-closing');
    if (open) { el.hidden = false; return; }
    var ms = parseFloat(getComputedStyle(el).getPropertyValue('--close-ms')) || 0;
    if (el.hidden || !ms || calm) { el.hidden = true; return; }
    el.setAttribute('data-closing', '');
    el.closeTimer = setTimeout(function () {
      el.hidden = true;
      el.removeAttribute('data-closing');
    }, ms);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.more'), function (btn) {
    var ids = (btn.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { showPanel(el, open); }
      });
    });
  });

  /* ---------- The place ---------- */

  var locateBtn = document.querySelector('[data-action="locate"]');
  var resetBtn = document.querySelector('[data-action="reset-place"]');

  function usePlace(p) {
    place = p;
    Data.setPlace(p.lat, p.lon);
    if (window.AuroraGlobe) { window.AuroraGlobe.setPlace({ lat: p.lat, lon: p.lon, label: p.label }); }
    if (resetBtn) { resetBtn.hidden = p.source === 'default'; }
    renderPlace();
    document.dispatchEvent(new CustomEvent('aurora:place', { detail: { lat: p.lat, lon: p.lon } }));
  }

  // The place the readout is for, for the time slider's darkness strip.
  window.AuroraHud = {
    get place() { return { lat: place.lat, lon: place.lon }; }
  };

  function say(message) {
    text('locate-status', message);
  }

  function remember(p) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat: p.lat, lon: p.lon }));
    } catch (err) { /* private mode, quota: not worth surfacing */ }
  }

  function recall() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) { return null; }
      var v = JSON.parse(raw);
      if (isFinite(v.lat) && isFinite(v.lon) && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180) {
        return mine(v.lat, v.lon);
      }
    } catch (err) { /* ignore */ }
    return null;
  }

  function mine(lat, lon) {
    return { lat: lat, lon: lon, name: 'Your location', label: '', source: 'geolocation' };
  }

  if (locateBtn) {
    locateBtn.addEventListener('click', function () {
      if (!navigator.geolocation) {
        say('This browser can’t share a location.');
        return;
      }
      locateBtn.disabled = true;
      locateBtn.textContent = 'Locating…';
      say('');
      navigator.geolocation.getCurrentPosition(function (pos) {
        locateBtn.disabled = false;
        locateBtn.textContent = 'Use my location';
        var p = mine(pos.coords.latitude, pos.coords.longitude);
        usePlace(p);
        remember(p);
      }, function (err) {
        locateBtn.disabled = false;
        locateBtn.textContent = 'Use my location';
        say(err && err.code === 1
          ? 'Location permission declined. Showing Malin Head.'
          : 'Couldn’t get a location. Showing Malin Head.');
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
      say('');
      usePlace(DEFAULT_PLACE);
    });
  }

  /* ---------- Demo badge ---------- */

  if (Data.state.demo) {
    var badge = document.createElement('p');
    badge.className = 'demo-badge';
    badge.setAttribute('role', 'status');
    badge.textContent = 'Simulated storm — not the live forecast';
    document.body.appendChild(badge);
  }

  /* ---------- Boot ---------- */

  document.addEventListener('aurora:data', renderAll);
  setInterval(renderAll, 30000);

  // The slider moves many times a second while playing; the readouts follow at most
  // five times a second, and always land on the final time.
  var timePending = null, timeLast = 0;
  function onTime() {
    var wait = 200 - (Date.now() - timeLast);
    if (wait <= 0) {
      timeLast = Date.now();
      renderAll();
    } else if (!timePending) {
      timePending = setTimeout(function () {
        timePending = null;
        timeLast = Date.now();
        renderAll();
      }, wait);
    }
  }
  document.addEventListener('aurora:time', onTime);
  document.addEventListener('aurora:model', renderAll);
  document.addEventListener('aurora:view', renderAll);
  document.addEventListener('aurora:wind', renderAll);
  document.addEventListener('aurora:sun', onTime); // a frame in: as often as the slider's

  // The chips that lead to another view scroll there, smoothly where motion is welcome.
  Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (a) {
    a.addEventListener('click', function (e) {
      var G = window.AuroraGlobe;
      if (!G || !G.go) { return; } // the link's own anchor still works
      e.preventDefault();
      G.go(a.getAttribute('data-go'));
    });
  });

  setLayer(location.hash === '#probability' ? 'probability' : 'seen', true);
  usePlace(recall() || DEFAULT_PLACE);
  renderAll();
})();
