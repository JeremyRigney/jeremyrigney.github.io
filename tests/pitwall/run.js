/*
 * Pitwall's tests, run from the repo root with macOS's JavaScriptCore shell (there is no
 * node on this machine):
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tests/pitwall/run.js
 *
 * It loads the wall's pure modules, which never touch the page, then every suite listed
 * below (jsc can't list a directory), and prints each failure and a last line of
 * "ALL PASS (n)" or "FAIL (k of n)". Read that line rather than jsc's exit status.
 *
 * Most cases are Pocket Pitwall's own unit tests (f1_app/app/src/test/), ported with their
 * fixtures, so the web wall is held to the same behaviour as the app.
 */
var window = this;

var MODULES = [
  'assets/js/pitwall-format.js',
  'assets/js/pitwall-parse.js',
  'assets/js/pitwall-season.js',
  'assets/js/pitwall-sse.js',
  'assets/js/pitwall-live.js',
  'assets/js/pitwall-replay.js',
  'assets/js/pitwall-track.js'
];

var SUITES = [
  'tests/pitwall/fake-time.js',
  'tests/pitwall/format.test.js',
  'tests/pitwall/parse.test.js',
  'tests/pitwall/season.test.js',
  'tests/pitwall/live.test.js',
  'tests/pitwall/stream.test.js',
  'tests/pitwall/replay.test.js',
  'tests/pitwall/map.test.js',
  'tests/pitwall/lint.test.js'
];

var TESTS = [];
var SUITE = '';

function test(name, fn) {
  TESTS.push({ name: SUITE + ' › ' + name, fn: fn });
}

function show(v) {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

function eq(actual, expected, label) {
  if (show(actual) !== show(expected)) {
    throw new Error((label ? label + ': ' : '') + 'expected ' + show(expected) + ', got ' + show(actual));
  }
}

function near(actual, expected, tolerance, label) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error((label ? label + ': ' : '') + 'expected ' + expected + ' ± ' + tolerance + ', got ' + show(actual));
  }
}

function ok(value, label) {
  if (!value) { throw new Error(label || 'expected true'); }
}

function no(value, label) {
  if (value) { throw new Error(label || 'expected false'); }
}

function isNull(value, label) {
  if (value != null) { throw new Error((label ? label + ': ' : '') + 'expected null, got ' + show(value)); }
}

function notNull(value, label) {
  if (value == null) { throw new Error((label ? label + ': ' : '') + 'expected a value'); }
}

function fixture(name) {
  return readFile('tests/pitwall/fixtures/' + name);
}

function asset(name) {
  return readFile('assets/data/f1/' + name);
}

MODULES.forEach(function (path) { load(path); });
SUITES.forEach(function (path) {
  SUITE = path.replace(/^.*\//, '').replace(/\.test\.js$/, '');
  load(path);
});

var failures = 0;
TESTS.forEach(function (t) {
  try {
    var result = t.fn();
    if (result && typeof result.then === 'function') {
      var settled = false;
      var error = null;
      result.then(function () { settled = true; }, function (e) { settled = true; error = e; });
      drainMicrotasks();
      if (!settled) { throw new Error('async test never settled'); }
      if (error) { throw error; }
    }
  } catch (e) {
    failures += 1;
    print('FAIL ' + t.name + '\n     ' + (e && e.message ? e.message : e));
  }
});

print(failures ? 'FAIL (' + failures + ' of ' + TESTS.length + ')' : 'ALL PASS (' + TESTS.length + ')');
