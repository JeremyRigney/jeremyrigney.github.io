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
  var DATA_V = '20260907';

  /* Beyond this from the centreline a car is not on the racing surface — pit lane. */
  var OFF_TRACK_M = 45;

  /*
   * How long a car takes to slide to a newly reported position.
   *
   * Adaptive, not fixed. A car eased over 900ms while frames arrive every 150ms is
   * permanently chasing a target it never reaches, which reads as lag — and the faster the
   * lab plays, the worse it looks. Easing over roughly the gap between updates instead
   * keeps the cars with the data at any speed.
   */
  var EASE_MIN = 90;
  var EASE_MAX = 900;
  var easeMs = EASE_MAX;
  var lastRender = 0;

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
          Math.min(1, (now - car.since) / easeMs);
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
      return !cars[num].offTrack && (now - cars[num].since) < easeMs;
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
      if (!ready() || !circuit || !local) {
        return;
      }
      if (!canvas.width) {
        resize();
      }

      var t = transformOf();
      var now = Date.now();

      // Ease over about the gap between frames. At 10x the lab delivers a frame every
      // couple of hundred milliseconds, and easing each one over 900ms would leave every
      // car permanently short of where the data says it is.
      if (lastRender) {
        easeMs = Math.max(EASE_MIN, Math.min(EASE_MAX, now - lastRender));
      }
      lastRender = now;

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
          // Resume from wherever the last ease had reached, so a car never jumps back.
          var progress = Math.min(1, (now - car.since) / easeMs);
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
      draw();
    }
  };
}());
