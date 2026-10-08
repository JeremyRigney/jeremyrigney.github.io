/*
 * /f1 — the live track map.
 *
 * A flat top-down outline of the circuit with a dot per car. Deliberately not the tilted,
 * elevation-lifted scene at the top of the page: that one is driven by scroll position, and
 * a map you can only read at certain scroll offsets is not a map.
 *
 * How the cars get onto the track
 * -------------------------------
 * OpenF1's `location` stream reports cars in Formula 1's own coordinate frame, in
 * decimetres. That is the same frame MultiViewer publishes its circuit outlines in, which
 * tools/build-f1-data.py already fits to our own lon/lat path in order to place the official
 * corner numbers. So the fit is already solved: the build now writes the six coefficients of
 * that fit into each circuit as `locationTransform`, and this file just applies them.
 *
 *   X = a*x + b*y + c        metres, relative to the path centroid
 *   Y = d*x + e*y + f
 *
 * Verified on Zandvoort: transformed telemetry sits a median 6.9 m from the centreline,
 * which is a racing line, not an error. A circuit whose corner fit was rejected has no
 * transform at all, and then the map draws the track with no cars rather than cars in the
 * wrong place.
 *
 * Motion
 * ------
 * Positions arrive every few seconds, but a car covers a few hundred metres in that time, so
 * interpolating between two samples in a straight line would cut visibly across the corners.
 * Each car is therefore projected onto the nearest point of the track and animated *along*
 * the path instead, which keeps it on the circuit between updates. Cars a long way off the
 * path — in the pit lane — skip that and are drawn where they actually are.
 */

(function () {
  'use strict';

  var M_PER_DEG_LAT = 110540;
  var M_PER_DEG_LON = 111320;

  /*
   * Cache-buster for the circuit JSON. Pages serves assets/data with max-age=600 and no
   * version in the URL, so without this a browser can pair a fresh script with a stale
   * data file for ten minutes after a deploy. Keep in step with f1-lab.js.
   */
  var DATA_V = '20261004';

  /* Beyond this from the centreline a car is not on the racing surface — pit lane. */
  var OFF_TRACK_M = 45;

  /*
   * How a car travels between the positions it actually reports.
   *
   * Position updates arrive every few seconds — three or so live, less under playback — and
   * the trick is to spend the *whole* interval covering the ground, so a car looks like it
   * is driving rather than teleporting. An earlier version capped the travel at 900ms, so
   * with a 3s poll a car darted for 900ms and then sat perfectly still for 2.1s, which is
   * exactly what reads as jumping.
   *
   * The duration is therefore the measured gap between updates, stretched slightly: a car
   * should still be moving when the next position lands, so the new target redirects a
   * moving car instead of restarting a stopped one. Motion is linear along the track, not
   * eased, because a racing car does not accelerate away from every sample and decelerate
   * into the next.
   */
  var TRAVEL_MIN = 200;
  var TRAVEL_MAX = 6000;
  var TRAVEL_STRETCH = 1.25;

  /* A jump bigger than this fraction of a lap is a scrub, not driving — snap instead. */
  var SNAP_FRACTION = 0.25;

  /*
   * A leap in *race* time this large was not driven, it was scrubbed.
   *
   * Judging this on wall-clock silence between frames, as an earlier version did, cannot
   * tell a person moving the playhead from a page that simply polls slowly — and once the
   * live poll went to 1.5s every ordinary update looked like a scrub, so the cars snapped
   * instead of moving. The clock the frame *represents* is the honest signal: live frames
   * advance a second or two at a time, playback advances by the speed multiplier, and only
   * a hand on the scrubber jumps minutes or runs backwards.
   */
  var SCRUB_JUMP_MS = 20000;

  var gapMs = 3000;        // observed interval between position updates
  var lastRender = 0;
  var flagged = [];        // marshalling sectors currently under a flag
  var lastData = null;     // the most recent frame, replayed if geometry arrives after it
  var lastRaceAt = NaN;    // the race instant the last frame represented
  var lastPositions = '';  // xy signature, to spot the frames that carry new fixes
  var lastFreshAt = 0;     // when positions last actually changed
  var emptyReason = '';    // why the track has no cars on it, when it has none

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * Why a data fetch failed, in terms that point at the fix.
   *
   * Opening the page straight off disk is the overwhelmingly likely cause: a browser gives
   * a file:// page a null origin and refuses to let it read neighbouring files, so the
   * circuit JSON cannot load while the timing API — which sends CORS headers — works fine.
   * The result is a page that looks like it is working with the map mysteriously absent,
   * and it is worth naming rather than leaving anyone to guess.
   */
  window.f1MapHint = function (what) {
    if (window.location.protocol === 'file:') {
      return 'Serve this page over http:// — a page opened from a file cannot read ' + what;
    }
    return 'Could not load ' + what;
  };

  var canvas = null;
  var ctx = null;
  var circuit = null;      // the loaded circuit JSON
  var local = null;        // path in metres about the centroid, laid on its long axis
  var spin = 0;            // the rotation applied to get there
  var bounds = null;
  var loading = null;      // geoId currently being fetched, to avoid duplicate loads
  var notice = '';         // shown instead of a map when there is no geometry to draw
  var cars = {};           // driver number -> render state
  var running = false;

  function transformOf() {
    return circuit && circuit.locationTransform;
  }

  /*
   * Above this turn angle at one vertex, the geometry is not a corner.
   *
   * The shipped path is resampled to an even 15 m, so the turn at a vertex implies a corner
   * radius: 120 degrees means 7 m, tighter than anything in Formula 1 — Monaco's hairpin,
   * the sharpest corner on the calendar, turns 77. Anything past this is spline overshoot in
   * the source geometry, where the curve loops back on itself and the resampler walks out
   * and straight back in. There are 47 such vertices across 14 circuits, and they draw as
   * needles: Silverstone has three, which is the doubling-back visible on its map.
   *
   * This mirrors despike() and smoothPath() in assets/js/f1-circuit.js, which do the same
   * job for the scroll story's canvas. They are repeated here rather than shared because
   * the lab does not load f1-circuit.js — that file boots an entire 3D scene, a preload
   * sequence and a scroll library, none of which belong on a replay harness.
   */
  var MAX_TURN_COS = Math.cos(120 * Math.PI / 180);
  var DESPIKE_PASSES = 12;
  var SMOOTH_WEIGHT = 0.18;
  var MAX_SMOOTH_SHIFT = 1.5;

  /* Pull any vertex that doubles back onto the line between its neighbours. */
  function despike(pts) {
    var count = pts.length;
    for (var pass = 0; pass < DESPIKE_PASSES; pass += 1) {
      var next = [];
      var moved = 0;
      for (var i = 0; i < count; i += 1) {
        var a = pts[(i - 1 + count) % count];
        var b = pts[i];
        var c = pts[(i + 1) % count];
        next[i] = b;

        var ax = b[0] - a[0];
        var ay = b[1] - a[1];
        var bx = c[0] - b[0];
        var by = c[1] - b[1];
        var la = Math.sqrt(ax * ax + ay * ay);
        var lb = Math.sqrt(bx * bx + by * by);
        if (la < 1e-6 || lb < 1e-6) {
          continue;
        }
        // cos of the turn: 1 is dead straight, -1 is a full reversal.
        if ((ax * bx + ay * by) / (la * lb) < MAX_TURN_COS) {
          next[i] = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
          moved += 1;
        }
      }
      // Applied as a whole, so a pass cannot depend on the order it walked the lap.
      pts = next;
      if (!moved) {
        break;
      }
    }
    return pts;
  }

  /* A light pull toward the local average, capped so it cannot round off real corners. */
  function smoothPath(pts) {
    var count = pts.length;
    var out = [];
    for (var i = 0; i < count; i += 1) {
      var a = pts[(i - 1 + count) % count];
      var b = pts[i];
      var c = pts[(i + 1) % count];
      var dx = SMOOTH_WEIGHT * ((a[0] + c[0]) / 2 - b[0]);
      var dy = SMOOTH_WEIGHT * ((a[1] + c[1]) / 2 - b[1]);
      var shift = Math.sqrt(dx * dx + dy * dy);
      if (shift > MAX_SMOOTH_SHIFT) {
        dx = dx / shift * MAX_SMOOTH_SHIFT;
        dy = dy / shift * MAX_SMOOTH_SHIFT;
      }
      out[i] = [b[0] + dx, b[1] + dy];
    }
    return out;
  }

  /*
   * The circuit path in the same frame the transform outputs: equirectangular metres about
   * lat0, recentred on the centroid. This mirrors local_metres() plus the centring in
   * tools/build-f1-data.py — the two have to agree or the cars land beside the track.
   */
  function toLocal(path) {
    var lat0 = 0;
    var i;
    for (i = 0; i < path.length; i += 1) {
      lat0 += path[i][1];
    }
    lat0 /= path.length;

    var scale = M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);
    var pts = [];
    var cx = 0;
    var cy = 0;
    for (i = 0; i < path.length; i += 1) {
      var x = path[i][0] * scale;
      var y = path[i][1] * M_PER_DEG_LAT;
      pts.push([x, y]);
      cx += x;
      cy += y;
    }
    cx /= pts.length;
    cy /= pts.length;
    for (i = 0; i < pts.length; i += 1) {
      pts[i][0] -= cx;
      pts[i][1] -= cy;
    }

    /*
     * Clean the shape only after centring on the raw points. The centroid is what
     * locationTransform was fitted against, so it has to stay exactly where
     * tools/build-f1-data.py put it — moving it would slide every car off the track. What
     * follows changes the outline, not the frame it sits in.
     */
    return smoothPath(despike(pts));
  }

  /*
   * The angle that lays a circuit's long axis across the screen.
   *
   * The map is a wide, short strip, and a circuit left in its true compass orientation is
   * fitted to whichever dimension runs out first — which for a north-south circuit like
   * Monza means a tiny drawing marooned in the middle of a wide canvas. Rotating onto the
   * principal axis is the same trick silhouette_for() uses in tools/build-f1-data.py, and it
   * costs nothing here because the cars are carried through the same rotation.
   */
  function principalAngle(pts) {
    var sxx = 0, syy = 0, sxy = 0;
    for (var i = 0; i < pts.length; i += 1) {
      sxx += pts[i][0] * pts[i][0];
      syy += pts[i][1] * pts[i][1];
      sxy += pts[i][0] * pts[i][1];
    }
    return 0.5 * Math.atan2(2 * sxy, sxx - syy);
  }

  function rotate(pts, theta) {
    var cos = Math.cos(theta);
    var sin = Math.sin(theta);
    return pts.map(function (p) {
      return [p[0] * cos + p[1] * sin, -p[0] * sin + p[1] * cos];
    });
  }

  function measure(pts) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i += 1) {
      minX = Math.min(minX, pts[i][0]);
      maxX = Math.max(maxX, pts[i][0]);
      minY = Math.min(minY, pts[i][1]);
      maxY = Math.max(maxY, pts[i][1]);
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  /* Metres about the centroid -> device pixels, fitted to the canvas with a margin. */
  function projector() {
    var pad = 26;
    var w = canvas.width;
    var h = canvas.height;
    var spanX = bounds.maxX - bounds.minX;
    var spanY = bounds.maxY - bounds.minY;
    var scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    var offX = (w - spanX * scale) / 2 - bounds.minX * scale;
    var offY = (h - spanY * scale) / 2 + bounds.maxY * scale;
    return function (x, y) {
      // Screen y grows downward; the world's does not.
      return [x * scale + offX, offY - y * scale];
    };
  }

  /* F1-frame decimetres -> the same rotated local metres the path is drawn in. */
  function apply(t, x, y) {
    var px = t.a * x + t.b * y + t.c;
    var py = t.d * x + t.e * y + t.f;
    var cos = Math.cos(spin);
    var sin = Math.sin(spin);
    return [px * cos + py * sin, -px * sin + py * cos];
  }

  /*
   * Nearest path index to a point, with its distance.
   *
   * `near` restricts the search to a window around where the car was last seen. Circuits
   * run close to themselves — Zandvoort's banking, Monza's parallel straights — and a
   * global search will happily snap a car onto the other side of the track, which shows up
   * as a dot flicking back and forth across the infield. Searching near the last known
   * position keeps a car on the piece of track it is actually on; the global search is the
   * fallback for a car that has genuinely jumped, such as one coming out of the pits.
   */
  function nearest(x, y, near) {
    var best = 0;
    var bestD = Infinity;
    var count = local.length;
    var i, idx, dx, dy, d;

    if (near !== null && near !== undefined) {
      var span = Math.max(6, Math.round(count * 0.08));
      for (i = -span; i <= span; i += 1) {
        idx = ((Math.round(near) + i) % count + count) % count;
        dx = x - local[idx][0];
        dy = y - local[idx][1];
        d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = idx;
        }
      }
      // Close enough to be the same stretch of track: trust it.
      if (Math.sqrt(bestD) <= OFF_TRACK_M) {
        return { index: best, distance: Math.sqrt(bestD) };
      }
      bestD = Infinity;
    }

    for (i = 0; i < count; i += 1) {
      dx = x - local[i][0];
      dy = y - local[i][1];
      d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { index: best, distance: Math.sqrt(bestD) };
  }

  /* Shortest signed step from a to b around a ring of n. */
  function ringDelta(a, b, n) {
    var d = (b - a) % n;
    if (d > n / 2) {
      d -= n;
    }
    if (d < -n / 2) {
      d += n;
    }
    return d;
  }

  function drawNotice() {
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var styles = getComputedStyle(document.documentElement);
    ctx.fillStyle = (styles.getPropertyValue('--ink-faint') || '#6b7178').trim();
    ctx.font = Math.max(11, Math.round(canvas.width / 110)) + 'px "Chivo Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(notice, canvas.width / 2, canvas.height / 2);
    ctx.textAlign = 'start';
  }

  /*
   * The stretch of track one marshalling sector covers, as a pair of path indices.
   *
   * The build stores where each sector *begins*, in metres round the lap; a sector runs
   * from its own start to the next number's, and the highest wraps back to the first. The
   * numbers are not necessarily contiguous or 1-based in the file, so the successor is
   * found by position in the sorted list rather than by adding one.
   */
  function sectorArc(number) {
    var sectors = circuit && circuit.marshalSectors;
    if (!sectors || sectors.length < 2 || !local) {
      return null;
    }
    var step = circuit.step || 15;
    var count = local.length;
    var at = -1;
    for (var i = 0; i < sectors.length; i += 1) {
      if (sectors[i].n === number) {
        at = i;
        break;
      }
    }
    if (at < 0) {
      return null;
    }
    var next = sectors[(at + 1) % sectors.length];
    return {
      from: Math.round(sectors[at].s / step) % count,
      to: Math.round(next.s / step) % count
    };
  }

  function drawFlaggedSectors(project, styles) {
    if (!flagged.length || !circuit || !circuit.marshalSectors) {
      return;
    }
    var colour = (styles.getPropertyValue('--flag') || '').trim();
    if (!colour || colour === 'transparent') {
      return;
    }

    var count = local.length;
    // Wider than the track line and drawn under the cars, so it reads as the piece of
    // circuit that is under a flag rather than as a second track.
    ctx.lineWidth = Math.max(5, canvas.width / 130);
    ctx.lineCap = 'round';
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.85;

    flagged.forEach(function (number) {
      var arc = sectorArc(number);
      if (!arc) {
        return;
      }
      // Walk forward from the start index to the end, the long way round if the sector
      // straddles the timing line — which the first one usually does.
      var span = ((arc.to - arc.from) % count + count) % count;
      if (!span) {
        return;
      }
      ctx.beginPath();
      for (var k = 0; k <= span; k += 1) {
        var p = project(local[(arc.from + k) % count][0], local[(arc.from + k) % count][1]);
        if (k === 0) {
          ctx.moveTo(p[0], p[1]);
        } else {
          ctx.lineTo(p[0], p[1]);
        }
      }
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  /*
   * A footnote under a track that has drawn correctly but has nothing on it.
   *
   * Distinct from `notice`, which replaces the map entirely because there is no geometry to
   * show. Here the circuit is real and worth looking at — the flagged sectors still mean
   * something — and only the cars are missing, so the map stays and the reason sits under
   * it. Without this an empty track is indistinguishable from a broken page, which is the
   * same complaint drawNotice() above was written to answer.
   */
  function drawFootnote(text) {
    var styles = getComputedStyle(document.documentElement);
    ctx.fillStyle = (styles.getPropertyValue('--ink-faint') || '#6b7178').trim();
    ctx.font = Math.max(11, Math.round(canvas.width / 130)) + 'px "Chivo Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, canvas.width / 2, canvas.height - Math.max(10, canvas.width / 90));
    ctx.textAlign = 'start';
  }

  function draw() {
    if (!ctx) {
      return;
    }
    if (notice) {
      drawNotice();
      return;
    }
    if (!local) {
      return;
    }
    var project = projector();
    var now = Date.now();
    var i;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    /*
     * Every colour from the stylesheet, read on each draw.
     *
     * One getComputedStyle for all five, rather than one per use: this runs on every
     * frame a car is moving. The fallbacks are f1.css's own values, so a stylesheet
     * that has not arrived leaves the map looking exactly as it always did.
     */
    var styles = getComputedStyle(document.documentElement);
    var line = (styles.getPropertyValue('--line-strong') || 'rgba(236,238,240,0.28)').trim();
    var accent = (styles.getPropertyValue('--accent') || '#e8112d').trim();
    var ink = (styles.getPropertyValue('--ink-faint') || '#6b7178').trim();
    var quiet = (styles.getPropertyValue('--ink-soft') || '#9aa0a6').trim();
    var ground = (styles.getPropertyValue('--coal') || '#111214').trim();
    var strong = (styles.getPropertyValue('--ink') || '#eceef0').trim();

    // The track.
    ctx.beginPath();
    for (i = 0; i < local.length; i += 1) {
      var p = project(local[i][0], local[i][1]);
      if (i === 0) {
        ctx.moveTo(p[0], p[1]);
      } else {
        ctx.lineTo(p[0], p[1]);
      }
    }
    ctx.closePath();
    ctx.strokeStyle = line;
    ctx.lineWidth = Math.max(2, canvas.width / 320);
    ctx.lineJoin = 'round';
    ctx.stroke();

    // The sectors race control has flagged, drawn over the track before anything else so
    // the start/finish dot and the cars still sit on top of it.
    drawFlaggedSectors(project, styles);

    // The start/finish line, from the marker the build placed by arc length.
    var markers = (circuit.markers || []).filter(function (m) {
      return m.type === 'start-finish';
    });
    if (markers.length) {
      var idx = Math.round(markers[0].s / (circuit.step || 15)) % local.length;
      var sf = project(local[idx][0], local[idx][1]);
      ctx.beginPath();
      ctx.arc(sf[0], sf[1], Math.max(3, canvas.width / 300), 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    /*
     * The cars.
     *
     * The sizes below are proportional to canvas width and tuned for the strip on /f1 and
     * the lab. A wall-sized panel therefore keeps the dot and the label at the same
     * fraction of a much larger map, which leaves a driver code too small to read across a
     * room, so the full-panel map scales them up.
     *
     * Keyed on data-fill rather than on a width threshold, and that is deliberate: these
     * are device pixels, so any width test would also fire on the 1180px strip the moment
     * it was drawn on a retina screen — silently restyling /f1 and the lab, which this
     * change must not touch. The attribute is set by exactly one page.
     */
    var big = canvas.hasAttribute('data-fill') ? 1.5 : 1;
    var radius = Math.max(4, canvas.width / 190) * big;
    ctx.font = '600 ' + Math.max(9, Math.round(canvas.width / 105 * big)) + 'px "Chivo Mono", monospace';
    ctx.textBaseline = 'middle';

    Object.keys(cars).forEach(function (num) {
      var car = cars[num];
      if (car.x === null || car.x === undefined) {
        return;
      }

      var here;
      if (car.offTrack) {
        here = [car.x, car.y];
      } else {
        // Travel along the path rather than across the infield, at a constant rate over
        // the whole interval between updates.
        var t = reducedMotion ? 1 :
          Math.min(1, (now - car.since) / (car.travel || TRAVEL_MIN));
        var at = car.from + ringDelta(car.from, car.to, local.length) * t;
        var i0 = ((Math.floor(at) % local.length) + local.length) % local.length;
        var i1 = (i0 + 1) % local.length;
        var f = at - Math.floor(at);
        here = [
          local[i0][0] + (local[i1][0] - local[i0][0]) * f,
          local[i0][1] + (local[i1][1] - local[i0][1]) * f
        ];
      }

      var pt = project(here[0], here[1]);

      ctx.beginPath();
      ctx.arc(pt[0], pt[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = car.colour || quiet;
      ctx.globalAlpha = car.dnf ? 0.25 : 1;
      ctx.fill();
      // A rim in the page's own ground, so two cars overlapping still read as two.
      // The ground rather than a dark literal: this map is also drawn on the printed
      // edition, where the page behind it is ivory and a charcoal rim reads as a blob.
      ctx.lineWidth = Math.max(1, radius / 4);
      ctx.strokeStyle = ground;
      ctx.stroke();

      if (car.code) {
        ctx.fillStyle = car.dnf ? ink : strong;
        ctx.fillText(car.code, pt[0] + radius + 3, pt[1]);
      }
      ctx.globalAlpha = 1;
    });

    if (emptyReason) {
      drawFootnote(emptyReason);
    }
  }

  function loop() {
    draw();
    var now = Date.now();
    var moving = Object.keys(cars).some(function (num) {
      return !cars[num].offTrack && (now - cars[num].since) < (cars[num].travel || 0);
    });
    if (moving && !reducedMotion) {
      window.requestAnimationFrame(loop);
    } else {
      running = false;
    }
  }

  function wake() {
    if (!running) {
      running = true;
      window.requestAnimationFrame(loop);
    }
  }

  /*
   * Height follows the circuit's own proportions rather than a fixed strip.
   *
   * Laid on its long axis a circuit can be anything from Monza's 3:1 to Zandvoort's 3:2, and
   * one fixed height either wastes most of the width on the squarer ones or crops the long
   * ones. Deriving it from the aspect ratio means every circuit is drawn as large as the
   * column allows, between sensible bounds.
   */
  function preferredHeight(width) {
    if (!bounds) {
      return null;
    }
    var aspect = (bounds.maxX - bounds.minX) / Math.max(1, bounds.maxY - bounds.minY);
    return Math.round(Math.max(170, Math.min(400, width / aspect + 40)));
  }

  function resize() {
    if (!canvas) {
      return;
    }
    var rect = canvas.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

    /*
     * data-fill hands the height back to CSS. On /f1 and the lab the map is a strip in a
     * document and sizes itself from the circuit's proportions; on the wall it is a cell in
     * a viewport grid that has already decided how tall it is, and a canvas that re-asserts
     * its own height there either overflows the cell or fights it every resize.
     */
    if (!canvas.hasAttribute('data-fill')) {
      var wanted = preferredHeight(rect.width);
      if (wanted) {
        canvas.style.height = wanted + 'px';
        rect = canvas.getBoundingClientRect();
      }
    }

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    draw();
  }

  function ready() {
    if (canvas) {
      return true;
    }
    canvas = document.getElementById('live-map');
    if (!canvas) {
      return false;
    }
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', resize);
    return true;
  }

  window.f1Map = {
    /*
     * Point the map at a circuit. Safe to call repeatedly with the same id — the lab does,
     * every time the scrubber moves.
     */
    use: function (geoId) {
      if (!geoId || loading === geoId || (circuit && circuit.id === geoId)) {
        return;
      }
      loading = geoId;
      notice = '';
      fetch('assets/data/f1/' + geoId + '.json?v=' + DATA_V)
        .then(function (r) {
          if (!r.ok) {
            throw new Error('HTTP ' + r.status);
          }
          return r.json();
        })
        .then(function (data) {
          circuit = data;
          circuit.id = geoId;
          var flat = toLocal(data.path);
          spin = principalAngle(flat);
          local = rotate(flat, spin);
          bounds = measure(local);
          cars = {};
          if (ready()) {
            resize();
          }
          // Any frame that arrived while this was in flight was held rather than dropped;
          // draw it now that there is a track to draw it on.
          if (lastData) {
            window.f1Map.render(lastData);
          }
        })
        .catch(function (error) {
          /*
           * Say what went wrong rather than leaving an empty rectangle. An earlier version
           * returned quietly here, so a failed circuit fetch was indistinguishable from a
           * map that had simply not been asked for — which cost real time to track down.
           */
          loading = null;
          circuit = null;
          local = null;
          notice = window.f1MapHint
            ? window.f1MapHint('the track for ' + geoId)
            : 'Could not load the track for ' + geoId + ' (' + error.message + ')';
          if (ready()) {
            resize();
          }
        });
    },

    render: function (data) {
      /*
       * Kept even when this frame cannot be drawn yet.
       *
       * The circuit JSON is fetched asynchronously, and on a cold load the first composed
       * frame routinely arrives before it lands — at which point this used to return and
       * the frame was gone for good. On /f1 the next poll covered it three seconds later,
       * but the lab and the wall only request a frame when the playhead moves, so a page
       * opened at a fixed instant drew the track with no cars and no flagged sector at all
       * until something was scrubbed. The load path replays this once geometry is ready.
       */
      lastData = data;

      if (!ready() || !circuit || !local) {
        return;
      }
      if (!canvas.width) {
        resize();
      }

      var t = transformOf();
      var now = Date.now();

      /*
       * Which sectors are under a flag. The payload has carried these all along and the
       * panel prints them as "Sectors 14, 15"; this is the same list, shown as the piece
       * of track it actually refers to.
       *
       * Held rather than passed into draw() because draw() also runs from the animation
       * loop and on resize, where there is no payload to hand.
       */
      flagged = (data.flag && data.flag.sectors) || [];

      /*
       * Was the playhead moved by hand? Judged on the clock the frame represents, not on
       * how long it has been since the last one — see SCRUB_JUMP_MS.
       */
      var stamp = (data.replay && data.replay.at) || data.generated;
      var raceAt = stamp ? Date.parse(stamp) : NaN;
      var scrubbed = !lastRender;
      if (!scrubbed && !isNaN(raceAt) && !isNaN(lastRaceAt)) {
        var jump = raceAt - lastRaceAt;
        scrubbed = jump < 0 || jump > SCRUB_JUMP_MS;
      }
      lastRender = now;
      lastRaceAt = raceAt;

      /*
       * How long a car has to cover the ground, measured between the frames that actually
       * carry new coordinates rather than between renders.
       *
       * These are not the same thing and the difference is the whole problem. The page
       * polls every 1.5s but `location` only refreshes upstream every 4 — so most frames
       * repeat the previous positions, and timing the glide off the poll rate sent cars
       * darting for under two seconds and then sitting still for the rest of the interval.
       * Timing it off the updates themselves means a car is still moving when its next
       * position lands, which is what makes it read as driving.
       */
      var signature = (data.drivers || []).map(function (d) {
        return d.xy ? d.xy[0] + ',' + d.xy[1] : '';
      }).join('|');
      var fresh = signature !== lastPositions;

      if (fresh) {
        if (lastFreshAt && !scrubbed) {
          var seen = Math.max(TRAVEL_MIN, Math.min(TRAVEL_MAX, now - lastFreshAt));
          gapMs = gapMs * 0.6 + seen * 0.4;
        }
        lastFreshAt = now;
        lastPositions = signature;
      }

      var travel = scrubbed
        ? TRAVEL_MIN
        : Math.max(TRAVEL_MIN, Math.min(TRAVEL_MAX, gapMs * TRAVEL_STRETCH));

      (data.drivers || []).forEach(function (driver) {
        // No transform for this circuit, or no fix for this car: nothing to place.
        if (!t || !driver.xy || driver.xy[0] === null) {
          return;
        }
        var world = apply(t, driver.xy[0], driver.xy[1]);
        var known = cars[driver.num];
        var snap = nearest(world[0], world[1], known ? known.to : null);
        var car = known;
        if (!car) {
          car = cars[driver.num] = { from: snap.index, to: snap.index, since: 0 };
        }

        car.colour = window.f1Live ? window.f1Live.teamColour(driver.colour) : null;
        car.code = driver.code;
        car.dnf = !!driver.dnf;
        car.x = world[0];
        car.y = world[1];
        car.offTrack = snap.distance > OFF_TRACK_M;

        if (!car.offTrack && snap.index !== car.to) {
          // Pick up from wherever the car has actually got to, so a new position redirects
          // a moving car rather than restarting it from behind.
          var progress = Math.min(1, (now - car.since) / (car.travel || TRAVEL_MIN));
          var at = car.since
            ? car.from + ringDelta(car.from, car.to, local.length) * progress
            : snap.index;

          // A scrub moves the playhead by minutes; driving it is not. Crossing a quarter of
          // the lap in one update means the clock jumped, so put the car where it belongs
          // instead of sending it on a long glide to catch up.
          //
          // Distance alone does not catch all of them: a scrub of a few seconds, or one
          // that happens to land a car a short way round, looks exactly like driving. The
          // clock the frame represents is the other half of the signal — see SCRUB_JUMP_MS.
          var leap = Math.abs(ringDelta(at, snap.index, local.length)) / local.length;
          car.from = (scrubbed || leap > SNAP_FRACTION) ? snap.index : at;
          car.to = snap.index;
          car.since = now;
          car.travel = travel;
        }
      });

      /*
       * Why the track is empty, when it is.
       *
       * Tested on `cars` rather than on this frame's coordinates, so a single frame that
       * happens to carry none — which the replay does whenever a location block fails to
       * load — does not flash a message over a map that was working a moment ago. Once any
       * car has been placed this stays quiet for the rest of the session.
       *
       * Both cases are real and neither is a bug here: OpenF1 published no `location` for
       * some past races at all (Monaco, Sakhir and Jeddah in 2026 have none from lights out
       * to flag), and a circuit whose MultiViewer fit was rejected has no transform to
       * place cars with.
       */
      if (Object.keys(cars).length) {
        emptyReason = '';
      } else if (!t) {
        emptyReason = 'No map fit for this circuit — the track is drawn, the cars cannot be';
      } else if ((data.drivers || []).length) {
        emptyReason = 'No car positions in this session’s timing feed';
      }

      wake();
      draw();
    },

    /*
     * No geometry for this circuit. Only the current calendar ships circuit files, so a
     * venue that has dropped off it — Imola, Jeddah, Sakhir — cannot be drawn. Saying so is
     * better than an empty rectangle that looks like a bug.
     */
    unavailable: function (name, reason) {
      circuit = null;
      local = null;
      cars = {};
      loading = null;
      notice = reason || ('No track geometry for ' + name);
      if (ready()) {
        if (!canvas.width) {
          resize();
        }
        draw();
      }
    },

    /* The lab clears the map when the session changes. */
    reset: function () {
      cars = {};
      // A flag and a held frame both belong to the session that was on screen, not to the
      // next one — replaying the old one onto a new circuit would put its cars on the
      // wrong track.
      flagged = [];
      lastData = null;
      emptyReason = '';
      lastRaceAt = NaN;
      lastPositions = '';
      lastFreshAt = 0;
      draw();
    },

    /*
     * Redraw in whatever colours the page is in now.
     *
     * Every colour this file paints is read out of the stylesheet on each draw, so
     * nothing here has to be told what changed — but loop() parks itself whenever no
     * car is moving, and a static map, or the "no geometry" notice, would otherwise
     * keep the old palette's pixels indefinitely. The printed edition has a palette
     * switch; this is how it asks. A no-op with nothing to draw.
     */
    repaint: function () {
      if (ready()) {
        draw();
      }
    }
  };
}());
