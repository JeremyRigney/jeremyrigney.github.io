/*
 * Pitwall: the sign-in screen. A deterrent, not security.
 *
 * Replays are open to anyone. The live wall is what costs: its stream and polling keep the
 * timing API's Cloud Run instance busy for a whole session. So from a day before a session
 * until it's over (Pitwall.Calendar.liveSoon), live needs signing in first, and until then
 * the live feed never starts. The app decides when to ask (Pitwall.Gate.ask); the screen
 * offers the replays instead.
 *
 * The page is static, so the check runs in the browser, and anyone who reads the source can
 * get past it. It keeps no password, only a SHA-256 of "username:password", and the browser
 * remembers a successful sign-in until Sign out in Settings. Loaded first in the page,
 * straight after its element.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  /** SHA-256 of "username:password", as hex. */
  var PASS = '03404adc2d7b98a079fd878344e7557951e8a9ea50cea52f24206933f8bd68f1';
  var KEY = 'pitwall.gate';

  var root = document.documentElement;
  var el = document.querySelector('.gate');
  var open;
  var ready = new Promise(function (resolve) { open = resolve; });

  function remembered() {
    try {
      return window.localStorage.getItem(KEY) === PASS;
    } catch (e) {
      return false;
    }
  }

  function remember(on) {
    try {
      if (on) { window.localStorage.setItem(KEY, PASS); } else { window.localStorage.removeItem(KEY); }
    } catch (e) {
      // Not remembered: the next visit asks again.
    }
  }

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  var form = el ? el.querySelector('form') : null;
  var asked = false;

  function unlock() {
    P.Gate.unlocked = true;
    show(false);
    open();
  }

  function show(on) {
    asked = on;
    if (!el) { return; }
    var was = !el.hidden;
    el.hidden = !on;
    if (on) { root.setAttribute('data-locked', ''); } else { root.removeAttribute('data-locked'); }
    if (on && !was) { form.querySelector('[name="username"]').focus(); }
  }

  var onReplay = null;

  P.Gate = {
    unlocked: false,
    /** Settles once signed in: the live feed starts from here. */
    ready: ready,
    /** Show the screen (live, near a session) or put it away; replay() runs on "Replays instead". */
    ask: function (on, replay) {
      if (P.Gate.unlocked) { return; }
      onReplay = replay || onReplay;
      if (on !== asked) { show(on); }
    },
    /** Forget this browser, and ask again. */
    signOut: function () {
      remember(false);
      window.location.reload();
    }
  };

  if (remembered()) {
    unlock();
    return;
  }
  if (!el) { return; }

  var user = form.querySelector('[name="username"]');
  var pass = form.querySelector('[name="password"]');
  var note = el.querySelector('.gate-note');

  el.querySelector('.gate-replay').addEventListener('click', function () {
    show(false);
    if (onReplay) { onReplay(); }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!window.crypto || !window.crypto.subtle) {
      note.textContent = 'This page needs a secure (https) connection to sign in.';
      return;
    }
    var bytes = new TextEncoder().encode(user.value.trim() + ':' + pass.value);
    window.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
      if (hex(digest) === PASS) {
        remember(true);
        unlock();
      } else {
        note.textContent = 'That username and password don’t match.';
        pass.value = '';
        pass.focus();
      }
    });
  });
}());
