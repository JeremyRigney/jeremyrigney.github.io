/*
 * Parse every Pitwall script without running it, the DOM ones included, which the tests
 * can't load. From the repo root:
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tests/pitwall/parse-check.js
 */
var FILES = [
  'pitwall-intro.js',
  'pitwall-format.js',
  'pitwall-parse.js',
  'pitwall-season.js',
  'pitwall-sse.js',
  'pitwall-live.js',
  'pitwall-replay.js',
  'pitwall-track.js',
  'pitwall-doom.js',
  'pitwall-alerts.js',
  'pitwall-ui.js',
  'pitwall-net.js',
  'pitwall-header.js',
  'pitwall-tower.js',
  'pitwall-timeline.js',
  'pitwall-map.js',
  'pitwall-ring.js',
  'pitwall-audio.js',
  'pitwall-feed.js',
  'pitwall-driver.js',
  'pitwall-standby.js',
  'pitwall-app.js'
];

var bad = 0;
FILES.forEach(function (name) {
  try {
    new Function(readFile('assets/js/' + name));
  } catch (e) {
    bad += 1;
    print('FAIL ' + name + ': ' + e);
  }
});
print(bad ? 'PARSE FAIL (' + bad + ')' : 'PARSE OK (' + FILES.length + ')');
