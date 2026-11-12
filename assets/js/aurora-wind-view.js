/*
 * jeremy.ie/aurora — the solar wind, drawn: what surrounds the Earth in the two views
 * from space. A layer of aurora-globe.js (see addLayer there), so it shares the globe's
 * canvas and camera and the zoom from one view to the next is a single move.
 *
 * What it draws goes by the scale the camera has reached, not by which view is
 * nearest, so each thing hands over to the next on the way out:
 *
 *   AT THE EARTH, while an Earth radius is a few pixels to a few tens, and in three
 *   dimensions, since the globe's camera can be swung a little round it there (x
 *   toward the Sun, z north, y toward dusk and the camera). The numbers are
 *   aurora-wind.js's. The magnetopause and the bow shock are surfaces of revolution
 *   about the Sun-Earth line, drawn as a few of their meridians and hoops, the one in
 *   the camera's plane strongest. Between them the sheath glows: its light is added up
 *   along each line of sight, as the aurora's is, so the shock stands out as a bright
 *   limb and the nose, where the wind is piled deepest, is brightest. How bright goes
 *   by the wind's measured pressure. Inside is the field-line sketch, as a cage.
 *
 *   THE WIND ITSELF, as streaks, from there out until the Sun is nearly in frame. They
 *   fill the screen and have depth, run straight away from the Sun, slow and bunch at
 *   the shock and stream on round the magnetopause and down its flanks
 *   (aurora-wind.js's flow, turned about the Sun-Earth line), so the magnetosphere
 *   shows as the hollow they leave. They are added to the picture as light, each with
 *   a soft glow. Their speed on screen and their number follow the speed and density
 *   measured at L1 and carried to the Earth, so a fast, dense wind looks it. The speed
 *   is in pixels, whatever the zoom: at the Earth that is about 130 times faster than
 *   life, and more the further out the camera is.
 *
 *   L1, on the way out, a million and a half km sunward: where that wind is measured,
 *   and how long before it arrives.
 *
 *   FROM THE SUN, once the Sun is in frame and the camera has risen over the ecliptic
 *   (scene.tilt). NOAA's WSA-Enlil run, radial speed as a colour field, sampled per
 *   pixel from a 3D texture (longitude, radius, frame). Between two frames it is read
 *   where its wind was or will be, a parcel moving outward at its own speed, so a
 *   front glides instead of cross-fading. Rings at 0.5, 1 and 1.5 AU are drawn from
 *   screen-space derivatives, a pixel wide, as the globe's graticule is. Over it,
 *   streaks run outward at the model's speed where they are, HELIO_HOURS_PER_S hours
 *   of travel a second, and the inner planets stand where they are today.
 *
 *   The field fills the screen, and the model does not: it ends at 1.7 AU. Past that
 *   (a dashed ring, named) each stream is carried on along its spiral at the speed it
 *   left with, and fades to the ground by the screen's far corner. That is a
 *   continuation, not NOAA's forecast: no stream is let catch another up. Tested on
 *   the model itself, it gives the ring at 1.68 AU from the ring at 1.19 AU to within
 *   9 km/s on average, and it is drawn fading because it gets worse with distance.
 *
 * Tried and taken out: contours every 100 km/s (on a field this smooth they wander,
 * and read as noise), and the model's north-south cut through the Earth, drawn side-on
 * before the camera rose (deep inside it, it was a flat wash over the whole screen).
 *
 * Two speed ramps, both in aurora.css. From the Sun, --wind-1 to --wind-6: one hue,
 * darker for slow, near white for fast, since the field fills the screen and slow wind
 * should recede. At the Earth, --gust-1 to --gust-6: the streaks are light on a dark
 * ground, so slow wind is a warm white and fast wind runs through gold to red. The two
 * cross as the camera moves between the views, each fading with what it colours.
 *
 * Under reduced motion the streaks are drawn where they stand and do not move.
 */
(function () {
  'use strict';

  var Globe = window.AuroraGlobe;
  var Wind = window.AuroraWind;
  var Geo = window.AuroraGeo;
  if (!Globe || !Wind || !Geo || !Globe.addLayer) { return; }

  var DEG = Geo.DEG;
  var L1_RE = Wind.L1_KM / Geo.EARTH_KM;
  var AU_RE = Globe.AU_RE;

  /* ---------- Tunables ---------- */

  // km/s at each of the ramp's six colours.
  var STOPS = [300, 400, 500, 600, 700, 800];

  // At the Earth: shown while an Earth radius is between these sizes, CSS px. The
  // names along the boundaries keep to a narrower range, where there is room for them.
  var MAG_IN = [1.2, 5], MAG_OUT = [70, 180];
  var MAG_LABEL_IN = [5, 10], MAG_LABEL_OUT = [34, 60];
  // The colour field: once an AU is under the first of these, gone above the second.
  var HELIO_PX_AU = [7000, 45000];
  // The two kinds of streak change over between these sizes of an AU: the wind's own
  // above, the model's below.
  var STREAKS_PX_AU = [900, 2500];
  // L1, 235 Earth radii sunward: named while it is on screen and clear of the Earth.
  var L1_IN = [0.12, 0.3], L1_OUT = [2.2, 4.5];

  var FIELD_ALPHA = 0.92; // the colour field's opacity over the ground
  var RING_ALPHA = 0.17;
  var EDGE_ALPHA = 0.34; // the dashed ring where the model ends: it has to be findable
  // Past the model's edge the field fades out by the screen's furthest corner from the
  // Sun, but over no less and no more than this many AU.
  var FADE_AU = [0.8, 2.4];
  // How far round a stream has wound by the time it is an AU further out: degrees of
  // longitude per AU, times its speed in km/s. The Sun turns once in 27.2753 days as
  // the Earth sees it; at 400 km/s this is 57 degrees an AU.
  var SPIRAL = (360 / 27.2753) / (86400 / 1.495978707e8);
  // The field dims toward the top of the screen, where the wordmark's row has no card
  // behind it, and a little toward the foot: CSS px over which, and to what.
  var VEIL_TOP = [24, 150], VEIL_TOP_TO = 0.1, VEIL_FOOT = 110, VEIL_FOOT_TO = 0.45;
  var SUN_SOFT_AU = 0.03; // the model's inner edge, at 0.1 AU, is eased over this

  // The wind's streaks. On screen a 450 km/s wind covers 180 px a second; at the wind
  // view's scale that is 9 Earth radii, where in life it covers 0.07.
  var NEAR_PX_PER_KMS = 0.4; // CSS px a second, per km/s
  var NEAR_TRAIL_S = 0.22; // a streak is this many seconds of its own travel long
  var NEAR_BASE = 1100, NEAR_PER_N = 200, NEAR_MAX = 4600; // how many, by density per cm^3
  var NEAR_LIFE = [7, 16]; // seconds a streak lasts: long enough to cross the screen
  var NEAR_DEPTH = 0.45; // they fill this fraction of the screen's height either side of its plane
  var NEAR_GLOW_PX = 7, NEAR_GLOW = 0.2; // the soft light round each

  // The sheath's glow. Its light is added up over SHEATH_STEPS samples along each line
  // of sight, SHEATH_DEPTH Earth radii either side of the Earth; SHEATH_GAIN sets how
  // bright a pressure of 2 nPa makes it, and it grows with the logarithm of pressure.
  var SHEATH_STEPS = 44, SHEATH_STEPS_NARROW = 26;
  var SHEATH_DEPTH = 46;
  var SHEATH_GAIN = 0.024;
  // A streak in front of or behind the magnetosphere is dimmed to this, so that it shows
  // as the hollow in the wind that it is.
  var NEAR_OVER_CAVITY = 0.1;
  // The far side of the cage is dimmed to this, over this many Earth radii of depth.
  var CAGE_BACK = 0.3, CAGE_DEPTH = 10;
  var NEAR_MARGIN = 40; // px beyond the screen they start and end
  // How far a streak's colour is taken from the ramp toward the ink. The ramp's slow end
  // is close to the ground, which suits a field that fills the screen and would lose a
  // one-pixel streak, so the wind's own streaks are lifted well clear of it.
  var NEAR_LIFT = 0.08;

  // The model's streaks.
  var HELIO_HOURS_PER_S = 10;
  var HELIO_TRAIL_S = 0.55;
  var HELIO_COUNT = 4200, HELIO_COUNT_NARROW = 1800;
  var HELIO_STREAK_ALPHA = 0.42;
  var KMS_TO_AU_PER_H = 3600 / 1.495978707e8;

  var LINE_PX = 1; // field lines and boundaries, CSS px
  var STREAK_PX = 1.25; // the wind's streaks
  var HELIO_STREAK_PX = 1;

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Colours ---------- */

  function cssColor(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    var m = /^#([0-9a-f]{6})$/i.exec(v) || /^#([0-9a-f]{6})$/i.exec(fallback);
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  var RAMP_FALLBACK = ['#16264d', '#1e418a', '#2c68cc', '#5b9aec', '#a5ccf8', '#eaf4fe'];
  var GUST_FALLBACK = ['#fbf3e4', '#fbe2a6', '#f8c062', '#f4933c', '#ea6232', '#d83a3c'];
  var ramp = [], gust = [], ink = [0.93, 0.91, 0.89];

  function readColors() {
    ramp = [];
    gust = [];
    for (var i = 0; i < 6; i++) {
      ramp = ramp.concat(cssColor('--wind-' + (i + 1), RAMP_FALLBACK[i]));
      gust = gust.concat(cssColor('--gust-' + (i + 1), GUST_FALLBACK[i]));
    }
    ink = cssColor('--ink', '#ece9e2');
  }

  function smooth(a, b, x) {
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* ---------- Shaders ---------- */

  var RAMP_GLSL = [
    'uniform vec3 uRamp[6];',
    'uniform float uStops[6];',
    'vec3 rampAt(float v) {',
    '  vec3 c = uRamp[0];',
    '  for (int i = 1; i < 6; i++) { c = mix(c, uRamp[i], clamp((v - uStops[i - 1]) / (uStops[i] - uStops[i - 1]), 0.0, 1.0)); }',
    '  return c;',
    '}'
  ].join('\n');

  function helioFS(kit) {
    return [
      kit.HEADER,
      'uniform vec2 uRes;',
      'uniform vec2 uSun;', // the Sun on screen, device px from the top left
      'uniform float uPxAu;', // device px in an AU
      'uniform float uTilt;', // 0 side-on in the ecliptic, 1 from its north
      'uniform sampler3D uEcl;', // (longitude, radius, frame)
      'uniform vec3 uFrame;', // texture z of the frame before and of the frame after, and how far between
      'uniform float uShift;', // AU a parcel moves per km/s in the time between those two frames
      'uniform vec3 uR;', // first, step, count: radius of the cell centres, AU
      'uniform vec3 uLon;', // degrees
      'uniform vec2 uSpeed;', // km/s at bytes 0 and 255
      'uniform float uData;', // 0 until the run is in
      'uniform float uAlpha;',
      'uniform float uFadeTo;', // AU from the Sun by which the continuation has faded out
      'uniform float uSpin;', // SPIRAL as a turn of the texture's longitude
      'uniform vec3 uVeil;', // device px: the top band's start and end, and the foot band's depth
      'uniform vec3 uInk;',
      RAMP_GLSL,
      'out vec4 outColor;',
      'const float DEG = 0.017453292519943295;',

      'float hair(float f, float w) {',
      '  return clamp(1.0 - abs(f) / max(w, 1e-6), 0.0, 1.0);',
      '}',

      // The speed at longitude coordinate a (0..1 across the texture) and radius r in one frame.
      'float look(float a, float r, float z) {',
      '  float t = ((r - uR.x) / uR.y + 0.5) / uR.z;',
      '  return uSpeed.x + textureLod(uEcl, vec3(a, t, z), 0.0).r * (uSpeed.y - uSpeed.x);',
      '}',

      // Between two frames: from the earlier one, where this wind was; from the later,
      // where it will be; blended by how far between. How far it moved comes from one
      // lookup between the frames, which the texture's own filtering blends.
      'float speedAt(float a, float r) {',
      '  float w = uFrame.z;',
      '  float v = look(a, r, mix(uFrame.x, uFrame.y, w));',
      '  if (w <= 0.001 || w >= 0.999) { return v; }',
      '  float va = look(a, r - v * uShift * w, uFrame.x);',
      '  float vb = look(a, r + v * uShift * (1.0 - w), uFrame.y);',
      '  return mix(va, vb, w);',
      '}',

      // One over another, both premultiplied.
      'vec4 over(vec4 under, vec3 c, float a) {',
      '  return vec4(under.rgb * (1.0 - a) + c * a, under.a + a - under.a * a);',
      '}',

      'void main() {',
      '  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
      '  vec2 s = (frag - uSun) / uPxAu;',
      '  s.y = -s.y;', // AU: x from the Sun toward the Earth, y up the screen
      // The ecliptic, seen from above it by st: edge-on it has no area and is not drawn.
      '  float st = sin(uTilt * 1.5707963);',
      '  float open = smoothstep(0.04, 0.5, st);',
      '  vec2 p = vec2(s.x, s.y / max(st, 1e-3));',
      '  float r = length(p);',
      '  float wr = fwidth(r) + 1e-6;',
      '  float rIn = uR.x - 0.5 * uR.y, rOut = uR.x + (uR.z - 0.5) * uR.y;',
      // Longitude. A pixel row centred exactly on the Sun-Earth line has p.y of 0, and
      // on the far side of the Sun some GL implementations then give atan as 0, not
      // pi, which paints that one row with the Earth's side of the model. The nudge
      // keeps it off zero and is far too small to move anything else.
      '  float lon = atan(p.y + 1e-9, p.x) / DEG;',
      '  float a = ((lon - uLon.x) / uLon.y + 0.5) / uLon.z;',
      // Past the model's edge: the stream here left the edge some time ago, when the
      // spiral had turned less, so it is the one now at the edge further round, by how
      // long it has been travelling. Its speed sets that, so it is found in two steps.
      '  float beyond = max(r - rOut, 0.0);',
      '  if (beyond > 0.0) {',
      '    float z = mix(uFrame.x, uFrame.y, uFrame.z);',
      '    float v0 = look(a, rOut, z);',
      '    v0 = look(a + uSpin * beyond / v0, rOut, z);',
      '    a += uSpin * beyond / v0;',
      '  }',
      '  float v = speedAt(a, clamp(r, rIn, rOut));',
      // Full strength inside the model, eased in at its inner edge (the Sun's glow
      // stands in the hole) and fading out past its outer one.
      '  float field = smoothstep(rIn - ' + SUN_SOFT_AU.toFixed(3) + ', rIn + 0.004, r) * (1.0 - smoothstep(rOut, uFadeTo, r));',
      '  vec4 acc = over(vec4(0.0), rampAt(v), field * uData * ' + FIELD_ALPHA.toFixed(2) + ');',
      // The rings, with or without a run: each half AU inside the model, and its edge
      // dashed, since past it the picture is no longer NOAA's.
      '  float ring = max(max(hair(r - 0.5, wr), hair(r - 1.5, wr)) * 0.6, hair(r - 1.0, wr));',
      '  float edge = hair(r - rOut, wr) * step(0.5, fract(lon / 2.0)) * ' + (EDGE_ALPHA / RING_ALPHA).toFixed(2) + ';',
      '  acc = over(acc, uInk, max(ring, edge) * ' + RING_ALPHA.toFixed(2) + ');',
      '  float veil = mix(' + VEIL_TOP_TO.toFixed(2) + ', 1.0, smoothstep(uVeil.x, uVeil.y, frag.y))',
      '    * mix(' + VEIL_FOOT_TO.toFixed(2) + ', 1.0, smoothstep(0.0, uVeil.z, uRes.y - frag.y));',
      '  outColor = acc * (open * uAlpha * veil);',
      '}'
    ].join('\n');
  }

  // Segments with analytic edges, each end with its own opacity: the cage in Earth
  // radii, in three dimensions, and streaks already placed on screen in device px.
  // Coloured ink, or by speed; crisp, or as a soft glow uLinePx wide.
  function segVS(kit) {
    return [
      kit.HEADER,
      'in vec3 aA;',
      'in vec3 aB;',
      'in vec2 aFade;', // opacity at A and at B
      'in float aV;', // km/s, for the ramp
      'uniform vec2 uRes;',
      'uniform vec2 uOrigin;', // device px
      'uniform vec3 uRowX;', // device px across the screen per unit along each axis
      'uniform vec3 uRowY;', // and down it
      'uniform vec3 uRowZ;', // toward the camera, in units
      'uniform vec2 uDepth;', // the depth over which the far side dims, and what it dims to
      'uniform float uLinePx;',
      'out float vD;',
      'out float vFade;',
      'out float vV;',
      'const vec2 CORNER[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),',
      '  vec2(0.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));',
      'void main() {',
      '  vec2 sa = uOrigin + vec2(dot(aA, uRowX), dot(aA, uRowY));',
      '  vec2 sb = uOrigin + vec2(dot(aB, uRowX), dot(aB, uRowY));',
      '  vec2 c = CORNER[gl_VertexID];',
      '  vec2 dir = sb - sa;',
      '  float len = length(dir);',
      '  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);',
      '  vec2 nrm = vec2(-dir.y, dir.x);',
      '  float hw = uLinePx * 0.5 + 1.0;',
      '  vec2 s = mix(sa, sb, c.x) + nrm * c.y * hw;',
      '  vD = c.y * hw;',
      '  float depth = dot((aA + aB) * 0.5, uRowZ);',
      '  vFade = mix(aFade.x, aFade.y, c.x) * mix(uDepth.y, 1.0, smoothstep(-uDepth.x, uDepth.x, depth));',
      '  vV = aV;',
      '  gl_Position = vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0);',
      '}'
    ].join('\n');
  }

  function segFS(kit) {
    return [
      kit.HEADER,
      'in float vD;',
      'in float vFade;',
      'in float vV;',
      'uniform float uLinePx;',
      'uniform vec3 uInk;',
      'uniform float uBySpeed;', // 0 ink, 1 the ramp at vV
      'uniform float uLift;', // how far the ramp's colour is taken toward the ink
      'uniform float uAlpha;',
      'uniform float uSoft;', // 0 a crisp line, 1 a glow falling off across uLinePx
      'uniform vec3 uKeepOut;', // device px from the top: clear above x, full below y; z is the canvas height
      RAMP_GLSL,
      'out vec4 outColor;',
      'void main() {',
      '  float crisp = clamp(uLinePx * 0.5 + 0.5 - abs(vD), 0.0, 1.0);',
      '  float q = vD / (uLinePx * 0.3);',
      '  float cov = mix(crisp, exp(-q * q), uSoft) * vFade * uAlpha;',
      '  cov *= smoothstep(uKeepOut.x, uKeepOut.y, uKeepOut.z - gl_FragCoord.y);',
      '  if (cov <= 0.002) { discard; }',
      '  vec3 c = mix(uInk, mix(rampAt(vV), uInk, uLift), uBySpeed);',
      '  outColor = vec4(c * cov, cov);',
      '}'
    ].join('\n');
  }

  // The sheath: plasma between two surfaces of revolution about the Sun-Earth line,
  // r = r0 (2 / (1 + cos t))^a each, its light added up along the line of sight.
  function sheathFS(kit) {
    return [
      kit.HEADER,
      'uniform vec2 uRes;',
      'uniform vec2 uEarth;', // device px from the top left
      'uniform float uPxRe;', // device px in an Earth radius
      'uniform vec3 uRight;', // the screen's right, up and toward-the-camera, in the
      'uniform vec3 uUp;', //    magnetosphere's own axes
      'uniform vec3 uOut;',
      'uniform vec2 uMp;', // r0 and a of the magnetopause
      'uniform vec2 uBs;', // and of the bow shock
      'uniform float uGain;',
      'uniform float uAlpha;',
      'uniform vec3 uColor;',
      'uniform int uSteps;',
      'uniform vec3 uKeepOut;',
      'out vec4 outColor;',
      'void main() {',
      '  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
      '  vec2 q = (frag - uEarth) / uPxRe;',
      '  vec3 o = q.x * uRight - q.y * uUp;',
      // A fixed offset for each pixel, so the samples' spacing shows as grain, not bands.
      '  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
      '  float n = float(uSteps);',
      '  float sum = 0.0;',
      '  for (int i = 0; i < 64; i++) {',
      '    if (i >= uSteps) { break; }',
      '    vec3 p = o + uOut * (((float(i) + jit) / n * 2.0 - 1.0) * ' + SHEATH_DEPTH.toFixed(1) + ');',
      '    float r = length(p);',
      '    float c = p.x / max(r, 1e-4);', // cosine of the angle from the Sun-Earth line
      '    float lg = log(2.0 / (1.0 + max(c, -0.98)));',
      '    float mp = uMp.x * exp(uMp.y * lg);',
      '    float bs = uBs.x * exp(uBs.y * lg);',
      '    float k = (r - mp) / (bs - mp);', // 0 on the magnetopause, 1 on the shock
      // Densest at the nose and thinning down the flanks; denser toward the shock,
      // with a bright front just behind it; eased at both surfaces.
      '    float nose = 0.07 + 0.93 * pow(smoothstep(-0.95, 1.0, c), 1.6);',
      '    float across = smoothstep(0.0, 0.14, k) * smoothstep(1.0, 0.94, k) * (0.4 + 0.6 * k * k);',
      '    float front = smoothstep(0.78, 0.95, k) * smoothstep(1.0, 0.95, k);',
      // Far down the tail the samples are too few for so thin a shell, and it is past
      // what the view at the Earth shows, so the glow is let go before then.
      '    sum += nose * (across + 1.4 * front) * (1.0 - smoothstep(55.0, 100.0, r));',
      '  }',
      '  float light = 1.0 - exp(-sum * (2.0 * ' + SHEATH_DEPTH.toFixed(1) + ' / n) * uGain);',
      '  light *= smoothstep(uKeepOut.x, uKeepOut.y, frag.y) * uAlpha;',
      '  outColor = vec4(uColor * light, light);',
      '}'
    ].join('\n');
  }

  /* ---------- GL state ---------- */

  var gl = null, kit = null;
  var helioProg = null, segProg = null, sheathProg = null;
  var emptyVao = null;
  var eclTex = null, blankTex = null, texRun = null;
  var nearBuf = null, helioBuf = null, fieldBuf = null, hoopBuf = null; // { vao, buffer, data, count }

  function make3D(width, height, depth, bytes, wrapS) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, width, height, depth, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    return t;
  }

  // The run as a texture, again whenever a new run arrives. Longitude wraps.
  function uploadRun() {
    var st = Wind.state;
    if (!gl || !st.ecl || !st.atlasMeta) { return; }
    var m = st.atlasMeta;
    if (eclTex) { gl.deleteTexture(eclTex); }
    eclTex = make3D(m.lon.count, m.r.count, m.atlas.frames, st.ecl, gl.REPEAT);
    texRun = st.run;
  }

  // An instanced buffer of segments: 9 floats each (a.xyz, b.xyz, fade a, fade b, speed).
  var SEG = 9;

  function makeSegs(capacity, usage) {
    var vao = gl.createVertexArray();
    var buffer = gl.createBuffer();
    var data = new Float32Array(capacity * SEG);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, usage);
    var stride = SEG * 4;
    [['aA', 3, 0], ['aB', 3, 12], ['aFade', 2, 24], ['aV', 1, 32]].forEach(function (a) {
      var loc = gl.getAttribLocation(segProg, a[0]);
      if (loc < 0) { return; }
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, a[1], gl.FLOAT, false, stride, a[2]);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);
    return { vao: vao, buffer: buffer, data: data, count: 0, capacity: capacity };
  }

  function fillSegs(b) {
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.count * SEG);
  }

  function init(glIn, kitIn) {
    gl = glIn;
    kit = kitIn;
    readColors();
    helioProg = kit.program(kit.FULLSCREEN_VS, helioFS(kit));
    segProg = kit.program(segVS(kit), segFS(kit));
    sheathProg = kit.program(kit.FULLSCREEN_VS, sheathFS(kit));
    emptyVao = gl.createVertexArray();
    eclTex = null;
    texRun = null;
    blankTex = make3D(1, 1, 1, new Uint8Array([0]), gl.REPEAT);
    nearBuf = makeSegs(NEAR_MAX, gl.DYNAMIC_DRAW);
    helioBuf = makeSegs(HELIO_COUNT, gl.DYNAMIC_DRAW);
    fieldBuf = makeSegs(11000, gl.DYNAMIC_DRAW);
    hoopBuf = makeSegs(400, gl.DYNAMIC_DRAW);
    fieldKey = '';
    if (Wind.ready()) { uploadRun(); }
  }

  /* ---------- What is showing ---------- */

  // How strongly each thing is drawn at this frame's scale: the boundaries and field
  // lines, their names, the wind's streaks, L1, the colour field and its streaks.
  var magA = 0, labelA = 0, nearA = 0, l1A = 0, helioA = 0, helioStreakA = 0;

  function weigh(scene) {
    var px = scene.pxPerRe, lau = Math.log(scene.pxPerAu);
    var far = 1 - smooth(MAG_OUT[0], MAG_OUT[1], px); // gone by the time the globe fills the screen
    var model = 1 - smooth(Math.log(STREAKS_PX_AU[0]), Math.log(STREAKS_PX_AU[1]), lau);
    magA = smooth(MAG_IN[0], MAG_IN[1], px) * far * scene.dim;
    labelA = smooth(MAG_LABEL_IN[0], MAG_LABEL_IN[1], px) * (1 - smooth(MAG_LABEL_OUT[0], MAG_LABEL_OUT[1], px)) * scene.dim;
    nearA = far * (1 - model) * scene.dim;
    l1A = smooth(L1_IN[0], L1_IN[1], px) * (1 - smooth(L1_OUT[0], L1_OUT[1], px)) * scene.dim;
    helioA = (1 - smooth(Math.log(HELIO_PX_AU[0]), Math.log(HELIO_PX_AU[1]), lau)) * scene.dim;
    helioStreakA = helioA * model;
  }

  /* ---------- At the Earth ---------- */

  // The wind arriving at the time shown, and the shapes it makes. Looked up again when
  // the time moves on or new data comes; null conditions draw an ordinary day's.
  var up = null, shape = Wind.boundaries(null), tilt = 0;
  var upAt = -1, upStamp = 0, dataStamp = 0;

  function l1() {
    var D = window.AuroraData;
    return D ? { wind: D.state.wind, mag: D.state.mag } : null;
  }

  function conditions(scene) {
    var t = scene.time;
    if (Math.abs(t - upAt) < 20000 && upStamp === dataStamp) { return; }
    upAt = t;
    upStamp = dataStamp;
    up = Wind.upstream(t, l1());
    shape = Wind.boundaries(up);
    document.dispatchEvent(new CustomEvent('aurora:upstream', { detail: { up: up, shape: shape } }));
  }

  document.addEventListener('aurora:data', function (e) {
    if (e.detail && (e.detail.feed === 'wind' || e.detail.feed === 'mag')) { dataStamp++; }
  });
  document.addEventListener('aurora:wind', function () {
    dataStamp++;
    if (gl && Wind.ready() && Wind.state.run !== texRun) { uploadRun(); }
  });

  /*
   * The magnetosphere's axes as the camera sees them: for a point (x toward the Sun, y
   * toward dusk, z north, Earth radii), how far right of the Earth it is on screen, how
   * far up, and how far toward the camera. Side-on that is (-x, z, y); the wobble turns
   * it. The axes are made square from the Sun and the ecliptic's north, which the
   * low-precision formulae leave half a degree off a right angle.
   */
  function axes(scene) {
    var X = scene.sun, b = scene.basis;
    var Y = Geo.normalize(Geo.cross(scene.pole, X));
    var Z = Geo.cross(X, Y);
    function row(k) {
      var e = [b[k], b[k + 1], b[k + 2]];
      return [Geo.dot(X, e), Geo.dot(Y, e), Geo.dot(Z, e)];
    }
    return { right: row(0), up: row(3), out: row(6) };
  }

  function onScreen(scene, M, x, y, z) {
    return {
      x: scene.earthX + (x * M.right[0] + y * M.right[1] + z * M.right[2]) * scene.pxPerRe,
      y: scene.earthY - (x * M.up[0] + y * M.up[1] + z * M.up[2]) * scene.pxPerRe
    };
  }

  // The cage as segments, rebuilt when the shapes or the tilt change: the two
  // boundaries' meridians and hoops, and the field lines.
  var fieldKey = '';

  function buildField() {
    var key = shape.r0.toFixed(2) + ',' + shape.alpha.toFixed(3) + ',' + shape.bs0.toFixed(2) + ',' + tilt.toFixed(3);
    if (key === fieldKey) { return; }
    fieldKey = key;
    var buf = fieldBuf, d = buf.data, n = 0;

    function seg(a, b, fa, fb) {
      if (n >= buf.capacity) { return; }
      var o = n * SEG;
      d[o] = a[0]; d[o + 1] = a[1]; d[o + 2] = a[2];
      d[o + 3] = b[0]; d[o + 4] = b[1]; d[o + 5] = b[2];
      d[o + 6] = fa; d[o + 7] = fb; d[o + 8] = 0;
      n++;
    }

    // Each boundary: the meridian in the plane of the Sun-Earth line and the
    // ecliptic's north at full strength, and two more turned about that line faintly.
    // (Not the one at a right angle: side-on it is a straight line through the Earth.)
    // Bright at the nose and fading down the tail.
    var curves = [[Wind.mpR, 0.85, [50, 90]], [Wind.bsR, 0.5, [90]]];
    curves.forEach(function (curve) {
      [0, 45, 135].forEach(function (turn) {
        var ct = Math.cos(turn * DEG), st = Math.sin(turn * DEG);
        var strength = curve[1] * (turn ? 0.3 : 1);
        var prev = null;
        for (var deg = -158; deg <= 158; deg += 2) {
          var t = deg * DEG, r = curve[0](shape, t);
          var cur = [r * Math.cos(t), r * Math.sin(t) * st, r * Math.sin(t) * ct];
          var f = strength * (1 - 0.75 * smooth(60, 150, Math.abs(deg)));
          if (prev) { seg(prev.p, cur, prev.f, f); }
          prev = { p: cur, f: f };
        }
      });
    });

    Wind.fieldLines3(shape, tilt).forEach(function (line) {
      var p = line.pts, last = p.length / 3 - 1;
      // Inner lines fainter: they crowd at the Earth. The planes off the camera's
      // fainter again. Open ones fade out as they go.
      var base = (line.open ? 0.3 : 0.2 + 0.2 * Math.min(1, line.L / 8)) * (line.phi % 180 ? 0.42 : 1);
      for (var i = 0; i < last; i++) {
        var fa = line.open ? base * (1 - i / last) : base;
        var fb = line.open ? base * (1 - (i + 1) / last) : base;
        seg([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]], [p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5]], fa, fb);
      }
    });
    fieldBuf.count = n;
    fillSegs(fieldBuf);

    // A hoop or two round each boundary, in a buffer of their own: side-on a hoop is a
    // straight line, so they are drawn only as far as the camera has swung to open them.
    buf = hoopBuf; d = buf.data; n = 0;
    curves.forEach(function (curve) {
      curve[2].forEach(function (deg) {
        var t = deg * DEG, r = curve[0](shape, t);
        var prev = null;
        for (var a = 0; a <= 360; a += 5) {
          var cur = [r * Math.cos(t), r * Math.sin(t) * Math.sin(a * DEG), r * Math.sin(t) * Math.cos(a * DEG)];
          if (prev) { seg(prev, cur, curve[1] * 0.3, curve[1] * 0.3); }
          prev = cur;
        }
      });
    });
    hoopBuf.count = n;
    fillSegs(hoopBuf);
  }

  // The wind's streaks, in the magnetosphere's axes (Earth radii), so that they slide
  // past one another when the camera swings. How the wind moves at each comes from the
  // flow in the plane through it and the Sun-Earth line.
  var near = []; // { x, y, z, age, life, lost }
  var nearPx = 0; // the scale they were last stepped at

  function flowAt(p) {
    return Wind.flow(shape, p.x, Math.sqrt(p.y * p.y + p.z * p.z));
  }

  // A streak starts at the sunward side of what the screen shows, or, to fill it at
  // once (and to stand still under reduced motion), anywhere the wind is, part-way
  // through its life. box is that volume in the camera's terms: left, right, bottom,
  // top and half-depth, Earth radii from the Earth.
  function spawnNear(p, box, M, anywhere) {
    p.life = NEAR_LIFE[0] + Math.random() * (NEAR_LIFE[1] - NEAR_LIFE[0]);
    p.age = anywhere ? (0.1 + 0.7 * Math.random()) * p.life : 0;
    for (var tries = 0; tries < 6; tries++) {
      var vx = anywhere ? box.l + Math.random() * (box.r - box.l) : box.l;
      var vy = box.b + Math.random() * (box.t - box.b);
      var vd = (Math.random() * 2 - 1) * box.d;
      p.x = vx * M.right[0] + vy * M.up[0] + vd * M.out[0];
      p.y = vx * M.right[1] + vy * M.up[1] + vd * M.out[1];
      p.z = vx * M.right[2] + vy * M.up[2] + vd * M.out[2];
      if (flowAt(p) !== null) { break; }
    }
    return p;
  }

  function stepNear(scene, dt, M) {
    var v = up && up.v > 0 ? up.v : 420, n = up && up.n > 0 ? up.n : 5;
    var want = Math.round(Math.max(NEAR_BASE, Math.min(NEAR_MAX, NEAR_BASE + NEAR_PER_N * n)) * (scene.w < 700 ? 0.45 : 1));
    var px = scene.pxPerRe, s = scene.dpr;
    var m = NEAR_MARGIN / px;
    var box = { l: -scene.earthX / px - m, r: (scene.w - scene.earthX) / px + m,
      b: -(scene.h - scene.earthY) / px - m, t: scene.earthY / px + m, d: NEAR_DEPTH * scene.h / px };
    while (near.length < want) { near.push(spawnNear({}, box, M, true)); }
    if (near.length > want) { near.length = want; }

    // While the camera zooms, what the screen shows changes faster than the wind can
    // refill it from the sunward side, and streaks sent round again would all come in
    // there at once, as a front. So as the volume grows, the share of streaks that
    // matches the new space is scattered through it, and any that fall outside (or had
    // nowhere to start, the screen being inside the magnetopause) start anywhere.
    var zoom = nearPx > 0 ? px / nearPx : 0;
    var zooming = Math.abs(zoom - 1) > 0.002;
    var scatterShare = zoom < 1 ? 1 - zoom * zoom * zoom : 0;
    nearPx = px;

    var speed = v * NEAR_PX_PER_KMS / px; // Earth radii a second, in the free wind
    var sunRe = scene.earthAu * AU_RE;
    var d = nearBuf.data, count = 0;
    for (var i = 0; i < near.length; i++) {
      var p = near[i];
      var f = flowAt(p);
      var vx = p.x * M.right[0] + p.y * M.right[1] + p.z * M.right[2];
      var vy = p.x * M.up[0] + p.y * M.up[1] + p.z * M.up[2];
      var vd = p.x * M.out[0] + p.y * M.out[1] + p.z * M.out[2];
      var scatter = p.lost || (scatterShare > 0 && Math.random() < scatterShare);
      if (scatter || f === null || vx > box.r || vx < box.l - m || vy > box.t || vy < box.b || Math.abs(vd) > box.d * 1.2 || p.age > p.life) {
        // One that ran its life starts again anywhere; one the wind carried off, or into
        // the magnetopause, comes in again on the sunward side.
        var ended = f !== null && p.age > p.life;
        spawnNear(p, box, M, scatter || zooming || ended);
        if (ended || !(scatter || zooming)) { p.age = 0; }
        f = flowAt(p);
        p.lost = f === null;
        if (f === null) { continue; }
        vd = p.x * M.out[0] + p.y * M.out[1] + p.z * M.out[2];
      }
      // The free wind runs straight away from the Sun, which from the Earth is straight
      // across and fans out as the camera pulls back; in the sheath it follows the flow.
      var ux, uy, uz, frac = 1;
      if (f[0] === -1 && f[1] === 0) {
        ux = p.x - sunRe; uy = p.y; uz = p.z;
        var len = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
        ux /= len; uy /= len; uz /= len;
      } else {
        var rho = Math.sqrt(p.y * p.y + p.z * p.z) || 1;
        frac = Math.sqrt(f[0] * f[0] + f[1] * f[1]) || 1e-6;
        ux = f[0] / frac; uy = f[1] * p.y / rho / frac; uz = f[1] * p.z / rho / frac;
      }
      var step = speed * frac;
      p.x += ux * step * dt; p.y += uy * step * dt; p.z += uz * step * dt;
      p.age += dt;

      // Fades in from birth and out toward the end of its life; the far ones fainter.
      var a = Math.min(1, p.age / 0.5) * Math.min(1, (p.life - p.age) / 0.8) * (0.62 + 0.38 * Math.max(-1, Math.min(1, vd / box.d)));
      // Where the line of sight through it passes inside the magnetopause, on the
      // screen's own plane through the Earth, it is in front of the hollow or behind it.
      vx = p.x * M.right[0] + p.y * M.right[1] + p.z * M.right[2];
      vy = p.x * M.up[0] + p.y * M.up[1] + p.z * M.up[2];
      var qx = vx * M.right[0] + vy * M.up[0], qr = Math.sqrt(vx * vx + vy * vy) || 1e-6;
      var edge = Wind.mpR(shape, Math.acos(Math.max(-1, Math.min(1, qx / qr))));
      a *= NEAR_OVER_CAVITY + (1 - NEAR_OVER_CAVITY) * smooth(0.9, 1.06, qr / edge);
      if (a <= 0) { continue; }
      var trail = step * NEAR_TRAIL_S;
      var head = onScreen(scene, M, p.x, p.y, p.z);
      var tail = onScreen(scene, M, p.x - ux * trail, p.y - uy * trail, p.z - uz * trail);
      var o = count * SEG;
      d[o] = tail.x * s; d[o + 1] = tail.y * s; d[o + 2] = 0;
      d[o + 3] = head.x * s; d[o + 4] = head.y * s; d[o + 5] = 0;
      d[o + 6] = 0;
      d[o + 7] = a * 0.72;
      d[o + 8] = v * frac;
      count++;
    }
    nearBuf.count = count;
    fillSegs(nearBuf);
  }

  // The header's top row (the wordmark and the switches) has no card behind it, so
  // streaks stay out of it: none above HEAD_CLEAR[0] CSS px, all of them below [1].
  var HEAD_CLEAR = [50, 92];

  // Sets the segment program up. o: alpha, bySpeed, lift, px (line width), soft, and M
  // (the camera's axes) for segments in Earth radii; without M they are in device px.
  function useSegs(scene, o) {
    var u = segProg.u, s = scene.dpr;
    gl.useProgram(segProg);
    gl.uniform2f(u.uRes, kit.canvas.width, kit.canvas.height);
    if (o.M) {
      var k = scene.pxPerRe * s;
      gl.uniform2f(u.uOrigin, scene.earthX * s, scene.earthY * s);
      gl.uniform3f(u.uRowX, o.M.right[0] * k, o.M.right[1] * k, o.M.right[2] * k);
      gl.uniform3f(u.uRowY, -o.M.up[0] * k, -o.M.up[1] * k, -o.M.up[2] * k);
      gl.uniform3f(u.uRowZ, o.M.out[0], o.M.out[1], o.M.out[2]);
      gl.uniform2f(u.uDepth, CAGE_DEPTH, CAGE_BACK);
    } else {
      gl.uniform2f(u.uOrigin, 0, 0);
      gl.uniform3f(u.uRowX, 1, 0, 0);
      gl.uniform3f(u.uRowY, 0, 1, 0);
      gl.uniform3f(u.uRowZ, 0, 0, 0);
      gl.uniform2f(u.uDepth, 1, 1);
    }
    gl.uniform1f(u.uLinePx, o.px * s);
    gl.uniform3fv(u.uInk, ink);
    gl.uniform1f(u.uBySpeed, o.bySpeed ? 1 : 0);
    gl.uniform1f(u.uLift, o.lift || 0);
    gl.uniform1f(u.uAlpha, o.alpha);
    gl.uniform1f(u.uSoft, o.soft ? 1 : 0);
    if (o.bySpeed) {
      gl.uniform3f(u.uKeepOut, HEAD_CLEAR[0] * s, HEAD_CLEAR[1] * s, kit.canvas.height);
    } else {
      gl.uniform3f(u.uKeepOut, -2, -1, kit.canvas.height);
    }
    gl.uniform3fv(u.uRamp, o.ramp || ramp);
    gl.uniform1fv(u.uStops, STOPS);
  }

  function drawSegs(b) {
    if (!b.count) { return; }
    gl.bindVertexArray(b.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, b.count);
  }

  // The sheath's glow, added to the picture as light.
  function drawSheath(scene, M) {
    var u = sheathProg.u, s = scene.dpr;
    gl.useProgram(sheathProg);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform2f(u.uRes, kit.canvas.width, kit.canvas.height);
    gl.uniform2f(u.uEarth, scene.earthX * s, scene.earthY * s);
    gl.uniform1f(u.uPxRe, scene.pxPerRe * s);
    gl.uniform3fv(u.uRight, M.right);
    gl.uniform3fv(u.uUp, M.up);
    gl.uniform3fv(u.uOut, M.out);
    gl.uniform2f(u.uMp, shape.r0, shape.alpha);
    gl.uniform2f(u.uBs, shape.bs0, shape.bsAlpha);
    // Brighter with pressure, by its logarithm: 2 nPa is an ordinary day.
    gl.uniform1f(u.uGain, SHEATH_GAIN * Math.max(0.5, Math.min(2.6, 1 + 0.55 * Math.log(shape.pd / 2) / Math.LN2)));
    gl.uniform1f(u.uAlpha, magA);
    // The warm ramp's gold: the wind's own family at the Earth, whatever its speed, so
    // that the glow stays a ground for the streaks and their colour says how fast.
    gl.uniform3f(u.uColor, gust[6] * 0.7 + gust[9] * 0.3, gust[7] * 0.7 + gust[10] * 0.3, gust[8] * 0.7 + gust[11] * 0.3);
    gl.uniform1i(u.uSteps, scene.w < 700 ? SHEATH_STEPS_NARROW : SHEATH_STEPS);
    gl.uniform3f(u.uKeepOut, HEAD_CLEAR[0] * s, HEAD_CLEAR[1] * s, kit.canvas.height);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function drawMag(scene, M) {
    tilt = Wind.dipoleTilt(Geo.MAG.z, scene.sun, scene.pole);
    buildField();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    useSegs(scene, { alpha: magA, px: LINE_PX, M: M });
    drawSegs(fieldBuf);
    // How far the hoops have opened: the Sun-Earth line's lean toward the camera.
    var opened = smooth(0.03, 0.22, Math.abs(M.out[0]));
    if (opened > 0) {
      useSegs(scene, { alpha: magA * opened, px: LINE_PX, M: M });
      drawSegs(hoopBuf);
    }
    gl.bindVertexArray(null);
  }

  // The streaks, as light: a soft glow round each, then the streak itself.
  function drawNear(scene, dt, M) {
    stepNear(scene, dt, M);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    useSegs(scene, { alpha: nearA * NEAR_GLOW, bySpeed: true, lift: NEAR_LIFT, px: NEAR_GLOW_PX, soft: true, ramp: gust });
    drawSegs(nearBuf);
    useSegs(scene, { alpha: nearA, bySpeed: true, lift: NEAR_LIFT, px: STREAK_PX, ramp: gust });
    drawSegs(nearBuf);
    gl.bindVertexArray(null);
  }

  /* ---------- From the Sun ---------- */

  // The model's streaks: a (degrees of longitude), r (AU), and v, the speed each last
  // had from the model, which it keeps once it is past the model's edge.
  var helio = [];

  // One starts at the inner boundary, a little way in so that they don't leave it in
  // ranks, or, to fill the screen at once, anywhere out to where the field has faded.
  function spawnHelio(p, rIn, rFar, anywhere) {
    p.a = Math.random() * 360 - 180;
    p.r = anywhere ? rIn + Math.random() * (rFar - rIn) : rIn + Math.random() * 0.012;
    p.age = anywhere ? 1 : 0;
    p.v = 0;
    return p;
  }

  // Where the field has faded out, AU from the Sun: the screen's furthest corner from
  // it, within FADE_AU of the model's edge.
  function fadeTo(scene, sunX, sunY, rOut) {
    var dx = Math.max(sunX, scene.w - sunX), dy = Math.max(sunY, scene.h - sunY);
    var far = Math.sqrt(dx * dx + dy * dy) / scene.pxPerAu;
    return rOut + Math.max(FADE_AU[0], Math.min(FADE_AU[1], far - rOut));
  }

  function stepHelio(scene, dt, frame, sunX, sunY, rFar) {
    var m = Wind.state.atlasMeta;
    var want = scene.w < 700 ? HELIO_COUNT_NARROW : HELIO_COUNT;
    var rIn = m.r.first - 0.5 * m.r.step, rOut = m.r.first + (m.r.count - 0.5) * m.r.step;
    while (helio.length < want) { helio.push(spawnHelio({}, rIn, rFar, true)); }
    helio.length = want;

    var st = Math.sin(scene.tilt * Math.PI / 2);
    var hours = HELIO_HOURS_PER_S * dt;
    var k = Math.round(frame);
    var d = helioBuf.data, count = 0;
    var s = scene.dpr, pxAu = scene.pxPerAu;
    for (var i = 0; i < helio.length; i++) {
      var p = helio[i];
      // Inside the model its speed is the model's there; past the edge, the speed it
      // left with (or, for one that began out there, the edge's speed at its longitude).
      var v = null;
      if (p.r <= rOut) {
        v = Wind.speedAt(p.r, p.a, k);
      } else if (p.r <= rFar) {
        v = p.v > 0 ? p.v : Wind.speedAt(rOut, p.a, k);
      }
      if (v === null) {
        spawnHelio(p, rIn, rFar, false);
        v = Wind.speedAt(p.r, p.a, k);
        if (v === null) { continue; }
      }
      p.v = v;
      var step = v * KMS_TO_AU_PER_H;
      p.r += step * hours;
      p.age += dt;
      var ca = Math.cos(p.a * DEG), sa = Math.sin(p.a * DEG);
      var hx = sunX + p.r * ca * pxAu, hy = sunY - p.r * sa * st * pxAu;
      if (hx < -NEAR_MARGIN || hx > scene.w + NEAR_MARGIN || hy < -NEAR_MARGIN || hy > scene.h + NEAR_MARGIN) { continue; }
      var rt = Math.max(rIn, p.r - step * HELIO_HOURS_PER_S * HELIO_TRAIL_S);
      var o = count * SEG;
      d[o] = (sunX + rt * ca * pxAu) * s;
      d[o + 1] = (sunY - rt * sa * st * pxAu) * s;
      d[o + 2] = 0;
      d[o + 3] = hx * s;
      d[o + 4] = hy * s;
      d[o + 5] = 0;
      d[o + 6] = 0;
      // In over the first quarter AU, where they are packed closest, and out with the field.
      d[o + 7] = Math.min(1, p.age / 0.5) * smooth(rIn, rIn + 0.25, p.r) * (1 - smooth(rOut, rFar, p.r)) * HELIO_STREAK_ALPHA;
      d[o + 8] = v;
      count++;
    }
    helioBuf.count = count;
    fillSegs(helioBuf);
  }

  function drawHelio(scene, dt) {
    var sunX = scene.earthX - scene.earthAu * scene.pxPerAu, sunY = scene.earthY;
    var s = scene.dpr;
    var m = Wind.state.atlasMeta;
    var has = Wind.ready() && eclTex && m;
    var fr = has ? Wind.frameAt(scene.time) : null;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(helioProg);
    var u = helioProg.u;
    gl.uniform2f(u.uRes, kit.canvas.width, kit.canvas.height);
    gl.uniform2f(u.uSun, sunX * s, sunY * s);
    gl.uniform1f(u.uPxAu, scene.pxPerAu * s);
    gl.uniform1f(u.uTilt, scene.tilt);
    gl.uniform1f(u.uAlpha, helioA);
    gl.uniform3fv(u.uInk, ink);
    gl.uniform3fv(u.uRamp, ramp);
    gl.uniform1fv(u.uStops, STOPS);
    var rOut = m ? m.r.first + (m.r.count - 0.5) * m.r.step : 1.7;
    var rFar = fadeTo(scene, sunX, sunY, rOut);
    gl.uniform1f(u.uFadeTo, rFar);
    gl.uniform1f(u.uSpin, SPIRAL / 360);
    gl.uniform3f(u.uVeil, VEIL_TOP[0] * s, VEIL_TOP[1] * s, VEIL_FOOT * s);
    gl.activeTexture(gl.TEXTURE0);
    if (has && fr) {
      var n = m.atlas.frames, ts = Wind.state.times;
      var k0 = Math.min(n - 1, Math.floor(fr.f)), k1 = Math.min(n - 1, k0 + 1);
      gl.uniform3f(u.uFrame, (k0 + 0.5) / n, (k1 + 0.5) / n, fr.f - k0);
      gl.uniform1f(u.uShift, (ts[k1] - ts[k0]) / 1000 / 1.495978707e8);
      gl.uniform3f(u.uR, m.r.first, m.r.step, m.r.count);
      gl.uniform3f(u.uLon, m.lon.first, m.lon.step, m.lon.count);
      gl.uniform2f(u.uSpeed, m.speed.min, m.speed.max);
      gl.uniform1f(u.uData, 1);
      gl.bindTexture(gl.TEXTURE_3D, eclTex);
    } else {
      // No run yet: the rings alone, at the model's usual extent.
      gl.uniform3f(u.uFrame, 0.5, 0.5, 0);
      gl.uniform1f(u.uShift, 0);
      gl.uniform3f(u.uR, 0.10625, 0.0125, 128);
      gl.uniform3f(u.uLon, -179, 2, 180);
      gl.uniform2f(u.uSpeed, 200, 900);
      gl.uniform1f(u.uData, 0);
      gl.bindTexture(gl.TEXTURE_3D, blankTex);
    }
    gl.uniform1i(u.uEcl, 0);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (has && fr && helioStreakA > 0.004) {
      stepHelio(scene, dt, fr.f, sunX, sunY, rFar);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      useSegs(scene, { alpha: helioStreakA, bySpeed: true, lift: 0.72, px: HELIO_STREAK_PX });
      drawSegs(helioBuf);
    }
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_3D, null);
  }

  /* ---------- The layer ---------- */

  function draw(scene) {
    weigh(scene);
    // Scrolled up at all: the run's picture will be wanted.
    if (scene.view === 'wind' || scene.view === 'sun') { Wind.want(); }
    var dt = reducedMotion ? 0 : scene.dt;
    if (magA > 0.004 || nearA > 0.004 || l1A > 0.004) { conditions(scene); }
    if (helioA > 0.004 && scene.tilt > 0.01) { drawHelio(scene, dt); }
    // The glow, then the streaks, then the cage over both, so its lines stay crisp.
    var M = (nearA > 0.004 || magA > 0.004) ? axes(scene) : null;
    if (magA > 0.004) { drawSheath(scene, M); }
    if (nearA > 0.004) { drawNear(scene, dt, M); }
    if (magA > 0.004) { drawMag(scene, M); }
  }

  function moving() {
    return !reducedMotion && (nearA > 0.004 || helioStreakA > 0.004);
  }

  /* ---------- Labels, on the 2D canvas ---------- */

  function rgba(c, a) {
    return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + a.toFixed(3) + ')';
  }

  function setType(ctx, scene, weight) {
    ctx.font = (weight || 500) + ' 11px ' + scene.colors.font;
    if ('letterSpacing' in ctx) { ctx.letterSpacing = '0.6px'; }
  }

  // A name, haloed in the ground's colour: bone on the pale blue of a fast stream would
  // not read, and a streak passing behind a name would strike it through.
  function label(ctx, scene, text, x, y, a, weight) {
    setType(ctx, scene, weight);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = rgba(scene.colors.night, 0.72 * a);
    ctx.strokeText(text, x, y);
    ctx.fillStyle = rgba(ink, a);
    ctx.fillText(text, x, y);
  }

  // A dot ringed in the ground's colour, for the same reason.
  function dot(ctx, scene, x, y, r, a) {
    ctx.fillStyle = rgba(scene.colors.night, 0.7 * a);
    ctx.beginPath(); ctx.arc(x, y, r + 1.75, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rgba(ink, a);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Names set left of or right of a point, each given up if it would run into one
  // already set: the planets bunch up when the disc is small or they are in line.
  var placed = [];

  function named(ctx, scene, text, x, y, a, weight) {
    setType(ctx, scene, weight);
    var wd = ctx.measureText(text).width;
    var box = { x0: x - 3, x1: x + wd + 3, y0: y - 8, y1: y + 8 };
    for (var i = 0; i < placed.length; i++) {
      var q = placed[i];
      if (box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0) { return; }
    }
    placed.push(box);
    label(ctx, scene, text, x, y, a, weight);
  }

  // Where a boundary's strongest meridian is on screen, at an angle from the Sun-Earth line.
  function onCurve(scene, radius, deg) {
    var t = deg * DEG, r = radius(shape, t);
    return onScreen(scene, axes(scene), r * Math.cos(t), 0, r * Math.sin(t));
  }

  // A name set along a boundary, as the globe sets DAY and NIGHT along the terminator.
  function alongCurve(ctx, scene, text, radius, deg, a) {
    var here = onCurve(scene, radius, deg), next = onCurve(scene, radius, deg + 0.5);
    var x = here.x, y = here.y;
    var ang = Math.atan2(next.y - y, next.x - x);
    if (Math.cos(ang) < 0) { ang += Math.PI; }
    // Off the line on the side away from the Earth.
    var nx = x - scene.earthX, ny = y - scene.earthY, nl = Math.sqrt(nx * nx + ny * ny) || 1;
    ctx.save();
    ctx.translate(x + nx / nl * 11, y + ny / nl * 11);
    ctx.rotate(ang);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    label(ctx, scene, text, 0, 0, a, 600);
    ctx.restore();
  }

  function overlayMag(ctx, scene) {
    if (labelA < 0.03 || !scene.fontsReady) { return; }
    var a = labelA;
    // In the corner by the dock: ten Earth radii, since this view is to scale, and
    // over it which way the Sun is.
    var len = 10 * scene.pxPerRe;
    var bx = 18.5, by = Math.round((scene.clearBottom > 0 ? scene.clearBottom : scene.h) - 20) + 0.5;
    var y = by - 22;

    // The boundaries' names go where there is room for both: south of the Sun-Earth
    // line for choice, nearer to it as the screen shortens, clear of the panels and of
    // that corner. The first angle that fits is taken; failing all, the last.
    var angles = scene.portrait ? [-72, -62, -52, -42, 72, 62] : [-46, -38, -30, -22, 46, 38, 30];
    var top = scene.clearTop + 34, foot = y - 34, side = bx + len + 150;
    var deg = angles[angles.length - 1];
    for (var i = 0; i < angles.length; i++) {
      var p1 = onCurve(scene, Wind.bsR, angles[i]), p2 = onCurve(scene, Wind.mpR, angles[i]);
      var fits = [p1, p2].every(function (p) {
        return p.x > 56 && p.x < scene.w - 56 && p.y > top && p.y < scene.h - 30
          && (p.y < foot || p.x > side) && p.y < (scene.clearBottom > 0 ? scene.clearBottom : scene.h) - 30;
      });
      if (fits) { deg = angles[i]; break; }
    }
    alongCurve(ctx, scene, 'BOW SHOCK', Wind.bsR, deg, 0.85 * a);
    alongCurve(ctx, scene, 'MAGNETOPAUSE', Wind.mpR, deg, 0.85 * a);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    function rules(width, colour) {
      ctx.lineWidth = width;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + len, by); ctx.lineTo(bx + len, by - 4);
      ctx.moveTo(bx + 16, y); ctx.lineTo(bx, y);
      ctx.moveTo(bx + 5, y - 4); ctx.lineTo(bx, y); ctx.lineTo(bx + 5, y + 4);
      ctx.stroke();
    }
    rules(4, rgba(scene.colors.night, 0.72 * a));
    rules(1, rgba(ink, 0.8 * a));
    label(ctx, scene, '10 EARTH RADII', bx + len + 8, by - 2, 0.85 * a, 500);
    label(ctx, scene, 'TO THE SUN', bx + 24, y, 0.85 * a, 500);
  }

  // L1, on the way out: where the wind the page shows is measured.
  function overlayL1(ctx, scene) {
    if (l1A < 0.03 || !scene.fontsReady) { return; }
    var x = Math.round(scene.earthX - L1_RE * scene.pxPerRe) + 0.5, y = Math.round(scene.earthY) + 0.5;
    if (x < 8 || x > scene.w - 8) { return; }
    var a = l1A;
    ctx.textBaseline = 'middle';
    // A diamond, as a spacecraft is marked on an orbit plot.
    function diamond(r) {
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    }
    ctx.fillStyle = rgba(scene.colors.night, 0.7 * a);
    diamond(6.5); ctx.fill();
    ctx.fillStyle = rgba(ink, a);
    diamond(4); ctx.fill();
    // Its name and what it is, under it and centred, so nothing runs into the Earth's.
    ctx.textAlign = 'center';
    label(ctx, scene, 'L1', x, y + 16, a, 600);
    var room = Math.abs(scene.earthX - x) > 150;
    if (room) {
      label(ctx, scene, 'THE WIND IS MEASURED HERE', x, y + 31, 0.8 * a, 500);
      if (up && up.source === 'l1' && up.lagMin > 0) {
        label(ctx, scene, Math.round(up.lagMin) + ' MIN BEFORE IT ARRIVES', x, y + 46, 0.8 * a, 500);
      }
    }
    ctx.textAlign = 'left';
  }

  var NAMES = { mercury: 'MERCURY', venus: 'VENUS', earth: 'EARTH', mars: 'MARS' };
  var bodies = null, bodiesAt = 0;

  function overlayHelio(ctx, scene) {
    var pxAu = scene.pxPerAu;
    var sunX = scene.earthX - scene.earthAu * pxAu, sunY = scene.earthY;
    var st = Math.sin(scene.tilt * Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    placed = [];

    // The Earth, once the globe itself is too small to draw. Named first: of all the
    // names here it is the one that must not give way.
    var small = (1 - smooth(1.0, 2.5, scene.pxPerRe)) * scene.dim;
    if (small > 0.02) {
      var ex = Math.round(scene.earthX) + 0.5, ey = Math.round(scene.earthY) + 0.5;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = rgba(scene.colors.night, 0.6 * small);
      ctx.beginPath(); ctx.arc(ex, ey, 5.5, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = rgba(ink, small);
      ctx.beginPath(); ctx.arc(ex, ey, 5.5, 0, Math.PI * 2); ctx.stroke();
      dot(ctx, scene, ex, ey, 2, small);
      if (scene.fontsReady) { named(ctx, scene, 'EARTH', ex + 12, ey, small, 600); }
      ctx.lineWidth = 1;
    }

    var a = helioA;
    if (a < 0.03) { return; }

    // The Sun: far too small to see at this scale (a pixel or two), so a mark, and a
    // glow that fills the hole the model leaves round it, inside 0.1 AU.
    var hole = 0.1 * pxAu;
    if (sunX > -hole - 20 && sunX < scene.w + hole + 20) {
      var glow = Math.max(16, hole * 1.15);
      var g = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, glow);
      g.addColorStop(0, rgba(ink, 0.6 * a));
      g.addColorStop(0.35, rgba(ink, 0.16 * a));
      g.addColorStop(1, rgba(ink, 0));
      ctx.fillStyle = g;
      ctx.save();
      ctx.translate(sunX, sunY);
      ctx.scale(1, Math.max(st, 0.35)); // flattened with the plane while the camera is low
      ctx.translate(-sunX, -sunY);
      ctx.beginPath(); ctx.arc(sunX, sunY, glow, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = rgba(ink, a);
      ctx.beginPath(); ctx.arc(sunX, sunY, hole > 20 ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
      if (scene.fontsReady) {
        ctx.textAlign = 'center';
        var sy = sunY + Math.max(14, hole * Math.max(st, 0.35) + 11);
        placed.push({ x0: sunX - 16, x1: sunX + 16, y0: sy - 8, y1: sy + 8 });
        label(ctx, scene, 'SUN', sunX, sy, 0.95 * a, 600);
        ctx.textAlign = 'left';
      }
    }

    var open = smooth(0.25, 0.8, st); // what lies in the ecliptic shows once it has opened
    if (open < 0.02 || !scene.fontsReady) { return; }
    if (!bodies || Math.abs(scene.time - bodiesAt) > 600000) {
      bodies = Wind.planets(new Date(scene.time));
      bodiesAt = scene.time;
    }
    // Outermost first: Mars has the most room, Mercury the least.
    bodies.slice().reverse().forEach(function (b) {
      if (b.name === 'earth') { return; }
      var x = sunX + b.r * Math.cos(b.lon * DEG) * pxAu, y = sunY - b.r * Math.sin(b.lon * DEG) * st * pxAu;
      if (y < scene.clearTop + 8) { return; } // behind the capsule, or up among the switches
      dot(ctx, scene, x, y, 2.5, 0.95 * a * open);
      named(ctx, scene, NAMES[b.name], x + 9, y, 0.9 * a * open, 500);
    });

    // The room the panels leave, for names that could go in more than one place.
    var roomTop = scene.clearTop + 16, roomFoot = (scene.clearBottom > 0 ? scene.clearBottom : scene.h) - 16;

    // The 1 AU ring, named where it tops out, or where it bottoms out if a panel is there.
    ctx.textAlign = 'center';
    var ringY = sunY - st * pxAu - 9;
    if (ringY < roomTop) { ringY = sunY + st * pxAu + 10; }
    if (ringY > roomTop && ringY < roomFoot) { label(ctx, scene, '1 AU', sunX, ringY, 0.85 * a * open, 500); }

    // The model's edge, named along its dashed ring at the first of these longitudes
    // that is on screen and clear of the panels. Only once the plane is face on: the
    // name is set along a circle.
    var m = Wind.state.atlasMeta;
    if (m && st > 0.97) {
      var rEdge = (m.r.first + (m.r.count - 0.5) * m.r.step) * pxAu;
      var at = [-28, 28, -40, 40, -14, 14, -152, 152, -166, 166, -62, 62, -118, 118];
      var words = 'NOAA’S MODEL ENDS HERE';
      setType(ctx, scene, 500);
      var half = ctx.measureText(words).width / 2 + 8;
      // Clear of the panels: on screen, below the pills' row at the sides, above the dock.
      var clear = function (x, y) {
        return x > 24 && x < scene.w - 24 && y > Math.max(roomTop, 170) && y < roomFoot - 6;
      };
      for (var i = 0; i < at.length; i++) {
        var t = at[i] * DEG;
        var lx = sunX + (rEdge + 12) * Math.cos(t), ly = sunY - (rEdge + 12) * Math.sin(t);
        var turn = Math.PI / 2 - t; // along the ring, and the right way up
        if (Math.cos(turn) < 0) { turn += Math.PI; }
        // The name runs half its length either way along the ring: both ends need room.
        var ex = half * Math.cos(turn), ey = half * Math.sin(turn);
        if (!clear(lx, ly) || !clear(lx - ex, ly - ey) || !clear(lx + ex, ly + ey)) { continue; }
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(turn);
        label(ctx, scene, words, 0, 0, 0.7 * a * open, 500);
        ctx.restore();
        break;
      }
    }
    ctx.textAlign = 'left';
  }

  function overlay(ctx, scene) {
    weigh(scene);
    overlayHelio(ctx, scene);
    overlayL1(ctx, scene);
    overlayMag(ctx, scene);
  }

  // The labels also follow the shapes, the travel time from L1 and, by the ten minutes,
  // the planets.
  function overlayKey(scene) {
    return [labelA.toFixed(3), l1A.toFixed(3), helioA.toFixed(3), shape.r0.toFixed(2), shape.bs0.toFixed(2), shape.alpha.toFixed(3),
      up && up.lagMin ? Math.round(up.lagMin) : 0, Math.round(scene.time / 600000), scene.fontsReady].join();
  }

  Globe.addLayer({ init: init, draw: draw, overlay: overlay, overlayKey: overlayKey, moving: moving });

  // What the page's panels repeat about how this is drawn (aurora-hud.js).
  window.AuroraWindView = {
    STOPS: STOPS,
    HELIO_HOURS_PER_S: HELIO_HOURS_PER_S,
    // How many times faster than life the wind's streaks run, at a given scale.
    speedup: function (pxPerRe) { return NEAR_PX_PER_KMS / pxPerRe * Geo.EARTH_KM; }
  };
})();
