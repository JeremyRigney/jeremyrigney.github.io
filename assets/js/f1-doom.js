/*
 * /f1-wall's Wall tab — the pit wall's "wall of doom".
 *
 * The lap is a ring, and one trip round it is one lap of *time*, not distance. Every car
 * sits at its gap to the leader: a car 20s behind is 20s of arc behind, whatever corner it
 * happens to be in. That is the property the whole view exists for, because a pit stop is
 * also a time: each car's ghost — where it would rejoin if it boxed now — is the car itself
 * moved back round the ring by the pit loss, and who the ghost lands next to is who the car
 * comes out next to.
 *
 * Under a safety car the lap stretches (the server's `strategy.ringLap`) and the pit loss
 * shrinks, so the ghosts visibly pull in towards their cars. That shrinking is the cheap
 * stop everyone dives for, and it is the main thing this is for.
 *
 * Where the ring is anchored: the leader's own lap start. Between polls the whole field
 * turns at one lap per `ringLap`, carried forward from the frame's `generated` time at the
 * replay or live rate, and every car eases towards its target so a fresh gap reads as a
 * drift rather than a jump. Nothing here depends on the map's car positions.
 *
 * Every field the server added for this (`strategy`, `lapStart`) is optional. Without them
 * the ring says what it is missing rather than drawing something wrong.
 *
 * Public: window.f1Doom = { render, show, select, onSelect }.
 */

(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Seconds a rejoining car can have to the car ahead of it before it is in traffic.
  var TRAFFIC_S = 1.5;
  // Close enough behind that the car can undercut: stop first, and the fresh tyres make
  // up the gap before the car ahead stops in turn.
  var UNDERCUT_S = 2.5;
  // How quickly a car eases to a new target, and how often the ring repaints.
  var SMOOTH_MS = 240;
  var FRAME_MS = reducedMotion ? 1000 : 33;
  // How far the clock is carried forward past a frame before it waits for the next one.
  var EXTRAPOLATE_MS = 1600;
  // A car whose lap began this many ring-laps ago is not on track: in the garage, or the
  // session stopped. It is left off the ring rather than spun round it forever.
  var STALE_LAPS = 2.5;

  var canvas = null;
  var ctx = null;
  var centre = null;
  var strip = null;
  var ghostsButton = null;
  var drawer = null;
  var stintsButton = null;
  var cardsWrap = null;
  var cards = null;        // { loss, free, feed, legend } — the corner cards
  var cardShown = {};      // card id -> the HTML it last drew, to skip identical rewrites

  // A driver code in Barlow Condensed bold is about 1.6em wide; with its padding, this is
  // the room the layout keeps for a label before any have been measured.
  var LABEL_EM = 1.7;

  var width = 0;
  var height = 0;
  var dpr = 1;
  var geometry = null;     // { cx, cy, R, lane, ghostR, pitR }

  var visible = false;
  var frame = null;        // the newest payload, digested — see digest()
  var shown = {};          // num -> the fraction of a lap it is drawn at now
  var lastStep = 0;
  var raf = 0;
  var hits = [];           // [{num, x, y, r}] for click testing

  var selected = null;
  var hovered = null;      // the car under the pointer, whose label is never dropped
  var allGhosts = false;
  var selectListener = null;

  /* ---------- Small helpers ---------- */

  function number(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function wrap(f) {
    f = f % 1;
    return f < 0 ? f + 1 : f;
  }

  function mod(value, by) {
    var r = value % by;
    return r < 0 ? r + by : r;
  }

  /* The shortest signed step from fraction a to fraction b, in laps. */
  function step(a, b) {
    var d = wrap(b - a);
    return d > 0.5 ? d - 1 : d;
  }

  function median(values) {
    var list = values.filter(function (v) { return number(v) !== null; })
      .sort(function (a, b) { return a - b; });
    if (!list.length) {
      return null;
    }
    var mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  }

  /*
   * The wall's own team colour when it is there — f1-dash.js lifts the dark ones so they
   * read on this ground, and the ring should match the tower and the map — and a plain
   * check of the hex otherwise. Asked at draw time, not load time: f1-dash.js loads after
   * this file.
   */
  function teamColour(value) {
    var shared = window.f1Live && window.f1Live.teamColour;
    var colour = shared ? shared(value) : null;
    if (colour) {
      return colour;
    }
    return /^[0-9a-fA-F]{6}$/.test(value || '') ? '#' + value : '#9aa0a6';
  }

  function code(driver) {
    return driver.code || ('#' + driver.num);
  }

  function seconds(value) {
    return value === null ? '—' : value.toFixed(1) + 's';
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function token(styles, name, fallback) {
    var value = styles.getPropertyValue(name);
    return (value && value.trim()) || fallback;
  }

  /* ---------- Digesting a frame ---------- */

  /*
   * Time behind the leader, per car, in race order.
   *
   * `gapToLeader` where it is a number. A lapped car's arrives as "+1 LAP", and for that one
   * the intervals are summed down from the car in front, which keeps a lapped car on the
   * ring at its real distance rather than parked at the leader.
   */
  function timesBehind(drivers) {
    var out = {};
    var previous = null;
    var leaderSeen = false;
    drivers.forEach(function (d) {
      if (d.dnf || d.pos === null || d.pos === undefined) {
        return;
      }
      var t = null;
      if (!leaderSeen) {
        t = 0;
        leaderSeen = true;
      } else if (number(d.gapToLeader) !== null && d.gapToLeader > 0) {
        t = d.gapToLeader;
      } else if (previous !== null && number(d.interval) !== null) {
        t = previous + d.interval;
      }
      out[d.num] = t;
      previous = t;
    });
    return out;
  }

  /*
   * The lap the ring is drawn on. The server's when it sent one — green pace, stretched
   * under a neutralisation. Otherwise an estimate: the session best plus a little for a
   * practice session, which has no pace model, or the field's median last lap.
   */
  function ringLap(data, drivers) {
    var strategy = data.strategy;
    if (strategy && number(strategy.ringLap)) {
      return strategy.ringLap;
    }
    var typical = median(drivers.map(function (d) { return d.lastLap; }));
    if (data.best && number(data.best.lap)) {
      return typical ? Math.min(typical, data.best.lap * 1.04) : data.best.lap * 1.04;
    }
    return typical;
  }

  function digest(data, options) {
    var drivers = (data.drivers || []).filter(function (d) { return !d.dnf; });
    var byNum = {};
    drivers.forEach(function (d) { byNum[d.num] = d; });
    var behind = timesBehind(drivers);
    var leader = null;
    for (var i = 0; i < drivers.length; i += 1) {
      if (behind[drivers[i].num] === 0) {
        leader = drivers[i];
        break;
      }
    }
    var strategy = data.strategy || null;
    var loss = strategy && strategy.pitLoss ? number(strategy.pitLoss.now) : null;
    return {
      data: data,
      drivers: drivers,
      byNum: byNum,
      behind: behind,
      leader: leader,
      T: ringLap(data, drivers),
      loss: loss,
      strategy: strategy,
      totalLaps: options.totalLaps || null,
      gen: Date.parse(data.generated) || Date.now(),
      at: performance.now(),
      rate: number(options.rate) === null ? 1 : options.rate,
      hasLapStart: drivers.some(function (d) { return !!d.lapStart; })
    };
  }

  /* ---------- Placement ---------- */

  function clockNow() {
    var elapsed = Math.min(performance.now() - frame.at, EXTRAPOLATE_MS);
    return frame.gen + Math.max(0, elapsed) * frame.rate;
  }

  function lapFraction(lapStart, now, T) {
    var begun = Date.parse(lapStart);
    if (!begun) {
      return null;
    }
    var into = (now - begun) / 1000;
    if (into < -5 || into > T * STALE_LAPS) {
      return null;
    }
    return wrap(into / T);
  }

  /* Where every car should be drawn at `now`, as a fraction of the lap from the line. */
  function targets(now) {
    var out = {};
    var T = frame.T;
    if (!T) {
      return out;
    }
    var anchor = frame.leader && frame.leader.lapStart
      ? lapFraction(frame.leader.lapStart, now, T) : null;
    frame.drivers.forEach(function (d) {
      var t = frame.behind[d.num];
      var f = null;
      if (anchor !== null && t !== null && t !== undefined) {
        f = wrap(anchor - t / T);
      } else if (d.lapStart) {
        // No gap to place it by — practice, qualifying, the opening lap — so its own lap.
        f = lapFraction(d.lapStart, now, T);
      }
      if (f !== null) {
        out[d.num] = f;
      }
    });
    return out;
  }

  /* ---------- The pit-now projection ---------- */

  /*
   * What happens if this car boxes now. All of it from time behind the leader, so it is
   * exactly what the ring shows: the ghost's time is the car's plus the pit loss, and
   * everything else is who sits either side of that time.
   */
  function project(num) {
    var car = frame.byNum[num];
    var t = frame.behind[num];
    var loss = frame.loss;
    if (!car || t === null || t === undefined || loss === null) {
      return null;
    }

    var rejoin = t + loss;
    var others = frame.drivers.filter(function (d) {
      var tj = frame.behind[d.num];
      return d.num !== num && tj !== null && tj !== undefined;
    });

    var position = 1;
    var ahead = null;
    var behind = null;
    var nextBack = null;   // the car directly behind it now
    var nextUp = null;     // the car directly ahead of it now
    others.forEach(function (d) {
      var tj = frame.behind[d.num];
      if (tj < rejoin) {
        position += 1;
        if (!ahead || tj > frame.behind[ahead.num]) {
          ahead = d;
        }
      } else if (!behind || tj < frame.behind[behind.num]) {
        behind = d;
      }
      if (tj > t && (!nextBack || tj < frame.behind[nextBack.num])) {
        nextBack = d;
      }
      if (tj < t && (!nextUp || tj > frame.behind[nextUp.num])) {
        nextUp = d;
      }
    });

    // Traffic is physical, not positional: a lapped car the ghost lands on is still in
    // the way. So it is measured round the ring, modulo a lap.
    var traffic = null;
    var T = frame.T;
    if (T) {
      var ghostRing = mod(rejoin, T);
      others.forEach(function (d) {
        if (d.inPit) {
          return;
        }
        var gapAhead = mod(ghostRing - mod(frame.behind[d.num], T), T);
        if (gapAhead < TRAFFIC_S && (!traffic || gapAhead < traffic.gap)) {
          traffic = { driver: d, gap: gapAhead };
        }
      });
    }

    var gapBack = nextBack ? frame.behind[nextBack.num] - t : null;
    var gapUp = nextUp ? t - frame.behind[nextUp.num] : null;

    return {
      car: car,
      from: car.pos,
      position: position,
      ahead: ahead,
      aheadGap: ahead ? rejoin - frame.behind[ahead.num] : null,
      behind: behind,
      behindGap: behind ? frame.behind[behind.num] - rejoin : null,
      traffic: traffic,
      free: gapBack === null || gapBack > loss,
      threat: nextBack && gapBack < UNDERCUT_S ? { driver: nextBack, gap: gapBack } : null,
      chance: nextUp && gapUp < UNDERCUT_S ? { driver: nextUp, gap: gapUp } : null
    };
  }

  /* Whether each car could stop now without losing a place to the car behind. */
  function freeStops() {
    var out = {};
    if (frame.loss === null) {
      return out;
    }
    var timed = frame.drivers.filter(function (d) {
      var t = frame.behind[d.num];
      return t !== null && t !== undefined;
    });
    timed.forEach(function (d, i) {
      var next = timed[i + 1];
      out[d.num] = !next || (frame.behind[next.num] - frame.behind[d.num]) > frame.loss;
    });
    return out;
  }

  /* ---------- The corners ---------- */

  /*
   * Top-left: what a stop costs, under each state of the race, with the one that applies
   * now marked. Under a neutralisation its second line becomes the saving, which is the
   * reason anyone looks at this card during a safety car.
   */
  function lossCard() {
    var s = frame.strategy;
    if (!s || !s.pitLoss) {
      return '';
    }
    var flag = (frame.data.flag && frame.data.flag.state) || 'GREEN';
    var active = flag === 'VSC' ? 'vsc' : flag === 'SAFETY_CAR' ? 'sc' : 'green';
    var cells = [['green', 'Green'], ['vsc', 'VSC'], ['sc', 'SC']].map(function (pair) {
      var value = number(s.pitLoss[pair[0]]);
      return '<span class="dk-loss-cell' + (pair[0] === active ? ' is-on' : '') + '">' +
        '<b>' + pair[1] + '</b>' + (value === null ? '—' : value.toFixed(1)) + '</span>';
    }).join('');

    var note;
    if (active !== 'green' && number(s.pitLoss.green) !== null
        && number(s.pitLoss[active]) !== null) {
      note = '<p class="dk-note is-save">A stop now saves ' +
        (s.pitLoss.green - s.pitLoss[active]).toFixed(1) + 's</p>';
    } else {
      var samples = s.pitLoss.samples || {};
      note = '<p class="dk-note">' + (s.pitLoss.basis === 'calibrated'
        ? 'Calibrated from ' + samples.green + ' stop' + (samples.green === 1 ? '' : 's')
        : 'Circuit estimate') + '</p>';
    }
    return '<p class="dk-label">Pit loss (s)</p><p class="dk-loss">' + cells + '</p>' + note;
  }

  /*
   * Top-right: who could box this lap without losing a place to the car behind — the
   * question a safety car poses to every pit wall at once. In running order, and cut to
   * three and a count when it runs long, because the card's height is fixed.
   */
  var FREE_MAX = 4;

  function freeCard() {
    if (frame.loss === null) {
      return '';
    }
    var free = frame.drivers.length > 1 ? freeStops() : {};
    var list = frame.drivers.filter(function (d) { return free[d.num] && !d.inPit; });
    var shown = list.length > FREE_MAX ? list.slice(0, FREE_MAX - 1) : list;
    var body = shown.map(function (d) {
      return '<button class="dk-chip' + (d.num === selected ? ' is-selected' : '') +
        '" type="button" data-num="' + d.num + '" title="' +
        escapeHtml((d.name || code(d)) + ' could stop now without losing a place') + '">' +
        escapeHtml(code(d)) + '</button>';
    }).join('');
    if (list.length > shown.length) {
      body += '<span class="dk-more">+' + (list.length - shown.length) + '</span>';
    }
    return '<p class="dk-label">Free stop now</p><p class="dk-free">' +
      (body || '<span class="dk-none">None</span>') + '</p>';
  }

  /*
   * Bottom-right: the newest message from race control. The Wall hides the map's feed band,
   * so without this the tab would be deaf to it. Shown from the first frame, with a
   * placeholder, so the card does not appear mid-race and move the ring.
   */
  function feedCard() {
    var event = (frame.data.events || [])[0];
    var when = event && event.t ? new Date(event.t) : null;
    var stamp = when && !isNaN(when) ? when.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit'
    }) : '';
    return '<p class="dk-label"><span>Race control</span>' +
      '<span class="dk-time">' + stamp + '</span></p>' +
      (event
        ? '<p class="dk-feed-text">' + escapeHtml(event.text || '') + '</p>'
        : '<p class="dk-feed-text is-empty">Nothing yet</p>');
  }

  /* Bottom-left: the key. What one trip round the ring is, and what a hollow ring means. */
  function legendCard() {
    if (!frame.T) {
      return '';
    }
    var minutes = Math.floor(frame.T / 60);
    var rest = frame.T - minutes * 60;
    return '<p class="dk-legend">Ring = one lap · ' + minutes + ':' + (rest < 10 ? '0' : '') +
      rest.toFixed(1) + '</p>' +
      '<p class="dk-legend"><i class="dk-ghost"></i>Where it rejoins if it pits</p>';
  }

  /*
   * Writes every card, and re-lays the ring out if one has appeared or gone — the only
   * change that moves a card's box, since each holds a fixed number of lines.
   */
  function renderCards() {
    if (!cards) {
      return;
    }
    var moved = false;
    [['loss', lossCard()], ['free', freeCard()], ['legend', legendCard()],
      ['feed', feedCard()]].forEach(function (pair) {
      var card = cards[pair[0]];
      var html = pair[1];
      if (!card) {
        return;
      }
      if (card.hidden === !!html) {
        card.hidden = !html;
        moved = true;
      }
      if (html && cardShown[pair[0]] !== html) {
        cardShown[pair[0]] = html;
        card.innerHTML = html;
      }
    });
    if (moved && geometry) {
      layout();
      draw();
    }
  }

  /* ---------- The centre ---------- */

  var centreShown = '';

  function pickBlock() {
    if (!frame.strategy) {
      return '<p class="dc-hint">' + (frame.data.session && frame.data.session.type === 'Race'
        ? 'Pit ghosts need the updated timing server'
        : 'Pit ghosts are for races — practice and qualifying have no gaps') + '</p>';
    }
    if (selected === null || !frame.byNum[selected]) {
      return '<p class="dc-hint">Pick a car to project its stop</p>';
    }
    var p = project(selected);
    var car = frame.byNum[selected];
    var head = '<p class="dc-pick-head"><i style="background:' + teamColour(car.colour) +
      '"></i>' + escapeHtml(code(car)) + ' · if they pit now</p>';
    if (!p) {
      return head + '<p class="dc-note">No gap to project from yet</p>';
    }
    var where = [];
    if (p.ahead) {
      where.push(seconds(p.aheadGap) + ' behind ' + escapeHtml(code(p.ahead)));
    }
    if (p.behind) {
      where.push(seconds(p.behindGap) + ' ahead of ' + escapeHtml(code(p.behind)));
    }
    var tags = [];
    if (p.free) {
      tags.push('<span class="dc-tag is-good">Free stop</span>');
    } else if (p.position > p.from) {
      tags.push('<span class="dc-tag">Loses ' + (p.position - p.from) + '</span>');
    }
    if (p.traffic) {
      tags.push('<span class="dc-tag is-warn">Traffic ' + escapeHtml(code(p.traffic.driver)) +
        ' ' + seconds(p.traffic.gap) + '</span>');
    }
    if (p.threat) {
      tags.push('<span class="dc-tag is-warn">Undercut threat ' +
        escapeHtml(code(p.threat.driver)) + '</span>');
    }
    if (p.chance) {
      tags.push('<span class="dc-tag is-good">Undercut on ' +
        escapeHtml(code(p.chance.driver)) + '</span>');
    }
    return head +
      '<p class="dc-pick-main">P' + p.from + ' → P' + p.position + '</p>' +
      (where.length ? '<p class="dc-where">' + where.join(' · ') + '</p>' : '') +
      (tags.length ? '<p class="dc-tags">' + tags.join('') + '</p>' : '');
  }

  /*
   * The pick and nothing else. The lap count is in the status bar, and the scale, the
   * losses and race control are in the corners — see renderCards.
   */
  function renderCentre() {
    if (!centre) {
      return;
    }
    var html = pickBlock();
    if (html !== centreShown) {
      centreShown = html;
      centre.innerHTML = html;
      fitCentre();
    }
  }

  /* ---------- The stint strip ---------- */

  var stripShown = '';

  function renderStrip() {
    // Drawn only while its drawer is open; opening it draws it.
    if (!strip || (drawer && drawer.hidden)) {
      return;
    }
    var current = (frame.data.lap && frame.data.lap.current) || 0;
    var total = frame.totalLaps || 0;
    frame.drivers.forEach(function (d) {
      total = Math.max(total, d.lap || 0);
    });
    total = Math.max(total, current, 1);
    var free = freeStops();

    var html = frame.drivers.map(function (d) {
      var bars = (d.stints || []).map(function (s) {
        if (s.lapStart === null || s.lapStart === undefined) {
          return '';
        }
        // Never past the lap the car is on. A replay's stints already know where they
        // end, and drawing that would show the strategy before it happened.
        var now = d.lap || current;
        var end = s.lapEnd === null || s.lapEnd === undefined ? now : Math.min(s.lapEnd, now);
        if (end < s.lapStart) {
          return '';
        }
        var left = (s.lapStart - 1) / total * 100;
        var span = Math.max(end - s.lapStart + 1, 0.5) / total * 100;
        var letter = (s.compound || '?').charAt(0).toLowerCase();
        return '<i class="ss-stint ss-' + escapeHtml(letter) + '" style="left:' +
          left.toFixed(2) + '%;width:' + span.toFixed(2) + '%" title="' +
          escapeHtml((s.compound || 'Unknown') + ' · laps ' + s.lapStart + '–' + end) + '"></i>';
      }).join('');
      var mark = free[d.num] && frame.drivers.length > 1
        ? '<b class="ss-free is-free" ' +
          'title="Free stop: the gap behind is bigger than the pit loss">FREE</b>'
        : '<b class="ss-free"></b>';
      return '<li class="ss-row' + (d.num === selected ? ' is-selected' : '') +
        (d.inPit ? ' is-pit' : '') + '" data-num="' + d.num + '">' +
        '<span class="ss-pos">' + (d.pos === null || d.pos === undefined ? '' : d.pos) + '</span>' +
        '<span class="ss-code" style="border-color:' + teamColour(d.colour) + '">' +
          escapeHtml(code(d)) + '</span>' +
        '<span class="ss-track">' + bars +
          '<i class="ss-now" style="left:' + (current / total * 100).toFixed(2) + '%"></i>' +
        '</span>' + mark + '</li>';
    }).join('');

    if (html !== stripShown) {
      stripShown = html;
      strip.innerHTML = html;
    }
  }

  /* ---------- Drawing ---------- */

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  /*
   * Sizes, type first. The labels are what has to be readable from across the room, so
   * their size is fixed from the space available and the ring is whatever is left once
   * there is room for them outside it — wider than tall on the sides, where a label
   * sticks out sideways, than at the top and bottom.
   */
  function layout() {
    var cx = width / 2;
    var cy = height / 2;
    var small = Math.min(width, height);
    // Smaller than it was (3% of the panel, up to 26px): a label now has to fit beside its
    // own car rather than be carried round the ring, and at this size most of a bunched
    // field does. Still the tower's code size on the 14-inch screen, give or take a pixel.
    var fontPx = clamp(small * 0.024, 13, 19);
    var labelW = fontPx * (LABEL_EM + 0.35);
    var labelH = fontPx * 1.2 + 2;
    var sideRoom = 18 + labelW;
    var topRoom = 18 + fontPx * 1.6;
    var R = Math.min(width / 2 - sideRoom, height / 2 - topRoom) / 1.04;

    /*
     * And clear of the corner cards. A label sits outside the ring at labelR plus up to its
     * own diagonal, so the furthest any label reaches is outer + 18 + about 0.71 of its
     * width and height together; the nearest point of any card has to be further than
     * that. outer is R plus half a lane, and a lane is 7.5% of R, hence the 1.0375.
     */
    var reach = cardReach(cx, cy);
    if (reach < Infinity) {
      R = Math.min(R, (reach - 22 - 0.71 * (labelW + labelH)) / 1.0375);
    }
    R = Math.max(60, R);
    var lane = clamp(R * 0.075, 10, 30);
    geometry = {
      cx: cx,
      cy: cy,
      R: R,
      lane: lane,
      outer: R + lane / 2,
      ghostR: R - lane * 1.4,
      pitR: R - lane * 2.7,
      innerR: R - lane * 3.7,
      fontPx: fontPx,
      tickFont: clamp(fontPx * 0.75, 12, 20),
      dot: clamp(lane * 0.55, 7, 15)
    };
    // The ring changed size, so the spacing rows were judged on is stale.
    assignDue = true;
    lastAssign = 0;

    // The centre text sits in a box just inside the innermost lane. Its corners reach a
    // little past the lane, which costs nothing: the text is centred, and the short lines
    // at top and bottom never reach them.
    if (centre) {
      var boxW = Math.max(180, geometry.innerR * 1.62);
      var boxH = Math.max(150, geometry.innerR * 1.5);
      centre.style.width = boxW + 'px';
      centre.style.height = boxH + 'px';
      centre.style.left = (cx - boxW / 2) + 'px';
      centre.style.top = (cy - boxH / 2) + 'px';
      fitCentre();
    }
  }

  /*
   * The nearest any visible corner card comes to the ring's centre, in canvas pixels, or
   * Infinity when there is nothing to keep clear of — no cards, or a narrow window, where
   * the cards are static and sit below the ring rather than over it.
   */
  function cardRects() {
    if (!cards || !cardsWrap || getComputedStyle(cardsWrap).position === 'static') {
      return [];
    }
    return Object.keys(cards).filter(function (name) {
      return cards[name] && !cards[name].hidden;
    }).map(function (name) {
      var card = cards[name];
      return {
        x0: card.offsetLeft,
        y0: card.offsetTop,
        x1: card.offsetLeft + card.offsetWidth,
        y1: card.offsetTop + card.offsetHeight
      };
    });
  }

  function cardReach(cx, cy) {
    var nearest = Infinity;
    cardRects().forEach(function (r) {
      var dx = r.x0 > cx ? r.x0 - cx : r.x1 < cx ? cx - r.x1 : 0;
      var dy = r.y0 > cy ? r.y0 - cy : r.y1 < cy ? cy - r.y1 : 0;
      nearest = Math.min(nearest, Math.hypot(dx, dy));
    });
    return nearest;
  }

  /*
   * Fit by dropping, never by shrinking. The centre's type is the page's own scale; if the
   * pick does not fit the box, the where-line goes first, then the tags past the second.
   * Shrinking everything to fit is how the projection used to end up the size of a
   * footnote.
   */
  function fitCentre() {
    if (!centre || !geometry) {
      return;
    }
    centre.classList.remove('is-tight', 'is-tighter');
    if (centre.scrollHeight > centre.clientHeight + 1) {
      centre.classList.add('is-tight');
    }
    if (centre.scrollHeight > centre.clientHeight + 1) {
      centre.classList.add('is-tighter');
    }
  }

  /*
   * Which row each car's label sits in, and whether it shows at all.
   *
   * This is a moving picture, and a label has to be something the eye can lock on to and
   * follow round the ring. So a label is fixed to its car — always straight out from it,
   * moving only because the car moves — and the one thing that can change about it, its
   * row, changes rarely and never abruptly:
   *
   *   - Rows are decided at most once a second (ASSIGN_MS), not on every painted frame.
   *   - Spacing is judged on the gaps between cars, with a footprint that is the same at
   *     every angle — a label's width, its widest case. So the whole field turning round
   *     the ring, which is most of what moves, never changes a row; only cars closing up
   *     or dropping back does.
   *   - A label keeps its row while it still fits, with some give (KEEP), so two cars sat
   *     right at the threshold do not trade rows back and forth.
   *   - A change of row is a glide, and a label that drops out or comes back fades (TAG_MS).
   *
   * Up to three rows outward. A label with no room in any is dropped — the car is still a
   * dot, still in the tower, and hovering it names it — in order of importance, so what
   * drops is the back of a bunch, never the car you picked or the leader.
   *
   * An earlier version placed every label afresh on every frame, with sideways nudges and
   * the cards and canvas edges as obstacles. Each frame was tidy; the animation was not —
   * labels hopped between slots constantly and could not be followed. Labels now simply
   * pass under a corner card, as anything moving behind it would.
   */
  var ROWS = 3;
  var ASSIGN_MS = 1000;
  var TAG_MS = 300;
  var KEEP = 0.85;
  // And the other side of the same give: a label that was dropped comes back only once
  // there is clearly room for it, not the moment there is just enough. Without this a car
  // at the edge of a bunch faded in and out every second or two.
  var RETURN = 1.25;

  var tags = {};           // num -> { row, rowShown, alpha, on }
  var lastAssign = 0;
  var assignDue = true;    // a new frame or pick has arrived since rows were last decided
  var tagSpan = 0;         // a label's footprint along the ring in pixels, set by draw()

  function rank(d) {
    if (d.num === selected) { return -2; }
    if (frame.leader && d.num === frame.leader.num) { return -1; }
    return d.pos === null || d.pos === undefined ? 99 : d.pos;
  }

  function assignRows(nowMs, force) {
    if (!frame || !geometry || !tagSpan) {
      return;
    }
    if (!force && nowMs - lastAssign < ASSIGN_MS) {
      return;
    }
    lastAssign = nowMs;
    assignDue = false;

    // The footprint as a fraction of the lap, on the innermost row, where it is tightest.
    var span = tagSpan / (Math.PI * 2 * (geometry.outer + 18));
    var cars = frame.drivers.filter(function (d) {
      return shown[d.num] !== undefined;
    }).sort(function (a, b) { return rank(a) - rank(b); });

    var rows = [];
    for (var r = 0; r < ROWS; r += 1) {
      rows.push([]);
    }
    var next = {};
    function fits(row, f, need) {
      return rows[row].every(function (g) { return Math.abs(step(g, f)) >= need; });
    }
    function put(d, row) {
      rows[row].push(shown[d.num]);
      next[d.num] = row;
    }

    // The pick where it already was, unconditionally; then everyone who still fits where
    // they are; then the rest, each in the lowest row with room. A car in the pit lane has
    // its own label inside the ring, so its outer one fades.
    cars.forEach(function (d) {
      var t = tags[d.num];
      if (d.num === selected && !d.inPit) {
        put(d, t && t.on ? t.row : 0);
      }
    });
    cars.forEach(function (d) {
      var t = tags[d.num];
      if (next[d.num] === undefined && !d.inPit && t && t.on &&
          fits(t.row, shown[d.num], span * KEEP)) {
        put(d, t.row);
      }
    });
    cars.forEach(function (d) {
      if (next[d.num] !== undefined || d.inPit) {
        return;
      }
      var t = tags[d.num];
      var need = t && !t.on ? span * RETURN : span;
      for (var row = 0; row < ROWS; row += 1) {
        if (fits(row, shown[d.num], need)) {
          put(d, row);
          return;
        }
      }
    });

    var present = {};
    cars.forEach(function (d) {
      present[d.num] = true;
      var row = next[d.num];
      var t = tags[d.num] || (tags[d.num] = { row: 0, rowShown: 0, alpha: 0, on: false });
      if (row === undefined) {
        t.on = false;
        return;
      }
      // A label that is coming back fades in where it lands rather than sliding there.
      if (!t.on && t.alpha < 0.05) {
        t.rowShown = row;
      }
      t.row = row;
      t.on = true;
    });
    Object.keys(tags).forEach(function (num) {
      if (!present[num]) {
        delete tags[num];
      }
    });
  }

  /* Glides each label toward its row and fades it in or out. True while any is moving. */
  function easeTags(dt) {
    var k = reducedMotion || !dt ? 1 : 1 - Math.exp(-dt * 3 / TAG_MS);
    var busy = false;
    Object.keys(tags).forEach(function (num) {
      var t = tags[num];
      var alpha = t.on ? 1 : 0;
      t.rowShown += (t.row - t.rowShown) * k;
      t.alpha += (alpha - t.alpha) * k;
      if (Math.abs(t.row - t.rowShown) > 0.01 || Math.abs(alpha - t.alpha) > 0.01) {
        busy = true;
      } else {
        t.rowShown = t.row;
        t.alpha = alpha;
      }
    });
    return busy;
  }

  function at(f, r) {
    var theta = -Math.PI / 2 + f * Math.PI * 2;
    return [geometry.cx + r * Math.cos(theta), geometry.cy + r * Math.sin(theta)];
  }

  function arcBetween(from, to, r) {
    // Clockwise, the direction of travel, from `from` to `to`.
    var a = -Math.PI / 2 + from * Math.PI * 2;
    var b = a + wrap(to - from) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(geometry.cx, geometry.cy, r, a, b, false);
  }

  function notice(text, styles) {
    ctx.fillStyle = token(styles, '--ink-faint', '#6b7178');
    ctx.font = '500 ' + (geometry ? Math.round(geometry.fontPx) : 16) + 'px ' +
      token(styles, '--font-mono', 'monospace');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2);
  }

  function draw() {
    if (!ctx || !width) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    hits = [];

    var styles = getComputedStyle(document.documentElement);
    var ground = token(styles, '--coal', '#111214');
    var ink = token(styles, '--ink', '#eceef0');
    var soft = token(styles, '--ink-soft', '#9aa0a6');
    var faint = token(styles, '--ink-faint', '#6b7178');
    var line = token(styles, '--line', 'rgba(236,238,240,0.14)');
    var strong = token(styles, '--line-strong', 'rgba(236,238,240,0.28)');
    var flagRgb = token(styles, '--flag-rgb', '0, 0, 0');
    var mono = token(styles, '--font-mono', 'monospace');
    // Driver codes and the ghost's place are names, not timing: the condensed face. The
    // marks round the ring (S/F, S2, S3) stay in the mono with the page's other labels.
    var cond = token(styles, '--font-cond', 'sans-serif');

    if (!frame) {
      notice('Waiting for timing', styles);
      return;
    }
    if (!frame.hasLapStart) {
      notice('The Wall needs the updated timing server', styles);
      return;
    }
    if (!frame.T) {
      notice('Waiting for lap times', styles);
      return;
    }

    var g = geometry;
    var T = frame.T;
    var flag = (frame.data.flag && frame.data.flag.state) || 'GREEN';
    var neutral = flag === 'VSC' || flag === 'SAFETY_CAR' || flag === 'RED';

    // The track: tinted with the flag while the race is neutralised, so a safety car
    // reads from across the room before any number on it does.
    ctx.lineWidth = g.lane;
    ctx.strokeStyle = neutral ? 'rgba(' + flagRgb + ', 0.32)' : line;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2);
    ctx.stroke();

    // The ghost lane and the pit lane, as hairlines.
    ctx.lineWidth = 1;
    ctx.strokeStyle = line;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.ghostR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.pitR, 0, Math.PI * 2);
    ctx.stroke();

    // A tick every five seconds of the lap, longer every fifteen, so a gap can be read
    // off the ring by eye.
    var outer = g.outer;
    for (var s = 5; s < T - 1; s += 5) {
      var major = s % 15 === 0;
      var p0 = at(s / T, outer + 3);
      var p1 = at(s / T, outer + (major ? 14 : 8));
      ctx.strokeStyle = major ? strong : line;
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
    }

    // Sector boundaries, placed by the session-best sector split, and the line itself.
    var sectors = (frame.data.best && frame.data.best.sectors) || [];
    var sum = (number(sectors[0]) || 0) + (number(sectors[1]) || 0) + (number(sectors[2]) || 0);
    var marks = [[0, 'S/F', ink, 1.6]];
    if (sum > 0 && number(sectors[0]) && number(sectors[1])) {
      marks.push([sectors[0] / sum, 'S2', soft, 1]);
      marks.push([(sectors[0] + sectors[1]) / sum, 'S3', soft, 1]);
    }
    var tickFont = g.tickFont;
    marks.forEach(function (m) {
      var a = at(m[0], g.R - g.lane / 2 - 2);
      var b = at(m[0], g.R + g.lane / 2 + 2);
      ctx.strokeStyle = m[2];
      ctx.lineWidth = m[3] * 2.5;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      var label = at(m[0], g.pitR - tickFont * 1.3);
      ctx.fillStyle = soft;
      ctx.font = '600 ' + tickFont + 'px ' + mono;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m[1], label[0], label[1]);
    });

    var placed = frame.drivers.filter(function (d) { return shown[d.num] !== undefined; });
    if (!placed.length) {
      notice(flag === 'RED' ? 'Session suspended' : 'No cars on track', styles);
      return;
    }

    var dot = g.dot;
    var fontPx = g.fontPx;

    // Ghosts first, under the cars: an arc along the ghost lane from where the car would
    // rejoin up to the car itself, and a hollow marker at the rejoin point.
    if (frame.loss !== null) {
      placed.forEach(function (d) {
        if (d.inPit || frame.behind[d.num] === null || frame.behind[d.num] === undefined) {
          return;
        }
        var isPick = d.num === selected;
        if (!allGhosts && !isPick) {
          return;
        }
        var colour = teamColour(d.colour);
        var f = shown[d.num];
        var ghost = wrap(f - frame.loss / T);
        ctx.globalAlpha = isPick ? 0.8 : 0.35;
        ctx.strokeStyle = colour;
        ctx.lineWidth = isPick ? 4 : 2.5;
        arcBetween(ghost, f, g.ghostR);
        ctx.stroke();
        ctx.globalAlpha = 1;

        var gp = at(ghost, g.ghostR);
        ctx.beginPath();
        ctx.arc(gp[0], gp[1], dot * (isPick ? 0.95 : 0.7), 0, Math.PI * 2);
        ctx.fillStyle = ground;
        ctx.fill();
        ctx.setLineDash(isPick ? [] : [3, 3]);
        ctx.lineWidth = isPick ? 3 : 2;
        ctx.stroke();
        ctx.setLineDash([]);

        if (isPick) {
          var p = project(d.num);
          if (p) {
            var lp = at(ghost, g.ghostR - dot - fontPx * 0.9);
            ctx.fillStyle = ink;
            ctx.font = '700 ' + Math.round(fontPx) + 'px ' + cond;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('P' + p.position, lp[0], lp[1]);
          }
        }
      });
    }

    // Cars, then their labels outside the ring, each straight out from its own car in the
    // row assignRows gave it. A label is as wide as the widest code actually on the ring,
    // measured, rather than a guess at the widest possible.
    var labelR = outer + 18;
    var labelFont = Math.round(fontPx) + 'px ' + cond;
    ctx.font = '700 ' + labelFont;
    var labelW = 0;
    placed.forEach(function (d) {
      labelW = Math.max(labelW, ctx.measureText(code(d)).width);
    });
    labelW += fontPx * 0.3;
    var labelH = fontPx * 1.15;
    tagSpan = labelW + 4;
    var onTrack = [];
    placed.forEach(function (d) {
      var f = shown[d.num];
      var isPick = d.num === selected;
      var p = at(f, d.inPit ? g.pitR : g.R);

      ctx.beginPath();
      ctx.arc(p[0], p[1], isPick ? dot * 1.35 : dot, 0, Math.PI * 2);
      ctx.fillStyle = teamColour(d.colour);
      ctx.fill();
      ctx.lineWidth = isPick ? 3 : 2;
      ctx.strokeStyle = isPick ? ink : ground;
      ctx.stroke();
      hits.push({ num: d.num, x: p[0], y: p[1], r: Math.max(dot * 1.8, 16) });

      if (d.inPit) {
        // Inside the ring, under the car: the pit lane rarely holds more than two or
        // three at once, so these are not spread.
        var ip = at(f, g.pitR - dot - fontPx * 0.75);
        ctx.fillStyle = soft;
        ctx.font = '600 ' + Math.round(fontPx * 0.85) + 'px ' + cond;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(code(d), ip[0], ip[1]);
      } else {
        onTrack.push({ num: d.num, f: f, driver: d });
      }
    });

    // Where a label in a given (possibly fractional, mid-glide) row sits for a car at f.
    // Rows step outward by the label's own depth along the radius at that angle, which
    // varies smoothly as the car goes round, so nothing here can jump.
    function tagAt(f, row) {
      var theta = f * Math.PI * 2;
      var extent = Math.abs(Math.sin(theta)) * labelW / 2 + Math.abs(Math.cos(theta)) * labelH / 2;
      var rc = labelR + extent + row * (extent * 2 + 3);
      var c = at(f, rc);
      return { cx: c[0], cy: c[1], inner: rc - extent };
    }

    var shownTags = [];
    onTrack.forEach(function (item) {
      var t = tags[item.driver.num];
      if (t && t.alpha > 0.02) {
        shownTags.push({ item: item, t: t, box: tagAt(item.f, t.rowShown) });
      }
    });

    // Ticks first, all of them, so a tick from an outer row passes under any label nearer
    // the ring rather than across it. Each runs straight out from the car.
    shownTags.forEach(function (s) {
      var isPick = s.item.driver.num === selected;
      var from = at(s.item.f, outer + 3);
      var to = at(s.item.f, s.box.inner - 2);
      ctx.strokeStyle = isPick ? ink : teamColour(s.item.driver.colour);
      ctx.globalAlpha = s.t.alpha * (isPick ? 1 : 0.6);
      ctx.lineWidth = isPick ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    function paintTag(d, box, alpha, bold) {
      // The ground behind the text, so a tick passing beneath reads as under the label.
      ctx.fillStyle = ground;
      ctx.globalAlpha = alpha * 0.85;
      ctx.fillRect(box.cx - labelW / 2 - 2, box.cy - labelH / 2 - 1, labelW + 4, labelH + 2);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ink;
      ctx.font = (bold ? '700 ' : '600 ') + labelFont;
      ctx.fillText(code(d), box.cx, box.cy);
    }
    shownTags.forEach(function (s) {
      var d = s.item.driver;
      var isPick = d.num === selected;
      paintTag(d, s.box, s.t.alpha, isPick || d.num === hovered);
      if (isPick) {
        ctx.fillStyle = teamColour(d.colour);
        ctx.fillRect(s.box.cx - labelW / 2, s.box.cy + labelH / 2, labelW, 3);
      }
      if (s.t.alpha > 0.5) {
        hits.push({ num: d.num, x: s.box.cx, y: s.box.cy, r: labelW / 2 + 4 });
      }
    });
    ctx.globalAlpha = 1;

    // A car whose label was dropped is named while the pointer is on it: drawn on top, in
    // the first row, outlined so it reads as a call-out — and without touching anyone
    // else's label, so hovering never sets the others moving.
    var hover = onTrack.filter(function (item) { return item.driver.num === hovered; })[0];
    var hoverTag = hover && tags[hover.driver.num];
    if (hover && (!hoverTag || hoverTag.alpha < 0.5)) {
      var hb = tagAt(hover.f, 0);
      ctx.strokeStyle = soft;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(at(hover.f, outer + 3)[0], at(hover.f, outer + 3)[1]);
      ctx.lineTo(at(hover.f, hb.inner - 2)[0], at(hover.f, hb.inner - 2)[1]);
      ctx.stroke();
      paintTag(hover.driver, hb, 1, true);
      ctx.strokeRect(hb.cx - labelW / 2 - 2, hb.cy - labelH / 2 - 1, labelW + 4, labelH + 2);
    }
  }

  /* ---------- The loop ---------- */

  function advance(ts) {
    var now = clockNow();
    var want = targets(now);
    var dt = lastStep ? Math.min(ts - lastStep, 500) : 0;
    lastStep = ts;
    var ease = reducedMotion || !dt ? 1 : 1 - Math.exp(-dt / SMOOTH_MS);
    var moving = frame.rate > 0;

    Object.keys(shown).forEach(function (num) {
      if (want[num] === undefined) {
        delete shown[num];
      }
    });
    Object.keys(want).forEach(function (num) {
      if (shown[num] === undefined) {
        shown[num] = want[num];
        return;
      }
      var d = step(shown[num], want[num]);
      // A big jump is a scrub or a new session, not a car moving: snap to it.
      if (Math.abs(d) > 0.25) {
        shown[num] = want[num];
        return;
      }
      shown[num] = wrap(shown[num] + d * ease);
      if (Math.abs(d) > 1e-4) {
        moving = true;
      }
    });
    // Rows are revisited on their own slow clock, and the loop is kept alive until a frame
    // that arrived while everything was still has had its turn.
    assignRows(ts, false);
    if (easeTags(dt) || assignDue) {
      moving = true;
    }
    draw();
    return moving;
  }

  var lastPaint = 0;

  function tick(ts) {
    raf = 0;
    if (!visible || !frame) {
      return;
    }
    var moving = true;
    if (ts - lastPaint >= FRAME_MS) {
      lastPaint = ts;
      moving = advance(ts);
    }
    if (moving) {
      raf = window.requestAnimationFrame(tick);
    }
  }

  function kick() {
    if (!raf && visible) {
      raf = window.requestAnimationFrame(tick);
    }
  }

  /* ---------- Size and input ---------- */

  function resize() {
    if (!canvas) {
      return;
    }
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    layout();
    draw();
  }

  function choose(num) {
    selected = (num === null || num === selected) ? null : num;
    if (frame) {
      renderCentre();
      renderCards();
      renderStrip();
      // A click is a deliberate change, so rows answer it at once rather than on the
      // once-a-second clock: the picked car's label has to be there when you look for it.
      assignRows(performance.now(), true);
      kick();
    }
    draw();
    if (selectListener) {
      selectListener(selected);
    }
  }

  function ready() {
    if (canvas) {
      return true;
    }
    canvas = document.getElementById('live-doom');
    if (!canvas) {
      return false;
    }
    ctx = canvas.getContext('2d');
    centre = document.getElementById('doom-centre');
    strip = document.getElementById('live-stints');
    ghostsButton = document.getElementById('doom-ghosts');
    drawer = document.getElementById('stint-drawer');
    stintsButton = document.getElementById('doom-stints');
    cardsWrap = document.getElementById('doom-cards');
    cards = {
      loss: document.getElementById('doom-loss'),
      free: document.getElementById('doom-free'),
      legend: document.getElementById('doom-legend'),
      feed: document.getElementById('doom-feed')
    };

    if (window.ResizeObserver) {
      new window.ResizeObserver(resize).observe(canvas);
    } else {
      window.addEventListener('resize', resize);
    }

    /*
     * The labels are drawn in Barlow Condensed, and a webfont is only fetched once
     * something on the page uses it — a canvas asking for it does not count. So it is
     * asked for here, and the ring is laid out again when it lands (and when the page's
     * other fonts do, since they set the corner cards' heights).
     */
    if (document.fonts && document.fonts.load) {
      var relayout = function () {
        if (width) {
          resize();
        }
      };
      document.fonts.load('700 20px "Barlow Condensed"').then(relayout, function () {});
      document.fonts.ready.then(relayout, function () {});
    }

    // A free-stop chip picks its car, as a click on the ring or the tower does.
    if (cardsWrap) {
      cardsWrap.addEventListener('click', function (event) {
        var chip = event.target.closest && event.target.closest('.dk-chip');
        if (chip) {
          choose(Number(chip.dataset.num));
        }
      });
    }

    canvas.addEventListener('click', function (event) {
      var rect = canvas.getBoundingClientRect();
      var x = event.clientX - rect.left;
      var y = event.clientY - rect.top;
      var best = null;
      hits.forEach(function (h) {
        var d = Math.hypot(h.x - x, h.y - y);
        if (d <= h.r && (!best || d < best.d)) {
          best = { num: h.num, d: d };
        }
      });
      choose(best ? best.num : null);
    });
    // Hovering a car labels it, which is how a car whose label was dropped from a tight
    // bunch is still found by name.
    canvas.addEventListener('mousemove', function (event) {
      var rect = canvas.getBoundingClientRect();
      var x = event.clientX - rect.left;
      var y = event.clientY - rect.top;
      var best = null;
      hits.forEach(function (h) {
        var d = Math.hypot(h.x - x, h.y - y);
        if (d <= h.r && (!best || d < best.d)) {
          best = { num: h.num, d: d };
        }
      });
      canvas.style.cursor = best ? 'pointer' : '';
      var now = best ? best.num : null;
      if (now !== hovered) {
        hovered = now;
        draw();
      }
    });
    canvas.addEventListener('mouseleave', function () {
      if (hovered !== null) {
        hovered = null;
        draw();
      }
    });

    if (strip) {
      strip.addEventListener('click', function (event) {
        var row = event.target.closest && event.target.closest('.ss-row');
        if (row) {
          choose(Number(row.dataset.num));
        }
      });
    }

    // The stint strip is reference, not the point of the tab, so it lives in a drawer
    // over the bottom of the ring and stays out of the way until asked for.
    function openStints(open) {
      if (!drawer) {
        return;
      }
      drawer.hidden = !open;
      if (stintsButton) {
        stintsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      if (open && frame) {
        stripShown = '';
        renderStrip();
      }
    }
    if (stintsButton) {
      stintsButton.addEventListener('click', function () {
        openStints(drawer && drawer.hidden);
      });
    }
    if (drawer) {
      drawer.addEventListener('click', function (event) {
        if (event.target.closest && event.target.closest('.stint-close')) {
          openStints(false);
        }
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !drawer.hidden) {
          openStints(false);
        }
      });
    }

    if (ghostsButton) {
      ghostsButton.addEventListener('click', function () {
        allGhosts = !allGhosts;
        ghostsButton.setAttribute('aria-pressed', allGhosts ? 'true' : 'false');
        draw();
      });
    }
    return true;
  }

  /* ---------- Public ---------- */

  window.f1Doom = {
    /*
     * Every frame, whether or not the tab is showing, so switching to it is instant.
     * `options.totalLaps` for the lap count, `options.rate` for how fast the race clock
     * runs between frames: 1 live, the replay speed while playing, 0 while paused.
     */
    render: function (data, options) {
      if (!ready() || !data) {
        return;
      }
      var previous = frame;
      frame = digest(data, options || {});
      assignDue = true;
      // A new session: nothing carried over is true any more. A scrub within one is
      // handled by advance(), which snaps any car asked to jump more than a quarter lap.
      if (previous && (previous.data.session || {}).key !== (data.session || {}).key) {
        shown = {};
        tags = {};
        lastAssign = 0;
        selected = null;
      }
      if (!visible) {
        return;
      }
      renderCentre();
      renderCards();
      renderStrip();
      kick();
    },

    /* The tab was switched to (true) or away from (false). */
    show: function (on) {
      visible = !!on;
      if (!visible || !ready()) {
        return;
      }
      // Cards first: their boxes are part of what resize() lays the ring out around.
      if (frame) {
        renderCards();
      }
      resize();
      if (frame) {
        renderCentre();
        renderStrip();
      }
      lastStep = 0;
      kick();
    },

    /* From the timing tower: pick a car (or the same one again to drop it). */
    select: function (num) {
      ready();
      choose(num);
    },

    /* Told whenever the pick changes, from here or from the tower. */
    onSelect: function (listener) {
      selectListener = listener;
    }
  };
}());
