/*
 * Pitwall: the track map. A port of Pocket Pitwall's ui/TrackMap.kt and ui/Basemap.kt.
 *
 * The circuit from above with a dot per car. Positions arrive several times a second on the
 * stream (every few seconds when polling), so each car is snapped to the track and glides
 * along it between fixes rather than cutting across the infield. Under it all sits CARTO's
 * dark street map, faded back so the circuit and the cars stay the brightest things on it.
 *
 * Each car is a dot in its team's colour with its race position inside it, as a broadcast
 * map does; only the drivers you follow carry a name tag. Official turn numbers sit just off
 * their corners, and one race control has just named lights up. Flagged marshalling
 * sectors are drawn in the flag's colour, and the wind's arrow is turned with the map.
 *
 * Scroll or pinch to zoom (up to 6×) and drag to look about; double-click zooms in on the
 * spot, or back out. Dots, labels and lines keep their size on screen, so zooming spreads a
 * pack out. Follow keeps the view on a driver you follow.
 *
 * Two canvases: the street map, track, sectors and labels underneath, redrawn only when one
 * of them or the view changes; the cars on top, redrawn each display frame only while a car
 * is moving or the view is following one. Nothing is drawn while the map is out of sight.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var F = P.Format;
  var UI = P.UI;

  var MAX_ZOOM = 6;
  var FOLLOW_ZOOM = 3;
  /** How quickly the view catches up with a followed car: a soft camera, not a jerky one. */
  var FOLLOW_EASE_MS = 250;
  var PAD = 36;
  var DOT = 11;
  var TILE_ALPHA = 135 / 255;
  var DATA_V = '20261106';

  var root = document.getElementById('map');
  var baseCanvas = root.querySelector('.map-base');
  var carCanvas = root.querySelector('.map-cars');
  var base = baseCanvas.getContext('2d');
  var cars = carCanvas.getContext('2d');
  var windEl = root.querySelector('.map-wind');
  var windArrow = windEl.querySelector('svg');
  var followBtn = root.querySelector('.map-follow');
  var wholeBtn = root.querySelector('.map-whole');
  var creditEl = root.querySelector('.map-credit');
  var noteEl = root.querySelector('.map-note');

  var template = typeof window.cartoTiles === 'function' ? window.cartoTiles('dark_nolabels', { subdomain: '{s}', retina: '@2x' }) : null;

  var handlers = {};
  var s = {
    geoId: null,
    track: null,
    motion: null,
    failed: null,
    frame: null,
    streamed: null,
    followed: new Set(),
    shown: false,
    w: 0,
    h: 0,
    dpr: 1,
    zoom: 1,
    pan: [0, 0],
    follow: null,
    lastEase: 0,
    tiles: [],
    detail: [],
    images: new Map(),
    baseKey: '',
    detailAt: 0,
    raf: 0,
    tagLeft: {}
  };

  // ---------- Colours ----------

  var colours = {};
  function colour(name) {
    if (!colours[name]) { colours[name] = UI.token(name); }
    return colours[name];
  }

  function rgb(hex) {
    return [1, 3, 5].map(function (i) { return parseInt(hex.substr(i, 2), 16); });
  }

  /** A colour as a dark block to put its own bright text on: amount of it in the ground. */
  function shade(hex, amount) {
    var a = rgb(colour('--ground'));
    var b = rgb(hex);
    return 'rgb(' + a.map(function (v, i) { return Math.round(v + (b[i] - v) * amount); }).join(',') + ')';
  }

  function luminance(hex) {
    var c = rgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function flagColour(state) {
    if (state === 'RED') { return colour('--flag-red'); }
    if (state === 'CHEQUERED') { return colour('--flag-chequered'); }
    if (state === 'GREEN') { return colour('--flag-green'); }
    return colour('--flag-yellow');
  }

  // ---------- The view ----------

  function centre() {
    return [s.w / 2, s.h / 2];
  }

  function fitted() {
    return P.Projector.fit(s.track, s.w, s.h, PAD);
  }

  function projector() {
    var fit = fitted();
    s.pan = P.Projector.clampPan(s.pan, s.zoom, fit.bounds(s.track), centre());
    return fit.zoomed(s.zoom, s.pan, centre());
  }

  function reset() {
    s.zoom = 1;
    s.pan = [0, 0];
    s.follow = null;
    s.baseKey = '';
    drawControls();
    wake();
  }

  function size() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var w = root.clientWidth;
    var h = root.clientHeight;
    if (w === s.w && h === s.h && dpr === s.dpr) { return false; }
    s.w = w;
    s.h = h;
    s.dpr = dpr;
    [baseCanvas, carCanvas].forEach(function (c) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    });
    s.baseKey = '';
    if (s.track) { loadTiles(); }
    return true;
  }

  // ---------- The street map ----------

  function tileUrl(t) {
    return template.replace('{s}', 'abcd'.charAt(((t.x + t.y) % 4 + 4) % 4))
      .replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  }

  function want(list) {
    if (!template) { return; }
    list.forEach(function (t) {
      if (s.images.has(t.key)) { return; }
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        img.ready = true;
        s.baseKey = '';
        wake();
      };
      img.src = tileUrl(t);
      s.images.set(t.key, img);
    });
    // Only the tiles in use are kept.
    var keep = {};
    s.tiles.concat(s.detail).forEach(function (t) { keep[t.key] = true; });
    s.images.forEach(function (img, key) {
      if (!keep[key]) { s.images.delete(key); }
    });
  }

  function loadTiles() {
    if (!s.track || !s.w || !s.h) { return; }
    s.tiles = P.tilesFor(s.track, fitted(), s.w, s.h);
    s.detail = [];
    want(s.tiles);
  }

  /*
   * Zoomed in, the whole-circuit tiles would be stretched and soft: a sharper set for just
   * what's on screen goes over them, checked a couple of times a second as the view moves.
   */
  function loadDetail(now) {
    if (now - s.detailAt < 400) { return; }
    s.detailAt = now;
    var next = s.zoom > 1.05 ? P.tilesFor(s.track, projector(), s.w, s.h) : [];
    var key = next.map(function (t) { return t.key; }).join(',');
    if (key === s.detail.map(function (t) { return t.key; }).join(',')) { return; }
    s.detail = next;
    want(next);
  }

  /*
   * Each tile is laid onto the screen by where three of its corners fall: tiles are in Web
   * Mercator and the track in a flat local frame, which over a few kilometres differ by far
   * less than a pixel, so an affine fit per tile is exact enough.
   */
  function drawTiles(list, p) {
    var M = P.Mercator;
    var px = M.TILE_PX;
    list.forEach(function (t) {
      var img = s.images.get(t.key);
      if (!img || !img.ready) { return; }
      function corner(dx, dy) {
        var m = s.track.local(M.lon(t.x + dx, t.z), M.lat(t.y + dy, t.z));
        return p.project(m[0], m[1]);
      }
      var nw = corner(0, 0);
      var ne = corner(1, 0);
      var sw = corner(0, 1);
      var d = s.dpr;
      base.setTransform((ne[0] - nw[0]) / px * d, (ne[1] - nw[1]) / px * d, (sw[0] - nw[0]) / px * d, (sw[1] - nw[1]) / px * d, nw[0] * d, nw[1] * d);
      // A hair over a tile's own size, so no seam shows between neighbours.
      base.drawImage(img, -0.5, -0.5, px + 1, px + 1);
    });
    base.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  }

  // ---------- Underneath: map, track, sectors, labels ----------

  /*
   * The circuit as a smooth line: a curve through the middle of each segment, bent by the
   * point between, so a hairpin stays round when zoomed in instead of showing the outline's
   * 15 m steps.
   */
  function trackPath(ctx, p) {
    var t = s.track;
    var n = t.size;
    var pts = [];
    for (var i = 0; i < n; i++) { pts.push(p.project(t.xs[i], t.ys[i])); }
    function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    var start = mid(pts[n - 1], pts[0]);
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    for (var j = 0; j < n; j++) {
      var m = mid(pts[j], pts[(j + 1) % n]);
      ctx.quadraticCurveTo(pts[j][0], pts[j][1], m[0], m[1]);
    }
    ctx.closePath();
  }

  function drawFlagged(p, sectors, state) {
    var t = s.track;
    base.strokeStyle = flagColour(state);
    base.globalAlpha = 0.85;
    base.lineWidth = 7;
    base.lineCap = 'round';
    base.lineJoin = 'round';
    sectors.forEach(function (number) {
      var arc = t.sectorArc(number);
      if (!arc) { return; }
      var span = ((arc[1] - arc[0]) % t.size + t.size) % t.size;
      if (!span) { return; }
      base.beginPath();
      for (var k = 0; k <= span; k++) {
        var i = (arc[0] + k) % t.size;
        var q = p.project(t.xs[i], t.ys[i]);
        if (k === 0) { base.moveTo(q[0], q[1]); } else { base.lineTo(q[0], q[1]); }
      }
      base.stroke();
    });
    base.globalAlpha = 1;
  }

  function overlaps(a, b, margin) {
    return a[0] < b[2] + margin && a[2] > b[0] - margin && a[1] < b[3] + margin && a[3] > b[1] - margin;
  }

  /** The parts of the map other things sit over, where a label would be hidden. */
  function taken() {
    var out = [];
    var mapBox = root.getBoundingClientRect();
    [windEl, followBtn, wholeBtn, creditEl, noteEl].forEach(function (el) {
      if (el.hidden || !el.offsetWidth) { return; }
      var r = el.getBoundingClientRect();
      out.push([r.left - mapBox.left, r.top - mapBox.top, r.right - mapBox.left, r.bottom - mapBox.top]);
    });
    return out;
  }

  /*
   * The official turn numbers, each just off its corner. Each tries the ways off the track
   * worked out for it, best first, and takes the first where it overlaps nothing already
   * down and stays on the map. Named turns go down first so they always show; after that in
   * lap order, and a label with nowhere to go is left out, so a tight complex drops its later
   * or lettered corners rather than piling up.
   */
  function drawTurns(p, called) {
    var t = s.track;
    if (!t.turns.length) { return; }
    var gap = 12;
    var down = [];
    var blocked = taken();
    var order = t.turns.slice().sort(function (a, b) {
      return (called[a.label] ? 0 : 1) - (called[b.label] ? 0 : 1) || a.number - b.number || (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0);
    });
    base.textBaseline = 'middle';
    order.forEach(function (turn) {
      var hot = !!called[turn.label];
      base.font = hot ? '700 15px Figtree, sans-serif' : '600 13px Figtree, sans-serif';
      var w = base.measureText(turn.label).width;
      var h = hot ? 18 : 16;
      var x = t.xs[turn.index];
      var y = t.ys[turn.index];
      var anchor = p.project(x, y);
      var boxes = turn.ways.map(function (way) {
        var ahead = p.project(x + way[0], y + way[1]);
        var dx = ahead[0] - anchor[0];
        var dy = ahead[1] - anchor[1];
        var length = Math.hypot(dx, dy);
        if (length < 1e-6) { return null; }
        // Far enough out that the label's nearest edge, not its middle, is gap off the corner.
        var reach = gap + Math.abs(dx / length) * w / 2 + Math.abs(dy / length) * h / 2;
        var cx = anchor[0] + dx / length * reach;
        var cy = anchor[1] + dy / length * reach;
        return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
      }).filter(Boolean);
      var fits = boxes.filter(function (b) {
        return b[0] >= 0 && b[1] >= 0 && b[2] <= s.w && b[3] <= s.h &&
          !down.concat(blocked).some(function (o) { return overlaps(b, o, 2); });
      })[0];
      // A named turn is drawn even with nowhere clear to go, in its best place.
      var box = fits || (hot ? boxes[0] : null);
      if (!box) { return; }
      down.push(box);
      base.shadowColor = shade(colour('--ground'), 1);
      base.shadowBlur = 6;
      base.shadowOffsetY = 1;
      base.fillStyle = hot ? colour('--caution') : colour('--ink-soft');
      base.fillText(turn.label, box[0], (box[1] + box[3]) / 2);
    });
    base.shadowColor = 'transparent';
    base.shadowBlur = 0;
    base.shadowOffsetY = 0;
  }

  function drawBase(p, called) {
    var frame = s.frame;
    var flag = frame && frame.flag;
    var flagged = flag && flag.sectors.length ? flag.sectors : [];
    var key = [s.w, s.h, s.dpr, s.zoom, Math.round(s.pan[0] * 10), Math.round(s.pan[1] * 10), flagged.join(','),
      flag ? flag.state : '', Object.keys(called).join(','), s.images.size, followBtn.hidden, wholeBtn.hidden, windEl.hidden].join('|');
    if (key === s.baseKey) { return; }
    s.baseKey = key;
    base.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    base.clearRect(0, 0, s.w, s.h);
    base.globalAlpha = TILE_ALPHA;
    drawTiles(s.tiles, p);
    drawTiles(s.detail, p);
    base.globalAlpha = 1;
    trackPath(base, p);
    base.strokeStyle = colour('--ink');
    base.globalAlpha = 0.28;
    base.lineWidth = 3;
    base.lineJoin = 'round';
    base.stroke();
    base.globalAlpha = 1;
    if (flagged.length) { drawFlagged(p, flagged, flag.state); }
    if (s.track.startIndex != null) {
      var st = p.project(s.track.xs[s.track.startIndex], s.track.ys[s.track.startIndex]);
      base.fillStyle = colour('--alert');
      base.beginPath();
      base.arc(st[0], st[1], 5, 0, Math.PI * 2);
      base.fill();
    }
    drawTurns(p, called);
  }

  // ---------- On top: the cars ----------

  function drawCars(p, now) {
    cars.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    cars.clearRect(0, 0, s.w, s.h);
    var frame = s.frame;
    if (!frame || !s.motion) { return; }
    var positions = {};
    frame.drivers.forEach(function (d) { positions[d.num] = d.pos; });
    var placed = [];
    s.motion.cars.forEach(function (car, num) {
      var m = s.motion.position(car, now);
      placed.push({ num: num, car: car, at: p.project(m[0], m[1]) });
    });
    s.placed = placed;
    // Retired cars first, then from the back of the field forward, so the leader is on top
    // wherever cars overlap.
    placed.sort(function (a, b) {
      return (a.car.dnf ? 0 : 1) - (b.car.dnf ? 0 : 1) || (positions[b.num] || 99) - (positions[a.num] || 99);
    });
    cars.textAlign = 'center';
    cars.textBaseline = 'middle';
    cars.font = '700 13px Figtree, sans-serif';
    placed.forEach(function (c) {
      var fill = F.teamColour(c.car.colour) || colour('--ink-soft');
      var mine = s.followed.has(c.num);
      cars.globalAlpha = c.car.dnf ? 0.25 : 1;
      cars.fillStyle = fill;
      cars.beginPath();
      cars.arc(c.at[0], c.at[1], DOT, 0, Math.PI * 2);
      cars.fill();
      // A rim in the ground colour, so two cars overlapping still read as two; an ink one for
      // a driver you follow.
      cars.strokeStyle = mine ? colour('--ink') : colour('--ground');
      cars.lineWidth = mine ? 2.5 : 1.5;
      cars.stroke();
      var pos = positions[c.num];
      if (pos != null) {
        // Dark figures on the light team colours, light on the dark ones.
        cars.fillStyle = luminance(fill) > 0.45 ? colour('--ground') : colour('--ink');
        cars.fillText(String(pos), c.at[0], c.at[1] + 0.5);
      }
    });
    cars.globalAlpha = 1;
    // Name tags for the drivers you follow, on the side they were on last time unless that
    // side has run off the edge of the map.
    cars.textAlign = 'left';
    cars.font = '700 14px Figtree, sans-serif';
    placed.forEach(function (c) {
      if (!s.followed.has(c.num) || c.car.dnf || !c.car.code) { return; }
      var team = F.teamColour(c.car.colour) || colour('--ink-soft');
      var w = cars.measureText(c.car.code).width + 12;
      var h = 20;
      var left = !!s.tagLeft[c.num];
      if (!left && c.at[0] + DOT + 5 + w > s.w) { left = true; }
      if (left && c.at[0] - DOT - 5 - w < 0) { left = false; }
      s.tagLeft[c.num] = left;
      var x = left ? c.at[0] - DOT - 5 - w : c.at[0] + DOT + 5;
      cars.fillStyle = shade(team, 0.3);
      cars.beginPath();
      if (cars.roundRect) { cars.roundRect(x, c.at[1] - h / 2, w, h, 5); } else { cars.rect(x, c.at[1] - h / 2, w, h); }
      cars.fill();
      cars.fillStyle = team;
      cars.fillText(c.car.code, x + 6, c.at[1] + 0.5);
    });
  }

  // ---------- The loop ----------

  function easeFollow(now) {
    if (s.follow == null) {
      s.lastEase = now;
      return;
    }
    var car = s.motion && s.motion.cars.get(s.follow);
    if (!car || car.dnf) {
      s.lastEase = now;
      return;
    }
    var m = s.motion.position(car, now);
    var c = centre();
    var at = fitted().zoomed(s.zoom, [0, 0], c).project(m[0], m[1]);
    var wantPan = [c[0] - at[0], c[1] - at[1]];
    var dt = s.lastEase === 0 ? 1000 : Math.min(now - s.lastEase, 500);
    var k = 1 - Math.exp(-dt / FOLLOW_EASE_MS);
    s.pan = [s.pan[0] + (wantPan[0] - s.pan[0]) * k, s.pan[1] + (wantPan[1] - s.pan[1]) * k];
    s.lastEase = now;
  }

  function frame() {
    s.raf = 0;
    if (!s.shown || !s.track || document.visibilityState !== 'visible') { return; }
    size();
    var now = performance.now();
    easeFollow(now);
    var p = projector();
    if (s.zoom > 1.05 || s.detail.length) { loadDetail(now); }
    var called = s.frame ? P.Callouts.named(s.frame.events, s.frame.raceAt) : {};
    drawBase(p, called);
    drawCars(p, now);
    // Another frame only while something is moving: a car, or the view after one.
    if (s.follow != null || (s.motion && s.motion.moving(now))) { wake(); }
  }

  function wake() {
    if (!s.raf) { s.raf = requestAnimationFrame(frame); }
  }

  // ---------- Controls over the map ----------

  function compass(degrees) {
    return F.compass(degrees);
  }

  /*
   * The wind across the circuit as drawn: the map is turned to fit the view, so the arrow is
   * turned with it rather than pointing compass-up.
   */
  function drawWind() {
    var weather = s.frame && s.frame.weather;
    var on = !!(s.track && weather && weather.windDir != null && s.w);
    windEl.hidden = !on;
    if (!on) { return; }
    var p = fitted();
    var ll = s.track.lonLat(0, 0);
    var towards = (weather.windDir + 180) * Math.PI / 180;
    var dLat = 0.002 * Math.cos(towards);
    var dLon = 0.002 * Math.sin(towards) / Math.cos(ll[1] * Math.PI / 180);
    var a = s.track.local(ll[0], ll[1]);
    var b = s.track.local(ll[0] + dLon, ll[1] + dLat);
    var from = p.project(a[0], a[1]);
    var to = p.project(b[0], b[1]);
    var angle = Math.atan2(to[0] - from[0], from[1] - to[1]) * 180 / Math.PI;
    windArrow.style.transform = 'rotate(' + angle.toFixed(1) + 'deg)';
    UI.text('windSpeed', weather.wind != null ? weather.wind.toFixed(1) + ' m/s' : 'Wind');
    UI.text('windFrom', 'from ' + compass(weather.windDir));
  }

  /** Follow: each press moves on to the next driver you follow, in race order, then back out. */
  function followOrder() {
    var frame = s.frame;
    if (!frame) { return []; }
    return frame.drivers.filter(function (d) { return s.followed.has(d.num) && !d.dnf; })
      .sort(function (a, b) { return (a.pos || 99) - (b.pos || 99); })
      .map(function (d) { return d.num; });
  }

  function drawControls() {
    var order = followOrder();
    followBtn.hidden = !order.length;
    var driver = s.follow != null && s.frame ? s.frame.byNumber[s.follow] : null;
    var label = driver ? 'Following ' + F.driverLabel(driver) : 'Follow';
    if (followBtn.textContent !== label) { followBtn.textContent = label; }
    followBtn.setAttribute('aria-pressed', driver ? 'true' : 'false');
    var team = driver ? F.teamColour(driver.colour) : null;
    if (team) { followBtn.style.setProperty('--team', team); } else { followBtn.style.removeProperty('--team'); }
    wholeBtn.hidden = !(s.zoom > 1.05);
    creditEl.hidden = !template || !Array.from(s.images.values()).some(function (img) { return img.ready; });
    var reason = s.motion && s.frame ? s.motion.emptyReason(s.frame) : null;
    var hint = reason || (s.followed.size ? '' : 'Numbers are race positions · hold a driver in the tower to name them here');
    noteEl.hidden = !hint;
    // Marked when it's only the hint, not why the map is empty: a phone leaves the hint out.
    noteEl.toggleAttribute('data-hint', !reason);
    if (noteEl.textContent !== hint) { noteEl.textContent = hint; }
  }

  followBtn.addEventListener('click', function () {
    var order = followOrder();
    var next = s.follow == null ? order[0] : order[order.indexOf(s.follow) + 1];
    if (next == null) {
      reset();
      return;
    }
    s.follow = next;
    s.zoom = Math.max(s.zoom, FOLLOW_ZOOM);
    s.lastEase = 0;
    drawControls();
    wake();
  });

  wholeBtn.addEventListener('click', reset);

  // ---------- Pointer, wheel and keys ----------

  function local(e) {
    var r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Zoom by factor about the point at on screen, so what's under it stays there. */
  function zoomAbout(at, factor) {
    var k = s.zoom;
    var k2 = Math.min(MAX_ZOOM, Math.max(1, k * factor));
    var f = k2 / k;
    var c = centre();
    s.pan = [(at[0] - c[0]) * (1 - f) + s.pan[0] * f, (at[1] - c[1]) * (1 - f) + s.pan[1] * f];
    s.zoom = k2;
    if (k2 <= 1.001) { s.follow = null; }
    drawControls();
    wake();
  }

  root.addEventListener('wheel', function (e) {
    if (!s.track) { return; }
    e.preventDefault();
    zoomAbout(local(e), Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
  }, { passive: false });

  var pointers = new Map();
  var dragged = 0;
  var pinch = null;

  root.addEventListener('pointerdown', function (e) {
    if (e.target.closest('button') || !s.track) { return; }
    root.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    dragged = 0;
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinch = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    }
  });

  root.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) { return; }
    var at = local(e);
    var was = pointers.get(e.pointerId);
    pointers.set(e.pointerId, at);
    if (pointers.size === 2 && pinch) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      // A pinch zooms about the fingers, and doesn't let go of a followed car.
      zoomAbout([(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], d / pinch);
      pinch = d;
      return;
    }
    var dx = at[0] - was[0];
    var dy = at[1] - was[1];
    dragged += Math.abs(dx) + Math.abs(dy);
    if (s.zoom > 1.001 && dragged > 4) {
      // A drag lets go of a followed car.
      s.follow = null;
      s.pan = [s.pan[0] + dx, s.pan[1] + dy];
      drawControls();
      wake();
    }
  });

  function release(e) {
    if (!pointers.has(e.pointerId)) { return; }
    var at = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { pinch = null; }
    if (e.type === 'pointerup' && dragged <= 4 && pointers.size === 0) { tap(at); }
  }
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);

  /** A click near a car picks it. */
  function tap(at) {
    var hit = null;
    var best = 36;
    (s.placed || []).forEach(function (c) {
      var d = Math.hypot(c.at[0] - at[0], c.at[1] - at[1]);
      if (d < best) {
        best = d;
        hit = c.num;
      }
    });
    if (hit != null && handlers.onCar) { handlers.onCar(hit); }
  }

  /* Out to the whole circuit, or in on the spot clicked. */
  root.addEventListener('dblclick', function (e) {
    if (e.target.closest('button') || !s.track) { return; }
    if (s.zoom > 1.05) {
      reset();
      return;
    }
    var at = local(e);
    var c = centre();
    s.pan = [(at[0] - c[0]) * (1 - FOLLOW_ZOOM), (at[1] - c[1]) * (1 - FOLLOW_ZOOM)];
    s.zoom = FOLLOW_ZOOM;
    drawControls();
    wake();
  });

  root.addEventListener('keydown', function (e) {
    if (e.key === '+' || e.key === '=') { zoomAbout(centre(), 1.5); } else if (e.key === '-') { zoomAbout(centre(), 1 / 1.5); } else if (e.key === '0') { reset(); } else { return; }
    e.preventDefault();
  });

  // ---------- The circuit ----------

  function load(geoId) {
    s.geoId = geoId;
    s.track = null;
    s.motion = null;
    s.failed = null;
    s.images.clear();
    s.tiles = [];
    s.detail = [];
    s.tagLeft = {};
    reset();
    if (!geoId) { return; }
    P.Net.data(geoId + '.json', DATA_V).then(function (json) {
      if (s.geoId !== geoId) { return; }
      if (!json) {
        s.failed = 'Couldn’t load the track for this circuit.';
        notice();
        return;
      }
      try {
        s.track = new P.Track(geoId, json);
      } catch (e) {
        s.failed = 'Couldn’t read the track for this circuit.';
        notice();
        return;
      }
      // Made mid-stream, a motion glides at the stream's pace from its first fix.
      s.motion = new P.MapMotion(s.track, s.streamRate ? 1000 / s.streamRate : null);
      size();
      loadTiles();
      update();
    });
  }

  var noticeEl = root.querySelector('.map-notice');
  function notice(text) {
    var msg = text || s.failed || '';
    noticeEl.hidden = !msg;
    if (noticeEl.textContent !== msg) { noticeEl.textContent = msg; }
  }

  function update() {
    if (!s.track || !s.frame) {
      drawControls();
      return;
    }
    var streamed = s.streamed && s.streamed.fresh ? s.streamed : null;
    s.motion.update(s.frame, performance.now(), !UI.calm, streamed ? streamed.positions : null, streamed ? streamed.at : null);
    drawWind();
    drawControls();
    wake();
  }

  /*
   * Draw a frame. ctx: {geoId, circuit (for the notice), followed: Set, shown: whether the
   * map view is up, streamed: the live stream's cars ({at, positions, fresh}) or null,
   * streamRate: car updates a second, for a motion made mid-stream}.
   */
  function render(frame, ctx) {
    s.frame = frame;
    s.followed = ctx.followed;
    s.shown = ctx.shown;
    s.streamed = ctx.streamed;
    s.streamRate = ctx.streamRate;
    if (!frame) {
      notice('The track shows here once a session is on.');
    } else if (!ctx.geoId) {
      notice('No track outline for ' + (ctx.circuit || 'this circuit') + '.');
    } else {
      notice();
    }
    if ((ctx.geoId || null) !== s.geoId) { load(ctx.geoId || null); }
    if (s.follow != null && !s.followed.has(s.follow)) { s.follow = null; }
    update();
  }

  /** The stream's cars, several times a second: they move the map alone. */
  function stream(streamed) {
    s.streamed = streamed;
    if (s.shown && s.frame) { update(); }
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () {
      if (size()) {
        drawWind();
        wake();
      }
    }).observe(root);
  }

  document.addEventListener('visibilitychange', wake);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      s.baseKey = '';
      wake();
    });
  }

  P.Map = {
    render: render,
    stream: stream,
    on: function (h) { handlers = h; }
  };
}());
