/*
 * Pitwall: Server-Sent Events from /f1/stream, a line at a time. A port of Pocket
 * Pitwall's data/Sse.kt.
 *
 * `event:` names the next event, `data:` lines carry it, and a blank line sends it. Comment
 * lines (": ping") and `retry:` are ignored. The page reads the stream through fetch rather
 * than EventSource: EventSource reconnects by itself every few seconds after the server
 * closes an idle stream, and can't tell a refusal (503, all streams taken) from a network
 * failure. Pure, so the framing is tested without a connection.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  function Parser() {
    this.event = null;
    this.data = [];
    this.buffer = '';
  }

  /** Feed one line, without its line ending; returns [event, data] when a blank line completes one. */
  Parser.prototype.feed = function (line) {
    var text = line.charAt(line.length - 1) === '\r' ? line.slice(0, -1) : line;
    if (text === '') {
      var name = this.event || 'message';
      var body = this.data.join('\n');
      this.event = null;
      this.data = [];
      return body === '' && name === 'message' ? null : [name, body];
    }
    if (text.charAt(0) === ':') { return null; }
    var colon = text.indexOf(':');
    var field = colon < 0 ? text : text.slice(0, colon);
    var value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.charAt(0) === ' ') { value = value.slice(1); }
    if (field === 'event') {
      this.event = value;
    } else if (field === 'data') {
      this.data.push(value);
    }
    return null;
  };

  /** Feed a chunk as it arrives off the wire, split anywhere; returns the events it completes. */
  Parser.prototype.push = function (chunk) {
    var out = [];
    this.buffer += chunk;
    var newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      var line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      var done = this.feed(line);
      if (done) { out.push(done); }
    }
    return out;
  };

  /** An event as the wall uses it, or null for one it doesn't know. */
  function decode(name, data) {
    switch (name) {
      case 'frame': return { type: 'frame', frame: P.Parse.frame(data) };
      case 'cars': return { type: 'cars', batch: P.Parse.cars(data) };
      case 'idle': return { type: 'idle', frame: P.Parse.frame(data) };
      case 'bye': return { type: 'bye' };
      case 'ping': return { type: 'ping' };
      default: return null;
    }
  }

  P.Sse = {
    Parser: Parser,
    decode: decode
  };
}());
