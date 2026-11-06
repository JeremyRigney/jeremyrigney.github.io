/*
 * Pitwall: the Wall — one lap of time as a ring, and what a stop would do. A port of Pocket
 * Pitwall's ui/Ring.kt.
 *
 * Every car is a dot at its time behind the leader, with its race position in it. Pick a car
 * and its ghost appears where it would rejoin if it boxed now; the cards beside the ring say
 * where that is (P3 → P5), the one thing that matters most about it (traffic, an undercut,
 * a free stop), what a stop costs under each flag, and who could stop for free.
 *
 * The ring is a dial: anywhere on it picks the car nearest that direction from its middle,
 * so there's no dot to hit. A click picks (or, on the car already picked, lets go); a drag
 * round the ring moves the pick from car to car, and a magnifier names the pack under the
 * pointer. ‹ and › step to the car ahead or behind.
 *
 * Between frames the ring keeps turning at the race's pace (live 1×, the replay's speed
 * while it plays, still when paused), drawn at most 30 times a second, and not at all while
 * the Wall is out of sight.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var F = P.Format;
  var UI = P.UI;
  var Doom = P.Doom;
  var RingPick = P.RingPick;

  /** How much of the lap either side of the pointer the magnifier lists. */
  var LOUPE_WINDOW = 0.04;
  var ASSIGN_MS = 1000;
  var TAG_MS = 300;
  var KEEP = 0.85;
  var RETURN = 1.25;
  var SMOOTH_MS = 240;
  var EXTRAPOLATE_MS = 1600;
  var PAINT_MS = 33;

  var root = document.getElementById('ring');
  var canvas = root.querySelector('canvas');
  var ctx = canvas.getContext('2d');
  var pitNow = document.getElementById('pit-now');
  var lossCard = document.getElementById('pit-loss');
  var freeCard = document.getElementById('free-stops');
  var ghostsBtn = document.getElementById('all-ghosts');
  var stintsBtn = document.getElementById('stints-open');
  var stintsCard = document.getElementById('stints');
  var stepBack = document.getElementById('ring-ahead');
  var stepOn = document.getElementById('ring-behind');

  var handlers = {};
  var s = {
    doom: null,
    frame: null,
    picked: null,
    followed: new Set(),
    rate: 0,
    arrived: 0,
    shown: {},
    tags: {},
    lastStep: 0,
    lastAssign: 0,
    lastEase: 0,
    assignDue: true,
    allGhosts: false,
    visible: false,
    raf: 0,
    lastPaint: 0,
    finger: null,
    g: null,
    w: 0,
    h: 0,
    dpr: 1,
    openedFor: null
  };

  var colours = {};
  function colour(name) {
    if (!colours[name]) { colours[name] = UI.token(name); }
    return colours[name];
  }

  function rgb(hex) {
    return [1, 3, 5].map(function (i) { return parseInt(hex.substr(i, 2), 16); });
  }

  function luminance(hex) {
    var c = rgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function team(d) {
    return F.teamColour(d.colour) || colour('--ink-soft');
  }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // ---------- Geometry ----------

  function size() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (w === s.w && h === s.h && dpr === s.dpr && s.g) { return; }
    s.w = w;
    s.h = h;
    s.dpr = dpr;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    s.g = null;
  }

  function layout() {
    if (s.g || !s.doom) { return s.g; }
    var w = s.w;
    var h = s.h;
    var font = 15;
    ctx.font = '700 15px Figtree, sans-serif';
    var widest = Math.max.apply(null, s.doom.drivers.map(function (d) { return ctx.measureText(F.driverLabel(d)).width; }).concat([font * 1.7]));
    var labelW = widest + font * 0.3;
    var labelH = font * 1.15;
    // Labels have to be legible from across a desk; the ring is whatever is left once there
    // is room for a row of them outside it.
    var sideRoom = 10 + labelW + 7;
    var topRoom = 10 + labelH + 7;
    var r = Math.min(w / 2 - sideRoom, h / 2 - topRoom) / 1.04;
    // The cards sit in the stage's corners, which a ring leaves free: as large a ring as keeps
    // its ticks and names clear of every one of them.
    var box = canvas.getBoundingClientRect();
    var reach = 11 + 14 + labelH + 8;
    Array.prototype.forEach.call(root.querySelectorAll('.ring-side .ring-card'), function (card) {
      if (card.hidden || !card.offsetWidth) { return; }
      var c = card.getBoundingClientRect();
      var nx = Math.min(Math.max(w / 2, c.left - box.left), c.right - box.left);
      var ny = Math.min(Math.max(h / 2, c.top - box.top), c.bottom - box.top);
      r = Math.min(r, Math.hypot(nx - w / 2, ny - h / 2) - reach);
    });
    r = Math.max(60, r);
    var lane = Math.min(22, Math.max(9, r * 0.075));
    // Dots big enough to carry a race position, as on the map.
    var dot = Math.min(13, Math.max(11, lane * 0.9));
    s.g = {
      cx: w / 2,
      cy: h / 2,
      r: r,
      lane: lane,
      outer: r + lane / 2,
      // The ghost lane, the pit lane and the middle stepped in far enough that a picked car's
      // dot and its ghost's never touch.
      ghostR: r - Math.max(lane * 1.4, dot * 2.4),
      pitR: r - Math.max(lane * 2.7, dot * 4.6),
      innerR: r - Math.max(lane * 3.7, dot * 6),
      font: font,
      dot: dot,
      labelW: labelW,
      labelH: labelH
    };
    return s.g;
  }

  function at(g, f, radius) {
    var theta = -Math.PI / 2 + f * Math.PI * 2;
    return [g.cx + radius * Math.cos(theta), g.cy + radius * Math.sin(theta)];
  }

  // ---------- Motion ----------

  function clockNow(now) {
    var elapsed = Math.min(now - s.arrived, EXTRAPOLATE_MS);
    return s.doom.generatedMs + Math.max(0, elapsed) * s.rate;
  }

  /** Ease every car toward where it belongs; says whether anything is still moving. */
  function advance(now) {
    var want = s.doom.targets(clockNow(now));
    var dt = s.lastStep ? Math.min(now - s.lastStep, 500) : 0;
    s.lastStep = now;
    var ease = UI.calm || !dt ? 1 : 1 - Math.exp(-dt / SMOOTH_MS);
    var moving = s.rate > 0;
    Object.keys(s.shown).forEach(function (k) { if (!(k in want)) { delete s.shown[k]; } });
    Object.keys(want).forEach(function (k) {
      var target = want[k];
      var current = s.shown[k];
      if (current == null) {
        s.shown[k] = target;
        return;
      }
      var d = Doom.step(current, target);
      // A big jump is a scrub or a new session, not a car moving: snap.
      if (Math.abs(d) > 0.25) {
        s.shown[k] = target;
        return;
      }
      s.shown[k] = Doom.wrap(current + d * ease);
      if (Math.abs(d) > 1e-4) { moving = true; }
    });
    return moving;
  }

  function rank(d) {
    if (d.num === s.picked) { return -2; }
    if (s.doom.leader && d.num === s.doom.leader.num) { return -1; }
    return d.pos == null ? 99 : d.pos;
  }

  /*
   * Which cars' labels show, decided at most once a second. A label is fixed straight out
   * from its car; it keeps its place while it still fits with some give, and a dropped one
   * comes back only once there is clearly room. Names only where they matter: the picked car
   * and the two it would rejoin between, the leader, and the drivers you follow.
   */
  function assignRows(g, now) {
    if (!s.assignDue && now - s.lastAssign < ASSIGN_MS) { return; }
    s.lastAssign = now;
    s.assignDue = false;
    var doom = s.doom;
    var span = (g.labelW + 4) / (2 * Math.PI * (g.outer + 18));
    var rejoin = s.picked != null ? doom.project(s.picked) : null;
    var matter = {};
    if (s.picked != null) { matter[s.picked] = true; }
    if (doom.leader) { matter[doom.leader.num] = true; }
    s.followed.forEach(function (n) { matter[n] = true; });
    if (rejoin && rejoin.ahead) { matter[rejoin.ahead.num] = true; }
    if (rejoin && rejoin.behind) { matter[rejoin.behind.num] = true; }
    var all = doom.drivers.filter(function (d) { return d.num in s.shown; });
    var cars = all.filter(function (d) { return matter[d.num]; }).sort(function (a, b) { return rank(a) - rank(b); });
    var row = [];
    var next = {};
    function fits(f, need) {
      return row.every(function (o) { return Math.abs(Doom.step(o, f)) >= need; });
    }
    function put(d) {
      row.push(s.shown[d.num]);
      next[d.num] = true;
    }
    cars.forEach(function (d) {
      if (d.num === s.picked && !d.inPit) { put(d); }
    });
    // The leader and the drivers you follow before the pick's neighbours, which change with
    // every pick: they're named whenever there's room for them at all.
    cars.forEach(function (d) {
      if (next[d.num] || d.inPit || (!s.followed.has(d.num) && !(doom.leader && d.num === doom.leader.num))) { return; }
      if (fits(s.shown[d.num], span * KEEP)) { put(d); }
    });
    cars.forEach(function (d) {
      var t = s.tags[d.num];
      if (!next[d.num] && !d.inPit && t && t.on && fits(s.shown[d.num], span * KEEP)) { put(d); }
    });
    cars.forEach(function (d) {
      if (next[d.num] || d.inPit) { return; }
      var t = s.tags[d.num];
      if (fits(s.shown[d.num], t && !t.on ? span * RETURN : span)) { put(d); }
    });
    var present = {};
    all.forEach(function (d) {
      present[d.num] = true;
      var t = s.tags[d.num] || (s.tags[d.num] = { on: false, alpha: 0 });
      t.on = !!next[d.num];
    });
    Object.keys(s.tags).forEach(function (k) { if (!present[k]) { delete s.tags[k]; } });
  }

  function easeTags(dt) {
    var k = UI.calm || !dt ? 1 : 1 - Math.exp(-dt * 3 / TAG_MS);
    var still = true;
    Object.keys(s.tags).forEach(function (n) {
      var t = s.tags[n];
      var want = t.on ? 1 : 0;
      t.alpha += (want - t.alpha) * k;
      if (Math.abs(want - t.alpha) <= 0.01) { t.alpha = want; } else { still = false; }
    });
    return still;
  }

  // ---------- Drawing ----------

  function notice(text) {
    ctx.fillStyle = colour('--ink-soft');
    ctx.font = '600 15px Figtree, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, s.w / 2, s.h / 2);
  }

  function circle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  function line(a, b) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }

  function draw(now) {
    size();
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.clearRect(0, 0, s.w, s.h);
    var doom = s.doom;
    if (!doom) {
      notice('The ring shows here once a session is on.');
      return;
    }
    if (!doom.hasLapStart) {
      // An older server never sends lapStart; a current one hasn't yet at lights out.
      notice(doom.frame.radio == null ? 'The Wall needs the updated timing server' : 'Waiting for the first lap');
      return;
    }
    var lap = doom.ringLap;
    if (lap == null) {
      notice('Waiting for lap times');
      return;
    }
    var g = layout();
    var ink = colour('--ink');
    var flag = doom.frame.flag ? doom.frame.flag.state : 'GREEN';

    // The track, tinted with the flag while the race is neutralised, so a safety car reads
    // from across the room before any number on it does.
    ctx.lineWidth = g.lane;
    if (F.neutralised(flag)) {
      ctx.strokeStyle = flag === 'RED' ? colour('--flag-red') : colour('--flag-yellow');
      ctx.globalAlpha = 0.32;
    } else {
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.1;
    }
    circle(g.cx, g.cy, g.r);
    ctx.stroke();
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    circle(g.cx, g.cy, g.ghostR);
    ctx.stroke();
    ctx.setLineDash([]);
    circle(g.cx, g.cy, g.pitR);
    ctx.stroke();

    // A tick every five seconds, longer every fifteen, so a gap can be read off by eye.
    for (var sec = 5; sec < lap - 1; sec += 5) {
      var major = sec % 15 === 0;
      ctx.globalAlpha = major ? 0.28 : 0.14;
      ctx.lineWidth = major ? 2 : 1;
      line(at(g, sec / lap, g.outer + 3), at(g, sec / lap, g.outer + (major ? 11 : 6)));
    }
    ctx.globalAlpha = 1;

    // Sector lines, placed by the session-best sector split, and the line itself.
    var sectors = doom.frame.best ? doom.frame.best.sectors : [];
    var s1 = sectors[0];
    var s2 = sectors[1];
    var sum = (s1 || 0) + (s2 || 0) + (sectors[2] || 0);
    var marks = [[0, 'S/F', ink]];
    if (sum > 0 && s1 != null && s2 != null) {
      marks.push([s1 / sum, 'S2', colour('--ink-soft')]);
      marks.push([(s1 + s2) / sum, 'S3', colour('--ink-soft')]);
    }
    ctx.font = '700 13px Figtree, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    marks.forEach(function (m) {
      ctx.strokeStyle = m[2];
      ctx.lineWidth = m[1] === 'S/F' ? 4 : 2.5;
      line(at(g, m[0], g.r - g.lane / 2 - 2), at(g, m[0], g.r + g.lane / 2 + 2));
      // The line itself is the bold mark at twelve o'clock; its name would sit where the pit
      // lane's cars are labelled, which is most often right by the line.
      if (m[1] === 'S/F') { return; }
      var p = at(g, m[0], g.pitR - 13 * 1.3);
      ctx.fillStyle = colour('--ink-soft');
      ctx.fillText(m[1], p[0], p[1]);
    });

    var placed = doom.drivers.filter(function (d) { return d.num in s.shown; });
    if (!placed.length) {
      notice(flag === 'RED' ? 'Session suspended' : 'No cars on track');
      return;
    }

    // Ghosts first, under the cars: an arc along the ghost lane from the rejoin point up to
    // the car, and a hollow marker where it rejoins.
    var loss = doom.loss;
    if (loss != null) {
      placed.forEach(function (d) {
        if (d.inPit || doom.behind[d.num] == null) { return; }
        var pick = d.num === s.picked;
        if (!s.allGhosts && !pick) { return; }
        var c = team(d);
        var f = s.shown[d.num];
        var ghost = Doom.wrap(f - loss / lap);
        var start = -Math.PI / 2 + ghost * Math.PI * 2;
        var sweep = Doom.wrap(f - ghost) * Math.PI * 2;
        ctx.strokeStyle = c;
        ctx.globalAlpha = pick ? 0.8 : 0.35;
        ctx.lineWidth = pick ? 4 : 2.5;
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.ghostR, start, start + sweep);
        ctx.stroke();
        ctx.globalAlpha = 1;
        var gp = at(g, ghost, g.ghostR);
        var gr = g.dot * (pick ? 0.95 : 0.7);
        ctx.fillStyle = colour('--ground');
        circle(gp[0], gp[1], gr);
        ctx.fill();
        ctx.lineWidth = pick ? 3 : 2;
        ctx.setLineDash(pick ? [] : [3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (pick) {
          var p = doom.project(d.num);
          if (p) {
            var lp = at(g, ghost, g.ghostR - g.dot - g.font * 0.9);
            ctx.font = '700 15px Figtree, sans-serif';
            ctx.fillStyle = ink;
            ctx.fillText('P' + p.position, lp[0], lp[1]);
          }
        }
      });
    }

    assignRows(g, now);
    var tagsStill = easeTags(s.lastEase ? Math.min(now - s.lastEase, 500) : 0);
    s.lastEase = now;

    var onTrack = [];
    var pitLabels = [];
    // From the back of the field forward, so the leader is on top where dots overlap, and the
    // picked car on top of all.
    placed.slice().sort(function (a, b) {
      return (a.num === s.picked ? 1 : 0) - (b.num === s.picked ? 1 : 0) || (b.pos || 99) - (a.pos || 99);
    }).forEach(function (d) {
      var f = s.shown[d.num];
      var pick = d.num === s.picked;
      var p = at(g, f, d.inPit ? g.pitR : g.r);
      var c = team(d);
      var radius = pick ? g.dot * 1.35 : g.dot;
      ctx.fillStyle = c;
      circle(p[0], p[1], radius);
      ctx.fill();
      ctx.strokeStyle = pick ? ink : colour('--ground');
      ctx.lineWidth = pick ? 3 : 1.5;
      ctx.stroke();
      if (d.pos != null) {
        // The race position in the dot, as on the map: dark figures on the light team colours.
        ctx.fillStyle = luminance(c) > 0.45 ? colour('--ground') : ink;
        ctx.font = '700 ' + (pick ? 15 : 13) + 'px Figtree, sans-serif';
        ctx.fillText(String(d.pos), p[0], p[1] + 0.5);
      }
      if (d.inPit) {
        // Inside the ring, under the car. Two cars stopping together would print one name over
        // the other, so a label that would land on one already drawn steps further in.
        ctx.font = '700 13px Figtree, sans-serif';
        var label = F.driverLabel(d);
        var lw = ctx.measureText(label).width;
        var lh = 15;
        var rad = g.pitR - g.dot - g.font * 0.75;
        var box;
        for (var tries = 0; tries < 4; tries++) {
          var ip = at(g, f, rad);
          box = [ip[0] - lw / 2, ip[1] - lh / 2, ip[0] + lw / 2, ip[1] + lh / 2];
          var hit = pitLabels.some(function (o) { return box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1]; });
          if (!hit) { break; }
          rad -= lh + 2;
        }
        pitLabels.push(box);
        ctx.fillStyle = colour('--ink-soft');
        ctx.fillText(label, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
      } else {
        onTrack.push([d, f]);
      }
    });

    var labelR = g.outer + 14;
    function tagAt(f) {
      var theta = f * Math.PI * 2;
      var extent = Math.abs(Math.sin(theta)) * g.labelW / 2 + Math.abs(Math.cos(theta)) * g.labelH / 2;
      var rc = labelR + extent;
      return [at(g, f, rc), rc - extent];
    }
    var shownTags = onTrack.filter(function (e) {
      var t = s.tags[e[0].num];
      return t && t.alpha > 0.02;
    });
    // Ticks first, so a tick passes under a nearer label, not across it.
    shownTags.forEach(function (e) {
      var d = e[0];
      var t = s.tags[d.num];
      var pick = d.num === s.picked;
      ctx.strokeStyle = pick ? ink : team(d);
      ctx.lineWidth = pick ? 2 : 1;
      ctx.globalAlpha = t.alpha * (pick ? 1 : 0.6);
      line(at(g, e[1], g.outer + 3), at(g, e[1], tagAt(e[1])[1] - 2));
    });
    ctx.font = '700 15px Figtree, sans-serif';
    shownTags.forEach(function (e) {
      var d = e[0];
      var t = s.tags[d.num];
      var c = tagAt(e[1])[0];
      ctx.globalAlpha = t.alpha * 0.85;
      ctx.fillStyle = colour('--ground');
      ctx.fillRect(c[0] - g.labelW / 2 - 2, c[1] - g.labelH / 2 - 1, g.labelW + 4, g.labelH + 2);
      ctx.globalAlpha = t.alpha;
      ctx.fillStyle = ink;
      ctx.fillText(F.driverLabel(d), c[0], c[1] + 0.5);
      if (d.num === s.picked) {
        ctx.fillStyle = team(d);
        ctx.fillRect(c[0] - g.labelW / 2, c[1] + g.labelH / 2, g.labelW, 3);
      }
    });
    ctx.globalAlpha = 1;
    if (s.finger) { drawLoupe(g); }
    return tagsStill;
  }

  /*
   * The magnifier while a drag goes round the ring: the cars either side of where it points,
   * named in order down a panel set in from the pointer towards the middle. The pick is
   * underlined. For a DRS train, where dots sit on top of each other.
   */
  function drawLoupe(g) {
    var dx = s.finger[0] - g.cx;
    var dy = s.finger[1] - g.cy;
    var f = RingPick.fraction(dx, dy);
    var cars = RingPick.near(s.shown, f, LOUPE_WINDOW).map(function (n) { return s.doom.byNum[n]; }).filter(Boolean).slice(0, 6);
    if (!cars.length) { return; }
    var row = g.labelH + 6;
    var pad = 10;
    var w = g.labelW + pad * 2;
    var h = row * cars.length + pad * 2 - 6;
    var distance = Math.max(Math.hypot(dx, dy), 1);
    var cx = s.finger[0] - dx / distance * (w / 2 + 44);
    var cy = s.finger[1] - dy / distance * (w / 2 + 44);
    var left = Math.min(s.w - w, Math.max(0, cx - w / 2));
    var top = Math.min(s.h - h, Math.max(0, cy - h / 2));
    ctx.fillStyle = colour('--card-solid');
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(left, top, w, h, 12); } else { ctx.rect(left, top, w, h); }
    ctx.fill();
    ctx.strokeStyle = colour('--ink');
    ctx.globalAlpha = 0.26;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '700 15px Figtree, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    cars.forEach(function (d, i) {
      var y = top + pad + i * row;
      ctx.fillStyle = team(d);
      ctx.fillText(F.driverLabel(d), left + w / 2, y);
      if (d.num === s.picked) { ctx.fillRect(left + pad, y + g.labelH, w - pad * 2, 2.5); }
    });
    ctx.textBaseline = 'middle';
  }

  // ---------- The loop ----------

  function frameLoop(ts) {
    s.raf = 0;
    if (!s.visible || !s.doom || document.visibilityState !== 'visible') { return; }
    if (ts - s.lastPaint < (UI.calm ? 1000 : PAINT_MS)) {
      s.raf = requestAnimationFrame(frameLoop);
      return;
    }
    s.lastPaint = ts;
    var now = performance.now();
    var moving = advance(now);
    var tagsStill = draw(now);
    if (moving || s.assignDue || !tagsStill || s.finger) { s.raf = requestAnimationFrame(frameLoop); }
  }

  function wake() {
    if (!s.raf && s.visible) { s.raf = requestAnimationFrame(frameLoop); }
  }

  // ---------- The cards ----------

  function lapClock(seconds) {
    var minutes = Math.floor(seconds / 60);
    var rest = seconds - minutes * 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  /** What a stop now does for the picked car: where it rejoins, and the one thing that matters most. */
  function drawPitNow() {
    var doom = s.doom;
    var car = doom && s.picked != null ? doom.byNum[s.picked] : null;
    var title = car ? 'If ' + esc(F.driverLabel(car)) + ' pits now' : 'Pit now';
    var body;
    var hint = null;
    if (!doom) {
      hint = 'Nothing on track';
    } else if (!doom.strategy) {
      hint = F.isRace(doom.frame.session) ? 'Ghosts appear once the race is running' : 'Ghosts are for races — no gaps in practice or qualifying';
    } else if (!car) {
      hint = 'Click a car on the ring or in the tower, or drag round the ring';
    }
    if (hint) {
      body = '<p class="ring-hint">' + esc(hint) + '</p>';
    } else {
      var p = doom.project(car.num);
      if (!p) {
        body = '<p class="ring-hint">No gap to project from yet</p>';
      } else {
        // Where it rejoins is the answer, so that's the big figure; where it is now goes small
        // in front. One verdict, the most important: fit by dropping, never by shrinking.
        var verdict = null;
        if (p.traffic) { verdict = ['caution', 'Traffic: ' + F.driverLabel(p.traffic.car)]; } else if (p.threat) { verdict = ['caution', 'Undercut threat: ' + F.driverLabel(p.threat.car)]; } else if (p.free) { verdict = ['good', 'Free stop']; } else if (p.chance) { verdict = ['good', 'Undercut on ' + F.driverLabel(p.chance.car)]; } else if (p.from != null && p.position > p.from) { verdict = ['quiet', 'Loses ' + (p.position - p.from)]; }
        body = '<p class="pit-move"><span>P' + (p.from == null ? F.DASH : p.from) + ' →</span> <b style="--team:' + team(car) + '">P' + p.position + '</b></p>' +
          (verdict ? '<p class="verdict" data-tone="' + verdict[0] + '">' + esc(verdict[1]) + '</p>' : '') +
          '<p class="ring-hint">' + (p.ahead ? 'Behind ' + esc(F.driverLabel(p.ahead)) + ' by ' + p.aheadGap.toFixed(1) + 's' : 'In the lead') +
          (p.behind ? ' · ahead of ' + esc(F.driverLabel(p.behind)) + ' by ' + p.behindGap.toFixed(1) + 's' : '') + '</p>';
      }
    }
    set(pitNow, '<p class="cap-label">' + title + '</p>' + body);
  }

  /** What a stop costs under each state of the race, the one that applies now inverted. */
  function drawLoss() {
    var doom = s.doom;
    var loss = doom && doom.strategy && doom.strategy.pitLoss;
    lossCard.hidden = !loss;
    if (!loss) { return; }
    var flag = doom.frame.flag ? doom.frame.flag.state : 'GREEN';
    var active = flag === 'VSC' ? 'vsc' : flag === 'SAFETY_CAR' ? 'sc' : 'green';
    var tiles = [['green', 'Green', loss.green], ['vsc', 'VSC', loss.vsc], ['sc', 'SC', loss.sc]].map(function (t) {
      return '<div class="loss-tile"' + (t[0] === active ? ' aria-current="true"' : '') + '><span>' + t[1] + '</span><b>' + (t[2] == null ? F.DASH : t[2].toFixed(1)) + '</b></div>';
    }).join('');
    // Under a neutralisation the line under them is the saving: why anyone looks at this then.
    var now = active === 'vsc' ? loss.vsc : active === 'sc' ? loss.sc : null;
    var note;
    if (loss.green != null && now != null) {
      note = '<p class="verdict" data-tone="good">Saves ' + (loss.green - now).toFixed(1) + 's now</p>';
    } else if (loss.basis === 'calibrated') {
      note = '<p class="ring-hint">From ' + loss.samplesGreen + ' stop' + (loss.samplesGreen === 1 ? '' : 's') + ' so far</p>';
    } else {
      note = '<p class="ring-hint">Circuit estimate</p>';
    }
    set(lossCard, '<p class="cap-label">Pit loss, seconds</p><div class="loss-tiles">' + tiles + '</div>' + note);
  }

  /** Who could box this lap without losing a place to the car behind. */
  function drawFree() {
    var doom = s.doom;
    freeCard.hidden = !(doom && doom.loss != null);
    if (freeCard.hidden) { return; }
    var free = doom.drivers.length > 1 ? doom.freeStops() : {};
    var list = doom.drivers.filter(function (d) { return free[d.num] && !d.inPit; });
    var chips = list.length ? list.map(function (d) {
      return '<button type="button" class="chip chip-driver" data-num="' + d.num + '" style="--team:' + team(d) + '"' +
        (d.num === s.picked ? ' aria-pressed="true"' : '') + '>' + esc(F.driverLabel(d)) + '</button>';
    }).join('') : '<p class="ring-hint">None this lap</p>';
    set(freeCard, '<p class="cap-label">Free stop now</p><div class="chips">' + chips + '</div>');
  }

  function drawControls() {
    var doom = s.doom;
    ghostsBtn.disabled = !(doom && doom.loss != null);
    ghostsBtn.setAttribute('aria-pressed', s.allGhosts ? 'true' : 'false');
    UI.text('ringLap', doom && doom.ringLap != null ? '1 lap = ' + lapClock(doom.ringLap) : '');
    var any = !!(doom && doom.drivers.length);
    stepBack.hidden = !any;
    stepOn.hidden = !any;
  }

  /** The tyre stints, every car on one line each, never past the lap it's on. */
  function drawStints() {
    if (stintsCard.hidden) { return; }
    var doom = s.doom;
    var list = stintsCard.querySelector('.stint-list');
    if (!doom) {
      list.innerHTML = '';
      return;
    }
    var current = doom.frame.lap || 0;
    var total = Math.max(doom.totalLaps || 0, Math.max.apply(null, doom.drivers.map(function (d) { return d.lap || 0; }).concat([0])), current, 1);
    var free = doom.freeStops();
    list.innerHTML = doom.drivers.map(function (d) {
      var nowLap = d.lap || current;
      var bars = d.stints.map(function (st) {
        if (st.lapStart == null) { return ''; }
        // Never past the lap the car is on: a replay's stints already know where they end,
        // and that would give the strategy away early.
        var end = st.lapEnd != null ? Math.min(st.lapEnd, nowLap) : nowLap;
        if (end < st.lapStart) { return ''; }
        var left = (st.lapStart - 1) / total * 100;
        var width = Math.max(end - st.lapStart + 1, 0.5) / total * 100;
        return '<i data-tyre="' + F.tyreRole(st.compound) + '" style="left:' + left.toFixed(2) + '%;width:calc(' + width.toFixed(2) + '% - 2px)"></i>';
      }).join('');
      return '<li' + (d.num === s.picked ? ' aria-current="true"' : '') + ' data-num="' + d.num + '"><b>' + (d.pos == null ? '' : d.pos) + '</b>' +
        '<span style="--team:' + team(d) + '">' + esc(F.driverLabel(d)) + '</span><div class="stint-bar">' + bars + '</div>' +
        '<em>' + (free[d.num] && doom.drivers.length > 1 ? 'Free' : '') + '</em></li>';
    }).join('');
  }

  function set(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  // ---------- Input ----------

  /**
   * The car a pointer at (x, y) means: the one drawn nearest its direction from the ring's
   * middle. Inside the pit lane's circle it's one of the cars in the pits, if any are; right
   * in the middle, none.
   */
  function carAt(x, y) {
    var g = s.g;
    if (!g || !s.doom) { return null; }
    var dx = x - g.cx;
    var dy = y - g.cy;
    var distance = Math.hypot(dx, dy);
    if (distance < g.innerR / 2) { return null; }
    var f = RingPick.fraction(dx, dy);
    var pitting = {};
    s.doom.drivers.forEach(function (d) { if (d.inPit) { pitting[d.num] = true; } });
    var inner = distance < (g.r + g.pitR) / 2 && distance > g.innerR && Object.keys(pitting).length > 0;
    var pool = {};
    Object.keys(s.shown).forEach(function (k) {
      if (!!pitting[k] === inner) { pool[k] = s.shown[k]; }
    });
    return RingPick.nearest(Object.keys(pool).length ? pool : s.shown, f);
  }

  function local(e) {
    var r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  var gesture = null;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) { return; }
    var p = local(e);
    canvas.setPointerCapture(e.pointerId);
    gesture = { start: p, first: carAt(p[0], p[1]), dragging: false, current: null };
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!gesture) { return; }
    var p = local(e);
    if (!gesture.dragging && Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) > 6) { gesture.dragging = true; }
    if (!gesture.dragging) { return; }
    s.finger = p;
    var num = carAt(p[0], p[1]);
    if (num != null && num !== gesture.current) {
      gesture.current = num;
      if (navigator.vibrate) { navigator.vibrate(5); }
      if (handlers.onSelect) { handlers.onSelect(num); }
    }
    wake();
  });
  function end(e) {
    if (!gesture) { return; }
    var g = gesture;
    gesture = null;
    s.finger = null;
    if (e.type === 'pointerup' && !g.dragging && g.first != null && handlers.onPick) { handlers.onPick(g.first); }
    s.lastPaint = 0;
    wake();
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  function order() {
    return s.doom ? s.doom.drivers.map(function (d) { return d.num; }) : [];
  }
  stepBack.addEventListener('click', function () {
    if (handlers.onSelect) { handlers.onSelect(RingPick.step(order(), s.picked, -1)); }
  });
  stepOn.addEventListener('click', function () {
    if (handlers.onSelect) { handlers.onSelect(RingPick.step(order(), s.picked, 1)); }
  });

  ghostsBtn.addEventListener('click', function () {
    s.allGhosts = !s.allGhosts;
    UI.save('ghosts', s.allGhosts);
    drawControls();
    s.lastPaint = 0;
    wake();
  });

  stintsBtn.addEventListener('click', function () {
    stintsCard.hidden = !stintsCard.hidden;
    stintsBtn.setAttribute('aria-pressed', stintsCard.hidden ? 'false' : 'true');
    drawStints();
  });
  stintsCard.querySelector('.stints-close').addEventListener('click', function () {
    stintsCard.hidden = true;
    stintsBtn.setAttribute('aria-pressed', 'false');
  });
  stintsCard.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      stintsCard.hidden = true;
      stintsBtn.setAttribute('aria-pressed', 'false');
      stintsBtn.focus();
    }
  });

  root.addEventListener('click', function (e) {
    var target = e.target.closest('[data-num]');
    if (target && handlers.onPick) { handlers.onPick(Number(target.getAttribute('data-num'))); }
  });

  s.allGhosts = UI.load('ghosts', false) === true;

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () {
      s.g = null;
      s.lastPaint = 0;
      wake();
    }).observe(canvas);
  }
  document.addEventListener('visibilitychange', wake);

  /*
   * Draw a frame. ctx: {totalLaps, picked, followed: Set, shown: whether the Wall is up,
   * rate: how fast race time runs between frames (1 live, the replay's speed while it plays,
   * 0 when paused or stale)}.
   */
  function render(frame, c) {
    var changed = frame !== s.frame;
    s.frame = frame;
    s.visible = c.shown;
    s.followed = c.followed;
    s.rate = c.rate;
    if (changed) {
      s.doom = frame ? new Doom(frame, c.totalLaps) : null;
      s.arrived = performance.now();
      s.g = null;
      if (!s.doom) { s.shown = {}; }
    }
    if (c.picked !== s.picked || changed) { s.assignDue = true; }
    s.picked = c.picked;
    // Opened with a driver you follow running: they're picked already, the usual question.
    if (c.shown && s.doom && s.picked == null && s.openedFor !== (frame.session && frame.session.key)) {
      s.openedFor = frame.session && frame.session.key;
      var first = s.doom.drivers.filter(function (d) { return s.followed.has(d.num) && !d.inPit; })
        .sort(function (a, b) { return (a.pos || 99) - (b.pos || 99); })[0];
      if (first && handlers.onSelect) {
        handlers.onSelect(first.num);
        return;
      }
    }
    if (!c.shown) { return; }
    drawPitNow();
    drawLoss();
    drawFree();
    drawControls();
    drawStints();
    // The cards may have grown or shrunk: the ring is sized round them.
    s.g = null;
    s.lastPaint = 0;
    wake();
  }

  P.Ring = {
    render: render,
    on: function (h) { handlers = h; }
  };
}());
