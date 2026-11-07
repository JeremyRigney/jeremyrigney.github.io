/*
 * Pitwall: between sessions, a poster. A port of the standby screen in Pocket Pitwall's
 * ui/WallScreen.kt (Empty, Poster, WeekendStrip) and ui/Backdrop.kt.
 *
 * The photograph of where the next session is fills the page behind everything, darkened
 * under the header and across the foot and left clear through the middle. Over its foot:
 * what's next and when, in the reader's own time, the event and the place, then the
 * countdown as the biggest thing on the screen, ticking each second and amber in its last
 * hour, the weekend's sessions as a strip, and three things to do while waiting: replay a
 * past session, put the weekend in a calendar, or be reminded an hour before.
 */
(function () {
  'use strict';

  var P = window.Pitwall;
  var F = P.Format;
  var UI = P.UI;

  var section = document.getElementById('standby');
  var photo = document.querySelector('.backdrop');
  var strip = document.getElementById('weekend');
  var credit = document.querySelector('[data-bind="photoCredit"]');
  var remind = document.getElementById('poster-remind');
  var handlers = {};
  var shown = null;
  var ticking = null;
  var loaded = null;

  var dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
  var dateFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** The photograph, once it has loaded, so it fades in rather than drawing down the page. */
  function backdrop(b) {
    var url = b ? b.url : null;
    if (url === loaded) { return; }
    loaded = url;
    photo.removeAttribute('data-loaded');
    if (!url) { return; }
    var img = new Image();
    img.onload = function () {
      if (loaded !== url) { return; }
      photo.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
      // A screen shows a slice of a picture of another shape: centred on its landmark.
      photo.style.backgroundPosition = (b.focus * 100).toFixed(0) + '% ' + (b.focusY * 100).toFixed(0) + '%';
      photo.setAttribute('data-loaded', '');
    };
    img.src = url;
  }

  /** The countdown and the strip, each second. */
  function tick() {
    if (!shown) { return; }
    var now = Date.now();
    var next = shown.next;
    var left = next.start - now;
    var total = Math.max(0, Math.floor(left / 1000));
    var days = Math.floor(total / 86400);
    var clock = section.querySelector('.countdown-clock');
    var starting = left <= 0;
    clock.hidden = starting;
    section.querySelector('.countdown-now').hidden = !starting;
    UI.setAttr(section.querySelector('.countdown'), 'data-soon', left < 3600000 ? '' : null);
    UI.show('nextDays', days > 0 && !starting);
    UI.text('nextDays', days === 1 ? '1 day' : days + ' days');
    UI.text('nextH', pad2(Math.floor(total % 86400 / 3600)));
    UI.text('nextM', pad2(Math.floor(total % 3600 / 60)));
    UI.text('nextS', pad2(total % 60));
    var chips = P.Weekend.strip(shown.weekend, now).slice(-6);
    var html = chips.length > 1 ? chips.map(function (c) {
      var done = c.state === 'DONE';
      return '<li class="weekend-chip" data-state="' + c.state.toLowerCase() + '"' + (c.state === 'NEXT' ? ' aria-current="true"' : '') + '>' +
        '<span>' + esc(c.start != null ? dayFormat.format(c.start) : '') + '</span>' +
        '<b>' + esc(c.label) + '</b>' +
        '<span>' + (done ? '<span aria-label="Done">✓</span>' : esc(F.clock(c.start))) + '</span></li>';
    }).join('') : '';
    if (strip.__html !== html) {
      strip.innerHTML = html;
      strip.__html = html;
    }
    strip.hidden = !html;
    clearTimeout(ticking);
    ticking = setTimeout(tick, 1000 - Date.now() % 1000 + 5);
  }

  /**
   * The poster, or none: c.shown, and with it c.next (the session), c.weekend (all of its
   * meeting's sessions), c.backdrop (or null) and c.remind ({on, note}).
   */
  function render(c) {
    var on = !!(c.shown && c.next);
    section.hidden = !on;
    document.documentElement.toggleAttribute('data-standby', on);
    backdrop(on ? c.backdrop : null);
    if (!on) {
      shown = null;
      clearTimeout(ticking);
      return;
    }
    var next = c.next;
    UI.text('nextWhen', [next.name || 'Session', dateFormat.format(next.start), F.clock(next.start)].join(' · '));
    UI.text('nextEvent', F.event(next) || 'Formula 1');
    UI.text('nextPlace', F.place(next) || next.country || '');
    var b = c.backdrop;
    credit.hidden = !b;
    if (b) {
      UI.text('photoCredit', b.caption);
      if (b.page) { credit.href = b.page; } else { credit.removeAttribute('href'); }
    }
    remind.setAttribute('aria-pressed', c.remind.on ? 'true' : 'false');
    remind.textContent = c.remind.on ? 'Reminders on' : 'Remind me an hour before';
    UI.text('posterNote', c.remind.note || '');
    var again = !shown || shown.next !== next || shown.weekend !== c.weekend;
    shown = { next: next, weekend: c.weekend };
    if (again) { tick(); }
  }

  document.getElementById('poster-replay').addEventListener('click', function () {
    if (handlers.onReplay) { handlers.onReplay(); }
  });
  document.getElementById('poster-ics').addEventListener('click', function () {
    if (handlers.onIcs) { handlers.onIcs(); }
  });
  remind.addEventListener('click', function () {
    if (handlers.onRemind) { handlers.onRemind(); }
  });

  P.Standby = {
    render: render,
    on: function (h) { handlers = h; }
  };
}());
