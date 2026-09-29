/*
 * jeremy.ie/galaxy — the viewing bands.
 *
 * A band is what the galaxy looks like at one wavelength. The model (galaxy-model.js)
 * says what every star physically is and where the dust lies; a band says what colour
 * each star is drawn in, how bright each population is, how much the dust dims what
 * is behind it, and what soft light sits under the stars. The renderer (galaxy-view.js)
 * reads a band and nothing else, so looking at the galaxy another way is a new entry
 * here, plus a new population in the model if the band shows something the others do
 * not (the neutral hydrogen a radio view would need, for example).
 *
 * A band has:
 *   id, label, range   what the band strip on the page shows
 *   exposure           overall gain before the tone map
 *   colour(teff)       RGB (0-1) for a star of temperature teff
 *   extinction         how strongly the dust dims R, G and B: 0 for none (radio)
 *   glow               the soft light under the stars, as radial gradients, each a
 *                      list of [position 0-1, [r, g, b], alpha]:
 *     haze             lying in the plane of the disc
 *     core             facing the viewer, over the bulge
 *   layers             brightness per model population. A population with no entry,
 *                      or 0, is not drawn in this band at all.
 *
 * Only the optical band exists for now.
 */
window.GalaxyBands = (function () {
  'use strict';

  /*
   * The hero's palette (home-galaxy.js, and --accent-rgb / --galaxy-teal-rgb in
   * coal.css and home-coal.css): sage and a softer sage for the disc, teal for the
   * young hot stars, a warm near-white for the old stars of the bulge.
   */
  var SAGE = [110, 138, 120];
  var SOFT = [142, 172, 152];
  var TEAL = [72, 190, 176];
  var WARM = [226, 222, 208];

  /*
   * The optical band as a survey plot rather than a photograph: each temperature is
   * drawn in the colour the hero gives that kind of star. K and M giants warm, G and
   * K dwarfs soft, F and G sage, O, B and A teal. Stops are in kelvin; colours blend
   * across the gaps on a log scale.
   */
  var OPTICAL = [
    [3000, WARM], [4250, WARM], [4600, SOFT], [5150, SOFT],
    [5600, SAGE], [7400, SAGE], [8600, TEAL], [40000, TEAL]
  ];

  function scale(c) {
    return [c[0] / 255, c[1] / 255, c[2] / 255];
  }

  function ramp(stops) {
    return function (teff) {
      if (teff <= stops[0][0]) { return scale(stops[0][1]); }
      var lt = Math.log(teff);
      for (var i = 1; i < stops.length; i++) {
        if (teff <= stops[i][0]) {
          var a = Math.log(stops[i - 1][0]);
          var t = (lt - a) / (Math.log(stops[i][0]) - a);
          var c0 = stops[i - 1][1], c1 = stops[i][1];
          return scale([c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t,
            c0[2] + (c1[2] - c0[2]) * t]);
        }
      }
      return scale(stops[stops.length - 1][1]);
    };
  }

  /* ---------- Bands ---------- */

  var BANDS = [
    {
      id: 'optical',
      label: 'Optical',
      range: '400–700 nm',
      exposure: 1,
      colour: ramp(OPTICAL),
      // Dust takes out more blue than red (roughly as 1 / wavelength): reddening.
      extinction: [0.8, 0.9, 1],
      // The hero's haze and core, a little quieter here: the stars carry the picture.
      glow: {
        haze: [[0, SAGE, 0.1], [0.6, SAGE, 0.032], [1, SAGE, 0]],
        core: [[0, WARM, 0.22], [0.18, WARM, 0.1], [0.55, SAGE, 0.06], [1, SAGE, 0]]
      },
      layers: {
        sky: 0.5,
        halo: 0.7,
        globular: 0.75,
        faint: 0.6,
        disc: 1,
        bulge: 0.8,
        young: 1
      }
    }
  ];

  var byId = {};
  BANDS.forEach(function (b) { byId[b.id] = b; });

  return {
    list: function () { return BANDS.slice(); },
    get: function (id) { return byId[id] || BANDS[0]; }
  };
})();
