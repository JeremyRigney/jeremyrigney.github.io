/*
 * jeremy.ie/galaxy — the renderer, the camera and the controls.
 *
 * Draws the model (galaxy-model.js) through a band (galaxy-bands.js) with WebGL2, in
 * the hero's manner: a survey plot of crisp points, each at its tier's size and
 * brightness, added together on the coal ground, with a soft halo on the brightest.
 *
 * Everything that moves on its own moves in the vertex shader: each star's orbit on
 * the rotation curve, its crowding into the arms, how brightly the wave lights it,
 * the warp it passes through. All of it is worked out there from the clock, so the
 * page uploads the galaxy once and then sends a handful of numbers a frame.
 * GalaxyModel.evaluate() repeats the same arithmetic on the CPU for the few stars the
 * page has to know about (the catalogue, a supernova host).
 *
 * Dust is not drawn; it is subtracted. The shader finds where the line of sight to
 * each star crosses the disc's midplane, reads the dust there (thin, densest in lanes
 * on the inner edge of each arm), and dims the star by that optical depth, more in
 * the blue than the red. Only stars on the far side of the midplane from the camera
 * are behind it, and the path through the layer lengthens as the disc tips, so the
 * lanes are faint face-on and cut a dark line across the bulge edge-on.
 *
 * A frame: the glow (one gradient in the plane of the disc, one facing the viewer over
 * the bulge), then every star, added into a half-float buffer; then a tone map that
 * is linear to 80% and then eases toward white, so a dense core keeps a gradient
 * instead of clipping flat.
 *
 * Depth comes from perspective: stars are drawn larger the nearer they are, so a
 * turned disc has a near edge and a far one, and the thick disc, the halo, the
 * globular clusters and the two satellite galaxies move against each other as it
 * turns. Behind all of it, the
 * sky and the distant galaxies are at infinity: they turn but never move.
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

  var CAMERA_DIST = 3.4; // disc radii from the centre: close enough for real parallax
  var ZOOM_MIN = 0.55;
  var ZOOM_MAX = 3.5;
  var ZOOM_EASE = 9; // per second
  var ZOOM_SIZE = 0.25; // stars grow as zoom^this: a little, so a close view is not dust

  var DRAG_TURN = 1.15; // radians per shorter-screen-dimension of drag
  var SPIN_DECAY = 2.6; // per second, once released
  var RESET_MS = 900;

  var REVEAL_MS = 2200; // as the hero: swell from 70% and fade in
  var HOVER_RADIUS = 22; // CSS px
  var TAP_SLOP = 6; // CSS px a touch may wander and still be a tap
  var RING_HOLD_MS = 1400; // the rings brighten while turning, and this long after

  // The soft light: radii of the hero's haze and core sprites, in disc radii.
  var HAZE_RADIUS = 1.15;
  var CORE_RADIUS = 0.475;

  // The hero's halo on its brightest stars: 16 px across, at 0.85.
  var HALO_PX = 16;
  var HALO_GAIN = 0.85;

  var MAX_PIXELS = 4200000;
  var FRAME_BUDGET_MS = 30;

  // Supernovae, as home-galaxy.js: about one a minute, the first soon after load.
  var SN_MEAN_GAP = 45;
  var SN_MIN_GAP = 20;
  var SN_LIFE = 12;

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
    'uniform float u_time, u_vrot, u_rcore2, u_pattern, u_sharp, u_interarm, u_winding;',
    'uniform float u_jam;',
    'uniform vec4 u_warp;', // amp, r0, r1, node
    'uniform vec4 u_dust;', // tau, lead, sharp, scale
    'uniform vec2 u_dustEdge;', // inner, outer
    'uniform vec3 u_extinct;',
    'uniform vec3 u_cam;', // the camera, in galaxy coordinates
    'uniform mat3 u_rot;',
    'uniform float u_dist, u_focal, u_dpr, u_scale, u_zoom, u_zoomSize, u_maxSize;',
    'uniform vec2 u_halfView;',
    'uniform float u_gain, u_haloPx, u_haloGain;',
    'uniform float u_useLut;',
    'uniform vec3 u_tint;',
    'uniform sampler2D u_lut;',
    'out vec3 v_col;',
    'out vec3 v_haloCol;',
    'out float v_core;',
    'out float v_halo;',
    'out float v_size;',
    'out vec2 v_axis;',
    'out float v_ratio;',
    'out float v_nucleus;',
    '',
    'float omegaAt(float r) { return u_vrot / sqrt(r * r + u_rcore2); }',
    '',
    'float crestAt(float ph) {',
    '  return u_interarm + (1.0 - u_interarm) * exp(u_sharp * (cos(2.0 * ph) - 1.0));',
    '}',
    '',
    'float warpAt(float r, float a) {',
    '  return u_warp.x * smoothstep(u_warp.y, u_warp.z, r) * sin(a - u_warp.w);',
    '}',
    '',
    // Optical depth of the dust layer (z = 0) where the sight line to p crosses it.
    'float dustTau(vec3 p) {',
    '  vec3 c = u_cam;',
    '  if (p.z * c.z >= 0.0) { return 0.0; }', // on the camera's side: in front of it
    '  vec3 d = p - c;',
    '  vec3 x = c + d * (c.z / (c.z - p.z));',
    '  float r = length(x.xy);',
    '  float radial = exp(-r / u_dust.w) * smoothstep(u_dustEdge.x, 2.0 * u_dustEdge.x, r)',
    '    * (1.0 - smoothstep(0.75 * u_dustEdge.y, u_dustEdge.y, r));',
    '  if (radial < 0.001) { return 0.0; }',
    // Its phase in the pattern's frame, and the lane just upstream of the crest.
    '  float ph = atan(x.y, x.x) + u_winding * log(1.0 + 6.0 * r) - u_pattern * u_time;',
    '  float crossing = tanh(3.0 * (omegaAt(r) - u_pattern) / u_pattern);',
    '  float lane = exp(u_dust.z * (cos(2.0 * (ph + u_dust.y * crossing)) - 1.0));',
    '  float mu = abs(d.z) / length(d);',
    '  return u_dust.x * radial * (0.15 + 0.85 * lane) / max(mu, 0.05);',
    '}',
    '',
    'void hide() {',
    '  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '  gl_PointSize = 0.0;',
    '  v_col = vec3(0.0); v_haloCol = vec3(0.0);',
    '  v_core = 0.0; v_halo = 0.0; v_size = 1.0;',
    '  v_axis = vec2(1.0, 0.0); v_ratio = 1.0; v_nucleus = 0.0;',
    '}',
    '',
    'void main() {',
    '  vec3 p = vec3(0.0);',
    '  float light = 1.0;',
    '  if (u_mode == 0) {',
    // The disc: an orbit on the rotation curve, crowding into and lit by the wave.
    '    float r = a_orbit.x;',
    '    float w = omegaAt(r);',
    '    float psi = a_orbit.w + (w - u_pattern) * u_time;',
    '    float ph = psi - 0.5 * u_jam * sin(2.0 * psi);',
    '    float a = a_orbit.y + w * u_time + (ph - psi);',
    '    light = a_phys.w + (1.0 - a_phys.w) * smoothstep(a_phys.z - 0.16, a_phys.z, crestAt(ph));',
    '    p = vec3(r * cos(a), r * sin(a), a_orbit.z + warpAt(r, a));',
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
    '',
    '  vec3 v;',
    '  float near = 1.0;',
    '  if (u_mode == 2 || u_mode == 4) {',
    // The sky is at infinity: it turns with the camera but never gets closer.
    '    v = u_rot * a_orbit.xyz;',
    '    if (v.z >= -0.01) { hide(); return; }',
    '  } else {',
    '    v = u_rot * (p * u_scale);',
    '    v.z -= u_dist;',
    '    if (v.z > -0.05) { hide(); return; }',
    '    near = u_dist / -v.z;',
    '  }',
    '  gl_Position = vec4(v.xy * (u_focal / -v.z) / u_halfView, 0.0, 1.0);',
    '',
    '  vec3 colour = u_tint;',
    '  if (u_useLut > 0.5) {',
    '    float x = clamp((log(max(a_phys.x, 1.0)) - 7.6) / 3.0, 0.0, 1.0);',
    '    colour *= texture(u_lut, vec2(x, 0.5)).rgb;',
    '  }',
    '  vec3 ext = vec3(1.0);',
    '  if (u_mode == 0 || u_mode == 1) { ext = exp(-dustTau(p) * u_extinct); }',
    '',
    '  if (u_mode == 4) {',
    // A distant galaxy: an ellipse whose major axis is a direction on the sky, turned
    // onto the screen the way a short line there would project. It magnifies with the
    // zoom, as anything with a real angular size does.
    '    vec3 t = u_rot * a_extra.xyz;',
    '    vec2 ax = t.xy * -v.z + v.xy * t.z;',
    '    v_axis = length(ax) > 1e-6 ? normalize(ax) : vec2(1.0, 0.0);',
    '    v_ratio = a_phys.z;',
    '    v_nucleus = a_phys.w;',
    '    v_size = min(a_extra.w * u_dpr * u_zoom, u_maxSize);',
    '    gl_PointSize = v_size;',
    '    v_col = colour * u_gain * a_phys.y;',
    '    v_haloCol = vec3(0.0);',
    '    v_core = 0.0;',
    '    v_halo = 0.0;',
    '    return;',
    '  }',
    '',
    '  float grow = u_dpr * near * u_zoomSize;',
    '  float core = clamp(a_extra.w * grow, 0.5 * u_dpr, 7.0 * u_dpr);',
    '  float halo = a_extra.w > 2.0 ? u_haloPx * grow : 0.0;',
    '  float size = min(max(ceil(core) + 2.0, halo), u_maxSize);',
    '  gl_PointSize = size;',
    '  v_col = colour * ext * (u_gain * a_phys.y * light);',
    // The halo only on a star that is fully lit, as the hero draws it.
    '  v_haloCol = colour * ext * (u_gain * u_haloGain * smoothstep(0.85, 1.0, light));',
    '  v_core = core;',
    '  v_halo = halo;',
    '  v_size = size;',
    '  v_axis = vec2(1.0, 0.0);',
    '  v_ratio = 1.0;',
    '  v_nucleus = 0.0;',
    '}'
  ].join('\n');

  /*
   * The hero draws each star as a fillRect, which the canvas anti-aliases. This is
   * the same: the fraction of each pixel the star's square covers, worked out from its
   * exact position, so a star moving a tenth of a pixel moves a tenth of a pixel
   * instead of snapping between them. Larger ones (close up) are round.
   */
  var POINT_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 v_col;',
    'in vec3 v_haloCol;',
    'in float v_core;',
    'in float v_halo;',
    'in float v_size;',
    'in vec2 v_axis;',
    'in float v_ratio;',
    'in float v_nucleus;',
    'uniform float u_shape;',
    'out vec4 o;',
    'void main() {',
    '  if (u_shape > 0.5) {',
    // A distant galaxy: a soft ellipse, brighter to the middle, some with a nucleus.
    '    vec2 q = (gl_PointCoord - 0.5) * 2.0;',
    '    q.y = -q.y;',
    '    float al = dot(q, v_axis);',
    '    float pe = dot(q, vec2(-v_axis.y, v_axis.x)) / v_ratio;',
    '    float d2 = al * al + pe * pe;',
    '    if (d2 >= 1.0) { discard; }',
    '    float g = (exp(-5.0 * d2) + v_nucleus * exp(-60.0 * d2)) * (1.0 - d2);',
    '    o = vec4(v_col * g, 1.0);',
    '    return;',
    '  }',
    '  vec2 u = (gl_PointCoord - 0.5) * v_size;',
    '  float hs = 0.5 * v_core;',
    '  float cov;',
    '  if (v_core > 2.6) {',
    '    cov = clamp(hs + 0.5 - length(u), 0.0, 1.0);',
    '  } else {',
    '    float ox = clamp(min(u.x + 0.5, hs) - max(u.x - 0.5, -hs), 0.0, 1.0);',
    '    float oy = clamp(min(u.y + 0.5, hs) - max(u.y - 0.5, -hs), 0.0, 1.0);',
    '    cov = ox * oy;',
    '  }',
    '  vec3 c = v_col * cov;',
    '  if (v_halo > 0.0) {',
    // The hero's halo gradient: 0.55 at the centre, 0.16 a third of the way out, 0.
    '    float d = length(u) / (0.5 * v_halo);',
    '    float g = d < 0.35 ? mix(0.55, 0.16, d / 0.35)',
    '      : mix(0.16, 0.0, clamp((d - 0.35) / 0.65, 0.0, 1.0));',
    '    c += v_haloCol * g;',
    '  }',
    '  o = vec4(c, 1.0);',
    '}'
  ].join('\n');

  // The soft light: a quad, either lying in the disc (kind 0) or facing the viewer.
  var GLOW_VS = [
    '#version 300 es',
    'precision highp float;',
    'layout(location = 0) in vec2 a_corner;',
    'uniform int u_kind;',
    'uniform float u_radius, u_scale, u_dist, u_focal;',
    'uniform mat3 u_rot;',
    'uniform vec2 u_halfView;',
    'out vec2 v_uv;',
    'void main() {',
    '  vec3 v = u_kind == 0',
    '    ? u_rot * vec3(a_corner * u_radius * u_scale, 0.0)',
    '    : vec3(a_corner * u_radius * u_scale, 0.0);',
    '  v.z -= u_dist;',
    '  v_uv = a_corner;',
    '  gl_Position = vec4(v.xy * u_focal / u_halfView, 0.0, -v.z);',
    '}'
  ].join('\n');

  var GLOW_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 v_uv;',
    'uniform sampler2D u_grad;',
    'uniform float u_gain;',
    'out vec4 o;',
    'void main() {',
    '  float d = length(v_uv);',
    '  if (d >= 1.0) { discard; }',
    '  vec4 g = texture(u_grad, vec2(d, 0.5));',
    '  o = vec4(g.rgb * g.a * u_gain, 1.0);',
    '}'
  ].join('\n');

  var TONE_VS = [
    '#version 300 es',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Linear to 0.8, as the hero's canvas adds light, then eased toward 1 rather than clipped.
  var TONE_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_hdr;',
    'uniform float u_exposure;',
    'uniform vec3 u_ground;',
    'out vec4 o;',
    'void main() {',
    '  vec3 c = max(texelFetch(u_hdr, ivec2(gl_FragCoord.xy), 0).rgb, 0.0) * u_exposure;',
    '  vec3 k = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));',
    '  c = mix(c, k, step(0.8, c));',
    '  o = vec4(u_ground + c * (1.0 - u_ground), 1.0);',
    '}'
  ].join('\n');

  /*
   * The H-alpha glow, marched through the gas layer for every pixel. The ionised gas is
   * a thin sheet in the midplane (a Gaussian of scale height h), and what a pixel sees
   * is the line integral of its emission along the camera ray: short face-on, long
   * edge-on. Nothing is drawn as sprites; the glow is a formula (GalaxyModel.halpha)
   * sampled where the ray is inside the sheet, so it is smooth at any angle.
   *
   * The ring is thin, so the samples are split: 12 along the part of the ray inside
   * the sheet and the disc, for the arms, and 6 in each stretch of it within reach of
   * the ring and its haze, so an edge-on view still catches it. The nucleus is a 3D
   * Gaussian and is integrated exactly, from the ray's closest approach.
   *
   * A long edge-on path would pile up far past anything seen face-on, and in a real
   * galaxy the dust in the same layer takes most of that out; so the total is rolled
   * off toward `u_cap` as an optically thick line would be.
   */
  var HALPHA_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform mat3 u_rot;',
    'uniform vec3 u_cam;',
    'uniform vec2 u_halfView;',
    'uniform float u_px, u_focal, u_time, u_vrot, u_rcore2, u_pattern, u_winding;',
    'uniform vec4 u_ring;', // radius, width, axis ratio, angle
    'uniform float u_ringGain, u_clump;',
    'uniform vec2 u_nucleus;', // gain, radius
    'uniform vec3 u_arms;', // gain, lag, sharp
    'uniform float u_h, u_cap, u_gain;',
    'uniform vec3 u_colour;',
    'out vec4 o;',
    '',
    'float omegaAt(float r) { return u_vrot / sqrt(r * r + u_rcore2); }',
    'vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }',
    'float hash(vec2 p) {',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
    '    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p) {',
    '  float a = 0.5, s = 0.0;',
    '  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }',
    '  return s / 0.875;',
    '}',
    '',
    // The ring, in the frame of its own gas, which turns at the ring's orbital speed:
    // a slightly oval band, broken into knots, with fog between them.
    'float ringAt(vec2 x) {',
    '  vec2 g = rot2(x, -omegaAt(u_ring.x) * u_time);',
    '  vec2 q = rot2(g, -u_ring.w);',
    '  float sq = sqrt(u_ring.z);',
    '  float rho = length(vec2(q.x * sq, q.y / sq));',
    '  float d = (rho - u_ring.x) / u_ring.y;',
    '  float knots = mix(1.0, 2.4 * smoothstep(0.36, 0.82, fbm(g * 40.0)), u_clump);',
    '  float fog = 0.7 + 0.6 * fbm(g * 9.0 + 3.1);',
    // The knotted band itself, and a wider, smooth haze of gas it sits in.
    '  float band = exp(-d * d) * knots + 0.45 * exp(-d * d / 6.25);',
    '  return u_ringGain * band * fog;',
    '}',
    '',
    // HII regions on the arms: just downstream of the stellar crest (the side gas leaves
    // the arm by, having formed stars in it), in patches that belong to the pattern, so
    // they hold their place on the arm instead of winding up.
    'float armsAt(vec2 x) {',
    '  float r = length(x);',
    '  float win = smoothstep(0.17, 0.28, r) * (1.0 - smoothstep(0.85, 1.08, r));',
    '  if (win <= 0.0) { return 0.0; }',
    '  float ph = atan(x.y, x.x) + u_winding * log(1.0 + 6.0 * r) - u_pattern * u_time;',
    '  float crossing = tanh(3.0 * (omegaAt(r) - u_pattern) / u_pattern);',
    '  float arm = exp(u_arms.z * (cos(2.0 * (ph - u_arms.y * crossing)) - 1.0));',
    '  vec2 pp = rot2(x, -u_pattern * u_time);',
    '  float clumps = smoothstep(0.4, 0.8, fbm(pp * 24.0));',
    '  float fog = 0.6 + 0.8 * fbm(pp * 5.0 + 7.7);',
    '  return u_arms.x * win * arm * (0.2 + 0.8 * clumps) * fog * exp(-(r - 0.2) / 0.7);',
    '}',
    '',
    // Where along the ray (s) its path over the disc lies within radius q of the centre.
    'vec2 within(vec3 c, vec3 d, float q) {',
    '  float A = dot(d.xy, d.xy), B = 2.0 * dot(c.xy, d.xy), C = dot(c.xy, c.xy) - q * q;',
    '  if (A < 1e-9) { return C < 0.0 ? vec2(-1e9, 1e9) : vec2(1.0, -1.0); }',
    '  float disc = B * B - 4.0 * A * C;',
    '  if (disc < 0.0) { return vec2(1.0, -1.0); }',
    '  float sq = sqrt(disc);',
    '  return vec2((-B - sq) / (2.0 * A), (-B + sq) / (2.0 * A));',
    '}',
    '',
    'float sheet(float z) { return exp(-0.5 * z * z / (u_h * u_h)) / (2.5066 * u_h); }',
    '',
    // March a stretch [a, b] of the ray with n jittered samples of either the ring
    // (which == 0) or the arms (which == 1).
    'float march(vec3 c, vec3 d, float a, float b, int n, int which, float jit) {',
    '  if (b <= a) { return 0.0; }',
    '  float ds = (b - a) / float(n);',
    '  float sum = 0.0;',
    '  for (int i = 0; i < 16; i++) {',
    '    if (i >= n) { break; }',
    '    vec3 x = c + d * (a + (float(i) + jit) * ds);',
    '    float e = which == 0 ? ringAt(x.xy) : armsAt(x.xy);',
    '    sum += e * sheet(x.z);',
    '  }',
    '  return sum * ds;',
    '}',
    '',
    'void main() {',
    '  vec3 dv = vec3((gl_FragCoord.xy * u_px - u_halfView) / u_focal, -1.0);',
    '  vec3 d = normalize(transpose(u_rot) * dv);',
    '  vec3 c = u_cam;',
    '  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '',
    // The stretch of the ray inside the sheet (to 3 scale heights) and over the disc.
    '  float z3 = 3.0 * u_h;',
    '  vec2 slab;',
    '  if (abs(d.z) > 1e-6) {',
    '    float s1 = (-z3 - c.z) / d.z, s2 = (z3 - c.z) / d.z;',
    '    slab = vec2(min(s1, s2), max(s1, s2));',
    '  } else {',
    '    slab = abs(c.z) < z3 ? vec2(0.0, 1e9) : vec2(1.0, -1.0);',
    '  }',
    '  slab.x = max(slab.x, 0.0);',
    '  vec2 disc = within(c, d, 1.1);',
    '  vec2 seg = vec2(max(slab.x, disc.x), min(slab.y, disc.y));',
    '',
    '  float I = 0.0;',
    '  if (seg.y > seg.x) {',
    '    I += march(c, d, seg.x, seg.y, 12, 1, jit);',
    // The ring's reach (its haze runs to about six widths), in up to two pieces:
    // inside its outer edge but not its inner one.
    '    vec2 outer = within(c, d, u_ring.x + 6.0 * u_ring.y);',
    '    vec2 inner = within(c, d, max(u_ring.x - 6.0 * u_ring.y, 0.0));',
    '    float oa = max(outer.x, seg.x), ob = min(outer.y, seg.y);',
    '    if (inner.y > inner.x) {',
    '      I += march(c, d, oa, min(ob, inner.x), 6, 0, jit);',
    '      I += march(c, d, max(oa, inner.y), ob, 6, 0, jit);',
    '    } else {',
    '      I += march(c, d, oa, ob, 12, 0, jit);',
    '    }',
    '  }',
    '',
    // The nucleus: a 3D Gaussian, integrated along the ray from its closest approach.
    '  float sc = max(-dot(c, d), 0.0);',
    '  vec3 closest = c + d * sc;',
    '  float rn = u_nucleus.y;',
    '  I += u_nucleus.x * exp(-dot(closest, closest) / (rn * rn));',
    '',
    '  I = u_cap * (1.0 - exp(-I / u_cap));',
    '  vec3 col = u_colour * I + vec3(0.1, 0.22, 0.24) * I * I * 0.05;',
    '  o = vec4(col * u_gain, 1.0);',
    '}'
  ].join('\n');

  // Adds a lower-resolution buffer into the one bound, filtered up to its size.
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
  var WARP = Model.warp;
  var DUST = Model.dust;

  /* ---------- GL resources ---------- */

  var pointProg, glowProg, toneProg, halphaProg, blitProg;
  var vaos = {}; // population name -> { vao, buffers }
  var snVao;
  var quadVao, toneVao;
  var lutTex, hazeTex, coreTex;
  var hdr = null, hdrFloat = false;
  var fog = null; // the H-alpha glow, at FOG_SCALE of the full resolution
  var FOG_SCALE = 0.5;
  var maxPointSize = 64;

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

  function makeQuad() {
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  function texture1d(px, n, old) {
    if (old) { gl.deleteTexture(old); }
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // The band's colour(teff), sampled on a log scale from 2,000 K to 40,000 K.
  function buildLut() {
    var N = 256;
    var px = new Uint8Array(N * 4);
    for (var i = 0; i < N; i++) {
      var c = band.colour(Math.exp(7.6 + 3 * i / (N - 1)));
      px[i * 4] = Math.round(c[0] * 255);
      px[i * 4 + 1] = Math.round(c[1] * 255);
      px[i * 4 + 2] = Math.round(c[2] * 255);
      px[i * 4 + 3] = 255;
    }
    lutTex = texture1d(px, N, lutTex);
  }

  // A glow's stops as a 1D texture: colour in RGB, the stop's alpha in A.
  function gradient(stops, old) {
    var N = 128;
    var px = new Uint8Array(N * 4);
    for (var i = 0; i < N; i++) {
      var t = i / (N - 1);
      var k = 1;
      while (k < stops.length - 1 && stops[k][0] < t) { k++; }
      var s0 = stops[k - 1], s1 = stops[k];
      var f = Math.min(1, Math.max(0, (t - s0[0]) / ((s1[0] - s0[0]) || 1)));
      for (var ch = 0; ch < 3; ch++) {
        px[i * 4 + ch] = Math.round(s0[1][ch] + (s1[1][ch] - s0[1][ch]) * f);
      }
      px[i * 4 + 3] = Math.round((s0[2] + (s1[2] - s0[2]) * f) * 255);
    }
    return texture1d(px, N, old);
  }

  function buildBandTextures() {
    buildLut();
    hazeTex = gradient(band.glow.haze, hazeTex);
    coreTex = gradient(band.glow.core, coreTex);
  }

  /*
   * The accumulation buffer: half float where the device can render to it, which is
   * nearly everywhere, so the dense core can sum past white and be eased back down;
   * otherwise 8-bit, where it simply clips, as the hero's canvas does.
   */
  function probeFloat() {
    hdrFloat = !!(gl.getExtension('EXT_color_buffer_float')
      || gl.getExtension('EXT_color_buffer_half_float'));
    if (!hdrFloat) { return; }
    var t = makeTarget(4, 4, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    hdrFloat = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  function makeTarget(width, height, old, filter) {
    var t = old || { tex: null, fbo: gl.createFramebuffer() };
    if (t.tex) { gl.deleteTexture(t.tex); }
    t.tex = gl.createTexture();
    t.width = width;
    t.height = height;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (hdrFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  }

  function buildTarget() {
    hdr = makeTarget(canvas.width, canvas.height, hdr);
    fog = makeTarget(Math.max(1, Math.ceil(canvas.width * FOG_SCALE)),
      Math.max(1, Math.ceil(canvas.height * FOG_SCALE)), fog, gl.LINEAR);
  }

  function initGL() {
    pointProg = program(POINT_VS, POINT_FS);
    glowProg = program(GLOW_VS, GLOW_FS);
    toneProg = program(TONE_VS, TONE_FS);
    halphaProg = program(TONE_VS, HALPHA_FS);
    blitProg = program(TONE_VS, BLIT_FS);
    toneVao = gl.createVertexArray();
    quadVao = makeQuad();

    vaos = {};
    model.populations.forEach(function (pop) {
      vaos[pop.name] = makeVao(pop.orbit, pop.phys, pop.extra);
    });
    snVao = makeVao(new Float32Array(4), new Float32Array(4), new Float32Array(4), gl.DYNAMIC_DRAW);

    var range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    maxPointSize = range ? range[1] : 64;

    buildBandTextures();
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

  var dirty = true;

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
    // Radius 1 on screen. The disc runs on past it, thinning out.
    basePx = narrow ? Math.min(w * 0.66, h * 0.42) : Math.min(w * 0.34, h * 0.56);

    if (gl && !gl.isContextLost()) { buildTarget(); }
    dirty = true;
  }

  /* ---------- Drawing ---------- */

  var clock = 0;
  var revealMs = reducedMotion ? REVEAL_MS : 0;

  function easeOut(t) {
    t = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - t, 3);
  }

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // How far a population that only shows zoomed in has come in, 0-1.
  function revealed(pop) {
    var rv = pop.render.reveal;
    return rv ? smoothstep(rv[0], rv[1], zoom) : 1;
  }

  function drawPopulation(name, rev) {
    var pop = model.byName[name];
    var weight = band.layers[name];
    if (!pop || !weight) { return; }
    var fade = revealed(pop);
    if (fade < 0.01) { return; }
    var L = pointProg.loc;
    gl.uniform1i(L.u_mode, pop.render.mode);
    gl.uniform1f(L.u_shape, pop.render.mode === 4 ? 1 : 0);
    gl.uniform1f(L.u_jam, pop.render.jam || 0);
    gl.uniform1f(L.u_gain, weight * rev * fade * starDim());
    gl.uniform1f(L.u_useLut, 1);
    gl.uniform3f(L.u_tint, 1, 1, 1);
    gl.uniform1f(L.u_haloPx, HALO_PX);
    gl.uniform1f(L.u_haloGain, HALO_GAIN);
    gl.bindVertexArray(vaos[name].vao);
    gl.drawArrays(gl.POINTS, 0, pop.count);
  }

  function drawGlow(kind, radius, tex, gain) {
    gl.uniform1i(glowProg.loc.u_kind, kind);
    gl.uniform1f(glowProg.loc.u_radius, radius);
    gl.uniform1f(glowProg.loc.u_gain, gain);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(glowProg.loc.u_grad, 0);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  var DRAW_ORDER = ['distant', 'sky', 'halo', 'globular', 'satellites', 'faint', 'disc', 'bulge', 'young'];

  function render() {
    applyView();
    var rev = easeOut(revealMs / REVEAL_MS);
    var scale = 0.7 + 0.3 * rev;
    var focal = focalCss() * dpr;

    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    // The soft light first: the haze in the plane of the disc, the core over the bulge.
    gl.useProgram(glowProg.prog);
    var G = glowProg.loc;
    gl.uniformMatrix3fv(G.u_rot, false, rotCol);
    gl.uniform1f(G.u_scale, scale);
    gl.uniform1f(G.u_dist, CAMERA_DIST);
    gl.uniform1f(G.u_focal, focal);
    gl.uniform2f(G.u_halfView, canvas.width / 2, canvas.height / 2);
    drawGlow(0, HAZE_RADIUS, hazeTex, rev);
    drawGlow(1, CORE_RADIUS, coreTex, rev);

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
    gl.uniform1f(L.u_winding, P.ARM_WINDING);
    gl.uniform4f(L.u_warp, WARP.amp, WARP.r0, WARP.r1, WARP.node);
    gl.uniform4f(L.u_dust, DUST.tau, DUST.lead, DUST.sharp, DUST.scale);
    gl.uniform2f(L.u_dustEdge, DUST.inner, DUST.outer);
    gl.uniform3f(L.u_extinct, band.extinction[0], band.extinction[1], band.extinction[2]);
    // The camera in galaxy coordinates: the view's third row, out to its distance.
    gl.uniform3f(L.u_cam, rot[6] * CAMERA_DIST / scale, rot[7] * CAMERA_DIST / scale,
      rot[8] * CAMERA_DIST / scale);
    gl.uniformMatrix3fv(L.u_rot, false, rotCol);
    gl.uniform1f(L.u_dist, CAMERA_DIST);
    gl.uniform1f(L.u_focal, focal);
    gl.uniform1f(L.u_dpr, dpr);
    gl.uniform1f(L.u_scale, scale);
    gl.uniform1f(L.u_zoom, zoom);
    gl.uniform1f(L.u_zoomSize, Math.pow(zoom, ZOOM_SIZE));
    gl.uniform1f(L.u_maxSize, maxPointSize);
    gl.uniform2f(L.u_halfView, canvas.width / 2, canvas.height / 2);

    for (var i = 0; i < DRAW_ORDER.length; i++) { drawPopulation(DRAW_ORDER[i], rev); }
    drawSupernovaFlash(rev);
    drawHalpha(scale, rev, focal);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(toneProg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.uniform1i(toneProg.loc.u_hdr, 0);
    gl.uniform1f(toneProg.loc.u_exposure, band.exposure);
    // The coal ground, #111214, in linear-ish 0-1.
    gl.uniform3f(toneProg.loc.u_ground, 17 / 255, 18 / 255, 20 / 255);
    gl.bindVertexArray(toneVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    drawOverlay(scale, rev);
  }

  /* ---------- Overlays: emission added to the band ---------- */

  /*
   * Each overlay in GalaxyBands.overlays() is on or off, and fades between the two;
   * `overlayAmount` is how far each has come. Only H-alpha exists, drawn by drawHalpha.
   */
  var OVERLAY_FADE = 1.4; // per second: about 700 ms from off to on
  var overlayOn = {};
  var overlayAmount = {};
  Bands.overlays().forEach(function (ov) { overlayOn[ov.id] = false; overlayAmount[ov.id] = 0; });

  function overlayById(id) {
    var list = Bands.overlays();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }

  // How much the stars are dimmed while overlays are showing: the strongest one's say.
  function starDim() {
    var k = 1;
    Bands.overlays().forEach(function (ov) {
      k = Math.min(k, 1 - (1 - ov.dimStars) * overlayAmount[ov.id]);
    });
    return k;
  }

  function toggleOverlay(id) {
    overlayOn[id] = !overlayOn[id];
    if (reducedMotion) { overlayAmount[id] = overlayOn[id] ? 1 : 0; }
    buildBandStrip();
    lastHud = 0;
    dirty = true;
  }

  function stepOverlays(dt) {
    var moving = false;
    Object.keys(overlayOn).forEach(function (id) {
      var target = overlayOn[id] ? 1 : 0;
      var a = overlayAmount[id];
      if (a !== target) {
        a += (target > a ? 1 : -1) * OVERLAY_FADE * dt;
        overlayAmount[id] = Math.min(1, Math.max(0, a));
        if (target === 0 ? overlayAmount[id] <= 0 : overlayAmount[id] >= 1) {
          overlayAmount[id] = target;
        }
        moving = true;
      }
    });
    return moving;
  }

  function drawHalpha(scale, rev, focal) {
    var amount = overlayAmount.halpha;
    var ov = overlayById('halpha');
    if (!ov || !(amount > 0)) { return; }
    var H = Model.halpha;
    var eased = amount * amount * (3 - 2 * amount);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fog.fbo);
    gl.viewport(0, 0, fog.width, fog.height);
    gl.disable(gl.BLEND);
    gl.useProgram(halphaProg.prog);
    var L = halphaProg.loc;
    gl.uniformMatrix3fv(L.u_rot, false, rotCol);
    gl.uniform3f(L.u_cam, rot[6] * CAMERA_DIST / scale, rot[7] * CAMERA_DIST / scale,
      rot[8] * CAMERA_DIST / scale);
    gl.uniform2f(L.u_halfView, canvas.width / 2, canvas.height / 2);
    gl.uniform1f(L.u_px, canvas.width / fog.width);
    gl.uniform1f(L.u_focal, focal);
    gl.uniform1f(L.u_time, clock);
    gl.uniform1f(L.u_vrot, P.V_ROT);
    gl.uniform1f(L.u_rcore2, P.R_CORE * P.R_CORE);
    gl.uniform1f(L.u_pattern, Model.PATTERN_SPEED);
    gl.uniform1f(L.u_winding, P.ARM_WINDING);
    gl.uniform4f(L.u_ring, H.ring.r, H.ring.width, H.ring.axis, H.ring.angle);
    gl.uniform1f(L.u_ringGain, H.ring.gain);
    gl.uniform1f(L.u_clump, H.clump);
    gl.uniform2f(L.u_nucleus, H.nucleus.gain, H.nucleus.r);
    gl.uniform3f(L.u_arms, H.arms.gain, H.arms.lag, H.arms.sharp);
    gl.uniform1f(L.u_h, H.thickness);
    gl.uniform1f(L.u_cap, 3);
    gl.uniform1f(L.u_gain, ov.gain * eased * rev);
    gl.uniform3f(L.u_colour, ov.colour[0], ov.colour[1], ov.colour[2]);
    gl.bindVertexArray(toneVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Filtered up into the main buffer, added to the stars.
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(blitProg.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fog.tex);
    gl.uniform1i(blitProg.loc.u_src, 1);
    gl.uniform2f(blitProg.loc.u_size, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  /* ---------- Overlay: the graticule and the supernova's marks ---------- */

  var ringAlpha = 0;
  var lastInteract = -Infinity;
  var KPC_RINGS = [1 / 3, 2 / 3, 1, 4 / 3];

  function drawOverlay(scale, rev) {
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);
    drawRings(scale, rev);
    drawSupernovaMarks(scale, rev);
  }

  /*
   * The chart graticule, as the hero's: dashed rings at 5, 10, 15 and 20 kpc in the
   * plane of the disc, faint always, and brighter while the galaxy is being turned or
   * zoomed, as a sense of which way up it is.
   */
  function drawRings(scale, rev) {
    var a = (0.16 + 0.22 * ringAlpha) * rev;
    ctx2.save();
    ctx2.lineWidth = 1;
    ctx2.strokeStyle = 'rgba(110, 138, 120, ' + a.toFixed(3) + ')';
    ctx2.fillStyle = 'rgba(142, 172, 152, ' + (a * 3).toFixed(3) + ')';
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
    // Labels on a fixed bearing in the disc, so they tip and turn with it.
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

  // The flash: a white point with the hero's halo, swelling to 124 px at peak.
  function drawSupernovaFlash(rev) {
    if (!sn) { return; }
    Model.evaluate(sn.pop, sn.index, clock, tmp);
    var Lc = snLight(sn.age) * Math.min(1, (SN_LIFE - sn.age) / 2) * rev;
    snOrbit[0] = tmp.x; snOrbit[1] = tmp.y; snOrbit[2] = tmp.z;
    snPhys[0] = 6000; snPhys[1] = Math.min(1, Lc * 1.2); snPhys[2] = -1; snPhys[3] = 1;
    snExtra[3] = 3;
    var b = snVao.buffers;
    gl.bindBuffer(gl.ARRAY_BUFFER, b[0]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, snOrbit);
    gl.bindBuffer(gl.ARRAY_BUFFER, b[1]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, snPhys);
    gl.bindBuffer(gl.ARRAY_BUFFER, b[2]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, snExtra);

    var L = pointProg.loc;
    gl.uniform1i(L.u_mode, 3);
    gl.uniform1f(L.u_shape, 0);
    gl.uniform1f(L.u_gain, 1);
    gl.uniform1f(L.u_useLut, 0);
    gl.uniform3f(L.u_tint, 1, 0.98, 0.94);
    gl.uniform1f(L.u_haloPx, 14 + 110 * Lc);
    gl.uniform1f(L.u_haloGain, 1.4);
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
    ctx2.strokeStyle = 'rgb(226, 222, 208)';
    ctx2.lineWidth = 1;
    ctx2.beginPath();
    ctx2.moveTo(x - spike, y); ctx2.lineTo(x + spike, y);
    ctx2.moveTo(x, y - spike); ctx2.lineTo(x, y + spike);
    ctx2.stroke();

    // The ejecta: a sphere, so a circle from any angle.
    var ring = (5 + t * 11) * z;
    ctx2.globalAlpha = 0.35 * Math.exp(-t / 3) * end;
    ctx2.strokeStyle = 'rgb(72, 190, 176)';
    ctx2.beginPath();
    ctx2.arc(x, y, ring, 0, Math.PI * 2);
    ctx2.stroke();

    // The type, not a designation: a made-up one could collide with a real transient.
    ctx2.globalCompositeOperation = 'source-over';
    ctx2.globalAlpha = Math.min(1, Math.max(0, (t - 0.6) / 0.8)) * end;
    ctx2.fillStyle = 'rgb(142, 172, 152)';
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
  var tapped = -1;
  var dragging = false;
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

  // Stars on screen: all but the sky's, the zoom-only ones as far as they are shown.
  function starsShown() {
    var n = 0;
    model.populations.forEach(function (pop) {
      if (pop.render.mode < 2 && band.layers[pop.name]) {
        n += Math.round(pop.count * revealed(pop));
      }
    });
    return n;
  }

  function updateHud(now) {
    if (!hud || now - lastHud < 140) { return; }
    lastHud = now;
    var nx = rot[2], ny = rot[5], nz = rot[8];
    var incl = Math.acos(Math.max(-1, Math.min(1, -nz))) * 180 / Math.PI;
    var pa = (Math.atan2(ny, nx) * 180 / Math.PI + 360) % 180;
    hud.textContent = 'INCL ' + incl.toFixed(1) + '°'
      + '  ·  PA ' + pa.toFixed(1) + '°'
      + '  ·  ×' + zoom.toFixed(2)
      + '  ·  N ' + Model.thousands(starsShown())
      + Bands.overlays().map(function (ov) {
        return overlayOn[ov.id] ? '  ·  ' + ov.label : '';
      }).join('');
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
    // Then a toggle for each overlay, which adds to the band rather than replacing it.
    Bands.overlays().forEach(function (ov) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'band band-overlay' + (overlayOn[ov.id] ? ' is-on' : '');
      el.setAttribute('aria-pressed', overlayOn[ov.id] ? 'true' : 'false');
      el.title = 'Show ' + ov.label + ' (' + ov.label.charAt(0) + ')';
      el.innerHTML = '<span class="band-name"></span><span class="band-range"></span>';
      el.firstChild.textContent = ov.label;
      el.lastChild.textContent = ov.range;
      el.addEventListener('click', function () { toggleOverlay(ov.id); });
      bandStrip.appendChild(el);
    });
  }

  function setBand(id) {
    band = Bands.get(id);
    buildBandTextures();
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

    if (stepOverlays(dt)) { dirty = true; }

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
      updateHover(0.7 + 0.3 * easeOut(revealMs / REVEAL_MS));
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
  var dragId = -1;
  var downX = 0, downY = 0, downTime = 0, moved = 0;
  var lastMoveTime = 0;
  var pinchDist = 0, pinchAngle = 0;
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

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) { return; }
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
    spinVel = [
      spinVel[0] + (ax * angle / dts - spinVel[0]) * 0.5,
      spinVel[1] + (ay * angle / dts - spinVel[1]) * 0.5,
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
    switch (e.key) {
      case 'ArrowLeft': turn(0, 1, 0, -step); resetFrom = null; break;
      case 'ArrowRight': turn(0, 1, 0, step); resetFrom = null; break;
      case 'ArrowUp': turn(1, 0, 0, -step); resetFrom = null; break;
      case 'ArrowDown': turn(1, 0, 0, step); resetFrom = null; break;
      case '+': case '=': zoomTarget = clampZoom(zoomTarget * 1.15); break;
      case '-': case '_': zoomTarget = clampZoom(zoomTarget / 1.15); break;
      case 'r': case 'R': case '0': resetView(); break;
      case 'h': case 'H': toggleOverlay('halpha'); e.preventDefault(); return;
      default: return;
    }
    e.preventDefault();
    noteInteraction();
    dirty = true;
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
      lutTex = hazeTex = coreTex = null;
      hdr = null;
      fog = null;
      initGL();
      resize();
      start();
    });

    start();
  }

  boot();
})();
