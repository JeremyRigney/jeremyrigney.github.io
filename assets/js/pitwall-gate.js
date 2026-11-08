/*
 * Pitwall: the sign-in screen. A deterrent, not security.
 *
 * The page is static, so the check runs in the browser, and anyone who reads the source can
 * get past it. What it does is stop someone who just lands here from starting the wall, and
 * with it the timing API's live stream and polling, which cost Cloud Run time. Until the
 * gate opens, nothing on the page asks the API for anything: the wall's start and the intro
 * both wait on Pitwall.Gate.ready.
 *
 * The page keeps no password, only a SHA-256 of "username:password", and the browser
 * remembers a successful sign-in until Sign out in Settings. Loaded first in the page,
 * straight after its element, so nothing of the wall shows before it.
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

  function unlock() {
    P.Gate.unlocked = true;
    root.removeAttribute('data-locked');
    if (el) { el.remove(); }
    open();
  }

  P.Gate = {
    unlocked: false,
    /** Settles once signed in; everything that reaches the API starts from here. */
    ready: ready,
    /** Forget this browser, and ask again. */
    signOut: function () {
      remember(false);
      window.location.reload();
    }
  };

  if (remembered() || !el) {
    unlock();
    return;
  }

  root.setAttribute('data-locked', '');
  el.hidden = false;
  var form = el.querySelector('form');
  var user = form.querySelector('[name="username"]');
  var pass = form.querySelector('[name="password"]');
  var note = el.querySelector('.gate-note');
  user.focus();

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
