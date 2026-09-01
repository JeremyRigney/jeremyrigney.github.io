/*
 * jeremy.ie/speaking — the talk map.
 *
 * A hairline chart of every venue, drawn once behind the opening frame: graticule,
 * coastline, arcs out of Dublin, then the venues themselves. It is a background, so
 * it is deliberately quiet — nothing here is above --line except the venue discs, and
 * the whole thing sits under an opacity ramp set in speaking.css.
 *
 * Canvas rather than SVG. 1200-odd coastline points is a lot of DOM to hand the
 * layout engine for something purely decorative, and the draw-on wants a partial
 * stroke of an arbitrary polyline, which canvas does with one lineTo loop and SVG
 * does with getTotalLength() per path.
 *
 * No dependency and no build step. The coastline comes from assets/data/speaking/
 * land.json, built by tools/build-speaking-map.py from Natural Earth 110m.
 *
 * The whole sequence is gated on prefers-reduced-motion, read once below: one static
 * frame is painted and the loop never starts.
 */
(function () {
  'use strict';

  var DATA = 'assets/data/speaking/land.json';

  /*
   * The projection window, in degrees. Tighter than the bbox the build script keeps,
   * which is why land.json carries a margin: this can be re-framed without a rebuild.
   *
   * The east edge stops at 30 so Sofia and Plovdiv sit inside the frame rather than
   * on its lip; the west edge at -78 holds Massachusetts with room to spare. The
   * latitude band is chosen so Ireland — which every second venue is in — lands just
   * above the vertical centre, where the opening's type is thinnest.
   */
  var LON_MIN = -78;
  var LON_MAX = 30;
  var LAT_MIN = 33;
  var LAT_MAX = 62;

  /* The parallel the longitude scale is true at. See project(). */
  var LAT_REF = 50;

  /*
   * Venues, with the number of appearances at each. `n` drives the disc radius, so it
   * is the count of separate visits rather than of talks — Birr is one place visited
   * many times, and a disc scaled by talks alone would swallow Ireland whole.
   *
   * `label` is set only on the anchors. Every venue gets a disc; labelling all
   * thirteen turns the North Atlantic into a word search, and the three that carry a
   * name are the three that tell the story: home, the base, and the far capital.
   *
   * Massachusetts is deliberately not labelled even though it is the furthest point.
   * It projects to the far left of the frame, which is where the lead paragraph sits,
   * and "MASSACHUSETTS" set across a line of body copy is worse than no label at all.
   * Its arc reaches out of frame on its own and says the same thing.
   *
   * `ly` nudges a label off the baseline of its disc. Birr and Dublin are 1.65
   * degrees apart, which at this scale is 22 px — close enough that their labels
   * overprint each other. One goes above its disc and the other below.
   */
  var VENUES = [
    { name: 'Birr', lon: -7.91, lat: 53.10, n: 14, label: 'Birr', ly: 13 },
    { name: 'Dublin', lon: -6.26, lat: 53.35, n: 4, label: 'Dublin', ly: -11 },
    { name: 'Belfast', lon: -5.93, lat: 54.60, n: 2 },
    { name: 'Armagh', lon: -6.65, lat: 54.35, n: 2 },
    { name: 'Cork', lon: -8.47, lat: 51.90, n: 1 },
    { name: 'Galway', lon: -9.05, lat: 53.27, n: 1 },
    { name: 'London', lon: -0.13, lat: 51.51, n: 1, label: 'London' },
    { name: 'Warwick', lon: -1.56, lat: 52.38, n: 1 },
    { name: 'Toulouse', lon: 1.44, lat: 43.60, n: 1 },
    { name: 'Krakow', lon: 19.94, lat: 50.06, n: 1 },
    { name: 'Sofia', lon: 23.32, lat: 42.70, n: 2 },
    { name: 'Plovdiv', lon: 24.75, lat: 42.14, n: 1 },
    { name: 'Massachusetts', lon: -71.09, lat: 42.36, n: 1 }
  ];

  /*
   * The order the discs land in: smallest first, so the two big Irish ones arrive
   * last and the sequence finishes where the page's story is. Sorted once here
   * rather than per frame.
   */
  var ORDER = VENUES.slice().sort(function (a, b) { return a.n - b.n; });

  /* Where the arcs are thrown from. Dublin, not Birr — it is the stated base. */
  var ORIGIN = { lon: -6.26, lat: 53.35 };

  /*
   * Which venues get an arc. Only the ones abroad: an arc from Dublin to Birr is
   * 150 km drawn at four pixels and reads as a smudge, and the point of the arcs is
   * the reach out of Ireland.
   */
  var ARC_MIN_DEG = 6;

  /* Timings, in ms. The same ordering the homepage's intro glyph uses: the shape
     first, then what sits on it. */
  var COAST_MS = 1500;
  var ARC_MS = 900;
  var ARC_START = 900;
  var ARC_GAP = 90;
  var DOT_MS = 520;
  var DOT_START = 1500;
  var DOT_GAP = 70;

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* The site's easing, as a function rather than as a cubic-bezier string. */
  function ease(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function clamp01(t) {
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }

  function main() {
    var canvas = document.getElementById('talk-map');
    if (!canvas || !canvas.getContext) {
      return;
    }

    var ctx = canvas.getContext('2d');
    var land = null;
    var started = 0;
    var running = false;

    /* Set by size(), read by project(). In CSS pixels. */
    var w = 0;
    var h = 0;

    /*
     * Equirectangular with the longitude axis compressed by cos(LAT_REF), which is
     * the standard plate carrée trick: without it Ireland is stretched half again as
     * wide as it is tall and reads as wrong to anyone who knows the shape. A real
     * conic would be better still and is not worth 40 lines for a background.
     *
     * The scale is the smaller of the two fits, so the whole window is always visible
     * and the map is centred in whatever aspect the frame happens to be.
     */
    var kx = 0;
    var ky = 0;
    var ox = 0;
    var oy = 0;

    function fit() {
      var lonSpan = (LON_MAX - LON_MIN) * Math.cos(LAT_REF * Math.PI / 180);
      var latSpan = LAT_MAX - LAT_MIN;

      /*
       * Contain, not cover. The point of this map is the spread — Massachusetts at one
       * end and Plovdiv at the other — and covering a 16:9 frame at this window's
       * aspect crops both off the edges, leaving a zoomed view of the Irish Sea that
       * says nothing. Containing it letterboxes instead, which costs nothing: the map
       * is faint and masked, so its unused band reads as ground, not as dead space.
       */
      var scale = Math.min(w / lonSpan, h / latSpan);

      /*
       * Except on a narrow frame, where containing the full 108 degrees leaves the map
       * a 150px ribbon across the middle of a phone screen. Below MIN_FILL of the
       * frame height it scales up and lets the longitude edges crop — on a phone the
       * map is texture rather than a chart (speaking.css dims it and drops the key),
       * so losing the far ends there is the right trade.
       */
      var MIN_FILL = 0.55;
      scale = Math.max(scale, (h * MIN_FILL) / latSpan);

      kx = scale * Math.cos(LAT_REF * Math.PI / 180);
      ky = scale;
      ox = w / 2 - (LON_MIN + LON_MAX) / 2 * kx;
      oy = h / 2 + (LAT_MIN + LAT_MAX) / 2 * ky;
    }

    function px(lon) {
      return ox + lon * kx;
    }

    function py(lat) {
      return oy - lat * ky;
    }

    /*
     * A device-pixel-ratio-aware resize. The canvas is sized in device pixels and
     * scaled back down in CSS, then the context is scaled so every draw call below
     * can work in CSS pixels and stay readable.
     */
    function size() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      if (!w || !h) {
        return false;
      }
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fit();
      return true;
    }

    /* ---------- Drawing ---------- */

    /*
     * The graticule, every 10 degrees. Drawn under everything at a third of the
     * coastline's weight — it is there to say "this is a chart", not to be read, and
     * at full strength it competes with the land for attention.
     */
    function drawGraticule(alpha) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(236, 238, 240, 0.05)';
      ctx.lineWidth = 1;

      var lon;
      for (lon = Math.ceil(LON_MIN / 10) * 10; lon <= LON_MAX; lon += 10) {
        ctx.beginPath();
        ctx.moveTo(px(lon), py(LAT_MAX));
        ctx.lineTo(px(lon), py(LAT_MIN));
        ctx.stroke();
      }

      var lat;
      for (lat = Math.ceil(LAT_MIN / 10) * 10; lat <= LAT_MAX; lat += 10) {
        ctx.beginPath();
        ctx.moveTo(px(LON_MIN), py(lat));
        ctx.lineTo(px(LON_MAX), py(lat));
        ctx.stroke();
      }

      ctx.restore();
    }

    /*
     * The coastline, revealed as a fraction of total length rather than per-ring: a
     * per-ring reveal finishes every short run instantly and leaves the two long
     * seaboards crawling, which reads as three separate animations. Measuring the
     * whole set first and spending one budget across it makes it one sweep.
     */
    function drawCoast(progress) {
      if (!land) {
        return;
      }

      ctx.save();
      ctx.strokeStyle = 'rgba(236, 238, 240, 0.17)';
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      var budget = progress * land.total;

      for (var r = 0; r < land.rings.length; r += 1) {
        if (budget <= 0) {
          break;
        }

        var ring = land.rings[r];
        var lengths = land.lengths[r];

        ctx.beginPath();
        ctx.moveTo(px(ring[0][0]), py(ring[0][1]));

        for (var i = 1; i < ring.length; i += 1) {
          var seg = lengths[i - 1];
          if (budget >= seg) {
            ctx.lineTo(px(ring[i][0]), py(ring[i][1]));
            budget -= seg;
          } else {
            /* Part-way along the last segment, so the line ends mid-stride rather
               than snapping to the next vertex. */
            var t = budget / seg;
            ctx.lineTo(
              px(ring[i - 1][0] + (ring[i][0] - ring[i - 1][0]) * t),
              py(ring[i - 1][1] + (ring[i][1] - ring[i - 1][1]) * t)
            );
            budget = 0;
            break;
          }
        }

        ctx.stroke();
      }

      ctx.restore();
    }

    /*
     * An arc from Dublin to a venue, bowed toward the pole. A straight line between
     * two points on this projection is not wrong so much as dull; the bow is what
     * makes a set of them read as routes rather than as a starburst. The sag is
     * proportional to span, so short hops stay nearly flat.
     */
    function drawArc(venue, progress) {
      if (progress <= 0) {
        return;
      }

      var x0 = px(ORIGIN.lon);
      var y0 = py(ORIGIN.lat);
      var x1 = px(venue.lon);
      var y1 = py(venue.lat);
      var mx = (x0 + x1) / 2;
      var my = (y0 + y1) / 2;
      var dist = Math.hypot(x1 - x0, y1 - y0);

      /* Control point lifted perpendicular to the chord, always upward on screen. */
      var cx = mx;
      var cy = my - dist * 0.18;

      ctx.save();
      /*
       * Heavier than the coastline, and deliberately so: the arcs are the only part
       * of this map carrying an argument, and on the page they run out under the
       * headline where both the frame mask and the copy scrim are eating into them.
       */
      ctx.strokeStyle = 'rgba(126, 156, 137, 0.55)';
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);

      /* Walked rather than handed to quadraticCurveTo, because it has to be able to
         stop part-way through for the draw-on. The step count scales with how much
         of the curve is being drawn, so the resolution per screen-pixel is constant
         and a barely-started arc does not cost 48 lineTo calls to render as a dot. */
      var steps = Math.max(2, Math.round(48 * progress));
      for (var s = 1; s <= steps; s += 1) {
        var t = (s / steps) * progress;
        var u = 1 - t;
        ctx.lineTo(
          u * u * x0 + 2 * u * t * cx + t * t * x1,
          u * u * y0 + 2 * u * t * cy + t * t * y1
        );
      }

      ctx.stroke();
      ctx.restore();
    }

    /*
     * A venue. The disc is scaled by the square root of the visit count, not by the
     * count: area is what the eye reads as quantity, so scaling the radius linearly
     * would make Birr look four times the weight it is.
     */
    function drawVenue(venue, progress) {
      if (progress <= 0) {
        return;
      }

      var x = px(venue.lon);
      var y = py(venue.lat);
      var r = (2.1 + Math.sqrt(venue.n) * 1.5) * progress;

      ctx.save();

      /* A halo under the larger venues, so Birr and Dublin separate from the
         coastline they sit on top of. */
      if (venue.n > 3) {
        var halo = ctx.createRadialGradient(x, y, 0, x, y, r * 4.5);
        halo.addColorStop(0, 'rgba(126, 156, 137, ' + (0.20 * progress) + ')');
        halo.addColorStop(1, 'rgba(126, 156, 137, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, r * 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = 'rgba(126, 156, 137, ' + (0.9 * progress) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      if (venue.label) {
        ctx.globalAlpha = progress;
        ctx.fillStyle = 'rgba(155, 161, 166, 0.85)';
        ctx.font = '500 9px "Chivo Mono", "Courier New", monospace';
        ctx.textBaseline = 'middle';
        /* Labels sit to the right except where that would run them off the edge. */
        var pad = r + 7;
        if (x + pad + ctx.measureText(venue.label.toUpperCase()).width > w - 8) {
          ctx.textAlign = 'right';
          pad = -pad;
        } else {
          ctx.textAlign = 'left';
        }
        ctx.fillText(venue.label.toUpperCase(), x + pad, y + (venue.ly || 0));
      }

      ctx.restore();
    }

    function frame(elapsed) {
      ctx.clearRect(0, 0, w, h);

      var coast = ease(clamp01(elapsed / COAST_MS));
      drawGraticule(coast);
      drawCoast(coast);

      var i;
      var arcIndex = 0;
      for (i = 0; i < VENUES.length; i += 1) {
        var v = VENUES[i];
        if (Math.hypot(v.lon - ORIGIN.lon, v.lat - ORIGIN.lat) < ARC_MIN_DEG) {
          continue;
        }
        drawArc(v, ease(clamp01(
          (elapsed - ARC_START - arcIndex * ARC_GAP) / ARC_MS
        )));
        arcIndex += 1;
      }

      for (i = 0; i < ORDER.length; i += 1) {
        drawVenue(ORDER[i], ease(clamp01(
          (elapsed - DOT_START - i * DOT_GAP) / DOT_MS
        )));
      }
    }

    var TOTAL = Math.max(
      COAST_MS,
      ARC_START + VENUES.length * ARC_GAP + ARC_MS,
      DOT_START + VENUES.length * DOT_GAP + DOT_MS
    );

    function tick(now) {
      var elapsed = now - started;
      frame(elapsed);
      if (elapsed < TOTAL) {
        requestAnimationFrame(tick);
      } else {
        running = false;
        /* One last frame at exactly the end state, so a dropped final frame can
           never leave a disc a pixel short of full size. */
        frame(TOTAL);
      }
    }

    function play() {
      if (!size()) {
        return;
      }
      if (reducedMotion) {
        frame(TOTAL);
        return;
      }
      started = performance.now();
      running = true;
      requestAnimationFrame(tick);
    }

    /*
     * Resize repaints the finished state rather than replaying: an animation that
     * restarts every time a phone's address bar collapses is a distraction, and on
     * desktop the frame is often resized long after the sequence has ended.
     */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        if (!size()) {
          return;
        }
        if (!running) {
          frame(TOTAL);
        }
      }, 150);
    });

    /* Precompute segment lengths in projected space is not possible before fit(), so
       lengths are measured in degrees instead. The ratio between a degree of
       longitude and one of latitude is fixed by the projection, so a length measured
       this way is proportional to the on-screen one and the sweep stays even. */
    function measure(rings) {
      var kxDeg = Math.cos(LAT_REF * Math.PI / 180);
      var lengths = [];
      var total = 0;
      for (var r = 0; r < rings.length; r += 1) {
        var ring = rings[r];
        var segs = [];
        for (var i = 1; i < ring.length; i += 1) {
          var dx = (ring[i][0] - ring[i - 1][0]) * kxDeg;
          var dy = ring[i][1] - ring[i - 1][1];
          var d = Math.hypot(dx, dy);
          segs.push(d);
          total += d;
        }
        lengths.push(segs);
      }
      return { rings: rings, lengths: lengths, total: total };
    }

    /*
     * The coastline is a nicety, not the content: if the fetch fails the venues and
     * arcs still draw over the graticule and the frame still works. That is why play()
     * is called from both branches.
     */
    fetch(DATA)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('land.json ' + response.status);
        }
        return response.json();
      })
      .then(function (rings) {
        land = measure(rings);
        canvas.parentNode.classList.add('is-ready');
        play();
      })
      .catch(function () {
        canvas.parentNode.classList.add('is-ready');
        play();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
