/*
 * jeremy.ie/aurora — the solar wind, drawn: what surrounds the Earth in the two views
 * from space. A layer of aurora-globe.js (see addLayer there), so it shares the globe's
 * canvas and camera and the zoom from one view to the next is a single move.
 *
 * What it draws goes by the scale the camera has reached, not by which view is
 * nearest, so each thing hands over to the next on the way out:
 *
 *   AT THE EARTH, while an Earth radius is a few pixels to a few tens. The numbers are
 *   aurora-wind.js's: the bow shock and the magnetopause as hairlines, and the
 *   field-line sketch inside them.
 *
 *   THE WIND ITSELF, as streaks, from there out until the Sun is nearly in frame. They
 *   run straight away from the Sun, slow and bunch at the shock and part round the
 *   magnetopause (aurora-wind.js's flow). Their speed on screen and their number
 *   follow the speed and density measured at L1 and carried to the Earth, so a fast,
 *   dense wind looks it. The speed is in pixels, whatever the zoom: at the Earth that
 *   is about 130 times faster than life, and more the further out the camera is.
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
 * Tried and taken out: contours every 100 km/s (on a field this smooth they wander,
 * and read as noise), and the model's north-south cut through the Earth, drawn side-on
 * before the camera rose (deep inside it, it was a flat wash over the whole screen).
 *
 * The speed ramp is --wind-1 to --wind-6 in aurora.css: one hue, darker for slow,
 * near white for fast, the one colour family nothing else on the page uses.
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

  // The wind's streaks. On screen a 450 km/s wind covers 180 px a second; at the wind
  // view's scale that is 9 Earth radii, where in life it covers 0.07.
  var NEAR_PX_PER_KMS = 0.4; // CSS px a second, per km/s
  var NEAR_TRAIL_S = 0.22; // a streak is this many seconds of its own travel long
  var NEAR_BASE = 260, NEAR_PER_N = 120, NEAR_MAX = 2600; // how many, by density per cm^3
  var NEAR_LIFE = [2.5, 6]; // seconds a streak lasts, so they don't march in ranks
  var NEAR_MARGIN = 40; // px beyond the screen they start and end

  // The model's streaks.
  var HELIO_HOURS_PER_S = 10;
  var HELIO_TRAIL_S = 0.55;
  var HELIO_COUNT = 1700, HELIO_COUNT_NARROW = 800;
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

  var RAMP_FALLBACK = ['#244a96', '#2a66c2', '#3f86e0', '#6faaf0', '#a9cff8', '#e9f3fd'];
  var ramp = [], ink = [0.93, 0.91, 0.89];

  function readColors() {
    ramp = [];
    for (var i = 0; i < 6; i++) { ramp = ramp.concat(cssColor('--wind-' + (i + 1), RAMP_FALLBACK[i])); }
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
      '  float inside = clamp((r - rIn) / wr + 0.5, 0.0, 1.0) * clamp((rOut - r) / wr + 0.5, 0.0, 1.0);',
      // Longitude. A pixel row centred exactly on the Sun-Earth line has p.y of 0, and
      // on the far side of the Sun some GL implementations then give atan as 0, not
      // pi, which paints that one row with the Earth's side of the model. The nudge
      // keeps it off zero and is far too small to move anything else.
      '  float a = ((atan(p.y + 1e-9, p.x) / DEG - uLon.x) / uLon.y + 0.5) / uLon.z;',
      '  float v = speedAt(a, clamp(r, rIn, rOut));',
      '  vec4 acc = over(vec4(0.0), rampAt(v), inside * uData * ' + FIELD_ALPHA.toFixed(2) + ');',
      // The rings, with or without a run: where the model starts and ends, and each half AU.
      '  float ring = max(max(hair(r - 0.5, wr), hair(r - 1.5, wr)) * 0.6, hair(r - 1.0, wr));',
      '  ring = max(ring * step(r, rOut), max(hair(r - rIn, wr), hair(r - rOut, wr)) * 0.75);',
      '  acc = over(acc, uInk, ring * ' + RING_ALPHA.toFixed(2) + ');',
      '  outColor = acc * (open * uAlpha);',
      '}'
    ].join('\n');
  }

  // Segments with analytic edges, each end with its own opacity: field lines and
  // boundaries in Earth radii, streaks in device px. Coloured ink, or by speed.
  function segVS(kit) {
    return [
      kit.HEADER,
      'in vec2 aA;',
      'in vec2 aB;',
      'in vec2 aFade;', // opacity at A and at B
      'in float aV;', // km/s, for the ramp
      'uniform vec2 uRes;',
      'uniform vec2 uOrigin;', // device px
      'uniform vec2 uScale;', // device px per unit, each axis signed
      'uniform float uLinePx;',
      'out float vD;',
      'out float vFade;',
      'out float vV;',
      'const vec2 CORNER[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),',
      '  vec2(0.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));',
      'void main() {',
      '  vec2 sa = uOrigin + aA * uScale;',
      '  vec2 sb = uOrigin + aB * uScale;',
      '  vec2 c = CORNER[gl_VertexID];',
      '  vec2 dir = sb - sa;',
      '  float len = length(dir);',
      '  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);',
      '  vec2 nrm = vec2(-dir.y, dir.x);',
      '  float hw = uLinePx * 0.5 + 1.0;',
      '  vec2 s = mix(sa, sb, c.x) + nrm * c.y * hw;',
      '  vD = c.y * hw;',
      '  vFade = mix(aFade.x, aFade.y, c.x);',
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
      'uniform vec3 uKeepOut;', // device px from the top: clear above x, full below y; z is the canvas height
      RAMP_GLSL,
      'out vec4 outColor;',
      'void main() {',
      '  float cov = clamp(uLinePx * 0.5 + 0.5 - abs(vD), 0.0, 1.0) * vFade * uAlpha;',
      '  cov *= smoothstep(uKeepOut.x, uKeepOut.y, uKeepOut.z - gl_FragCoord.y);',
      '  if (cov <= 0.0) { discard; }',
      '  vec3 c = mix(uInk, mix(rampAt(vV), uInk, uLift), uBySpeed);',
      '  outColor = vec4(c * cov, cov);',
      '}'
    ].join('\n');
  }

  /* ---------- GL state ---------- */

  var gl = null, kit = null;
  var helioProg = null, segProg = null;
  var emptyVao = null;
  var eclTex = null, blankTex = null, texRun = null;
  var nearBuf = null, helioBuf = null, fieldBuf = null; // { vao, buffer, data, count }

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

  // An instanced buffer of segments: 7 floats each (a.xy, b.xy, fade a, fade b, speed).
  var SEG = 7;

  function makeSegs(capacity, usage) {
    var vao = gl.createVertexArray();
    var buffer = gl.createBuffer();
    var data = new Float32Array(capacity * SEG);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, usage);
    var stride = SEG * 4;
    [['aA', 2, 0], ['aB', 2, 8], ['aFade', 2, 16], ['aV', 1, 24]].forEach(function (a) {
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
    emptyVao = gl.createVertexArray();
    eclTex = null;
    texRun = null;
    blankTex = make3D(1, 1, 1, new Uint8Array([0]), gl.REPEAT);
    nearBuf = makeSegs(NEAR_MAX, gl.DYNAMIC_DRAW);
    helioBuf = makeSegs(HELIO_COUNT, gl.DYNAMIC_DRAW);
    fieldBuf = makeSegs(6000, gl.DYNAMIC_DRAW);
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

  // Boundaries and field lines as segments, rebuilt when the shapes or the tilt change.
  var fieldKey = '';

  function buildField() {
    var key = shape.r0.toFixed(2) + ',' + shape.alpha.toFixed(3) + ',' + shape.bs0.toFixed(2) + ',' + tilt.toFixed(3);
    if (key === fieldKey) { return; }
    fieldKey = key;
    var d = fieldBuf.data, n = 0;

    function seg(ax, az, bx, bz, fa, fb) {
      if (n >= fieldBuf.capacity) { return; }
      var o = n * SEG;
      d[o] = ax; d[o + 1] = az; d[o + 2] = bx; d[o + 3] = bz; d[o + 4] = fa; d[o + 5] = fb; d[o + 6] = 0;
      n++;
    }

    // The two boundaries, bright at the nose and fading down the tail.
    [[Wind.mpR, 0.85], [Wind.bsR, 0.5]].forEach(function (curve) {
      var prev = null;
      for (var deg = -158; deg <= 158; deg += 1) {
        var t = deg * DEG, r = curve[0](shape, t);
        var cur = [r * Math.cos(t), r * Math.sin(t), curve[1] * (1 - 0.75 * smooth(60, 150, Math.abs(deg)))];
        if (prev) { seg(prev[0], prev[1], cur[0], cur[1], prev[2], cur[2]); }
        prev = cur;
      }
    });

    Wind.fieldLines(shape, tilt).forEach(function (line) {
      var p = line.pts, last = p.length / 2 - 1;
      // Inner lines fainter: they crowd at the Earth. Open ones fade out as they go.
      var base = line.open ? 0.3 : 0.2 + 0.2 * Math.min(1, line.L / 8);
      for (var i = 0; i < last; i++) {
        var fa = line.open ? base * (1 - i / last) : base;
        var fb = line.open ? base * (1 - (i + 1) / last) : base;
        seg(p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3], fa, fb);
      }
    });
    fieldBuf.count = n;
    fillSegs(fieldBuf);
  }

  // The wind's streaks, in CSS px on screen. Where one stands in the magnetosphere's
  // plane (x toward the Sun, z north, Earth radii) says how the wind moves there.
  var near = []; // { x, y, age, life }

  // A streak starts at the sunward edge, or, to fill the screen at once (and to stand
  // still under reduced motion), anywhere the wind is, part-way through its life.
  function spawnNear(p, scene, anywhere) {
    p.life = NEAR_LIFE[0] + Math.random() * (NEAR_LIFE[1] - NEAR_LIFE[0]);
    p.x = -NEAR_MARGIN;
    p.y = -NEAR_MARGIN + Math.random() * (scene.h + 2 * NEAR_MARGIN);
    p.age = 0;
    if (anywhere) {
      for (var tries = 0; tries < 6; tries++) {
        var x = -NEAR_MARGIN + Math.random() * (scene.w + 2 * NEAR_MARGIN);
        var y = -NEAR_MARGIN + Math.random() * (scene.h + 2 * NEAR_MARGIN);
        if (Wind.flow(shape, (scene.earthX - x) / scene.pxPerRe, (scene.earthY - y) / scene.pxPerRe) !== null) {
          p.x = x; p.y = y;
          break;
        }
      }
      p.age = (0.15 + 0.6 * Math.random()) * p.life;
    }
    return p;
  }

  function stepNear(scene, dt) {
    var v = up && up.v > 0 ? up.v : 420, n = up && up.n > 0 ? up.n : 5;
    var want = Math.round(Math.max(NEAR_BASE, Math.min(NEAR_MAX, NEAR_BASE + NEAR_PER_N * n)) * (scene.w < 700 ? 0.5 : 1));
    while (near.length < want) { near.push(spawnNear({}, scene, true)); }
    if (near.length > want) { near.length = want; }

    var speed = v * NEAR_PX_PER_KMS; // px a second, in the free wind
    var sunX = scene.earthX - scene.earthAu * scene.pxPerAu, sunY = scene.earthY;
    var px = scene.pxPerRe, s = scene.dpr;
    var d = nearBuf.data, count = 0;
    for (var i = 0; i < near.length; i++) {
      var p = near[i];
      var f = Wind.flow(shape, (scene.earthX - p.x) / px, (scene.earthY - p.y) / px);
      if (f === null || p.x > scene.w + NEAR_MARGIN || p.y < -NEAR_MARGIN || p.y > scene.h + NEAR_MARGIN || p.age > p.life) {
        // One that ran its life starts again anywhere; one the wind carried off, or into
        // the magnetopause, comes in again at the sunward edge.
        spawnNear(p, scene, f !== null && p.age > p.life);
        if (p.age > 0) { p.age = 0; }
        f = Wind.flow(shape, (scene.earthX - p.x) / px, (scene.earthY - p.y) / px);
        if (f === null) { p.x = -NEAR_MARGIN; f = [-1, 0]; }
      }
      // On screen: the free wind runs straight away from the Sun, which from the Earth
      // is straight across, and fans out as the camera pulls back; in the sheath it
      // follows the flow, whose x is toward the Sun (left) and z north (up).
      var ux, uy, frac = 1;
      if (f[0] === -1 && f[1] === 0) {
        ux = p.x - sunX; uy = p.y - sunY;
        var len = Math.sqrt(ux * ux + uy * uy) || 1;
        ux /= len; uy /= len;
      } else {
        frac = Math.sqrt(f[0] * f[0] + f[1] * f[1]);
        ux = -f[0]; uy = -f[1];
        if (frac > 1e-6) { ux /= frac; uy /= frac; }
      }
      p.x += ux * speed * frac * dt;
      p.y += uy * speed * frac * dt;
      p.age += dt;

      // Fades in from birth, out toward the end of its life.
      var a = Math.min(1, p.age / 0.4) * Math.min(1, (p.life - p.age) / 0.6);
      if (a <= 0) { continue; }
      var trail = speed * frac * NEAR_TRAIL_S;
      var o = count * SEG;
      d[o] = (p.x - ux * trail) * s; // tail
      d[o + 1] = (p.y - uy * trail) * s;
      d[o + 2] = p.x * s; // head
      d[o + 3] = p.y * s;
      d[o + 4] = 0;
      d[o + 5] = a * 0.85;
      d[o + 6] = v * frac;
      count++;
    }
    nearBuf.count = count;
    fillSegs(nearBuf);
  }

  // The header's top row (the wordmark and the switches) has no card behind it, so
  // streaks stay out of it: none above HEAD_CLEAR[0] CSS px, all of them below [1].
  var HEAD_CLEAR = [50, 92];

  function useSegs(scene, alpha, bySpeed, lift, linePx, ox, oy, sx, sy) {
    var u = segProg.u;
    gl.useProgram(segProg);
    gl.uniform2f(u.uRes, kit.canvas.width, kit.canvas.height);
    gl.uniform2f(u.uOrigin, ox, oy);
    gl.uniform2f(u.uScale, sx, sy);
    gl.uniform1f(u.uLinePx, linePx * scene.dpr);
    gl.uniform3fv(u.uInk, ink);
    gl.uniform1f(u.uBySpeed, bySpeed);
    gl.uniform1f(u.uLift, lift);
    gl.uniform1f(u.uAlpha, alpha);
    if (bySpeed) {
      gl.uniform3f(u.uKeepOut, HEAD_CLEAR[0] * scene.dpr, HEAD_CLEAR[1] * scene.dpr, kit.canvas.height);
    } else {
      gl.uniform3f(u.uKeepOut, -2, -1, kit.canvas.height);
    }
    gl.uniform3fv(u.uRamp, ramp);
    gl.uniform1fv(u.uStops, STOPS);
  }

  function drawSegs(b) {
    if (!b.count) { return; }
    gl.bindVertexArray(b.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, b.count);
  }

  function drawMag(scene) {
    tilt = Wind.dipoleTilt(Geo.MAG.z, scene.sun, scene.pole);
    buildField();
    var s = scene.dpr;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    useSegs(scene, magA, 0, 0, LINE_PX, scene.earthX * s, scene.earthY * s, -scene.pxPerRe * s, -scene.pxPerRe * s);
    drawSegs(fieldBuf);
    gl.bindVertexArray(null);
  }

  function drawNear(scene, dt) {
    stepNear(scene, dt);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    useSegs(scene, nearA, 1, 0.25, STREAK_PX, 0, 0, 1, 1);
    drawSegs(nearBuf);
    gl.bindVertexArray(null);
  }

  /* ---------- From the Sun ---------- */

  // The model's streaks: a (degrees of longitude), r (AU).
  var helio = [];

  // One starts at the inner boundary, a little way in so that they don't leave it in
  // ranks, or, to fill the disc at once, anywhere.
  function spawnHelio(p, rIn, rOut, anywhere) {
    p.a = Math.random() * 360 - 180;
    p.r = anywhere ? rIn + Math.random() * (rOut - rIn) : rIn + Math.random() * 0.012;
    p.age = anywhere ? 1 : 0;
    return p;
  }

  function stepHelio(scene, dt, frame, sunX, sunY) {
    var m = Wind.state.atlasMeta;
    var want = scene.w < 700 ? HELIO_COUNT_NARROW : HELIO_COUNT;
    var rIn = m.r.first - 0.5 * m.r.step, rOut = m.r.first + (m.r.count - 0.5) * m.r.step;
    while (helio.length < want) { helio.push(spawnHelio({}, rIn, rOut, true)); }
    helio.length = want;

    var st = Math.sin(scene.tilt * Math.PI / 2);
    var hours = HELIO_HOURS_PER_S * dt;
    var k = Math.round(frame);
    var d = helioBuf.data, count = 0;
    var s = scene.dpr, pxAu = scene.pxPerAu;
    for (var i = 0; i < helio.length; i++) {
      var p = helio[i];
      var v = p.r > rOut ? null : Wind.speedAt(p.r, p.a, k);
      if (v === null) {
        spawnHelio(p, rIn, rOut, false);
        v = Wind.speedAt(p.r, p.a, k);
        if (v === null) { continue; }
      }
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
      d[o + 2] = hx * s;
      d[o + 3] = hy * s;
      d[o + 4] = 0;
      // In over the first quarter AU, where they are packed closest, and out toward the edge.
      d[o + 5] = Math.min(1, p.age / 0.5) * smooth(rIn, rIn + 0.25, p.r) * (1 - smooth(rOut - 0.18, rOut, p.r)) * HELIO_STREAK_ALPHA;
      d[o + 6] = v;
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
      stepHelio(scene, dt, fr.f, sunX, sunY);
      useSegs(scene, helioStreakA, 1, 0.72, HELIO_STREAK_PX, 0, 0, 1, 1);
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
    // Streaks under the field lines and boundaries, so those stay crisp.
    if (nearA > 0.004) { drawNear(scene, dt); }
    if (magA > 0.004) { drawMag(scene); }
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

  // Where a boundary is on screen at an angle from the Sun-Earth line.
  function onCurve(scene, radius, deg) {
    var t = deg * DEG, r = radius(shape, t);
    return { x: scene.earthX - r * Math.cos(t) * scene.pxPerRe, y: scene.earthY - r * Math.sin(t) * scene.pxPerRe };
  }

  // A name set along a boundary, as the globe sets DAY and NIGHT along the terminator.
  function alongCurve(ctx, scene, text, radius, deg, a) {
    var t = deg * DEG, e = 0.5 * DEG;
    var r = radius(shape, t), r2 = radius(shape, t + e);
    var px = scene.pxPerRe;
    var x = scene.earthX - r * Math.cos(t) * px, y = scene.earthY - r * Math.sin(t) * px;
    var x2 = scene.earthX - r2 * Math.cos(t + e) * px, y2 = scene.earthY - r2 * Math.sin(t + e) * px;
    var ang = Math.atan2(y2 - y, x2 - x);
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

    // The Sun: far too small to see at this scale (a pixel and a half), so a mark.
    if (sunX > -20 && sunX < scene.w + 20) {
      var g = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 16);
      g.addColorStop(0, rgba(ink, 0.5 * a));
      g.addColorStop(1, rgba(ink, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sunX, sunY, 16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(ink, a);
      ctx.beginPath(); ctx.arc(sunX, sunY, 3.5, 0, Math.PI * 2); ctx.fill();
      if (scene.fontsReady) {
        // Under the hole the model leaves round the Sun, inside 0.1 AU.
        ctx.textAlign = 'center';
        var sy = sunY + Math.max(14, 0.1 * pxAu * Math.max(st, 0.35) + 11);
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
      dot(ctx, scene, x, y, 2.5, 0.95 * a * open);
      named(ctx, scene, NAMES[b.name], x + 9, y, 0.9 * a * open, 500);
    });

    // The 1 AU ring, named where it tops out.
    ctx.textAlign = 'center';
    label(ctx, scene, '1 AU', sunX, sunY - st * pxAu - 9, 0.85 * a * open, 500);
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
