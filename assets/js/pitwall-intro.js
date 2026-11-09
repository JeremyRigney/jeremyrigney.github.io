/*
 * Pitwall: the opening seconds. A port of Pocket Pitwall's ui/Intro.kt.
 *
 * "Pitwall", and under it the five compounds pop in one by one, spin up, and roll off to
 * the right — turning exactly as fast as they travel, as a tyre on the road does — and the
 * wall, which has been loading underneath all along, shows through. 2.38 seconds.
 *
 * It plays once per visit (per tab, as the app plays on a cold start only), and not at all
 * for a link straight to a replay (by session or by race) or a demo frame, for a tab opened in the background, or
 * with reduced motion. A click, a tap or any key skips it. ?intro plays it regardless.
 * Under the sign-in screen, when that is up, it plays unseen.
 *
 * Loaded straight after its element at the top of the page, before anything else, so the
 * wall never shows first.
 */
(function () {
  'use strict';

  // The timeline, in milliseconds.
  var POP_EVERY = 90;     // between one tyre appearing and the next
  var POP_FOR = 420;      // each tyre's pop
  var SPIN_FROM = 450;    // all five start to turn
  var ROLL_FROM = 1500;   // the rightmost sets off; each one left of it a beat later
  var ROLL_EVERY = 70;
  var TOTAL = 2380;       // the fade starts as the last tyre leaves
  var FADE_FOR = 280;     // the last of it: the wall shows through

  /** Each tyre starts a little further round than the one before, so they don't look stamped out. */
  var STAGGER = 33;

  /** Spin-up: the angle grows with the square of the time, a steady angular acceleration (rad/ms²). */
  var SPIN = 3 * Math.PI / 1000000;

  /** How hard they pull away, in px/ms², once rolling. */
  var PULL = 0.0012;

  var KEY = 'pitwall.intro';

  var el = document.querySelector('.intro');
  if (!el) { return; }

  var params = new URLSearchParams(window.location.search);
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function seen() {
    try {
      return window.sessionStorage.getItem(KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  var wanted = params.has('intro') || (!calm && !params.has('session') && !params.has('race') && !params.has('demo') &&
    document.visibilityState === 'visible' && !seen());
  if (!wanted) {
    el.remove();
    return;
  }

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** The five compounds left to right, in the colours the tower draws them in. */
  var compounds = [token('--tyre-soft'), token('--tyre-medium'), token('--tyre-hard'), token('--tyre-inter'), token('--tyre-wet')];
  var ink = {
    rubber: token('--rubber'),
    sheen: token('--rubber-sheen'),
    edge: token('--rubber-edge'),
    treadLit: token('--tread-lit'),
    treadShade: token('--tread-shade'),
    cover: token('--wheel-cover'),
    coverLine: token('--wheel-line'),
    bolt: token('--wheel-bolt'),
    lipLit: token('--rim-lit'),
    lipShade: token('--rim-shade'),
    hub: token('--hub'),
    nut: token('--hub-nut')
  };

  var word = el.querySelector('.intro-word');
  var canvas = el.querySelector('canvas');
  var ctx = canvas.getContext('2d');
  var started = null;
  var finished = false;

  /** Ease out: quick, then settling. */
  function ease(x) {
    return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  }

  /** Ease out with a little overshoot, for the pop. */
  function overshoot(x) {
    var c1 = 1.70158;
    var c3 = c1 + 1;
    var u = Math.min(1, Math.max(0, x)) - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  }

  /**
   * Tyre i's sideways travel (px) and turn (radians) at t: spinning up in place, then
   * rolling away from where it stands at the spin-up's speed and gaining, the turn always
   * matching the distance covered.
   */
  function roll(t, i, r) {
    var sets = ROLL_FROM + (compounds.length - 1 - i) * ROLL_EVERY;
    var spun = Math.max(0, Math.min(t, sets) - SPIN_FROM);
    var turned = SPIN * spun * spun;
    if (t <= sets) { return [0, turned]; }
    var dt = t - sets;
    var speed = 2 * SPIN * spun * r;
    var travel = speed * dt + 0.5 * PULL * dt * dt;
    return [travel, turned + travel / r];
  }

  function circle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  function vertical(y0, y1, from, to) {
    var g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    return g;
  }

  /**
   * One tyre side on, turned (radians): the sidewall, the tread's edge lit from above, the
   * compound band, the covered wheel inside the rim, the hub. The band is broken twice, where
   * a sidewall's lettering sits, and the wheel cover has five bolts: those are what show it
   * turning. The light stays put while the tyre turns.
   */
  function tyre(x, y, r, band, turn) {
    var rubber = ctx.createRadialGradient(x, y, 0, x, y, r);
    rubber.addColorStop(0, ink.rubber);
    rubber.addColorStop(0.58, ink.rubber);
    rubber.addColorStop(0.8, ink.sheen);
    rubber.addColorStop(1, ink.edge);
    circle(x, y, r);
    ctx.fillStyle = rubber;
    ctx.fill();

    circle(x, y, r * 0.98);
    ctx.lineWidth = r * 0.042;
    ctx.strokeStyle = vertical(y - r, y + r, ink.treadLit, ink.treadShade);
    ctx.stroke();

    ctx.strokeStyle = band;
    ctx.lineWidth = r * 0.108;
    [14, 194].forEach(function (from) {
      var a = from * Math.PI / 180 + turn;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.8, a, a + 152 * Math.PI / 180);
      ctx.stroke();
    });

    circle(x, y, r * 0.594);
    ctx.fillStyle = ink.cover;
    ctx.fill();
    circle(x, y, r * 0.381);
    ctx.lineWidth = r * 0.03;
    ctx.strokeStyle = ink.coverLine;
    ctx.stroke();

    ctx.fillStyle = ink.bolt;
    for (var k = 0; k < 5; k++) {
      var b = (k * 72 - 90) * Math.PI / 180 + turn;
      circle(x + Math.cos(b) * r * 0.25, y + Math.sin(b) * r * 0.25, r * 0.05);
      ctx.fill();
    }

    circle(x, y, r * 0.622);
    ctx.lineWidth = r * 0.057;
    ctx.strokeStyle = vertical(y - r * 0.62, y + r * 0.62, ink.lipLit, ink.lipShade);
    ctx.stroke();

    circle(x, y, r * 0.14);
    ctx.fillStyle = ink.hub;
    ctx.fill();
    circle(x, y, r * 0.063);
    ctx.fillStyle = ink.nut;
    ctx.fill();
  }

  function frame(now) {
    if (finished) { return; }
    if (started == null) { started = now; }
    var t = now - started;
    if (t >= TOTAL) {
      done();
      return;
    }
    el.style.opacity = String(Math.min(1, Math.max(0, (TOTAL - t) / FADE_FOR)));

    var shown = ease((t - 150) / 450) * (1 - ease((t - 1650) / 400));
    word.style.opacity = String(shown);
    word.style.transform = 'translateY(' + ((1 - ease((t - 150) / 450)) * 18).toFixed(2) + 'px)';

    var width = el.clientWidth;
    var gap = 8;
    var d = Math.min(72, (width - 24 - gap * 4) / 5);
    var r = d / 2;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(d * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(d * dpr);
      canvas.style.height = d + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, d);
    var left = (width - (5 * d + 4 * gap)) / 2 + r;
    compounds.forEach(function (band, i) {
      var pop = Math.min(1, Math.max(0, (t - i * POP_EVERY) / POP_FOR));
      if (pop <= 0) { return; }
      var moved = roll(t, i, r);
      var x = left + i * (d + gap);
      var s = overshoot(pop);
      ctx.save();
      ctx.translate(x + moved[0], r);
      ctx.scale(s, s);
      tyre(0, 0, r, band, (i * STAGGER) * Math.PI / 180 + moved[1]);
      ctx.restore();
    });
    window.requestAnimationFrame(frame);
  }

  function done() {
    if (finished) { return; }
    finished = true;
    el.remove();
    window.removeEventListener('keydown', done, true);
  }

  function play() {
    try {
      window.sessionStorage.setItem(KEY, '1');
    } catch (e) {
      // Not remembered: it plays again on the next load, which is all.
    }
    el.hidden = false;
    el.addEventListener('pointerdown', done);
    window.addEventListener('keydown', done, true);
    window.requestAnimationFrame(frame);
  }

  play();
}());
