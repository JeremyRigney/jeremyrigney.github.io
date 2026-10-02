/*
 * jeremy.ie/star — the channels.
 *
 * A channel is what the star looks like through one of the Solar Dynamics
 * Observatory's filters. The model (star-model.js) says where the field is and how
 * hot and dense the plasma on it is; a channel says how much of that each filter
 * sees, how the image is stretched, and what colour table it is shown in. The
 * renderer (star-view.js) reads a channel and nothing else.
 *
 * Seven are AIA's extreme-ultraviolet filters, each centred on a line of iron (or,
 * at 304, helium) that forms in a narrow range of temperature; one is AIA's 1600 A
 * ultraviolet; one is white light, the visible surface; one is HMI's magnetogram;
 * and one is the three-colour composite SDO publishes (211, 193 and 171 as red,
 * green and blue).
 *
 * A channel has:
 *   id, label, ion, temp   what the chip on the page shows
 *   key                    its keyboard shortcut
 *   table                  colour table (below), or 'grey'
 *   tone                   'asinh' (AIA), 'linear' (white light) or 'signed' (magnetogram)
 *   stretch                vmax: the top of the scale, in units of the quiet star at disc
 *                          centre; a: the asinh softening (smaller is closer to log)
 *   resp                   the filter's temperature response, as Gaussians in log T:
 *                          [centre, width, weight]. Plasma at log T shines in the
 *                          channel in proportion to this times its density squared.
 *   layers                 how much of each surface layer the channel sees:
 *     photo    the photosphere in white light: granules, spots, faculae
 *     uv       the 1600 A upper photosphere and transition region: network, plage
 *     chrom    the He II chromosphere: mottles, network, plage
 *     net      the quiet transition region over the network, at 0.1 to 0.8 MK
 *     moss     the bright base of hot active-region loops
 *     mag      the line-of-sight field
 *     ribbon   flare ribbons
 *     limb     the chromosphere and spicules just past the limb
 *   absorb                 the optical depth of cool material (filaments, prominences,
 *                          rain, spicules) in the channel: opaque in the EUV, which its
 *                          hydrogen and helium absorb, nearly clear at 1600
 *   coolS                  the light cool material gives off where it is opaque, in units
 *                          of the quiet star: below the disc's, so it is dark against the
 *                          disc and bright against the sky (a prominence)
 *   gain                   overall scale, set so the quiet star at disc centre is 1
 *   noise                  for the faint channels, the counts in a quiet-star pixel:
 *                          AIA's 94, 131 and 335 images are grainy with photon noise
 *
 * The stretches are measured from real AIA images by tools/star-references.py
 * (SunPy's sample data, 7 June 2011, 06:33 UT): vmax is the 99.9th percentile of
 * the disc over the quiet-Sun median, and a puts the quiet Sun 42% of the way up
 * the colour table, as those images look. For 94, 131 and 335 the 99.9th percentile
 * that morning was an M2.5 flare, so their vmax is set lower by hand.
 *
 * The star itself was then tuned (scale heights, loop and corona brightness, the
 * layer weights here) until the page, read back raw with ?debug at t = 30 s and a
 * radius of 396 px, measured like those images. All relative to the quiet star at
 * disc centre; the Sun's numbers first, then the star's:
 *
 *            limb (0.97-1 R)   1.04 R        1.125 R       99th pct      10th pct
 *   171      2.14  1.78        1.51  1.85    0.26  0.22    8.0   6.5     0.67  0.69
 *   193      1.72  1.68        2.41  2.91    0.67  0.99    8.8   6.7     0.67  0.76
 *   211      1.89  1.68        2.67  2.59    1.00  0.96    15.7  11.3    0.65  0.70
 *   335      2.01  1.82        2.44  1.90    0.70  0.72    29.4  13.4    0.62  0.74
 *   304      1.08  1.07        0.29  0.27    0.10  0.08    7.0   4.2     0.61  0.55
 *   1600     0.56  0.54        0.02  0.01    0.01  0.00    2.2   2.3     0.56  0.59
 *
 * 94 and 131 are left out: that morning both were dominated by the flare and by
 * photon noise. The star's corona fades faster than the Sun's beyond about 1.2 R,
 * where AIA's own scattered light and the streamers this model lacks take over.
 */
window.StarBands = (function () {
  'use strict';

  /* ---------- Colour tables ---------- */

  /*
   * SunPy's AIA colour tables (sunpy.visualization.colormaps.color_tables,
   * create_aia_wave_dict, BSD-2), themselves from aia_lct.pro by Karel Schrijver.
   * Each channel takes its red, green and blue from a few curves: c0 linear, c1 a
   * square root, c2 a square, c3 a blend, and r0, g0, b0, IDL's colour table 3 ("red
   * temperature"), which is three clamped ramps: fitted here to SunPy's idl_3.csv to
   * within 1/255 in red and green and 3/255 in blue.
   */
  function ramp(i, a, b) { return Math.max(0, Math.min(255, (i - a) * 255 / (b - a))); }
  function r0(i) { return ramp(i, 0.3, 176.3); }
  function g0(i) { return ramp(i, 120.2, 255.2); }
  function b0(i) { return ramp(i, 191, 255); }
  function c0(i) { return i; }
  function c1(i) { return Math.sqrt(i) * Math.sqrt(255); }
  function c2(i) { return i * i / 255; }
  function c3(i) { return (c1(i) + c2(i) / 2) * 255 / (255 + 127.5); }
  function half(f) { return function (i) { return f(i) / 2; }; }

  var TABLES = {
    '94': [c2, c3, c0],
    '131': [g0, r0, r0],
    '171': [r0, c0, b0],
    '193': [c1, c0, c2],
    '211': [c1, c0, c3],
    '304': [r0, g0, b0],
    '335': [c2, c0, c1],
    '1600': [c3, c3, c2],
    '4500': [c0, c0, half(b0)],
    grey: [c0, c0, c0]
  };

  // A table as 256 RGBA texels.
  function table(name) {
    var t = TABLES[name] || TABLES.grey;
    var px = new Uint8Array(256 * 4);
    for (var i = 0; i < 256; i++) {
      px[i * 4] = Math.round(t[0](i));
      px[i * 4 + 1] = Math.round(t[1](i));
      px[i * 4 + 2] = Math.round(t[2](i));
      px[i * 4 + 3] = 255;
    }
    return px;
  }

  // The colour a table gives at v (0-1), as a CSS rgb() triple, for the chips.
  function swatch(name, v) {
    var t = TABLES[name] || TABLES.grey;
    var i = Math.round(v * 255);
    return [Math.round(t[0](i)), Math.round(t[1](i)), Math.round(t[2](i))];
  }

  /* ---------- Layers ---------- */

  var LAYERS = ['photo', 'uv', 'chrom', 'net', 'moss', 'mag', 'ribbon', 'limb'];

  function layers(o) {
    return LAYERS.map(function (k) { return o[k] || 0; });
  }

  /* ---------- Channels ---------- */

  /*
   * Response peaks are AIA's (Boerner et al. 2012): 94 from Fe XVIII at 6.85 with
   * Fe X at 6.05; 131 from Fe VIII at 5.6 and Fe XXI at 7.05; 171 Fe IX at 5.85;
   * 193 Fe XII at 6.2 with Fe XXIV at 7.25; 211 Fe XIV at 6.3; 335 Fe XVI at 6.45;
   * 304 He II at 4.9 with a little Si XI at 6.25. Widths and the second peaks'
   * weights are rounded from the published curves.
   */
  var CHANNELS = [
    {
      id: '94', label: '94', unit: 'Å', ion: 'Fe XVIII', temp: '6.3 MK', key: '1', table: '94',
      tone: 'asinh', stretch: { vmax: 60, a: 0.00339 },
      resp: [[6.85, 0.13, 1], [6.05, 0.12, 0.09]],
      layers: layers({ net: 0.03, moss: 0.25, ribbon: 0.6 }),
      absorb: 0.9, gain: 6.18, noise: 8
    },
    {
      id: '131', label: '131', unit: 'Å', ion: 'Fe VIII · XXI', temp: '0.4 · 10 MK', key: '2', table: '131',
      tone: 'asinh', stretch: { vmax: 80, a: 0.00172 },
      resp: [[5.6, 0.12, 0.55], [7.05, 0.12, 1]],
      layers: layers({ net: 1, moss: 0.3, ribbon: 3 }),
      absorb: 0.9, coolS: 0.05, gain: 1.05, noise: 30
    },
    {
      // 171: vmax 22.09, a 0.00982 measured.
      id: '171', label: '171', unit: 'Å', ion: 'Fe IX', temp: '0.6 MK', key: '3', table: '171',
      tone: 'asinh', stretch: { vmax: 22.09, a: 0.00982 },
      resp: [[5.85, 0.13, 1]],
      layers: layers({ net: 0.6, moss: 0.6, ribbon: 1.2 }),
      absorb: 0.9, coolS: 0.04, gain: 0.863
    },
    {
      // 193: vmax 53.21, a 0.00213 measured.
      id: '193', label: '193', unit: 'Å', ion: 'Fe XII', temp: '1.6 MK', key: '4', table: '193',
      tone: 'asinh', stretch: { vmax: 53.21, a: 0.00213 },
      resp: [[6.2, 0.11, 1], [7.25, 0.12, 0.12]],
      layers: layers({ net: 0.15, moss: 1, ribbon: 1 }),
      absorb: 0.9, gain: 1.11
    },
    {
      // 211: vmax 44.09, a 0.00294 measured.
      id: '211', label: '211', unit: 'Å', ion: 'Fe XIV', temp: '2 MK', key: '5', table: '211',
      tone: 'asinh', stretch: { vmax: 44.09, a: 0.00294 },
      resp: [[6.3, 0.11, 1]],
      layers: layers({ net: 0.1, moss: 0.8, ribbon: 0.8 }),
      absorb: 0.9, gain: 2.06
    },
    {
      id: '335', label: '335', unit: 'Å', ion: 'Fe XVI', temp: '2.5 MK', key: '6', table: '335',
      tone: 'asinh', stretch: { vmax: 60, a: 0.00339 },
      resp: [[6.45, 0.15, 1], [5.5, 0.12, 0.15]],
      layers: layers({ net: 0.15, moss: 0.5, ribbon: 0.8 }),
      absorb: 0.9, gain: 2.93, noise: 25
    },
    {
      // 304: vmax 54.04, a 0.00207 measured.
      id: '304', label: '304', unit: 'Å', ion: 'He II', temp: '50,000 K', key: '7', table: '304',
      tone: 'asinh', stretch: { vmax: 54.04, a: 0.00207 },
      resp: [[4.9, 0.2, 1], [6.25, 0.12, 0.09]],
      layers: layers({ chrom: 1, ribbon: 6, limb: 1 }),
      absorb: 1.1, coolS: 0.55, gain: 1.14
    },
    {
      // 1600: vmax 7.23, a 0.0737 measured.
      id: '1600', label: '1600', unit: 'Å', ion: 'C IV + cont.', temp: '6,000 K', key: '8', table: '1600',
      tone: 'asinh', stretch: { vmax: 7.23, a: 0.0737 },
      resp: [[5.0, 0.15, 0.05]],
      layers: layers({ uv: 1, ribbon: 9, limb: 0.15 }),
      absorb: 0.15, coolS: 0.1, gain: 0.994
    },
    {
      id: 'white', label: 'White light', unit: '', ion: '4500 Å', temp: '5,700 K', key: '9', table: '4500',
      tone: 'linear', stretch: { vmax: 1.12, a: 1 },
      resp: [[4, 0.1, 0]],
      layers: layers({ photo: 1 }),
      absorb: 0, gain: 1
    },
    {
      id: 'mag', label: 'Magnetogram', unit: '', ion: 'HMI', temp: '±400 G', key: '0', table: 'grey',
      tone: 'signed', stretch: { vmax: 400, a: 1 },
      resp: [[4, 0.1, 0]],
      layers: layers({ mag: 1 }),
      absorb: 0, gain: 1
    },
    {
      // SDO's composite: each channel stretched as on its own, as red, green and blue.
      id: 'rgb', label: 'Composite', unit: '', ion: '211 · 193 · 171', temp: '', key: 'c', table: 'grey',
      tone: 'rgb', components: ['211', '193', '171']
    }
  ];

  var byId = {};
  CHANNELS.forEach(function (c) { byId[c.id] = c; });

  /*
   * Each channel as up to three components the renderer computes at once, in the R, G
   * and B of its buffer: one for a single channel, three for the composite.
   */
  function components(c) {
    if (c.components) { return c.components.map(function (id) { return byId[id]; }); }
    return [c];
  }

  return {
    list: function () { return CHANNELS.slice(); },
    get: function (id) { return byId[id] || byId['171']; },
    has: function (id) { return !!byId[id]; },
    components: components,
    table: table,
    swatch: swatch,
    LAYERS: LAYERS
  };
})();
