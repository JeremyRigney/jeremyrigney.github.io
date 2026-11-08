/*
 * Pitwall: the map's arithmetic — one circuit's outline laid flat, the fit that puts the
 * cars on it, the street map's tiles, the view's projection, how cars move between fixes,
 * and which turns race control has named. Pure: it runs under jsc in tests/pitwall/.
 *
 * Ports of Pocket Pitwall's data/Track.kt, data/Basemap.kt, the Projector and tilesFor in
 * ui/TrackMap.kt, wall/MapMotion.kt and wall/TurnCallouts.kt. Those were ports of the old
 * wall's f1-map.js, plus the app's own additions (unfolding needles, gliding by metres,
 * official turn labels and where they go); the two must agree with the site's build, or
 * the cars land beside the track.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  var M_PER_DEG_LAT = 110540;
  var M_PER_DEG_LON = 111320;
  var RAD = Math.PI / 180;

  /** Beyond this from the centreline a car is not on the racing surface — pit lane. */
  var OFF_TRACK_M = 45;
  var MAX_TURN_COS = Math.cos(120 * RAD);
  var FOLD_CHORD_M = 15;
  var FOLD_RATIO = 0.25;
  var FOLD_ARC_M = 160;
  var FOLD_SPAN = 14;
  var FOLD_TURN_COS = Math.cos(100 * RAD);
  // Turn labels: the stretch either side that gives the track's direction at a corner, the
  // reach either side that says which way is its inside, how far out a label lands, and how
  // much clearer the inside must be to win over the outside.
  var TANGENT_M = 30;
  var INSIDE_M = 60;
  var LABEL_NEAR = 20;
  var LABEL_FAR = 90;
  var TIE_M = 6;
  /** The least clearance of track a fallback way must have to be offered at all. */
  var LABEL_CLEAR = 30;
  var DESPIKE_PASSES = 12;
  var SMOOTH_WEIGHT = 0.18;
  var MAX_SMOOTH_SHIFT = 1.5;

  function mod(a, n) {
    return ((a % n) + n) % n;
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /** Shortest signed step from a to b round a ring of n. */
  function ringDelta(a, b, n) {
    var d = (b - a) % n;
    if (d > n / 2) { d -= n; }
    if (d < -n / 2) { d += n; }
    return d;
  }

  // ---------- Laying the outline flat ----------

  /* Equirectangular metres about the mean latitude, centred on the raw centroid. */
  function frameOf(path) {
    var lat0 = path.reduce(function (s, p) { return s + p[1]; }, 0) / path.length;
    var scale = M_PER_DEG_LON * Math.cos(lat0 * RAD);
    return {
      metresPerLon: scale,
      cx: path.reduce(function (s, p) { return s + p[0] * scale; }, 0) / path.length,
      cy: path.reduce(function (s, p) { return s + p[1] * M_PER_DEG_LAT; }, 0) / path.length
    };
  }

  /** Cosine of the turn at b: 1 straight on, −1 straight back. */
  function turnCos(a, b, c) {
    var ax = b[0] - a[0];
    var ay = b[1] - a[1];
    var bx = c[0] - b[0];
    var by = c[1] - b[1];
    var la = Math.sqrt(ax * ax + ay * ay);
    var lb = Math.sqrt(bx * bx + by * by);
    return la < 1e-6 || lb < 1e-6 ? 1 : (ax * bx + ay * by) / (la * lb);
  }

  /*
   * Lay flat each needle: a stretch where the outline runs on past a corner and then doubles
   * back on itself, which the site's build leaves at some hairpins (Sepang's last corner
   * overshoots by 40 m on both straights). A needle comes back within 15 m of where it left
   * over a path at least four times as long, and flips round at a single point. A real
   * hairpin turns over several points instead, which is how Monaco's Grand Hotel hairpin,
   * 13 m across, keeps its shape. The needle's points are kept, spread along the shortcut,
   * so every index still means the same metres round the lap.
   */
  function unfold(input) {
    var pts = input.map(function (p) { return [p[0], p[1]]; });
    var count = pts.length;
    function at(i) { return pts[mod(i, count)]; }
    var i = 0;
    while (i < count) {
      var end = -1;
      var arc = 0;
      for (var j = i + 1; j <= i + FOLD_SPAN; j++) {
        arc += Math.hypot(at(j)[0] - at(j - 1)[0], at(j)[1] - at(j - 1)[1]);
        if (arc > FOLD_ARC_M) { break; }
        if (j - i < 2) { continue; }
        var chord = Math.hypot(at(j)[0] - at(i)[0], at(j)[1] - at(i)[1]);
        if (chord < FOLD_CHORD_M && chord < FOLD_RATIO * arc) {
          for (var k = i + 1; k < j; k++) {
            if (turnCos(at(k - 1), at(k), at(k + 1)) < FOLD_TURN_COS) {
              end = j;
              break;
            }
          }
        }
      }
      if (end < 0) {
        i += 1;
        continue;
      }
      var a = at(i).slice();
      var b = at(end).slice();
      for (var m = i + 1; m < end; m++) {
        var f = (m - i) / (end - i);
        at(m)[0] = a[0] + (b[0] - a[0]) * f;
        at(m)[1] = a[1] + (b[1] - a[1]) * f;
      }
      i = end;
    }
    return pts;
  }

  /* Pull any vertex that doubles back (a >120° turn: spline overshoot) onto its neighbours' line. */
  function despike(input) {
    var pts = input;
    var count = pts.length;
    for (var pass = 0; pass < DESPIKE_PASSES; pass++) {
      var moved = 0;
      var next = [];
      for (var i = 0; i < count; i++) {
        var a = pts[mod(i - 1, count)];
        var b = pts[i];
        var c = pts[(i + 1) % count];
        var ax = b[0] - a[0];
        var ay = b[1] - a[1];
        var bx = c[0] - b[0];
        var by = c[1] - b[1];
        var la = Math.sqrt(ax * ax + ay * ay);
        var lb = Math.sqrt(bx * bx + by * by);
        if (la >= 1e-6 && lb >= 1e-6 && (ax * bx + ay * by) / (la * lb) < MAX_TURN_COS) {
          moved += 1;
          next.push([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]);
        } else {
          next.push(b);
        }
      }
      pts = next;
      if (moved === 0) { return pts; }
    }
    return pts;
  }

  /* A light pull toward the local average, capped so it cannot round off real corners. */
  function smoothPath(pts) {
    var count = pts.length;
    return pts.map(function (b, i) {
      var a = pts[mod(i - 1, count)];
      var c = pts[(i + 1) % count];
      var dx = SMOOTH_WEIGHT * ((a[0] + c[0]) / 2 - b[0]);
      var dy = SMOOTH_WEIGHT * ((a[1] + c[1]) / 2 - b[1]);
      var shift = Math.sqrt(dx * dx + dy * dy);
      if (shift > MAX_SMOOTH_SHIFT) {
        dx = dx / shift * MAX_SMOOTH_SHIFT;
        dy = dy / shift * MAX_SMOOTH_SHIFT;
      }
      return [b[0] + dx, b[1] + dy];
    });
  }

  function toLocal(path, geo) {
    var pts = path.map(function (p) { return [p[0] * geo.metresPerLon - geo.cx, p[1] * M_PER_DEG_LAT - geo.cy]; });
    // Cleaned only after centring: the centroid is what the transform was fitted to.
    return smoothPath(despike(unfold(pts)));
  }

  /* The angle that lays a circuit's long axis along x. */
  function principalAngle(pts) {
    var sxx = 0;
    var syy = 0;
    var sxy = 0;
    pts.forEach(function (p) {
      sxx += p[0] * p[0];
      syy += p[1] * p[1];
      sxy += p[0] * p[1];
    });
    return 0.5 * Math.atan2(2 * sxy, sxx - syy);
  }

  // ---------- Where turn labels go ----------

  function segmentDistance(px, py, ax, ay, bx, by) {
    var vx = bx - ax;
    var vy = by - ay;
    var l2 = vx * vx + vy * vy;
    var u = l2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / l2));
    return Math.hypot(px - ax - u * vx, py - ay - u * vy);
  }

  /**
   * How close a label pushed off corner i along side comes to any other stretch of the path,
   * in metres: the least distance, over points from LABEL_NEAR to LABEL_FAR out, to the
   * path's segments, leaving out the corner's own stretch either side of it.
   */
  function clearance(xs, ys, i, side, step) {
    var n = xs.length;
    var own = Math.round(LABEL_FAR / step) + 1;
    var least = Infinity;
    for (var d = LABEL_NEAR; d <= LABEL_FAR; d += 10) {
      var px = xs[i] + side[0] * d;
      var py = ys[i] + side[1] * d;
      for (var j = 0; j < n; j++) {
        var g = mod(j - i, n);
        if (Math.min(g, n - g) <= own) { continue; }
        var b = (j + 1) % n;
        var dist = segmentDistance(px, py, xs[j], ys[j], xs[b], ys[b]);
        if (dist < least) { least = dist; }
      }
    }
    return least;
  }

  /*
   * Which way off the track a corner's label goes. On a circuit that doubles back on itself
   * one side can be another stretch of track: so each way is tried along a line from
   * LABEL_NEAR to LABEL_FAR metres out, and the one that keeps furthest from any other part
   * of the path wins. The ways tried are square to the direction of travel on either side,
   * then the four diagonals between those and the track. Near enough the best, square on the
   * corner's outside, which is where a circuit map puts it.
   */
  function ways(xs, ys, i, step) {
    var n = xs.length;
    function at(k) { return mod(k, n); }
    var k = Math.max(1, Math.round(TANGENT_M / step));
    var tx = xs[at(i + k)] - xs[at(i - k)];
    var ty = ys[at(i + k)] - ys[at(i - k)];
    var length = Math.hypot(tx, ty);
    if (length < 1e-9) { return [[0, 1]]; }
    tx /= length;
    ty /= length;
    var right = [ty, -tx];
    var left = [-ty, tx];
    var m = Math.max(2, Math.round(INSIDE_M / step));
    var inX = (xs[at(i - m)] + xs[at(i + m)]) / 2 - xs[i];
    var inY = (ys[at(i - m)] + ys[at(i + m)]) / 2 - ys[i];
    var outside = right[0] * inX + right[1] * inY < 0 ? right : left;
    var inside = outside === right ? left : right;
    var r = 1 / Math.sqrt(2);
    function lean(side, along) {
      return [(side[0] + tx * along) * r, (side[1] + ty * along) * r];
    }
    var all = [outside, inside, lean(outside, 1), lean(outside, -1), lean(inside, 1), lean(inside, -1)];
    var clear = all.map(function (w) { return clearance(xs, ys, i, w, step); });
    var best = 0;
    clear.forEach(function (c, idx) { if (c > clear[best]) { best = idx; } });
    var first = clear[0] >= clear[best] - TIE_M ? 0 : best;
    // Then any other way that also keeps clear, clearest first.
    var rest = all.map(function (w, idx) { return idx; })
      .filter(function (idx) { return idx !== first && clear[idx] >= LABEL_CLEAR; })
      .sort(function (a, b) { return clear[b] - clear[a]; });
    return [first].concat(rest).map(function (idx) { return all[idx]; });
  }

  // ---------- The track ----------

  /**
   * One circuit's outline (assets/data/f1/<geoId>.json) laid flat for a top-down map, plus
   * the fit that puts OpenF1's car positions onto it. OpenF1's location stream is in
   * Formula 1's own frame, in decimetres; the site's build fitted that frame to the outline
   * and stored six coefficients as locationTransform: X = a·x + b·y + c, Y = d·x + e·y + f
   * (metres about the path's centroid).
   */
  function Track(id, json) {
    var o = typeof json === 'string' ? JSON.parse(json) : json;
    var path = (Array.isArray(o.path) ? o.path : []).filter(function (p) {
      return Array.isArray(p) && num(p[0]) != null && num(p[1]) != null;
    });
    if (path.length < 3) { throw new Error('No path for ' + id); }
    this.id = id;
    this.name = typeof o.name === 'string' ? o.name : null;
    var geo = this.geo = frameOf(path);
    var flat = toLocal(path, geo);
    var spin = this.spin = principalAngle(flat);
    var c = Math.cos(spin);
    var s = Math.sin(spin);
    var n = flat.length;
    var xs = this.xs = new Float64Array(n);
    var ys = this.ys = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      xs[i] = flat[i][0] * c + flat[i][1] * s;
      ys[i] = -flat[i][0] * s + flat[i][1] * c;
    }
    this.size = n;
    var step = this.step = num(o.step) || 15;
    var t = o.locationTransform;
    var keys = t ? ['a', 'b', 'c', 'd', 'e', 'f'].map(function (k) { return num(t[k]); }) : null;
    this.transform = keys && keys.every(function (k) { return k != null; }) ? keys : null;
    var start = (Array.isArray(o.markers) ? o.markers : []).filter(function (m) { return m && m.type === 'start-finish' && num(m.s) != null; })[0];
    this.startIndex = start ? Math.round(start.s / step) % n : null;
    this.marshalSectors = (Array.isArray(o.marshalSectors) ? o.marshalSectors : []).filter(function (m) {
      return m && num(m.n) != null && num(m.s) != null;
    }).map(function (m) { return [m.n, m.s]; });
    // Official corners only. Where the build had no official map for a circuit it marked its
    // own curvature-based guesses provisional; race control's numbering needn't match those.
    this.turns = (Array.isArray(o.turns) ? o.turns : []).filter(function (tn) {
      return tn && !tn.provisional && num(tn.n) != null && num(tn.s) != null;
    }).map(function (tn) {
      var index = mod(Math.round(tn.s / step), n);
      var letter = typeof tn.letter === 'string' ? tn.letter : '';
      return { number: tn.n, letter: letter, label: 'T' + tn.n + letter, index: index, ways: ways(xs, ys, index, step) };
    });
    var minX = Infinity;
    var maxX = -Infinity;
    var minY = Infinity;
    var maxY = -Infinity;
    for (var j = 0; j < n; j++) {
      minX = Math.min(minX, xs[j]);
      maxX = Math.max(maxX, xs[j]);
      minY = Math.min(minY, ys[j]);
      maxY = Math.max(maxY, ys[j]);
    }
    this.minX = minX;
    this.maxX = maxX;
    this.minY = minY;
    this.maxY = maxY;
    /*
     * Metres round the path to each point from point 0; the last entry is the whole lap.
     * The points are not evenly spaced: most are 15 m apart, but the lap's closing gap runs
     * up to 115 m and unfold packs a needle's points into a few metres.
     */
    var along = this.along = new Float64Array(n + 1);
    for (var k = 1; k <= n; k++) {
      var a = k - 1;
      var b = k % n;
      along[k] = along[a] + Math.hypot(xs[b] - xs[a], ys[b] - ys[a]);
    }
    this.perimeter = along[n];
    this.hasTransform = !!this.transform;
  }

  /** A point on the earth in the track's own frame: the rotated metres the path is drawn in. */
  Track.prototype.local = function (lon, lat) {
    var px = lon * this.geo.metresPerLon - this.geo.cx;
    var py = lat * M_PER_DEG_LAT - this.geo.cy;
    var c = Math.cos(this.spin);
    var s = Math.sin(this.spin);
    return [px * c + py * s, -px * s + py * c];
  };

  /** The other way: a point in the track's frame back to [lon, lat]. */
  Track.prototype.lonLat = function (x, y) {
    var c = Math.cos(this.spin);
    var s = Math.sin(this.spin);
    var px = x * c - y * s;
    var py = x * s + y * c;
    return [(px + this.geo.cx) / this.geo.metresPerLon, (py + this.geo.cy) / M_PER_DEG_LAT];
  };

  /** OpenF1 decimetres → the rotated local metres the path is drawn in; null with no fit. */
  Track.prototype.place = function (x, y) {
    var t = this.transform;
    if (!t) { return null; }
    var px = t[0] * x + t[1] * y + t[2];
    var py = t[3] * x + t[4] * y + t[5];
    var c = Math.cos(this.spin);
    var s = Math.sin(this.spin);
    return [px * c + py * s, -px * s + py * c];
  };

  /*
   * Nearest path index to a point. near restricts the search to ±8% of the lap around where
   * the car was last seen: circuits run close to themselves (Monza's parallel straights), and
   * a global search snaps a car onto the other side of the infield. The global search is the
   * fallback for a car that genuinely jumped, out of the pits say.
   */
  Track.prototype.nearest = function (x, y, near) {
    var xs = this.xs;
    var ys = this.ys;
    var count = this.size;
    var best = 0;
    var bestD = Infinity;
    var i;
    var d;
    if (near != null) {
      var span = Math.max(6, Math.round(count * 0.08));
      var centre = Math.round(near);
      for (i = -span; i <= span; i++) {
        var idx = mod(centre + i, count);
        d = (x - xs[idx]) * (x - xs[idx]) + (y - ys[idx]) * (y - ys[idx]);
        if (d < bestD) {
          bestD = d;
          best = idx;
        }
      }
      if (Math.sqrt(bestD) <= OFF_TRACK_M) { return { index: best, distance: Math.sqrt(bestD) }; }
      bestD = Infinity;
    }
    for (i = 0; i < count; i++) {
      d = (x - xs[i]) * (x - xs[i]) + (y - ys[i]) * (y - ys[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { index: best, distance: Math.sqrt(bestD) };
  };

  /** The point at fractional path index at, interpolated between its neighbours. */
  Track.prototype.pointAt = function (at) {
    var count = this.size;
    var floor = Math.floor(at);
    var i0 = mod(floor, count);
    var i1 = (i0 + 1) % count;
    var f = at - floor;
    return [this.xs[i0] + (this.xs[i1] - this.xs[i0]) * f, this.ys[i0] + (this.ys[i1] - this.ys[i0]) * f];
  };

  /** Metres round the path from point 0 to fractional index at. */
  Track.prototype.distanceAt = function (at) {
    var floor = Math.floor(at);
    var i0 = mod(floor, this.size);
    return this.along[i0] + (this.along[i0 + 1] - this.along[i0]) * (at - floor);
  };

  /** The fractional index distance metres round the path from point 0. */
  Track.prototype.indexAt = function (distance) {
    var lap = this.perimeter;
    var d = ((distance % lap) + lap) % lap;
    var lo = 0;
    var hi = this.size;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (this.along[mid] <= d) { lo = mid; } else { hi = mid; }
    }
    var segment = this.along[lo + 1] - this.along[lo];
    return lo + (segment > 1e-9 ? (d - this.along[lo]) / segment : 0);
  };

  /**
   * The fractional index t of the way from from to to, measured in metres the short way
   * round, so a car gliding between them keeps an even speed over uneven points.
   */
  Track.prototype.glide = function (from, to, t) {
    var steps = ringDelta(from, to, this.size);
    if (steps === 0) { return from; }
    var start = this.distanceAt(from);
    var metres = this.distanceAt(to) - start;
    if (steps > 0 && metres < 0) { metres += this.perimeter; }
    if (steps < 0 && metres > 0) { metres -= this.perimeter; }
    return this.indexAt(start + metres * t);
  };

  /*
   * The stretch of path one marshalling sector covers, as [from, to] indices. The file
   * stores where each sector begins, in metres round the lap; a sector runs to the next one's
   * start, and the last wraps to the first.
   */
  Track.prototype.sectorArc = function (number) {
    var list = this.marshalSectors;
    if (list.length < 2) { return null; }
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i][0] === number) { at = i; break; }
    }
    if (at < 0) { return null; }
    var next = list[(at + 1) % list.length];
    return [Math.round(list[at][1] / this.step) % this.size, Math.round(next[1] / this.step) % this.size];
  };

  Track.OFF_TRACK_M = OFF_TRACK_M;
  Track.LABEL_CLEAR = LABEL_CLEAR;
  Track.ringDelta = ringDelta;
  Track.clearance = clearance;
  Track.unfold = unfold;
  Track.despike = despike;

  // ---------- The street map ----------

  /*
   * CARTO's dark basemap without labels, in the usual Web Mercator grid: roads, water and
   * building outlines in greys that sit quietly behind the circuit. 512-px tiles.
   */
  var EARTH = 40075016.686;
  var Mercator = {
    TILE_PX: 512,
    CREDIT: '© OpenStreetMap contributors © CARTO',
    x: function (lon, z) { return (lon + 180) / 360 * Math.pow(2, z); },
    y: function (lat, z) {
      var r = lat * RAD;
      return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
    },
    lon: function (x, z) { return x / Math.pow(2, z) * 360 - 180; },
    lat: function (y, z) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, z)))) / RAD; },
    /** The zoom whose tile pixels come closest to metresPerPixel at lat, so tiles draw at about 1:1. */
    zoomFor: function (metresPerPixel, lat) {
      var z = Math.round(Math.log2(EARTH * Math.cos(lat * RAD) / (512 * metresPerPixel)));
      return Math.min(18, Math.max(11, z));
    },
    /** Every tile at z that overlaps the box. */
    covering: function (west, south, east, north, z) {
      var x0 = Math.floor(Mercator.x(west, z));
      var x1 = Math.floor(Mercator.x(east, z));
      var y0 = Math.floor(Mercator.y(north, z));
      var y1 = Math.floor(Mercator.y(south, z));
      var out = [];
      for (var ty = y0; ty <= y1; ty++) {
        for (var tx = x0; tx <= x1; tx++) { out.push({ z: z, x: tx, y: ty, key: z + '/' + tx + '/' + ty }); }
      }
      return out;
    }
  };

  // ---------- The view ----------

  /**
   * Track metres → pixels, fitted with a margin. A tall view gets the circuit turned a
   * quarter (a rotation, never a mirror, so corners keep their hand).
   */
  function Projector(scale, offX, offY, turn) {
    this.scale = scale;
    this.offX = offX;
    this.offY = offY;
    this.turn = turn;
    this.pixelsPerMetre = scale;
  }

  /**
   * The same view zoomed k× about the point c on screen, then shifted by pan: a point at s
   * on screen moves to c + (s − c)·k + pan.
   */
  Projector.prototype.zoomed = function (k, pan, c) {
    return new Projector(this.scale * k, c[0] + (this.offX - c[0]) * k + pan[0], c[1] + (this.offY - c[1]) * k + pan[1], this.turn);
  };

  Projector.prototype.project = function (x, y) {
    var u = this.turn ? -y : x;
    var v = this.turn ? x : y;
    // Screen y grows downward; the world's does not.
    return [u * this.scale + this.offX, this.offY - v * this.scale];
  };

  /** Pixels back to the track's metres. */
  Projector.prototype.unproject = function (sx, sy) {
    var u = (sx - this.offX) / this.scale;
    var v = (this.offY - sy) / this.scale;
    return this.turn ? [v, -u] : [u, v];
  };

  /** Where the circuit's bounding box falls on screen, as [left, top, right, bottom]. */
  Projector.prototype.bounds = function (track) {
    var self = this;
    var corners = [[track.minX, track.minY], [track.maxX, track.minY], [track.minX, track.maxY], [track.maxX, track.maxY]]
      .map(function (p) { return self.project(p[0], p[1]); });
    var xs = corners.map(function (p) { return p[0]; });
    var ys = corners.map(function (p) { return p[1]; });
    return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
  };

  Projector.fit = function (track, w, h, pad, turn) {
    var tall = turn == null ? h > w : turn;
    var minU = tall ? -track.maxY : track.minX;
    var maxU = tall ? -track.minY : track.maxX;
    var minV = tall ? track.minX : track.minY;
    var maxV = tall ? track.maxX : track.maxY;
    var spanU = Math.max(1, maxU - minU);
    var spanV = Math.max(1, maxV - minV);
    var scale = Math.min((w - pad * 2) / spanU, (h - pad * 2) / spanV);
    var offX = (w - spanU * scale) / 2 - minU * scale;
    var offY = (h - spanV * scale) / 2 + maxV * scale;
    return new Projector(scale, offX, offY, tall);
  };

  /**
   * pan held so the middle of the screen c stays over the circuit's box (at k× it spans
   * c + (box − c)·k + pan), however far it's dragged; none at the whole-circuit view.
   */
  Projector.clampPan = function (pan, k, box, c) {
    if (k <= 1.001) { return [0, 0]; }
    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    return [
      clamp(pan[0], -(box[2] - c[0]) * k, -(box[0] - c[0]) * k),
      clamp(pan[1], -(box[3] - c[1]) * k, -(box[1] - c[1]) * k)
    ];
  };

  /** The street map tiles covering the screen under p, at about one tile pixel to a screen pixel. */
  function tilesFor(track, p, w, h) {
    var corners = [[0, 0], [w, 0], [0, h], [w, h]].map(function (s) {
      var m = p.unproject(s[0], s[1]);
      return track.lonLat(m[0], m[1]);
    });
    var lons = corners.map(function (c) { return c[0]; });
    var lats = corners.map(function (c) { return c[1]; });
    var west = Math.min.apply(null, lons);
    var east = Math.max.apply(null, lons);
    var south = Math.min.apply(null, lats);
    var north = Math.max.apply(null, lats);
    var z = Mercator.zoomFor(1 / p.pixelsPerMetre, (north + south) / 2);
    var want = Mercator.covering(west, south, east, north, z);
    // A sensible ceiling on downloads, whatever the screen.
    while (want.length > 48 && z > 11) {
      z -= 1;
      want = Mercator.covering(west, south, east, north, z);
    }
    return want;
  }

  // ---------- Cars between fixes ----------

  var FIRST_GAP_MS = 3000;
  var TRAVEL_MIN = 200;
  var TRAVEL_MAX = 6000;
  var TRAVEL_STRETCH = 1.25;
  var SNAP_FRACTION = 0.25;
  var SCRUB_JUMP_MS = 20000;

  /**
   * Where each car is on the map, and how it travels between the positions it reports.
   * A car spends the whole measured interval between position updates covering the ground,
   * at an even speed along the track (by metres, not by path points), so it is still moving
   * when the next fix lands and that redirects it instead of restarting it. A jump in race
   * time (a scrub) or a leap of a quarter lap snaps instead of gliding. Cars far off the
   * centreline (the pit lane) are drawn where they are.
   *
   * initialGapMs: the gap between fixes to assume before any have been timed. A motion made
   * mid-stream is given the stream's own pace, so its first glides aren't a slow three seconds.
   */
  function MapMotion(track, initialGapMs) {
    this.track = track;
    this.cars = new Map();
    this.gapMs = Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, initialGapMs == null ? FIRST_GAP_MS : initialGapMs));
    this.lastRender = 0;
    this.lastRaceAt = null;
    this.lastPositions = '';
    this.lastFreshAt = 0;
  }

  /**
   * Take the cars' latest fixes. positions, when given, are the live stream's — several a
   * second — and win over the frame's own xy; at is the instant they describe.
   */
  MapMotion.prototype.update = function (frame, now, glide, positions, at) {
    var track = this.track;
    function fixOf(d) {
      return positions && positions[d.num] ? positions[d.num] : d.xy;
    }
    var raceAt = at != null ? at : frame.raceAt;
    var scrubbed = this.lastRender === 0 || glide === false;
    var previous = this.lastRaceAt;
    if (!scrubbed && raceAt != null && previous != null) {
      var jump = raceAt - previous;
      scrubbed = jump < 0 || jump > SCRUB_JUMP_MS;
    }
    this.lastRender = now;
    this.lastRaceAt = raceAt;

    // Time the glide off the frames that carry new fixes, not off the poll: location
    // refreshes upstream every ~4 s while the poll is 1.5 s.
    var signature = frame.drivers.map(function (d) {
      var f = fixOf(d);
      return f ? f[0] + ',' + f[1] : '';
    }).join('|');
    if (signature !== this.lastPositions) {
      if (this.lastFreshAt !== 0 && !scrubbed) {
        var seen = Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, now - this.lastFreshAt));
        this.gapMs = this.gapMs * 0.6 + seen * 0.4;
      }
      this.lastFreshAt = now;
      this.lastPositions = signature;
    }
    var travel = scrubbed ? TRAVEL_MIN : Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, Math.trunc(this.gapMs * TRAVEL_STRETCH)));

    var cars = this.cars;
    frame.drivers.forEach(function (driver) {
      var xy = fixOf(driver);
      if (!xy) { return; }
      var w = track.place(xy[0], xy[1]);
      if (!w) { return; }
      var known = cars.get(driver.num);
      var snap = track.nearest(w[0], w[1], known ? known.to : null);
      var car = known;
      if (!car) {
        car = { from: snap.index, to: snap.index, since: 0, travel: TRAVEL_MIN, x: 0, y: 0, offTrack: false };
        cars.set(driver.num, car);
      }
      car.colour = driver.colour;
      car.code = driver.code;
      car.dnf = driver.dnf;
      car.x = w[0];
      car.y = w[1];
      car.offTrack = snap.distance > OFF_TRACK_M;
      if (!car.offTrack && snap.index !== car.to) {
        var progress = Math.min(1, (now - car.since) / Math.max(1, car.travel));
        var at2 = car.since !== 0 ? track.glide(car.from, car.to, progress) : snap.index;
        var leap = Math.abs(ringDelta(at2, snap.index, track.size)) / track.size;
        car.from = scrubbed || leap > SNAP_FRACTION ? snap.index : at2;
        car.to = snap.index;
        car.since = now;
        car.travel = travel;
      }
    });
  };

  /** Where car is drawn at now, in the track's metres. */
  MapMotion.prototype.position = function (car, now) {
    if (car.offTrack) { return [car.x, car.y]; }
    var t = Math.min(1, (now - car.since) / Math.max(1, car.travel));
    return this.track.pointAt(this.track.glide(car.from, car.to, t));
  };

  MapMotion.prototype.moving = function (now) {
    var any = false;
    this.cars.forEach(function (car) {
      if (!car.offTrack && now - car.since < car.travel) { any = true; }
    });
    return any;
  };

  /** Why the track has no cars on it, when it has none. */
  MapMotion.prototype.emptyReason = function (frame) {
    if (this.cars.size) { return null; }
    if (!this.track.hasTransform) { return 'No map fit for this circuit — the track is drawn, the cars can’t be'; }
    if (frame.drivers.length) { return 'No car positions in this session’s timing feed'; }
    return null;
  };

  MapMotion.FIRST_GAP_MS = FIRST_GAP_MS;

  // ---------- Turns race control names ----------

  /** "TURN 12", "TURNS 6 AND 7", "TURNS 6-7", "TURNS 6, 7 AND 8", "TURN 11A". */
  var TURNS = /\bTURNS?\s+(\d{1,2}[A-Z]?(?:\s*(?:,|AND|&|-|\/|TO)\s*\d{1,2}[A-Z]?)*)\b/gi;
  /** "T12", "T1A": the short form. */
  var SHORT = /\bT(\d{1,2})([A-Z]?)\b/gi;
  var ONE = /(\d{1,2})([A-Z]?)/gi;
  var CALLOUT_WINDOW = 30000;

  /** The turns named in one message, as the map labels them: "T12", "T11A". */
  function labels(text) {
    var out = [];
    function add(label) {
      if (out.indexOf(label) < 0) { out.push(label); }
    }
    var m;
    TURNS.lastIndex = 0;
    while ((m = TURNS.exec(text))) {
      var group = m[1];
      var n;
      ONE.lastIndex = 0;
      while ((n = ONE.exec(group))) { add('T' + parseInt(n[1], 10) + n[2].toUpperCase()); }
    }
    SHORT.lastIndex = 0;
    while ((m = SHORT.exec(text))) { add('T' + parseInt(m[1], 10) + m[2].toUpperCase()); }
    return out;
  }

  /**
   * The turns named by messages from the last 30 s before at — the drawn frame's moment, so
   * this keeps to the delay live and to the playhead in replay.
   */
  function named(events, at, windowMs) {
    var out = {};
    if (at == null) { return out; }
    var window = windowMs == null ? CALLOUT_WINDOW : windowMs;
    events.forEach(function (e) {
      if (e.t == null || e.t > at || at - e.t > window) { return; }
      labels(e.text).forEach(function (label) { out[label] = true; });
    });
    return out;
  }

  P.Track = Track;
  P.Mercator = Mercator;
  P.Projector = Projector;
  P.tilesFor = tilesFor;
  P.MapMotion = MapMotion;
  P.Callouts = { labels: labels, named: named };
}());
