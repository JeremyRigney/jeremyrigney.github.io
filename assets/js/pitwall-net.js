/*
 * Pitwall: the timing API and the site's own data files. A port of Pocket Pitwall's
 * data/Api.kt.
 *
 * The API is the site's Cloud Run service (f1_live.py), which keeps the OpenF1 account on
 * the server; CORS is open, so the page calls it directly.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  var DEFAULT_API = 'https://irishrail-api-737590149980.europe-west1.run.app';
  // Live polls and the session list answer quickly; a replay's first frame can take a while,
  // because the server pulls the whole session before it answers.
  var TIMEOUT_LIVE = 15000;
  var TIMEOUT_REPLAY = 120000;

  /*
   * A local API, for developing against the Flask server on this machine. Restricted to
   * loopback on purpose: an arbitrary origin here would let a crafted link feed the page its
   * content from somewhere else entirely. The same rule as the old wall's.
   */
  function apiBase() {
    var override = new URLSearchParams(window.location.search).get('api');
    if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override)) {
      return override.replace(/\/$/, '');
    }
    return DEFAULT_API;
  }

  /**
   * GET some JSON. A 502 from the API still carries a JSON body ({live: false, error}),
   * which the caller reads as an upstream failure, so the body is returned whatever the
   * status, as long as it is JSON.
   */
  function getJson(url, timeout) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeout || TIMEOUT_LIVE) : null;
    return fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (response) {
        return response.json().catch(function () {
          throw new Error('HTTP ' + response.status);
        });
      })
      .finally(function () { clearTimeout(timer); });
  }

  function api(path, timeout) {
    return getJson(apiBase() + path, timeout);
  }

  /** One frame of /f1/live, parsed. */
  function live() {
    return api('/f1/live', TIMEOUT_LIVE).then(P.Parse.frame);
  }

  /*
   * /f1/stream, read through fetch: each chunk goes through the SSE parser and each event
   * the wall knows reaches onEvent; onEnd(error) comes once, when the server closes it
   * (error null), or it is refused or drops (an Error). A 503 means the server's few stream
   * slots are taken. Closing it from this side calls neither.
   */
  function stream(handlers) {
    var controller = new AbortController();
    var closed = false;

    function deliver(pairs) {
      pairs.forEach(function (pair) {
        var ev = P.Sse.decode(pair[0], pair[1]);
        if (ev && !closed) { handlers.onEvent(ev); }
      });
    }

    fetch(apiBase() + '/f1/stream', {
      cache: 'no-store',
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok || !response.body) { throw new Error('HTTP ' + response.status); }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var parser = new P.Sse.Parser();
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            deliver(parser.push(decoder.decode() + '\n'));
            return;
          }
          deliver(parser.push(decoder.decode(chunk.value, { stream: true })));
          return pump();
        });
      }
      return pump();
    }).then(function () {
      if (!closed) { handlers.onEnd(null); }
    }, function (error) {
      if (!closed) { handlers.onEnd(error || new Error('stream failed')); }
    });

    return {
      close: function () {
        closed = true;
        controller.abort();
      }
    };
  }

  /*
   * The stream, one per browser. The server holds only a few open at once, and the app
   * needs one, so a second tab of this page doesn't take another: it polls instead, and
   * picks the stream up when the tab holding it lets go. Without Web Locks, every tab
   * streams.
   */
  function openStream(handlers) {
    if (!navigator.locks || typeof navigator.locks.request !== 'function') { return stream(handlers); }
    var connection = null;
    var release = null;
    var closed = false;
    navigator.locks.request('pitwall-stream', { ifAvailable: true }, function (lock) {
      if (!lock) {
        if (!closed) { handlers.onEnd(new Error('another tab has the stream')); }
        return null;
      }
      return new Promise(function (resolve) {
        release = resolve;
        if (closed) {
          resolve();
          return;
        }
        connection = stream({
          onEvent: handlers.onEvent,
          onEnd: function (error) {
            resolve();
            handlers.onEnd(error);
          }
        });
      });
    }).catch(function (error) {
      if (!closed) { handlers.onEnd(error); }
    });
    return {
      close: function () {
        closed = true;
        if (connection) { connection.close(); }
        if (release) { release(); }
      }
    };
  }

  /** A file under assets/data/f1/, or null when the site doesn't have it. */
  function data(name, version) {
    return fetch('assets/data/f1/' + name + (version ? '?v=' + version : ''))
      .then(function (response) { return response.ok ? response.json() : null; })
      .catch(function () { return null; });
  }

  P.Net = {
    apiBase: apiBase,
    getJson: getJson,
    api: api,
    live: live,
    stream: stream,
    openStream: openStream,
    data: data,
    TIMEOUT_REPLAY: TIMEOUT_REPLAY
  };
}());
