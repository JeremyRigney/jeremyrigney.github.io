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

  /* Beyond this from the centreline a car is not on the racing surface — pit lane. */
  var OFF_TRACK_M = 45;

  /* How long a car takes to slide to a newly reported position. */
  var EASE_MS = 900;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    return pts;
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

  /* Nearest path index to a point, with its distance. Linear over ~300 points; trivial. */
  function nearest(x, y) {
    var best = 0;
    var bestD = Infinity;
    for (var i = 0; i < local.length; i += 1) {
      var dx = x - local[i][0];
      var dy = y - local[i][1];
      var d = dx * dx + dy * dy;
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

    var styles = getComputedStyle(document.documentElement);
    var line = (styles.getPropertyValue('--line-strong') || 'rgba(236,238,240,0.28)').trim();
    var accent = (styles.getPropertyValue('--accent') || '#e8112d').trim();
    var ink = (styles.getPropertyValue('--ink-faint') || '#6b7178').trim();

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

    // The cars.
    var radius = Math.max(4, canvas.width / 190);
    ctx.font = '600 ' + Math.max(9, Math.round(canvas.width / 105)) + 'px "Chivo Mono", monospace';
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
        // Ease along the path rather than across the infield.
        var t = reducedMotion ? 1 :
          Math.min(1, (now - car.since) / EASE_MS);
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
      ctx.fillStyle = car.colour || '#9aa0a6';
      ctx.globalAlpha = car.dnf ? 0.25 : 1;
      ctx.fill();
      // A dark rim so two cars overlapping still read as two.
      ctx.lineWidth = Math.max(1, radius / 4);
      ctx.strokeStyle = '#111214';
      ctx.stroke();

      if (car.code) {
        ctx.fillStyle = car.dnf ? ink : '#eceef0';
        ctx.fillText(car.code, pt[0] + radius + 3, pt[1]);
      }
      ctx.globalAlpha = 1;
    });
  }

  function loop() {
    draw();
    var now = Date.now();
    var moving = Object.keys(cars).some(function (num) {
      return !cars[num].offTrack && (now - cars[num].since) < EASE_MS;
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

    var wanted = preferredHeight(rect.width);
    if (wanted) {
      canvas.style.height = wanted + 'px';
      rect = canvas.getBoundingClientRect();
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
      fetch('assets/data/f1/' + geoId + '.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) {
            return;
          }
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
        })
        .catch(function () { loading = null; });
    },

    render: function (data) {
      if (!ready() || !circuit || !local) {
        return;
      }
      if (!canvas.width) {
        resize();
      }

      var t = transformOf();
      var now = Date.now();

      (data.drivers || []).forEach(function (driver) {
        // No transform for this circuit, or no fix for this car: nothing to place.
        if (!t || !driver.xy || driver.xy[0] === null) {
          return;
        }
        var world = apply(t, driver.xy[0], driver.xy[1]);
        var snap = nearest(world[0], world[1]);
        var car = cars[driver.num];
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
          // Resume from wherever the last ease had reached, so a car never jumps back.
          var progress = Math.min(1, (now - car.since) / EASE_MS);
          car.from = car.since
            ? car.from + ringDelta(car.from, car.to, local.length) * progress
            : snap.index;
          car.to = snap.index;
          car.since = now;
        }
      });

      wake();
      draw();
    },

    /*
     * No geometry for this circuit. Only the current calendar ships circuit files, so a
     * venue that has dropped off it — Imola, Jeddah, Sakhir — cannot be drawn. Saying so is
     * better than an empty rectangle that looks like a bug.
     */
    unavailable: function (name) {
      circuit = null;
      local = null;
      cars = {};
      loading = null;
      notice = 'No track geometry for ' + name;
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
      draw();
    }
  };
}());
