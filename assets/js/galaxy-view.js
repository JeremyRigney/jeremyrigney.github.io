/*
 * jeremy.ie/galaxy — the renderer, the camera and the controls.
 *
 * Draws the model (galaxy-model.js) through a band (galaxy-bands.js) with WebGL2.
 * Everything that moves on its own moves in the vertex shader: each point's orbit on
 * the rotation curve and its phase against the arm wave are worked out there from the
 * clock, so the page uploads the galaxy once and then sends a handful of numbers a
 * frame. The shader's arithmetic is the hero's (home-galaxy.js), and GalaxyModel's
 * evaluate() repeats it on the CPU for the few points the page has to know about.
 *
 * A frame, in order:
 *
 *   1. Everything is added into a half-float buffer, so light can sum well past white
 *      without clipping. The core in particular is thousands of stars deep.
 *   2. The background sky.
 *   3. Every population on the far side of the disc's midplane from the camera.
 *   4. The dust, which takes light out of what is already there, more in the blue
 *      than in the red. The dust layer is thin, so a star is behind it exactly when it
 *      is on the far side of the midplane: drawing in this order is what puts a dark
 *      lane across the bulge when the disc is turned near edge-on.
 *   5. Everything on the near side.
 *   6. A colour-preserving asinh stretch to the screen, as survey images are made:
 *      faint light is lifted, and the core rolls off to white instead of clipping.
 *
 * Stars are point sources: they keep their pixel size, and brighten as the view zooms
 * in by just as much as they spread apart, so the surface brightness of the disc stays
 * the same at any zoom and the stars resolve out of it. Extended light (the glow, the
 * nebulae, the dust) is drawn at its size in the galaxy instead. The patches that lie
 * in the disc foreshorten with it, and brighten as they do, since an inclined disc
 * puts more material along each line of sight.
 *
 * The camera is a trackball on a quaternion, so there is no gimbal lock and no angle
 * the disc cannot be turned to.
 */
(function () {
  'use strict';

  var Model = window.GalaxyModel;
  var Bands = window.GalaxyBands;
  if (!Model || !Bands) { return; }

  /* ---------- Tunables ---------- */

  // The opening view: the hero's inclination (about 62 degrees from face-on).
  var BASE_TILT = 1.08;

  var CAMERA_DIST = 4.2; // disc radii from the centre: enough perspective to read as 3D
  var ZOOM_MIN = 0.55;
  var ZOOM_MAX = 3.5;
  var ZOOM_EASE = 9; // per second

  var DRAG_TURN = 1.15; // radians per shorter-screen-dimension of drag
  var SPIN_DECAY = 2.6; // per second, once released
  var RESET_MS = 900;

  var REVEAL_MS = 2200; // as the hero: swell from 70% and fade in
  var HOVER_RADIUS = 22; // CSS px
  var TAP_SLOP = 6; // CSS px a touch may wander and still be a tap
  var RING_HOLD_MS = 1400; // the kpc rings linger this long after the last interaction

  var MAX_PIXELS = 4200000;
  var FRAME_BUDGET_MS = 30;

  // Supernovae, as home-galaxy.js: about one a minute, the first soon after load.
  var SN_MEAN_GAP = 45;
  var SN_MIN_GAP = 20;
  var SN_LIFE = 12;
  var SN_PEAK = 900; // luminosity at peak, against ~3 for a bright young star

  /* ---------- DOM ---------- */

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var stage = document.getElementById('stage');
  var canvas = document.getElementById('galaxy-gl');
  var overlay = document.getElementById('galaxy-overlay');
  if (!stage || !canvas || !overlay) { return; }
  var ctx2 = overlay.getContext('2d');

  var hud = document.getElementById('galaxy-hud');
  var hint = document.getElementById('galaxy-hint');
  var bandStrip = document.getElementById('galaxy-bands');
  var fallback = document.getElementById('galaxy-fallback');
  var card = document.querySelector('.galaxy-card');
  var reticle = document.querySelector('.galaxy-reticle');
  var cardId = card && card.querySelector('.galaxy-card-id');
  var cardTag = card && card.querySelector('.galaxy-card-tag');
  var cardRows = card && card.querySelectorAll('.galaxy-card-row');

  function fail() {
    document.documentElement.classList.add('no-webgl');
    if (fallback) { fallback.hidden = false; }
  }

  var gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance'
  });
  if (!gl) {
    fail();
    return;
  }

  /* ---------- Shaders ---------- */

  var POINT_VS = [
    '#version 300 es',
    'precision highp float;',
    'layout(location = 0) in vec4 a_orbit;',
    'layout(location = 1) in vec4 a_phys;',
    'layout(location = 2) in vec4 a_extra;',
    'uniform int u_mode;',
    'uniform float u_time, u_vrot, u_rcore2, u_pattern, u_sharp, u_interarm;',
    'uniform mat3 u_rot;',
    'uniform float u_dist, u_focal, u_refPx, u_dpr, u_scale, u_maxSize;',
    'uniform vec2 u_halfView;',
    'uniform float u_side, u_camSide;',
    'uniform float u_extended, u_size, u_gain;',
    'uniform float u_plane, u_flat;',
    'uniform float u_useLut;',
    'uniform vec3 u_tint;',
    'uniform sampler2D u_lut;',
    'out vec3 v_col;',
    '',
    'float omegaAt(float r) { return u_vrot / sqrt(r * r + u_rcore2); }',
    '',
    'void hide() {',
    '  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '  gl_PointSize = 0.0;',
    '  v_col = vec3(0.0);',
    '}',
    '',
    'void main() {',
    '  vec3 p = vec3(0.0);',
    '  float light = 1.0;',
    '  if (u_mode == 0) {',
    // The disc: an orbit on the rotation curve, lit by the density wave.
    '    float r = a_orbit.x;',
    '    float w = omegaAt(r);',
    '    float a = a_orbit.y + w * u_time;',
    '    float ph = a_orbit.w + (w - u_pattern) * u_time;',
    '    float crest = u_interarm + (1.0 - u_interarm) * exp(u_sharp * (cos(2.0 * ph) - 1.0));',
    '    light = a_phys.w + (1.0 - a_phys.w) * smoothstep(a_phys.z - 0.16, a_phys.z, crest);',
    '    p = vec3(r * cos(a), r * sin(a), a_orbit.z);',
    '  } else if (u_mode == 1) {',
    // The halo: a circular orbit in its own plane, either way round.
    '    float r = abs(a_orbit.x);',
    '    float a = a_orbit.y + sign(a_orbit.x) * omegaAt(r) * u_time;',
    '    float ci = cos(a_orbit.z), si = sin(a_orbit.z);',
    '    float cn = cos(a_orbit.w), sn = sin(a_orbit.w);',
    '    vec3 q = vec3(r * cos(a), r * sin(a) * ci, r * sin(a) * si);',
    '    p = vec3(q.x * cn - q.y * sn, q.x * sn + q.y * cn, q.z) + a_extra.xyz;',
    '  } else if (u_mode == 3) {',
    '    p = a_orbit.xyz;',
    '  }',
    '  if (light < 0.004 || a_phys.y <= 0.0) { hide(); return; }',
    '  if (u_mode != 2 && u_side != 0.0 && p.z * u_camSide * u_side < 0.0) { hide(); return; }',
    '',
    '  vec3 v;',
    '  if (u_mode == 2) {',
    // The sky is at infinity: it turns with the camera but never gets closer.
    '    v = u_rot * a_orbit.xyz;',
    '    if (v.z >= -0.01) { hide(); return; }',
    '  } else {',
    '    v = u_rot * (p * u_scale);',
    '    v.z -= u_dist;',
    '    if (v.z > -0.05) { hide(); return; }',
    '  }',
    '  float ppu = u_focal / -v.z;',
    '  gl_Position = vec4(v.xy * ppu / u_halfView, 0.0, 1.0);',
    '',
    '  vec3 colour = u_tint;',
    '  if (u_useLut > 0.5) {',
    '    float x = clamp((log(max(a_phys.x, 1.0)) - 7.6) / 3.0, 0.0, 1.0);',
    '    colour *= texture(u_lut, vec2(x, 0.5)).rgb;',
    '  }',
    '',
    '  float size;',
    '  float inten;',
    '  if (u_extended > 0.5) {',
    '    size = a_extra.w * u_size * ppu;',
    '    inten = u_gain * a_phys.y * light;',
    '    if (u_plane > 0.5) { inten /= u_flat; }',
    '    float floorPx = 1.5 * u_dpr;',
    '    if (size < floorPx) { inten *= (size * size) / (floorPx * floorPx); size = floorPx; }',
    '    size = min(size, u_maxSize);',
    '  } else {',
    '    size = u_size * a_extra.w * u_dpr;',
    '    float m = u_mode == 2 ? 1.0 : ppu / u_refPx;',
    '    float css = size / u_dpr;',
    '    inten = u_gain * a_phys.y * light * m * m / (0.19 * css * css);',
    '  }',
    '  gl_PointSize = size;',
    '  v_col = colour * inten;',
    '}'
  ].join('\n');

  var POINT_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 v_col;',
    'uniform float u_plane, u_flat, u_absorb;',
    'uniform vec2 u_axis;',
    'out vec4 o;',
    'void main() {',
    '  vec2 q = gl_PointCoord * 2.0 - 1.0;',
    '  q.y = -q.y;',
    '  float d2;',
    '  if (u_plane > 0.5) {',
    // Foreshortened along the projected disc normal: a patch lying in the plane.
    '    float al = dot(q, u_axis);',
    '    vec2 pp = q - al * u_axis;',
    '    d2 = dot(pp, pp) + al * al / (u_flat * u_flat);',
    '  } else {',
    '    d2 = dot(q, q);',
    '  }',
    '  if (d2 >= 1.0) { discard; }',
    '  float prof = (exp(-4.0 * d2) - 0.0183) / 0.9817;',
    '  if (u_absorb > 0.5) {',
    '    o = vec4(1.0 - exp(-v_col * prof), 1.0);',
    '  } else {',
    '    o = vec4(v_col * prof, 1.0);',
    '  }',
    '}'
  ].join('\n');

  var TONE_VS = [
    '#version 300 es',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var TONE_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_hdr;',
    'uniform float u_exposure, u_stretch, u_sat;',
    'uniform vec3 u_ground;',
    'out vec4 o;',
    'void main() {',
    '  vec3 c = max(texelFetch(u_hdr, ivec2(gl_FragCoord.xy), 0).rgb, 0.0) * u_exposure;',
    '  float I = (c.r + c.g + c.b) / 3.0;',
    '  if (I > 1e-6) { c *= asinh(u_stretch * I) / (asinh(u_stretch) * I); }',
    '  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = max(mix(vec3(L), c, u_sat), 0.0);',
    // A soft shoulder instead of a clip: past 0.75 the brightest channel is eased
    // toward 1, so the core keeps a gradient, and the brightest light runs to white.
    '  float m = max(max(c.r, c.g), c.b);',
    '  if (m > 0.75) {',
    '    float k = 0.75 + 0.25 * (1.0 - exp(-(m - 0.75) / 0.25));',
    '    c = mix(c * (k / m), vec3(k), 0.55 * smoothstep(0.9, 4.0, m));',
    '  }',
    '  o = vec4(u_ground + pow(c, vec3(1.0 / 1.12)) * (1.0 - u_ground), 1.0);',
    '}'
  ].join('\n');

  // Adds a low-resolution buffer into the one bound, filtered up to its size.
  var BLIT_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_src;',
    'uniform vec2 u_size;',
    'out vec4 o;',
    'void main() {',
    '  o = vec4(texture(u_src, gl_FragCoord.xy / u_size).rgb, 1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    var loc = {};
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      loc[name] = gl.getUniformLocation(p, name);
    }
    return { prog: p, loc: loc };
  }

  /* ---------- Model and band ---------- */

  // Phones and tablets get the lighter model; the choice is made once, at load.
  var small = window.innerWidth < 700
    || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var model = Model.build(small);
  var band = Bands.get('optical');
  var P = Model.params;

  /* ---------- GL resources ---------- */

  var pointProg, toneProg;
  var vaos = {}; // population name -> { vao, buffers }
  var snVao, snBuffers;
  var lutTex, hdrFloat = false;
  var blitProg;
  var maxPointSize = 256;
  var toneVao;

  function makeVao(orbit, phys, extra, usage) {
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var bufs = [orbit, phys, extra].map(function (data, loc) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
      return b;
    });
    gl.bindVertexArray(null);
    return { vao: vao, buffers: bufs };
  }

  // The band's colour(teff), sampled on a log scale from 2,000 K to 40,000 K.
  function buildLut() {
    var N = 256;
    var px = new Uint8Array(N * 4);
    for (var i = 0; i < N; i++) {
      var teff = Math.exp(7.6 + 3 * i / (N - 1));
      var c = band.colour(teff);
      px[i * 4] = Math.round(c[0] * 255);
      px[i * 4 + 1] = Math.round(c[1] * 255);
      px[i * 4 + 2] = Math.round(c[2] * 255);
      px[i * 4 + 3] = 255;
    }
    if (lutTex) { gl.deleteTexture(lutTex); }
    lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /*
   * The accumulation buffers. Half float where the device can render to it, which is
   * nearly everywhere; otherwise 8-bit, with everything scaled down going in and back
   * up coming out, which loses the faintest stars but keeps the picture.
   *
   * The smooth light (the unresolved glow of the disc and the bulge) goes into two
   * buffers at a third of the resolution, one for each side of the midplane, and is
   * blended up into the main one on either side of the dust. It has no detail finer
   * than a few pixels, and at full resolution it would be most of the page's fill.
   */
  var HDR_SCALE_8BIT = 0.25;
  var SOFT_SCALE = 1 / 3;
  var hdr = null, soft = [null, null];

  function makeTarget(width, height, filter, old) {
    var t = old || { tex: null, fbo: gl.createFramebuffer() };
    if (t.tex) { gl.deleteTexture(t.tex); }
    t.tex = gl.createTexture();
    t.width = width;
    t.height = height;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    if (hdrFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  }

  // Can this device render (and blend) into a half-float buffer? Asked once.
  function probeFloat() {
    hdrFloat = false;
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      return;
    }
    hdrFloat = true;
    var t = makeTarget(4, 4, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    hdrFloat = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  function buildTarget() {
    hdr = makeTarget(canvas.width, canvas.height, gl.NEAREST, hdr);
    var sw = Math.max(1, Math.ceil(canvas.width * SOFT_SCALE));
    var sh = Math.max(1, Math.ceil(canvas.height * SOFT_SCALE));
    soft[0] = makeTarget(sw, sh, gl.LINEAR, soft[0]);
    soft[1] = makeTarget(sw, sh, gl.LINEAR, soft[1]);
  }

  function initGL() {
    pointProg = program(POINT_VS, POINT_FS);
    toneProg = program(TONE_VS, TONE_FS);
    blitProg = program(TONE_VS, BLIT_FS);
    toneVao = gl.createVertexArray();

    vaos = {};
    model.populations.forEach(function (pop) {
      vaos[pop.name] = makeVao(pop.orbit, pop.phys, pop.extra);
    });
    snVao = makeVao(new Float32Array(4), new Float32Array(4), new Float32Array(4), gl.DYNAMIC_DRAW);

    var range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    maxPointSize = range ? range[1] : 64;

    buildLut();
    probeFloat();
    buildTarget();
  }

  /* ---------- Quaternions ---------- */

  function qaxis(x, y, z, angle) {
    var s = Math.sin(angle / 2);
    return [x * s, y * s, z * s, Math.cos(angle / 2)];
  }

  function qmul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }

  function qnorm(q) {
    var l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }

  function qslerp(a, b, t) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
    if (d > 0.9995) {
      return qnorm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
    }
    var th = Math.acos(d);
    var s = Math.sin(th);
    var wa = Math.sin((1 - t) * th) / s;
    var wb = Math.sin(t * th) / s;
    return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
  }

  // Row-major 3x3.
  function qmat(q, m) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w);
    m[3] = 2 * (x * y + z * w); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - x * w);
    m[6] = 2 * (x * z - y * w); m[7] = 2 * (y * z + x * w); m[8] = 1 - 2 * (x * x + y * y);
    return m;
  }

  /* ---------- Camera ---------- */

  var w = 0, h = 0, dpr = 1, dprCap = 2;
  var cx = 0, cy = 0, basePx = 1;

  /*
   * The opening view matches the hero's: tipped back BASE_TILT about the horizontal,
   * so the near side of the disc is at the bottom and it turns the same way on screen.
   * Tall phone screens also roll it onto the diagonal, as the hero does, so the disc
   * spans the screen rather than sitting in a stripe across it.
   */
  function defaultView() {
    var q = qaxis(1, 0, 0, Math.PI - BASE_TILT);
    if (h > w * 1.3) { q = qmul(qaxis(0, 0, 1, 0.62), q); }
    return q;
  }

  var view = [0, 0, 0, 1];
  var rot = new Float32Array(9);
  var rotCol = new Float32Array(9);
  var zoom = 1, zoomTarget = 1;
  var spinVel = [0, 0, 0]; // view-space angular velocity, rad/s
  var resetFrom = null, resetT = 0;

  function turn(ax, ay, az, angle) {
    if (!angle) { return; }
    view = qnorm(qmul(qaxis(ax, ay, az, angle), view));
  }

  function applyView() {
    qmat(view, rot);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        rotCol[c * 3 + r] = rot[r * 3 + c];
      }
    }
  }

  function focalCss() {
    return basePx * CAMERA_DIST * zoom;
  }

  var projX = 0, projY = 0, projDepth = 0;

  // Galaxy coordinates to CSS pixels, exactly as the vertex shader does it.
  function project(x, y, z, scale) {
    var vx = (rot[0] * x + rot[1] * y + rot[2] * z) * scale;
    var vy = (rot[3] * x + rot[4] * y + rot[5] * z) * scale;
    var vz = (rot[6] * x + rot[7] * y + rot[8] * z) * scale - CAMERA_DIST;
    projDepth = -vz;
    if (projDepth < 0.05) { return false; }
    var f = focalCss() / projDepth;
    projX = cx + vx * f;
    projY = cy - vy * f;
    return true;
  }

  /* ---------- Sizing ---------- */

  function resize() {
    w = Math.max(1, stage.clientWidth);
    h = Math.max(1, stage.clientHeight);
    var narrow = w < 700;
    dpr = Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : dprCap);
    while (dpr > 1 && w * h * dpr * dpr > MAX_PIXELS) { dpr -= 0.25; }

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    overlay.width = canvas.width;
    overlay.height = canvas.height;

    cx = w / 2;
    cy = h / 2;
    basePx = narrow ? Math.min(w * 0.62, h * 0.42) : Math.min(w * 0.38, h * 0.6);

    if (gl && !gl.isContextLost()) { buildTarget(); }
    dirty = true;
  }

  /* ---------- Drawing ---------- */

  var clock = 0;
  var revealMs = reducedMotion ? REVEAL_MS : 0;
  var dirty = true;

  function easeOut(t) {
    t = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - t, 3);
  }

  function drawPopulation(name, side, rev, flat, axis) {
    var layer = band.layers[name];
    var pop = model.byName[name];
    if (!layer || !layer.weight || !pop) { return; }
    var r = pop.render;
    var L = pointProg.loc;
    var absorb = !!layer.absorb;

    gl.uniform1i(L.u_mode, r.mode);
    gl.uniform1f(L.u_side, r.mode === 2 ? 0 : side);
    gl.uniform1f(L.u_extended, r.extended ? 1 : 0);
    gl.uniform1f(L.u_size, layer.size || r.size);
    gl.uniform1f(L.u_plane, r.shape === 'plane' ? 1 : 0);
    gl.uniform1f(L.u_absorb, absorb ? 1 : 0);
    // Dust multiplies what is there rather than adding to it, so it takes no scaling.
    gl.uniform1f(L.u_gain, layer.weight * rev * (absorb || hdrFloat ? 1 : HDR_SCALE_8BIT));
    gl.uniform1f(L.u_useLut, layer.lut ? 1 : 0);
    var tint = absorb ? layer.absorb : (layer.tint || [1, 1, 1]);
    gl.uniform3f(L.u_tint, tint[0], tint[1], tint[2]);

    if (absorb) {
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    gl.bindVertexArray(vaos[name].vao);
    gl.drawArrays(gl.POINTS, 0, pop.count);
  }

  // Emitters, far to near. The sky is drawn once, first, and dust in between.
  var EMITTERS = ['disc', 'bulge', 'young', 'globular', 'hii'];
  var SOFT = ['diffuse', 'bulgeGlow'];

  // Where the point shader draws to: the size of the target, and its pixels per CSS px.
  function setTarget(L, width, height, px) {
    gl.viewport(0, 0, width, height);
    gl.uniform2f(L.u_halfView, width / 2, height / 2);
    gl.uniform1f(L.u_focal, focalCss() * px);
    gl.uniform1f(L.u_refPx, basePx * px);
    gl.uniform1f(L.u_dpr, px);
  }

  function blit(target) {
    gl.useProgram(blitProg.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(blitProg.loc.u_src, 1);
    gl.uniform2f(blitProg.loc.u_size, canvas.width, canvas.height);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(toneVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(pointProg.prog);
  }

  function render() {
    applyView();
    var rev = easeOut(revealMs / REVEAL_MS);
    var scale = 0.7 + 0.3 * rev;

    // The disc's normal in view space: which side of it the camera is on, how
    // foreshortened it is, and which way that foreshortening points on screen.
    var nx = rot[2], ny = rot[5], nz = rot[8];
    var camSide = nz >= 0 ? 1 : -1;
    var flat = Math.max(0.08, Math.abs(nz));
    var nl = Math.hypot(nx, ny) || 1;

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.clearColor(0, 0, 0, 1);

    gl.useProgram(pointProg.prog);
    var L = pointProg.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.uniform1i(L.u_lut, 0);
    gl.uniform1f(L.u_time, clock);
    gl.uniform1f(L.u_vrot, P.V_ROT);
    gl.uniform1f(L.u_rcore2, P.R_CORE * P.R_CORE);
    gl.uniform1f(L.u_pattern, Model.PATTERN_SPEED);
    gl.uniform1f(L.u_sharp, P.ARM_SHARP);
    gl.uniform1f(L.u_interarm, P.INTERARM);
    gl.uniformMatrix3fv(L.u_rot, false, rotCol);
    gl.uniform1f(L.u_dist, CAMERA_DIST);
    gl.uniform1f(L.u_scale, scale);
    gl.uniform1f(L.u_maxSize, maxPointSize);
    gl.uniform1f(L.u_camSide, camSide);
    gl.uniform1f(L.u_flat, flat);
    gl.uniform2f(L.u_axis, nx / nl, ny / nl);

    // The smooth light, far side then near side, at low resolution.
    var i, s;
    for (s = 0; s < 2; s++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, soft[s].fbo);
      setTarget(L, soft[s].width, soft[s].height, dpr * SOFT_SCALE);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (i = 0; i < SOFT.length; i++) { drawPopulation(SOFT[i], s ? 1 : -1, rev); }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    setTarget(L, canvas.width, canvas.height, dpr);
    gl.clear(gl.COLOR_BUFFER_BIT);

    drawPopulation('sky', 0, rev);
    blit(soft[0]);
    for (i = 0; i < EMITTERS.length; i++) { drawPopulation(EMITTERS[i], -1, rev); }
    drawPopulation('dust', 0, rev);
    blit(soft[1]);
    for (i = 0; i < EMITTERS.length; i++) { drawPopulation(EMITTERS[i], 1, rev); }
    drawSupernovaFlash(scale, rev);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(toneProg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.uniform1i(toneProg.loc.u_hdr, 0);
    gl.uniform1f(toneProg.loc.u_exposure, band.exposure * (hdrFloat ? 1 : 1 / HDR_SCALE_8BIT));
    gl.uniform1f(toneProg.loc.u_stretch, band.stretch);
    gl.uniform1f(toneProg.loc.u_sat, band.saturation);
    gl.uniform3f(toneProg.loc.u_ground, 0.016, 0.018, 0.024);
    gl.bindVertexArray(toneVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    drawOverlay(scale, rev);
  }

  /* ---------- Overlay: rings and the supernova's marks ---------- */

  var ringAlpha = 0;
  var lastInteract = -Infinity;
  var KPC_RINGS = [1 / 3, 2 / 3, 1];

  function drawOverlay(scale, rev) {
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);
    if (ringAlpha > 0.01) { drawRings(scale); }
    drawSupernovaMarks(scale, rev);
  }

  /*
   * The chart graticule: rings at 5, 10 and 15 kpc in the plane of the disc. They
   * only come up while the galaxy is being turned or zoomed, as a sense of which way
   * up it is, and fade once it is let go.
   */
  function drawRings(scale) {
    ctx2.save();
    ctx2.lineWidth = 1;
    ctx2.strokeStyle = 'rgba(210, 200, 175, ' + (0.4 * ringAlpha).toFixed(3) + ')';
    ctx2.fillStyle = 'rgba(210, 200, 175, ' + (0.6 * ringAlpha).toFixed(3) + ')';
    ctx2.setLineDash([2, 7]);
    ctx2.font = '9px "Chivo Mono", "Courier New", monospace';
    ctx2.textBaseline = 'middle';
    var s, j, ang, pen;
    for (s = 0; s < KPC_RINGS.length; s++) {
      var rr = KPC_RINGS[s];
      ctx2.beginPath();
      pen = false;
      for (j = 0; j <= 120; j++) {
        ang = (j / 120) * Math.PI * 2;
        if (!project(rr * Math.cos(ang), rr * Math.sin(ang), 0, scale)) { pen = false; continue; }
        if (!pen) { ctx2.moveTo(projX, projY); pen = true; } else { ctx2.lineTo(projX, projY); }
      }
      ctx2.stroke();
    }
    ctx2.setLineDash([]);
    for (s = 0; s < KPC_RINGS.length; s++) {
      var rl = KPC_RINGS[s];
      if (project(rl * Math.cos(-0.75), rl * Math.sin(-0.75), 0, scale)) {
        ctx2.fillText(Math.round(rl * P.GALAXY_KPC) + ' kpc', projX + 6, projY);
      }
    }
    ctx2.restore();
  }

  /* ---------- Supernovae ---------- */

  /*
   * As on the homepage: now and then a star explodes. Usually a young hot star on an
   * arm crest (core collapse, Type II); now and then an old disc star, standing in for
   * a Type Ia. The star is gone afterwards. Purely illustrative in rate: a galaxy like
   * this has one or two a century, and this has one about a minute.
   */
  var sn = null; // { pop, index, age, type }
  var snNext = 10 + Math.random() * 12;
  var tmp = {};

  function kill(pop, i) {
    pop.phys[i * 4 + 1] = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, vaos[pop.name].buffers[1]);
    gl.bufferSubData(gl.ARRAY_BUFFER, i * 16, pop.phys.subarray(i * 4, i * 4 + 4));
  }

  function igniteSupernova() {
    var young = Math.random() < 0.8;
    var pop = model.byName[young ? 'young' : 'disc'];
    var named = {};
    model.catalogue.forEach(function (c) { if (c.pop === pop.name) { named[c.index] = true; } });
    for (var tries = 0; tries < 600; tries++) {
      var i = Math.floor(Math.random() * pop.count);
      if (named[i] || pop.phys[i * 4 + 1] <= 0 || pop.orbit[i * 4] < 0.12) { continue; }
      Model.evaluate(pop, i, clock, tmp);
      if (tmp.light < 0.9) { continue; }
      if (!project(tmp.x, tmp.y, tmp.z, 1)) { continue; }
      if (projX < 40 || projX > w - 40 || projY < 80 || projY > h - 80) { continue; }
      sn = { pop: pop, index: i, age: 0, type: young ? 'SN II' : 'SN Ia' };
      kill(pop, i);
      return;
    }
    snNext = clock + 3; // nothing suitable in view this time: try again shortly
  }

  function stepSupernova(dt) {
    if (sn) {
      sn.age += dt;
      if (sn.age > SN_LIFE) {
        sn = null;
        snNext = clock + SN_MIN_GAP - Math.log(1 - Math.random()) * SN_MEAN_GAP;
      }
    } else if (clock >= snNext && revealMs >= REVEAL_MS) {
      igniteSupernova();
    }
  }

  // A quarter-second rise, then a fast drop with a slow tail. The shape is the point.
  function snLight(t) {
    if (t < 0.25) { return t / 0.25; }
    var u = t - 0.25;
    return 0.6 * Math.exp(-u / 1.2) + 0.4 * Math.exp(-u / 5);
  }

  var snOrbit = new Float32Array(4), snPhys = new Float32Array(4), snExtra = new Float32Array(4);

  function drawSupernovaFlash(scale, rev) {
    if (!sn) { return; }
    Model.evaluate(sn.pop, sn.index, clock, tmp);
    var Lc = snLight(sn.age) * Math.min(1, (SN_LIFE - sn.age) / 2) * rev;
    snOrbit[0] = tmp.x; snOrbit[1] = tmp.y; snOrbit[2] = tmp.z;
    snPhys[0] = sn.type === 'SN II' ? 14000 : 9000;
    snPhys[1] = SN_PEAK * Lc;
    snPhys[2] = -1; snPhys[3] = 1;
    snExtra[3] = 1.4 + 3 * Lc;
    var b = snVao.buffers;
    gl.bindBuffer(gl.ARRAY_BUFFER, b[0]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, snOrbit);
    gl.bindBuffer(gl.ARRAY_BUFFER, b[1]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, snPhys);
    gl.bindBuffer(gl.ARRAY_BUFFER, b[2]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, snExtra);

    var L = pointProg.loc;
    gl.uniform1i(L.u_mode, 3);
    gl.uniform1f(L.u_side, 0);
    gl.uniform1f(L.u_extended, 0);
    gl.uniform1f(L.u_size, 3);
    gl.uniform1f(L.u_plane, 0);
    gl.uniform1f(L.u_absorb, 0);
    gl.uniform1f(L.u_gain, hdrFloat ? 1 : HDR_SCALE_8BIT);
    gl.uniform1f(L.u_useLut, 1);
    gl.uniform3f(L.u_tint, 1, 1, 1);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(snVao.vao);
    gl.drawArrays(gl.POINTS, 0, 1);
  }

  function drawSupernovaMarks(scale, rev) {
    if (!sn) { return; }
    Model.evaluate(sn.pop, sn.index, clock, tmp);
    if (!project(tmp.x, tmp.y, tmp.z, scale)) { return; }
    var x = projX, y = projY, t = sn.age;
    var Lc = snLight(t) * rev;
    var end = Math.min(1, (SN_LIFE - t) / 2);
    var z = Math.sqrt(zoom);

    ctx2.save();
    ctx2.globalCompositeOperation = 'lighter';

    // Diffraction spikes, as a reflector's secondary-mirror supports draw them.
    var spike = 70 * Lc * z;
    ctx2.globalAlpha = 0.55 * Lc * end;
    ctx2.strokeStyle = 'rgb(236, 228, 210)';
    ctx2.lineWidth = 1;
    ctx2.beginPath();
    ctx2.moveTo(x - spike, y); ctx2.lineTo(x + spike, y);
    ctx2.moveTo(x, y - spike); ctx2.lineTo(x, y + spike);
    ctx2.stroke();

    // The ejecta: a sphere, so a circle from any angle.
    var ring = (5 + t * 11) * z;
    ctx2.globalAlpha = 0.35 * Math.exp(-t / 3) * end;
    ctx2.strokeStyle = 'rgb(160, 196, 255)';
    ctx2.beginPath();
    ctx2.arc(x, y, ring, 0, Math.PI * 2);
    ctx2.stroke();

    // The type, not a designation: a made-up one could collide with a real transient.
    ctx2.globalCompositeOperation = 'source-over';
    ctx2.globalAlpha = Math.min(1, Math.max(0, (t - 0.6) / 0.8)) * end * 0.85;
    ctx2.fillStyle = 'rgb(200, 204, 212)';
    ctx2.font = '9px "Chivo Mono", "Courier New", monospace';
    ctx2.textBaseline = 'middle';
    var label = 'TRANSIENT · ' + sn.type;
    var lw = ctx2.measureText(label).width;
    var lx = x + 16 + lw > w - 8 ? x - 16 - lw : x + 16;
    ctx2.fillText(label, lx, y - 14);
    ctx2.restore();
  }

  /* ---------- Catalogue hover ---------- */

  var pointerX = -1, pointerY = -1, pointerIn = false;
  var hovered = -1;
  var cardW = 0, cardH = 0, cardWhere = '';
  var namedX = new Float32Array(model.catalogue.length);
  var namedY = new Float32Array(model.catalogue.length);
  var namedOk = new Uint8Array(model.catalogue.length);

  function placeNamed(scale) {
    for (var k = 0; k < model.catalogue.length; k++) {
      var c = model.catalogue[k];
      var pop = model.byName[c.pop];
      Model.evaluate(pop, c.index, clock, tmp);
      var ok = tmp.light > 0.5 && pop.phys[c.index * 4 + 1] > 0
        && project(tmp.x, tmp.y, tmp.z, scale);
      namedOk[k] = ok ? 1 : 0;
      namedX[k] = projX;
      namedY[k] = projY;
    }
  }

  function nearest() {
    var limit = HOVER_RADIUS * HOVER_RADIUS;
    var best = -1, bestD = limit, dx, dy, d;
    if (hovered >= 0 && namedOk[hovered]) {
      dx = namedX[hovered] - pointerX;
      dy = namedY[hovered] - pointerY;
      if (dx * dx + dy * dy <= limit * 2.2) { return hovered; }
    }
    for (var k = 0; k < model.catalogue.length; k++) {
      if (!namedOk[k]) { continue; }
      dx = namedX[k] - pointerX;
      dy = namedY[k] - pointerY;
      d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  function setWhere(k) {
    var c = model.catalogue[k];
    var text = Model.locate(model.byName[c.pop], c.index, clock) + ' · ' + c.vc;
    if (text !== cardWhere) {
      cardWhere = text;
      cardRows[2].textContent = text;
    }
  }

  function showCard(k) {
    var c = model.catalogue[k];
    cardId.textContent = c.id;
    cardTag.textContent = c.hot ? 'Young / hot' : 'Field';
    card.classList.toggle('is-hot', c.hot);
    reticle.classList.toggle('is-hot', c.hot);
    cardRows[0].textContent = c.cls + ' · ' + c.teff;
    cardRows[1].textContent = c.mag + ' · R ' + c.radius + ' · z ' + c.height;
    cardWhere = '';
    setWhere(k);
    card.classList.add('is-on');
    reticle.classList.add('is-on');
    cardW = card.offsetWidth;
    cardH = card.offsetHeight;
  }

  function hideCard() {
    card.classList.remove('is-on');
    reticle.classList.remove('is-on');
  }

  function updateHover(scale) {
    if (!card) { return; }
    placeNamed(scale);
    var next = pointerIn && !dragging ? nearest() : -1;
    // A card picked by a tap stays until the star goes dark or another tap moves it.
    if (tapped >= 0 && next < 0) { next = namedOk[tapped] ? tapped : -1; }
    if (next !== hovered) {
      hovered = next;
      if (hovered >= 0) { showCard(hovered); } else { hideCard(); }
    }
    if (hovered < 0) { return; }
    setWhere(hovered);

    var sx = namedX[hovered], sy = namedY[hovered];
    reticle.style.transform = 'translate3d(' + (sx - 11).toFixed(1) + 'px,' + (sy - 11).toFixed(1) + 'px,0)';
    var px, py;
    if (w < 700) {
      px = sx - cardW / 2;
      py = sy + 20 + cardH > h - 60 ? sy - 20 - cardH : sy + 20;
    } else {
      px = sx + 20;
      if (px + cardW > w - 12) { px = sx - 20 - cardW; }
      py = sy - cardH / 2;
    }
    px = Math.min(Math.max(12, px), w - cardW - 12);
    py = Math.min(Math.max(64, py), h - cardH - 12);
    card.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)';
  }

  /* ---------- Readout ---------- */

  var lastHud = 0;

  function updateHud(now) {
    if (!hud || now - lastHud < 140) { return; }
    lastHud = now;
    var nx = rot[2], ny = rot[5], nz = rot[8];
    var incl = Math.acos(Math.max(-1, Math.min(1, -nz))) * 180 / Math.PI;
    var pa = (Math.atan2(ny, nx) * 180 / Math.PI + 360) % 180;
    hud.textContent = 'INCL ' + incl.toFixed(1) + '°'
      + '  ·  PA ' + pa.toFixed(1) + '°'
      + '  ·  ×' + zoom.toFixed(2)
      + '  ·  N ' + Model.thousands(model.stars);
  }

  /* ---------- Band strip ---------- */

  /*
   * Built from the registry. With one band it is a label; once a second band exists it
   * becomes a row of buttons, and choosing one swaps `band` and rebuilds its colours.
   */
  function buildBandStrip() {
    if (!bandStrip) { return; }
    var list = Bands.list();
    bandStrip.textContent = '';
    list.forEach(function (b) {
      var el = document.createElement(list.length > 1 ? 'button' : 'span');
      el.className = 'band' + (b.id === band.id ? ' is-on' : '');
      el.innerHTML = '<span class="band-name"></span><span class="band-range"></span>';
      el.firstChild.textContent = b.label;
      el.lastChild.textContent = b.range;
      if (list.length > 1) {
        el.type = 'button';
        el.setAttribute('aria-pressed', b.id === band.id ? 'true' : 'false');
        el.addEventListener('click', function () { setBand(b.id); });
      }
      bandStrip.appendChild(el);
    });
  }

  function setBand(id) {
    band = Bands.get(id);
    buildLut();
    buildBandStrip();
    dirty = true;
  }

  /* ---------- Loop ---------- */

  var running = false;
  var lastTime = 0;
  var frames = 0;
  var smoothed = 16;

  function tick(now) {
    if (!running) { return; }
    var dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 1 / 60;
    if (lastTime) {
      smoothed += ((now - lastTime) - smoothed) * 0.05;
      frames++;
      // Struggling after warm-up: drop the resolution a step, at most twice.
      if (frames > 120 && smoothed > FRAME_BUDGET_MS && dprCap > 1) {
        dprCap = Math.max(1, dprCap - 0.5);
        frames = 0;
        resize();
      }
    }
    lastTime = now;

    if (!reducedMotion) {
      clock += dt;
      revealMs = Math.min(REVEAL_MS, revealMs + dt * 1000);
      stepSupernova(dt);
      dirty = true;
    }

    // Resetting: ease back to the opening view.
    if (resetFrom) {
      resetT = Math.min(1, resetT + dt * 1000 / RESET_MS);
      var e = resetT < 0.5 ? 4 * resetT * resetT * resetT : 1 - Math.pow(-2 * resetT + 2, 3) / 2;
      view = qslerp(resetFrom, defaultView(), e);
      if (resetT >= 1) { resetFrom = null; }
      dirty = true;
    } else if (!dragging && (spinVel[0] || spinVel[1] || spinVel[2])) {
      // Let go mid-turn: keep turning, slowing down.
      var sp = Math.hypot(spinVel[0], spinVel[1], spinVel[2]);
      if (sp < 0.02 || reducedMotion) {
        spinVel = [0, 0, 0];
      } else {
        turn(spinVel[0] / sp, spinVel[1] / sp, spinVel[2] / sp, sp * dt);
        var k = Math.exp(-SPIN_DECAY * dt);
        spinVel = [spinVel[0] * k, spinVel[1] * k, spinVel[2] * k];
        noteInteraction(now);
      }
      dirty = true;
    }

    if (Math.abs(Math.log(zoomTarget / zoom)) > 0.001) {
      zoom *= Math.pow(zoomTarget / zoom, 1 - Math.exp(-ZOOM_EASE * dt));
      dirty = true;
    } else if (zoom !== zoomTarget) {
      zoom = zoomTarget;
      dirty = true;
    }

    var ringTarget = now - lastInteract < RING_HOLD_MS ? 1 : 0;
    if (Math.abs(ringTarget - ringAlpha) > 0.005) {
      ringAlpha += (ringTarget - ringAlpha) * (1 - Math.exp(-(ringTarget ? 10 : 2.5) * dt));
      dirty = true;
    } else {
      ringAlpha = ringTarget;
    }

    if (dirty) {
      dirty = false;
      render();
      var rev = easeOut(revealMs / REVEAL_MS);
      updateHover(0.7 + 0.3 * rev);
      updateHud(now);
    }
    requestAnimationFrame(tick);
  }

  function start() {
    if (running) { return; }
    running = true;
    lastTime = 0;
    requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
  }

  /* ---------- Input ---------- */

  var pointers = {}; // active pointers by id: { x, y }
  var dragging = false;
  var dragId = -1;
  var downX = 0, downY = 0, downTime = 0, moved = 0;
  var lastMoveTime = 0;
  var pinchDist = 0, pinchAngle = 0;
  var tapped = -1;
  var lastTap = { t: 0, x: 0, y: 0 };

  function noteInteraction(now) {
    lastInteract = now || performance.now();
    if (hint && !hint.classList.contains('is-quiet')) { hint.classList.add('is-quiet'); }
  }

  function pointerCount() {
    return Object.keys(pointers).length;
  }

  function twoPointers() {
    var ids = Object.keys(pointers);
    var a = pointers[ids[0]], b = pointers[ids[1]];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x)
    };
  }

  function local(e) {
    var r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') { return; }
    var p = local(e);
    pointers[e.pointerId] = p;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    resetFrom = null;
    spinVel = [0, 0, 0];

    if (pointerCount() === 1) {
      dragging = true;
      dragId = e.pointerId;
      downX = p.x; downY = p.y; downTime = performance.now();
      moved = 0;
      lastMoveTime = downTime;
    } else if (pointerCount() === 2) {
      var tp = twoPointers();
      pinchDist = tp.dist;
      pinchAngle = tp.angle;
      moved = TAP_SLOP + 1; // two fingers are never a tap
    }
    stage.classList.add('is-grabbing');
    dirty = true;
  }

  function onMove(e) {
    var p = local(e);
    if (e.pointerType === 'mouse') {
      pointerX = p.x;
      pointerY = p.y;
      pointerIn = true;
    }
    var prev = pointers[e.pointerId];
    if (!prev) {
      if (reducedMotion) { dirty = true; }
      return;
    }
    var now = performance.now();

    if (pointerCount() >= 2) {
      pointers[e.pointerId] = p;
      var tp = twoPointers();
      if (pinchDist > 0) {
        zoomTarget = clampZoom(zoomTarget * tp.dist / pinchDist);
        zoom = zoomTarget;
      }
      var da = tp.angle - pinchAngle;
      if (da > Math.PI) { da -= 2 * Math.PI; }
      if (da < -Math.PI) { da += 2 * Math.PI; }
      turn(0, 0, 1, -da);
      pinchDist = tp.dist;
      pinchAngle = tp.angle;
      noteInteraction(now);
      dirty = true;
      return;
    }

    if (e.pointerId !== dragId) { return; }
    var dx = p.x - prev.x, dy = p.y - prev.y;
    pointers[e.pointerId] = p;
    moved = Math.max(moved, Math.hypot(p.x - downX, p.y - downY));
    if (!dx && !dy) { return; }

    // Turn about the screen axis at right angles to the drag, by an amount that feels
    // the same at any zoom: a little less when zoomed in, where a pixel is less sky.
    var len = Math.hypot(dx, dy);
    var angle = len * DRAG_TURN / Math.min(w, h) / Math.pow(zoom, 0.35);
    var ax = dy / len, ay = dx / len;
    turn(ax, ay, 0, angle);

    var dts = Math.max(0.004, (now - lastMoveTime) / 1000);
    var inst = [ax * angle / dts, ay * angle / dts, 0];
    spinVel = [
      spinVel[0] + (inst[0] - spinVel[0]) * 0.5,
      spinVel[1] + (inst[1] - spinVel[1]) * 0.5,
      0
    ];
    lastMoveTime = now;
    noteInteraction(now);
    dirty = true;
  }

  function onUp(e) {
    var p = local(e);
    var had = pointers[e.pointerId];
    delete pointers[e.pointerId];
    var now = performance.now();

    if (pointerCount() === 1) {
      // Back to one finger after a pinch: carry on dragging with the one that is left.
      dragId = Number(Object.keys(pointers)[0]);
      spinVel = [0, 0, 0];
      return;
    }
    if (pointerCount() > 1) { return; }

    dragging = false;
    stage.classList.remove('is-grabbing');
    // Held still before letting go: no fling.
    if (now - lastMoveTime > 80) { spinVel = [0, 0, 0]; }

    // A tap: pick the nearest catalogue star, or clear the card; two quick taps reset.
    if (had && moved <= TAP_SLOP && e.type === 'pointerup' && now - downTime < 500) {
      spinVel = [0, 0, 0];
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
        resetView();
        lastTap.t = 0;
      } else {
        lastTap = { t: now, x: p.x, y: p.y };
        if (e.pointerType !== 'mouse') {
          pointerX = p.x;
          pointerY = p.y;
          pointerIn = true;
          placeNamed(0.7 + 0.3 * easeOut(revealMs / REVEAL_MS));
          hovered = -1;
          tapped = nearest();
          pointerIn = false;
        }
      }
    }
    dirty = true;
  }

  function onLeave(e) {
    if (e.pointerType === 'mouse') {
      pointerIn = false;
      dirty = true;
    }
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  function onWheel(e) {
    e.preventDefault();
    var d = e.deltaY;
    if (e.deltaMode === 1) { d *= 16; } else if (e.deltaMode === 2) { d *= h; }
    // A trackpad pinch arrives as a wheel with ctrlKey, in much smaller steps.
    var k = e.ctrlKey ? 0.01 : 0.0015;
    zoomTarget = clampZoom(zoomTarget * Math.exp(-d * k));
    resetFrom = null;
    noteInteraction();
    dirty = true;
  }

  function resetView() {
    resetFrom = view.slice();
    resetT = 0;
    zoomTarget = 1;
    spinVel = [0, 0, 0];
    tapped = -1;
    noteInteraction();
    dirty = true;
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) { return; }
    var step = 0.08;
    var handled = true;
    switch (e.key) {
      case 'ArrowLeft': turn(0, 1, 0, -step); break;
      case 'ArrowRight': turn(0, 1, 0, step); break;
      case 'ArrowUp': turn(1, 0, 0, -step); break;
      case 'ArrowDown': turn(1, 0, 0, step); break;
      case '+': case '=': zoomTarget = clampZoom(zoomTarget * 1.15); break;
      case '-': case '_': zoomTarget = clampZoom(zoomTarget / 1.15); break;
      case 'r': case 'R': case '0': resetView(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      resetFrom = e.key === 'r' || e.key === 'R' || e.key === '0' ? resetFrom : null;
      noteInteraction();
      dirty = true;
    }
  }

  /* ---------- Boot ---------- */

  function boot() {
    try {
      initGL();
    } catch (err) {
      fail();
      if (window.console) { console.error(err); }
      return;
    }
    resize();
    view = defaultView();
    buildBandStrip();
    document.documentElement.classList.add('is-ready');

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('pointerleave', onLeave);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dblclick', function (e) { e.preventDefault(); resetView(); });
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKey);
    // Safari's own pinch-to-zoom of the page. The galaxy has its own zoom.
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
    });

    var pending = null;
    window.addEventListener('resize', function () {
      window.clearTimeout(pending);
      pending = window.setTimeout(resize, 120);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stop(); } else { start(); }
    });

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      stop();
    });
    canvas.addEventListener('webglcontextrestored', function () {
      lutTex = null;
      hdr = null;
      soft = [null, null];
      initGL();
      resize();
      start();
    });

    start();
  }

  boot();
})();
