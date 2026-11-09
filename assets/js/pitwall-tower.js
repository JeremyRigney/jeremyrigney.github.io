/*
 * Pitwall: the running order. A port of Pocket Pitwall's ui/Tower.kt.
 *
 * A stack of rows rather than a table: each car its own row, its position and code large,
 * the code in its team's colour, the figure bold on the right and the tyre as the broadcast
 * shows it. P1-P10, the points places, get the larger slots, with a small break under P10;
 * the slots are fixed, so a car crossing P10 moves into a smaller slot rather than the
 * whole tower re-flowing. Rows are keyed on the car and glide to their new place, so an
 * overtake reads as two cars swapping rather than the list blinking.
 *
 * Click a row to pick that car; hold it (or right-click) to follow the driver, whose row is
 * then painted in their team's colour.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var F = P.Format;
  var UI = P.UI;

  /** How many places are points, and so get the larger slots. */
  var TOP = 10;
  var HOLD_MS = 550;

  /*
   * What the figure column shows. Races have gaps; practice and qualifying run on best laps;
   * and when the tower is too narrow for its own last-lap column, the last lap is one click
   * away on the figure chip.
   */
  var FIGURES = {
    LEADER: 'Gap to leader',
    INTERVAL: 'Interval',
    BEST: 'Best lap',
    LAST: 'Last lap'
  };

  var list = document.getElementById('tower');
  var tower = list.closest('.tower');
  var chip = document.getElementById('figure');
  var rows = {};
  var handlers = {};
  var lastHidden = false;
  var lastRender = null;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** A figure with its routine part set back: [faint, strong] as markup. */
  function split(parts, cls) {
    return (parts[0] ? '<span class="faint">' + esc(parts[0]) + '</span>' : '') +
      '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(parts[1]) + '</span>';
  }

  function set(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  function build(num) {
    var li = document.createElement('li');
    li.className = 'row';
    li.tabIndex = 0;
    li.innerHTML =
      '<span class="row-pos"></span><span class="row-bar"></span><span class="row-code"></span>' +
      '<span class="row-marks"></span><span class="row-fig"></span><span class="row-last"></span>' +
      '<span class="row-sectors"><i class="sector"></i><i class="sector"></i><i class="sector"></i></span>' +
      '<span class="row-tyre"></span>';
    li.cells = {
      pos: li.children[0],
      code: li.children[2],
      marks: li.children[3],
      fig: li.children[4],
      last: li.children[5],
      sectors: li.children[6].children,
      tyre: li.children[7]
    };
    wire(li, num);
    return li;
  }

  function wire(li, num) {
    var timer = null;
    var held = false;
    li.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) { return; }
      held = false;
      timer = setTimeout(function () {
        held = true;
        if (navigator.vibrate) { navigator.vibrate(12); }
        if (handlers.onFollow) { handlers.onFollow(num); }
      }, HOLD_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (type) {
      li.addEventListener(type, function () { clearTimeout(timer); });
    });
    li.addEventListener('click', function () {
      if (held) { held = false; return; }
      if (handlers.onPick) { handlers.onPick(num); }
    });
    li.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (handlers.onFollow) { handlers.onFollow(num); }
    });
    li.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (handlers.onPick) { handlers.onPick(num); }
      } else if (e.key === 'f' || e.key === 'F') {
        if (handlers.onFollow) { handlers.onFollow(num); }
      }
    });
  }

  /** Purple beats green: a session best is also a personal best, and only one can show. */
  function lastClass(driver, best) {
    if (F.same(driver.lastLap, best && best.lap)) { return 'is-best'; }
    if (F.same(driver.lastLap, driver.bestLap)) { return 'is-personal'; }
    return '';
  }

  /*
   * The penalty in race control's own words ("+5s" says what "P" never could), then the
   * single-letter marks for states with no value to show. The bare P is dropped once a
   * penalty has replaced it, or once it has been served.
   */
  function marks(driver) {
    var out = driver.penalty ? '<span class="mark mark-penalty">' + esc(driver.penalty) + '</span>' : '';
    driver.badges.forEach(function (badge) {
      if (badge === 'penalty' && (driver.penalty || driver.penaltyServed)) { return; }
      if (badge === 'investigation') { out += '<span class="mark mark-investigation" title="Under investigation">!</span>'; }
      if (badge === 'penalty') { out += '<span class="mark mark-p" title="Penalty">P</span>'; }
      if (badge === 'deletion') { out += '<span class="mark mark-deletion" title="Lap time deleted">D</span>'; }
    });
    return out;
  }

  function tyre(driver) {
    if (driver.inPit) { return '<span class="tyre-pit">Pit</span>'; }
    if (!driver.compound) { return '<span class="tyre-age">' + F.DASH + '</span>'; }
    return '<span class="tyre-ring" data-tyre="' + F.tyreRole(driver.compound) + '" title="' + esc(driver.compound.toLowerCase()) + '">' + esc(F.tyre(driver.compound)) + '</span>' +
      '<span class="tyre-age">' + (driver.tyreAge == null ? '' : driver.tyreAge) + '</span>';
  }

  function figureHtml(driver, figure, best) {
    switch (figure) {
      case 'LEADER': return split(F.splitGap(driver.gapToLeader));
      case 'INTERVAL': return split(F.splitGap(driver.interval));
      case 'BEST': return split(F.splitLap(driver.bestLap), F.same(driver.bestLap, best && best.lap) ? 'is-best' : '');
      default: return split(F.splitLap(driver.lastLap), lastClass(driver, best));
    }
  }

  function fill(li, driver, index, frame, opts, figure) {
    var best = frame.best;
    li.classList.toggle('is-big', index < TOP);
    li.classList.toggle('is-followed', opts.followed.has(driver.num));
    li.classList.toggle('is-picked', opts.picked === driver.num);
    li.classList.toggle('is-pit', driver.inPit);
    li.classList.toggle('is-out', driver.dnf);
    var team = F.teamColour(driver.colour);
    if (li.__team !== team) {
      if (team) { li.style.setProperty('--team', team); } else { li.style.removeProperty('--team'); }
      li.__team = team;
    }
    var c = li.cells;
    set(c.pos, driver.pos == null ? F.DASH : String(driver.pos));
    c.pos.classList.toggle('is-fastest', !!best && best.num === driver.num);
    set(c.code, esc(F.driverLabel(driver)));
    set(c.marks, marks(driver));
    set(c.fig, figureHtml(driver, figure, best));
    set(c.last, split(F.splitLap(driver.lastLap), lastClass(driver, best)));
    for (var i = 0; i < 3; i++) {
      var s = driver.sectors[i];
      var cls = 'sector';
      if (s != null) {
        if (best && F.same(s, best.sectors[i])) { cls += ' is-best'; } else if (F.same(s, driver.bestSectors[i])) { cls += ' is-personal'; } else { cls += ' is-set'; }
      }
      if (c.sectors[i].className !== cls) { c.sectors[i].className = cls; }
    }
    set(c.tyre, tyre(driver));
    UI.setAttr(li, 'title', [driver.name, driver.team].filter(Boolean).join(' · ') || null);
    UI.setAttr(li, 'aria-label', 'P' + (driver.pos == null ? '' : driver.pos) + ' ' + (driver.name || F.driverLabel(driver)));
  }

  /** Where each row is now, to glide from after the order changes. */
  function positions() {
    var out = {};
    Object.keys(rows).forEach(function (num) {
      out[num] = rows[num].getBoundingClientRect().top;
    });
    return out;
  }

  function glide(before) {
    if (UI.calm) { return; }
    var moved = [];
    Object.keys(rows).forEach(function (num) {
      if (before[num] == null) { return; }
      var dy = before[num] - rows[num].getBoundingClientRect().top;
      if (Math.abs(dy) < 1) { return; }
      var li = rows[num];
      li.style.transition = 'none';
      li.style.transform = 'translateY(' + dy + 'px)';
      moved.push(li);
    });
    if (!moved.length) { return; }
    void list.offsetHeight;
    moved.forEach(function (li) {
      li.style.transition = 'transform var(--move-ms) var(--ease), background-color 160ms ease';
      li.style.transform = '';
    });
  }

  function figuresFor(drivers) {
    var hasGaps = drivers.some(function (d) { return d.gapToLeader != null; });
    var figures = hasGaps ? ['LEADER', 'INTERVAL'] : ['BEST'];
    if (lastHidden) { figures.push('LAST'); }
    return { hasGaps: hasGaps, list: figures };
  }

  function figureFor(gapMode, figures) {
    if (gapMode === 'LAST') { return lastHidden ? 'LAST' : figures.list[0]; }
    if (gapMode === 'INTERVAL') { return figures.hasGaps ? 'INTERVAL' : 'BEST'; }
    return figures.hasGaps ? 'LEADER' : 'BEST';
  }

  function head(figure, figures, empty) {
    var choice = figures.list.length > 1 && !empty;
    chip.hidden = !choice;
    UI.show('figureLabel', !choice && !empty);
    if (choice) {
      if (chip.textContent !== FIGURES[figure]) { chip.textContent = FIGURES[figure]; }
      var next = figures.list[(figures.list.indexOf(figure) + 1) % figures.list.length];
      chip.dataset.next = next === 'BEST' ? 'LEADER' : next;
      chip.setAttribute('aria-label', 'Showing ' + FIGURES[figure].toLowerCase() + '; show ' + FIGURES[next].toLowerCase());
    } else {
      UI.text('figureLabel', FIGURES[figure]);
    }
  }

  /**
   * Draw the order for a frame (null for none). opts: {followed: Set, picked, gapMode}.
   */
  function render(frame, opts) {
    lastRender = [frame, opts];
    var drivers = frame ? frame.drivers : [];
    tower.classList.toggle('has-rows', drivers.length > 0);

    var before = positions();
    var keep = {};
    drivers.forEach(function (d) { keep[d.num] = true; });
    Object.keys(rows).forEach(function (num) {
      if (!keep[num]) {
        rows[num].remove();
        delete rows[num];
      }
    });

    var figures = figuresFor(drivers);
    var figure = figureFor(opts.gapMode, figures);
    drivers.forEach(function (d, index) {
      var li = rows[d.num] || (rows[d.num] = build(d.num));
      if (list.children[index] !== li) { list.insertBefore(li, list.children[index] || null); }
      fill(li, d, index, frame, opts, figure);
    });
    head(figure, figures, drivers.length === 0);
    glide(before);

    // Whether the last-lap column has left for want of room, which puts it on the chip.
    var sample = list.querySelector('.row-last');
    var hidden = !!sample && getComputedStyle(sample).display === 'none';
    if (hidden !== lastHidden) {
      lastHidden = hidden;
      render(frame, opts);
      return;
    }
    // Only a window too short for the smallest slots scrolls.
    list.classList.toggle('is-scrolling', list.scrollHeight > list.clientHeight + 1);
  }

  chip.addEventListener('click', function () {
    if (handlers.onGapMode) { handlers.onGapMode(chip.dataset.next); }
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () {
      if (lastRender) { render(lastRender[0], lastRender[1]); }
    }).observe(tower);
  }

  P.Tower = {
    render: render,
    on: function (h) { handlers = h; }
  };
}());
