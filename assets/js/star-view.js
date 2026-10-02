/*
 * jeremy.ie/star — the renderer, the camera and the controls.
 *
 * Draws the model (star-model.js) through a channel (star-bands.js) with WebGL2, the
 * way an SDO image is made: first the light the channel collects at each pixel, in
 * units of the quiet star at disc centre, then a stretch and a colour table.
 *
 * Two maps of the field are kept on the GPU and redrawn as the field changes:
 *
 *   - A cube map of the field vector at the surface, for everything drawn on it:
 *     spots where it is strong, plage and faculae where it is moderate, penumbral
 *     filaments along its horizontal part, the magnetogram.
 *   - A volume, on a spherical grid from the surface to 1.6 radii, of the corona's
 *     temperature and density. Each cell traces the field line through it both
 *     ways: if both ends come down, the loop's length and the field at its feet set
 *     how hot and dense it is at its base; if either end leaves, it is open field, a
 *     coronal hole. A layer or two are redrawn each frame.
 *
 * A frame, all added into one half-float buffer:
 *
 *   1. The surface: a ray at each pixel meets the sphere and reads the layers the
 *      channel sees there (granulation, network, spots, plage, chromosphere,
 *      magnetogram, flare ribbons). Near spots, at high zoom, the ray marches into
 *      the umbra's Wilson depression, which makes spots near the limb lopsided.
 *   2. The diffuse corona: rays marched through the volume at half resolution,
 *      only in front of the star, adding density squared times the channel's
 *      response, the density brought up from the base with the scale height of the
 *      temperature the channel sees. The limb brightening and the glow off the limb
 *      come from the length of the path, as they do in the real thing.
 *   3. Strands: every traced field line, filament thread and flare loop drawn as a
 *      thin tube in 3D (a strip widened on screen, Gaussian across), hidden where the
 *      star is in front of it. Each works out its own temperature and density from
 *      the clock in the vertex shader. Blending is premultiplied, so cool material
 *      can both shine and absorb: a filament is dark against the disc and a bright
 *      prominence against the sky.
 *   4. Close up, spicules: short jets standing off the limb.
 *
 * Then the channel's stretch and colour table, and a 2D overlay: the heliographic
 * grid, the poles and limbs, and a flare's marks.
 *
 * The projection is orthographic, as for a star seen from far away. The camera is a
 * trackball on a quaternion, as /galaxy's; the star turns under it on its own axis.
 */
(function () {
  'use strict';

  var Model = window.StarModel;
  var Bands = window.StarBands;
  if (!Model || !Bands) { return; }

  /* ---------- Page options ---------- */

  var query = new URLSearchParams(window.location.search);
  var DEBUG = query.has('debug');
  var STILL = query.has('still');
  var START_T = parseFloat(query.get('t')) || 0;
  // ?debug&skip=corona,strands,surface leaves passes out, for checking each alone.
  var SKIP = DEBUG ? (query.get('skip') || '').split(',') : [];
  var NOSPIN = DEBUG && query.has('nospin'); // the star held still under the camera

  /* ---------- Tunables ---------- */

  var ZOOM_MIN = 0.6;
  var ZOOM_MAX = 12;
  var ZOOM_EASE = 9; // per second
  var SPIN_DECAY = 2.6; // per second, once released
  var RESET_MS = 900;
  var REVEAL_MS = 2200;
  var HOVER_RADIUS = 30; // CSS px
  var TAP_SLOP = 6;
  var RING_HOLD_MS = 1400;
  var MAX_PIXELS = 4200000;
  var FRAME_BUDGET_MS = 30;

  var R_OUT = 1.6; // the corona volume's outer edge
  var R_POW = 1.6; // its shells crowd toward the surface as k^R_POW
  var HFAC = 1.5; // scale heights over hydrostatic, from the measured off-limb fall-off
  var GRAN_CELL = 0.0021; // granule size in radii: about 1.3 Mm
  var SG_CELL = 0.045; // supergranule: about 28 Mm
  var WILSON = 0.0008; // umbral depression: about 500 km

  // How bright each kind of light is against the quiet star. Calibrated against the
  // AIA references: see tools/star-references.py and the debug read-back.
  var CORONA_SCALE = 60;
  var LOOP_SCALE = 1200;
  var DEM_CORONA = 0.15; // the diffuse corona is multithermal: responses broadened by this, in log T
  var DEM_LOOP = 0.04;

  /* ---------- DOM ---------- */

  var reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var stage = document.getElementById('stage');
  var canvas = document.getElementById('star-gl');
  var overlay = document.getElementById('star-overlay');
  if (!stage || !canvas || !overlay) { return; }
  var ctx2 = overlay.getContext('2d');

  var hud = document.getElementById('star-hud');
  var hint = document.getElementById('star-hint');
  var bandStrip = document.getElementById('star-bands');
  var fallback = document.getElementById('star-fallback');
  var card = document.querySelector('.star-card');
  var reticle = document.querySelector('.star-reticle');
  var cardId = card && card.querySelector('.star-card-id');
  var cardTag = card && card.querySelector('.star-card-tag');
  var cardRows = card && card.querySelectorAll('.star-card-row');

  function fail(err) {
    document.documentElement.classList.add('no-webgl');
    if (fallback) { fallback.hidden = false; }
    if (err && window.console) { console.error(err); }
  }

  var gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: DEBUG,
    powerPreference: 'high-performance'
  });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
    fail();
    return;
  }

  /* ---------- Model ---------- */

  var small = window.innerWidth < 700
    || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var model = Model.build(small, DEBUG ? parseInt(query.get('seed'), 10) || 0 : 0);
  var TH = Model.THERMAL;
  var POINTS = model.POINTS;
  var SPR = 16; // strands per texture row
  var VOL = small ? [64, 32, 24] : [128, 64, 32]; // phi, theta, r
  var CUBE = small ? 256 : 512;
  var CORONA_STEPS = small ? 24 : 40;
  var TRACE_BUDGET = small ? 2.5 : 4; // ms a frame

  /* ---------- Shaders ---------- */

  function f(x) {
    var s = String(x);
    return /[.e]/.test(s) ? s : s + '.0';
  }

  var HEAD = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp sampler3D;',
    'precision highp samplerCube;'
  ].join('\n');

  var COMMON = [
    'float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }',
    'float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }',
    'vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }',
    'float vnoise(vec3 p) {',
    '  vec3 i = floor(p), q = fract(p);',
    '  vec3 u = q * q * (3.0 - 2.0 * q);',
    '  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),',
    '      mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),',
    '    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),',
    '      mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);',
    '}',
    // Distances to the nearest two cell centres, whose centres drift with time.
    'vec2 worley(vec3 p, float t) {',
    '  vec3 i = floor(p), q = fract(p);',
    '  float f1 = 8.0, f2 = 8.0;',
    '  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {',
    '    vec3 g = vec3(float(x), float(y), float(z));',
    '    vec3 h = hash33(i + g);',
    '    vec3 o = 0.5 + 0.42 * sin(t * (0.6 + 0.8 * h.zxy) + 6.2831853 * h);',
    '    vec3 r = g + o - q;',
    '    float d = dot(r, r);',
    '    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }',
    '  }',
    '  return sqrt(vec2(f1, f2));',
    '}',
    // Where a direction and radius fall in the corona volume.
    'vec3 volCoord(vec3 d, float r) {',
    '  float phi = atan(d.y, d.x);',
    '  if (phi < 0.0) { phi += 6.2831853; }',
    '  float th = acos(clamp(d.z, -1.0, 1.0));',
    '  float k = pow(clamp((r - 1.0) / ' + f(R_OUT - 1) + ', 0.0, 1.0), ' + f(1 / R_POW) + ');',
    '  return vec3(phi / 6.2831853, th / 3.14159265, (k * ' + f(VOL[2] - 1) + ' + 0.5) / ' + f(VOL[2]) + ');',
    '}',
    // Wraps in longitude by hand: some implementations do not repeat a 3D texture.
    'vec4 volSample(sampler3D vol, vec3 c) {',
    '  float W = ' + f(VOL[0]) + ';',
    '  c.x = fract(c.x);',
    '  float x = c.x * W - 0.5;',
    '  if (x < 0.0 || x > W - 1.0) {',
    '    float t = x < 0.0 ? x + 1.0 : x - (W - 1.0);',
    '    vec4 a = textureLod(vol, vec3((W - 0.5) / W, c.yz), 0.0);',
    '    vec4 b = textureLod(vol, vec3(0.5 / W, c.yz), 0.0);',
    '    return mix(a, b, t);',
    '  }',
    '  return textureLod(vol, c, 0.0);',
    '}'
  ].join('\n');

  // A channel's response at log T, three components at once, each Gaussian broadened
  // by `dem` (keeping its area) for plasma spread over a range of temperatures.
  var RESP = [
    'uniform vec3 u_resp[9];',
    'float g1(float lt, vec3 g, float dem) {',
    '  float s = sqrt(g.y * g.y + dem * dem);',
    '  float d = (lt - g.x) / s;',
    '  return g.z * (g.y / s) * exp(-0.5 * d * d);',
    '}',
    'vec3 respAt(float lt, float dem) {',
    '  return vec3(g1(lt, u_resp[0], dem) + g1(lt, u_resp[1], dem) + g1(lt, u_resp[2], dem),',
    '    g1(lt, u_resp[3], dem) + g1(lt, u_resp[4], dem) + g1(lt, u_resp[5], dem),',
    '    g1(lt, u_resp[6], dem) + g1(lt, u_resp[7], dem) + g1(lt, u_resp[8], dem));',
    '}'
  ].join('\n');

  // The field from the model's sources and groups (two rows of u_src), as the model
  // sums it: exact near a group, a monopole and dipole far from it.
  var FIELD = [
    'uniform sampler2D u_src;',
    'uniform int u_ngroups;',
    'vec3 fieldAt(vec3 x, out float dmin) {',
    '  vec3 B = vec3(0.0);',
    '  dmin = 1e9;',
    '  for (int g = 0; g < 64; g++) {',
    '    if (g >= u_ngroups) { break; }',
    '    vec4 a = texelFetch(u_src, ivec2(g * 3, 1), 0);',
    '    vec4 m = texelFetch(u_src, ivec2(g * 3 + 1, 1), 0);',
    '    vec4 c = texelFetch(u_src, ivec2(g * 3 + 2, 1), 0);',
    '    vec3 d = x - a.xyz;',
    '    float d2 = dot(d, d);',
    '    if (c.w > 0.5 && d2 > a.w) {',
    '      float dl = sqrt(d2);',
    '      float inv3 = 1.0 / (d2 * dl);',
    '      float mr = 3.0 * dot(m.xyz, d) / d2;',
    '      B += (mr * d - m.xyz + m.w * d) * inv3;',
    '      dmin = min(dmin, dl - c.z);',
    '      continue;',
    '    }',
    '    int k1 = int(c.y + 0.5);',
    '    for (int k = int(c.x + 0.5); k < k1; k++) {',
    '      vec4 s = texelFetch(u_src, ivec2(k, 0), 0);',
    '      vec3 e = x - s.xyz;',
    '      float r2 = dot(e, e);',
    '      float r = sqrt(r2);',
    '      B += s.w * e / (r2 * r);',
    '      dmin = min(dmin, r);',
    '    }',
    '  }',
    '  return B;',
    '}'
  ].join('\n');

  // The model's coronal temperature and density (StarModel's coronaLogT, coronaN).
  var THERMAL = [
    'float coronaLogT(float L, float B) {',
    '  float core = sstep(' + f(TH.coreL[0]) + ', ' + f(TH.coreL[1]) + ', L) * sstep(' + f(TH.coreB[0]) + ', ' + f(TH.coreB[1]) + ', B);',
    '  float quiet = 1.0 - sstep(' + f(TH.quietB[0]) + ', ' + f(TH.quietB[1]) + ', B);',
    '  return ' + f(TH.base) + ' + ' + f(TH.core) + ' * core + (1.0 - core) * (' + f(TH.quiet) + ' * quiet',
    '    + ' + f(TH.mid) + ' * (1.0 - quiet) * sstep(' + f(TH.midL[0]) + ', ' + f(TH.midL[1]) + ', L));',
    '}',
    'float coronaN(float L, float B) {',
    '  return pow((B + ' + f(TH.nFloor) + ') / 100.0, ' + f(TH.nB) + ') * pow(max(L, 0.01) / 0.2, ' + f(TH.nL) + ');',
    '}'
  ].join('\n');

  var FULL_VS = [
    '#version 300 es',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* The field at the surface, one cube face at a time. */
  var CUBE_FS = [
    HEAD, FIELD,
    'uniform int u_face;',
    'uniform float u_size;',
    'out vec4 o;',
    'void main() {',
    '  vec2 st = gl_FragCoord.xy / u_size * 2.0 - 1.0;',
    '  float sc = st.x, tc = st.y;',
    '  vec3 d;',
    '  if (u_face == 0) { d = vec3(1.0, -tc, -sc); }',
    '  else if (u_face == 1) { d = vec3(-1.0, -tc, sc); }',
    '  else if (u_face == 2) { d = vec3(sc, 1.0, tc); }',
    '  else if (u_face == 3) { d = vec3(sc, -1.0, -tc); }',
    '  else if (u_face == 4) { d = vec3(sc, -tc, 1.0); }',
    '  else { d = vec3(-sc, -tc, -1.0); }',
    '  float dm;',
    '  o = vec4(fieldAt(normalize(d), dm), 0.0);',
    '}'
  ].join('\n');

  /*
   * One shell of the corona volume. Each cell follows the field line through it both
   * ways (Euler steps, a third of the distance to the nearest source) to its two feet.
   */
  var VOL_FS = [
    HEAD, COMMON, FIELD, THERMAL,
    'uniform float u_r;',
    'uniform vec2 u_dims;',
    'out vec4 o;',
    'const int STEPS = ' + (small ? 22 : 30) + ';',
    // state: 1 came down at `foot`, 2 left, 0 ran out of steps
    'int follow(vec3 x, float sgn, out vec3 foot, out float len) {',
    '  len = 0.0;',
    '  foot = normalize(x);',
    '  for (int i = 0; i < STEPS; i++) {',
    '    float dm;',
    '    vec3 B = fieldAt(x, dm);',
    '    float h = clamp(0.33 * dm, 0.003, 0.06);',
    '    x += sgn * h * normalize(B + 1e-9);',
    '    len += h;',
    '    float r = length(x);',
    '    if (r < 1.0) { foot = x / r; return 1; }',
    '    if (r > 2.2) { return 2; }',
    '  }',
    '  return 0;',
    '}',
    'void main() {',
    '  float phi = gl_FragCoord.x / u_dims.x * 6.2831853;',
    '  float th = gl_FragCoord.y / u_dims.y * 3.14159265;',
    '  vec3 dir = vec3(sin(th) * cos(phi), sin(th) * sin(phi), cos(th));',
    '  float h = u_r - 1.0;',
    '  vec3 x = dir * max(u_r, 1.003);',
    '  vec3 fa, fb;',
    '  float la, lb;',
    '  int sa = follow(x, 1.0, fa, la);',
    '  int sb = follow(x, -1.0, fb, lb);',
    '  float T, n, open = 0.0;',
    '  if (sa == 2 || sb == 2) {',
    // Open field: cooler, thinner, more extended, with plumes rooted in the network.
    '    vec3 foot = sa == 1 ? fa : (sb == 1 ? fb : dir);',
    '    float plume = sstep(0.55, 0.9, vnoise(foot * 38.0));',
    '    T = 1.0;',
    '    n = 0.45 * (0.6 + 1.6 * plume);',
    '    open = 1.0;',
    '  } else {',
    '    float dm;',
    '    float B = 0.5 * (length(fieldAt(fa * 1.0004, dm)) + length(fieldAt(fb * 1.0004, dm)));',
    '    float L = la + lb;',
    '    if (sa == 0 || sb == 0) { L *= 1.5; }',
    '    T = pow(10.0, coronaLogT(L, B) - 6.0);',
    '    n = coronaN(L, B);',
    '  }',
    // The density at the base of the field line through the cell; the corona pass
    // brings it up to the cell's height with the scale height of the temperature
    // each channel sees (open field is more extended: the wind).
    '  o = vec4(T, n, open, open > 0.5 ? 1.6 : 1.0);',
    '}'
  ].join('\n');

  /* ---------- The surface ---------- */

  var SURF_FS = [
    HEAD, COMMON,
    'uniform samplerCube u_cube;',
    'uniform sampler3D u_vol;',
    'uniform mat3 u_rot;',
    'uniform vec2 u_center;',
    'uniform float u_scale, u_time, u_wilson, u_spic;',
    'uniform vec3 u_w[8];',
    'uniform vec3 u_gain;',
    'uniform vec4 u_rib0, u_rib1, u_rib2;', // centre + strength, across + separation, along + half-length
    'uniform float u_ribW;',
    'out vec4 o;',
    '',
    // Umbra and penumbra from the field strength, where it is steep enough: between the
    // two spots of a pair the field is strong but lies flat, and that is plage, not spot.
    'float umbraOf(float b, float incl) { return sstep(1650.0, 1950.0, b) * sstep(0.55, 0.75, incl); }',
    'float penOf(float b, float incl) { return sstep(700.0, 850.0, b) * sstep(0.22, 0.4, incl) * (1.0 - umbraOf(b, incl)); }',
    'float spotDepth(vec3 dir) {',
    '  vec3 B = texture(u_cube, dir).xyz;',
    '  float b = length(B), incl = abs(dot(B, dir)) / max(b, 1.0);',
    '  return ' + f(WILSON) + ' * (umbraOf(b, incl) + 0.35 * penOf(b, incl));',
    '}',
    '',
    // March the view ray into the umbra's depression, so its far wall shows and its
    // near wall hides, as near the limb.
    'vec3 wilson(vec3 p, vec3 d, float mu) {',
    '  if (length(texture(u_cube, p).xyz) < 600.0) { return p; }',
    '  float smax = min(0.03, 1.6 * ' + f(WILSON) + ' / max(mu, 0.03));',
    '  for (int i = 1; i <= 8; i++) {',
    '    vec3 y = p + d * (smax * float(i) / 8.0);',
    '    float r = length(y);',
    '    vec3 dir = y / r;',
    '    if (r <= 1.0 - spotDepth(dir)) { return dir; }',
    '  }',
    '  return normalize(p + d * smax);',
    '}',
    '',
    'float ribbon(vec3 p) {',
    '  if (u_rib0.w <= 0.0) { return 0.0; }',
    '  vec3 d = p - u_rib0.xyz;',
    '  float u = dot(d, u_rib2.xyz), v = dot(d, u_rib1.xyz);',
    // Ribbons are not straight: they wander with the inversion line and fray at the ends.
    '  v += 0.014 * (vnoise(vec3(u * 38.0, 3.1, 0.0)) - 0.5) + 0.004 * (vnoise(vec3(u * 160.0, 7.7, 0.0)) - 0.5)',
    '    + sign(v) * 0.003 * (vnoise(vec3(u * 70.0, 5.3, 1.0)) - 0.5);',
    '  float along = 1.0 - sstep(0.45 * u_rib2.w, u_rib2.w * (0.85 + 0.3 * vnoise(vec3(v * 300.0, 1.0, 2.0))), abs(u));',
    '  float a = (v - u_rib1.w) / u_ribW, b = (v + u_rib1.w) / u_ribW;',
    '  float strips = exp(-0.5 * a * a) + exp(-0.5 * b * b);',
    '  float knots = 0.35 + 1.3 * vnoise(vec3(u * 700.0, v * 260.0, u_time * 0.6));',
    '  float c = v / (u_rib1.w + 2.0 * u_ribW);',
    '  return u_rib0.w * along * (strips * knots + 0.18 * exp(-0.5 * c * c));',
    '}',
    '',
    'void main() {',
    '  vec2 q = (gl_FragCoord.xy - u_center) / u_scale;',
    '  float rr = dot(q, q);',
    '  float r = sqrt(rr);',
    '  mat3 toStar = transpose(u_rot);',
    '  float px = 1.0 / u_scale;',
    '  vec3 col = vec3(0.0);',
    '',
    // Past the limb: the chromosphere and the spicules, as a fuzzy band. Close up,
    // the spicules are drawn as strands and the band thins to the chromosphere.
    '  if (r > 1.0 - px) {',
    '    float h = max(r - 1.0, 0.0);',
    '    vec3 limbPt = toStar * vec3(q / max(r, 1e-6), 0.0);',
    '    float fuzz = 0.7 + 0.6 * vnoise(limbPt * 420.0 + vec3(0.0, 0.0, u_time * 0.2));',
    '    float hb = mix(0.012, 0.005, u_spic);',
    '    float band = 1.15 * exp(-h / hb) * fuzz * mix(1.0, 0.6, u_spic);',
    '    col += band * u_w[7] * clamp((r - 1.0) * u_scale + 0.5, 0.0, 1.0);',
    '  }',
    '',
    '  if (r < 1.0 + px) {',
    '    float cover = clamp((1.0 - r) * u_scale + 0.5, 0.0, 1.0);',
    '    float mu = sqrt(max(1.0 - rr, 0.0));',
    '    vec3 p = normalize(toStar * vec3(q, mu));',
    '    vec3 toward = toStar * vec3(0.0, 0.0, 1.0);',
    '    if (u_wilson > 0.0) { p = wilson(p, -toward, mu); }',
    '    vec3 B = texture(u_cube, p).xyz;',
    '    float Bm = length(B), Br = dot(B, p);',
    '    float incl = abs(Br) / max(Bm, 1.0);',
    '    float umb = umbraOf(Bm, incl), pen = penOf(Bm, incl), spot = umb + pen;',
    '    float plage = sstep(60.0, 300.0, abs(Br));',
    '',
    // The supergranular network: bright, magnetic lanes between cells 28 Mm across.
    // The lanes are wobbled and broken into knots, so the cells read as a network of
    // bright points rather than a crazed glaze.
    '    vec3 warp = vec3(vnoise(p * 70.0), vnoise(p * 70.0 + 17.0), vnoise(p * 70.0 + 31.0)) - 0.5;',
    '    vec2 sg = worley(p * ' + f(1 / SG_CELL) + ' + warp * 0.9, u_time * 0.02);',
    '    float lane = 1.0 - sstep(0.0, 0.42, sg.y - sg.x);',
    '    float knots = vnoise(p * 300.0) * 0.65 + vnoise(p * 900.0) * 0.35;',
    '    float network = lane * lane * sstep(0.25, 0.85, knots) * 1.6;',
    '    float mottle = vnoise(p * 140.0 + u_time * 0.01) * 0.55 + vnoise(p * 500.0) * 0.45;',
    '',
    // Granules: only once they are a few pixels across.
    '    float cellPx = u_scale * ' + f(GRAN_CELL) + ' * max(mu, 0.15);',
    '    float gfade = sstep(1.3, 4.0, cellPx);',
    '    float gran = 0.0;',
    '    if (gfade > 0.001) {',
    '      vec2 g = worley(p * ' + f(1 / GRAN_CELL) + ', u_time * 0.12);',
    '      gran = (1.0 - 0.6 * g.x) * sstep(0.02, 0.24, g.y - g.x) * 2.0 - 1.0;',
    '    }',
    '',
    // Penumbral filaments: noise smeared along the horizontal field.
    '    float fil = 0.5;',
    '    if (pen > 0.01) {',
    '      vec3 bh = B - Br * p;',
    '      bh = bh / max(length(bh), 1e-3);',
    '      float s = 0.0;',
    '      for (int k = -3; k <= 3; k++) { s += vnoise((p + bh * (float(k) * 0.0012)) * 950.0); }',
    '      fil = s / 7.0;',
    '    }',
    '    float dots = umb > 0.01 ? sstep(0.72, 0.95, vnoise(p * 1500.0 + u_time * 0.05)) : 0.0;',
    '    float strong = sstep(500.0, 1400.0, abs(Br));',
    '',
    '    float m1 = 1.0 - mu;',
    // White light: limb darkening for 4500 A, granules, spots, faculae near the limb.
    '    float photo = (1.0 - 0.9 * m1 + 0.2 * m1 * m1) * (1.0 + 0.12 * gfade * gran);',
    '    photo *= mix(1.0, 0.5 + 0.45 * fil, pen) * mix(1.0, 0.14 + 0.22 * dots, umb);',
    '    photo *= 1.0 + plage * 0.5 * pow(m1, 1.6) * (1.0 - spot);',
    // 1600: darkening fitted to the reference (1 - 0.803 (1 - mu) + 0.267 (1 - mu)^2).
    '    float patchy = 0.35 + 0.9 * knots;',
    '    float uv = (1.0 - 0.803 * m1 + 0.267 * m1 * m1) * (0.74 + 0.3 * mottle + 0.7 * network)',
    '      * (1.0 + 1.5 * plage * patchy) * mix(1.0, 0.75, pen) * mix(1.0, 0.35, umb);',
    // He II: a mottled chromosphere, network and plage bright, a little brighter to the limb.
    '    float chrom = (0.2 + 0.85 * mottle * mottle * 1.3 + 1.1 * network) * (1.0 + 2.6 * plage * patchy * (1.0 - 0.4 * strong))',
    '      * (1.0 + 0.12 * m1);',
    // The quiet transition region: a thin layer, brighter toward the limb.
    '    float net = (0.35 + 0.45 * mottle + 0.8 * network) * (1.0 + 0.6 * plage) / sqrt(max(mu, 0.25));',
    // Moss: the base of hot active-region loops, where the corona over it is hot.
    '    float hot = volSample(u_vol, volCoord(p, 1.0)).x;',
    '    float moss = plage * (1.0 - strong) * sstep(1.8, 3.2, hot) * (0.5 + 0.9 * vnoise(p * 700.0));',
    // The magnetogram: the field along the line of sight, and the network\'s mixed polarity.
    '    float sgn = vnoise(p * 55.0 + 9.0) > 0.5 ? 1.0 : -1.0;',
    '    float mag = dot(B, toward) + sgn * network * 160.0 * (1.0 - plage) * mu',
    '      + (vnoise(p * 900.0) - 0.5) * 16.0;',
    '    float rib = ribbon(p);',
    '    vec3 disc = photo * u_w[0] + uv * u_w[1] + chrom * u_w[2] + net * u_w[3]',
    '      + moss * u_w[4] + mag * u_w[5] + rib * u_w[6];',
    '    col = mix(col, disc, cover);',
    '  }',
    '  o = vec4(col * u_gain, 1.0);',
    '}'
  ].join('\n');

  /* ---------- The diffuse corona ---------- */

  var CORONA_FS = [
    HEAD, COMMON, RESP,
    'uniform sampler3D u_vol;',
    'uniform mat3 u_rot;',
    'uniform vec2 u_center;',
    'uniform float u_scale, u_px, u_time;',
    'uniform vec3 u_gain;',
    'out vec4 o;',
    'const int N = ' + CORONA_STEPS + ';',
    'mat3 toStar;',
    'uniform vec3 u_peak;', // log T each component sees best
    'vec3 sampleAt(vec3 xv) {',
    '  float r = length(xv);',
    '  if (r < 1.0 || r > ' + f(R_OUT) + ') { return vec3(0.0); }',
    '  vec3 d = toStar * (xv / r);',
    '  vec3 c = volCoord(d, r);',
    '  vec4 v = 0.5 * (volSample(u_vol, c + vec3(0.55 / ' + f(VOL[0]) + ', 0.0, 0.0))',
    '    + volSample(u_vol, c - vec3(0.55 / ' + f(VOL[0]) + ', 0.0, 0.0)));',
    '  float lt = 6.0 + log(max(v.x, 0.05)) / 2.302585;',
    // The corona at each point is multithermal: what a channel sees of it is the part
    // near its own temperature, which has its own scale height, so the cool channels
    // fall off the limb faster than the hot ones, as they do.
    '  vec3 lk = clamp(u_peak, lt - 0.15, lt + 0.25);',
    '  vec3 Hk = ' + f(HFAC) + ' * 0.064 * v.w * pow(vec3(10.0), lk - 6.0);',
    '  float h = r - 1.0;',
    // Fine structure the volume is too coarse for: threads along the radial direction.
    '  float n0 = v.y * (0.8 + 0.4 * vnoise(d * 90.0));',
    '  vec3 n = n0 * exp(-h / Hk);',
    // The lowest few thousand km are full of spicules, whose cool gas absorbs EUV:
    // it takes the edge off the ring the limb would otherwise show.
    '  float spicules = 0.3 + 0.7 * sstep(0.0, 0.01, h);',
    '  return n * n * respAt(lt, ' + f(DEM_CORONA) + ') * spicules;',
    '}',
    'void main() {',
    '  vec2 q = (gl_FragCoord.xy * u_px - u_center) / u_scale;',
    '  float b2 = dot(q, q);',
    '  float R2 = ' + f(R_OUT * R_OUT) + ';',
    '  if (b2 >= R2) { o = vec4(0.0); return; }',
    '  toStar = transpose(u_rot);',
    '  float zf = sqrt(R2 - b2);',
    '  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  vec3 acc = vec3(0.0);',
    '  if (b2 < 1.0) {',
    // In front of the disc: from the surface out, samples crowded toward the surface.
    '    float z0 = sqrt(1.0 - b2);',
    '    float L = zf - z0;',
    '    for (int i = 0; i < N; i++) {',
    '      float u = (float(i) + jit) / float(N);',
    '      acc += sampleAt(vec3(q, z0 + L * u * u)) * (2.0 * u * L / float(N));',
    '    }',
    '  } else {',
    // Past the limb: the whole chord, crowded toward its closest approach.
    '    int M = N / 2;',
    '    for (int i = 0; i < N; i++) {',
    '      float u = (float(i / 2) + jit) / float(M);',
    '      float z = (i % 2 == 0 ? 1.0 : -1.0) * zf * u * u;',
    '      acc += sampleAt(vec3(q, z)) * (2.0 * u * zf / float(M));',
    '    }',
    '  }',
    '  o = vec4(acc * ' + f(CORONA_SCALE) + ' * u_gain, 1.0);',
    '}'
  ].join('\n');

  var BLIT_FS = [
    HEAD,
    'uniform sampler2D u_src;',
    'uniform vec2 u_size;',
    'out vec4 o;',
    'void main() {',
    '  o = vec4(texture(u_src, gl_FragCoord.xy / u_size).rgb, 0.0);',
    '}'
  ].join('\n');

  /* ---------- Strands ---------- */

  var STRAND_COMMON = [
    'uniform mat3 u_rot;',
    'uniform vec2 u_center, u_res;',
    'uniform float u_scale, u_time, u_dpr, u_absorb;',
    'uniform vec3 u_gain, u_coolS;',
    'out vec3 v_emit;',
    'out vec3 v_cool;',
    'out float v_alpha;',
    'out float v_across;',
    'out vec3 v_view;',
    'out float v_s;',
    'out float v_len;',
    'out float v_rain;',
    'out float v_seed;',
    // A strip vertex: the point (in view space), widened on screen at right angles to
    // the tangent.
    'void place(vec3 V, vec3 TV, float side, float widthR, out float flux) {',
    '  vec2 dir = TV.xy;',
    '  float dl = length(dir);',
    '  dir = dl > 1e-5 ? dir / dl : vec2(1.0, 0.0);',
    '  vec2 nrm = vec2(-dir.y, dir.x);',
    '  float sig = widthR * u_scale / 2.355;',
    '  float sigUsed = max(sig, 0.65 * u_dpr);',
    '  flux = sig / sigUsed;',
    '  vec2 px = u_center + V.xy * u_scale + nrm * (2.6 * sigUsed * side);',
    '  gl_Position = vec4(px / u_res * 2.0 - 1.0, 0.0, 1.0);',
    '  v_across = 2.6 * side;',
    '  v_view = V;',
    '}',
    'void hide() {',
    '  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '  v_emit = vec3(0.0); v_cool = vec3(0.0); v_alpha = 0.0; v_across = 0.0; v_view = vec3(0.0);',
    '  v_s = 0.0; v_len = 0.0; v_rain = -1.0; v_seed = 0.0;',
    '}'
  ].join('\n');

  var STRAND_VS = [
    HEAD, COMMON, RESP, STRAND_COMMON,
    'uniform sampler2D u_geom, u_par;',
    'uniform int u_pass;', // 0 filament threads, 1 everything else
    'const int PTS = ' + POINTS + ';',
    'const int SPR = ' + SPR + ';',
    'void main() {',
    '  int per = (PTS - 1) * 6;',
    '  int slot = gl_VertexID / per;',
    '  int rem = gl_VertexID - slot * per;',
    '  int seg = rem / 6;',
    '  int c = rem - seg * 6;',
    '  int endI = (c == 1 || c == 4 || c == 5) ? 1 : 0;',
    '  float side = (c == 2 || c == 3 || c == 5) ? 1.0 : -1.0;',
    '  int pi = seg + endI;',
    '  int col = slot - (slot / SPR) * SPR, row = slot / SPR;',
    '  vec4 c2 = texelFetch(u_par, ivec2(col * 3 + 2, row), 0);',
    '  int kind = int(c2.x + 0.5);',
    '  if (kind == 0 || (u_pass == 0) != (kind == 4)) { hide(); return; }',
    '  float born = c2.y, end = c2.z, rain = c2.w;',
    '  float t = u_time;',
    '  float life = sstep(born, born + 1.5, t) * (1.0 - sstep(end - 2.0, end, t));',
    '  if (life <= 0.0) { hide(); return; }',
    '  vec4 a = texelFetch(u_par, ivec2(col * 3, row), 0);',
    '  vec4 b = texelFetch(u_par, ivec2(col * 3 + 1, row), 0);',
    '  vec4 P = texelFetch(u_geom, ivec2(col * PTS * 2 + pi * 2, row), 0);',
    '  vec4 T = texelFetch(u_geom, ivec2(col * PTS * 2 + pi * 2 + 1, row), 0);',
    '  float peak = a.z, floorT = a.w, gain = b.x, widthR = b.y;',
    '  v_rain = -1.0;',
    '  float lt, nrel;',
    '  if (kind == 3) {',
    // A flare loop: heated once, then cooling and draining for the rest of its life.
    '    float tau = clamp((t - born) / max(end - born, 1.0), 0.0, 1.0);',
    '    lt = tau < 0.04 ? mix(6.2, peak, tau / 0.04) : mix(peak, floorT, pow((tau - 0.04) / 0.96, 1.25));',
    '    nrel = 0.4 + 0.6 * pow(sin(3.14159 * pow(tau, 0.55)), 1.2);',
    '    if (tau > 0.72) { v_rain = (tau - 0.72) * (end - born); }',
    '  } else if (kind == 4 || kind == 5) {',
    '    lt = 4.85;',
    '    nrel = 1.0;',
    '  } else {',
    // A heating cycle: a quick jump to the peak, then cooling and filling then draining.
    '    float ph = fract((t + a.y) / max(a.x, 1.0));',
    '    lt = ph < 0.03 ? mix(floorT, peak, ph / 0.03) : mix(peak, floorT, pow((ph - 0.03) / 0.97, 0.9));',
    '    nrel = 0.35 + 0.65 * pow(sin(3.14159 * pow(ph, 0.6)), 1.5);',
    '    if (rain > 0.5 && ph > 0.72) { v_rain = (ph - 0.72) * a.x; }',
    '  }',
    '  float flux;',
    // Threads sway a little.
    '  vec3 pos = P.xyz;',
    '  if (kind == 4) {',
    '    vec3 sideways = normalize(cross(pos, T.xyz) + 1e-6);',
    '    pos += sideways * (0.0007 * P.w * sin(u_time * 0.35 + float(slot) * 1.7 + P.w * 3.0));',
    '  }',
    '  place(u_rot * pos, u_rot * T.xyz, side, widthR, flux);',
    '  v_s = P.w;',
    '  v_len = b.z;',
    '  v_seed = float(slot);',
    '  vec3 TV = u_rot * T.xyz;',
    // A tube seen end-on is brighter: the path through it is longer.
    '  float los = 1.0 / max(sqrt(max(1.0 - TV.z * TV.z, 0.0)), 0.25);',
    '  float h = max(length(P.xyz) - 1.0, 0.0);',
    // Warm loops (around 1 MK, the crisp ones in 171) are observed to be far denser
    // than steady heating allows; this gives them that.
    '  float n = gain * nrel * (1.0 + 1.6 * sstep(6.2, 5.92, peak));',
    // Cool material (filament threads, the arches of emerging flux) is optically thick:
    // what comes through is its own source function where it is opaque and what is
    // behind it where it is not. Its source function is below the disc's, so it is dark
    // against the disc and bright against the sky.
    '  v_cool = u_coolS * life;',
    '  if (kind == 4 || kind == 5) {',
    '    v_emit = vec3(0.0);',
    '    v_alpha = u_absorb * (kind == 4 ? 0.9 : 1.0) * min(los, 2.0) * life * min(1.0, flux * 1.5);',
    '  } else {',
    '    float Tm = pow(10.0, lt - 6.0);',
    '    float strat = exp(-h / (' + f(HFAC) + ' * 0.064 * max(Tm, 0.05)));',
    '    if (kind == 2) { strat *= exp(-h / 0.12); }',
    '    float root = sstep(0.0, 0.004, h) * sstep(5.15, 5.6, lt);',
    '    v_emit = ' + f(LOOP_SCALE) + ' * n * n * respAt(lt, ' + f(DEM_LOOP) + ') * strat * root * widthR * flux * los * life * u_gain;',
    '    v_alpha = 0.0;',
    '  }',
    '}'
  ].join('\n');

  var STRAND_FS = [
    HEAD, COMMON,
    'in vec3 v_emit;',
    'in vec3 v_cool;',
    'in float v_alpha;',
    'in float v_across;',
    'in vec3 v_view;',
    'in float v_s;',
    'in float v_len;',
    'in float v_rain;',
    'in float v_seed;',
    'uniform float u_scale, u_absorb;',
    'out vec4 o;',
    'void main() {',
    // Behind the star: hidden, with a pixel of softness at the limb.
    '  float vis = v_view.z >= 0.0 ? 1.0 : sstep(1.0, 1.0 + 1.5 / u_scale, length(v_view.xy));',
    '  if (vis <= 0.0) { discard; }',
    '  float g = exp(-0.5 * v_across * v_across);',
    '  vec3 e = v_emit * g;',
    '  float tau = v_alpha * g;',
    // Coronal rain: blobs let go near the top and falling, faster and faster, down the legs.
    '  if (v_rain >= 0.0 && v_len > 0.0) {',
    '    for (int k = 0; k < 3; k++) {',
    '      vec3 hh = hash33(vec3(v_seed, float(k), 7.0));',
    '      float t = v_rain - hh.y * 2.5;',
    '      if (t < 0.0) { continue; }',
    '      float s0 = 0.5 + (hh.x - 0.5) * 0.5;',
    '      float dirn = s0 > 0.5 ? 1.0 : -1.0;',
    '      float s = s0 + dirn * (0.5 * 0.006 * t * t + 0.002 * t) / v_len;',
    '      if (s < 0.0 || s > 1.0) { continue; }',
    '      float d = (v_s - s) * v_len / 0.0035;',
    '      tau += u_absorb * 2.0 * exp(-d * d) * g;',
    '    }',
    '  }',
    '  float a = (1.0 - exp(-tau)) * vis;',
    // Against the disc, cool material shows its own faint light over less of the
    // chromosphere's: a dark filament. Against the sky, the long path through it is all
    // there is: a bright prominence.
    '  float onDisc = 1.0 - sstep(0.985, 1.0, length(v_view.xy));',
    '  o = vec4(e * vis + v_cool * mix(1.4, 0.3, onDisc) * a, a);',
    '}'
  ].join('\n');

  /*
   * Spicules: short-lived jets of chromospheric gas, a few thousand km tall, too many
   * and too small to model one by one over the whole star. They only show close up and
   * at the limb, so that is where they are drawn: a forest of them standing round the
   * limb, some in front of it and some behind, each rising and falling on its own clock.
   */
  var SPIC_VS = [
    HEAD, COMMON, RESP, STRAND_COMMON,
    'uniform float u_fade, u_count;',
    'const int PTS = 6;',
    'void main() {',
    '  int seg = gl_VertexID / 6;',
    '  int c = gl_VertexID - seg * 6;',
    '  int endI = (c == 1 || c == 4 || c == 5) ? 1 : 0;',
    '  float side = (c == 2 || c == 3 || c == 5) ? 1.0 : -1.0;',
    '  float s = float(seg + endI) / float(PTS - 1);',
    '  float id = float(gl_InstanceID);',
    '  vec3 h1 = hash33(vec3(id, 3.7, 11.0));',
    '  vec3 h2 = hash33(vec3(id, 8.1, 2.0));',
    '  float th = (id + h1.x * 0.9) / u_count * 6.2831853;',
    '  float z0 = (h1.y - 0.5) * 0.09;',
    '  float rz = sqrt(1.0 - z0 * z0);',
    '  vec3 root = vec3(cos(th) * rz, sin(th) * rz, z0);',
    '  vec2 sp = u_center + root.xy * u_scale;',
    '  if (u_fade <= 0.0 || sp.x < -60.0 || sp.y < -60.0 || sp.x > u_res.x + 60.0 || sp.y > u_res.y + 60.0) { hide(); return; }',
    '  vec3 along = vec3(-sin(th), cos(th), 0.0);',
    '  vec3 dirv = normalize(root + along * (h1.z - 0.5) * 0.7 + vec3(0.0, 0.0, 1.0) * (h2.x - 0.5) * 0.5);',
    '  float len = mix(0.005, 0.015, h2.y) * (h2.z < 0.15 ? 1.5 : 1.0);',
    '  float period = 6.0 + 8.0 * fract(h2.z * 13.7);',
    '  float ph = fract(u_time / period + h1.z * 3.1);',
    '  float ext = pow(sin(3.14159 * ph), 0.7);',
    '  float flux;',
    '  place(root * 1.0005 + dirv * (len * ext * s), dirv, side, 0.0007, flux);',
    '  v_s = s; v_len = 0.0; v_rain = -1.0; v_seed = 0.0;',
    '  float fade = u_fade * (1.0 - 0.5 * s) * sstep(0.0, 0.15, ext);',
    '  v_emit = vec3(0.0);',
    '  v_cool = u_coolS * 1.8;',
    '  v_alpha = u_absorb * 1.2 * fade * min(1.0, flux * 1.5);',
    '}'
  ].join('\n');

  /* ---------- Tone ---------- */

  var TONE_FS = [
    HEAD,
    'uniform sampler2D u_hdr, u_lut;',
    'uniform int u_tone;', // 0 asinh, 1 linear, 2 signed, 3 rgb
    'uniform vec3 u_vmax, u_a;',
    'uniform float u_exposure;',
    'uniform vec3 u_ground;',
    'uniform vec2 u_center;',
    'uniform float u_scale, u_noise, u_seed;',
    'out vec4 o;',
    'float hash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }',
    'float st(float x, float vmax, float a) {',
    '  return clamp(asinh(max(x, 0.0) / vmax / a) / asinh(1.0 / a), 0.0, 1.0);',
    '}',
    'vec3 lut(float v) { return texture(u_lut, vec2((v * 255.0 + 0.5) / 256.0, 0.5)).rgb; }',
    'void main() {',
    '  vec3 c = texelFetch(u_hdr, ivec2(gl_FragCoord.xy), 0).rgb * u_exposure;',
    // The faint channels count few photons, and look it: Poisson noise, as a Gaussian
    // with the variance of the counts (u_noise counts in the quiet star).
    '  if (u_noise > 0.0) {',
    '    vec3 q = vec3(floor(gl_FragCoord.xy / max(1.0, u_scale / 400.0)), u_seed);',
    '    float g = (hash(q) + hash(q + 17.0) + hash(q + 41.0) - 1.5) * 2.0;',
    '    c.r = max(0.0, c.r + g * sqrt(max(c.r, 0.0) / u_noise + 0.02 / u_noise));',
    '  }',
    '  vec3 col;',
    '  if (u_tone == 0) { col = lut(st(c.r, u_vmax.x, u_a.x)); }',
    '  else if (u_tone == 1) { col = lut(clamp(c.r / u_vmax.x, 0.0, 1.0)); }',
    '  else if (u_tone == 2) {',
    '    float r = length((gl_FragCoord.xy - u_center) / u_scale);',
    '    float cover = clamp((1.0 - r) * u_scale + 0.5, 0.0, 1.0);',
    '    col = vec3(clamp(0.5 + 0.5 * c.r / u_vmax.x, 0.0, 1.0)) * cover * u_exposure;',
    '  } else {',
    '    col = vec3(st(c.r, u_vmax.x, u_a.x), st(c.g, u_vmax.y, u_a.y), st(c.b, u_vmax.z, u_a.z));',
    '  }',
    '  o = vec4(u_ground + col * (1.0 - u_ground), 1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      var lines = src.split('\n').map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n');
      throw new Error(log + '\n' + (DEBUG ? lines : ''));
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

  /* ---------- GL resources ---------- */

  var cubeProg, volProg, surfProg, coronaProg, blitProg, strandProg, spicProg, toneProg;
  var emptyVao;
  var srcTex, cubeTex, volTex, geomTex, parTex, lutTex;
  var cubeFbo, volFbo;
  var hdr = null, corona = null;
  var CORONA_RES = 0.5;
  var rows = Math.ceil(model.slots / SPR);
  var SPICULES = small ? 2000 : 5000; // round the whole limb
  var srcData = new Float32Array(512 * 2 * 4);

  function floatTex(w, h, data) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function makeTarget(width, height, old) {
    var t = old || { tex: null, fbo: gl.createFramebuffer() };
    if (t.tex) { gl.deleteTexture(t.tex); }
    t.tex = gl.createTexture();
    t.width = width;
    t.height = height;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  }

  function buildTargets() {
    hdr = makeTarget(canvas.width, canvas.height, hdr);
    corona = makeTarget(Math.max(1, Math.ceil(canvas.width * CORONA_RES)),
      Math.max(1, Math.ceil(canvas.height * CORONA_RES)), corona);
  }

  function initGL() {
    cubeProg = program(FULL_VS, CUBE_FS);
    volProg = program(FULL_VS, VOL_FS);
    surfProg = program(FULL_VS, SURF_FS);
    coronaProg = program(FULL_VS, CORONA_FS);
    blitProg = program(FULL_VS, BLIT_FS);
    strandProg = program(STRAND_VS, STRAND_FS);
    spicProg = program(SPIC_VS, STRAND_FS);
    toneProg = program(FULL_VS, TONE_FS);
    emptyVao = gl.createVertexArray();

    srcTex = floatTex(512, 2, null);
    geomTex = floatTex(SPR * POINTS * 2, rows, null);
    parTex = floatTex(SPR * 3, rows, null);

    cubeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cubeTex);
    for (var i = 0; i < 6; i++) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA16F, CUBE, CUBE, 0, gl.RGBA, gl.HALF_FLOAT, null);
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    cubeFbo = gl.createFramebuffer();

    volTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, volTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, VOL[0], VOL[1], VOL[2], 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    volFbo = gl.createFramebuffer();

    lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    setLut();

    buildTargets();
  }

  /* ---------- Keeping the GPU's copy of the model current ---------- */

  function uploadSources() {
    srcData.fill(0);
    srcData.set(model.sources.subarray(0, 512 * 4), 0);
    srcData.set(model.groups.subarray(0, Math.min(model.groups.length, 512 * 4)), 512 * 4);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RGBA, gl.FLOAT, srcData);
  }

  function uploadStrands() {
    var d = model.dirty;
    if (!d.length) { return; }
    var full = Math.floor(model.slots / SPR);
    if (d.length > model.slots / 4) {
      gl.bindTexture(gl.TEXTURE_2D, geomTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPR * POINTS * 2, full, gl.RGBA, gl.FLOAT, model.geom, 0);
      gl.bindTexture(gl.TEXTURE_2D, parTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPR * 3, full, gl.RGBA, gl.FLOAT, model.par, 0);
      for (var s = full * SPR; s < model.slots; s++) { uploadSlot(s); }
    } else {
      for (var i = 0; i < d.length; i++) { uploadSlot(d[i]); }
    }
    for (var k = 0; k < d.length; k++) { model.dirtyFlagClear(d[k]); }
    d.length = 0;
  }

  function uploadSlot(s) {
    var col = s % SPR, row = Math.floor(s / SPR);
    gl.bindTexture(gl.TEXTURE_2D, geomTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, col * POINTS * 2, row, POINTS * 2, 1, gl.RGBA, gl.FLOAT,
      model.geom, s * POINTS * model.GEOM_STRIDE);
    gl.bindTexture(gl.TEXTURE_2D, parTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, col * 3, row, 3, 1, gl.RGBA, gl.FLOAT, model.par, s * model.PAR_STRIDE);
  }

  function bindSources(prog) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(prog.loc.u_src, 0);
    gl.uniform1i(prog.loc.u_ngroups, model.groupCount);
  }

  function drawCube() {
    gl.useProgram(cubeProg.prog);
    bindSources(cubeProg);
    gl.uniform1f(cubeProg.loc.u_size, CUBE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, cubeFbo);
    gl.viewport(0, 0, CUBE, CUBE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(emptyVao);
    for (var i = 0; i < 6; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, cubeTex, 0);
      gl.uniform1i(cubeProg.loc.u_face, i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function shellRadius(k) {
    return 1 + (R_OUT - 1) * Math.pow(k / (VOL[2] - 1), R_POW);
  }

  function drawShells(from, count) {
    gl.useProgram(volProg.prog);
    bindSources(volProg);
    gl.uniform2f(volProg.loc.u_dims, VOL[0], VOL[1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, volFbo);
    gl.viewport(0, 0, VOL[0], VOL[1]);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(emptyVao);
    for (var k = from; k < from + count && k < VOL[2]; k++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volTex, 0, k);
      gl.uniform1f(volProg.loc.u_r, shellRadius(k));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /*
   * The field maps follow the model's sources: the cube at most twice a second, the
   * volume a shell or two a frame, so a full refresh takes about half a second.
   */
  var cubeVersion = -1, cubeAt = -1e9;
  var volVersion = -1, volNext = 0;

  function refreshFieldMaps(now, force) {
    var v = model.sourcesVersion;
    if (force) {
      uploadSources();
      drawCube();
      drawShells(0, VOL[2]);
      cubeVersion = volVersion = v;
      cubeAt = now;
      volNext = VOL[2];
      return;
    }
    if (v !== cubeVersion && now - cubeAt > 500) {
      uploadSources();
      drawCube();
      cubeVersion = v;
      cubeAt = now;
    }
    if (volNext >= VOL[2] && volVersion !== cubeVersion) {
      volVersion = cubeVersion;
      volNext = 0;
    }
    if (volNext < VOL[2]) {
      var n = small ? 1 : 2;
      drawShells(volNext, n);
      volNext += n;
    }
  }

  /* ---------- Channel ---------- */

  var channel = Bands.get(query.get('band') || '171');
  var chU = null;

  function channelUniforms(ch) {
    var comps = Bands.components(ch);
    var resp = new Float32Array(27);
    var w = new Float32Array(24);
    var gain = [0, 0, 0], vmax = [1, 1, 1], a = [1, 1, 1], absorb = 0, peak = [6, 6, 6];
    for (var j = 0; j < 9; j++) { resp[j * 3 + 1] = 1; }
    comps.forEach(function (c, k) {
      for (var g = 0; g < 3; g++) {
        var r = c.resp[g];
        if (!r) { continue; }
        resp[(k * 3 + g) * 3] = r[0];
        resp[(k * 3 + g) * 3 + 1] = r[1];
        resp[(k * 3 + g) * 3 + 2] = r[2];
      }
      for (var l = 0; l < 8; l++) { w[l * 3 + k] = c.layers[l]; }
      // The coronal temperature the channel sees best: its strongest peak above 0.5 MK.
      var best = 0;
      c.resp.forEach(function (r) { if (r[0] > 5.7 && r[2] > best) { best = r[2]; peak[k] = r[0]; } });
      gain[k] = c.gain;
      vmax[k] = c.stretch.vmax;
      a[k] = c.stretch.a;
      absorb = Math.max(absorb, c.absorb);
    });
    // The source function of cool, optically thick material in each component.
    var cool = comps.map(function (c) { return c.coolS || 0; });
    while (cool.length < 3) { cool.push(0); }
    var tone = ch.tone === 'rgb' ? 3 : ch.tone === 'signed' ? 2 : ch.tone === 'linear' ? 1 : 0;
    return { resp: resp, w: w, gain: gain, vmax: vmax, a: a, absorb: absorb, cool: cool, tone: tone, peak: peak };
  }

  function setLut() {
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      Bands.table(channel.table));
    chU = channelUniforms(channel);
  }

  function setChannel(id, quiet) {
    if (!Bands.has(id)) { return; }
    channel = Bands.get(id);
    setLut();
    buildBandStrip();
    lastHud = 0;
    dirty = true;
    if (!quiet && window.history && window.history.replaceState) {
      var u = new URL(window.location.href);
      if (channel.id === '171') { u.searchParams.delete('band'); } else { u.searchParams.set('band', channel.id); }
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
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

  function qfromMat(m) {
    var t = m[0] + m[4] + m[8], s;
    if (t > 0) {
      s = 0.5 / Math.sqrt(t + 1);
      return qnorm([(m[7] - m[5]) * s, (m[2] - m[6]) * s, (m[3] - m[1]) * s, 0.25 / s]);
    }
    if (m[0] > m[4] && m[0] > m[8]) {
      s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
      return qnorm([0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s]);
    }
    if (m[4] > m[8]) {
      s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
      return qnorm([(m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s]);
    }
    s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    return qnorm([(m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s]);
  }

  /* ---------- Camera ---------- */

  var w = 0, h = 0, dpr = 1, dprCap = 2;
  var cx = 0, cy = 0, basePx = 1;
  var panX = 0, panY = 0;

  /*
   * The opening view is a solar image's: north up, east on the left, the star's
   * equator across the middle and its north pole tipped B0 toward us. The star's +x
   * (longitude 0) faces us, +y is to the right (west), +z up.
   */
  function defaultView() {
    var base = [0, 1, 0, 0, 0, 1, 1, 0, 0]; // view = base * star
    return qmul(qaxis(1, 0, 0, Model.params.B0), qfromMat(base));
  }

  var view = [0, 0, 0, 1];
  var Rv = new Float32Array(9);
  var M = new Float64Array(9); // star to view, row-major: the view and the star's own turn
  var Mcol = new Float32Array(9);
  var zoom = 1, zoomTarget = 1;
  var zoomAnchor = null;
  var spinVel = [0, 0, 0];
  var resetFrom = null, resetT = 0, resetPan = [0, 0];

  function turn(ax, ay, az, angle) {
    if (!angle) { return; }
    view = qnorm(qmul(qaxis(ax, ay, az, angle), view));
  }

  function applyView() {
    qmat(view, Rv);
    var a = NOSPIN ? 0 : Model.SPIN * model.time;
    var c = Math.cos(a), s = Math.sin(a);
    // M = Rv * Rz(a)
    for (var r = 0; r < 3; r++) {
      var x = Rv[r * 3], y = Rv[r * 3 + 1], z = Rv[r * 3 + 2];
      M[r * 3] = x * c + y * s;
      M[r * 3 + 1] = -x * s + y * c;
      M[r * 3 + 2] = z;
    }
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) { Mcol[j * 3 + i] = M[i * 3 + j]; }
    }
  }

  function scalePx() { return basePx * zoom; }

  var projX = 0, projY = 0, projZ = 0;

  // Star coordinates to CSS pixels, as the shaders do it.
  function project(x, y, z) {
    var vx = M[0] * x + M[1] * y + M[2] * z;
    var vy = M[3] * x + M[4] * y + M[5] * z;
    projZ = M[6] * x + M[7] * y + M[8] * z;
    var k = scalePx();
    projX = cx + panX + vx * k;
    projY = cy + panY - vy * k;
    return projZ > 0 || vx * vx + vy * vy > 1;
  }

  function clampPan() {
    var lim = 1.5 * scalePx();
    var l = Math.hypot(panX, panY);
    if (l > lim) { panX *= lim / l; panY *= lim / l; }
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
    // The radius at zoom 1, leaving room for the corona off the limb.
    basePx = narrow ? Math.min(w * 0.4, h * 0.3) : Math.min(w * 0.3, h * 0.33);
    if (gl && !gl.isContextLost()) { buildTargets(); }
    dirty = true;
  }

  /* ---------- Drawing ---------- */

  var revealMs = reducedMotion || START_T ? REVEAL_MS : 0;

  function easeOut(t) {
    t = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - t, 3);
  }

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function centerDevice() {
    return [(cx + panX) * dpr, (h - (cy + panY)) * dpr];
  }

  function spiculeFade() { return smoothstep(3.2, 5, zoom); }

  // A flare's ribbons for the surface shader: centre and strength, across and spread,
  // along and half-length.
  var rib0 = new Float32Array(4), rib1 = new Float32Array(4), rib2 = new Float32Array(4);

  function ribbons() {
    var fl = model.flare;
    rib0[3] = 0;
    if (!fl) { return; }
    var t = model.time - fl.t0;
    var rise = smoothstep(0, 1.2, t);
    var fall = 0.7 * Math.exp(-Math.max(0, t - 1.2) / 7) + 0.3 * Math.exp(-Math.max(0, t - 1.2) / 22);
    var end = 1 - smoothstep(fl.life - 6, fl.life, t);
    rib0[0] = fl.c[0]; rib0[1] = fl.c[1]; rib0[2] = fl.c[2];
    rib0[3] = 6 * fl.strength * rise * fall * end;
    rib1[0] = fl.across[0]; rib1[1] = fl.across[1]; rib1[2] = fl.across[2];
    rib1[3] = model.ribbonSep(fl, t);
    rib2[0] = fl.along[0]; rib2[1] = fl.along[1]; rib2[2] = fl.along[2];
    rib2[3] = fl.half;
  }

  function render() {
    applyView();
    var rev = easeOut(revealMs / REVEAL_MS);
    var cd = centerDevice();
    var sc = scalePx() * dpr;
    var U = chU;

    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(emptyVao);

    // 1. The surface.
    gl.useProgram(surfProg.prog);
    var L = surfProg.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cubeTex);
    gl.uniform1i(L.u_cube, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, volTex);
    gl.uniform1i(L.u_vol, 1);
    gl.uniformMatrix3fv(L.u_rot, false, Mcol);
    gl.uniform2f(L.u_center, cd[0], cd[1]);
    gl.uniform1f(L.u_scale, sc);
    gl.uniform1f(L.u_time, model.time);
    gl.uniform1f(L.u_wilson, sc * WILSON > 0.4 ? 1 : 0);
    gl.uniform1f(L.u_spic, spiculeFade());
    gl.uniform3fv(L.u_w, U.w);
    gl.uniform3fv(L.u_gain, U.gain);
    ribbons();
    if (SKIP.indexOf('surface') >= 0) { gl.uniform3fv(L.u_gain, [0, 0, 0]); }
    gl.uniform4fv(L.u_rib0, rib0);
    gl.uniform4fv(L.u_rib1, rib1);
    gl.uniform4fv(L.u_rib2, rib2);
    gl.uniform1f(L.u_ribW, 0.003);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. The diffuse corona, at half resolution, then added in.
    if (U.tone !== 1 && U.tone !== 2 && SKIP.indexOf('corona') < 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, corona.fbo);
      gl.viewport(0, 0, corona.width, corona.height);
      gl.useProgram(coronaProg.prog);
      L = coronaProg.loc;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, volTex);
      gl.uniform1i(L.u_vol, 1);
      gl.uniformMatrix3fv(L.u_rot, false, Mcol);
      gl.uniform2f(L.u_center, cd[0], cd[1]);
      gl.uniform1f(L.u_scale, sc);
      gl.uniform1f(L.u_px, canvas.width / corona.width);
      gl.uniform1f(L.u_time, model.time);
      gl.uniform3fv(L.u_resp, U.resp);
      gl.uniform3fv(L.u_gain, U.gain);
      gl.uniform3fv(L.u_peak, U.peak);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(blitProg.prog);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, corona.tex);
      gl.uniform1i(blitProg.loc.u_src, 2);
      gl.uniform2f(blitProg.loc.u_size, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 3. Strands, premultiplied: filament threads first, then the rest.
    if (U.tone !== 1 && U.tone !== 2 && SKIP.indexOf('strands') < 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(strandProg.prog);
      L = strandProg.loc;
      strandUniforms(L, cd, sc);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, geomTex);
      gl.uniform1i(L.u_geom, 3);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, parTex);
      gl.uniform1i(L.u_par, 4);
      var verts = model.slots * (POINTS - 1) * 6;
      if (model.filaments.length) {
        gl.uniform1i(L.u_pass, 0);
        gl.drawArrays(gl.TRIANGLES, 0, verts);
      }
      gl.uniform1i(L.u_pass, 1);
      gl.drawArrays(gl.TRIANGLES, 0, verts);

      // 4. Spicules, close up.
      var sf = spiculeFade();
      if (sf > 0.01) {
        gl.useProgram(spicProg.prog);
        L = spicProg.loc;
        strandUniforms(L, cd, sc);
        gl.uniform1f(L.u_fade, sf);
        gl.uniform1f(L.u_count, SPICULES);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 5 * 6, SPICULES);
      }
    }

    // 5. Stretch and colour.
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(toneProg.prog);
    L = toneProg.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.uniform1i(L.u_hdr, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.uniform1i(L.u_lut, 1);
    gl.uniform1i(L.u_tone, U.tone);
    gl.uniform3fv(L.u_vmax, U.vmax);
    gl.uniform3fv(L.u_a, U.a);
    gl.uniform1f(L.u_exposure, 0.35 + 0.65 * rev);
    gl.uniform3f(L.u_ground, 17 / 255, 18 / 255, 20 / 255);
    gl.uniform2f(L.u_center, cd[0], cd[1]);
    gl.uniform1f(L.u_scale, sc);
    gl.uniform1f(L.u_noise, channel.noise || 0);
    gl.uniform1f(L.u_seed, Math.floor(model.time * 3) % 97);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    drawOverlay(rev);
  }

  function strandUniforms(L, cd, sc) {
    var U = chU;
    gl.uniformMatrix3fv(L.u_rot, false, Mcol);
    gl.uniform2f(L.u_center, cd[0], cd[1]);
    gl.uniform2f(L.u_res, canvas.width, canvas.height);
    gl.uniform1f(L.u_scale, sc);
    gl.uniform1f(L.u_time, model.time);
    gl.uniform1f(L.u_dpr, dpr);
    gl.uniform1f(L.u_absorb, U.absorb);
    gl.uniform3fv(L.u_gain, U.gain);
    gl.uniform3fv(L.u_resp, U.resp);
    gl.uniform3fv(L.u_coolS, U.cool);
  }

  /* ---------- Overlay ---------- */

  var ringAlpha = 0;
  var lastInteract = -Infinity;

  function drawOverlay(rev) {
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);
    drawGrid(rev);
    drawLimbMarks(rev);
    drawFlareMarks(rev);
  }

  /*
   * The heliographic grid, every 15 degrees, on the near side only: faint always, and
   * brighter while the star is being turned, as a sense of which way up it is.
   */
  function drawGrid(rev) {
    var a = (0.08 + 0.24 * ringAlpha) * rev;
    if (a < 0.01) { return; }
    ctx2.save();
    ctx2.lineWidth = 1;
    ctx2.strokeStyle = 'rgba(110, 138, 120, ' + a.toFixed(3) + ')';
    ctx2.setLineDash([2, 6]);
    var i, j, pen, lat, lon, cl;
    for (i = -5; i <= 5; i++) {
      lat = i * Math.PI / 12;
      cl = Math.cos(lat);
      ctx2.beginPath();
      pen = false;
      for (j = 0; j <= 96; j++) {
        lon = j / 96 * 2 * Math.PI;
        project(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
        if (projZ <= 0) { pen = false; continue; }
        if (!pen) { ctx2.moveTo(projX, projY); pen = true; } else { ctx2.lineTo(projX, projY); }
      }
      ctx2.stroke();
    }
    for (i = 0; i < 24; i++) {
      lon = i * Math.PI / 12;
      ctx2.beginPath();
      pen = false;
      for (j = 0; j <= 48; j++) {
        lat = -Math.PI / 2 + j / 48 * Math.PI;
        cl = Math.cos(lat);
        project(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
        if (projZ <= 0) { pen = false; continue; }
        if (!pen) { ctx2.moveTo(projX, projY); pen = true; } else { ctx2.lineTo(projX, projY); }
      }
      ctx2.stroke();
    }
    ctx2.restore();
  }

  // N and S where the star's axis points, E and W along its equator: east on the left
  // when north is up, as on a solar image.
  function drawLimbMarks(rev) {
    // The north pole on screen: M's third column is the star's axis in view space,
    // and screen y runs down.
    var ax = M[2], ay = -M[5];
    var l = Math.hypot(ax, ay);
    if (l < 0.05) { ax = 0; ay = -1; } else { ax /= l; ay /= l; }
    var r = 1.1 * scalePx() + 8;
    var ox = cx + panX, oy = cy + panY;
    ctx2.save();
    ctx2.globalAlpha = (0.35 + 0.4 * ringAlpha) * rev;
    ctx2.fillStyle = 'rgb(142, 172, 152)';
    ctx2.font = '9px "Chivo Mono", "Courier New", monospace';
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';
    var marks = [['N', ax, ay], ['S', -ax, -ay], ['E', ay, -ax], ['W', -ay, ax]];
    marks.forEach(function (mk) {
      ctx2.fillText(mk[0], ox + mk[1] * r, oy + mk[2] * r);
    });
    ctx2.restore();
  }

  /*
   * A flare's marks: its GOES class beside it and, at the peak of a big one, the
   * pattern AIA's entrance filter meshes diffract a saturated kernel into: two
   * diagonal lines of fading dots.
   */
  function drawFlareMarks(rev) {
    var fl = model.flare;
    if (!fl || !fl.c) { return; }
    var t = model.time - fl.t0;
    if (!project(fl.c[0], fl.c[1], fl.c[2]) || projZ <= 0) { return; }
    var x = projX, y = projY;
    var end = 1 - smoothstep(fl.life - 4, fl.life, t);
    ctx2.save();
    var peak = smoothstep(0, 1.2, t) * Math.exp(-Math.max(0, t - 1.2) / 6);
    if (fl.flux >= 1e-5 && peak > 0.05 && channel.tone !== 'linear' && channel.tone !== 'signed') {
      ctx2.globalCompositeOperation = 'lighter';
      var col = Bands.swatch(channel.id === 'rgb' ? 'grey' : channel.table, 0.85);
      ctx2.fillStyle = 'rgb(' + col.join(',') + ')';
      var len = (60 + 120 * Math.log10(fl.flux / 1e-5 + 1)) * Math.sqrt(zoom);
      for (var k = 1; k * 7 < len; k++) {
        var d = k * 7, fade = peak * rev * Math.exp(-d / (len * 0.4)) * 0.8;
        ctx2.globalAlpha = fade;
        [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (s) {
          ctx2.fillRect(x + s[0] * d * 0.707 - 0.75, y + s[1] * d * 0.707 - 0.75, 1.5, 1.5);
        });
      }
      ctx2.globalCompositeOperation = 'source-over';
    }
    ctx2.globalAlpha = Math.min(1, Math.max(0, (t - 0.8) / 0.8)) * end * rev;
    ctx2.fillStyle = 'rgb(142, 172, 152)';
    ctx2.font = '9px "Chivo Mono", "Courier New", monospace';
    ctx2.textBaseline = 'middle';
    var label = 'FLARE · ' + fl.cls;
    var lw = ctx2.measureText(label).width;
    var lx = x + 18 + lw > w - 8 ? x - 18 - lw : x + 18;
    ctx2.fillText(label, lx, y - 16);
    ctx2.restore();
  }

  /* ---------- Region cards ---------- */

  var pointerX = -1, pointerY = -1, pointerIn = false;
  var hovered = null;
  var tapped = null;
  var dragging = false;
  var cardW = 0, cardH = 0;
  var placed = [];

  function placeRegions() {
    placed.length = 0;
    model.regions.forEach(function (reg) {
      var c = reg.frame.c;
      if (project(c[0], c[1], c[2]) && projZ > 0.08) {
        placed.push({ reg: reg, x: projX, y: projY });
      }
    });
  }

  function nearest() {
    var limit = HOVER_RADIUS * HOVER_RADIUS;
    var best = null, bestD = limit;
    placed.forEach(function (p) {
      var dx = p.x - pointerX, dy = p.y - pointerY, d = dx * dx + dy * dy;
      if (p.reg === hovered) { d *= 0.45; }
      if (d < bestD) { bestD = d; best = p.reg; }
    });
    return best;
  }

  function stonyhurst(v) {
    var lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) * 180 / Math.PI;
    var lonStar = Math.atan2(v[1], v[0]) * 180 / Math.PI;
    var l0 = Math.atan2(M[7], M[6]) * 180 / Math.PI;
    var lon = ((lonStar - l0 + 540) % 360) - 180;
    return (lat >= 0 ? 'N' : 'S') + Math.abs(Math.round(lat))
      + ' ' + (lon >= 0 ? 'W' : 'E') + Math.abs(Math.round(lon));
  }

  function mk(n) {
    return n >= 10 ? n.toFixed(0) : n.toFixed(1);
  }

  function fillCard(reg) {
    var d = model.describe(reg);
    cardId.textContent = d.name + ' · ' + d.hale;
    cardTag.textContent = d.stage;
    card.classList.toggle('is-hot', d.stage === 'Flaring' || d.stage === 'Emerging');
    reticle.classList.toggle('is-hot', d.stage === 'Flaring' || d.stage === 'Emerging');
    cardRows[0].textContent = 'McIntosh ' + d.mcintosh + ' · ' + Model.thousands(d.area) + ' MSH';
    // The tilt of its axis to the equator (Joy's law) rather than its flux: the
    // buried sources set the field's shape well, but not its total flux.
    cardRows[1].textContent = '|B| ' + Model.thousands(d.peakB) + ' G · tilt ' + Math.round(d.tilt) + '°';
    cardRows[2].textContent = stonyhurst(reg.frame.c)
      + (d.tmax ? ' · loops ' + mk(d.tmin) + '–' + mk(d.tmax) + ' MK' : '');
  }

  function updateHover() {
    if (!card) { return; }
    placeRegions();
    var next = pointerIn && !dragging ? nearest() : null;
    if (tapped && !next) {
      next = placed.some(function (p) { return p.reg === tapped; }) ? tapped : null;
    }
    if (next !== hovered) {
      hovered = next;
      if (hovered) {
        fillCard(hovered);
        card.classList.add('is-on');
        reticle.classList.add('is-on');
        cardW = card.offsetWidth;
        cardH = card.offsetHeight;
      } else {
        card.classList.remove('is-on');
        reticle.classList.remove('is-on');
      }
    }
    if (!hovered) { return; }
    if (Math.floor(model.time * 2) !== Math.floor((model.time - 0.02) * 2)) { fillCard(hovered); }
    var p = null;
    placed.forEach(function (q) { if (q.reg === hovered) { p = q; } });
    if (!p) { return; }
    var sx = p.x, sy = p.y;
    reticle.style.transform = 'translate3d(' + (sx - 13).toFixed(1) + 'px,' + (sy - 13).toFixed(1) + 'px,0)';
    var px, py;
    if (w < 700) {
      px = sx - cardW / 2;
      py = sy + 24 + cardH > h - 60 ? sy - 24 - cardH : sy + 24;
    } else {
      px = sx + 24;
      if (px + cardW > w - 12) { px = sx - 24 - cardW; }
      py = sy - cardH / 2;
    }
    px = Math.min(Math.max(12, px), w - cardW - 12);
    py = Math.min(Math.max(64, py), h - cardH - 12);
    card.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)';
  }

  /* ---------- Readout ---------- */

  var lastHud = 0;
  var strandsShown = 0;

  function updateHud(now) {
    if (!hud || now - lastHud < 140) { return; }
    lastHud = now;
    if (Math.floor(now / 1000) !== Math.floor((now - 140) / 1000) || !strandsShown) {
      strandsShown = model.strandCount();
    }
    var b0 = Math.asin(Math.max(-1, Math.min(1, M[8]))) * 180 / Math.PI;
    var l0 = (Math.atan2(M[7], M[6]) * 180 / Math.PI + 360) % 360;
    var name = channel.id === 'rgb' ? 'Composite'
      : channel.unit ? channel.label + ' ' + channel.unit : channel.label;
    var flare = model.flare ? '  ·  GOES ' + model.flare.cls : '';
    if (w < 700) {
      // A phone: what fits on one line.
      hud.textContent = 'B0 ' + (b0 >= 0 ? '+' : '−') + Math.abs(b0).toFixed(0) + '°'
        + '  ·  L0 ' + l0.toFixed(0) + '°  ·  ×' + zoom.toFixed(1) + '  ·  ' + name + flare;
      return;
    }
    hud.textContent = 'B0 ' + (b0 >= 0 ? '+' : '−') + Math.abs(b0).toFixed(1) + '°'
      + '  ·  L0 ' + l0.toFixed(1) + '°'
      + '  ·  ×' + zoom.toFixed(2)
      + '  ·  ' + model.regions.length + ' regions'
      + '  ·  ' + Model.thousands(strandsShown) + ' strands'
      + '  ·  ' + name + flare;
  }

  /* ---------- Channel strip ---------- */

  function buildBandStrip() {
    if (!bandStrip) { return; }
    var active = null;
    bandStrip.textContent = '';
    Bands.list().forEach(function (c) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'band' + (c.id === channel.id ? ' is-on' : '');
      el.setAttribute('aria-pressed', c.id === channel.id ? 'true' : 'false');
      el.title = c.label + (c.unit ? ' ' + c.unit : '') + (c.ion ? ' · ' + c.ion : '')
        + (c.temp ? ' · ' + c.temp : '') + ' (' + c.key.toUpperCase() + ')';
      var col = c.id === 'rgb' ? [170, 150, 200] : c.id === 'mag' ? [200, 200, 200]
        : Bands.swatch(c.table, 0.72);
      el.style.setProperty('--chip-rgb', col.join(', '));
      el.innerHTML = '<span class="band-name"></span><span class="band-range"></span>';
      el.firstChild.textContent = c.label + (c.unit ? ' ' + c.unit : '');
      el.lastChild.textContent = c.id === 'rgb' ? '211·193·171' : c.temp;
      el.addEventListener('click', function () { setChannel(c.id); });
      bandStrip.appendChild(el);
      if (c.id === channel.id) { active = el; }
    });
    // On a phone the strip scrolls sideways: keep the chosen chip in sight.
    if (active && bandStrip.scrollWidth > bandStrip.clientWidth) {
      bandStrip.scrollLeft = active.offsetLeft - (bandStrip.clientWidth - active.offsetWidth) / 2;
    }
  }

  /* ---------- Loop ---------- */

  var running = false;
  var lastTime = 0;
  var frames = 0;
  var smoothed = 16;
  var animating = !reducedMotion && !STILL;

  function tick(now) {
    if (!running) { return; }
    var dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 1 / 60;
    if (lastTime) {
      smoothed += ((now - lastTime) - smoothed) * 0.05;
      frames++;
      if (frames > 120 && smoothed > FRAME_BUDGET_MS && dprCap > 1) {
        dprCap = Math.max(1, dprCap - 0.5);
        frames = 0;
        resize();
      }
    }
    lastTime = now;

    // While the strands are first being traced, trace harder.
    var budget = model.pending() > 200 ? 12 : TRACE_BUDGET;
    model.step(animating ? dt : 0, budget, { flares: animating, prefer: nearSide });
    if (model.dirty.length) { uploadStrands(); dirty = true; }
    refreshFieldMaps(now, false);
    if (animating) {
      revealMs = Math.min(REVEAL_MS, revealMs + dt * 1000);
      dirty = true;
    }

    if (resetFrom) {
      resetT = Math.min(1, resetT + dt * 1000 / RESET_MS);
      var e = resetT < 0.5 ? 4 * resetT * resetT * resetT : 1 - Math.pow(-2 * resetT + 2, 3) / 2;
      view = qslerp(resetFrom, defaultView(), e);
      panX = resetPan[0] * (1 - e);
      panY = resetPan[1] * (1 - e);
      if (resetT >= 1) { resetFrom = null; }
      dirty = true;
    } else if (!dragging && (spinVel[0] || spinVel[1] || spinVel[2])) {
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
      setZoom(zoom * Math.pow(zoomTarget / zoom, 1 - Math.exp(-ZOOM_EASE * dt)));
    } else if (zoom !== zoomTarget) {
      setZoom(zoomTarget);
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
      updateHover();
      updateHud(now);
    }
    requestAnimationFrame(tick);
  }

  // Flares anywhere, but mostly where they can be seen.
  function nearSide(reg) {
    var c = reg.frame.c;
    project(c[0], c[1], c[2]);
    return projZ > 0.2 ? 1 : 0.06;
  }

  // Zooms, keeping the point under the anchor (the pointer) where it is.
  function setZoom(z) {
    if (zoomAnchor) {
      var k = z / zoom;
      var ax = zoomAnchor[0] - cx, ay = zoomAnchor[1] - cy;
      panX = ax - (ax - panX) * k;
      panY = ay - (ay - panY) * k;
    }
    zoom = z;
    clampPan();
    dirty = true;
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

  var pointers = {};
  var dragId = -1;
  var downX = 0, downY = 0, downTime = 0, moved = 0;
  var lastMoveTime = 0;
  var pinchDist = 0, pinchAngle = 0, pinchMid = null;
  var panning = false;
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
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mid: [(a.x + b.x) / 2, (a.y + b.y) / 2]
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
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) { return; }
    var p = local(e);
    pointers[e.pointerId] = p;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    resetFrom = null;
    spinVel = [0, 0, 0];
    zoomAnchor = null;
    zoomTarget = zoom;

    if (pointerCount() === 1) {
      dragging = true;
      dragId = e.pointerId;
      panning = e.button === 2 || e.shiftKey;
      downX = p.x; downY = p.y; downTime = performance.now();
      moved = 0;
      lastMoveTime = downTime;
    } else if (pointerCount() === 2) {
      var tp = twoPointers();
      pinchDist = tp.dist;
      pinchAngle = tp.angle;
      pinchMid = tp.mid;
      moved = TAP_SLOP + 1;
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
      dirty = true;
      return;
    }
    var now = performance.now();

    if (pointerCount() >= 2) {
      pointers[e.pointerId] = p;
      var tp = twoPointers();
      if (pinchDist > 0) {
        zoomAnchor = tp.mid;
        setZoom(clampZoom(zoom * tp.dist / pinchDist));
        zoomTarget = zoom;
        zoomAnchor = null;
      }
      if (pinchMid) {
        panX += tp.mid[0] - pinchMid[0];
        panY += tp.mid[1] - pinchMid[1];
        clampPan();
      }
      var da = tp.angle - pinchAngle;
      if (da > Math.PI) { da -= 2 * Math.PI; }
      if (da < -Math.PI) { da += 2 * Math.PI; }
      turn(0, 0, 1, -da);
      pinchDist = tp.dist;
      pinchAngle = tp.angle;
      pinchMid = tp.mid;
      noteInteraction(now);
      dirty = true;
      return;
    }

    if (e.pointerId !== dragId) { return; }
    var dx = p.x - prev.x, dy = p.y - prev.y;
    pointers[e.pointerId] = p;
    moved = Math.max(moved, Math.hypot(p.x - downX, p.y - downY));
    if (!dx && !dy) { return; }

    if (panning) {
      panX += dx;
      panY += dy;
      clampPan();
      noteInteraction(now);
      dirty = true;
      return;
    }

    // Turn as if the surface under the pointer were being dragged: a drag across a
    // radius turns the star a radian, at any zoom.
    var len = Math.hypot(dx, dy);
    var angle = len / scalePx();
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
      dragId = Number(Object.keys(pointers)[0]);
      spinVel = [0, 0, 0];
      pinchMid = null;
      return;
    }
    if (pointerCount() > 1) { return; }

    dragging = false;
    stage.classList.remove('is-grabbing');
    if (now - lastMoveTime > 80 || panning) { spinVel = [0, 0, 0]; }
    panning = false;
    pinchMid = null;

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
          placeRegions();
          hovered = null;
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
    var k = e.ctrlKey ? 0.01 : 0.0015;
    var p = local(e);
    zoomAnchor = [p.x, p.y];
    zoomTarget = clampZoom(zoomTarget * Math.exp(-d * k));
    resetFrom = null;
    noteInteraction();
    dirty = true;
  }

  function resetView() {
    resetFrom = view.slice();
    resetPan = [panX, panY];
    resetT = 0;
    zoomAnchor = [cx, cy];
    zoomTarget = 1;
    spinVel = [0, 0, 0];
    tapped = null;
    noteInteraction();
    dirty = true;
  }

  var KEYS = {};
  Bands.list().forEach(function (c) { KEYS[c.key] = c.id; });

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) { return; }
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { return; }
    var step = 0.08 / Math.sqrt(zoom);
    var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (KEYS[key]) { setChannel(KEYS[key]); e.preventDefault(); return; }
    switch (key) {
      case 'ArrowLeft': turn(0, 1, 0, -step); resetFrom = null; break;
      case 'ArrowRight': turn(0, 1, 0, step); resetFrom = null; break;
      case 'ArrowUp': turn(1, 0, 0, -step); resetFrom = null; break;
      case 'ArrowDown': turn(1, 0, 0, step); resetFrom = null; break;
      case '+': case '=': zoomAnchor = [cx, cy]; zoomTarget = clampZoom(zoomTarget * 1.2); break;
      case '-': case '_': zoomAnchor = [cx, cy]; zoomTarget = clampZoom(zoomTarget / 1.2); break;
      case 'r': resetView(); break;
      case 'f': model.triggerFlare(null, 0, function (reg) { return nearSide(reg) > 0.5 ? 1 : 0.001; }); break;
      default: return;
    }
    e.preventDefault();
    noteInteraction();
    dirty = true;
  }

  /* ---------- Debug ---------- */

  // ?debug: the raw channel intensities, for checking against the AIA references.
  function exposeDebug() {
    window.__star = {
      model: model,
      channel: function (id) { setChannel(id, true); render(); },
      read: function () {
        render();
        gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
        var px = new Float32Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        var cd = centerDevice();
        return { w: canvas.width, h: canvas.height, cx: cd[0], cy: cd[1], r: scalePx() * dpr, data: Array.from(px) };
      },
      view: function (q) { view = qnorm(q); applyView(); dirty = true; },
      turn: function (ax, ay, az, a) { turn(ax, ay, az, a); applyView(); dirty = true; },
      zoom: function (z, ax, ay) { zoomAnchor = ax === undefined ? [cx, cy] : [ax, ay]; setZoom(z); zoomTarget = z; render(); },
      pan: function (x, y) { panX = x; panY = y; render(); },
      advance: function (s, flares) {
        var end = model.time + s;
        while (model.time < end - 1e-6) { model.step(Math.min(0.1, end - model.time), 1e9, { flares: !!flares }); }
        uploadStrands();
        refreshFieldMaps(performance.now(), true);
        render();
      },
      flare: function (i, flux) { model.triggerFlare(i === undefined ? null : model.regions[i], flux); },
      readShell: function (k) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, volFbo);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volTex, 0, k);
        var px = new Float32Array(VOL[0] * VOL[1] * 4);
        gl.readPixels(0, 0, VOL[0], VOL[1], gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { w: VOL[0], h: VOL[1], data: Array.from(px) };
      },
      project: function (v) { project(v[0], v[1], v[2]); return [projX, projY, projZ]; },
      render: render
    };
  }

  /* ---------- Boot ---------- */

  function boot() {
    try {
      initGL();
    } catch (err) {
      fail(err);
      return;
    }
    resize();
    view = defaultView();
    applyView();
    if (START_T > 0) {
      while (model.time < START_T - 1e-6) {
        model.step(Math.min(0.1, START_T - model.time), 1e9, { flares: true });
      }
    }
    // The first strands before the first frame, so it never opens empty.
    model.step(0, START_T > 0 || STILL ? 1e9 : 60, { flares: false });
    uploadStrands();
    refreshFieldMaps(performance.now(), true);
    buildBandStrip();
    document.documentElement.classList.add('is-ready');
    if (DEBUG) { exposeDebug(); }

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('pointerleave', onLeave);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dblclick', function (e) { e.preventDefault(); resetView(); });
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKey);
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
      hdr = corona = null;
      try { initGL(); } catch (err) { fail(err); return; }
      resize();
      // Everything the GPU had is gone: send all of it again.
      for (var s = 0; s < model.slots; s++) { model.dirty.push(s); }
      uploadStrands();
      refreshFieldMaps(performance.now(), true);
      start();
    });

    start();
  }

  boot();
})();
