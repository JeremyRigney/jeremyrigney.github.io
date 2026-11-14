/*
 * /aurora's tests, for the modules that are numbers and never touch the page. From the
 * repo root, with macOS's JavaScriptCore shell or with node:
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tests/aurora/run.js
 *   node tests/aurora/run.js
 *
 * It loads the modules, then every suite listed below, and prints each failure and a last
 * line of "ALL PASS (n)" or "FAIL (k of n)". Read that line rather than the exit status.
 * The helpers are tests/pitwall/run.js's.
 */
var G = typeof globalThis !== 'undefined' ? globalThis : this;
if (typeof load === 'undefined') {
  // node: give it jsc's two globals.
  G.load = function (path) { require('vm').runInThisContext(require('fs').readFileSync(path, 'utf8'), { filename: path }); };
  G.print = function (line) { console.log(line); };
}
G.window = G;

var MODULES = [
  'assets/js/aurora-geo.js',
  'assets/js/aurora-wind.js',
  'assets/js/aurora-sun.js'
];

var SUITES = [
  'tests/aurora/wind.test.js',
  'tests/aurora/sun.test.js'
];

var TESTS = [];
var SUITE = '';

G.test = function (name, fn) {
  TESTS.push({ name: SUITE + ' › ' + name, fn: fn });
};

function show(v) {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

G.eq = function (actual, expected, label) {
  if (show(actual) !== show(expected)) {
    throw new Error((label ? label + ': ' : '') + 'expected ' + show(expected) + ', got ' + show(actual));
  }
};

G.near = function (actual, expected, tolerance, label) {
  if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= tolerance)) {
    throw new Error((label ? label + ': ' : '') + 'expected ' + expected + ' ± ' + tolerance + ', got ' + show(actual));
  }
};

G.ok = function (value, label) {
  if (!value) { throw new Error(label || 'expected true'); }
};

G.isNull = function (value, label) {
  if (value != null) { throw new Error((label ? label + ': ' : '') + 'expected null, got ' + show(value)); }
};

G.notNull = function (value, label) {
  if (value == null) { throw new Error((label ? label + ': ' : '') + 'expected a value'); }
};

MODULES.forEach(function (path) { load(path); });
SUITES.forEach(function (path) {
  SUITE = path.replace(/^.*\//, '').replace(/\.test\.js$/, '');
  load(path);
});

var failures = 0;
TESTS.forEach(function (t) {
  try {
    t.fn();
  } catch (e) {
    failures += 1;
    print('FAIL ' + t.name + '\n     ' + (e && e.message ? e.message : e));
  }
});

print(failures ? 'FAIL (' + failures + ' of ' + TESTS.length + ')' : 'ALL PASS (' + TESTS.length + ')');
