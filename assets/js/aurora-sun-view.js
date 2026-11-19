/*
 * jeremy.ie/aurora — the Sun as GOES-19 sees it, on the globe's stage.
 *
 * A layer (AuroraGlobe.addLayer, as aurora-wind-view.js is) that draws SUVI's 171
 * Angstrom picture of the Sun where the Sun is, at its true size: at the system view
 * that is a pixel or two, so it shows only as the camera zooms in toward the sun view,
 * taking over from the system view's mark. Frames come from aurora-sun.js; the one
 * shown is the newest at or before the time being shown, faded into the next, so the
 * time slider plays the day back. Live it shows the newest at NOAA's own size.
 *
 * The picture is face-on, solar north up, as GOES sees it from the Earth, and the camera
 * comes round to look at the Sun from the Earth's side on its way in (aurora-globe.js,
 * helioBasis), through the lens the wind is drawn with. On the way the picture is laid on the half of the Sun
 * that faces the Earth, so it turns with the camera: from above, the half GOES sees is
 * the half toward the Earth, and the far half, which nobody on the Earth sees, glows
 * in the picture's own colour (its average over a few points on the disc), dimmer in
 * the middle and brighter toward the limb, as the corona is at 171 Angstroms, with no
 * detail it could not have. The corona round the limb shows only once the camera faces the Sun
 * from the Earth, since off the disc the picture is flat. It is masked round, out to
 * MASK solar radii, which also leaves out NOAA's caption; past that a soft halo in its
 * colour, out to HALO solar radii, carries the corona on into the wind round it.
 *
 * With the corona on (the switch in the header, AuroraGlobe.setCorona), the camera
 * pulls back and the halo gives way to the corona itself, as CCOR-1, the coronagraph on
 * the same spacecraft, sees it in white light (aurora-sun.js, AuroraCorona): its
 * brightness drawn in white, from where its occulter's edge is clean to where its field
 * is, CORONA_FIELD solar radii. Between the two pictures neither instrument sees, and
 * the dark ring is left dark. It follows the time slider as the disc does.
 */
(function () {
  'use strict';

  var Globe = window.AuroraGlobe;
  var Sun = window.AuroraSun;
  var Corona = window.AuroraCorona;
  var Geo = window.AuroraGeo;
  if (!Globe || !Sun || !Corona || !Geo) { return; }

  var SUN_RE = 109.08; // the Sun's radius in Earth radii
  var MASK = [1.38, 1.52]; // solar radii: the picture fades out between these
  var HALO = 7, HALO_GAIN = 0.2, HALO_FALL = 2.6; // the halo: out to, at the limb, falling as r^-this
  var SHOW_PX = [2, 9]; // and in as the Sun's radius on screen grows between these
  var WAITING = [0.30, 0.27, 0.24]; // a plain disc, until the first frame is in
  var UNSEEN = [0.62, 0.55]; // the far half: its glow at the middle, and how much more at the limb
  // The coronagraph: in from, in to, out from, out to (solar radii); its white; and the
  // curve its brightness is drawn on: from a floor (the speckle under the faint outer
  // field), to a power, times a gain.
  var CORONA_FIELD = [4.5, 5.0, 17.5, 19.5];
  var CORONA_WHITE = [0.93, 0.94, 0.96], CORONA_CURVE = [0.06, 1.5, 1.0];

  function smooth(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  // The fullscreen triangle, and the picture's colour (its average over five points on the
  // disc), worked out once per corner rather than for every pixel the halo covers.
  function sunVS(kit) {
    return [
      kit.HEADER,
      'uniform sampler2D uA;',
      'uniform sampler2D uB;',
      'uniform float uMix;',
      'uniform float uFrac;',
      'flat out vec3 vTone;',
      'vec3 picture(vec2 d) {',
      '  vec2 uv = 0.5 + d * uFrac;',
      '  return mix(textureLod(uA, uv, 0.0).rgb, textureLod(uB, uv, 0.0).rgb, uMix);',
      '}',
      'void main() {',
      '  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);',
      '  vTone = (picture(vec2(0.0)) + picture(vec2(0.45, 0.0)) + picture(vec2(-0.45, 0.0))',
      '    + picture(vec2(0.0, 0.45)) + picture(vec2(0.0, -0.45))) * 0.2;',
      '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
      '}'
    ].join('\n');
  }

  function sunFS(kit) {
    return [
      kit.HEADER,
      'uniform vec2 uRes;',
      'uniform vec2 uSun;', // device px, from the top left
      'uniform float uR;', // the Sun's radius, device px
      'uniform float uFrac;', // the Sun's radius as a fraction of the frame's width
      'uniform sampler2D uA;',
      'uniform sampler2D uB;',
      'uniform float uMix;', // 0 shows uA, 1 uB
      'uniform float uMode;', // 0 the frames, 1 a plain disc while none is in
      'uniform vec3 uWaiting;',
      'uniform vec2 uUnseen;',
      // The camera in the ecliptic, x toward the Earth, y the way the planets go round,
      // z north: the screen's right, its up, and toward the camera. GOES's own is y, z, x.
      'uniform vec3 uRight;',
      'uniform vec3 uUp;',
      'uniform vec3 uToward;',
      'uniform vec2 uMask;',
      'uniform vec3 uHalo;', // reach (solar radii), strength at the limb, fall-off
      'uniform float uAlpha;',
      'flat in vec3 vTone;', // the picture's colour (sunVS)
      'out vec4 outColor;',
      'void main() {',
      '  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
      '  vec2 d = (frag - uSun) / uR;', // solar radii, y down as the picture's rows
      '  float r = length(d);',
      '  if (r > uHalo.x) { discard; }',
      '  vec3 c;',
      '  float a = (1.0 - smoothstep(uMask.x, uMask.y, r)) * uAlpha;',
      '  if (uMode > 0.5) {',
      '    float w = fwidth(r);',
      '    c = uWaiting;',
      '    a = (1.0 - smoothstep(1.0 - w, 1.0 + w, r)) * uAlpha;',
      '  } else if (r > uMask.y) {',
      // Past the picture's mask only the halo, in the picture's colour.
      '    c = vTone * uHalo.y * pow(r, -uHalo.z) * (1.0 - smoothstep(uHalo.x * 0.6, uHalo.x, r));',
      '    a = uAlpha;',
      '  } else {',
      '    vec3 tone = vTone;',
      // On the disc: the point of the sphere under this pixel, and where GOES pictured
      // it, if it faces the Earth.
      '    vec3 p = d.x * uRight - d.y * uUp + sqrt(max(0.0, 1.0 - r * r)) * uToward;',
      '    vec2 uv = 0.5 + vec2(p.y, -p.z) * uFrac;',
      '    vec3 disc = mix(texture(uA, uv).rgb, texture(uB, uv).rgb, uMix);',
      // Fully pictured up to GOES's own limb (p.x 0), so that face-on it is NOAA's picture
      // exactly; just past it, eased into the plain far side.
      '    float rim = 1.0 - sqrt(max(0.0, 1.0 - r * r));',
      '    vec3 far = tone * (uUnseen.x + uUnseen.y * rim * rim);',
      '    disc = mix(far, disc, smoothstep(-0.12, 0.0, p.x));',
      // Off it: the corona, flat as pictured, once the camera faces the Sun from the Earth.
      '    vec2 fuv = 0.5 + d * uFrac;',
      '    vec3 corona = mix(texture(uA, fuv).rgb, texture(uB, fuv).rgb, uMix) * smoothstep(0.96, 1.0, uToward.x);',
      '    float w = fwidth(r);',
      '    c = mix(corona, disc, 1.0 - smoothstep(1.0 - w, 1.0 + w, r));',
      // Within the mask, the halo begins under the corona as it fades.
      '    float halo = uHalo.y * pow(max(r, 1.0), -uHalo.z) * (1.0 - smoothstep(uHalo.x * 0.6, uHalo.x, r)) * smoothstep(1.0, 1.4, r);',
      '    c = c * (1.0 - smoothstep(uMask.x, uMask.y, r)) + tone * halo;',
      '    a = uAlpha;',
      '  }',
      // Added to what is under it: the picture's black sky leaves the page's own
      // dark showing, rather than a darker ring round the corona. The plain disc,
      // which has no sky, covers.
      '  outColor = uMode > 0.5 ? vec4(c * a, a) : vec4(c * a, 0.0);',
      '}'
    ].join('\n');
  }

  function coronaVS(kit) {
    return [
      kit.HEADER,
      'void main() {',
      '  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);',
      '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
      '}'
    ].join('\n');
  }

  function coronaFS(kit) {
    return [
      kit.HEADER,
      'uniform vec2 uRes;',
      'uniform vec2 uSun;', // device px, from the top left
      'uniform float uR;', // the Sun's radius, device px
      'uniform float uFrac;', // the Sun's radius as a fraction of the picture's width
      'uniform sampler2D uA;', // brightness, one channel
      'uniform sampler2D uB;',
      'uniform float uMix;',
      'uniform vec4 uField;',
      'uniform vec3 uWhite;',
      'uniform vec3 uCurve;',
      'uniform float uAlpha;',
      'out vec4 outColor;',
      'void main() {',
      '  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
      '  vec2 d = (frag - uSun) / uR;', // solar radii, y down as the picture's rows
      '  float r = length(d);',
      '  if (r < uField.x || r > uField.w) { discard; }',
      '  vec2 uv = 0.5 + d * uFrac;',
      '  float v = mix(texture(uA, uv).r, texture(uB, uv).r, uMix);',
      '  v = pow(max(0.0, v - uCurve.x) / (1.0 - uCurve.x), uCurve.y) * uCurve.z;',
      '  float m = smoothstep(uField.x, uField.y, r) * (1.0 - smoothstep(uField.z, uField.w, r));',
      // Added, as the disc is: the picture's black leaves the page's own dark.
      '  outColor = vec4(uWhite * v * m * uAlpha, 0.0);',
      '}'
    ].join('\n');
  }

  var gl = null, kit = null, prog = null, vao = null;
  var cprog = null;
  var ctex = []; // the coronagraph's, slot -> texture
  var cfull = null, cfullT = null;
  var cshown = null;
  var tex = []; // slot -> texture
  var full = null, fullT = null; // the newest frame at full size, and its time
  var shown = null; // what was drawn last: { a, b, mix, latest } from Sun.lookup

  function init(glIn, kitIn) {
    gl = glIn;
    kit = kitIn;
    prog = kit.program(sunVS(kit), sunFS(kit));
    cprog = kit.program(coronaVS(kit), coronaFS(kit));
    vao = gl.createVertexArray();
    // A context restored starts with no textures: until the next frames come in, the
    // plain disc stands in for the ones lost.
    tex = [];
    full = null;
    fullT = null;
    ctex = [];
    cfull = null;
    cfullT = null;
  }

  function texture(source) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Mipmapped: pulled back for the corona, the disc is a few dozen px across.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // A coronagraph frame's brightness ({ data, size }), one byte a pixel.
  function brightness(b) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, b.size, b.size, 0, gl.RED, gl.UNSIGNED_BYTE, b.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // The frames aurora-sun.js has drawn down since the last frame, into textures.
  function upload() {
    Sun.take().forEach(function (p) {
      if (tex[p.slot]) { gl.deleteTexture(tex[p.slot]); }
      tex[p.slot] = texture(p.source);
      if (p.full && (fullT === null || p.t >= fullT)) {
        if (full) { gl.deleteTexture(full); }
        full = texture(p.full);
        fullT = p.t;
      }
    });
    Corona.take().forEach(function (p) {
      if (ctex[p.slot]) { gl.deleteTexture(ctex[p.slot]); }
      ctex[p.slot] = brightness(p.source);
      if (p.full && (cfullT === null || p.t >= cfullT)) {
        if (cfull) { gl.deleteTexture(cfull); }
        cfull = brightness(p.full);
        cfullT = p.t;
      }
    });
  }

  // The coronagraph's picture round the Sun, as much as the camera's corona (scene.corona)
  // and only facing the Sun from the Earth, since it is flat.
  function coronaShown(scene) {
    return (scene.corona || 0) * smooth(0.96, 1.0, scene.helio.back[0]);
  }

  function drawCorona(scene, rPx, alpha) {
    var l = Corona.lookup(scene.time);
    cshown = l;
    var a = l && ctex[l.a.slot], b = l && ctex[l.b.slot];
    if (l && l.latest && cfull && cfullT === l.a.t) { a = cfull; b = cfull; }
    if (!a || !b) { return; }
    var s = scene.dpr;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(cprog);
    var u = cprog.u;
    gl.uniform2f(u.uRes, kit.canvas.width, kit.canvas.height);
    gl.uniform2f(u.uSun, scene.sunX * s, scene.sunY * s);
    gl.uniform1f(u.uR, rPx * s);
    gl.uniform1f(u.uFrac, Corona.radiusFrac(scene.earthAu));
    gl.uniform4fv(u.uField, CORONA_FIELD);
    gl.uniform3fv(u.uWhite, CORONA_WHITE);
    gl.uniform3fv(u.uCurve, CORONA_CURVE);
    gl.uniform1f(u.uAlpha, alpha);
    gl.uniform1f(u.uMix, a !== b ? l.mix : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.uniform1i(u.uA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b);
    gl.uniform1i(u.uB, 1);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function draw(scene) {
    var sunX = scene.sunX, sunY = scene.sunY;
    var rPx = SUN_RE * scene.pxPerRe;
    // Heading up from the system view: the frames will be wanted, and more of them
    // once the Sun view itself is open.
    if ((scene.sunward || 0) > 0) { Sun.want(scene.view === 'sun'); }
    var cor = coronaShown(scene);
    if ((scene.corona || 0) > 0.004) { Corona.want(scene.view === 'sun'); }
    upload();
    var alpha = smooth(SHOW_PX[0], SHOW_PX[1], rPx) * scene.dim;
    if (alpha < 0.004) { return; }
    if (cor * alpha > 0.004) { drawCorona(scene, rPx, cor * alpha); } else { cshown = null; }
    var reach = rPx * HALO;
    if (sunX + reach < 0 || sunX - reach > scene.w || sunY + reach < 0 || sunY - reach > scene.h) { return; }

    var l = Sun.lookup(scene.time);
    shown = l;
    var s = scene.dpr;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(prog);
    var u = prog.u;
    gl.uniform2f(u.uRes, kit.canvas.width, kit.canvas.height);
    gl.uniform2f(u.uSun, sunX * s, sunY * s);
    gl.uniform1f(u.uR, rPx * s);
    gl.uniform1f(u.uFrac, Sun.radiusFrac(scene.earthAu));
    gl.uniform2f(u.uMask, MASK[0], MASK[1]);
    gl.uniform3fv(u.uWaiting, WAITING);
    gl.uniform2fv(u.uUnseen, UNSEEN);
    // With the corona's own picture round it, the halo gives way.
    gl.uniform3f(u.uHalo, HALO, HALO_GAIN * (1 - cor), HALO_FALL);
    // The lens's axes in the ecliptic (scene.helio): the Sun is at its centre.
    gl.uniform3fv(u.uRight, scene.helio.right);
    gl.uniform3fv(u.uUp, scene.helio.up);
    gl.uniform3fv(u.uToward, scene.helio.back);
    gl.uniform1f(u.uAlpha, alpha);
    var a = l && tex[l.a.slot], b = l && tex[l.b.slot];
    if (l && l.latest && full && fullT === l.a.t) { a = full; b = full; }
    gl.uniform1f(u.uMode, a && b ? 0 : 1);
    gl.uniform1f(u.uMix, l && a && b && a !== b ? l.mix : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a || null);
    gl.uniform1i(u.uA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b || null);
    gl.uniform1i(u.uB, 1);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // Frames still to go up keep the loop turning until they are drawn.
  function moving() {
    return (Sun.state.wanted && Sun.loading() > 0) || (Corona.state.wanted && Corona.loading() > 0);
  }

  Globe.addLayer({ init: init, draw: draw, moving: moving });

  /*
   * In the system view the Sun and the Earth are the two ways in: a click on either
   * glides there (the Sun up to the sun view, the Earth down to L1), and the pointer
   * says so over them. The chips and the index do the same from the keyboard. A click
   * that ends a drag, or lands on a panel, is left alone.
   */
  var HIT_PX = 26;
  var stage = document.getElementById('views');

  function target(e) {
    var sc = Globe.scene;
    if (!sc || sc.view !== 'system' || (sc.sunward || 0) > 0.05) { return null; }
    if (e.target && e.target.closest && e.target.closest('a, button, input, select, textarea, .card, .top-seg')) { return null; }
    var sunX = sc.sunX, sunY = sc.sunY;
    var ds = Math.hypot(e.clientX - sunX, e.clientY - sunY), de = Math.hypot(e.clientX - sc.earthX, e.clientY - sc.earthY);
    if (Math.min(ds, de) > HIT_PX) { return null; }
    return ds <= de ? 'sun' : 'l1';
  }

  if (stage) {
    var downAt = null;
    stage.addEventListener('pointerdown', function (e) { downAt = { x: e.clientX, y: e.clientY }; });
    stage.addEventListener('click', function (e) {
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) { return; }
      var go = target(e);
      if (go && Globe.go) { e.preventDefault(); Globe.go(go); }
    });
    stage.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') { return; }
      var go = target(e);
      stage.style.cursor = go ? 'pointer' : '';
    });
  }

  // What the page's panels say about the frame on show (aurora-hud.js).
  window.AuroraSunView = {
    shown: function () { return shown; },
    coronaShown: function () { return cshown; }
  };
})();
