/*
 * jeremy.ie — a ship heading for the galaxy.
 *
 * Once per page load, a few seconds after the opening frame has settled, a small ship
 * comes up from the bottom of the screen beneath the View CV button, climbs, and dwindles
 * into the core of the galaxy. Then it is gone and nothing here runs again.
 *
 * The ship is a little inline SVG seen from above: a needle hull, swept wings, a teal
 * canopy and two engines with flickering exhaust. Its engine trail and the glint where it
 * vanishes are drawn on a canvas the size of the frame, which exists only for the flight.
 * Both sit above the copy (z-index 2), so it flies over anything in its way. It takes no
 * pointer events, so nothing under it stops being clickable.
 *
 * The flight is a quadratic Bézier from the bottom edge to the galaxy's core, which is read
 * from home-galaxy.js (window.JRGalaxy.core) on every frame, so it lands in the right place
 * at every breakpoint. The ship moves fast at first and slows as it shrinks, which is what
 * makes it read as going away from the viewer rather than just getting smaller.
 *
 * Skipped under prefers-reduced-motion, and if the opening frame is not on screen when the
 * time comes: it is a one-off, not something to wait around for.
 *
 * Loaded separately on purpose, like home-sky.js: it is decoration, and if it throws,
 * nothing else may go with it. Hidden from assistive tech.
 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion || !window.requestAnimationFrame) {
    return;
  }

  var frame = document.querySelector('.opening');
  if (!frame) {
    return;
  }
  var root = document.documentElement;

  /* ---------- Tunables ---------- */

  var DELAY_MS = 3000; // after load, or after the loading sequence lets go of the page
  var FLIGHT_MS = 2400; // edge of the screen to the core
  var GLINT_MS = 700; // the flash where it vanishes
  var END_SCALE = 0.05; // how small the ship is when it reaches the core
  var TRAIL_MS = 420; // how much of the past path the engine trail shows
  var SHIP_W = 46; // CSS px, nose to the end of the exhaust, at full size
  var SHIP_W_SMALL = 36; // on a phone
  var RETRIES = 6; // if the galaxy has not placed its core yet, try again this often
  var RETRY_MS = 500;

  // The SVG's own geometry. The ship points along +x; ANCHOR_X is the point that follows
  // the path, and TAIL_X is where the engines are, which is where the trail starts.
  var VIEW_W = 84;
  var VIEW_H = 28;
  var ANCHOR_X = 54;
  var TAIL_X = 22;

  /* ---------- Helpers ---------- */

  function readRgb(name, fallback) {
    var raw = '';
    try {
      raw = getComputedStyle(frame).getPropertyValue(name);
    } catch (e) { /* fall through */ }
    var parts = String(raw).split(',').map(function (s) { return parseInt(s, 10); });
    return parts.length === 3 && parts.every(function (n) { return n >= 0 && n <= 255; })
      ? parts
      : fallback;
  }

  function rgb(c) { return c[0] + ',' + c[1] + ',' + c[2]; }

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // A point on, and the direction of, a quadratic Bézier, one axis at a time.
  function bez(a, b, c, u) {
    var v = 1 - u;
    return v * v * a + 2 * v * u * b + u * u * c;
  }

  function bezD(a, b, c, u) {
    return 2 * (1 - u) * (b - a) + 2 * u * (c - b);
  }

  /* ---------- The ship ---------- */

  var SHIP_SVG =
    '<svg class="ship" viewBox="0 0 ' + VIEW_W + ' ' + VIEW_H + '" focusable="false">'
    + '<defs>'
    + '<linearGradient id="jr-ship-hull" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#f6f4ec"/>'
    + '<stop offset="0.5" stop-color="#d3dbd1"/>'
    + '<stop offset="1" stop-color="#6e8a78"/>'
    + '</linearGradient>'
    + '<linearGradient id="jr-ship-flame" x1="1" y1="0" x2="0" y2="0">'
    + '<stop offset="0" stop-color="#ffffff"/>'
    + '<stop offset="0.25" class="ship-teal-stop" stop-opacity="0.95"/>'
    + '<stop offset="1" class="ship-teal-stop" stop-opacity="0"/>'
    + '</linearGradient>'
    + '<linearGradient id="jr-ship-canopy" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#d8fff8"/>'
    + '<stop offset="1" class="ship-teal-stop"/>'
    + '</linearGradient>'
    + '</defs>'
    // Exhaust, behind everything; it flickers (see .ship-flames in home-coal.css).
    + '<g class="ship-flames">'
    + '<path d="M24 10.4 L2 11.9 L24 13.2 Z" fill="url(#jr-ship-flame)"/>'
    + '<path d="M24 14.8 L2 16.1 L24 17.6 Z" fill="url(#jr-ship-flame)"/>'
    + '</g>'
    // Swept wings, the far one a shade darker so the hull reads as lit from above.
    + '<path d="M52 11 L34 1.4 L27 1.4 L33 10.6 Z" fill="#8eac98" class="ship-edge"/>'
    + '<path d="M52 17 L34 26.6 L27 26.6 L33 17.4 Z" fill="#5d7666" class="ship-edge"/>'
    + '<rect x="27.5" y="0.6" width="6" height="1.2" class="ship-teal"/>'
    + '<rect x="27.5" y="26.2" width="6" height="1.2" class="ship-teal"/>'
    // Needle hull, engine pods, canopy, a running light down the spine. The hull and wings
    // have a dark edge (.ship-edge) so the ship still reads where it crosses the white type.
    + '<path d="M83.5 14 C72 11.2 58 9.6 40 9.8 L24 10.3 L21.5 12 L21.5 16 L24 17.7 L40 18.2 C58 18.4 72 16.8 83.5 14 Z" fill="url(#jr-ship-hull)" class="ship-edge"/>'
    + '<rect x="21.5" y="10.2" width="6" height="3" rx="0.8" fill="#38443d"/>'
    + '<rect x="21.5" y="14.8" width="6" height="3" rx="0.8" fill="#38443d"/>'
    + '<ellipse cx="60" cy="13.6" rx="7.5" ry="2.2" fill="url(#jr-ship-canopy)"/>'
    + '<path d="M30 14 L48 14" stroke-width="0.7" class="ship-teal-line"/>'
    + '</svg>';

  /* ---------- Flight ---------- */

  function fly(rect) {
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var narrow = w < 700;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    var teal = readRgb('--galaxy-teal-rgb', [72, 190, 176]);

    var layer = document.createElement('div');
    layer.className = 'ship-layer';
    layer.setAttribute('aria-hidden', 'true');

    var canvas = document.createElement('canvas');
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (ctx) {
      layer.appendChild(canvas);
    }

    layer.insertAdjacentHTML('beforeend', SHIP_SVG);
    var ship = layer.lastChild;
    var shipW = narrow ? SHIP_W_SMALL : SHIP_W;
    var shipH = shipW * VIEW_H / VIEW_W;
    var ox = shipW * ANCHOR_X / VIEW_W;
    var oy = shipH / 2;
    var tailOff = shipW * (TAIL_X - ANCHOR_X) / VIEW_W; // negative: behind the anchor
    ship.setAttribute('width', shipW.toFixed(1));
    ship.setAttribute('height', shipH.toFixed(1));
    ship.style.transformOrigin = ox.toFixed(1) + 'px ' + oy.toFixed(1) + 'px';

    frame.appendChild(layer);

    /*
     * Enter from the bottom of the screen, directly beneath the View CV button, and climb
     * toward the galaxy. The control point sits a little under the button, so the ship
     * rises almost straight up at first, then bends over and heads up and right into the
     * core. On a phone the core is lower than the button, so the climb is shorter and the
     * turn comes sooner; the control point is kept below the core so it never overshoots
     * and drops back down into it.
     */
    var core0 = window.JRGalaxy.core();
    var cta = frame.querySelector('.cta-lead');
    var bx = w * 0.12;
    var by = h * 0.6;
    if (cta) {
      var br = cta.getBoundingClientRect();
      if (br.width > 0) {
        bx = br.left + br.width / 2 - rect.left;
        by = br.bottom - rect.top;
      }
    }
    var x0 = Math.max(shipW / 2, bx);
    var y0 = Math.min(h, window.innerHeight - rect.top) + shipW * 0.6;
    var x1 = x0 + (core0.x - x0) * 0.1;
    var y1 = Math.max(by + 30, core0.y + (y0 - core0.y) * 0.15);

    var trail = [];
    var start = 0;
    var glintAt = -1;

    function step(now) {
      if (!start) { start = now; }
      var ms = now - start;
      var t = Math.min(1, ms / FLIGHT_MS);

      var core = window.JRGalaxy.core();
      var x2 = core.x, y2 = core.y;

      // Fast across the copy, slower as it recedes; the shrink speeds up instead.
      var u = 1 - Math.pow(1 - t, 2.2);
      var s = Math.pow(END_SCALE, Math.pow(t, 1.5));
      var alpha = 1 - smoothstep(0.82, 1, t);

      var x = bez(x0, x1, x2, u);
      var y = bez(y0, y1, y2, u);
      var a = Math.atan2(bezD(y0, y1, y2, u), bezD(x0, x1, x2, u));

      ship.style.opacity = alpha.toFixed(3);
      ship.style.transform = 'translate3d(' + (x - ox).toFixed(2) + 'px,' + (y - oy).toFixed(2)
        + 'px,0) rotate(' + a.toFixed(4) + 'rad) scale(' + s.toFixed(4) + ')';

      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';

        // The engine trail: the last TRAIL_MS of the engines' path, fading with age and
        // thinning with distance.
        if (t < 1) {
          trail.push({
            x: x + Math.cos(a) * tailOff * s,
            y: y + Math.sin(a) * tailOff * s,
            s: s,
            t: ms
          });
        }
        while (trail.length && ms - trail[0].t > TRAIL_MS) {
          trail.shift();
        }
        ctx.lineCap = 'butt';
        for (var k = 1; k < trail.length; k++) {
          var p = trail[k - 1], q = trail[k];
          var fade = 1 - (ms - q.t) / TRAIL_MS;
          ctx.globalAlpha = Math.max(0, fade) * 0.55 * alpha;
          ctx.strokeStyle = 'rgb(' + rgb(teal) + ')';
          ctx.lineWidth = Math.max(0.6, 3.2 * q.s * fade);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }

        // The glint as it disappears into the core, in the supernova's style but small.
        if (t > 0.9 && glintAt < 0) { glintAt = ms; }
        if (glintAt >= 0) {
          var g = Math.min(1, (ms - glintAt) / GLINT_MS);
          var L = Math.sin(Math.PI * g);
          var r = 2 + 10 * L;
          var grad = ctx.createRadialGradient(x2, y2, 0, x2, y2, r);
          grad.addColorStop(0, 'rgba(255,255,255,' + (0.95 * L).toFixed(3) + ')');
          grad.addColorStop(0.3, 'rgba(' + rgb(teal) + ',' + (0.5 * L).toFixed(3) + ')');
          grad.addColorStop(1, 'rgba(' + rgb(teal) + ',0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = grad;
          ctx.fillRect(x2 - r, y2 - r, r * 2, r * 2);

          var spike = 9 * L;
          ctx.globalAlpha = 0.6 * L;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 0.75;
          ctx.beginPath();
          ctx.moveTo(x2 - spike, y2); ctx.lineTo(x2 + spike, y2);
          ctx.moveTo(x2, y2 - spike); ctx.lineTo(x2, y2 + spike);
          ctx.stroke();
        }
      }

      if (ms < FLIGHT_MS + GLINT_MS) {
        window.requestAnimationFrame(step);
      } else if (layer.parentNode) {
        layer.parentNode.removeChild(layer);
      }
    }

    window.requestAnimationFrame(step);
  }

  /* ---------- When ---------- */

  var tries = 0;

  function launch() {
    // A background tab would freeze the flight half way. Wait until it is looked at.
    if (document.hidden) {
      var onVisible = function () {
        if (!document.hidden) {
          document.removeEventListener('visibilitychange', onVisible);
          window.setTimeout(launch, 800);
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      return;
    }

    // Only if the opening frame is still mostly on screen.
    var rect = frame.getBoundingClientRect();
    if (rect.height <= 0 || rect.top < -rect.height * 0.4 || rect.top > window.innerHeight * 0.5) {
      return;
    }

    var core = window.JRGalaxy && window.JRGalaxy.core && window.JRGalaxy.core();
    if (!core || !core.ready) {
      if (tries++ < RETRIES) { window.setTimeout(launch, RETRY_MS); }
      return;
    }

    fly(rect);
  }

  var scheduled = false;

  function schedule() {
    if (scheduled) { return; }
    scheduled = true;
    window.setTimeout(launch, DELAY_MS);
  }

  /*
   * While the loading sequence is running, the clock starts when it lets go of the page
   * (the head script in index.html sends intro:release on every way out, watchdogs
   * included), so the ship flies after the headline has risen rather than behind the stage.
   */
  if (root.classList.contains('intro') && !root.hasAttribute('data-intro-revealed')) {
    document.addEventListener('intro:release', schedule);
  } else if (document.readyState === 'complete') {
    schedule();
  } else {
    window.addEventListener('load', schedule);
  }
})();
