/*
 * CARTO raster basemaps — one place for the key.
 *
 * CARTO enforces API keys on basemaps.cartocdn.com. A keyless request does not
 * fail: it returns a perfectly valid 200 PNG with "API KEY REQUIRED" printed
 * across it, which is why an onerror-style fallback can never catch it. The key
 * below is the free basemap key from carto.com/basemaps/apikey.
 *
 * Consumers ask for a URL template rather than building one, so rotating the key
 * is a one-line edit here. With no key set, cartoTiles returns null and every
 * caller is expected to draw no basemap at all — never a watermarked one.
 */
(function () {
  'use strict';

  /* Free basemap key (carto.com/basemaps/apikey). Public by design on a static
     site; regenerate at the same URL if it is ever abused. */
  var CARTO_KEY = 'cb1_2hpu_1_016e2403c1245a9bdfedd4fc';

  /*
   * style     one of CARTO's raster styles, e.g. 'dark_nolabels', 'dark_all'
   * subdomain 'a' for a plain <img> loader, '{s}' to let Leaflet round-robin
   * retina    '@2x' to always ask for retina tiles, '{r}' to let Leaflet decide
   */
  window.cartoTiles = function (style, options) {
    if (!CARTO_KEY) {
      return null;
    }
    var opts = options || {};
    var host = (opts.subdomain ? opts.subdomain + '.' : '') + 'basemaps.cartocdn.com';
    return 'https://' + host + '/' + style + '/{z}/{x}/{y}' + (opts.retina || '') +
      '.png?key=' + CARTO_KEY;
  };
}());
