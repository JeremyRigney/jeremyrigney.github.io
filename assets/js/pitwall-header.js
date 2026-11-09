/*
 * Pitwall: the top of the wall — the session's name, and the capsule with the flag, the
 * lap, the fastest lap and whether the wall is live. A port of Pocket Pitwall's
 * ui/StatusBar.kt.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};
  var F = P.Format;
  var UI = P.UI;

  function title(session) {
    if (!session) { return ''; }
    return [F.eventAndPlace(session), F.sessionShort(session.name)].filter(Boolean).join(' · ');
  }

  /** The lap, out of the grand prix's length when that is known, and its last one marked. */
  function lap(frame, totalLaps) {
    var current = frame ? frame.lap : null;
    var finished = !!(frame && frame.flag && frame.flag.state === 'CHEQUERED');
    UI.text('lap', current == null ? F.DASH : current);
    UI.text('lapOf', current != null && totalLaps != null ? '/' + totalLaps : '');
    var left = current != null && totalLaps != null ? totalLaps - current : -1;
    var sub = UI.text('lapSub', finished ? 'Finished' : left === 0 ? 'Final lap' : '');
    if (sub) { sub.classList.toggle('is-final', left === 0 && !finished); }
  }

  function fastest(frame) {
    var best = frame && frame.best;
    var who = best && best.num != null ? frame.byNumber[best.num] : null;
    UI.text('fastestTime', best && best.lap != null ? F.lapTime(best.lap) : F.DASH);
    var el = UI.text('fastestWho', who ? F.driverLabel(who) : '');
    if (el) {
      var colour = who ? F.teamColour(who.colour) : null;
      if (colour) { el.style.setProperty('--team', colour); } else { el.style.removeProperty('--team'); }
    }
    UI.show('rain', !!(frame && frame.weather && frame.weather.rain));
  }

  /*
   * badge: {tag, tone, clock, delay} — the wall's state ("Live", "Stale", "No session"…), its
   * tone (live, warn, quiet, demo), the drawn frame's own time, and the delay, which shows
   * whatever the state: a wall held back on purpose can't be mistaken for a stuck one, and
   * a delay left over from the last race is in plain sight before this one starts.
   */
  function badge(b) {
    UI.text('badgeTag', b.tag);
    UI.text('badgeClock', b.clock || '');
    UI.text('badgeDelay', b.delay || '');
    UI.setAttr(document.querySelector('.cap-badge'), 'data-tone', b.tone);
  }

  /**
   * Draw the header for a frame, or for no frame at all (standby): the flag's colour goes on
   * the root, where the block, the word and the wash all read it.
   */
  function render(frame, ctx) {
    var state = frame ? (frame.flag ? frame.flag.state : 'GREEN') : null;
    UI.setAttr(document.documentElement, 'data-flag', state);
    UI.text('flagMark', state && F.FLAGS[state].mark ? F.FLAGS[state].mark : '');
    UI.text('flagWord', F.flagWord(state));
    UI.text('flagNote', frame ? F.flagNote(frame.flag) : ctx.standbyNote || '');
    UI.text('title', title(frame && frame.session));
    lap(frame, ctx.totalLaps);
    fastest(frame);
    badge(ctx.badge);
  }

  P.Header = {
    render: render,
    title: title
  };
}());
