/*
 * jeremy.ie/aurora — the globe: renderer, camera and controls.
 *
 * Raw WebGL2, in the manner of galaxy-view.js, so the page carries no library and
 * every pixel is worked out here. A frame is:
 *
 *   1. The sphere. One full-screen triangle; each pixel casts a ray, meets the globe
 *      analytically and shades it. Nothing about the globe is a tessellated mesh, so
 *      the limb is a true circle at any size, and the lines that live on the surface
 *      (graticule, terminator, geomagnetic latitudes, the circle of sky a place can
 *      see, the probability contours) are drawn from screen-space derivatives at one
 *      device pixel wide, however the surface is turned.
 *      The earth itself comes from one texture (earth.png): the land, a shade lighter
 *      than the sea and lightening a little into the day side, with hairline
 *      contours of its height, and the night side's lights, from NASA's Black Marble.
 *   2. Coastlines, as instanced quads with analytic edges: true 1-CSS-px lines,
 *      which gl.LINES cannot give.
 *   3. The aurora (drawAurora), into a half-float target of its own, then bloomed and
 *      added over the top. Only the aurora blooms; the mesh stays sharp.
 *
 * The camera is not a free trackball. The view is a latitude, a longitude, a roll, a
 * place on screen and a size, eased between five framings as the page scrolls. From
 * the top:
 *
 *   sun      the whole inner solar system, seen from north of the ecliptic, the Earth
 *            a dot 1 AU right of the Sun;
 *   wind     the Earth about 40 px across, seen from its dusk side with the ecliptic's
 *            north up, so the Sun is off-screen to the left and its wind blows right;
 *   north    the northern half rising from the bottom with Ireland in frame (where
 *            the page opens);
 *   south    the southern half hanging from the top;
 *   drivers  smaller and dimmed behind the charts.
 *
 * From north down, north stays up and a sideways drag adds a spin in longitude. Above
 * it the size runs through four decades, so size is eased as its logarithm, and what
 * is drawn around the Earth belongs to layers (aurora-wind-view.js) that register
 * with addLayer() and are handed this frame's scene: where the Earth is on screen,
 * how many pixels an Earth radius is, and how far the camera has risen over the
 * ecliptic. The globe's own fine lines fade out as it shrinks, and below a pixel and a
 * half so does the globe.
 *
 * Coordinates are AuroraGeo's: Earth-centred, Earth radii, +z north. The view basis
 * is east, north and out-of-screen at the point the camera faces, turned by the roll.
 */
(function () {
  'use strict';

  var Geo = window.AuroraGeo;
  if (!Geo) { return; }

  var DEG = Geo.DEG;

  /* ---------- Tunables ---------- */

  var CAMERA_DIST = 4.2; // Earth radii from the centre: a little perspective, no more
  var FOLLOW = 6.5; // per second: how quickly the camera eases to the scroll's framing
  var SPIN_DECAY = 2.4; // per second, once a drag is let go
  var RESET_MS = 900;

  var LINE_PX = 1; // coastlines, CSS px

  var MAX_PIXELS = 8500000;
  var DPR_CAP = 2.5;
  var DPR_CAP_NARROW = 2;

  // Aurora heights are drawn this much taller than life, so curtains read from orbit.
  // Kept modest (Jeremy, 2026-11-04: 2.5x was "too accentuated"): the green still sits
  // low on the limb, the red not far over it, as from the space station.
  var AURORA_LIFT = 1.5;

  /*
   * The amplification, and the only one. The Seen layer draws the model's brightness
   * in linear light, GAIN times as luminous as the real sky would be, taking a screen's
   * white as DISPLAY_NITS. One kilorayleigh of 557.7 nm is 1.935e-4 cd/m^2, so at
   * 20,000x the naked-eye threshold (about 1 kR) is a faint but plain green, 10 kR is
   * bright, and only storm aurora reaches white. The tone curve is linear to 80% and
   * only then eases, so below that the factor holds exactly.
   *
   * What the eye can't see isn't drawn: brightness fades in from EYE_FROM kR and
   * counts in full from EYE_FULL, half of it at 1 kR, the faintest aurora the eye
   * picks out on a dark night (IBC I). Without the floor, the model's faint fringe
   * glowed as plainly as aurora worth going out for.
   */
  var GAIN = 20000;
  var DISPLAY_NITS = 200;
  var KR_NITS = 1.935e-4;
  var EYE_FROM = 0.5;
  var EYE_FULL = 1.5;

  var BLOOM_GAIN = 0.6;
  var BLOOM_LEVELS = 5;

  // The raymarch runs at a fraction of the canvas, which adapts to the frame rate,
  // and never past AURORA_PIXELS_MAX: the glow is soft and bloomed, so about one
  // sample per CSS pixel is all the eye can use, where a Retina canvas has four.
  var AURORA_SCALE = 0.6;
  var AURORA_SCALE_NARROW = 0.5;
  var AURORA_SCALE_MIN = 0.3;
  var AURORA_PIXELS_MAX = 1500000;

  // Frame pacing. Nothing here needs more than 60 frames a second, even on a 120 Hz
  // screen. When only the aurora's own slow shimmer is moving, 30 is plenty, and 20
  // once the globe is the dim backdrop to the Drivers view.
  var FPS_MOVING = 60;
  var FPS_IDLE = 30;
  var FPS_BACKDROP = 20;
  var STEP_LEN = 0.0035; // globe radii per step along the ray
  var MAX_STEPS = 64;
  var MAX_STEPS_NARROW = 36;

  // The circle of sky a place can see aurora in: where emission at 110 km sits on
  // the horizon, about 1,180 km away.
  var SKY_KM = 110;

  /*
   * The framings, by the id of the section that scrolls each into place. lat/lon is
   * the point the camera faces; cx, cy place the globe's centre as fractions of the
   * viewport; size is the globe's radius as a fraction of frame() below; dim fades it
   * toward the ground.
   *
   * North faces 34°N, so the pole sits two thirds of the way up the visible half and
   * the far side of the oval stands on the limb, and Ireland lands in the lower
   * middle of the screen. South mirrors it from 34°S over Tasmania and New Zealand.
   * The two views from space are framed by the Sun and the screen (spaceAim, viewAt).
   */
  var VIEWS = {
    sun: { dim: 1 },
    wind: { dim: 1 },
    north: { lat: 34, lon: -8, cx: 0.5, cy: 1.04, size: 0.855, dim: 1 },
    south: { lat: -34, lon: 150, cx: 0.5, cy: -0.04, size: 0.855, dim: 1 },
    drivers: { lat: 20, lon: -8, cx: 0.5, cy: 0.55, size: 0.62, dim: 0.26 }
  };

  var AU_RE = 23481; // Earth radii in an astronomical unit

  // The wind view shows this many Earth radii across a landscape screen (or down it,
  // whichever binds), and fewer on a portrait one, where the tail runs off the side.
  var WIND_SPAN = 62, WIND_SPAN_TALL = 44, WIND_SPAN_PORTRAIT = 34;
  // The sun view fits the model's disc, 1.7 AU in radius, with a margin.
  var SUN_DISC_AU = 1.76;

  // Leaving the wind view for the sun, the zoom runs fast at first and settles: most of
  // the scroll is spent on the last decade, where the Sun comes into frame and the
  // camera rises over the ecliptic. This is the exponent of that ease.
  var ZOOM_EASE = 2.2;
  // The camera rises over the ecliptic across this stretch of the way from the sun view
  // to the wind view (0 to 1). The Sun comes into frame a little under half way, by when
  // the ecliptic has begun to open; before then there is only the wind going by.
  var TILT_SPAN = [0.08, 0.66];

  // The globe's fine lines (graticule, contours, coasts, labels) fade out between these
  // radii, in CSS px, and the globe itself between the last two.
  var DETAIL_FROM = 60, DETAIL_FULL = 220;
  var GLOBE_FROM = 0.6, GLOBE_FULL = 2.0;
  var AURORA_MIN_PX = 4; // below this radius the aurora pass is skipped

  /* ---------- DOM ---------- */

  var stage = document.getElementById('stage');
  var canvas = document.getElementById('aurora-gl');
  var overlay = document.getElementById('aurora-overlay');
  var views = document.getElementById('views');
  var fallbackEl = document.getElementById('aurora-fallback');
  if (!stage || !canvas || !overlay) { return; }

  // The views in page order; a section this file has no framing for is left out.
  var sections = Array.prototype.slice.call(document.querySelectorAll('.view')).filter(function (s) { return VIEWS[s.id]; });
  var ids = sections.map(function (s) { return s.id; });
  var NORTH = Math.max(0, ids.indexOf('north'));
  var indexLinks = Array.prototype.slice.call(document.querySelectorAll('.view-index a'));
  var octx = overlay.getContext('2d');

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var gl = canvas.getContext('webgl2', {
    antialias: false, // every edge here is anti-aliased analytically
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance'
  });

  var failed = false;

  function fail() {
    failed = true;
    document.documentElement.classList.add('no-webgl');
    if (fallbackEl) {
      fallbackEl.hidden = false;
      // At the head of the north view: the readouts and charts still work without
      // the globe.
      var north = document.getElementById('north');
      if (north) { north.insertBefore(fallbackEl, north.firstChild); }
    }
  }

  if (!gl) { fail(); return; }

  /* ---------- Colours, from aurora.css ---------- */

  function cssColor(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    var m = /^#([0-9a-f]{6})$/i.exec(v);
    if (!m) { v = fallback; m = /^#([0-9a-f]{6})$/i.exec(v); }
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function cssValue(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function cssNumber(name, fallback) {
    var v = parseFloat(cssValue(name, ''));
    return isFinite(v) ? v : fallback;
  }

  var C = {};

  // The earth texture, from tools/build-aurora-earth.py: night lights in R, the land
  // as a signed distance field in G, the land's height in B. The two constants are
  // the builder's.
  var EARTH_FILE = 'assets/data/aurora/earth.png?v=20261102a';
  var EARTH_SDF_K = 32; // codes per texel in the land field
  var EARTH_TOP_M = 6500; // height is stored as sqrt(h / EARTH_TOP_M)
  // The hemisphere names' texture: two rows of NAME_ROW, the type NAME_PX high on a
  // baseline NAME_BASE down each (see setNames).
  var NAME_W = 2048, NAME_H = 512, NAME_ROW = 256, NAME_BASE = 200, NAME_PX = 190;

  function toLinear(c) {
    return c.map(function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  }

  function luminance(lin) {
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  var exposure = 0.0385;

  function readColors() {
    C.night = cssColor('--night', '#05080d');
    C.ink = cssColor('--ink', '#e8f0f3');
    C.em5577 = cssColor('--em-5577', '#47ffa0');
    C.em6300 = cssColor('--em-6300', '#ff3d2e');
    C.em4278 = cssColor('--em-4278', '#7b5cff');
    C.prob = [];
    C.probLin = [];
    for (var i = 1; i <= 6; i++) {
      var c = cssColor('--prob-' + i, '#3f8ad6');
      C.prob = C.prob.concat(c);
      C.probLin = C.probLin.concat(toLinear(c));
    }
    // The aurora pass works in linear light; the composite encodes it.
    C.green = toLinear(C.em5577);
    C.red = toLinear(C.em6300);
    C.violet = toLinear(C.em4278);
    exposure = GAIN * KR_NITS / (DISPLAY_NITS * luminance(C.green));

    // The space behind the globe, and the earth.
    C.skyTop = cssColor('--sky-top', '#131317');
    C.skyBottom = cssColor('--sky-bottom', '#131317');
    var haze = cssNumber('--haze-strength', 0.05);
    C.haze = cssColor('--haze', '#ece9e2').map(function (v) { return v * haze; });
    C.seaN = cssColor('--earth-sea', '#141418');
    C.landN = cssColor('--earth-land', '#1f1f26');
    C.seaD = cssColor('--earth-sea-day', '#1c1c22');
    C.landD = cssColor('--earth-land-day', '#2c2c33');
    C.lights = cssColor('--earth-lights', '#ffe2b0');
    C.place = cssColor('--place', '#ece9e2');
    C.coastAlpha = cssNumber('--coast-alpha', 0.35);
    C.font = cssValue('--font', '"Figtree", "Helvetica Neue", Arial, sans-serif');
  }

  /* ---------- Shaders ---------- */

  var HEADER = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler3D;'
  ].join('\n');

  // Shared by every pass that casts rays or projects points.
  var CAMERA = [
    'uniform mat3 uBasis;', // columns: east, north, out — view to globe; p * uBasis is globe to view
    'uniform vec3 uEye;', // the camera, in globe coordinates
    'uniform float uDist;',
    'uniform float uFocal;', // device px
    'uniform vec2 uCenter;', // the globe centre on screen, device px from the top left
    'uniform vec2 uRes;',
    'const float DEG = 0.017453292519943295;',
    'vec3 rayDir(vec2 fragTopLeft) {',
    '  vec3 d = normalize(vec3((fragTopLeft.x - uCenter.x) / uFocal, -(fragTopLeft.y - uCenter.y) / uFocal, -1.0));',
    '  return uBasis * d;',
    '}',
    'vec2 project(vec3 p, out float depth) {',
    '  vec3 v = p * uBasis;',
    '  depth = uDist - v.z;',
    '  return uCenter + vec2(v.x, -v.y) * uFocal / depth;',
    '}',
    'vec4 toClip(vec2 s) {',
    '  return vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0);',
    '}',
    // How squarely the camera sees a surface point: 0 on the limb, 1 face on.
    'float facing(vec3 n) {',
    '  float mu = dot(n, normalize(uEye));',
    '  return (mu - 1.0 / uDist) / (1.0 - 1.0 / uDist);',
    '}'
  ].join('\n');

  /*
   * The aurora at a point: r = brightness in kR, g = chance overhead (0..1).
   *
   * Live, it is NOAA's grid: two copies, so an update can fade in rather than snap.
   * Away from live (the time slider), it is OVATION-Prime driven by Kp, as
   * aurora-model.js describes: the cell's AACGM latitude and longitude from uAacgm,
   * longitude turned into magnetic local time with uMltRef, then the flux at that
   * (MLT, latitude, coupling level) from the hemisphere's table, trilinearly. Chance
   * divides by the live calibration slope, so both sources share one scale.
   * uModelMix blends from one to the other. Lookups use textureLod: none of these
   * textures has mipmaps, and some calls sit in branches.
   */
  var DATA = [
    'uniform sampler2D uData;',
    'uniform sampler2D uDataPrev;',
    'uniform float uDataMix;',
    'uniform vec2 uDataSize;',
    'uniform sampler2D uAacgm;', // mlat, cos mlon, sin mlon on a 1-degree grid
    'uniform sampler3D uOpN;', // flux (erg cm^-2 s^-1) over (MLT, |mlat| 50-90, coupling level)
    'uniform sampler3D uOpS;',
    'uniform float uModelMix;',
    'uniform float uLevelZ;',
    'uniform float uMltRef;', // MLT of magnetic longitude 0, hours
    'uniform vec2 uAnchor;', // north, south
    'uniform vec2 uSlope;', // erg per percent, north, south
    'vec2 dataAt(vec3 n) {',
    '  float lat = asin(clamp(n.z, -1.0, 1.0)) / DEG;',
    '  float lonS = atan(n.y, n.x) / DEG;',
    '  float lon = mod(lonS + 360.0, 360.0);',
    '  vec2 uv = vec2(lon / 360.0 + 0.5 / uDataSize.x,',
    '    ((lat + 90.0) / 180.0 * (uDataSize.y - 1.0) + 0.5) / uDataSize.y);',
    '  vec2 live = mix(textureLod(uDataPrev, uv, 0.0).rg, textureLod(uData, uv, 0.0).rg, uDataMix);',
    '  if (uModelMix <= 0.0) { return live; }',
    '  vec3 a = textureLod(uAacgm, vec2((lonS + 180.5) / 360.0, (lat + 90.5) / 181.0), 0.0).rgb;',
    '  vec2 model = vec2(0.0);',
    '  float am = abs(a.r);',
    '  if (am >= 50.0) {',
    '    float mlt = mod(uMltRef + atan(a.b, a.g) / DEG / 15.0 + 24.0, 24.0);',
    '    vec3 c = vec3(mlt / 24.0, (am - 50.0) / 40.0, uLevelZ);',
    '    bool north = a.r >= 0.0;',
    '    float flux = north ? textureLod(uOpN, c, 0.0).r * uAnchor.x : textureLod(uOpS, c, 0.0).r * uAnchor.y;',
    '    model = vec2(flux, min(1.0, flux / (north ? uSlope.x : uSlope.y) * 0.01));',
    '  }',
    '  return mix(live, model, uModelMix);',
    '}',
    // Brightness as the Seen layer draws it, after the eye's floor.
    'float seenKR(float kR) {',
    '  return kR * smoothstep(' + EYE_FROM.toFixed(2) + ', ' + EYE_FULL.toFixed(2) + ', kR);',
    '}',
    // The Probability ramp at chance p: each colour sits on its threshold (5, 10, 30,
    // 50, 70, 90 %) and blends into the next between them, as the legend's bar does.
    'const float PROB_TH[6] = float[6](0.05, 0.10, 0.30, 0.50, 0.70, 0.90);',
    'vec3 rampAt(vec3 r[6], float p) {',
    '  vec3 c = r[0];',
    '  for (int i = 1; i < 6; i++) { c = mix(c, r[i], clamp((p - PROB_TH[i - 1]) / (PROB_TH[i] - PROB_TH[i - 1]), 0.0, 1.0)); }',
    '  return c;',
    '}'
  ].join('\n');

  var FULLSCREEN_VS = [
    HEADER,
    'void main() {',
    '  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var SPHERE_FS = [
    HEADER,
    CAMERA,
    DATA,
    'uniform vec3 uSun;',
    'uniform mat3 uMag;', // columns: the geomagnetic axes; n * uMag is magnetic
    'uniform vec3 uPlace;',
    'uniform vec3 uPlaceEast;',
    'uniform vec3 uPlaceNorth;',
    'uniform float uSkyRad;',
    'uniform float uLayer;', // 0 = Seen, 1 = Probability
    'uniform float uDim;',
    'uniform float uDetail;', // the fine lines: 1 at the aurora views' size, 0 once the globe is small
    'uniform float uShow;', // the globe itself: 0 once it is under a pixel or so
    'uniform vec3 uInk;',
    'uniform vec3 uProb[6];',
    'uniform vec3 uSkyTop;', // the space behind, top to bottom of the screen
    'uniform vec3 uSkyBottom;',
    'uniform vec3 uHaze;',
    'uniform sampler2D uEarth;', // earth.png: lights, the land's distance field, its height
    'uniform vec2 uEarthSize;',
    'uniform float uEarthReady;', // fades the texture in once it has loaded; open sea till then
    'uniform sampler2D uName;', // the hemisphere names, set flat in two rows (see nameArc)
    'uniform vec4 uNameArc;', // baseline radius (px), px per texel, 0 north or 1 south, strength
    'uniform vec3 uSeaN;', // by night
    'uniform vec3 uLandN;',
    'uniform vec3 uSeaD;', // and in full sun
    'uniform vec3 uLandD;',
    'uniform vec3 uLights;',
    'out vec4 outColor;',

    // A line of about one device pixel along the zero set of f, given f's derivative.
    'float hair(float f, float w) {',
    '  return clamp(1.0 - abs(f) / max(w, 1e-6), 0.0, 1.0);',
    '}',

    'void main() {',
    '  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
    '  vec3 rd = rayDir(frag);',
    '  vec3 ro = uEye;',
    '  float b = dot(ro, rd);',
    '  float dmin = sqrt(max(dot(ro, ro) - b * b, 0.0));', // closest approach, radii
    '  float aa = fwidth(dmin);',
    '  float cover = clamp((1.0 - dmin) / aa + 0.5, 0.0, 1.0) * uShow;',

    // Space: the ground, top to bottom, and a thin haze above the limb.
    '  vec3 ground = mix(uSkyTop, uSkyBottom, frag.y / uRes.y);',
    '  float above = max(dmin - 1.0, 0.0);',
    '  vec3 sky = ground + uHaze * exp(-above * 26.0) * step(1.0, dmin) * uShow;',

    // The hemisphere's name, large and faint, bent along the limb: rising from behind
    // the earth over the top of the disc in the north, hanging under its foot in the
    // south. It is part of space, so the earth hides its foot and the aurora, drawn
    // after, glows in front of it.
    '  if (uNameArc.w > 0.0) {',
    '    vec2 q = frag - uCenter;',
    '    float th = atan(q.y, q.x);', // screen y runs down: pi/2 is straight down
    '    float phi = mix(th + 1.5707963, 1.5707963 - th, uNameArc.z);', // along it, rightward
    '    phi = mod(phi + 3.1415927, 6.2831853) - 3.1415927;',
    '    float up = mix(length(q) - uNameArc.x, uNameArc.x - length(q), uNameArc.z);', // up the letters
    '    float row = uNameArc.z * ' + NAME_ROW.toFixed(1) + ';',
    '    vec2 t = vec2(phi * uNameArc.x / uNameArc.y, row + ' + NAME_BASE.toFixed(1) + ' - up / uNameArc.y);',
    '    float inside = step(abs(t.x), ' + (NAME_W / 2).toFixed(1) + ') * step(row, t.y) * step(t.y, row + ' + NAME_ROW.toFixed(1) + ');',
    '    t = vec2(t.x / ' + NAME_W.toFixed(1) + ' + 0.5, t.y / ' + NAME_H.toFixed(1) + ');',
    '    sky = mix(sky, uInk, texture(uName, t).r * inside * uNameArc.w);',
    '  }',

    // The surface point under every pixel (off the disc, the nearest one), found
    // before any branch so the earth texture is sampled with sound derivatives.
    '  float disc = max(b * b - (dot(ro, ro) - 1.0), 0.0);',
    '  vec3 n = normalize(ro + rd * (-b - sqrt(disc)));',
    '  float lat = asin(clamp(n.z, -1.0, 1.0)) / DEG;',
    '  float lon = atan(n.y, n.x) / DEG;',
    '  vec2 uv = vec2(lon / 360.0 + 0.5, (90.0 - lat) / 180.0);',
    '  vec2 gx = dFdx(uv), gy = dFdy(uv);',
    '  gx.x = fract(gx.x + 0.5) - 0.5;', // across the antimeridian, the short way round
    '  gy.x = fract(gy.x + 0.5) - 0.5;',
    '  vec3 E = textureGrad(uEarth, uv, gx, gy).rgb * uEarthReady;',
    // The coast from the distance field, a pixel wide however far the globe is zoomed.
    '  float texels = max(length(gx * uEarthSize), length(gy * uEarthSize));',
    '  float land = clamp((E.g * 255.0 - 128.0) / ' + EARTH_SDF_K.toFixed(1) + ' / max(texels, 1e-3) + 0.5, 0.0, 1.0);',
    '  float hM = E.b * E.b * ' + EARTH_TOP_M.toFixed(1) + ';', // metres
    '  float wH = fwidth(hM);',

    '  vec3 col = sky;',
    '  if (cover > 0.0) {',
    '    float mu = clamp(dot(n, -rd), 0.0, 1.0);',
    '    float face = smoothstep(0.03, 0.4, mu);',

    // Land a shade lighter than the sea. The day side lightens a little, gently,
    // from the terminator to where the Sun stands about 30 degrees up: no terrain,
    // only the light. The night side carries the lights.
    '    float sunDot = dot(n, uSun);',
    '    float lit = smoothstep(-0.08, 0.5, sunDot);',
    '    vec3 surf = mix(mix(uSeaN, uLandN, land), mix(uSeaD, uLandD, land), lit);',
    '    float night = 1.0 - smoothstep(-0.25, 0.05, sunDot);',
    '    surf += uLights * (E.r * E.r * 1.8) * night;',
    '    surf += uInk * 0.05 * pow(1.0 - mu, 3.0);',
    // Small, from space, the day side has to read at a glance: it is lifted well clear
    // of the night, the land a little more than the sea.
    '    surf += uInk * (0.13 + 0.09 * land) * lit * (1.0 - uDetail);',

    // Contours on land, every 500 m and each 2000 m a little stronger; none at sea.
    // Fewer where they crowd: steep ground, and toward the limb.
    '    float c = hair(abs(fract(hM / 500.0 + 0.5) - 0.5) * 500.0, wH);',
    '    float major = hair(abs(fract(hM / 2000.0 + 0.5) - 0.5) * 2000.0, wH);',
    '    float crowd = clamp(1.6 - wH / 500.0 * 5.0, 0.0, 1.0);',
    '    surf += uInk * max(c, major) * (mix(0.16, 0.3, lit) + major * 0.14) * crowd * land * step(150.0, hM) * face * uDetail;',

    // Graticule: latitude every 10°, longitude every 15°, fading near the poles.
    '    float wLat = fwidth(lat);',
    '    vec2 dl = vec2(dFdx(lon), dFdy(lon));',
    '    dl = mod(dl + 180.0, 360.0) - 180.0;',
    '    float wLon = abs(dl.x) + abs(dl.y);',
    '    float gLat = abs(fract(lat / 10.0 + 0.5) - 0.5) * 10.0;',
    '    float gLon = abs(fract(lon / 15.0 + 0.5) - 0.5) * 15.0;',
    '    float grid = max(hair(gLat, wLat), hair(gLon, wLon) * (1.0 - smoothstep(76.0, 84.0, abs(lat))));',
    '    float equator = hair(lat, wLat);',
    '    surf += uInk * (grid * 0.045 + equator * 0.05) * face * uDetail;',

    // Geomagnetic latitudes 50, 60 and 70, dashed: where the oval lives.
    '    vec3 m = n * uMag;',
    '    float mlat = asin(clamp(m.z, -1.0, 1.0)) / DEG;',
    '    float mlon = atan(m.y, m.x) / DEG;',
    '    float wM = fwidth(mlat);',
    '    float am = abs(mlat);',
    '    float ring = max(max(hair(am - 50.0, wM), hair(am - 60.0, wM)), hair(am - 70.0, wM));',
    '    float dash = step(0.5, fract(mlon / 2.5));',
    '    surf += uInk * ring * dash * 0.09 * face * uDetail;',

    // The terminator, and where the Sun is 12° down: dark enough for faint aurora.
    '    float wS = fwidth(sunDot);',
    '    surf += uInk * hair(sunDot, wS) * 0.2 * face * uDetail;',
    '    float dusk = sunDot + 0.2079;',
    '    surf += uInk * hair(dusk, wS) * step(0.5, fract(lon / 1.5)) * 0.09 * face * uDetail;',

    // The circle of sky the chosen place can see aurora in, dashed, and its centre.
    '    float pd = dot(n, uPlace);',
    '    float ang = acos(clamp(pd, -1.0, 1.0));',
    '    float wA = fwidth(ang);',
    '    float az = atan(dot(n, uPlaceNorth), dot(n, uPlaceEast));',
    '    float skyDash = step(0.45, fract(az * 36.0 / 6.2831853));',
    '    surf += uInk * hair(ang - uSkyRad, wA) * skyDash * 0.42 * face * step(0.0, pd) * uDetail;',

    // Probability: the ramp as a gradient from 5 %, with a hairline at each
    // threshold above it so the levels can still be read off.
    '    if (uLayer > 0.001) {',
    '      vec2 dat = dataAt(n);',
    '      float p = dat.g;',
    '      float wp = fwidth(p);',
    '      float contour = 0.0;',
    '      for (int i = 1; i < 6; i++) { contour = max(contour, hair(p - PROB_TH[i], wp)); }',
    '      float fill = clamp((p - PROB_TH[0]) / max(wp, 1e-4) + 0.5, 0.0, 1.0);',
    '      surf = mix(surf, rampAt(uProb, p), 0.66 * uLayer * fill);',
    '      surf = mix(surf, uInk, contour * 0.4 * uLayer * step(0.04, p) * uDetail);',
    '    }',

    '    col = mix(sky, surf, cover);',
    '  }',

    // The limb itself: one crisp hairline.
    '  col += uInk * hair(dmin - 1.0, aa) * mix(0.34, 0.22, uDetail) * uShow;',

    '  col = mix(ground, col, uDim);',
    '  outColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var LINE_VS = [
    HEADER,
    CAMERA,
    'in vec3 aA;',
    'in vec3 aB;',
    'uniform float uLinePx;',
    'uniform float uDim;',
    'out float vD;',
    'out float vFade;',
    // Two triangles per segment: (t along, s across).
    'const vec2 CORNER[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),',
    '  vec2(0.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));',
    'void main() {',
    '  float fa = facing(aA), fb = facing(aB);',
    '  vFade = smoothstep(0.0, 0.22, min(fa, fb)) * uDim;',
    '  if (vFade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vD = 0.0; return; }',
    '  float da, db;',
    '  vec2 sa = project(aA, da);',
    '  vec2 sb = project(aB, db);',
    '  vec2 c = CORNER[gl_VertexID];',
    '  vec2 dir = sb - sa;',
    '  float len = length(dir);',
    '  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);',
    '  vec2 nrm = vec2(-dir.y, dir.x);',
    '  float hw = uLinePx * 0.5 + 1.0;',
    '  vec2 s = mix(sa, sb, c.x) + nrm * c.y * hw + dir * (c.x * 2.0 - 1.0) * hw * 0.5;',
    '  vD = c.y * hw;',
    '  gl_Position = toClip(s);',
    '}'
  ].join('\n');

  var LINE_FS = [
    HEADER,
    'in float vD;',
    'in float vFade;',
    'uniform float uLinePx;',
    'uniform vec4 uColor;',
    'out vec4 outColor;',
    'void main() {',
    '  float cov = clamp(uLinePx * 0.5 + 0.5 - abs(vD), 0.0, 1.0) * vFade;',
    '  if (cov <= 0.0) { discard; }',
    '  float a = uColor.a * cov;',
    '  outColor = vec4(uColor.rgb * a, a);',
    '}'
  ].join('\n');

  /*
   * The aurora, as seen. A ray through the shell between H_LOW and H_TOP (drawn
   * AURORA_LIFT times taller than life) adds up emission along its length:
   *
   *   brightness (kR, from the forecast grid at that spot, after the eye's floor:
   *     nothing below EYE_FROM)
   *   x structure (arcs, folds and rays, built in geomagnetic coordinates; its mean is
   *     1, so it moves the model's light around inside a cell and adds none)
   *   x a vertical profile per emission line, each integrating to 1 per km:
   *       557.7 nm green from a sharp lower edge near 100 km, decaying upward;
   *       630.0 nm red, broad around 245 km, a tenth of the green on a quiet night,
   *         more in storms and toward the equatorward edge;
   *       427.8 nm violet in a thin band along the lower edge, in storms.
   *
   * Path length is counted in real kilometres of height, so a column seen straight
   * down sums to the grid's own kR, and a curtain seen edge-on near the limb is
   * brighter, as it is from orbit. Emission is added, never absorbed: aurora is
   * optically thin. Where the Sun is up it is dimmed to 30%, since nobody sees it
   * there.
   *
   * The Probability layer swaps this for a faint glow of the ramp's colours at the
   * ground, so it blooms like light rather than sitting on the globe like paint.
   */
  var NOISE = [
    'float hash12(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    // Value noise that wraps in x every `period` cells, so nothing seams where
    // magnetic longitude goes from +180 to -180.
    'float pnoise(vec2 p, float period) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float i0 = mod(i.x, period), i1 = mod(i.x + 1.0, period);',
    '  float a = hash12(vec2(i0, i.y)), b = hash12(vec2(i1, i.y));',
    '  float c = hash12(vec2(i0, i.y + 1.0)), d = hash12(vec2(i1, i.y + 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}'
  ].join('\n');

  var AURORA_FS = [
    HEADER,
    CAMERA,
    DATA,
    NOISE,
    'uniform vec3 uSun;',
    'uniform mat3 uMag;',
    'uniform float uTime;',
    'uniform float uLift;',
    'uniform int uSteps;',
    'uniform float uStepLen;',
    'uniform float uSeen;',
    'uniform float uProbGlow;',
    'uniform float uExposure;',
    'uniform vec2 uPower;', // hemispheric power, GW, north and south
    'uniform float uFrame;',
    'uniform vec3 uGreen;',
    'uniform vec3 uRed;',
    'uniform vec3 uViolet;',
    'uniform vec3 uProbLin[6];',
    'out vec4 outColor;',
    'const float R_KM = 6371.0;',
    'const float H_LOW = 88.0;',
    'const float H_TOP = 330.0;',

    // Mean 1 by construction: 0.45 of diffuse glow that pulses slowly, 0.55 of
    // discrete arcs (ridges across magnetic latitude, folded along the oval) broken
    // into rays. 0.266 is the measured mean of ridge x rays.
    'float structure(vec3 m, float time, out float hb) {',
    '  float u = atan(m.y, m.x) / 6.2831853 + 0.5;',
    '  float am = abs(asin(clamp(m.z, -1.0, 1.0)) / DEG);',
    '  float fold = pnoise(vec2(u * 18.0 + time * 0.010, time * 0.020), 18.0) * 0.65',
    '    + pnoise(vec2(u * 54.0 - time * 0.025, time * 0.050 + 7.0), 54.0) * 0.35;',
    '  float y = am + (fold - 0.5) * 3.2;',
    '  float across = pnoise(vec2(u * 6.0, y * 0.6), 6.0);',
    '  float ridge = pow(1.0 - abs(across * 2.0 - 1.0), 3.0);',
    '  float rays = 0.45 + 0.55 * pnoise(vec2(u * 1400.0 + time * 0.8, time * 0.6), 1400.0);',
    '  float pulse = 0.85 + 0.3 * pnoise(vec2(u * 30.0, am * 0.8 + time * 0.15), 30.0);',
    '  hb = 98.0 + 14.0 * pnoise(vec2(u * 80.0 + time * 0.03, 3.0), 80.0);',
    '  return 0.45 * pulse + 0.55 * ridge * rays / 0.266;',
    '}',

    'void main() {',
    '  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
    '  vec3 rd = rayDir(frag);',
    '  vec3 ro = uEye;',
    '  float b = dot(ro, rd);',
    '  float oo = dot(ro, ro);',
    '  float r1 = 1.0 + uLift * H_TOP / R_KM;',
    '  float r0 = 1.0 + uLift * H_LOW / R_KM;',
    '  float d1 = b * b - (oo - r1 * r1);',
    '  if (d1 <= 0.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  float s1 = sqrt(d1);',
    '  float tA = max(-b - s1, 0.0);',
    '  float tB = -b + s1;',
    '  vec3 col = vec3(0.0);',

    '  float dE = b * b - (oo - 1.0);',
    '  if (dE > 0.0) {',
    // The ray meets the Earth: stop where it drops below the aurora's floor.
    '    tB = -b - sqrt(max(b * b - (oo - r0 * r0), 0.0));',
    '    if (uProbGlow > 0.001) {',
    '      vec3 nh = normalize(ro + rd * (-b - sqrt(dE)));',
    '      float p = dataAt(nh).g;',
    '      if (p >= PROB_TH[0]) { col += rampAt(uProbLin, p) * (0.03 + 0.09 * p) * uProbGlow; }',
    '    }',
    '  }',

    '  if (uSeen > 0.001 && tB > tA) {',
    // A cheap look along the ray first: most rays cross no aurora the eye could see.
    // Half the floor, so a band narrower than the look's spacing still counts.
    '    float peek = 0.0;',
    '    for (int i = 0; i < 12; i++) {',
    '      vec3 q = normalize(ro + rd * mix(tA, tB, (float(i) + 0.5) / 12.0));',
    '      peek = max(peek, dataAt(q).r);',
    '    }',
    '    if (peek > ' + (EYE_FROM / 2).toFixed(2) + ') {',
    '      int steps = int(clamp(ceil((tB - tA) / uStepLen), 8.0, float(uSteps)));',
    '      float dt = (tB - tA) / float(steps);',
    '      float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.61803398);',
    '      float t = tA + dt * jit;',
    '      float dsKm = dt * R_KM / uLift;',
    '      vec3 acc = vec3(0.0);',
    '      for (int i = 0; i < 64; i++) {',
    '        if (i >= steps) { break; }',
    '        vec3 p = ro + rd * t;',
    '        t += dt;',
    '        float r = length(p);',
    '        float hKm = (r - 1.0) / uLift * R_KM;',
    '        if (hKm < H_LOW || hKm > H_TOP) { continue; }',
    '        vec3 n = p / r;',
    '        float kR = seenKR(dataAt(n).r);',
    '        if (kR < 0.01) { continue; }',
    '        vec3 m = n * uMag;',
    '        float hb;',
    '        float s = structure(m, uTime, hb);',
    '        float gw = n.z >= 0.0 ? uPower.x : uPower.y;',
    '        float storm = smoothstep(25.0, 140.0, gw);',
    '        float am = abs(asin(clamp(m.z, -1.0, 1.0)) / DEG);',
    '        float redF = 0.10 + 0.22 * storm + 0.45 * smoothstep(63.0, 52.0, am);',
    '        float vioF = 0.03 + 0.10 * storm;',
    '        float g = smoothstep(hb - 6.0, hb + 2.0, hKm) * exp(-max(hKm - hb, 0.0) / 32.0) / 32.0;',
    '        float zr = (hKm - 245.0) / 55.0;',
    '        float zv = (hKm - hb + 2.0) / 5.0;',
    '        float rr = exp(-zr * zr) / 97.48;',
    '        float vv = exp(-zv * zv) / 8.862;',
    '        float day = mix(1.0, 0.3, smoothstep(-0.05, 0.15, dot(n, uSun)));',
    '        acc += (uGreen * g + uRed * (rr * redF) + uViolet * (vv * vioF)) * (kR * s * day * dsKm);',
    '      }',
    '      col += acc * uExposure * uSeen;',
    '    }',
    '  }',
    '  outColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // Dual-filter (Kawase) bloom: five halvings down, then back up, adding each level.
  var DOWN_FS = [
    HEADER,
    'uniform sampler2D uSrc;',
    'uniform vec2 uTexel;', // one source texel
    'uniform vec2 uDstRes;',
    'out vec4 outColor;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uDstRes;',
    '  vec4 s = texture(uSrc, uv) * 4.0;',
    '  s += texture(uSrc, uv - uTexel);',
    '  s += texture(uSrc, uv + uTexel);',
    '  s += texture(uSrc, uv + vec2(uTexel.x, -uTexel.y));',
    '  s += texture(uSrc, uv - vec2(uTexel.x, -uTexel.y));',
    '  outColor = s / 8.0;',
    '}'
  ].join('\n');

  var UP_FS = [
    HEADER,
    'uniform sampler2D uSrc;',
    'uniform vec2 uTexel;',
    'uniform vec2 uDstRes;',
    'out vec4 outColor;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uDstRes;',
    '  vec2 h = uTexel;',
    '  vec4 s = texture(uSrc, uv + vec2(-h.x * 2.0, 0.0));',
    '  s += texture(uSrc, uv + vec2(-h.x, h.y)) * 2.0;',
    '  s += texture(uSrc, uv + vec2(0.0, h.y * 2.0));',
    '  s += texture(uSrc, uv + vec2(h.x, h.y)) * 2.0;',
    '  s += texture(uSrc, uv + vec2(h.x * 2.0, 0.0));',
    '  s += texture(uSrc, uv + vec2(h.x, -h.y)) * 2.0;',
    '  s += texture(uSrc, uv + vec2(0.0, -h.y * 2.0));',
    '  s += texture(uSrc, uv + vec2(-h.x, -h.y)) * 2.0;',
    '  outColor = s / 12.0;',
    '}'
  ].join('\n');

  // Aurora plus bloom, tone-mapped (linear to 0.8, then easing to white), encoded to
  // sRGB and added over the globe.
  var COMPOSITE_FS = [
    HEADER,
    'uniform sampler2D uAurora;',
    'uniform sampler2D uBloom;',
    'uniform vec2 uRes;',
    'uniform float uBloomGain;',
    'uniform float uDim;',
    'out vec4 outColor;',
    'vec3 tone(vec3 x) {',
    '  vec3 hi = 0.8 + 0.2 * (1.0 - exp(-(x - 0.8) / 0.2));',
    '  return mix(x, hi, step(0.8, x));',
    '}',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uRes;',
    '  vec3 c = texture(uAurora, uv).rgb + texture(uBloom, uv).rgb * uBloomGain;',
    '  c = tone(max(c, 0.0));',
    '  outColor = vec4(pow(c, vec3(1.0 / 2.2)) * uDim, 1.0);',
    '}'
  ].join('\n');

  /* ---------- GL plumbing (as galaxy-view.js) ---------- */

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log);
    }
    return s;
  }

  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    p.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      var name = info.name.replace(/\[0\]$/, '');
      p.u[name] = gl.getUniformLocation(p, info.name);
    }
    return p;
  }

  var sphereProg, lineProg, auroraProg, downProg, upProg, compositeProg;
  var emptyVao, lineVao;
  var hdrFloat = false;
  var auroraTarget = null;
  var bloomTargets = [];
  var auroraScale = AURORA_SCALE;
  var power = [0, 0]; // GW, north and south, from the latest grid
  var lineCount = 0;
  var dataTex = [null, null];
  var dataSize = [2, 2];
  var dataMix = 1, dataFadeFrom = 0;

  function makeDataTexture(w, h, values) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.FLOAT, values);
    return t;
  }

  var mesh = null; // globe.json, decoded: { segs: Float32Array }
  var grid = null; // the latest forecast: { w, h, values: Float32Array (kR, prob) }

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

  function buildTargets() {
    var aw = Math.max(8, Math.round(canvas.width * auroraScale));
    var ah = Math.max(8, Math.round(canvas.height * auroraScale));
    auroraTarget = makeTarget(aw, ah, auroraTarget);
    for (var i = 0; i < BLOOM_LEVELS; i++) {
      aw = Math.max(1, aw >> 1);
      ah = Math.max(1, ah >> 1);
      bloomTargets[i] = makeTarget(aw, ah, bloomTargets[i]);
    }
  }

  function initGL() {
    sphereProg = program(FULLSCREEN_VS, SPHERE_FS);
    lineProg = program(LINE_VS, LINE_FS);
    auroraProg = program(FULLSCREEN_VS, AURORA_FS);
    downProg = program(FULLSCREEN_VS, DOWN_FS);
    upProg = program(FULLSCREEN_VS, UP_FS);
    compositeProg = program(FULLSCREEN_VS, COMPOSITE_FS);
    emptyVao = gl.createVertexArray();
    probeFloat();
    auroraTarget = null;
    bloomTargets = [];
    if (canvas.width > 1) { buildTargets(); }

    var zero = new Float32Array(2 * 2 * 2);
    dataTex[0] = makeDataTexture(2, 2, zero);
    dataTex[1] = makeDataTexture(2, 2, zero);
    dataSize = [2, 2];
    if (grid) { uploadGrid(grid, true); }
    if (mesh) { uploadMesh(); }

    // The model's textures start as single empty texels, so every sampler is bound.
    aacgmTex = makeAacgmTexture(1, 1, new Float32Array([0, 1, 0]));
    opTex = [makeOpTexture(1, 1, 1, new Float32Array(1)), makeOpTexture(1, 1, 1, new Float32Array(1))];
    opDoy = null;
    if (window.AuroraModel && window.AuroraModel.ready()) { uploadModel(); }
    uploadEarth();
    uploadNames();
  }

  /* ---------- The earth texture ---------- */

  /* ---------- The hemisphere's name ---------- */

  // "Borealis" over "Australis", set flat once the page's face has loaded, large and
  // heavy as the ghost words were, then bent along the limb by the sphere pass, so the
  // type keeps its own spacing. The letters stand NAME_SCALE of the globe's radius
  // high; in the north the earth hides their foot (NAME_SINK of that), in the south
  // they hang under the disc with their tops behind it (baseline NAME_HANG below).
  var NAME_SCALE = 0.17, NAME_SINK = 0.12, NAME_HANG = 0.55, NAME_STRENGTH = 0.11;
  var nameTex = null;
  var nameCanvas = null; // kept, so a lost context can be given it back
  var nameReady = 0, nameFadeFrom = 0;

  function setNames() {
    nameCanvas = document.createElement('canvas');
    nameCanvas.width = NAME_W;
    nameCanvas.height = NAME_H;
    var c = nameCanvas.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, NAME_W, NAME_H);
    c.fillStyle = '#fff';
    c.font = '700 ' + NAME_PX + 'px ' + C.font;
    if ('letterSpacing' in c) { c.letterSpacing = (-0.035 * NAME_PX).toFixed(1) + 'px'; }
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillText('Borealis', NAME_W / 2, NAME_BASE);
    c.fillText('Australis', NAME_W / 2, NAME_ROW + NAME_BASE);
    if (gl && !gl.isContextLost()) { uploadNames(); }
    nameFadeFrom = performance.now();
  }

  function uploadNames() {
    if (nameTex) { gl.deleteTexture(nameTex); }
    nameTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, nameTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (nameCanvas) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, nameCanvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  function smooth(a, b, x) {
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // This frame's name: which, where and how strong. It leaves as the camera crosses the
  // equator between views, as the globe dims for the drivers and as it shrinks into space.
  function nameArc() {
    var south = cam.lat < 0 ? 1 : 0;
    var fs = NAME_SCALE * radiusPx;
    var rb = south ? radiusPx + NAME_HANG * fs : radiusPx - NAME_SINK * fs;
    var show = smooth(8, 25, Math.abs(cam.lat)) * smooth(0.6, 0.95, cam.dim) * nameReady * detail;
    return [rb * dpr, fs / NAME_PX * dpr, south, NAME_STRENGTH * show];
  }

  var earthTex = null;
  var earthImage = null; // kept, so a lost context can be given it back
  var earthSize = [1, 1];
  var earthReady = 0, earthFadeFrom = 0;
  var EARTH_FADE_MS = 600;

  function uploadEarth() {
    if (earthTex) { gl.deleteTexture(earthTex); }
    earthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, earthTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (earthImage) {
      // The channels are data, not colour: no colour management, no premultiplying.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, earthImage);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      earthSize = [earthImage.width, earthImage.height];
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      earthSize = [1, 1];
    }
  }

  function decodeImage(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  // After first paint. Until it is in, the earth reads as open sea; it fades in.
  function loadEarth() {
    fetch(EARTH_FILE)
      .then(function (r) {
        if (!r.ok) { throw new Error('earth.png ' + r.status); }
        return r.blob();
      })
      .then(decodeImage)
      .then(function (img) {
        earthImage = img;
        earthReady = 0;
        earthFadeFrom = performance.now();
        if (!gl.isContextLost()) { uploadEarth(); }
      })
      .catch(function (err) {
        if (window.console) { console.error('aurora-globe: no earth texture', err); }
      });
  }

  /* ---------- The time slider's model ---------- */

  var aacgmTex = null;
  var opTex = [null, null];
  var opDoy = null;
  var modelFrame = { modelMix: 0 };

  function makeAacgmTexture(w, h, values) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, w, h, 0, gl.RGB, gl.FLOAT, values);
    return t;
  }

  // x = MLT (wraps), y = |mlat| 50-90, z = coupling level.
  function makeOpTexture(w, h, d, values) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, w, h, d, 0, gl.RED, gl.FLOAT, values);
    return t;
  }

  // The AACGM grid once; the flux tables again whenever the day being shown changes,
  // since the season weights do.
  function uploadModel() {
    var M = window.AuroraModel;
    var ag = M.aacgmGrid;
    var cells = 181 * 360;
    var noData = M.meta.aacgm.noData;
    var rgb = new Float32Array(cells * 3);
    for (var i = 0; i < cells; i++) {
      var la = ag[i], lo = ag[cells + i];
      if (la === noData) {
        rgb[i * 3 + 1] = 1;
        continue;
      }
      var r = lo / 100 * DEG;
      rgb[i * 3] = la / 100;
      rgb[i * 3 + 1] = Math.cos(r);
      rgb[i * 3 + 2] = Math.sin(r);
    }
    gl.deleteTexture(aacgmTex);
    aacgmTex = makeAacgmTexture(360, 181, rgb);
    opDoy = null;
  }

  function uploadTables(doy) {
    var M = window.AuroraModel;
    var d = M.dims();
    for (var h = 0; h < 2; h++) {
      gl.deleteTexture(opTex[h]);
      opTex[h] = makeOpTexture(d.nMlt, d.nLat, d.nLev, M.combined(h === 1, doy));
    }
    opDoy = doy;
  }

  // What the shaders show this frame: live, or the model at the slider's time.
  function stepModel() {
    var M = window.AuroraModel;
    if (!M || M.viewTime === null || !M.ready()) {
      modelFrame = { modelMix: 0 };
      return;
    }
    modelFrame = M.frame(M.viewTime);
    if (modelFrame.modelMix > 0 && modelFrame.doy !== opDoy) { uploadTables(modelFrame.doy); }
  }

  function uploadMesh() {
    lineVao = gl.createVertexArray();
    gl.bindVertexArray(lineVao);
    var lb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lb);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.segs, gl.STATIC_DRAW);
    var la = gl.getAttribLocation(lineProg, 'aA');
    var lbb = gl.getAttribLocation(lineProg, 'aB');
    gl.enableVertexAttribArray(la);
    gl.vertexAttribPointer(la, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(la, 1);
    gl.enableVertexAttribArray(lbb);
    gl.vertexAttribPointer(lbb, 3, gl.FLOAT, false, 24, 12);
    gl.vertexAttribDivisor(lbb, 1);
    lineCount = mesh.segs.length / 6;
    gl.bindVertexArray(null);
  }

  // A new forecast fades in over DATA_FADE_MS; the first one simply appears.
  var DATA_FADE_MS = 4000;

  function uploadGrid(g, instant) {
    var t = dataTex[0];
    dataTex[0] = dataTex[1];
    dataTex[1] = t;
    gl.deleteTexture(dataTex[1]);
    dataTex[1] = makeDataTexture(g.w, g.h, g.values);
    if (instant || dataSize[0] !== g.w || dataSize[1] !== g.h) {
      gl.deleteTexture(dataTex[0]);
      dataTex[0] = makeDataTexture(g.w, g.h, g.values);
      dataMix = 1;
    } else {
      dataMix = 0;
      dataFadeFrom = performance.now();
    }
    dataSize = [g.w, g.h];
  }

  /* ---------- The coastlines ---------- */

  // globe.json's runs (tools/build-aurora-globe.py), as segments for the line pass.
  function decodeMesh(json) {
    var p = json.precision;
    var segs = [];
    json.coast.forEach(function (run) {
      var x = run[0], y = run[1];
      var prev = Geo.unit(y / p, x / p);
      for (var k = 2; k < run.length; k += 2) {
        x += run[k];
        y += run[k + 1];
        var cur = Geo.unit(y / p, x / p);
        segs.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
        prev = cur;
      }
    });
    return { segs: new Float32Array(segs) };
  }

  /* ---------- Camera ---------- */

  var w = 1, h = 1, dpr = 1;
  // ls is the logarithm of size: the views span four decades of it, so it is what eases.
  // tilt is how far the camera has risen over the ecliptic, 0 side-on to 1 from its north.
  var cam = { lat: VIEWS.north.lat, lon: VIEWS.north.lon, roll: 0, cx: 0.5, cy: 1, ls: Math.log(VIEWS.north.size), size: VIEWS.north.size, dim: 1, tilt: 0 };
  var target = { lat: cam.lat, lon: cam.lon, roll: 0, cx: cam.cx, cy: cam.cy, ls: cam.ls, dim: cam.dim, tilt: 0 };
  var KEYS = ['lat', 'lon', 'roll', 'cx', 'cy', 'ls', 'dim', 'tilt'];
  var spin = 0, spinVel = 0; // degrees, degrees per second
  var resetFrom = null, resetT = 0;
  var progress = NORTH;

  var basis = new Float32Array(9);
  var eye = [0, 0, CAMERA_DIST];
  var radiusPx = 1, focalPx = 1, centerX = 0, centerY = 0; // CSS px
  var detail = 1, shown = 1; // how much of the globe's fine lines, and of the globe, is drawn

  var sunDir = [1, 0, 0];
  var eclPole = [0, 0, 1];
  var earthAu = 1;

  // The globe's radius is a fraction of this: the height on a landscape screen, a
  // little more than the width on a portrait one, and on a portrait screen up to tablet
  // width the width itself, so the globe is the page there.
  function portrait() {
    return w <= 900 && h > w;
  }

  function frame() {
    return portrait() ? w : Math.min(h, w * 0.78);
  }

  // Where the panels leave the globe room: the foot of the top capsule (or, where it
  // parts into pills at the sides, of the switches over the open middle) and the head
  // of the dock, all fixed. Read every frame (a few rects), since the capsule can grow
  // as its text arrives; when they move the views are framed again.
  var clearTop = 0, clearBottom = 0;
  // Where the capsule parts into a pill each side: how far in from the middle each
  // reaches, and their foot. Zero where there is one capsule right across.
  var pillReach = 0, pillFoot = 0;

  function readClearance() {
    var top = document.querySelector('.topdock');
    var controls = document.querySelector('.header-controls');
    var dock = document.querySelector('.dock');
    var parted = !(top && top.getClientRects().length);
    var t = !parted ? top.getBoundingClientRect().bottom
      : controls ? controls.getBoundingClientRect().bottom : 0;
    var b = dock ? dock.getBoundingClientRect().top : h;
    var reach = 0, foot = 0;
    if (parted) {
      var pills = document.querySelectorAll('.top-time, .top-seg');
      for (var i = 0; i < pills.length; i++) {
        if (!pills[i].getClientRects().length) { continue; }
        var r = pills[i].getBoundingClientRect();
        if (r.width <= 0 || getComputedStyle(pills[i]).visibility === 'hidden') { continue; }
        // The gap from the middle of the screen to this pill's near end.
        var gap = r.left > w / 2 ? r.left - w / 2 : w / 2 - r.right;
        reach = reach ? Math.min(reach, gap) : gap;
        foot = Math.max(foot, r.bottom);
      }
    }
    if (t === clearTop && b === clearBottom && reach === pillReach && foot === pillFoot) { return false; }
    clearTop = t;
    clearBottom = b;
    pillReach = reach;
    pillFoot = foot;
    return true;
  }

  /*
   * The camera for both views from space: off the Earth's dusk side, in the ecliptic,
   * with the ecliptic's north up. East on screen is then straight away from the Sun, so
   * the wind blows left to right, and the Earth's own axis leans as it really does. The
   * globe turns under this camera once a day. Returned as the point it faces and the
   * roll that stands the ecliptic's north upright there.
   */
  function spaceAim() {
    var east = [-sunDir[0], -sunDir[1], -sunDir[2]];
    var out = Geo.normalize(Geo.cross(eclPole, sunDir));
    var ll = Geo.latLon(out);
    var la = ll[0] * DEG, lo = ll[1] * DEG;
    var east0 = [-Math.sin(lo), Math.cos(lo), 0];
    var north0 = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    return { lat: ll[0], lon: ll[1], roll: Math.atan2(Geo.dot(east, north0), Geo.dot(east, east0)) / DEG };
  }

  // A view's framing. North and south are placed against the panels: in the north the
  // limb sits below the top capsule by the name's height, in the south the disc's foot
  // sits above the dock by the depth of the name hanging under it. The views from space
  // are sized to the screen: the wind view to a span of Earth radii with the Earth left
  // of centre and its tail running right, the sun view to the model's whole disc with
  // the Sun in the middle of the room the panels leave. lat/lon, and the drivers'
  // framing, are VIEWS' own.
  var PORTRAIT_SIZE = 0.95;
  var NAME_ROOM = 12; // px between the panels and the name

  function viewAt(i) {
    var id = ids[i];
    var v = VIEWS[id];
    var aim, mid;
    if (id === 'wind') {
      aim = spaceAim();
      var pxRe = portrait() ? w / WIND_SPAN_PORTRAIT : Math.min(w / WIND_SPAN, h / WIND_SPAN_TALL);
      mid = (clearTop + (clearBottom > clearTop ? clearBottom : h)) / 2;
      return { lat: aim.lat, lon: aim.lon, roll: aim.roll, cx: portrait() ? 0.56 : 0.36, cy: mid / h,
        size: pxRe / frame(), dim: v.dim, tilt: 0 };
    }
    if (id === 'sun') {
      aim = spaceAim();
      // The largest disc that stands on the room above the dock, centred. Under one
      // capsule it keeps below that. Where the capsule parts into pills it may rise
      // between them, as far as the switches' row, so long as it clears their corners.
      var bottom = (clearBottom > clearTop ? clearBottom : h) - 16;
      var top = clearTop + 12;
      var rad = (bottom - top) / 2;
      if (pillReach > 0) {
        var half = Math.max(0, pillReach - 10), foot = pillFoot + 10;
        // Standing on the dock with its centre at y: clear of a corner at (half, foot)
        // once y is this far down.
        var y = (bottom * bottom - half * half - foot * foot) / (2 * (bottom - foot));
        rad = bottom - Math.max(y, (top + bottom) / 2);
      }
      rad = Math.max(40, Math.min(rad, w * 0.47));
      var pxAu = rad / SUN_DISC_AU;
      return { lat: aim.lat, lon: aim.lon, roll: aim.roll, cx: (w / 2 + earthAu * pxAu) / w, cy: (bottom - rad) / h,
        size: pxAu / AU_RE / frame(), dim: v.dim, tilt: 1 };
    }
    if (id === 'drivers') {
      return { lat: v.lat, lon: v.lon, roll: 0, cx: v.cx, cy: v.cy, size: v.size, dim: v.dim, tilt: 0 };
    }
    var size = portrait() ? PORTRAIT_SIZE : v.size;
    var r = size * frame();
    var fs = NAME_SCALE * r;
    var cy = id === 'north'
      ? (clearTop + NAME_ROOM + (0.72 - NAME_SINK) * fs + r) / h
      : (clearBottom - NAME_ROOM - NAME_HANG * fs - r) / h;
    return { lat: v.lat, lon: v.lon, roll: 0, cx: 0.5, cy: cy, size: size, dim: v.dim, tilt: 0 };
  }

  function wrap180(d) {
    return ((d + 540) % 360) - 180;
  }

  function easeInOut(t) {
    return t * t * (3 - 2 * t);
  }

  function sectionTops() {
    return sections.map(function (s) { return s.offsetTop; });
  }

  var tops = [];

  // Where the page is scrolled to, as a position among the views.
  function readScroll() {
    var y = window.scrollY || window.pageYOffset || 0;
    if (!tops.length) { tops = sectionTops(); }
    var p = 0;
    for (var i = 0; i < tops.length - 1; i++) {
      if (y >= tops[i + 1]) { p = i + 1; continue; }
      if (y > tops[i]) { p = i + (y - tops[i]) / Math.max(1, tops[i + 1] - tops[i]); }
      break;
    }
    progress = Math.max(0, Math.min(ids.length - 1, p));

    var nearest = ids[Math.round(progress)];
    if (document.body.getAttribute('data-view') !== nearest) {
      document.body.setAttribute('data-view', nearest);
      indexLinks.forEach(function (a) {
        if (a.getAttribute('data-view') === nearest) { a.setAttribute('aria-current', 'true'); } else { a.removeAttribute('aria-current'); }
      });
      document.dispatchEvent(new CustomEvent('aurora:view', { detail: { view: nearest } }));
    }
  }

  // The framing that position asks for. Worked out every frame, not only on a scroll:
  // the views from space follow the Sun, which the time slider can move.
  function aim() {
    var at = reducedMotion ? Math.round(progress) : progress;
    var i0 = Math.min(ids.length - 1, Math.floor(at));
    var i1 = Math.min(ids.length - 1, i0 + 1);
    var t = easeInOut(at - i0);
    var a = viewAt(i0), b = viewAt(i1);
    // Between the sun and the wind the zoom and the tilt keep their own pace (ZOOM_EASE).
    var zt = t, tt = t;
    if (ids[i0] === 'sun' && ids[i1] === 'wind') {
      zt = Math.pow(t, ZOOM_EASE);
      tt = smooth(TILT_SPAN[0], TILT_SPAN[1], t);
    }
    target.lat = a.lat + (b.lat - a.lat) * t;
    target.lon = a.lon + wrap180(b.lon - a.lon) * t;
    target.roll = a.roll + wrap180(b.roll - a.roll) * t;
    target.cx = a.cx + (b.cx - a.cx) * t;
    target.cy = a.cy + (b.cy - a.cy) * t;
    target.ls = Math.log(a.size) + (Math.log(b.size) - Math.log(a.size)) * zt;
    target.dim = a.dim + (b.dim - a.dim) * t;
    target.tilt = a.tilt + (b.tilt - a.tilt) * tt;
  }

  // How much of a sideways spin still shows: all of it from north down, none from space.
  function spinShare() {
    return Math.max(0, Math.min(1, progress - (NORTH - 1)));
  }

  function landed() {
    return Math.abs(target.lat - cam.lat) < 1e-3 && Math.abs(wrap180(target.lon - cam.lon)) < 1e-3
      && Math.abs(wrap180(target.roll - cam.roll)) < 1e-3
      && Math.abs(target.cx - cam.cx) < 1e-4 && Math.abs(target.cy - cam.cy) < 1e-4
      && Math.abs(target.ls - cam.ls) < 1e-4 && Math.abs(target.dim - cam.dim) < 1e-3
      && Math.abs(target.tilt - cam.tilt) < 1e-3;
  }

  function stepCamera(dt) {
    var k = reducedMotion ? 1 : 1 - Math.exp(-FOLLOW * dt);
    cam.lat += (target.lat - cam.lat) * k;
    cam.lon = wrap180(cam.lon + wrap180(target.lon - cam.lon) * k);
    cam.roll = wrap180(cam.roll + wrap180(target.roll - cam.roll) * k);
    cam.cx += (target.cx - cam.cx) * k;
    cam.cy += (target.cy - cam.cy) * k;
    cam.ls += (target.ls - cam.ls) * k;
    cam.dim += (target.dim - cam.dim) * k;
    cam.tilt += (target.tilt - cam.tilt) * k;
    // The easing never quite arrives, so it lands once it is within a hair: a still
    // camera is what lets the loop slow down and the overlay stop redrawing.
    if (landed()) {
      KEYS.forEach(function (key) { cam[key] = target[key]; });
    }
    cam.size = Math.exp(cam.ls);

    if (resetFrom !== null) {
      resetT = Math.min(1, resetT + dt * 1000 / RESET_MS);
      spin = resetFrom * (1 - easeInOut(resetT));
      if (resetT >= 1) { resetFrom = null; spin = 0; }
    } else if (!dragging && spinVel) {
      spin = wrap180(spin + spinVel * dt);
      spinVel *= Math.exp(-SPIN_DECAY * dt);
      if (Math.abs(spinVel) < 0.5) { spinVel = 0; }
    }
  }

  // What the layers are handed each frame (see addLayer). Lengths are CSS px.
  var scene = {
    w: 1, h: 1, dpr: 1,
    earthX: 0, earthY: 0, // the Earth's centre on screen
    pxPerRe: 1, // an Earth radius
    pxPerAu: 1,
    earthAu: 1, // the Earth's distance from the Sun
    tilt: 0, // 0 side-on in the ecliptic, 1 from its north
    progress: 0, // position among the views, in page order
    view: 'north', // the nearest view's id
    dim: 1,
    time: 0, // the time shown, ms
    live: true,
    dt: 0, // seconds since the last frame
    clock: 0, // seconds of animation so far; barely moves under reduced motion
    basis: basis, // east, north, out in globe coordinates
    sun: sunDir, // toward the Sun, globe coordinates
    pole: eclPole, // north of the ecliptic, globe coordinates
    clearTop: 0, clearBottom: 0, // the room the panels leave
    portrait: false,
    reducedMotion: reducedMotion,
    fontsReady: false,
    colors: C
  };

  function applyCamera() {
    var lat = cam.lat * DEG;
    var lon = (cam.lon + spin * spinShare()) * DEG;
    var roll = cam.roll * DEG;
    var cl = Math.cos(lat), sl = Math.sin(lat), co = Math.cos(lon), so = Math.sin(lon);
    var cr = Math.cos(roll), sr = Math.sin(roll);
    var e = [-so, co, 0], n = [-sl * co, -sl * so, cl];
    // east, north, out: the columns of uBasis
    basis[0] = cr * e[0] + sr * n[0]; basis[1] = cr * e[1] + sr * n[1]; basis[2] = cr * e[2] + sr * n[2];
    basis[3] = cr * n[0] - sr * e[0]; basis[4] = cr * n[1] - sr * e[1]; basis[5] = cr * n[2] - sr * e[2];
    basis[6] = cl * co; basis[7] = cl * so; basis[8] = sl;
    eye[0] = basis[6] * CAMERA_DIST;
    eye[1] = basis[7] * CAMERA_DIST;
    eye[2] = basis[8] * CAMERA_DIST;

    radiusPx = cam.size * frame();
    focalPx = radiusPx * Math.sqrt(CAMERA_DIST * CAMERA_DIST - 1);
    centerX = cam.cx * w;
    centerY = cam.cy * h;
    detail = smooth(DETAIL_FROM, DETAIL_FULL, radiusPx);
    shown = smooth(GLOBE_FROM, GLOBE_FULL, radiusPx);

    scene.w = w; scene.h = h; scene.dpr = dpr;
    scene.earthX = centerX; scene.earthY = centerY;
    scene.pxPerRe = radiusPx;
    scene.pxPerAu = radiusPx * AU_RE;
    scene.earthAu = earthAu;
    scene.tilt = cam.tilt;
    scene.progress = progress;
    scene.view = ids[Math.round(progress)];
    scene.dim = cam.dim;
    scene.sun = sunDir;
    scene.pole = eclPole;
    scene.clearTop = clearTop; scene.clearBottom = clearBottom;
    scene.portrait = portrait();
    scene.fontsReady = fontsReady;
    scene.colors = C;
  }

  // Globe coordinates to CSS px, exactly as the shaders do it. Returns null when the
  // point is on the far side.
  function projectCss(p) {
    var vx = p[0] * basis[0] + p[1] * basis[1] + p[2] * basis[2];
    var vy = p[0] * basis[3] + p[1] * basis[4] + p[2] * basis[5];
    var vz = p[0] * basis[6] + p[1] * basis[7] + p[2] * basis[8];
    var mu = vz; // p is on the unit sphere, so this is its cosine to the camera axis
    var face = (mu - 1 / CAMERA_DIST) / (1 - 1 / CAMERA_DIST);
    var depth = CAMERA_DIST - vz;
    return { x: centerX + vx * focalPx / depth, y: centerY - vy * focalPx / depth, face: face };
  }

  /* ---------- Sizing ---------- */

  function resize() {
    w = Math.max(1, window.innerWidth);
    h = Math.max(1, stage.clientHeight || window.innerHeight);
    var narrow = w < 700;
    dpr = Math.min(window.devicePixelRatio || 1, narrow ? DPR_CAP_NARROW : DPR_CAP);
    while (dpr > 1 && w * h * dpr * dpr > MAX_PIXELS) { dpr -= 0.25; }
    scene.w = w; scene.h = h; scene.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    auroraScale = Math.min(auroraScale, scaleMax());
    overlayKey = '';
    if (gl && !gl.isContextLost() && auroraProg) { buildTargets(); }
    tops = sectionTops();
    readClearance();
    readScroll();
    layers.forEach(function (l) { if (l.resize) { l.resize(scene); } });
  }

  /* ---------- State the rest of the page sets ---------- */

  var layer = 0, layerTarget = 0; // 0 Seen, 1 Probability
  var LAYER_MS = 600;
  var place = { lat: 55.38, lon: -7.37, label: 'Malin Head' };

  function setLayer(name) {
    layerTarget = name === 'probability' ? 1 : 0;
    if (reducedMotion) { layer = layerTarget; }
  }

  function setPlace(p) {
    if (!p || !isFinite(p.lat) || !isFinite(p.lon)) { return; }
    place = { lat: p.lat, lon: p.lon, label: p.label || '' };
  }

  function setGrid(g) {
    grid = g;
    if (g.power) { power = [g.power.north || 0, g.power.south || 0]; }
    if (!failed && gl && !gl.isContextLost() && sphereProg) { uploadGrid(g, false); }
  }

  /* ---------- Drawing ---------- */

  var magCols = new Float32Array([
    Geo.MAG.x[0], Geo.MAG.x[1], Geo.MAG.x[2],
    Geo.MAG.y[0], Geo.MAG.y[1], Geo.MAG.y[2],
    Geo.MAG.z[0], Geo.MAG.z[1], Geo.MAG.z[2]
  ]);

  function setCamera(p) {
    gl.uniformMatrix3fv(p.u.uBasis, false, basis);
    gl.uniform3f(p.u.uEye, eye[0], eye[1], eye[2]);
    gl.uniform1f(p.u.uDist, CAMERA_DIST);
    gl.uniform1f(p.u.uFocal, focalPx * dpr);
    gl.uniform2f(p.u.uCenter, centerX * dpr, centerY * dpr);
    gl.uniform2f(p.u.uRes, canvas.width, canvas.height);
  }

  function setData(p) {
    if (!p.u.uData) { return; }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dataTex[1]);
    gl.uniform1i(p.u.uData, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dataTex[0]);
    gl.uniform1i(p.u.uDataPrev, 1);
    gl.uniform1f(p.u.uDataMix, dataMix);
    gl.uniform2f(p.u.uDataSize, dataSize[0], dataSize[1]);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, aacgmTex);
    gl.uniform1i(p.u.uAacgm, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, opTex[0]);
    gl.uniform1i(p.u.uOpN, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, opTex[1]);
    gl.uniform1i(p.u.uOpS, 4);
    var f = modelFrame;
    gl.uniform1f(p.u.uModelMix, f.modelMix || 0);
    if (f.modelMix) {
      gl.uniform1f(p.u.uLevelZ, (f.level + 0.5) / window.AuroraModel.dims().nLev);
      gl.uniform1f(p.u.uMltRef, f.mltRef);
      gl.uniform2f(p.u.uAnchor, f.anchor[0], f.anchor[1]);
      gl.uniform2f(p.u.uSlope, f.slope[0], f.slope[1]);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  function render() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);

    // 1. The sphere.
    gl.useProgram(sphereProg);
    setCamera(sphereProg);
    setData(sphereProg);
    var u = sphereProg.u;
    gl.uniform3fv(u.uSun, sunDir);
    gl.uniformMatrix3fv(u.uMag, false, magCols);
    var pn = Geo.unit(place.lat, place.lon);
    var pe = [-Math.sin(place.lon * DEG), Math.cos(place.lon * DEG), 0];
    var pnorth = Geo.cross(pn, pe);
    gl.uniform3fv(u.uPlace, pn);
    gl.uniform3fv(u.uPlaceEast, pe);
    gl.uniform3fv(u.uPlaceNorth, pnorth);
    gl.uniform1f(u.uSkyRad, Geo.horizonAngle(SKY_KM));
    gl.uniform1f(u.uLayer, layer);
    gl.uniform1f(u.uDim, cam.dim);
    gl.uniform1f(u.uDetail, detail);
    gl.uniform1f(u.uShow, shown);
    gl.uniform3fv(u.uInk, C.ink);
    gl.uniform3fv(u.uProb, C.prob);
    gl.uniform3fv(u.uSkyTop, C.skyTop);
    gl.uniform3fv(u.uSkyBottom, C.skyBottom);
    gl.uniform3fv(u.uHaze, C.haze);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, earthTex);
    gl.uniform1i(u.uEarth, 5);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(u.uEarthSize, earthSize[0], earthSize[1]);
    gl.uniform1f(u.uEarthReady, earthImage ? earthReady : 0);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, nameTex);
    gl.uniform1i(u.uName, 6);
    gl.activeTexture(gl.TEXTURE0);
    var arc = nameArc();
    gl.uniform4f(u.uNameArc, arc[0], arc[1], arc[2], arc[3]);
    gl.uniform3fv(u.uSeaN, C.seaN);
    gl.uniform3fv(u.uLandN, C.landN);
    gl.uniform3fv(u.uSeaD, C.seaD);
    gl.uniform3fv(u.uLandD, C.landD);
    gl.uniform3fv(u.uLights, C.lights);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // What surrounds the Earth from space: the layers, over the sky. Each leaves the
    // GL state as it likes; what follows sets its own.
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].ready && layers[i].draw) { layers[i].draw(scene); }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (mesh && lineVao && detail > 0) {
      // 2. Coastlines.
      gl.useProgram(lineProg);
      setCamera(lineProg);
      u = lineProg.u;
      gl.uniform1f(u.uLinePx, LINE_PX * dpr);
      gl.uniform1f(u.uDim, cam.dim);
      gl.uniform4f(u.uColor, C.ink[0], C.ink[1], C.ink[2], C.coastAlpha * detail);
      gl.bindVertexArray(lineVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, lineCount);
    }

    // 3. The aurora, bloomed, added over everything.
    if (auroraTarget && radiusPx >= AURORA_MIN_PX) { drawAurora(); }

    gl.bindVertexArray(null);
  }

  var frameNo = 0;
  var clockS = 0;

  function fullscreen() {
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function drawAurora() {
    var narrow = w < 700;
    var t = auroraTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.width, t.height);
    gl.disable(gl.BLEND);

    var p = auroraProg, u = p.u;
    var sx = t.width / canvas.width;
    gl.useProgram(p);
    gl.uniformMatrix3fv(u.uBasis, false, basis);
    gl.uniform3f(u.uEye, eye[0], eye[1], eye[2]);
    gl.uniform1f(u.uDist, CAMERA_DIST);
    gl.uniform1f(u.uFocal, focalPx * dpr * sx);
    gl.uniform2f(u.uCenter, centerX * dpr * sx, centerY * dpr * (t.height / canvas.height));
    gl.uniform2f(u.uRes, t.width, t.height);
    setData(p);
    gl.uniform3fv(u.uSun, sunDir);
    gl.uniformMatrix3fv(u.uMag, false, magCols);
    gl.uniform1f(u.uTime, clockS);
    gl.uniform1f(u.uLift, AURORA_LIFT);
    gl.uniform1i(u.uSteps, narrow ? MAX_STEPS_NARROW : MAX_STEPS);
    gl.uniform1f(u.uStepLen, narrow ? STEP_LEN * 1.6 : STEP_LEN);
    gl.uniform1f(u.uSeen, 1 - layer);
    gl.uniform1f(u.uProbGlow, layer);
    gl.uniform1f(u.uExposure, exposure);
    gl.uniform2f(u.uPower, power[0], power[1]);
    gl.uniform1f(u.uFrame, frameNo % 64);
    gl.uniform3fv(u.uGreen, C.green);
    gl.uniform3fv(u.uRed, C.red);
    gl.uniform3fv(u.uViolet, C.violet);
    gl.uniform3fv(u.uProbLin, C.probLin);
    fullscreen();

    // Down the chain...
    gl.useProgram(downProg);
    var src = t;
    for (var i = 0; i < BLOOM_LEVELS; i++) {
      var dst = bloomTargets[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.width, dst.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(downProg.u.uSrc, 0);
      gl.uniform2f(downProg.u.uTexel, 1 / src.width, 1 / src.height);
      gl.uniform2f(downProg.u.uDstRes, dst.width, dst.height);
      fullscreen();
      src = dst;
    }

    // ...and back up, each level adding into the one above it.
    gl.useProgram(upProg);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (var k = BLOOM_LEVELS - 2; k >= 0; k--) {
      var up = bloomTargets[k], from = bloomTargets[k + 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, up.fbo);
      gl.viewport(0, 0, up.width, up.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform1i(upProg.u.uSrc, 0);
      gl.uniform2f(upProg.u.uTexel, 1 / from.width, 1 / from.height);
      gl.uniform2f(upProg.u.uDstRes, up.width, up.height);
      fullscreen();
    }

    // Over the globe.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(compositeProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(compositeProg.u.uAurora, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTargets[0].tex);
    gl.uniform1i(compositeProg.u.uBloom, 1);
    gl.uniform2f(compositeProg.u.uRes, canvas.width, canvas.height);
    gl.uniform1f(compositeProg.u.uBloomGain, BLOOM_GAIN / BLOOM_LEVELS);
    gl.uniform1f(compositeProg.u.uDim, cam.dim);
    fullscreen();
    gl.disable(gl.BLEND);
  }

  /*
   * The raymarch's resolution follows the frame rate: when frames come 20% later
   * than the pace asks for, for two seconds, it steps down, and after a long run on
   * time it tries a step up, as far as scaleMax(). A step down holds off any step up
   * for twenty seconds, so it cannot hunt.
   */
  var lateEma = 1, budgetAt = 0, lastDrop = 0;

  function scaleMax() {
    var cap = Math.sqrt(AURORA_PIXELS_MAX / Math.max(1, canvas.width * canvas.height));
    return Math.max(AURORA_SCALE_MIN, Math.min(w < 700 ? AURORA_SCALE_NARROW : 1, cap));
  }

  function adaptScale(now, late, full) {
    // Paced below the display's rate, a frame can only land on the display's own
    // beat, which can be most of a beat after the pace asks for it. So there, only
    // a frame half as late again counts.
    if (!full && late < 1.5) { late = 1; }
    lateEma += (late - lateEma) * 0.08;
    if (now - budgetAt < 2000) { return; }
    budgetAt = now;
    var max = scaleMax();
    var next = Math.min(auroraScale, max);
    if (lateEma > 1.2 && auroraScale > AURORA_SCALE_MIN) {
      next = Math.max(AURORA_SCALE_MIN, auroraScale * 0.85);
      lastDrop = now;
    } else if (lateEma < 1.05 && auroraScale < max && now - lastDrop > 20000) {
      next = Math.min(max, auroraScale * 1.1);
    }
    if (Math.abs(next - auroraScale) > 0.005) {
      auroraScale = next;
      buildTargets();
    }
  }

  /* ---------- Overlay: the place marker, the poles, day and night ---------- */

  var fontsReady = false;
  var overlayKey = ''; // what the overlay last drew from; it redraws only when that changes

  function rgba(c) {
    return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',';
  }

  function drawOverlay() {
    var key = [cam.lat, cam.lon, cam.roll, cam.cx, cam.cy, cam.size, cam.dim, cam.tilt, spin, place.lat, place.lon, place.label, fontsReady,
      sunDir[0].toFixed(4), sunDir[1].toFixed(4), sunDir[2].toFixed(4)].join();
    for (var li = 0; li < layers.length; li++) {
      if (layers[li].ready && layers[li].overlayKey) { key += '|' + layers[li].overlayKey(scene); }
    }
    if (key === overlayKey) { return; }
    overlayKey = key;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (li = 0; li < layers.length; li++) {
      if (layers[li].ready && layers[li].overlay) {
        octx.save();
        layers[li].overlay(octx, scene);
        octx.restore();
      }
    }
    // The globe's own marks leave with its fine lines.
    var alpha = cam.dim * detail;
    if (alpha < 0.01) { return; }
    var ink = rgba(C.ink);
    var mark = rgba(C.place);

    var s = projectCss(Geo.unit(place.lat, place.lon));
    if (s.face > 0.02) {
      var a = Math.min(1, s.face / 0.2) * alpha;
      var x = Math.round(s.x) + 0.5, y = Math.round(s.y) + 0.5;
      octx.beginPath();
      octx.arc(x, y, 4, 0, Math.PI * 2);
      octx.moveTo(x - 11, y); octx.lineTo(x - 6, y);
      octx.moveTo(x + 6, y); octx.lineTo(x + 11, y);
      octx.moveTo(x, y - 11); octx.lineTo(x, y - 6);
      octx.moveTo(x, y + 6); octx.lineTo(x, y + 11);
      octx.strokeStyle = mark + (0.9 * a) + ')';
      octx.lineWidth = 1;
      octx.stroke();
      if (fontsReady && place.label) {
        octx.font = '600 11px ' + C.font;
        if ('letterSpacing' in octx) { octx.letterSpacing = '0.6px'; }
        octx.textBaseline = 'middle';
        octx.fillStyle = mark + (0.85 * a) + ')';
        octx.fillText(place.label.toUpperCase(), x + 16, y);
      }
    }

    // The geomagnetic pole of whichever hemisphere is facing, as a small tick.
    [1, -1].forEach(function (sign) {
      var pole = projectCss([Geo.MAG.z[0] * sign, Geo.MAG.z[1] * sign, Geo.MAG.z[2] * sign]);
      if (pole.face <= 0.05) { return; }
      var pa = Math.min(1, pole.face / 0.25) * alpha * 0.7;
      var px = Math.round(pole.x) + 0.5, py = Math.round(pole.y) + 0.5;
      octx.strokeStyle = ink + pa + ')';
      octx.lineWidth = 1;
      octx.beginPath();
      octx.moveTo(px - 4, py); octx.lineTo(px + 4, py);
      octx.moveTo(px, py - 4); octx.lineTo(px, py + 4);
      octx.stroke();
      if (fontsReady) {
        octx.font = '500 11px ' + C.font;
        if ('letterSpacing' in octx) { octx.letterSpacing = '0.6px'; }
        octx.fillStyle = ink + pa + ')';
        octx.textBaseline = 'middle';
        octx.fillText(sign > 0 ? 'MAG N' : 'MAG S', px + 9, py);
      }
    });

    drawDayNight(alpha, ink);
  }


  // DAY and NIGHT either side of the terminator, set along it as a map sets a river's
  // name, and fixed to the globe: each pair stands where the terminator crosses
  // Ireland's latitude (and the same south), at dusk and at dawn, so it turns with the
  // globe when it's spun and moves only as the terminator itself does. Only the
  // crossings on the facing side show. A short stretch of the line between each pair
  // is drawn up, so it's clear which line they name.
  var DN_LATS = [55, -55];
  var DN_GAP = 8; // px from the line to each label's near edge
  var DN_TEXT = 12; // the labels' height

  function unit3(v) {
    var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function toward(p, d, k) {
    return unit3([p[0] + k * d[0], p[1] + k * d[1], p[2] + k * d[2]]);
  }

  function drawDayNight(alpha, ink) {
    if (!fontsReady || alpha < 0.05) { return; }
    var sun = sunDir;
    octx.font = '600 12px ' + C.font;
    if ('letterSpacing' in octx) { octx.letterSpacing = '1.5px'; }
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';

    // Where the terminator (p . sun = 0) crosses latitude lat: R cos(lon - az) = -sz tan(lat).
    var points = [];
    var R = Math.sqrt(sun[0] * sun[0] + sun[1] * sun[1]), az = Math.atan2(sun[1], sun[0]) / DEG;
    DN_LATS.forEach(function (lat) {
      var c = -sun[2] * Math.tan(lat * DEG) / R;
      if (Math.abs(c) > 1) { return; } // polar day or night: no crossing
      var d = Math.acos(c) / DEG;
      points.push(Geo.unit(lat, az + d), Geo.unit(lat, az - d));
    });

    points.forEach(function (p) {
      var a = projectCss(p);
      if (a.face < 0.12) { return; }

      // The line's direction on screen, turned to read left to right, and its normal
      // turned toward the day side.
      var along = unit3(Geo.cross(sun, p));
      var b = projectCss(toward(p, along, 0.01));
      var tx = b.x - a.x, ty = b.y - a.y;
      var tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-6) { return; }
      tx /= tl; ty /= tl;
      if (tx < 0) { tx = -tx; ty = -ty; }
      var nx = -ty, ny = tx;
      var c = projectCss(toward(p, sun, 0.01));
      if ((c.x - a.x) * nx + (c.y - a.y) * ny < 0) { nx = -nx; ny = -ny; }
      var k = alpha * Math.min(1, 0.4 + a.face);

      // The stretch of terminator between them, fading out each way.
      var half = Math.min(0.08, 46 / radiusPx);
      function on(t) {
        var ct = Math.cos(t), st = Math.sin(t);
        return projectCss([ct * p[0] + st * along[0], ct * p[1] + st * along[1], ct * p[2] + st * along[2]]);
      }
      var e0 = on(-half), e1 = on(half);
      var grad = octx.createLinearGradient(e0.x, e0.y, e1.x, e1.y);
      grad.addColorStop(0, ink + '0)');
      grad.addColorStop(0.5, ink + (0.55 * k) + ')');
      grad.addColorStop(1, ink + '0)');
      octx.beginPath();
      for (var i = 0; i <= 12; i++) {
        var pt = on(-half + i * half / 6);
        if (i) { octx.lineTo(pt.x, pt.y); } else { octx.moveTo(pt.x, pt.y); }
      }
      octx.strokeStyle = grad;
      octx.lineWidth = 1;
      octx.stroke();

      var off = DN_GAP + DN_TEXT / 2, angle = Math.atan2(ty, tx);
      octx.fillStyle = ink + (0.8 * k) + ')';
      [['DAY', 1], ['NIGHT', -1]].forEach(function (l) {
        octx.save();
        octx.translate(a.x + nx * off * l[1], a.y + ny * off * l[1]);
        octx.rotate(angle);
        octx.fillText(l[0], 0, 0);
        octx.restore();
      });
    });
    octx.textAlign = 'start';
  }

  /* ---------- The loop ---------- */

  var running = false;
  var last = 0;
  var readyMarked = false;
  var sunAt = 0;
  var drawnViewTime = null;

  // Anything moving besides the shimmer: the camera, a drag or spin, a layer or data
  // fade, the slider being scrubbed or played, or a layer with something in motion.
  function moving() {
    var M = window.AuroraModel;
    if (dragging || spinVel !== 0 || resetFrom !== null || layer !== layerTarget || dataMix < 1
      || (M ? M.viewTime : null) !== drawnViewTime
      || (earthImage && earthReady < 1)
      || (nameCanvas && nameReady < 1)) { return true; }
    for (var k = 0; k < KEYS.length; k++) {
      if (cam[KEYS[k]] !== target[KEYS[k]]) { return true; }
    }
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].ready && layers[i].moving && layers[i].moving(scene)) { return true; }
    }
    return false;
  }

  function tick(now) {
    if (!running) { return; }
    requestAnimationFrame(tick);
    var fps = moving() ? FPS_MOVING : cam.dim < 0.5 ? FPS_BACKDROP : FPS_IDLE;
    var pace = 1000 / fps;
    // A few ms of slack, so a frame that lands just early on the display's own beat
    // isn't skipped a whole beat.
    if (last && now - last < pace - 4) { return; }
    var dtMs = last ? now - last : pace;
    var dt = Math.min(0.1, dtMs / 1000);
    last = now;
    // The aurora's own clock. Under reduced motion it barely moves.
    clockS += dt * (reducedMotion ? 0.05 : 1);
    frameNo++;
    if (dtMs < 250) { adaptScale(now, dtMs / pace, fps === FPS_MOVING); }

    // The Sun at the time being shown: the slider's, or now.
    var M = window.AuroraModel;
    drawnViewTime = M ? M.viewTime : null;
    if (M && M.viewTime !== null) {
      sunFor(new Date(M.viewTime));
      sunAt = 0;
    } else if (now - sunAt > 30000 || !sunAt) {
      sunFor(new Date());
      sunAt = now;
    }
    scene.time = drawnViewTime === null ? Date.now() : drawnViewTime;
    scene.live = drawnViewTime === null;
    scene.dt = dt;
    scene.clock = clockS;
    stepModel();

    if (layer !== layerTarget) {
      var step = dt * 1000 / LAYER_MS;
      layer = layerTarget > layer ? Math.min(layerTarget, layer + step) : Math.max(layerTarget, layer - step);
    }
    if (dataMix < 1) {
      dataMix = Math.min(1, (now - dataFadeFrom) / DATA_FADE_MS);
    }
    if (earthImage && earthReady < 1) {
      earthReady = reducedMotion ? 1 : Math.min(1, (now - earthFadeFrom) / EARTH_FADE_MS);
    }
    if (nameCanvas && nameReady < 1) {
      nameReady = reducedMotion ? 1 : Math.min(1, (now - nameFadeFrom) / EARTH_FADE_MS);
    }

    if (readClearance()) { readScroll(); }
    aim();
    stepCamera(dt);
    applyCamera();
    render();
    drawOverlay();

    if (!readyMarked) {
      readyMarked = true;
      document.documentElement.classList.add('is-ready');
    }
  }

  // The Sun, and with it the ecliptic and the Earth's place in its orbit, at a time.
  function sunFor(date) {
    sunDir = Geo.sun(date).dir;
    eclPole = Geo.eclipticPole(date);
    earthAu = Geo.sunDistance(date);
  }

  function start() {
    if (running || failed) { return; }
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
  }

  /* ---------- Controls ---------- */

  var dragging = false;
  var dragId = null, dragX = 0, dragY = 0, dragT = 0, dragAxis = null, lastTap = 0;

  function interactive(el) {
    return el && el.closest && el.closest('a, button, input, select, textarea, .place, .legend, .chart, .alerts, .layer-toggle');
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) { return; }
    if (interactive(e.target)) { return; }
    if (spinShare() < 0.5) { return; } // from space the view is set by the Sun, not by hand
    dragId = e.pointerId;
    dragX = e.clientX;
    dragY = e.clientY;
    dragT = performance.now();
    dragAxis = null;
    resetFrom = null;
    spinVel = 0;

    var now = performance.now();
    if (e.pointerType !== 'mouse' && now - lastTap < 320) { resetSpin(); }
    lastTap = now;
  }

  function onMove(e) {
    if (e.pointerId !== dragId) { return; }
    var dx = e.clientX - dragX, dy = e.clientY - dragY;
    if (!dragAxis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) { return; }
      dragAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (dragAxis === 'x') {
        dragging = true;
        document.body.classList.add('is-spinning');
        if (e.target.setPointerCapture) { try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* already released */ } }
      }
    }
    if (dragAxis !== 'x') { return; }
    var now = performance.now();
    var ddeg = -dx / Math.max(1, radiusPx) / DEG;
    spin = wrap180(spin + ddeg);
    var dtm = Math.max(1, now - dragT) / 1000;
    spinVel = spinVel * 0.6 + (ddeg / dtm) * 0.4;
    dragX = e.clientX;
    dragY = e.clientY;
    dragT = now;
    e.preventDefault();
  }

  function onUp(e) {
    if (e.pointerId !== dragId) { return; }
    dragId = null;
    if (dragging && performance.now() - dragT > 80) { spinVel = 0; }
    dragging = false;
    document.body.classList.remove('is-spinning');
  }

  function resetSpin() {
    if (!spin) { return; }
    spinVel = 0;
    if (reducedMotion) { spin = 0; return; }
    resetFrom = spin;
    resetT = 0;
  }

  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { return; }
    if (e.metaKey || e.ctrlKey || e.altKey) { return; }
    if (spinShare() < 0.5) { return; }
    if (e.key === 'r' || e.key === 'R') { resetSpin(); }
    else if (e.key === 'ArrowLeft') { spinVel = 0; resetFrom = null; spin = wrap180(spin - 10); }
    else if (e.key === 'ArrowRight') { spinVel = 0; resetFrom = null; spin = wrap180(spin + 10); }
  }

  /* ---------- Boot ---------- */

  function boot() {
    readColors();
    try {
      initGL();
    } catch (err) {
      if (window.console) { console.error('aurora-globe:', err); }
      fail();
      return;
    }

    // The page opens on the northern view, with the views from space above it to scroll
    // up into. A link to another view, or a reload part-way down, is left where it is.
    var nav = window.performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    var named = ids.indexOf(window.location.hash.slice(1)) >= 0; // #probability is the layer's, not a view
    if (NORTH > 0 && !named && !(nav && (nav.type === 'reload' || nav.type === 'back_forward'))) {
      window.scrollTo(0, sections[NORTH].offsetTop);
    }

    sunFor(new Date());
    resize();
    // Start framed for this screen: the camera eases between views, not in from nowhere.
    aim();
    KEYS.forEach(function (key) { cam[key] = target[key]; });
    cam.size = Math.exp(cam.ls);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', readScroll, { passive: true });
    if (views) {
      views.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      views.addEventListener('dblclick', function (e) { if (!interactive(e.target)) { resetSpin(); } });
    }
    window.addEventListener('keydown', onKey);

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      stop();
    });
    canvas.addEventListener('webglcontextrestored', function () {
      try {
        initGL();
        layers.forEach(initLayer);
        start();
      } catch (err) {
        fail();
      }
    });

    document.addEventListener('aurora:model', function () {
      if (!failed && !gl.isContextLost()) { uploadModel(); }
    });

    loadEarth();

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stop(); } else { start(); }
    });

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { fontsReady = true; overlayKey = ''; setNames(); });
    } else {
      fontsReady = true;
      setNames();
    }

    fetch('assets/data/aurora/globe.json?v=20261102')
      .then(function (r) {
        if (!r.ok) { throw new Error('globe.json ' + r.status); }
        return r.json();
      })
      .then(function (json) {
        mesh = decodeMesh(json);
        if (!gl.isContextLost()) { uploadMesh(); }
      })
      .catch(function (err) {
        if (window.console) { console.error('aurora-globe: no land mesh', err); }
      });

    start();
  }

  // The colour a column of kR of green aurora comes out on screen, before bloom: the
  // same floor, exposure and tone curve as the globe, for the legend's bar.
  function swatch(kR) {
    var t = Math.max(0, Math.min(1, (kR - EYE_FROM) / (EYE_FULL - EYE_FROM)));
    var seen = kR * t * t * (3 - 2 * t);
    var rgb = C.green.map(function (c) {
      var x = c * seen * exposure;
      if (x > 0.8) { x = 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2)); }
      return Math.round(Math.pow(Math.max(0, x), 1 / 2.2) * 255);
    });
    return 'rgb(' + rgb.join(',') + ')';
  }

  /*
   * Layers: what is drawn around the Earth from space (aurora-wind-view.js). A layer is
   * an object with any of
   *
   *   init(gl, kit)        build programs and textures; called again if the context is
   *                        lost and restored. kit has program(vs, fs), HEADER and
   *                        FULLSCREEN_VS, and the canvas.
   *   resize(scene)        the canvas changed size.
   *   draw(scene)          once a frame, after the sky and the Earth and before the
   *                        coasts and the aurora, into the default framebuffer.
   *   overlay(ctx, scene)  labels, on the 2D canvas, in CSS px. Redrawn only when the
   *                        camera or overlayKey(scene) changes.
   *   moving(scene)        true while it has something in motion, to hold the frame rate.
   *
   * A layer that throws in init() is dropped; the globe carries on without it.
   */
  var layers = [];
  var kit = { program: program, HEADER: HEADER, FULLSCREEN_VS: FULLSCREEN_VS, canvas: canvas };

  function initLayer(l) {
    l.ready = false;
    if (failed || !gl || gl.isContextLost() || !sphereProg) { return; }
    try {
      if (l.init) { l.init(gl, kit); }
      l.ready = true;
      if (l.resize) { l.resize(scene); }
    } catch (err) {
      if (window.console) { console.error('aurora-globe: layer', err); }
    }
  }

  function addLayer(l) {
    layers.push(l);
    initLayer(l);
    overlayKey = '';
  }

  window.AuroraGlobe = {
    setLayer: setLayer,
    setPlace: setPlace,
    setGrid: setGrid,
    swatch: swatch,
    gain: GAIN,
    LIFT: AURORA_LIFT,
    addLayer: addLayer,
    scene: scene,
    AU_RE: AU_RE,
    // An Earth radius in CSS px once the camera has settled on a view.
    pxPerReAt: function (id) {
      var k = ids.indexOf(id);
      return k < 0 ? 0 : viewAt(k).size * frame();
    },
    // Scroll to a view by its section's id.
    go: function (id) {
      var k = ids.indexOf(id);
      if (k >= 0) { window.scrollTo({ top: sections[k].offsetTop, behavior: reducedMotion ? 'auto' : 'smooth' }); }
    }
  };

  boot();
})();
