/*
 * /f1 — the next Formula 1 circuit, revealed on scroll.
 *
 * The page ships with everything it needs. tools/build-f1-data.py precomputes a
 * season index and one file per circuit (uniform 15 m track samples plus a DEM
 * elevation profile), so this file does no geometry work beyond projection and
 * makes at most one network call at runtime, to refresh the last winner.
 *
 * The scene is a single canvas driven directly by scroll position — the same
 * rAF-and-lerp approach as the eclipse scroll story, rather than a scroll library.
 * There are no third-party dependencies at all: section reveals use an
 * IntersectionObserver, as on the homepage.
 *
 * Coordinate pipeline, once per circuit:
 *
 *   lon/lat  ->  local metres about the centroid (equirectangular; fine over 7 km)
 *            ->  PCA-rotated so the circuit's long axis lies across the screen
 *            ->  yaw about Z, tilt about X, gentle perspective
 *            ->  device pixels
 *
 * Every marker — corners, start/finish, and the Overtake Mode detection line when
 * the FIA publish where those sit — is addressed by `s`, its arc length in metres
 * around the lap, so positions can be corrected by editing data alone.
 */

(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var DATA_DIR = 'assets/data/f1/';
  var SEASON = 2026;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // The fixed header's height, for offsetting anchor jumps. Matches .site-header.
  var HEADER_H = 62;

  // How long the intro outline takes to draw itself, and the hard ceiling on the
  // whole sequence. The scene is built while the outline draws, so the draw is
  // covering work that was happening anyway rather than delaying it.
  var INTRO_DRAW_MS = 900;
  var INTRO_MAX_MS = 3000;

  /*
   * The Lenis instance, or null when it is not driving: reduced motion, or the CDN
   * script failing to load. Everything that reads it treats null as "use the native
   * scroll", so the page degrades to exactly what it was before Lenis was added.
   */
  var scroller = null;

  /*
   * Wakes the render loop. Assigned by run() once that loop exists, and a no-op
   * until then. Anything that moves the page without producing an input event —
   * lenis.scrollTo() from a nav click, most of all — has to call this: the loop
   * parks when idle, and while it is parked Lenis's raf is not being called, so its
   * animation would sit there never advancing.
   */
  var wake = function () {};

  var MAX_TILT = 58 * Math.PI / 180;
  var MAX_YAW = -22 * Math.PI / 180;

  /*
   * How much of the rise window the travelling wave occupies, 0-1.
   *
   * At 0 every point rises together and the circuit simply inflates. At 1 the head
   * of the wave reaches the flag exactly as the tail leaves the line, so no point
   * is ever given time to finish standing up. 0.45 leaves each point a little over
   * half the window to rise in, which keeps the sweep obvious without the far side
   * of the circuit still lying flat when the near side has finished.
   */
  var RISE_SPREAD = 0.45;

  // Distance between the posts dropped from the track down to the ground plane,
  // in metres. Sparse enough to read as a scale rather than a fence.
  var POST_SPACING_M = 150;

  // Ribbon height as a fraction of the circuit's on-screen width. Because it is a
  // fraction of the *model*, flat circuits get amplified harder than hilly ones, so
  // that Zandvoort's 5 m is still legible next to Spa's 106 m. The resulting factor
  // is put on screen so the exaggeration is never implied to be real.
  var RIBBON_FRACTION = 0.17;

  /*
   * Ceiling on that amplification.
   *
   * Uncapped, the fraction above asks for absurd factors on the flattest circuits —
   * ×150 at Miami, whose entire lap covers 1.7 m of height. At that gain the ribbon
   * is not showing terrain, it is showing the digital elevation model's own noise:
   * the DEMs sampled here have vertical errors of several metres, which is larger
   * than Miami's whole range. Capping keeps flat circuits reading as flat, and only
   * bites on the circuits where the relief is at or below the noise floor anyway.
   */
  var MAX_EXAGGERATION = 12;

  /*
   * Above this turn angle at one vertex, the geometry is not a corner.
   *
   * The path arrives resampled to an even 15 m, so the turn at a vertex implies a
   * corner radius: 120 degrees means 7 m, tighter than anything in Formula 1 (the
   * sharpest real corner in this data set, Monaco's hairpin, turns 77). Everything
   * past the threshold is spline overshoot in the source geometry, where the curve
   * loops back on itself and the resampler walks out and straight back in — 47 such
   * vertices across 14 circuits, drawn as pinches and needles.
   */
  var MAX_TURN_COS = Math.cos(120 * Math.PI / 180);
  var DESPIKE_PASSES = 12;

  /*
   * A light pull toward the local average afterwards, to take the faceting off
   * curves, with a hard ceiling on how far it may move any one point.
   *
   * The ceiling matters more than the weight. Smoothing a polyline cuts corners, and
   * the correction is largest exactly where the track is sharpest — unclamped, this
   * weight moves an apex at Sepang by 9 m, which is most of a track width. Clamped,
   * it rounds the hard points off without meaningfully relocating the racing line.
   */
  var SMOOTH_WEIGHT = 0.18;
  var MAX_SMOOTH_SHIFT = 1.5;

  var PERSPECTIVE = 0.1;   // gentle; the poster look is closer to orthographic
  var TILE_URL = window.cartoTiles
    ? window.cartoTiles('dark_nolabels', { subdomain: 'a', retina: '@2x' })
    : null;
  var MAX_TILES = 40;

  var M_PER_DEG_LAT = 110540;
  var M_PER_DEG_LON = 111320;

  /*
   * One accent colour per circuit, keyed by the Jolpica circuit id.
   *
   * Keyed on that rather than on the geoId used for the data files because the ids
   * read as the circuit's name, and because Jeddah has a colour but no round in the
   * 2026 calendar and so no data file to hang a geoId on. Circuits missing from this
   * map fall back to Formula 1 red, which is what the whole page used to be.
   */
  var DEFAULT_ACCENT = '#e8112d';

  var CIRCUIT_COLOURS = {
    albert_park: '#3B7A9E',   // Albert Park blue
    suzuka: '#2E4172',        // Ai indigo
    miami: '#FF6FA5',         // Flamingo pink
    monaco: '#0E3A5C',        // Harbour navy
    silverstone: '#004225',   // British racing green
    spa: '#5A7566',           // Ardennes mist
    zandvoort: '#FF6B00',     // Dutch orange
    monza: '#B21419',         // Autodromo red
    jeddah: '#0E7C7B',        // Red Sea teal
    marina_bay: '#4B2E83',    // Night violet
    americas: '#A94E00',      // Burnt orange
    rodriguez: '#B5127E',     // Rosa mexicano
    interlagos: '#F5C518',    // Canarinho yellow
    vegas: '#E0A32E'          // Neon gold
  };

  // The page ground, as the contrast lifts below measure against.
  var GROUND_RGB = [17, 18, 20];

  /* ---------- Accent ---------- */

  /*
   * The live accent, read by the canvas every frame. Populated by applyAccent before
   * anything draws; the defaults here are the red the page shipped with, so a failure
   * to resolve a circuit still leaves the scene painted rather than blank.
   */
  var accent = null;

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map(function (c) {
      var s = Math.round(clamp(c, 0, 255)).toString(16);
      return s.length < 2 ? '0' + s : s;
    }).join('');
  }

  /* WCAG relative luminance. */
  function luminance(rgb) {
    var channels = rgb.map(function (c) {
      var v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastWithGround(rgb) {
    var a = luminance(rgb);
    var b = luminance(GROUND_RGB);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function rgbToHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    if (max === min) {
      return [0, 0, l];
    }
    var d = max - min;
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    return [h / 6, s, l];
  }

  function hslToRgb(hsl) {
    var h = hsl[0], s = hsl[1], l = hsl[2];
    if (s === 0) {
      return [l * 255, l * 255, l * 255];
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function channel(t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
  }

  /*
   * Raise a colour's lightness until it clears a contrast ratio against the page
   * ground, holding hue and saturation.
   *
   * Half the palette is chosen for what the place looks like rather than for what
   * reads on charcoal — Monaco's harbour navy sits at 1.6:1, Silverstone's British
   * racing green at 1.6:1, where text needs 4.5:1. Lifting in HSL keeps the colour
   * recognisably itself (the navy becomes a mid blue, not a grey) while making it
   * legible, and colours that are already bright pass straight through untouched.
   */
  function liftToContrast(rgb, target) {
    var hsl = rgbToHsl(rgb);
    var lifted = rgb;
    var l = hsl[2];
    // Rounded to 8-bit channels before the test, not after: measuring the contrast
    // of the float colour and then rounding it can land just under the target.
    while (contrastWithGround(lifted) < target && l < 0.95) {
      l += 0.005;
      lifted = hslToRgb([hsl[0], hsl[1], l]).map(Math.round);
    }
    return lifted;
  }

  /*
   * Three tones from one hex: the raw colour for large fills where its mass carries
   * it, a 3:1 tone for lines and borders, a 5:1 tone for anything that is text.
   * Matches the --f1-red / --f1-red-soft pair the stylesheet already used, and run
   * against that red it reproduces very nearly the same two values.
   */
  function deriveAccent(hex) {
    var deepRgb = hexToRgb(hex);
    var baseRgb = liftToContrast(deepRgb, 3);
    var softRgb = liftToContrast(deepRgb, 5);

    function rgba(rgb, alpha) {
      return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
    }

    return {
      deep: rgbToHex(deepRgb),
      base: rgbToHex(baseRgb),
      soft: rgbToHex(softRgb),
      deepRgb: deepRgb,
      // The brightest of the three, which is what the ribbon's rising edge mixes
      // towards so the wave front reads as lit rather than merely a lighter wall.
      softRgb: softRgb,
      rgbTriple: deepRgb.join(', '),
      // Prebuilt because the draw loops would otherwise reformat these every frame.
      baseAt90: rgba(baseRgb, 0.9),
      baseAt55: rgba(baseRgb, 0.55),
      softAt55: rgba(softRgb, 0.55),
      baseAt42: rgba(baseRgb, 0.42),
      baseAt02: rgba(baseRgb, 0.02)
    };
  }

  /* ---------- Favicon ---------- */

  /*
   * The tab icon, as one template with the stroke colour left open.
   *
   * This is assets/favicon-f1.svg with its comment stripped and %s where the stroke
   * colour goes — that file is the version the markup ships and the one that renders
   * with the script off, this is the version the accent repaints. Edit the shape in
   * one and port it to the other.
   */
  var FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<rect width="32" height="32" rx="7" fill="#111214"/>'
    + '<path d="M 16 5.6 C 22.6 5.6, 26.6 9.8, 26.6 15.4 C 26.6 20.2, 23.6 24.2, 19.2 25.9'
    + ' C 16.4 27, 13.4 25.4, 14.2 22.8 C 14.9 20.4, 12.2 19.2, 10.4 21.2'
    + ' C 8 23.9, 5.4 21.4, 5.4 17.2 C 5.4 10.4, 9.4 5.6, 16 5.6 Z"'
    + ' fill="none" stroke="%s" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

  /*
   * The icon at one colour, as a data URI.
   *
   * encodeURIComponent rather than a raw inline SVG: the colour arrives as a hex, and
   * an unescaped # would truncate the URI at the fragment.
   */
  function faviconDataUri(colour) {
    return 'data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG.replace('%s', colour));
  }

  /*
   * Point the whole page at one circuit's colour.
   *
   * The single entry point for the accent: CSS picks it up through the custom
   * properties, the canvas through the module-level `accent`, the tab through its
   * icon. Re-calling this and redrawing is all a change of circuit needs.
   */
  function applyAccent(circuitId) {
    accent = deriveAccent(CIRCUIT_COLOURS[circuitId] || DEFAULT_ACCENT);

    var root = document.documentElement;
    root.style.setProperty('--accent', accent.base);
    root.style.setProperty('--accent-soft', accent.soft);
    root.style.setProperty('--accent-deep', accent.deep);
    root.style.setProperty('--accent-rgb', accent.rgbTriple);

    /*
     * The lifted tone, not the circuit's colour as given: a favicon sits on the same
     * charcoal the rest of the page does, so Monaco's harbour navy needs the same lift
     * here that it needs everywhere else to stay visible.
     */
    var icon = document.getElementById('favicon');
    if (icon) {
      icon.href = faviconDataUri(accent.base);
    }
    return accent;
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  /* Normalised progress through a sub-range of the overall scroll timeline. */
  function seg(p, a, b) {
    return clamp((p - a) / (b - a), 0, 1);
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function mix(a, b, t) {
    return a + (b - a) * t;
  }

  function fetchJSON(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) {
        throw new Error(url + ' -> ' + response.status);
      }
      return response.json();
    });
  }

  /* ---------- Formatting helpers ---------- */

  /*
   * ISO 3166-1 alpha-2 -> flag emoji, by offsetting each letter into the
   * regional-indicator block. Saves shipping 23 flag assets; the circuit ids in the
   * source GeoJSON already start with the country code.
   */
  function flagEmoji(code) {
    if (!code || code.length !== 2) {
      return '';
    }
    return String.fromCodePoint.apply(String, code.toUpperCase().split('').map(function (c) {
      return 0x1f1e6 + c.charCodeAt(0) - 65;
    }));
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  }

  /*
   * The schedule board sets the day and the clock time in separate columns, so they
   * are formatted separately rather than sliced back out of one localised string —
   * the order of the parts is locale-dependent and not safe to split on.
   */
  function formatDay(iso) {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'short'
    });
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit'
    });
  }

  function formatCountdown(ms) {
    if (ms <= 0) {
      return 'Lights out';
    }
    var totalMinutes = Math.floor(ms / 60000);
    var days = Math.floor(totalMinutes / 1440);
    var hours = Math.floor((totalMinutes % 1440) / 60);
    var minutes = totalMinutes % 60;
    if (days > 0) {
      return days + 'd ' + hours + 'h ' + minutes + 'm';
    }
    return hours + 'h ' + minutes + 'm';
  }

  function setText(id, text) {
    var node = document.getElementById(id);
    if (node) {
      node.textContent = text;
    }
  }

  /* ---------- Geometry ---------- */

  /*
   * Collapse doubling-back needles left by spline overshoot upstream.
   *
   * A flagged vertex is pulled onto the midpoint of its two neighbours, which folds
   * an out-and-back excursion flat. Needles are often two or three vertices long
   * (out, back, out), so this repeats until a pass finds nothing left to move.
   *
   * The point count is deliberately preserved. Every marker on the page — corners
   * and start/finish — is addressed by arc length as `round(s / step)` into this array,
   * so inserting or dropping a point would silently walk every label around the lap.
   * Moving a handful of them by a few metres does not.
   */
  function despike(xs, ys, count) {
    var nextX = new Float64Array(count);
    var nextY = new Float64Array(count);
    var fixed = 0;

    for (var pass = 0; pass < DESPIKE_PASSES; pass += 1) {
      var moved = 0;
      for (var i = 0; i < count; i += 1) {
        var prev = (i - 1 + count) % count;
        var next = (i + 1) % count;
        nextX[i] = xs[i];
        nextY[i] = ys[i];

        var ax = xs[i] - xs[prev];
        var ay = ys[i] - ys[prev];
        var bx = xs[next] - xs[i];
        var by = ys[next] - ys[i];
        var la = Math.hypot(ax, ay);
        var lb = Math.hypot(bx, by);
        if (la < 1e-6 || lb < 1e-6) {
          continue;
        }
        // cos of the turn: 1 is dead straight, -1 is a full reversal.
        if ((ax * bx + ay * by) / (la * lb) < MAX_TURN_COS) {
          nextX[i] = (xs[prev] + xs[next]) / 2;
          nextY[i] = (ys[prev] + ys[next]) / 2;
          moved += 1;
        }
      }
      // Applied as a whole so a pass cannot depend on the order it walked the lap.
      xs.set(nextX);
      ys.set(nextY);
      fixed += moved;
      if (!moved) {
        break;
      }
    }
    return fixed;
  }

  /*
   * One gentle pass toward the local average, to take the polygonal faceting off
   * curves. The per-point displacement is capped, because the correction grows with
   * the sharpness of the corner and is therefore biggest where cutting it would do
   * the most damage — see MAX_SMOOTH_SHIFT.
   */
  function smoothPath(xs, ys, count, weight, limit) {
    var outX = new Float64Array(count);
    var outY = new Float64Array(count);
    for (var i = 0; i < count; i += 1) {
      var prev = (i - 1 + count) % count;
      var next = (i + 1) % count;
      var dx = weight * ((xs[prev] + xs[next]) / 2 - xs[i]);
      var dy = weight * ((ys[prev] + ys[next]) / 2 - ys[i]);
      var shift = Math.hypot(dx, dy);
      if (shift > limit) {
        dx = dx / shift * limit;
        dy = dy / shift * limit;
      }
      outX[i] = xs[i] + dx;
      outY[i] = ys[i] + dy;
    }
    xs.set(outX);
    ys.set(outY);
  }

  /*
   * Project lon/lat to metres, then rotate so the circuit's principal axis runs
   * across the screen. Without the rotation, tracks laid out diagonally (Suzuka,
   * COTA) waste most of the frame; with it, every circuit fills the stage the same
   * way. On portrait viewports the axis is turned upright instead.
   */
  function prepareGeometry(circuit, portrait) {
    var path = circuit.path;
    var count = path.length;

    var lat0 = 0;
    var lon0 = 0;
    var i;
    for (i = 0; i < count; i += 1) {
      lon0 += path[i][0];
      lat0 += path[i][1];
    }
    lon0 /= count;
    lat0 /= count;

    var mPerLon = M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);
    var xs = new Float64Array(count);
    var ys = new Float64Array(count);
    for (i = 0; i < count; i += 1) {
      xs[i] = (path[i][0] - lon0) * mPerLon;
      ys[i] = (path[i][1] - lat0) * M_PER_DEG_LAT;
    }

    // Clean the source geometry before anything measures or draws it: the bounding
    // box, the fit and the outward normals all read better without the needles.
    despike(xs, ys, count);
    smoothPath(xs, ys, count, SMOOTH_WEIGHT, MAX_SMOOTH_SHIFT);

    // Principal axis of the point cloud.
    var sxx = 0;
    var syy = 0;
    var sxy = 0;
    for (i = 0; i < count; i += 1) {
      sxx += xs[i] * xs[i];
      syy += ys[i] * ys[i];
      sxy += xs[i] * ys[i];
    }
    var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    if (portrait) {
      theta += Math.PI / 2;
    }

    var cos = Math.cos(-theta);
    var sin = Math.sin(-theta);
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (i = 0; i < count; i += 1) {
      var rx = xs[i] * cos - ys[i] * sin;
      var ry = xs[i] * sin + ys[i] * cos;
      xs[i] = rx;
      ys[i] = ry;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }

    // Recentre on the bounding box rather than the centroid, so the drawing sits in
    // the middle of the frame even when the track's points bunch up at one end.
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    for (i = 0; i < count; i += 1) {
      xs[i] -= cx;
      ys[i] -= cy;
    }

    /*
     * Outward unit normal at each point, in the same plane as the track.
     *
     * Marker labels are pushed along this rather than radially outward from the
     * frame's centre: once the view tilts, "away from the middle of the screen" and
     * "off the side of the track" stop agreeing, and labels end up sitting on the
     * tarmac. The sign is chosen so the normal points away from the centroid, which
     * the points have already been recentred on.
     */
    var normalX = new Float64Array(count);
    var normalY = new Float64Array(count);
    for (i = 0; i < count; i += 1) {
      var prev = (i - 1 + count) % count;
      var next = (i + 1) % count;
      var tx = xs[next] - xs[prev];
      var ty = ys[next] - ys[prev];
      var tLength = Math.hypot(tx, ty) || 1;
      var nx = -ty / tLength;
      var ny = tx / tLength;
      if (nx * xs[i] + ny * ys[i] < 0) {
        nx = -nx;
        ny = -ny;
      }
      normalX[i] = nx;
      normalY[i] = ny;
    }

    var elev = circuit.elev;
    var minElev = Math.min.apply(Math, elev);
    var maxElev = Math.max.apply(Math, elev);
    var elevRange = Math.max(maxElev - minElev, 0.5);

    var width = maxX - minX;
    var height = maxY - minY;
    // Capped, so the flattest circuits are not shown a magnified picture of the
    // elevation model's noise. Only they reach the ceiling; hilly circuits are
    // nowhere near it and keep the fraction above.
    var zScale = Math.min((width * RIBBON_FRACTION) / elevRange, MAX_EXAGGERATION);

    return {
      xs: xs,
      ys: ys,
      zs: elev.map(function (e) { return (e - minElev) * zScale; }),
      normalX: normalX,
      normalY: normalY,
      count: count,
      width: width,
      height: height,
      radius: Math.sqrt(width * width + height * height) / 2,
      minElev: minElev,
      maxElev: maxElev,
      elevRange: elevRange,
      exaggeration: zScale,
      lat0: lat0,
      lon0: lon0,
      mPerLon: mPerLon,
      theta: theta,
      offsetX: cx,
      offsetY: cy
    };
  }

  /*
   * World -> screen.
   *
   * Yaw about the vertical axis, then tilt about the screen-horizontal axis. At
   * tilt 0 this is a plain top-down plan view and Z does nothing; as tilt opens up,
   * Z rises up the screen and the depth term drives the painter's-algorithm sort.
   */
  function makeProjector(view) {
    var cosYaw = Math.cos(view.yaw);
    var sinYaw = Math.sin(view.yaw);
    var cosTilt = Math.cos(view.tilt);
    var sinTilt = Math.sin(view.tilt);
    var scale = view.scale;
    var cx = view.cx;
    var cy = view.cy;
    var invRadius = 1 / view.radius;

    return function project(x, y, z, out) {
      var xr = x * cosYaw - y * sinYaw;
      var yr = x * sinYaw + y * cosYaw;

      var yc = yr * cosTilt + z * sinTilt;   // screen-vertical in world units
      var zc = z * cosTilt - yr * sinTilt;   // toward the camera; the depth key

      var persp = 1 + zc * invRadius * PERSPECTIVE;
      out[0] = cx + xr * scale * persp;
      out[1] = cy - yc * scale * persp;
      out[2] = zc;
      return out;
    };
  }

  /* ---------- Basemap tiles ---------- */

  /*
   * CARTO dark tiles, drawn only while the view is flat.
   *
   * Because they are faded out before the tilt opens, each tile is placed with a
   * plain affine transform derived from three of its projected corners — there is
   * never any need to warp a raster in 3D.
   *
   * The basemap is decorative: with no CARTO key set (see carto-basemap.js) the
   * scene simply renders on the flat background instead.
   */
  var tileCache = {};

  function lonToTile(lon, z) {
    return (lon + 180) / 360 * Math.pow(2, z);
  }

  function latToTile(lat, z) {
    var rad = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
  }

  function tileToLon(x, z) {
    return x / Math.pow(2, z) * 360 - 180;
  }

  function tileToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function planTiles(geometry, view, canvasWidth, canvasHeight) {
    // Match tile resolution to the on-screen scale, then back off if the resulting
    // grid would be unreasonable.
    var metresPerPixel = 1 / view.scale;
    var zoom = Math.round(
      Math.log2(156543.03392 * Math.cos(geometry.lat0 * Math.PI / 180) / metresPerPixel)
    );
    zoom = clamp(zoom, 10, 17);

    var plan = null;
    while (zoom >= 10) {
      // Corners of the visible stage, walked back through the projection to lon/lat.
      var halfW = canvasWidth / 2 / view.scale;
      var halfH = canvasHeight / 2 / view.scale;
      var cosT = Math.cos(-geometry.theta);
      var sinT = Math.sin(-geometry.theta);
      var lons = [];
      var lats = [];
      [[-halfW, -halfH], [halfW, -halfH], [-halfW, halfH], [halfW, halfH]].forEach(
        function (corner) {
          var x = corner[0] + geometry.offsetX;
          var y = corner[1] + geometry.offsetY;
          // Undo the PCA rotation (the tiles live in unrotated lon/lat space).
          var ux = x * cosT + y * sinT;
          var uy = -x * sinT + y * cosT;
          lons.push(geometry.lon0 + ux / geometry.mPerLon);
          lats.push(geometry.lat0 + uy / M_PER_DEG_LAT);
        }
      );

      var x0 = Math.floor(lonToTile(Math.min.apply(Math, lons), zoom));
      var x1 = Math.ceil(lonToTile(Math.max.apply(Math, lons), zoom));
      var y0 = Math.floor(latToTile(Math.max.apply(Math, lats), zoom));
      var y1 = Math.ceil(latToTile(Math.min.apply(Math, lats), zoom));

      if ((x1 - x0) * (y1 - y0) <= MAX_TILES) {
        plan = { zoom: zoom, x0: x0, x1: x1, y0: y0, y1: y1 };
        break;
      }
      zoom -= 1;
    }
    return plan;
  }

  function loadTile(zoom, x, y, onLoad) {
    var key = zoom + '/' + x + '/' + y;
    if (tileCache[key]) {
      return tileCache[key];
    }
    var image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    // A missing basemap is cosmetic, so failures are recorded and never retried.
    image.onerror = function () { tileCache[key].failed = true; };
    image.onload = onLoad;
    image.src = TILE_URL.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    tileCache[key] = image;
    return image;
  }

  /* ---------- The scene ---------- */

  function buildScene(circuit, onDirty) {
    var canvas = document.getElementById('circuit-canvas');
    var section = document.getElementById('scene');
    if (!canvas || !section) {
      return null;
    }
    var ctx = canvas.getContext('2d');

    var geometry = null;
    var tilePlan = null;
    var canvasWidth = 0;
    var canvasHeight = 0;
    var dpr = 1;

    var markers = circuit.markers.concat(circuit.turns.map(function (turn) {
      return {
        type: 'turn',
        s: turn.s,
        n: turn.n,
        // Some circuits number a sequence as one corner with lettered parts:
        // the Hungaroring runs 1, 1A, 2 ... 12, 12A, 13.
        label: String(turn.n) + (turn.letter || ''),
        dir: turn.dir
      };
    })).sort(function (a, b) { return a.s - b.s; });

    var scratch = [0, 0, 0];
    var scratchB = [0, 0, 0];

    /*
     * How much of the lap has been drawn in, 0-1.
     *
     * This runs on a clock rather than on scroll: tying it to scroll position meant
     * a reader who never scrolled was left looking at an empty stage, when the point
     * of the opening frame is to show the circuit as a poster before anything moves.
     */
    var introStart = 0;
    var INTRO_MS = 1500;

    function introProgress() {
      if (reducedMotion || !introStart) {
        return 1;
      }
      return easeOut(clamp((Date.now() - introStart) / INTRO_MS, 0, 1));
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      var rect = canvas.getBoundingClientRect();
      canvasWidth = Math.max(rect.width, 1);
      canvasHeight = Math.max(rect.height, 1);
      canvas.width = Math.round(canvasWidth * dpr);
      canvas.height = Math.round(canvasHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      geometry = prepareGeometry(circuit, canvasHeight > canvasWidth * 1.15);
      tilePlan = null;
    }

    /*
     * Fit the circuit to the stage, leaving room for the title and the readout rail.
     *
     * The fit is measured rather than derived: the geometry is projected once at
     * unit scale and the resulting bounding box is what gets fitted. Yaw, tilt and
     * the perspective term interact in ways that are awkward to solve analytically,
     * and an approximation there leaves the drawing drifting off-centre or shrinking
     * away from the frame partway through the tilt.
     */
    function viewFor(progress) {
      var tilt = easeInOut(seg(progress, 0.15, 0.36)) * MAX_TILT;
      var yaw = easeInOut(seg(progress, 0.15, 0.62)) * MAX_YAW;

      /*
       * The rise travels around the lap rather than inflating all at once.
       *
       * Every point used to share one z scale, so the circuit swelled uniformly
       * and read as a drawing being scaled rather than a solid standing up. Giving
       * each point a phase offset by its position around the lap turns it into a
       * wave leaving start/finish and running to the flag, which is also the order
       * a reader would drive it in. RISE_SPREAD is how much of the scroll window
       * the wave occupies: the rest is the time any one point takes to stand up.
       */
      var raw = seg(progress, 0.36, 0.62);
      var zProgress = easeInOut(raw);
      var zAt = function (index, count) {
        var phase = (index / count) * RISE_SPREAD;
        return easeInOut(clamp((raw - phase) / (1 - RISE_SPREAD), 0, 1));
      };

      var padTop = canvasHeight * (canvasWidth < 700 ? 0.24 : 0.2);
      var padBottom = canvasHeight * 0.17;
      var padSide = canvasWidth * (canvasWidth < 700 ? 0.08 : 0.11);

      var availableWidth = canvasWidth - padSide * 2;
      var availableHeight = canvasHeight - padTop - padBottom;

      var unit = makeProjector({
        tilt: tilt, yaw: yaw, scale: 1, cx: 0, cy: 0, radius: geometry.radius
      });

      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      var probe = [0, 0, 0];
      for (var i = 0; i < geometry.count; i += 1) {
        // Both the track surface and the ground plane below it, since the ribbon
        // hangs between them and has to stay in frame too.
        for (var k = 0; k < 2; k += 1) {
          unit(geometry.xs[i], geometry.ys[i],
            k ? geometry.zs[i] * zAt(i, geometry.count) : 0, probe);
          if (probe[0] < minX) minX = probe[0];
          if (probe[0] > maxX) maxX = probe[0];
          if (probe[1] < minY) minY = probe[1];
          if (probe[1] > maxY) maxY = probe[1];
        }
      }

      var scale = Math.min(
        availableWidth / Math.max(maxX - minX, 1e-6),
        availableHeight / Math.max(maxY - minY, 1e-6)
      );

      return {
        tilt: tilt,
        yaw: yaw,
        // The aggregate, for the readouts and for anything that needs one number
        // for the rise as a whole; zAt is the per-point value the drawing uses.
        zProgress: zProgress,
        zRaw: raw,
        zAt: zAt,
        scale: scale,
        radius: geometry.radius,
        // Centre the measured box in the available area rather than the origin,
        // which is only the centroid and drifts once the track is tilted.
        cx: padSide + availableWidth / 2 - (minX + maxX) / 2 * scale,
        cy: padTop + availableHeight / 2 - (minY + maxY) / 2 * scale
      };
    }

    function drawTiles(project, alpha) {
      if (alpha <= 0.01 || !TILE_URL) {
        return;
      }
      if (!tilePlan) {
        tilePlan = planTiles(geometry, viewFor(0), canvasWidth, canvasHeight);
      }
      if (!tilePlan) {
        return;
      }

      var cosT = Math.cos(-geometry.theta);
      var sinT = Math.sin(-geometry.theta);

      /* lon/lat -> the same rotated, recentred metre space the track uses. */
      function place(lon, lat, out) {
        var ux = (lon - geometry.lon0) * geometry.mPerLon;
        var uy = (lat - geometry.lat0) * M_PER_DEG_LAT;
        return project(
          ux * cosT - uy * sinT - geometry.offsetX,
          ux * sinT + uy * cosT - geometry.offsetY,
          0,
          out
        );
      }

      ctx.save();
      ctx.globalAlpha = alpha * 0.85;
      var corner = [0, 0, 0];
      var right = [0, 0, 0];
      var down = [0, 0, 0];

      for (var tx = tilePlan.x0; tx < tilePlan.x1; tx += 1) {
        for (var ty = tilePlan.y0; ty < tilePlan.y1; ty += 1) {
          // Tiles arrive well after the first paint, and by then the render loop has
          // usually parked itself. onDirty wakes it so late tiles actually appear.
          var image = loadTile(tilePlan.zoom, tx, ty, onDirty);
          if (!image.complete || image.failed || !image.naturalWidth) {
            continue;
          }
          place(tileToLon(tx, tilePlan.zoom), tileToLat(ty, tilePlan.zoom), corner);
          place(tileToLon(tx + 1, tilePlan.zoom), tileToLat(ty, tilePlan.zoom), right);
          place(tileToLon(tx, tilePlan.zoom), tileToLat(ty + 1, tilePlan.zoom), down);

          var size = image.naturalWidth;
          ctx.setTransform(
            (right[0] - corner[0]) / size * dpr, (right[1] - corner[1]) / size * dpr,
            (down[0] - corner[0]) / size * dpr, (down[1] - corner[1]) / size * dpr,
            corner[0] * dpr, corner[1] * dpr
          );
          ctx.drawImage(image, 0, 0);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.restore();
    }

    /*
     * The elevation ribbon: one quad per track segment, from the ground plane up to
     * the track surface, painted back to front. Colour carries both height (base
     * charcoal to the circuit's accent at the crest) and depth (far walls darker),
     * which reads as a lit extrusion without needing per-quad gradients.
     */
    function drawRibbon(project, view) {
      if (view.zRaw <= 0.001) {
        return;
      }

      var count = geometry.count;
      var zs = geometry.zs;
      var xs = geometry.xs;
      var ys = geometry.ys;

      var order = new Array(count);
      var top = new Float64Array(count * 3);
      var base = new Float64Array(count * 2);
      var rise = new Float64Array(count);
      var postStride = Math.max(1, Math.round(POST_SPACING_M / (circuit.step || 15)));
      var i;

      for (i = 0; i < count; i += 1) {
        rise[i] = view.zAt(i, count);
        project(xs[i], ys[i], zs[i] * rise[i], scratch);
        top[i * 3] = scratch[0];
        top[i * 3 + 1] = scratch[1];
        top[i * 3 + 2] = scratch[2];
        project(xs[i], ys[i], 0, scratchB);
        base[i * 2] = scratchB[0];
        base[i * 2 + 1] = scratchB[1];
        order[i] = i;
      }

      // Painter's algorithm: the segment nearest the camera is drawn last.
      order.sort(function (a, b) {
        return (top[a * 3 + 2] + top[((a + 1) % count) * 3 + 2])
          - (top[b * 3 + 2] + top[((b + 1) % count) * 3 + 2]);
      });

      var maxZ = Math.max.apply(Math, geometry.zs) || 1;
      var minDepth = Infinity;
      var maxDepth = -Infinity;
      for (i = 0; i < count; i += 1) {
        if (top[i * 3 + 2] < minDepth) minDepth = top[i * 3 + 2];
        if (top[i * 3 + 2] > maxDepth) maxDepth = top[i * 3 + 2];
      }
      var depthSpan = Math.max(maxDepth - minDepth, 1);

      for (var k = 0; k < count; k += 1) {
        i = order[k];
        var j = (i + 1) % count;

        var heightFraction = (zs[i] / maxZ);
        var depthFraction = (top[i * 3 + 2] - minDepth) / depthSpan;

        /*
         * The wave's leading edge: brightest where a segment is halfway up, gone
         * once it has settled.
         *
         * Cubed rather than a plain half-sine. Enough of the lap is mid-rise at
         * once that the untouched curve lights all of it, which reads as "the part
         * that has risen is bright" instead of as a front moving through. Cubing
         * pulls the highlight into a band narrow enough to have a direction.
         */
        var t = rise[i];
        var heat = (t > 0.02 && t < 0.98) ? Math.pow(Math.sin(Math.PI * t), 3) : 0;

        var warmth = 0.06 + 0.5 * heightFraction;
        var shade = 0.45 + 0.55 * depthFraction;
        var r = Math.round(mix(mix(14, accent.deepRgb[0], warmth) * shade,
          accent.softRgb[0], heat * 0.35));
        var g = Math.round(mix(mix(16, accent.deepRgb[1], warmth) * shade,
          accent.softRgb[1], heat * 0.35));
        var b = Math.round(mix(mix(19, accent.deepRgb[2], warmth) * shade,
          accent.softRgb[2], heat * 0.35));

        var colour = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(base[i * 2], base[i * 2 + 1]);
        ctx.lineTo(base[j * 2], base[j * 2 + 1]);
        ctx.lineTo(top[j * 3], top[j * 3 + 1]);
        ctx.lineTo(top[i * 3], top[i * 3 + 1]);
        ctx.closePath();
        ctx.fill();
        // Adjacent quads share an edge, but antialiasing along it leaves a hairline
        // of background showing through. Stroking each quad in its own fill colour
        // covers the seam without changing the shape.
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        ctx.stroke();

        // The crest of the wall, lit while this segment is on its way up. The
        // colour mix alone is too quiet to read against the ribbon's own gradient;
        // it is this line along the top edge that makes the front visible.
        if (heat > 0.01) {
          ctx.strokeStyle = accent.soft;
          ctx.globalAlpha = heat * 0.75;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(top[i * 3], top[i * 3 + 1]);
          ctx.lineTo(top[j * 3], top[j * 3 + 1]);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        /*
         * A post every POST_SPACING_M, from the ground up to the track.
         *
         * Drawn here rather than in a pass of their own so they sort with the
         * ribbon: a post on the far side of the circuit has to be painted before
         * the near wall that hides it, or it shows through.
         */
        if (i % postStride === 0 && t > 0.02) {
          ctx.strokeStyle = accent.baseAt55;
          ctx.globalAlpha = 0.35 * t;
          ctx.beginPath();
          ctx.moveTo(base[i * 2], base[i * 2 + 1]);
          ctx.lineTo(top[i * 3], top[i * 3 + 1]);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    /* The track line itself. `drawFraction` lets it draw itself in at the open. */
    function drawTrack(project, view, drawFraction) {
      var count = geometry.count;
      var upTo = Math.max(2, Math.round(count * drawFraction));
      var zs = geometry.zs;

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.beginPath();
      for (var i = 0; i <= upTo; i += 1) {
        var index = i % count;
        project(geometry.xs[index], geometry.ys[index],
          zs[index] * view.zAt(index, count), scratch);
        if (i === 0) {
          ctx.moveTo(scratch[0], scratch[1]);
        } else {
          ctx.lineTo(scratch[0], scratch[1]);
        }
      }

      // A dark casing under the line keeps it readable where the track crosses
      // itself or runs over the ribbon behind it.
      ctx.strokeStyle = 'rgba(10,11,12,0.85)';
      ctx.lineWidth = 8.5;
      ctx.stroke();

      ctx.strokeStyle = accent.base;
      ctx.lineWidth = 4.5;
      ctx.stroke();

      ctx.strokeStyle = accent.softAt55;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    }

    /*
     * The lap's own outline, left lying on the ground plane as the track rises off
     * it.
     *
     * Tilt alone does not say how high anything is: without something at z = 0 to
     * measure against, a tall ribbon and a steeply tilted flat one look the same.
     * The footprint gives the height something to be measured from, and costs one
     * stroke.
     *
     * It is drawn lighter than the stage rather than darker. A literal shadow is
     * the obvious instinct and it is invisible here — the ground is already very
     * near black, so a dark mark on it lands within a few values of the background
     * and disappears. Reading it as a trace left on the floor rather than a shadow
     * cast onto it is what makes it show up at all.
     */
    function drawGroundShadow(project, view, alpha) {
      if (alpha <= 0.01) {
        return;
      }
      var count = geometry.count;

      ctx.save();
      ctx.globalAlpha = alpha;
      // Not supported everywhere, and a hard-edged shadow still reads correctly —
      // it just sits closer to being a second track than a shadow.
      if (typeof ctx.filter === 'string') {
        ctx.filter = 'blur(3px)';
      }
      ctx.beginPath();
      for (var i = 0; i <= count; i += 1) {
        project(geometry.xs[i % count], geometry.ys[i % count], 0, scratch);
        if (i === 0) {
          ctx.moveTo(scratch[0], scratch[1]);
        } else {
          ctx.lineTo(scratch[0], scratch[1]);
        }
      }
      ctx.strokeStyle = accent.baseAt42;
      ctx.lineWidth = 7;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }

    function drawChequered(x, y, angle) {
      var cell = 3.4;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      for (var row = 0; row < 3; row += 1) {
        for (var col = 0; col < 3; col += 1) {
          ctx.fillStyle = (row + col) % 2 === 0 ? '#f6f7f8' : '#111214';
          ctx.fillRect((col - 1.5) * cell, (row - 1.5) * cell, cell, cell);
        }
      }
      ctx.restore();
    }

    /*
     * Turn numbers and trackside markers, billboarded: positioned in 3D, drawn
     * upright. Labels are pushed away from the circuit's centre so they sit outside
     * the track the way they do on a printed circuit map.
     */
    function drawMarkers(project, view, progress) {
      if (progress <= 0.001) {
        return;
      }

      var count = geometry.count;
      var step = circuit.step || 15;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Boxes already committed this frame, so later labels can step further out
      // rather than stacking on top of earlier ones.
      var taken = [];

      function overlaps(box) {
        for (var t = 0; t < taken.length; t += 1) {
          var other = taken[t];
          if (box.x < other.x + other.w && box.x + box.w > other.x
            && box.y < other.y + other.h && box.y + box.h > other.y) {
            return true;
          }
        }
        return false;
      }

      for (var m = 0; m < markers.length; m += 1) {
        var marker = markers[m];

        // Stagger by position around the lap, so markers arrive in the order a car
        // would meet them rather than all at once.
        var order = m / Math.max(markers.length - 1, 1);
        var alpha = clamp((progress - order * 0.55) / 0.35, 0, 1);
        if (alpha <= 0.01) {
          continue;
        }

        var index = Math.round(marker.s / step) % count;
        if (index < 0) {
          index += count;
        }
        var x = geometry.xs[index];
        var y = geometry.ys[index];
        var z = geometry.zs[index] * view.zAt(index, count);
        project(x, y, z, scratch);
        var px = scratch[0];
        var py = scratch[1];

        var isTurn = marker.type === 'turn';
        // Pad on the number, not the label: '4A' is already two characters but
        // still wants to read as 04A alongside 03 and 05.
        var label = isTurn
          ? (marker.n < 10 ? '0' + marker.label : marker.label)
          : marker.label || '';

        ctx.globalAlpha = alpha;
        ctx.font = isTurn
          ? '600 11px "Chivo Mono", ui-monospace, monospace'
          : '500 8.5px "Chivo Mono", ui-monospace, monospace';

        if (marker.type === 'start-finish') {
          var heading = Math.atan2(
            geometry.ys[(index + 2) % count] - y,
            geometry.xs[(index + 2) % count] - x
          );
          drawChequered(px, py, -heading + view.yaw);
          continue;
        }

        // Step out along the track's own normal until the label finds clear air.
        var width = ctx.measureText(label).width;
        var height = isTurn ? 13 : 14;
        var lx = px;
        var ly = py;
        var box = null;
        for (var attempt = 0; attempt < 4; attempt += 1) {
          var metres = (isTurn ? 22 : 32) + attempt * 15;
          project(
            x + geometry.normalX[index] * metres / view.scale,
            y + geometry.normalY[index] * metres / view.scale,
            z,
            scratchB
          );
          lx = scratchB[0];
          ly = scratchB[1];
          box = { x: lx - width / 2 - 4, y: ly - height / 2, w: width + 8, h: height };
          if (!overlaps(box)) {
            break;
          }
        }
        taken.push(box);

        var dx = lx - px;
        var dy = ly - py;
        var length = Math.hypot(dx, dy) || 1;

        if (isTurn) {
          ctx.strokeStyle = 'rgba(236,238,240,0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + dx / length * 6, py + dy / length * 6);
          ctx.lineTo(lx - dx / length * 8, ly - dy / length * 8);
          ctx.stroke();

          ctx.fillStyle = '#f6f7f8';
          ctx.fillText(label, lx, ly);
        } else {
          ctx.fillStyle = accent.baseAt90;
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = accent.baseAt55;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(lx, ly);
          ctx.stroke();

          ctx.fillStyle = 'rgba(17,18,20,0.88)';
          ctx.fillRect(box.x, box.y, box.w, box.h);
          ctx.fillStyle = accent.soft;
          ctx.fillText(label, lx, ly);
        }
      }
      ctx.restore();
    }

    function render(progress) {
      if (!geometry) {
        return;
      }
      var view = viewFor(progress);
      var project = makeProjector(view);

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);

      drawTiles(project, 1 - seg(progress, 0.12, 0.26));
      drawGroundShadow(project, view, seg(progress, 0.30, 0.50));
      drawRibbon(project, view);
      drawTrack(project, view, introProgress());
      drawMarkers(project, view, seg(progress, 0.6, 0.9));

      updateReadouts(progress, view);
    }

    var lastElevationShown = -1;

    function updateReadouts(progress, view) {
      // The elevation figures count up as the ribbon rises, so the number and the
      // drawing always agree about how much relief is on screen.
      var shown = Math.round(geometry.elevRange * view.zProgress);
      if (shown !== lastElevationShown) {
        lastElevationShown = shown;
        setText('readout-elevation', shown + ' m');
      }

      var exaggerationCue = document.getElementById('cue-exaggeration');
      if (exaggerationCue) {
        exaggerationCue.classList.toggle('is-on', view.zProgress > 0.35);
      }
      setText('readout-exaggeration', '×' + geometry.exaggeration.toFixed(1));

      var hint = document.getElementById('scroll-hint');
      if (hint) {
        hint.classList.toggle('is-on', progress < 0.08);
      }
    }

    return {
      resize: resize,
      render: render,
      startIntro: function () { introStart = Date.now(); },
      introRunning: function () {
        return !reducedMotion && introStart && Date.now() - introStart < INTRO_MS;
      },
      section: section
    };
  }

  /* ---------- The flat elevation profile further down the page ---------- */

  function drawProfile(circuit) {
    var canvas = document.getElementById('profile-canvas');
    if (!canvas) {
      return;
    }
    var ctx = canvas.getContext('2d');

    function draw() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var rect = canvas.getBoundingClientRect();
      var w = rect.width;
      var h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      var elev = circuit.elev;
      var minElev = Math.min.apply(Math, elev);
      var maxElev = Math.max.apply(Math, elev);
      var range = Math.max(maxElev - minElev, 1);

      var padLeft = 44;
      var padRight = 12;
      var padTop = 16;
      var padBottom = 30;
      var plotW = w - padLeft - padRight;
      var plotH = h - padTop - padBottom;

      function px(i) { return padLeft + i / (elev.length - 1) * plotW; }
      function py(v) { return padTop + (1 - (v - minElev) / range) * plotH; }

      // Horizontal grid, labelled in real metres above sea level.
      ctx.font = '400 9px "Chivo Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(155,160,166,0.75)';
      ctx.strokeStyle = 'rgba(236,238,240,0.09)';
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (var g = 0; g <= 4; g += 1) {
        var value = minElev + range * g / 4;
        var y = py(value);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();
        ctx.fillText(Math.round(value) + ' m', padLeft - 8, y);
      }

      // Filled area under the profile.
      var gradient = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      gradient.addColorStop(0, accent.baseAt42);
      gradient.addColorStop(1, accent.baseAt02);
      ctx.beginPath();
      ctx.moveTo(px(0), padTop + plotH);
      for (var i = 0; i < elev.length; i += 1) {
        ctx.lineTo(px(i), py(elev[i]));
      }
      ctx.lineTo(px(elev.length - 1), padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.beginPath();
      for (i = 0; i < elev.length; i += 1) {
        ctx.lineTo(px(i), py(elev[i]));
      }
      ctx.strokeStyle = accent.base;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Turn ticks along the bottom axis.
      var step = circuit.step || 15;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '500 8px "Chivo Mono", ui-monospace, monospace';
      circuit.turns.forEach(function (turn) {
        var index = Math.round(turn.s / step);
        var x = px(index);
        ctx.strokeStyle = 'rgba(236,238,240,0.22)';
        ctx.beginPath();
        ctx.moveTo(x, padTop + plotH);
        ctx.lineTo(x, padTop + plotH + 5);
        ctx.stroke();
        // Skip every other label when they would collide.
        if (circuit.turns.length <= 14 || turn.n % 2 === 1) {
          ctx.fillStyle = 'rgba(155,160,166,0.85)';
          ctx.fillText(String(turn.n), x, padTop + plotH + 8);
        }
      });

      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(107,113,120,0.9)';
      ctx.fillText('START/FINISH', padLeft, padTop + plotH + 18);
      ctx.textAlign = 'right';
      ctx.fillText(
        (circuit.perimeter / 1000).toFixed(3) + ' KM',
        w - padRight, padTop + plotH + 18
      );
    }

    draw();
    window.addEventListener('resize', draw);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(draw);
    }
  }

  /* ---------- Page content ---------- */

  function fillPage(season, round, circuit, isNext) {
    var stats = round.stats || {};

    document.title = round.name + ' — ' + circuit.name + ' | jeremy.ie';
    setText('round-meta', 'Round ' + round.round + ' / ' + season.rounds.length
      + ' — ' + formatDate(round.date));

    // "Next up" is only true when the date picked this round. A circuit chosen from
    // the calendar is just itself, and may well already have been run.
    setText('circuit-eyebrow', (isNext ? 'Next up — ' : '')
      + 'Round ' + round.round + ' — ' + round.name);

    // With a circuit pinned, the masthead becomes the way back to whatever is
    // actually next — otherwise there is no route out of a hand-picked round.
    // Dropping the query off the current path rather than naming f1.html keeps
    // whichever spelling the visitor arrived on; see renderSeasonWall.
    var masthead = document.querySelector('.masthead');
    if (masthead && !isNext) {
      masthead.href = window.location.pathname;
    }
    setText('circuit-title', circuit.name);
    setText('circuit-sub', flagEmoji(circuit.country) + '  ' + circuit.location + ', '
      + round.country + ' — ' + (circuit.length / 1000).toFixed(3) + ' km'
      + (stats.laps ? ', ' + stats.laps + ' laps' : ''));

    setText('vital-length', (circuit.length / 1000).toFixed(3));
    // Distinct numbers, not entries: a lettered corner like the Hungaroring's 1A is
    // part of turn 1, so counting rows would report 16 turns where the circuit has 14.
    var numbers = {};
    for (var t = 0; t < circuit.turns.length; t += 1) {
      numbers[circuit.turns[t].n] = true;
    }
    setText('vital-turns', String(Object.keys(numbers).length));
    setText('vital-laps', stats.laps ? String(stats.laps) : '—');
    setText('vital-distance', stats.raceDistanceKm ? stats.raceDistanceKm.toFixed(1) : '—');
    setText('vital-elevation', String(Math.round(
      Math.max.apply(Math, circuit.elev) - Math.min.apply(Math, circuit.elev)
    )));
    setText('vital-firstgp', circuit.firstgp ? String(circuit.firstgp) : '—');

    setText('profile-note',
      'Sampled from the ' + circuit.elevationSource.toUpperCase()
      + ' digital elevation model every ' + (circuit.step || 15)
      + ' m along the racing line, then smoothed. Ticks mark provisional turn positions.');

    // Last winner.
    if (stats.lastWinner) {
      var winner = stats.lastWinner;
      setText('winner-name', winner.driver);
      setText('winner-sub', winner.constructor + ' — ' + winner.season + ' '
        + winner.raceName + (winner.grid ? ', from P' + winner.grid : ''));
      setText('winner-dt', 'Last winner here');
    } else {
      setText('winner-name', 'No history');
      setText('winner-sub', 'This circuit has never held a Grand Prix before.');
    }

    // Fastest lap of that race.
    if (stats.fastestLap) {
      var lap = stats.fastestLap;
      setText('fastest-time', lap.time);
      setText('fastest-sub', lap.driver + ', ' + lap.constructor
        + ' — lap ' + lap.lap + ' of the ' + lap.season + ' race'
        + (lap.speed ? ', ' + Math.round(parseFloat(lap.speed)) + ' km/h average' : ''));
    } else {
      setText('fastest-time', '—');
      setText('fastest-sub', 'No timed laps on record for this circuit.');
    }

    setText('races-held', stats.racesHeld ? String(stats.racesHeld) : '0');

    renderTally('tally-drivers', stats.mostWinsDrivers || []);
    renderTally('tally-constructors', stats.mostWinsConstructors || []);

    renderSchedule(round);
    renderSeasonWall(season, round);
  }

  function renderTally(id, entries) {
    var list = document.getElementById(id);
    if (!list) {
      return;
    }
    list.innerHTML = '';
    if (!entries.length) {
      var empty = document.createElement('li');
      empty.className = 'tally-name';
      empty.textContent = 'No wins recorded yet.';
      list.appendChild(empty);
      return;
    }
    var max = entries[0].wins;
    entries.forEach(function (entry, index) {
      var item = document.createElement('li');

      var name = document.createElement('span');
      name.className = 'tally-name';
      name.textContent = entry.name;

      var count = document.createElement('span');
      count.className = 'tally-count';
      count.textContent = entry.wins + (entry.wins === 1 ? ' win' : ' wins');

      // Scaled rather than sized: the bar grows on reveal, and animating a transform
      // does not lay the row out again on every frame the way animating width would.
      var bar = document.createElement('span');
      bar.className = 'tally-bar';
      bar.style.setProperty('--w', String(entry.wins / max));
      bar.style.setProperty('--d', String(index));

      item.appendChild(name);
      item.appendChild(count);
      item.appendChild(bar);
      list.appendChild(item);
    });
  }

  function renderSchedule(round) {
    var container = document.getElementById('schedule');
    if (!container) {
      return;
    }
    container.innerHTML = '';

    var labels = {
      fp1: 'Practice 1', fp2: 'Practice 2', fp3: 'Practice 3',
      sprintQualifying: 'Sprint Qualifying', sprint: 'Sprint',
      qualifying: 'Qualifying'
    };
    var order = ['fp1', 'sprintQualifying', 'fp2', 'sprint', 'fp3', 'qualifying'];
    var sessions = round.sessions || {};

    var rows = order.filter(function (key) { return sessions[key]; }).map(function (key) {
      return { name: labels[key], iso: sessions[key], isRace: false };
    });
    rows.push({ name: 'Grand Prix', iso: round.start, isRace: true });

    // Practice and qualifying can be listed out of order across sprint weekends;
    // sorting by the actual timestamp is the only reliable ordering.
    rows.sort(function (a, b) { return new Date(a.iso) - new Date(b.iso); });

    rows.forEach(function (row, index) {
      var element = document.createElement('div');
      element.className = 'schedule-row' + (row.isRace ? ' is-race' : '');
      element.style.setProperty('--d', String(index));

      var name = document.createElement('span');
      name.className = 'schedule-name';
      name.textContent = row.name;

      var day = document.createElement('span');
      day.className = 'schedule-day';
      day.textContent = formatDay(row.iso);

      var time = document.createElement('time');
      time.className = 'schedule-time';
      time.dateTime = row.iso;
      time.textContent = formatTime(row.iso);

      element.appendChild(name);
      element.appendChild(day);
      element.appendChild(time);
      container.appendChild(element);
    });

    setText('schedule-tz', 'Times shown in ' +
      (Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time zone') + '.');
  }

  /*
   * The season strip, which doubles as the circuit picker.
   *
   * Each round is a real link to ?circuit=<id> rather than a click handler: the page
   * reloads and re-reads the parameter, so a switch costs nothing in teardown — none
   * of the one-shot setup in run() has to be made re-runnable — and the rounds stay
   * shareable, bookmarkable and middle-clickable. The cost is a scroll reset per
   * switch, which is the accepted trade.
   *
   * `shownRound` is the round on screen, which is not necessarily the next one.
   *
   * The hrefs are query-only, which resolves against the current path and so leaves
   * it untouched. GitHub Pages serves this page at both /f1 and /f1.html, and the
   * sitemap points at /f1; naming the file here would have moved anyone who arrived
   * on the clean URL onto the other one the moment they picked a round. It also
   * keeps the page working under python3 -m http.server, which only resolves /f1.html.
   */
  function renderSeasonWall(season, shownRound) {
    var list = document.getElementById('wall');
    if (!list) {
      return;
    }
    list.innerHTML = '';
    var now = Date.now();
    var glyphs = [];

    season.rounds.forEach(function (round, index) {
      var item = document.createElement('li');
      var isShown = round.round === shownRound.round;
      if (isShown) {
        item.className = 'is-next';
      } else if (new Date(round.start).getTime() < now) {
        item.className = 'is-done';
      }

      var link = document.createElement('a');
      link.className = 'wall-link';
      link.href = '?circuit=' + encodeURIComponent(round.circuitId);
      if (isShown) {
        link.setAttribute('aria-current', 'page');
      }

      var label = document.createElement('span');
      label.className = 'wall-round';
      label.textContent = 'R' + round.round + '  ' + flagEmoji(round.geoId.slice(0, 2));

      // The outline is added later, once the silhouette file lands. Its box is
      // reserved now so the strip does not reflow when it does.
      var glyph = document.createElementNS(SVG_NS, 'svg');
      glyph.setAttribute('class', 'wall-glyph');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.style.setProperty('--d', String(index));
      glyphs.push({ svg: glyph, geoId: round.geoId });

      var name = document.createElement('span');
      name.className = 'wall-name';
      name.textContent = round.name;

      var meta = document.createElement('span');
      meta.className = 'wall-meta';
      meta.textContent = formatDate(round.date);

      link.appendChild(label);
      link.appendChild(glyph);
      link.appendChild(name);
      link.appendChild(meta);
      item.appendChild(link);
      list.appendChild(item);
    });

    // Bring the round on screen into view in the strip. Set directly rather than
    // scrolled smoothly: this runs long before the section is reached, and an
    // animation nobody is looking at is just work.
    var current = list.querySelector('.is-next');
    if (current) {
      list.scrollLeft = Math.max(0, current.offsetLeft - list.offsetLeft);
    }

    loadSilhouettes(season.season, glyphs, list);
  }

  /*
   * The outlines behind the season strip.
   *
   * Fetched after the scene is already running, so it never sits in front of first
   * paint, and entirely optional: if the file is missing the strip keeps its round
   * numbers, names and dates and simply has no drawings in it.
   *
   * Every circuit is drawn into ONE viewBox sized to the largest of them, in metres.
   * That shared frame is the whole point — it is what makes Monaco visibly smaller
   * than Spa instead of making all 23 circuits the same size. See silhouette_for()
   * in tools/build-f1-data.py for the matching half of this.
   */
  function loadSilhouettes(season, glyphs, list) {
    fetchJSON(DATA_DIR + 'silhouettes-' + season + '.json').then(function (data) {
      var circuits = data.circuits || {};

      var maxW = 0;
      var maxH = 0;
      glyphs.forEach(function (entry) {
        var shape = circuits[entry.geoId];
        if (shape) {
          maxW = Math.max(maxW, shape.w);
          maxH = Math.max(maxH, shape.h);
        }
      });
      if (!maxW || !maxH) {
        return;
      }

      // A little air so the widest circuit's stroke is not clipped by the viewBox.
      var boxW = maxW * 1.06;
      var boxH = maxH * 1.06;
      var viewBox = (-boxW / 2) + ' ' + (-boxH / 2) + ' ' + boxW + ' ' + boxH;

      glyphs.forEach(function (entry) {
        var shape = circuits[entry.geoId];
        if (!shape) {
          return;
        }
        entry.svg.setAttribute('viewBox', viewBox);
        entry.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        var path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', shape.d);
        entry.svg.appendChild(path);
        // getTotalLength needs the path laid out, which it now is.
        entry.svg.style.setProperty('--len', String(path.getTotalLength()));
      });

      drawWallOnReveal(list);
    }).catch(function () {
      /* No silhouettes: the strip still lists the season, which is the fallback. */
    });
  }

  /* Draw the outlines on when the strip first comes into view, staggered along it. */
  function drawWallOnReveal(list) {
    function draw() {
      var nodes = list.querySelectorAll('.wall-glyph');
      for (var i = 0; i < nodes.length; i += 1) {
        nodes[i].classList.add('is-drawn');
      }
    }

    if (reducedMotion || typeof IntersectionObserver !== 'function') {
      draw();
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          draw();
          observer.disconnect();
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    observer.observe(list);
  }

  function startCountdown(round) {
    // A hand-picked round can be one that has already been run, where counting down
    // to it is meaningless. Show when it was held instead of a stuck "Lights out".
    if (new Date(round.start).getTime() < Date.now()) {
      setText('readout-countdown', formatDate(round.date));
      var label = document.querySelector('.readout-lead .readout-label');
      if (label) {
        label.textContent = 'Race completed';
      }
      return;
    }

    function tick() {
      setText('readout-countdown', formatCountdown(new Date(round.start).getTime() - Date.now()));
    }
    tick();
    setInterval(tick, 30000);
  }

  /*
   * Best-effort refresh of the last winner.
   *
   * The vendored figures go stale the moment a race is run, and the build script is
   * only re-run by hand. One request per visitor is well inside Jolpica's per-IP
   * budget, and any failure leaves the shipped data on screen.
   */
  function refreshLastWinner(round) {
    if (!round.stats || !round.circuitId) {
      return;
    }
    var generated = new Date(round._generated || 0).getTime();
    if (Date.now() - generated < 3 * 86400000) {
      return;
    }

    fetchJSON('https://api.jolpi.ca/ergast/f1/circuits/' + round.circuitId
      + '/results/1/?format=json&limit=100')
      .then(function (payload) {
        var races = payload.MRData.RaceTable.Races;
        if (!races.length) {
          return;
        }
        var latest = races[races.length - 1];
        var known = round.stats.lastWinner;
        if (known && String(known.season) >= String(latest.season)) {
          return;
        }
        var result = latest.Results[0];
        setText('winner-name', result.Driver.givenName + ' ' + result.Driver.familyName);
        setText('winner-sub', result.Constructor.name + ' — ' + latest.season + ' '
          + latest.raceName + (result.grid ? ', from P' + result.grid : ''));
        setText('races-held', String(payload.MRData.total));
      })
      .catch(function () { /* the shipped figures stand */ });
  }

  /* ---------- Chrome ---------- */

  function setupChrome() {
    var header = document.getElementById('site-header');
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('site-nav');

    if (toggle && nav) {
      toggle.addEventListener('click', function () {
        var open = nav.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      nav.addEventListener('click', function (event) {
        if (event.target.tagName === 'A') {
          nav.classList.remove('is-open');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    }

    /*
     * Anchor clicks go through Lenis when it is driving, so the jump is part of the
     * same interpolation as everything else rather than a native jump fighting it.
     * Without Lenis this listener does nothing and the plain href takes over.
     */
    if (nav) {
      nav.addEventListener('click', function (event) {
        var link = event.target.closest ? event.target.closest('a[href^="#"]') : null;
        if (!link || !scroller) {
          return;
        }
        var target = document.querySelector(link.getAttribute('href'));
        if (target) {
          event.preventDefault();
          scroller.scrollTo(target, { offset: -HEADER_H });
          wake();
        }
      });
    }

    if (header) {
      // Kept out of the way over the opening frame, then brought in once the
      // circuit has had the screen to itself for a while.
      header.classList.add('is-hidden');
      var onScroll = function () {
        var scrolled = scroller ? scroller.scroll : (window.scrollY || window.pageYOffset);
        header.classList.toggle('is-hidden', scrolled < window.innerHeight * 0.7);
      };
      // Under Lenis the native scroll event still fires, but its own event is the
      // one in step with the interpolated position the scene is drawn at.
      if (scroller) {
        scroller.on('scroll', onScroll);
      } else {
        window.addEventListener('scroll', onScroll, { passive: true });
      }
      onScroll();
    }

    /*
     * Section reveals, the same way the homepage does them.
     *
     * Deliberately an observer rather than a scroll library: the schedule and
     * calendar are empty at this point and only get their rows once the season data
     * arrives. A library that caches trigger positions up front measures them at
     * zero height and never fires, leaving the filled lists invisible. An observer
     * re-evaluates when they grow.
     */
    var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

    function show(node) {
      node.classList.add('is-in');
      countUp(node);
    }

    if (reducedMotion) {
      reveals.forEach(show);
      return;
    }

    // A stagger index per direct child, so a group arrives as a sequence rather than
    // all at once. Set at reveal time, not up front: the schedule and the season
    // strip have no children until the season data lands.
    function stagger(node) {
      var children = node.children;
      for (var i = 0; i < children.length; i += 1) {
        if (!children[i].style.getPropertyValue('--d')) {
          children[i].style.setProperty('--d', String(i));
        }
      }
    }

    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            stagger(entry.target);
            show(entry.target);
            observer.unobserve(entry.target);
          }
        });
      }, { rootMargin: '0px 0px -12% 0px' });
      reveals.forEach(function (node) { observer.observe(node); });
    } else {
      reveals.forEach(show);
    }
  }

  /*
   * Count the ledger figures up as they arrive.
   *
   * Reads the value already on screen and counts to it, so the formatting written by
   * fillPage — decimal places, em dashes, "—" for a missing figure — is the single
   * source of truth and nothing here needs to know what any of these numbers mean.
   * Anything that does not parse as a number is left exactly as it is.
   */
  function countUp(root) {
    if (reducedMotion) {
      return;
    }
    var targets = root.querySelectorAll('[data-count]');
    for (var i = 0; i < targets.length; i += 1) {
      startCount(targets[i], i);
    }
  }

  function startCount(node, index) {
    var text = node.textContent.trim();
    var value = parseFloat(text);
    if (!isFinite(value) || node.dataset.counted) {
      return;
    }
    node.dataset.counted = '1';

    // Match the written precision so the digits do not jitter in width as it runs.
    var dot = text.indexOf('.');
    var places = dot === -1 ? 0 : text.length - dot - 1;
    var start = 0;
    var duration = 700;
    var delay = index * 70;

    function step(now) {
      if (!start) {
        start = now;
      }
      var t = clamp((now - start - delay) / duration, 0, 1);
      node.textContent = (value * easeOut(t)).toFixed(places);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        // Land on the original string, so any grouping or trailing zeroes survive.
        node.textContent = text;
      }
    }
    requestAnimationFrame(step);
  }

  function showError(message) {
    var box = document.getElementById('scene-error');
    if (!box) {
      return;
    }
    box.classList.add('is-on');

    // Opening the file straight off disk is the overwhelmingly likely cause: the
    // circuit data is fetched, and browsers refuse cross-origin fetches on file://.
    // Worth naming explicitly, because the failure otherwise looks like broken code.
    if (window.location.protocol === 'file:') {
      setText('scene-error-title', 'Needs a web server');
      setText('scene-error-body',
        'This page loads its circuit data with fetch(), which browsers block on '
        + 'file:// URLs. Run "python3 -m http.server 8000" in the site folder and '
        + 'open http://localhost:8000/f1.html instead.');
    }
    setText('scene-error-detail', message);
  }

  /* ---------- Round selection ---------- */

  /*
   * The next round is the first whose race start is still ahead of us. Once the
   * season is over there is nothing further to count down to, so the page holds on
   * the finale rather than showing an empty stage.
   */
  function pickRound(season) {
    var now = Date.now();
    for (var i = 0; i < season.rounds.length; i += 1) {
      if (new Date(season.rounds[i].start).getTime() + 3 * 3600000 > now) {
        return season.rounds[i];
      }
    }
    return season.rounds[season.rounds.length - 1];
  }

  /*
   * ?circuit=<id> pins the page to one round, using the same Jolpica circuit ids as
   * CIRCUIT_COLOURS. Without it — or with one that names nothing on this season's
   * calendar — the page stays date-driven, which is what /f1 on its own should be.
   */
  function roundFromQuery(season) {
    var wanted = new URLSearchParams(window.location.search).get('circuit');
    if (!wanted) {
      return null;
    }
    for (var i = 0; i < season.rounds.length; i += 1) {
      if (season.rounds[i].circuitId === wanted) {
        return season.rounds[i];
      }
    }
    return null;
  }

  function run(season, circuit, round, isNext) {
    // Before anything paints, so the first frame is already in the circuit's colour.
    applyAccent(round.circuitId);

    fillPage(season, round, circuit, isNext);
    drawProfile(circuit);
    startCountdown(round);
    round._generated = season.generated;
    refreshLastWinner(round);

    // Declared up front so buildScene can wake the render loop when a basemap tile
    // finishes loading; kick is only assigned once the loop exists below.
    var kick = function () {};
    var scene = buildScene(circuit, function () { kick(); });
    if (!scene) {
      return;
    }
    scene.resize();

    if (reducedMotion) {
      // No timeline: compose the finished frame once, with every marker present.
      scene.render(1);
      window.addEventListener('resize', function () {
        scene.resize();
        scene.render(1);
      });
      return;
    }

    var target = 0;
    var rendered = 0;
    var running = false;

    /*
     * Lenis already interpolates the scroll position, so the loop's own smoothing is
     * eased off when it is driving. Left at 0.14 the two lags stack and the scene
     * swims behind the page instead of feeling weighted to it.
     */
    var smoothing = scroller ? 0.28 : 0.14;

    function computeProgress() {
      var start = scene.section.offsetTop;
      var span = scene.section.offsetHeight - window.innerHeight;
      var scrolled = scroller ? scroller.scroll : (window.scrollY || window.pageYOffset);
      return clamp((scrolled - start) / Math.max(span, 1), 0, 1);
    }

    function frame(time) {
      // Lenis has no loop of its own unless autoRaf is set, and autoRaf never stops.
      // Driving it from this loop keeps one rAF on the page rather than two, and
      // lets both of them park together when nothing is moving.
      if (scroller) {
        scroller.raf(time);
        target = computeProgress();
      }

      rendered += (target - rendered) * smoothing;
      var settled = Math.abs(target - rendered) < 0.0004;
      if (settled) {
        rendered = target;
      }

      scene.render(rendered);

      // Stay awake while Lenis is still gliding, or its inertia stops the moment the
      // scene settles and the page halts mid-flick.
      if (settled && !scene.introRunning() && !(scroller && scroller.isScrolling)) {
        running = false;
      } else {
        requestAnimationFrame(frame);
      }
    }

    kick = function () {
      target = computeProgress();
      if (!running) {
        running = true;
        requestAnimationFrame(frame);
      }
    };
    // Now anything outside run() can restart the loop — see `wake` above.
    wake = kick;

    /*
     * Wake sources. The native scroll event covers scrollbar drags and anchor jumps;
     * the input events matter because once the loop has parked, Lenis's raf is no
     * longer being called, so a fresh wheel or key press has nothing to advance it.
     * These fire on the DOM event itself, which is what breaks that standstill.
     */
    window.addEventListener('scroll', kick, { passive: true });
    if (scroller) {
      ['wheel', 'touchstart', 'touchmove', 'keydown'].forEach(function (type) {
        window.addEventListener(type, kick, { passive: true });
      });
    }
    window.addEventListener('resize', function () {
      scene.resize();
      kick();
    });
    // Marker labels are measured with Chivo Mono; redraw once it is actually there.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { kick(); });
    }

    rendered = computeProgress();
    scene.startIntro();
    kick();
  }

  /* ---------- Scroll ---------- */

  function makeScroller() {
    // Optional by design: the script tag has no fallback, so if unpkg is blocked or
    // the SRI check fails, window.Lenis is simply absent and the page scrolls
    // natively. Reduced motion opts out of it outright.
    if (reducedMotion || typeof window.Lenis !== 'function') {
      return null;
    }
    return new window.Lenis({
      // A long ramp and a low lerp are what give the page its weight; anything
      // brisker and the inertia stops reading as deliberate.
      lerp: 0.075,
      wheelMultiplier: 0.9,
      // Touch devices already have inertia of their own. Doubling it up fights the
      // platform and makes the page feel like it is refusing to stop.
      syncTouch: false
    });
  }

  /* ---------- Boot ---------- */

  /*
   * The intro sequence.
   *
   * The overlay ships hidden in the markup, so if this script never runs, or the
   * visitor has asked for reduced motion, they simply never see it. Progress is
   * reported from the two fetches rather than run off a timer, and there is a hard
   * timeout underneath the whole thing: a stalled request must not be able to leave
   * a blank screen behind.
   */
  function makeIntro() {
    var node = document.getElementById('preload');
    var pathNode = document.getElementById('preload-path');
    var barNode = document.getElementById('preload-bar');
    var done = false;

    if (reducedMotion || !node || !pathNode) {
      return {
        progress: function () {},
        draw: function () {},
        finish: function () {}
      };
    }

    node.hidden = false;

    var shown = 0;
    var wanted = 0;
    var ticking = false;

    // The counter eases toward the true fraction rather than jumping to it, so a
    // fetch that resolves instantly still reads as a count rather than a flash.
    function tick() {
      shown += (wanted - shown) * 0.12;
      if (wanted - shown < 0.005) {
        shown = wanted;
      }
      setText('preload-count', Math.round(shown * 100) + '%');
      if (barNode) {
        barNode.style.setProperty('--p', String(shown));
      }
      if (shown < wanted) {
        requestAnimationFrame(tick);
      } else {
        ticking = false;
      }
    }

    function progress(fraction, snap) {
      wanted = Math.max(wanted, clamp(fraction, 0, 1));
      // The last step does not ease: the overlay starts fading on the same frame,
      // and easing toward 100 would hide it still showing 90-something.
      if (snap) {
        shown = wanted;
        setText('preload-count', Math.round(shown * 100) + '%');
        if (barNode) {
          barNode.style.setProperty('--p', String(shown));
        }
        return;
      }
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(tick);
      }
    }

    return {
      progress: progress,

      /*
       * Draw the lap on. The geometry is the same prepareGeometry() output the scene
       * is built from, so the outline the visitor watches being drawn is the one
       * that is about to tilt up underneath it, at the same orientation.
       */
      draw: function (circuit) {
        if (done) {
          return;
        }
        var geometry = prepareGeometry(circuit, false);
        var d = '';
        for (var i = 0; i < geometry.count; i += 2) {
          // SVG's y axis points down; negate so the lap is not drawn mirrored.
          d += (i ? 'L' : 'M') + geometry.xs[i].toFixed(1) + ' '
            + (-geometry.ys[i]).toFixed(1) + ' ';
        }
        pathNode.setAttribute('d', d + 'Z');

        var pad = geometry.radius * 1.12;
        document.getElementById('preload-glyph')
          .setAttribute('viewBox', (-pad) + ' ' + (-pad) + ' ' + (pad * 2) + ' ' + (pad * 2));

        var length = pathNode.getTotalLength();
        pathNode.style.strokeDasharray = length;
        pathNode.style.strokeDashoffset = length;
        // Force layout so the transition has a start value to move from.
        pathNode.getBoundingClientRect();
        pathNode.style.transition = 'stroke-dashoffset ' + INTRO_DRAW_MS + 'ms '
          + 'cubic-bezier(0.22, 1, 0.36, 1)';
        pathNode.style.strokeDashoffset = '0';

        setText('preload-status', circuit.name);
      },

      finish: function () {
        if (done) {
          return;
        }
        done = true;
        progress(1, true);
        node.classList.add('is-out');
        // Taken out of the accessibility tree once it has faded, so it is not a
        // focusable, screen-reader-visible layer sitting over the page forever.
        window.setTimeout(function () { node.hidden = true; }, 800);
      }
    };
  }

  function boot() {
    scroller = makeScroller();
    setupChrome();

    var intro = makeIntro();
    // The floor under the whole sequence. Whatever the fetches are doing, the
    // overlay comes down; the page underneath is readable with or without it.
    var failsafe = window.setTimeout(intro.finish, INTRO_MAX_MS);

    intro.progress(0.12);

    fetchJSON(DATA_DIR + 'season-' + SEASON + '.json')
      .then(function (season) {
        intro.progress(0.5);
        var next = pickRound(season);
        var round = roundFromQuery(season) || next;
        return fetchJSON(DATA_DIR + round.geoId + '.json').then(function (circuit) {
          intro.progress(0.9);
          intro.draw(circuit);

          // The scene is built underneath while the outline draws, so the sequence
          // costs the wait it is covering rather than adding to it.
          run(season, circuit, round, round === next);

          window.clearTimeout(failsafe);
          window.setTimeout(intro.finish, INTRO_DRAW_MS);
        });
      })
      .catch(function (error) {
        window.clearTimeout(failsafe);
        intro.finish();
        showError(error.message);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
