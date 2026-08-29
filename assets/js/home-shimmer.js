/*
 * jeremy.ie — the shimmer in the opening frame.
 *
 * A field of etched contour lines over an iridescent ground, after the anodised
 * "damascus" finish on a laptop skin: the etching is fixed in the metal and only the
 * colour moves, sweeping as you change the viewing angle.
 *
 * There are two clocks, and neither of them touches the field.
 *
 * The field is a domain-warped noise value per pixel, quantised to a byte of phase. It
 * is built once — on a lattice a quarter of the render size and interpolated up, which
 * costs a sixteenth as much and loses nothing, because the field is low frequency by
 * construction. See buildCoarseRows().
 *
 * The optical clock is the sheen: it follows the pointer and creeps on its own.
 * The structural clock is the contours, drifting like syrup on a 75-second cycle.
 *
 * Both are a single number per frame, because both the ramp and the groove are
 * functions of the same per-pixel phase, and so is their composite. So the two are
 * folded into one 256-entry table rebuilt each frame, and every pixel of the finished
 * image is one lookup. See makeFrameLut() and paint().
 *
 * This replaced a version that animated the contours by rebuilding the field. It could
 * not be made smooth: BANDS amplifies the field, so a change of 0.0007 moves a contour
 * a whole band width, and a rebuild — however finely its cost was sliced across frames
 * — still lands as one discrete step. Measured at the rate it shipped with, contours
 * snapped 3.8px every 1.3 seconds. Sliding a phase has no step in it at all, costs
 * less, and is most of a hundred lines shorter.
 *
 * The one thing given up is that phase is cyclic, so the pattern repeats exactly once
 * per cycle. There is no seam, and nobody watches a title page for 75 seconds.
 *
 * The pointer is the viewing angle. Scroll deliberately does not drive this: the
 * frame is one screen tall and gone before any meaningful scrolling has happened, and
 * a lid shimmers because you tilt it, not because you move down the page.
 *
 * Loaded separately from home-coal.js on purpose. That file states its five jobs in
 * its own header, and this is decoration: if it throws, the header, the nav, the
 * reveals and the intro overlay all have to carry on without it.
 */
(function () {
  'use strict';

  /* ---------- Tunables ---------- */

  /*
   * Overall opacity lives in CSS as --shimmer-strength, not here, so it can be dialled
   * without reading a line of this file. Everything below changes the material itself.
   */

  // Contour lines across the height of the frame. Higher reads as finer etching.
  var BANDS = 71;

  /*
   * The structural clock: how fast the contours drift, in cycles per millisecond. One
   * cycle moves every line by one band spacing, about 22px on a 1440px frame.
   *
   * This shipped at 1/75000 — 0.3px a second — on my claim that it would be "visible if
   * you watch for ten seconds". It is not. That is under a pixel of movement in three
   * seconds, which is well below the threshold for seeing motion in a textured field;
   * it only ever registered by comparison, as an apparent jump, after looking away long
   * enough for the difference to accumulate. Hence 1/12000: about 1.8px a second, five
   * and a half pixels in the three seconds someone might rest their eyes on it.
   *
   * The ladder, if this wants tuning: 1/20000 is 1.1px/s and calmer, 1/8000 is 2.7px/s
   * and starts to feel busy behind the headline.
   */
  var CONTOUR_PER_MS = 1 / 12000;

  /*
   * How many frames the one-off field build is spread over. It is only paid at load and
   * on resize, but a whole build is around 100ms and dropping that on the main thread
   * in one go is a visible hitch on a page that is still settling.
   */
  var BUILD_SLICES = 40;

  /*
   * Where the contours stop being drawable. Both numbers are in bands per pixel: below
   * AA_LO a band is comfortably wider than a pixel and is drawn at full strength, and
   * by AA_HI they are packed tighter than the grid can represent, so the field is faded
   * back instead of being allowed to alias. AA_FLOOR is how much survives at the worst
   * of it — not zero, or the dense folds would punch visible holes in the surface.
   */
  var AA_LO = 0.22;
  var AA_HI = 0.52;
  var AA_FLOOR = 0.18;

  /*
   * Lattice spacing for the field, in render pixels. The field is smooth, so this
   * costs a sixteenth of a per-pixel evaluation and loses nothing — but it cannot go
   * much coarser: the warp steepens the field locally, and once a lattice cell spans
   * more than about one band the interpolation's own cell structure starts beating
   * against the contours and the whole frame breaks out in moire.
   */
  var COARSE = 4;

  /*
   * How far the field folds back through itself. This is the damascus swirl: at 0 the
   * contours are smooth blobs like a topographic map, and the character appears
   * somewhere around 0.6 and turns to mush past about 1.4.
   *
   * It is also the main thing that causes aliasing, which is why it sits lower than it
   * wants to. Folding steepens the field locally, and where it steepens enough that
   * bands land closer than a pixel apart they cannot be drawn — that region turns into
   * a crawling crosshatch instead of contours. The blur on .shimmer-etch cleans up what
   * is left; between them the field stays inside what the pixels can carry.
   */
  var WARP_STRENGTH = 0.72;

  // Groove thickness as a fraction of one band, and how dark the groove goes.
  var LINE_WIDTH = 0.1;
  var LINE_DEPTH = 0.75;

  // Band cycles swept between opposite corners of the frame by the pointer.
  var TILT_RANGE = 0.6;

  // Idle creep, in cycles per millisecond: one full sweep roughly every 26 seconds.
  var DRIFT_PER_MS = 1 / 26000;

  /*
   * One buffer pixel per CSS pixel, and the fractional scales this started on are a
   * mistake worth recording. Rendering at 0.75 and letting the browser stretch the
   * result puts the buffer grid and the screen grid at a ratio of 4:3, and a pattern
   * with this much high-frequency content beats against that into a regular diagonal
   * screen-door hatch across the densest half of the frame. It reads as the whole
   * thing being pixelated, and no amount of blur or band tuning touches it, because
   * the artefact is the resampling and not the field.
   *
   * Deliberately still not devicePixelRatio: on a retina display the browser doubles
   * this cleanly, and a 2:1 upscale does not beat the way 4:3 does.
   */
  var SCALE = 1;
  var MAX_PIXELS = 2200000;

  // Base frequency of the field, in cycles across the frame's larger dimension.
  var FIELD_FREQ = 2.2;
  var WARP_FREQ = 0.55;

  /*
   * One cycle of the ramp, sage-anchored. The page's accent is the note it starts and
   * ends on, so the wrap is seamless and the whole sweep stays inside the site's own
   * family. The violet is the one hue from outside it and it is given the least room.
   */
  var RAMP = [
    [0.00, 0x9d, 0xcd, 0xb1],  // Spa sage, lifted
    [0.28, 0x8a, 0xd3, 0xd0],  // teal
    [0.52, 0x81, 0xae, 0xde],  // slate blue
    [0.74, 0xb9, 0x9d, 0xd3],  // violet, brief
    [1.00, 0x9d, 0xcd, 0xb1]   // back to sage
  ];

  /*
   * What the field sits at where no sheen is falling on it. Darker than the page's own
   * ground, deliberately: without this the ramp lifts every pixel by roughly the same
   * amount and the whole frame just goes a flatter grey, which reads as a wash rather
   * than as a surface. Sitting below the ground gives the bright band something to be
   * bright against, and it is what makes the movement legible at all.
   */
  var DARK = [0x0a, 0x0b, 0x0d];

  /*
   * How tightly the sheen is focused within one cycle. At 1 the brightness is a broad
   * cosine and most of the field is half-lit; higher values pull it into a narrower
   * band with more dark between, which is what a viewing-angle highlight actually
   * looks like on an anodised surface.
   */
  var SHEEN_FOCUS = 2.2;

  // What the etched line darkens toward.
  var GROOVE = [0x0c, 0x0d, 0x0e];

  /* ---------- Setup ---------- */

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * One canvas. This was two for a while — an iridescence layer repainted every frame
   * and an etching layer repainted rarely — because the grooves must not rotate with
   * the sheen's phase, which was the first version's bug and made the whole surface
   * crawl. Two canvases were one way to keep them apart; giving them two shifts inside
   * one composite table is a better one, and costs a single lookup per pixel instead of
   * two full passes. See makeFrameLut().
   */
  var hue = document.getElementById('shimmer-hue');
  var frame = document.querySelector('.opening');
  if (!hue || !frame || !hue.getContext) {
    return;
  }

  var hueCtx = hue.getContext('2d');
  if (!hueCtx) {
    return;
  }

  var width = 0;
  var height = 0;
  var image = null;
  var out32 = null;
  var index = null;

  // The coarse lattice the field is actually evaluated on, and the repeating
  // interpolation weights that carry it back up to pixels. See buildCoarseRows().
  var coarse = null;
  var coarseW = 0;
  var coarseH = 0;
  /*
   * Per-column and per-row lattice index and interpolation weight, precomputed at
   * resize. The obvious way to write the upsample is to derive these inline with a
   * divide and a floor per pixel — which costs more than everything else in the loop
   * put together, over a million pixels, several times a second. They only depend on
   * the geometry, so they are computed 2,340 times instead of 1,296,000.
   */
  var GXI = null;
  var WUX = null;
  var GYI = null;
  var WVY = null;
  var AA_INV = 1 / (AA_HI - AA_LO);

  /*
   * Per-pixel damping, carried in the output alpha. Where the field is too steep for
   * the contours to be resolved this fades the whole surface back toward the page
   * instead of letting it alias — see upsampleRowsInto().
   */
  var damp = null;

  // Which pass the one-off build is in (0 lattice, 1 upsample), and how far down it is.
  var stage = 0;
  var buildRow = 0;
  var built = false;

  // The ramp alone, with no groove in it.
  var lut = new Uint32Array(256);
  // The groove alone, its alpha carrying the line profile.
  var etchLut = new Uint32Array(256);
  // The two composited at this frame's two phases; the only thing paint() reads.
  var frameLut = new Uint32Array(256);

  // The sheen's phase, and the angle it is easing toward. Pointer-driven.
  var phase = 0;
  var phaseTarget = 0;
  // The contours' own phase. Deliberately not pointer-driven: etching does not move
  // when you tilt something, it only creeps on its own clock.
  var contourPhase = 0;

  var running = false;
  var visible = false;
  var lastTime = 0;

  /* ---------- Value noise ---------- */

  /*
   * A shuffled permutation table rather than an arithmetic hash. The field costs a few
   * million noise evaluations to build, and the usual sin-based GLSL hash would spend
   * most of a second in Math.sin to get there; a table turns each sample into four
   * array reads.
   *
   * The seed is fixed, so the pattern is the same on every visit and every machine.
   * That matters more than it sounds: it is the page's material, not a random one.
   */
  var perm = new Uint8Array(512);

  /*
   * Eight unit gradient directions. This is gradient noise, not value noise: value
   * noise interpolates a scalar per lattice point, and the result carries a visible
   * axis-aligned crosshatch that contour lines then trace faithfully — the grid shows
   * up in the finished field as a plaid in the flatter regions. Gradients interpolated
   * with a quintic fade have no second-derivative discontinuity at the lattice and the
   * artefact goes away.
   */
  var GX = new Float32Array([1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071]);
  var GY = new Float32Array([0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071]);

  (function seed() {
    var i;
    var source = new Uint8Array(256);
    for (i = 0; i < 256; i += 1) {
      source[i] = i;
    }
    // A small deterministic LCG, so no two builds disagree about the pattern.
    var state = 1618033;
    for (i = 255; i > 0; i -= 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      var j = state % (i + 1);
      var swap = source[i];
      source[i] = source[j];
      source[j] = swap;
    }
    for (i = 0; i < 512; i += 1) {
      perm[i] = source[i & 255];
    }
  })();

  function noise(x, y) {
    var xi = Math.floor(x);
    var yi = Math.floor(y);
    var xf = x - xi;
    var yf = y - yi;

    // Quintic fade. Smoothstep is enough for a colour ramp but not for this: contours
    // are level sets of the field, so a kink in its curvature becomes a visible crease.
    var u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    var v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    var xa = xi & 255;
    var xb = (xi + 1) & 255;
    var ya = yi & 255;
    var yb = (yi + 1) & 255;

    var g = perm[perm[xa] + ya] & 7;
    var n00 = GX[g] * xf + GY[g] * yf;
    g = perm[perm[xb] + ya] & 7;
    var n10 = GX[g] * (xf - 1) + GY[g] * yf;
    g = perm[perm[xa] + yb] & 7;
    var n01 = GX[g] * xf + GY[g] * (yf - 1);
    g = perm[perm[xb] + yb] & 7;
    var n11 = GX[g] * (xf - 1) + GY[g] * (yf - 1);

    var top = n00 + (n10 - n00) * u;
    var bottom = n01 + (n11 - n01) * u;

    // 2D gradient noise runs to about ±0.707; normalise into 0..1.
    return (top + (bottom - top) * v) * 0.7071 + 0.5;
  }

  function fbm2(x, y) {
    return noise(x, y) * 0.667 + noise(x * 2.03, y * 2.03) * 0.333;
  }

  /*
   * Only two octaves for the field itself, weighted hard toward the base. A third
   * octave adds detail the contours cannot resolve: where it steepens the gradient the
   * bands fall below a pixel apart and the whole area sparkles. The complexity comes
   * from the warp instead, which folds the field without steepening it.
   */
  function fbm3(x, y) {
    return noise(x, y) * 0.72 + noise(x * 2.03, y * 2.03) * 0.28;
  }

  /* ---------- The palette ---------- */

  /*
   * 256 entries, written once. Each holds the ramp colour for that point in the cycle
   * with the groove darkening already mixed in, so the per-frame loop never has to
   * know that contour lines exist.
   */
  function buildLut() {
    var bytes = new Uint8Array(lut.buffer);
    var etchBytes = new Uint8Array(etchLut.buffer);

    for (var i = 0; i < 256; i += 1) {
      var t = i / 256;
      var o = i * 4;

      // Where in the ramp this entry sits.
      var s = 1;
      while (s < RAMP.length - 1 && RAMP[s][0] < t) {
        s += 1;
      }
      var a = RAMP[s - 1];
      var b = RAMP[s];
      var span = b[0] - a[0];
      var k = span > 0 ? (t - a[0]) / span : 0;

      var r = a[1] + (b[1] - a[1]) * k;
      var g = a[2] + (b[2] - a[2]) * k;
      var bl = a[3] + (b[3] - a[3]) * k;

      /*
       * The sheen envelope: dark at the ends of the cycle, bright through the middle,
       * focused by SHEEN_FOCUS. This is what turns the ramp from a tint applied evenly
       * across the frame into a band of light travelling through a dark surface — and
       * a travelling band is something the eye can actually follow, where a uniform
       * shift of hue is not.
       */
      var env = 0.5 - 0.5 * Math.cos(t * 6.283185307);
      env = Math.pow(env, SHEEN_FOCUS);

      // Little-endian RGBA. Alpha is full; --shimmer-strength does the dimming.
      bytes[o] = DARK[0] + (r - DARK[0]) * env;
      bytes[o + 1] = DARK[1] + (g - DARK[1]) * env;
      bytes[o + 2] = DARK[2] + (bl - DARK[2]) * env;
      bytes[o + 3] = 255;

      /*
       * The groove, in its own table. Distance to the nearest end of the cycle,
       * smoothstepped, so the line has soft shoulders rather than an aliased edge —
       * this is painted once at a fraction of screen resolution and a hard threshold
       * would stair-step visibly once it is scaled up.
       */
      var d = Math.min(t, 1 - t) / LINE_WIDTH;
      var edge = d >= 1 ? 0 : 1 - d * d * (3 - 2 * d);

      etchBytes[o] = GROOVE[0];
      etchBytes[o + 1] = GROOVE[1];
      etchBytes[o + 2] = GROOVE[2];
      etchBytes[o + 3] = edge * LINE_DEPTH * 255;
    }
  }

  /* ---------- The field ---------- */

  /*
   * Built once per meaningful resize, then discarded down to a byte of palette index
   * per pixel. Everything expensive about this effect happens here.
   */
  /*
   * The field is evaluated on a coarse lattice and interpolated up, rather than
   * sampled per pixel. That is not an approximation of the result — it is the honest
   * shape of the problem. The field is low frequency by construction (two octaves at
   * FIELD_FREQ); every bit of fine detail in the finished image comes from multiplying
   * it by BANDS afterwards. So a lattice a sixth of the render size carries all the
   * information there is, at a thirty-sixth of the cost.
   *
   * That is what buys the slow morph. At full resolution a rebuild is ~45ms and can
   * only ever happen once; on the lattice it is a few milliseconds and can happen
   * several times a second, which is what lets the contours evolve at all.
   */
  function buildCoarseRows(t, fromRow, toRow) {
    var span = Math.max(width, height);
    var fs = FIELD_FREQ / span * COARSE;
    var ws = WARP_FREQ * FIELD_FREQ / span * COARSE;

    /*
     * Two drifts at different rates and directions. A single offset would slide the
     * whole pattern rigidly, like a photograph being pulled past a window; moving the
     * warp and the field it warps against each other makes the folds reorganise in
     * place, which is the difference between a texture that travels and one that
     * evolves.
     */
    var wt = t;
    var ft = t * 0.62;

    for (var gy = fromRow; gy < toRow; gy += 1) {
      var row = gy * coarseW;
      for (var gx = 0; gx < coarseW; gx += 1) {
        /*
         * Domain warping: sample the field not at this point but at this point pushed
         * around by a second, slower field. Without it the contours are the smooth
         * concentric blobs of a topographic map; with it they fold back through each
         * other, which is the whole character of the reference.
         */
        var wx = fbm2(gx * ws + wt, gy * ws + wt * 0.4);
        var wy = fbm2(gx * ws + 71.3 + wt, gy * ws + 19.7 + wt * 0.4);

        coarse[row + gx] = fbm3(
          gx * fs + wx * WARP_STRENGTH + ft,
          gy * fs + wy * WARP_STRENGTH - ft * 0.6
        );
      }
    }
  }

  /*
   * Lattice to pixels, then straight into palette space.
   *
   * The interpolation weights are quintic rather than linear, and that matters more
   * here than it looks: contours are level sets, so a discontinuity in the field's
   * first derivative at every lattice boundary would show up as a grid of kinks
   * running through every line. Because the lattice is regular the weights repeat with
   * period COARSE, so they are computed once into WU/WV and read back per pixel.
   */
  function upsampleRowsInto(target, targetDamp, fromRow, toRow) {
    /*
     * Bands per pixel, from the field's own slope across a lattice cell. This is the
     * cheap equivalent of the derivative a shader would get from fwidth: the four
     * corner values are already loaded for the interpolation, so their differences
     * cost nothing extra and say exactly how fast the field is moving here — which is
     * the same thing as how tightly the contours are packed.
     */
    var dens = BANDS / COARSE;

    for (var y = fromRow; y < toRow; y += 1) {
      var v = WVY[y];
      var rowA = GYI[y] * coarseW;
      var rowB = rowA + coarseW;
      var out = y * width;

      for (var x = 0; x < width; x += 1) {
        var gx = GXI[x];
        var u = WUX[x];

        var a = coarse[rowA + gx];
        var b = coarse[rowA + gx + 1];
        var c = coarse[rowB + gx];
        var d = coarse[rowB + gx + 1];

        var top = a + (b - a) * u;
        var bottom = c + (d - c) * u;

        var i = out + x;
        target[i] = ((top + (bottom - top) * v) * BANDS * 256) & 255;

        var dx = b - a;
        if (dx < 0) { dx = -dx; }
        var dy = c - a;
        if (dy < 0) { dy = -dy; }
        var rate = (dx > dy ? dx : dy) * dens;

        var k = (rate - AA_LO) * AA_INV;
        if (k <= 0) {
          targetDamp[i] = 255;
        } else if (k >= 1) {
          targetDamp[i] = AA_FLOOR * 255;
        } else {
          // Smoothstepped, so the transition into the faded region is not itself an
          // edge the eye can find.
          targetDamp[i] = (1 - (1 - AA_FLOOR) * k * k * (3 - 2 * k)) * 255;
        }
      }
    }
  }

  function upsampleRows(fromRow, toRow) {
    upsampleRowsInto(index, damp, fromRow, toRow);
  }

  /*
   * The field build, spread across frames.
   *
   * It only ever runs at load and on resize — the contours are animated by phase, not
   * by rebuilding this — but a whole build is around a hundred milliseconds and landing
   * that in one frame is a visible hitch on a page that is still settling. Sliced, it
   * costs a couple of milliseconds a frame for about two thirds of a second, and the
   * canvas fades in when it is done rather than popping.
   *
   * No back buffer: nothing is being replaced. Until `built` goes true the canvas is
   * transparent and the frame shows the plain highlight wash underneath.
   */
  function stepBuild() {
    if (built) {
      return;
    }

    if (stage === 0) {
      var rows = Math.ceil(coarseH / BUILD_SLICES);
      var end = Math.min(buildRow + rows, coarseH);
      buildCoarseRows(0, buildRow, end);
      buildRow = end;
      if (buildRow >= coarseH) {
        stage = 1;
        buildRow = 0;
      }
      return;
    }

    var up = Math.ceil(height / BUILD_SLICES);
    var stop = Math.min(buildRow + up, height);
    upsampleRows(buildRow, stop);
    buildRow = stop;

    if (buildRow >= height) {
      built = true;
      frame.classList.add('is-ready');
    }
  }

  /*
   * Drives the build to completion, a slice at a time.
   *
   * Deliberately setTimeout and not requestAnimationFrame. This is chunked work, not
   * animation: it wants to yield to the event loop between slices, nothing more. Tying
   * it to frames would mean the field never gets built at all when frames are not being
   * produced — a backgrounded tab, or the opening frame already scrolled past on a
   * reload partway down the page — and the shimmer would simply never appear.
   */
  function pumpBuild() {
    stepBuild();
    if (built) {
      paint();
      return;
    }
    window.setTimeout(pumpBuild, 0);
  }

  // Used for the first field and under reduced motion, where there is no loop to
  // spread the work across and one finished frame is the whole job.
  // Used under reduced motion, where there is no loop to spread the work across and one
  // finished frame is the whole job.
  function buildFieldNow() {
    buildCoarseRows(0, 0, coarseH);
    upsampleRowsInto(index, damp, 0, height);
    built = true;
    frame.classList.add('is-ready');
  }

  /* ---------- Sizing ---------- */

  function measure() {
    var rect = frame.getBoundingClientRect();
    var w = Math.max(Math.round(rect.width * SCALE), 1);
    var h = Math.max(Math.round(rect.height * SCALE), 1);

    // Cap the buffer on very large displays rather than letting it grow without limit.
    var total = w * h;
    if (total > MAX_PIXELS) {
      var k = Math.sqrt(MAX_PIXELS / total);
      w = Math.max(Math.round(w * k), 1);
      h = Math.max(Math.round(h * k), 1);
    }
    return { w: w, h: h };
  }

  function resize() {
    var size = measure();
    width = size.w;
    height = size.h;

    hue.width = width;
    hue.height = height;

    image = hueCtx.createImageData(width, height);
    out32 = new Uint32Array(image.data.buffer);
    index = new Uint8Array(width * height);
    damp = new Uint8Array(width * height);

    // One lattice cell of margin on each side, so the interpolation always has a
    // right-hand and bottom neighbour to read.
    coarseW = ((width - 1) / COARSE | 0) + 2;
    coarseH = ((height - 1) / COARSE | 0) + 2;
    coarse = new Float32Array(coarseW * coarseH);

    GXI = new Int32Array(width);
    WUX = new Float32Array(width);
    for (var x = 0; x < width; x += 1) {
      var gx = (x / COARSE) | 0;
      var fx = (x - gx * COARSE) / COARSE;
      GXI[x] = gx;
      WUX[x] = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    }

    GYI = new Int32Array(height);
    WVY = new Float32Array(height);
    for (var y = 0; y < height; y += 1) {
      var gy = (y / COARSE) | 0;
      var fy = (y - gy * COARSE) / COARSE;
      GYI[y] = gy;
      WVY[y] = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    }

    // Re-arm the sliced builder rather than building here. resize() runs on a debounce
    // from a real resize event, and a hundred-millisecond block on that path is exactly
    // the hitch the slicing exists to avoid.
    stage = 0;
    buildRow = 0;
    built = false;
    frame.classList.remove('is-ready');
  }

  /*
   * The etching, painted once per resize. Nothing here depends on the phase, which is
   * exactly the property that makes the surface read as a fixed thing being lit rather
   * than as a pattern crawling across the screen.
   */

  /* ---------- Painting ---------- */

  /*
   * The whole per-frame cost, and only the hue layer pays it. No arithmetic on the
   * field, no colour mixing, no gradient: the phase is a byte, the ramp wraps, and
   * shifting the viewing angle is a rotation of the lookup rather than a recomputation
   * of the image. Measured at 0.8ms for a 1080x675 buffer.
   */
  /*
   * Composite the two clocks into one table, once per frame.
   *
   * The ramp and the groove are both functions of a pixel's phase, so their composite
   * is a function of it too — which means the whole two-layer effect collapses into a
   * single 256-entry lookup, and the per-pixel loop below never has to know that
   * contour lines exist at all. Two hundred and fifty six iterations a frame buys a
   * million pixels of work.
   *
   * The two shifts must stay separate. Rotating both by the sheen's phase was the
   * original bug in this file: the grooves then walk with the light, and the surface
   * crawls instead of a fixed surface catching it.
   */
  function makeFrameLut() {
    var sheenShift = ((phase - Math.floor(phase)) * 256) & 255;
    var lineShift = ((contourPhase - Math.floor(contourPhase)) * 256) & 255;
    var bytes = new Uint8Array(frameLut.buffer);
    var ramp = new Uint8Array(lut.buffer);
    var etch = new Uint8Array(etchLut.buffer);

    for (var k = 0; k < 256; k += 1) {
      var so = (((k + sheenShift) & 255) * 4);
      var eo = (((k + lineShift) & 255) * 4);
      var a = etch[eo + 3] / 255;
      var o = k * 4;

      // Groove over sheen. Alpha is left full here; the per-pixel damping supplies it.
      bytes[o] = ramp[so] + (etch[eo] - ramp[so]) * a;
      bytes[o + 1] = ramp[so + 1] + (etch[eo + 1] - ramp[so + 1]) * a;
      bytes[o + 2] = ramp[so + 2] + (etch[eo + 2] - ramp[so + 2]) * a;
      bytes[o + 3] = 255;
    }
  }

  function paint() {
    makeFrameLut();

    var n = width * height;
    for (var i = 0; i < n; i += 1) {
      // Colour from the composite table, opacity from the damping. Keeping the damping
      // in the alpha channel is what lets this stay a lookup: the alternative is
      // unpacking three channels and mixing them per pixel, every frame, forever.
      out32[i] = (frameLut[index[i]] & 0xffffff) | (damp[i] << 24);
    }

    hueCtx.putImageData(image, 0, 0);
  }

  /* ---------- Motion ---------- */

  /*
   * Two clocks, running at wildly different rates, and both of them just numbers.
   *
   * The optical clock is the sheen: it eases toward the pointer's angle and creeps on
   * its own, so a page nobody is touching is still alive.
   *
   * The structural clock is the contours, drifting on a 75-second cycle. It advances by
   * five thousandths of a pixel per frame, which is exactly why it is smooth — there is
   * no rebuild here to land as a step, only a scalar going into a lookup.
   */
  function tick(time) {
    var dt = lastTime ? Math.min(time - lastTime, 100) : 16;
    lastTime = time;

    phase += (phaseTarget - phase) * 0.14;
    phase += DRIFT_PER_MS * dt;

    contourPhase += CONTOUR_PER_MS * dt;

    // Nothing is painted until the first field lands; pumpBuild() handles that, and
    // paints the moment it is done.
    if (built) {
      paint();
    }

    if (running) {
      requestAnimationFrame(tick);
    }
  }

  function start() {
    if (running || reducedMotion || !index) {
      return;
    }
    running = true;
    lastTime = 0;
    requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
  }

  /*
   * The pointer is the viewing angle. Both axes feed one number through a fixed
   * direction, so dragging the cursor across the frame sweeps the colour diagonally —
   * a straight horizontal response reads as a wipe rather than as a tilt.
   *
   * The highlight is handed to CSS as two custom properties instead of being drawn
   * here. A radial gradient the compositor already knows how to move costs nothing,
   * and it keeps the loop above down to its four operations.
   */
  function onPointer(event) {
    /*
     * Ignored while the frame is parked, and this is the fix for a real symptom rather
     * than housekeeping. The listener is on the window, so it kept firing while the
     * opening frame was scrolled past — moving phaseTarget the whole time, with no loop
     * running to ease phase toward it. Coming back then started the loop with the two
     * far apart, and the sheen swept across at the lerp's full rate for a third of a
     * second before settling: a lurch on return, from a page that had looked static.
     */
    if (!visible) {
      return;
    }

    var rect = frame.getBoundingClientRect();
    if (rect.height <= 0) {
      return;
    }

    var x = (event.clientX - rect.left) / rect.width;
    var y = (event.clientY - rect.top) / rect.height;

    frame.style.setProperty('--shimmer-x', (x * 100).toFixed(2) + '%');
    frame.style.setProperty('--shimmer-y', (y * 100).toFixed(2) + '%');

    phaseTarget = ((x - 0.5) * 0.8 + (y - 0.5) * 0.6) * TILT_RANGE;
  }

  /* ---------- Boot ---------- */

  function build() {
    buildLut();
    resize();

    if (reducedMotion) {
      // One finished frame and nothing else: no loop, no listeners, no drift.
      buildFieldNow();
      paint();
      return;
    }

    pumpBuild();

    /*
     * The frame is one screen tall, so once it is gone the loop has nothing to say.
     * An observer is the honest parking condition here — unlike the circuit page there
     * is no settled state to test for, because the drift never settles.
     */
    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) {
          start();
        } else {
          stop();
        }
      });
      observer.observe(frame);
    } else {
      // No observer: the loop never parks, so the frame is always live as far as the
      // pointer gate in onPointer() is concerned.
      visible = true;
      start();
    }

    window.addEventListener('pointermove', onPointer, { passive: true });

    /*
     * Only a width change is worth rebuilding for. On a phone the URL bar collapsing
     * changes 100svh constantly, and a field rebuild is the one genuinely expensive
     * thing on this page.
     */
    var lastWidth = window.innerWidth;
    var lastHeight = window.innerHeight;
    var pending = null;

    window.addEventListener('resize', function () {
      var dw = window.innerWidth !== lastWidth;
      var dh = Math.abs(window.innerHeight - lastHeight) > 180;
      if (!dw && !dh) {
        return;
      }
      lastWidth = window.innerWidth;
      lastHeight = window.innerHeight;

      window.clearTimeout(pending);
      pending = window.setTimeout(function () {
        resize();
        if (reducedMotion) {
          buildFieldNow();
          paint();
        } else {
          pumpBuild();
          if (visible) {
            start();
          }
        }
      }, 180);
    });
  }

  /*
   * Deferred past first paint. The field costs on the order of 100ms to build and
   * there is nothing on screen waiting for it — the intro overlay is usually still up.
   */
  function defer() {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(build, { timeout: 1200 });
    } else {
      window.setTimeout(build, 0);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', defer);
  } else {
    defer();
  }
})();
