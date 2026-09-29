/*
 * jeremy.ie/galaxy — the viewing bands.
 *
 * A band is what the galaxy looks like at one wavelength. The model (galaxy-model.js)
 * says what every point physically is; a band says how much light each kind of point
 * gives at that wavelength, in what colour, and what it takes away. The renderer
 * (galaxy-view.js) reads a band and nothing else, so looking at the galaxy another way
 * is a new entry here, plus a new population in the model if the band shows something
 * the others do not (the neutral hydrogen a radio view would need, for example).
 *
 * A band has:
 *   id, label, range   what the band strip on the page shows
 *   exposure           overall gain before the tone map
 *   stretch            the asinh softening: higher lifts faint light more
 *   saturation         applied after the tone map
 *   colour(teff)       linear RGB for a point of temperature teff, max channel 1
 *   layers             one entry per model population. A population with no entry, or
 *                      weight 0, is not drawn in this band at all:
 *     weight           its brightness in this band
 *     lut              true to colour it by colour(teff)
 *     tint             an RGB multiplier (or the whole colour, without lut)
 *     absorb           instead of emitting, take this fraction of R, G, B out of what
 *                      lies behind it, scaled by the point's optical depth
 *
 * Only the optical band exists for now.
 */
window.GalaxyBands = (function () {
  'use strict';

  /* ---------- Blackbody colour ---------- */

  /*
   * The CIE 1931 colour-matching functions, as the multi-lobe Gaussian fit of Wyman,
   * Sloan and Shirley (2013), then XYZ to linear sRGB. Integrating Planck's law against
   * them gives the colour a star of that temperature actually has: M dwarfs orange,
   * the Sun very nearly white, O and B stars pale blue.
   */
  function lobe(l, mu, s1, s2) {
    var t = (l - mu) / (l < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  }

  function blackbody(teff) {
    var X = 0, Y = 0, Z = 0;
    for (var l = 380; l <= 780; l += 5) {
      var b = Math.pow(l, -5) / (Math.exp(1.4388e7 / (l * teff)) - 1);
      X += b * (1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7)
        - 0.065 * lobe(l, 501.1, 20.4, 26.2));
      Y += b * (0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1));
      Z += b * (1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8));
    }
    var r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    var g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    var bl = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    r = Math.max(0, r); g = Math.max(0, g); bl = Math.max(0, bl);
    return [r, g, bl];
  }

  /*
   * White-balanced to a G2 star, as survey colour images are: the Sun comes out white,
   * cooler stars toward orange and hotter ones toward blue. Referenced to the display's
   * own white point instead, everything the Sun's temperature or cooler would read as
   * orange, and a galaxy's old light would all be the colour of a candle.
   */
  var G2 = blackbody(5800);

  function balanced(teff) {
    var c = blackbody(teff);
    var r = c[0] / G2[0], g = c[1] / G2[1], b = c[2] / G2[2];
    var m = Math.max(r, g, b) || 1;
    return [r / m, g / m, b / m];
  }

  /* ---------- Bands ---------- */

  var BANDS = [
    {
      id: 'optical',
      label: 'Optical',
      range: '400–700 nm',
      exposure: 0.4,
      stretch: 20,
      saturation: 1,
      colour: balanced,
      layers: {
        sky: { weight: 0.9, lut: true },
        diffuse: { weight: 0.0085, lut: true },
        bulgeGlow: { weight: 0.011, lut: true },
        disc: { weight: 0.9, lut: true },
        bulge: { weight: 0.22, lut: true },
        young: { weight: 1.3, lut: true },
        globular: { weight: 0.55, lut: true },
        // H-alpha at 656 nm with some H-beta: the pink of an emission nebula.
        hii: { weight: 0.1, lut: false, tint: [1, 0.32, 0.52] },
        // Extinction rises toward the blue (roughly as 1/wavelength), so what shows
        // through the edge of a lane is reddened as well as dimmed.
        dust: { weight: 0.65, absorb: [0.62, 0.8, 1] }
      }
    }
  ];

  var byId = {};
  BANDS.forEach(function (b) { byId[b.id] = b; });

  return {
    list: function () { return BANDS.slice(); },
    get: function (id) { return byId[id] || BANDS[0]; },
    blackbody: blackbody
  };
})();
