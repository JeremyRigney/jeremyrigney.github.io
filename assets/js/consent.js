/*
 * jeremy.ie — cookie consent, and Google Consent Mode v2 (advanced).
 *
 * Google Analytics is the only thing on the site that sets cookies, so this replaces a
 * third-party consent platform with one small card. It has to load synchronously, ahead
 * of the gtag snippet: the consent defaults must be on the dataLayer before
 * gtag('config') or the first hit goes out without them.
 *
 * Advanced mode: gtag.js always loads, but every storage type starts denied, so until a
 * visitor says yes GA sends only cookieless pings and writes nothing. The ad types stay
 * denied for good (there are no ads here); they are still declared because v2 expects
 * all four.
 *
 * The choice lives in localStorage. Storing it needs no consent of its own, since it is
 * the record of the answer. If storage is unavailable the defaults hold, and the card
 * asks again on the next page. An answer is kept for six months, then asked for again,
 * in line with the Irish DPC's cookie guidance.
 *
 * The card waits a moment so it does not fight the first paint or the home intro, sits
 * small in the corner, and leaves as soon as it is answered. Ignoring it is the same as
 * no. Its "Details" link goes to /privacy, which says who gets what. Any element with data-consent-open (the footer's "Cookie settings") brings it back.
 */
(function () {
  'use strict';

  var KEY = 'jr-consent';
  var VERSION = 1; // bump to ask everyone again if what is being asked for changes
  var MAX_AGE = 183 * 24 * 60 * 60 * 1000; // six months
  var DELAY = 1200;
  var LEAVE_MS = 300;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied'
  });

  function read() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(KEY));
      if (saved && saved.v === VERSION && Date.now() - saved.t < MAX_AGE &&
          (saved.analytics === 'granted' || saved.analytics === 'denied')) {
        return saved.analytics;
      }
    } catch (e) { /* unreadable or blocked: treat as unanswered */ }
    return null;
  }

  function save(value) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ v: VERSION, analytics: value, t: Date.now() }));
    } catch (e) { /* the defaults still hold */ }
  }

  var choice = read();
  if (choice === 'granted') {
    // Before the page's own gtag('config'), so a returning visitor's first hit counts.
    gtag('consent', 'update', { analytics_storage: 'granted' });
  }

  // GA's cookies outlive a change of mind unless they are removed.
  function clearAnalyticsCookies() {
    var host = location.hostname;
    var domains = ['', host, '.' + host.replace(/^www\./, '')];
    document.cookie.split(';').forEach(function (pair) {
      var name = pair.split('=')[0].trim();
      if (name !== '_ga' && name.indexOf('_ga_') !== 0) { return; }
      domains.forEach(function (d) {
        document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  function decide(value) {
    var was = choice;
    choice = value;
    save(value);
    gtag('consent', 'update', { analytics_storage: value });
    if (value === 'denied' && was === 'granted') { clearAnalyticsCookies(); }
    hide();
  }

  var card = null;

  function build() {
    var el = document.createElement('div');
    el.id = 'jr-consent';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Cookie consent');
    el.innerHTML =
      '<p class="jr-consent-text">Google Analytics cookies, to see what gets read? ' +
        '<a href="/privacy">Details</a></p>' +
      '<div class="jr-consent-actions">' +
        '<button type="button" data-value="granted">Yes</button>' +
        '<button type="button" data-value="denied">No</button>' +
      '</div>';
    el.addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-value]');
      if (btn) { decide(btn.getAttribute('data-value')); }
    });
    return el;
  }

  function show() {
    if (card) { return; }
    card = build();
    var buttons = card.querySelectorAll('button[data-value]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-value') === choice ? 'true' : 'false');
    }
    document.body.appendChild(card);
    // Two frames, so the starting state is painted before the transition to the end one.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (card) { card.classList.add('is-in'); }
      });
    });
  }

  function hide() {
    if (!card) { return; }
    var leaving = card;
    card = null;
    leaving.classList.remove('is-in');
    window.setTimeout(function () {
      if (leaving.parentNode) { leaving.parentNode.removeChild(leaving); }
    }, LEAVE_MS);
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest && event.target.closest('[data-consent-open]');
    if (!opener) { return; }
    event.preventDefault();
    show();
  });

  function start() {
    if (choice === null) { window.setTimeout(show, DELAY); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
