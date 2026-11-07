/*
 * Pitwall: sound — team radio clips, and the voice that says the flags out loud. The
 * player half of Pocket Pitwall's wall/Radio.kt, and wall/Voice.kt.
 *
 * Browsers won't play sound a page hasn't been given a click for, so the first click
 * anywhere on the page unlocks it: a silent sample through the one <audio> element radio
 * uses, and a resumed audio context for the voice's tone. Until then the settings say so.
 *
 * The voice is the browser's speech synthesis in UK English: a short tone, then the words
 * 120 ms later. Only voices that run on this computer are offered, because an online voice
 * waits on a server before speaking, and that would cost the head start set with the delay.
 */
(function () {
  'use strict';

  var P = window.Pitwall = window.Pitwall || {};

  // A single silent sample. Playing this under a real click is what unlocks the element for
  // every later clip, without any audible artefact.
  var SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  var TONE_MS = 260;

  var audio = new Audio();
  audio.preload = 'auto';
  var unlocked = false;
  var context = null;
  var listeners = [];

  function changed() {
    listeners.forEach(function (fn) { fn(); });
  }

  function unlock() {
    if (unlocked) { return; }
    audio.src = SILENCE;
    var played = audio.play();
    if (played && played.then) {
      played.then(function () {
        unlocked = true;
        changed();
      }, function () {});
    } else {
      unlocked = true;
    }
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !context) { context = new Ctx(); }
      if (context && context.state === 'suspended') { context.resume(); }
    } catch (e) {
      context = null;
    }
  }

  ['pointerdown', 'keydown'].forEach(function (type) {
    document.addEventListener(type, unlock, { capture: true });
  });

  // ---------- Radio ----------

  /** The player Radio drives: play(url, done) calls done once, however the clip ends. */
  var current = null;
  var player = {
    play: function (url, done) {
      player.stop();
      var finished = false;
      function finish() {
        if (finished) { return; }
        finished = true;
        audio.onended = null;
        audio.onerror = null;
        current = null;
        done();
      }
      current = finish;
      audio.onended = finish;
      // A clip that 404s is one bad file, not a reason to stop the radio.
      audio.onerror = finish;
      audio.src = url;
      var played = audio.play();
      if (played && played.catch) {
        played.catch(function (e) {
          // Only a refusal to play means sound is blocked; anything else is one bad clip.
          if (e && e.name === 'NotAllowedError') {
            unlocked = false;
            changed();
          }
          finish();
        });
      }
    },
    stop: function () {
      audio.pause();
      if (current) {
        var finish = current;
        current = null;
        audio.onended = null;
        audio.onerror = null;
        finish();
      }
    }
  };

  // ---------- The voice ----------

  function voices() {
    if (!window.speechSynthesis) { return []; }
    return window.speechSynthesis.getVoices().filter(function (v) {
      return /^en[-_]GB$/i.test(v.lang) && v.localService;
    }).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  }

  if (window.speechSynthesis && 'onvoiceschanged' in window.speechSynthesis) {
    window.speechSynthesis.addEventListener('voiceschanged', changed);
  }

  function tone() {
    if (!context) { return; }
    try {
      var osc = context.createOscillator();
      var gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      var t = context.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + TONE_MS / 1000);
      osc.connect(gain).connect(context.destination);
      osc.start(t);
      osc.stop(t + TONE_MS / 1000 + 0.02);
    } catch (e) {
      // No tone; the words still come.
    }
  }

  /** A tone, then the words, in the chosen UK voice; anything still being said is cut off. */
  function say(words, voiceName) {
    if (!window.speechSynthesis) { return; }
    tone();
    setTimeout(function () {
      var u = new SpeechSynthesisUtterance(words);
      u.lang = 'en-GB';
      u.rate = 1.05;
      var v = voices().filter(function (x) { return x.name === voiceName; })[0] || voices()[0];
      if (v) { u.voice = v; }
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }, TONE_MS + 120);
  }

  P.Audio = {
    player: player,
    say: say,
    voices: voices,
    canSpeak: !!window.speechSynthesis,
    unlocked: function () { return unlocked; },
    unlock: unlock,
    onChange: function (fn) { listeners.push(fn); },
    position: function () { return audio.currentTime || 0; },
    duration: function () { return isFinite(audio.duration) ? audio.duration : null; }
  };
}());
