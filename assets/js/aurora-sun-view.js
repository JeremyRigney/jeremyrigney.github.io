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
 * The picture is face-on, solar north up, as GOES sees it from the Earth: the camera is
 * not turned to look along the Sun-Earth line, and the page says so. It is masked
 * round, out to MASK solar radii, which also leaves out NOAA's caption.
 */
(function () {
  'use strict';

  var Globe = window.AuroraGlobe;
  var Sun = window.AuroraSun;
  var Geo = window.AuroraGeo;
  if (!Globe || !Sun || !Geo) { return; }

  var SUN_RE = 109.08; // the Sun's radius in Earth radii
  var MASK = [1.38, 1.52]; // solar radii: the picture fades out between these
  var SHOW_PX = [2, 9]; // and in as the Sun's radius on screen grows between these
  var WAITING = [0.30, 0.27, 0.24]; // a plain disc, until the first frame is in

  function smooth(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
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
      'uniform vec2 uMask;',
      'uniform float uAlpha;',
      'out vec4 outColor;',
      'void main() {',
      '  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
      '  vec2 d = (frag - uSun) / uR;', // solar radii, y down as the picture's rows
      '  float r = length(d);',
      '  if (r > uMask.y) { discard; }',
      '  vec3 c;',
      '  float a = (1.0 - smoothstep(uMask.x, uMask.y, r)) * uAlpha;',
      '  if (uMode > 0.5) {',
      '    float w = fwidth(r);',
      '    c = uWaiting;',
      '    a = (1.0 - smoothstep(1.0 - w, 1.0 + w, r)) * uAlpha;',
      '  } else {',
      '    vec2 uv = 0.5 + d * uFrac;',
      '    c = mix(texture(uA, uv).rgb, texture(uB, uv).rgb, uMix);',
      '  }',
      // Added to what is under it: the picture's black sky leaves the page's own
      // dark showing, rather than a darker ring round the corona. The plain disc,
      // which has no sky, covers.
      '  outColor = uMode > 0.5 ? vec4(c * a, a) : vec4(c * a, 0.0);',
      '}'
    ].join('\n');
  }

  var gl = null, kit = null, prog = null, vao = null;
  var tex = []; // slot -> texture
  var full = null, fullT = null; // the newest frame at full size, and its time
  var shown = null; // what was drawn last: { a, b, mix, latest } from Sun.lookup

  function init(glIn, kitIn) {
    gl = glIn;
    kit = kitIn;
    prog = kit.program(kit.FULLSCREEN_VS, sunFS(kit));
    vao = gl.createVertexArray();
    // A context restored starts with no textures: until the next frames come in, the
    // plain disc stands in for the ones lost.
    tex = [];
    full = null;
    fullT = null;
  }

  function texture(source) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
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
  }

  function draw(scene) {
    var sunX = scene.earthX - scene.earthAu * scene.pxPerAu, sunY = scene.earthY;
    var rPx = SUN_RE * scene.pxPerRe;
    // Heading up from the system view: the frames will be wanted, and more of them
    // once the Sun view itself is open.
    if ((scene.sunward || 0) > 0) { Sun.want(scene.view === 'sun'); }
    upload();
    var alpha = smooth(SHOW_PX[0], SHOW_PX[1], rPx) * scene.dim;
    if (alpha < 0.004) { return; }
    var reach = rPx * MASK[1];
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
    return Sun.state.wanted && Sun.loading() > 0;
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
    var sunX = sc.earthX - sc.earthAu * sc.pxPerAu, sunY = sc.earthY;
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
    shown: function () { return shown; }
  };
})();
