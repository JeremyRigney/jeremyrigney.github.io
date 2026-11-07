/*
 * The page's house rules, checked rather than remembered:
 *   - colours are tokens: no literal colour below the :root block in pitwall.css;
 *   - every colour a script reads from CSS is six-digit hex (canvas code parses only that);
 *   - every text colour clears 4.5:1 on the surfaces it sits on;
 *   - the draft stays out of search, off the site's shared theme and nav, and loads its
 *     scripts in dependency order.
 */
(function () {
  var css = readFile('assets/css/pitwall.css');
  var html = readFile('f1-wall_2.html');

  // The first :root block holds every literal; what follows must only use tokens.
  var rootStart = css.indexOf(':root {');
  var rootEnd = css.indexOf('\n}', rootStart);
  var root = css.slice(rootStart, rootEnd);
  var rest = css.slice(rootEnd + 2);

  function tokens() {
    var out = {};
    var re = /(--[\w-]+)\s*:\s*([^;]+);/g;
    var m;
    while ((m = re.exec(root))) { out[m[1]] = m[2].trim(); }
    return out;
  }
  var T = tokens();

  var NAMED = /\b(white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|gold|pink|navy|teal|maroon|olive|lime|aqua|fuchsia|cyan|magenta)\b/;

  test('no literal colour below :root', function () {
    var bad = [];
    var stripped = rest.replace(/\/\*[\s\S]*?\*\//g, '');
    var re = /([\w-]+)\s*:\s*([^;{}]+);/g;
    var m;
    while ((m = re.exec(stripped))) {
      if (m[1].indexOf('--') === 0 && /^--[\w-]+$/.test(m[1])) {
        // A token set below :root may point at another token, never at a literal.
      }
      var value = m[2].replace(/var\(--[\w-]+\)/g, '').replace(/--[\w-]+/g, '');
      if (/#[0-9a-fA-F]{3,8}\b/.test(value) || /\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/.test(value) || NAMED.test(value)) {
        bad.push(m[1] + ': ' + m[2].trim());
      }
    }
    eq(bad, []);
  });

  test('colours read by scripts are six-digit hex', function () {
    var read = {};
    ['pitwall-ui.js', 'pitwall-tower.js', 'pitwall-header.js', 'pitwall-timeline.js', 'pitwall-replay.js', 'pitwall-map.js', 'pitwall-ring.js', 'pitwall-feed.js', 'pitwall-driver.js', 'pitwall-app.js'].forEach(function (f) {
      var src = readFile('assets/js/' + f);
      var re = /(?:token|colour)\('(--[\w-]+)'\)/g;
      var m;
      while ((m = re.exec(src))) { read[m[1]] = true; }
    });
    Object.keys(read).forEach(function (name) {
      ok(/^#[0-9a-fA-F]{6}$/.test(T[name] || ''), name + ' is ' + T[name]);
    });
  });

  function rgb(hex) {
    return [1, 3, 5].map(function (i) { return parseInt(hex.substr(i, 2), 16) / 255; });
  }

  function luminance(c) {
    var lin = c.map(function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** A token's colour, flattened over the ground when it carries an alpha. */
  function solid(name) {
    var v = T[name];
    var m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v || '');
    if (m) {
      var ground = rgb(T['--ground']);
      var a = +m[4];
      return [+m[1] / 255, +m[2] / 255, +m[3] / 255].map(function (c, i) { return c * a + ground[i] * (1 - a); });
    }
    ok(/^#[0-9a-fA-F]{6}$/.test(v || ''), name + ' is ' + v);
    return rgb(v);
  }

  test('text clears 4.5:1 on every surface', function () {
    ['--ink', '--ink-soft', '--ink-faint'].forEach(function (text) {
      ['--ground', '--card', '--card-solid', '--row'].forEach(function (surface) {
        var ratio = contrast(solid(text), solid(surface));
        ok(ratio >= 4.5, text + ' on ' + surface + ' is ' + ratio.toFixed(2) + ':1');
      });
    });
  });

  test('data colours clear 4.5:1 on a row', function () {
    ['--timing-best', '--timing-personal', '--caution', '--rain'].forEach(function (text) {
      var ratio = contrast(solid(text), solid('--row'));
      ok(ratio >= 4.5, text + ' on --row is ' + ratio.toFixed(2) + ':1');
    });
  });

  test('the draft stays out of search and off the shared chrome', function () {
    ok(/<meta name="robots" content="noindex, nofollow"/.test(html), 'noindex');
    no(/theme\.js|site-nav\.js|coal\.css/.test(html), 'loads the shared theme or nav');
  });

  test('scripts load in dependency order', function () {
    var order = [];
    var re = /<script src="assets\/js\/(pitwall-[\w-]+)\.js/g;
    var m;
    while ((m = re.exec(html))) { order.push(m[1]); }
    var pure = ['pitwall-format', 'pitwall-parse', 'pitwall-season', 'pitwall-sse', 'pitwall-live'];
    eq(order.slice(0, pure.length), pure);
    eq(order[order.length - 1], 'pitwall-app');
  });
}());
