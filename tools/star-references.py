#!/usr/bin/env python3
"""
Calibration for /star, from real images of the Sun.

/star draws a young Sun-like star in the channels of NASA's Solar Dynamics
Observatory. Every number that sets how a channel looks (how bright the limb is,
how fast the corona fades off it, how bright an active region is against the quiet
Sun, how dark a coronal hole is, and the display stretch) is measured here from real
AIA and HMI images and copied into assets/js/star-bands.js, with a comment beside
each saying where it came from.

The images are SunPy's sample data: AIA 94, 131, 171, 193, 211, 304, 335 and
1600 A and an HMI line-of-sight magnetogram, all taken within a minute of each
other at 06:33 UT on 7 June 2011, rebinned to 1024 x 1024. An M2.5 flare and a
filament eruption were under way in the south-west at the time, so the brightest
pixels are flare pixels; the measures below are medians and percentiles that a
single flare does not move much.

    python3 tools/star-references.py --cache /tmp/aia --out /tmp/aia/png

prints a JSON block of measurements and writes each image, scaled and coloured the
way star-bands.js shows that channel, as a PNG for side-by-side comparison.

Needs numpy, astropy and Pillow. Downloads about 16 MB once, into --cache.
"""
import argparse
import json
import math
import os
import sys
import urllib.request

import numpy as np
from astropy.io import fits

SAMPLE = 'https://media.githubusercontent.com/media/sunpy/data/main/sunpy/v1/'
IDL3 = ('https://raw.githubusercontent.com/sunpy/sunpy/main/sunpy/visualization/'
        'colormaps/data/idl_3.csv')

FILES = {
    '94': 'AIA20110607_063305_0094_lowres.fits',
    '131': 'AIA20110607_063301_0131_lowres.fits',
    '171': 'AIA20110607_063302_0171_lowres.fits',
    '193': 'AIA20110607_063307_0193_lowres.fits',
    '211': 'AIA20110607_063302_0211_lowres.fits',
    '304': 'AIA20110607_063334_0304_lowres.fits',
    '335': 'AIA20110607_063303_0335_lowres.fits',
    '1600': 'AIA20110607_063305_1600_lowres.fits',
    'mag': 'HMI20110607_063211_los_lowres.fits',
}

# Where the quiet Sun's level is taken: the middle of the disc, as a median.
CENTRE = 0.5
# Annuli for the radial profile, in solar radii.
PROFILE = [0.0, 0.25, 0.5, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99, 1.0, 1.01, 1.02, 1.03,
           1.05, 1.075, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5]
# The display stretch puts the quiet Sun this far up the colour table.
QUIET_LEVEL = 0.42


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    sys.stderr.write('fetching ' + url + '\n')
    urllib.request.urlretrieve(url, path)
    return path


def load(cache, key):
    path = fetch(SAMPLE + FILES[key], os.path.join(cache, FILES[key]))
    with fits.open(path) as hdul:
        hdu = next(h for h in hdul if h.data is not None)
        data = np.array(hdu.data, dtype=np.float64)
        head = hdu.header
    # Disc centre and radius in pixels, from the WCS.
    cx = head['CRPIX1'] - 1 - head.get('CRVAL1', 0) / head['CDELT1']
    cy = head['CRPIX2'] - 1 - head.get('CRVAL2', 0) / head['CDELT2']
    rsun = head['RSUN_OBS'] / head['CDELT1']
    exptime = head.get('EXPTIME') or 1.0
    if key != 'mag':
        data = data / exptime  # DN/s
    if abs(abs(head.get('CROTA2', 0)) - 180) < 5:
        data = data[::-1, ::-1]  # HMI is stored upside down
        cx = data.shape[1] - 1 - cx
        cy = data.shape[0] - 1 - cy
    return data, cx, cy, rsun


def radius_map(shape, cx, cy, rsun):
    y, x = np.indices(shape)
    return np.hypot(x - cx, y - cy) / rsun


def annulus(data, r, a, b):
    m = (r >= a) & (r < b) & np.isfinite(data)
    return data[m]


def asinh_a(quiet, vmax, level):
    """The asinh softening, a, that puts the quiet Sun at `level` of the range."""
    q = quiet / vmax
    lo, hi = 1e-5, 10.0
    for _ in range(80):
        a = math.sqrt(lo * hi)
        v = math.asinh(q / a) / math.asinh(1 / a)
        if v > level:
            lo = a  # too bright: soften less
        else:
            hi = a
    return a


def measure(key, data, cx, cy, rsun):
    r = radius_map(data.shape, cx, cy, rsun)
    if key == 'mag':
        disc = annulus(data, r, 0, 0.95)
        quiet = annulus(data, r, 0, CENTRE)
        return {
            'quiet_abs_median_G': round(float(np.median(np.abs(quiet))), 1),
            'abs_p99_G': round(float(np.percentile(np.abs(disc), 99)), 0),
            'abs_p999_G': round(float(np.percentile(np.abs(disc), 99.9)), 0),
            'abs_max_G': round(float(np.max(np.abs(disc))), 0),
            'network_fraction_over_50G': round(float(np.mean(np.abs(quiet) > 50)), 3),
        }
    quiet = float(np.median(annulus(data, r, 0, CENTRE)))
    disc = annulus(data, r, 0, 0.98)
    prof = []
    for a, b in zip(PROFILE[:-1], PROFILE[1:]):
        v = annulus(data, r, a, b)
        prof.append([round((a + b) / 2, 4), round(float(np.median(v)) / quiet, 4)])
    # The off-limb fall-off, as an e-folding height in solar radii, fitted from 1.02 to 1.2.
    off = [(m, v) for m, v in prof if 1.02 <= m <= 1.2 and v > 0]
    if len(off) >= 3:
        xs = np.array([m for m, _ in off])
        ys = np.log(np.array([v for _, v in off]))
        slope = np.polyfit(xs, ys, 1)[0]
        efold = round(float(-1 / slope), 4) if slope < 0 else None
    else:
        efold = None
    limb = float(np.median(annulus(data, r, 0.97, 1.0))) / quiet
    vmax = float(np.percentile(disc, 99.9))
    a = asinh_a(quiet, vmax, QUIET_LEVEL)
    return {
        'quiet_dn_s': round(quiet, 3),
        'limb_over_quiet': round(limb, 3),
        'offlimb_1p05_over_quiet': round(dict(prof).get(1.04, float('nan')), 4),
        'offlimb_efold_R': efold,
        # Bright: active regions (and, here, the flare). Dark: coronal holes and filaments.
        'p99_over_quiet': round(float(np.percentile(disc, 99)) / quiet, 3),
        'p999_over_quiet': round(vmax / quiet, 3),
        'p02_over_quiet': round(float(np.percentile(disc, 2)) / quiet, 3),
        'p10_over_quiet': round(float(np.percentile(disc, 10)) / quiet, 3),
        'stretch': {'vmax_over_quiet': round(vmax / quiet, 2), 'asinh_a': round(a, 5)},
        'profile': prof,
    }


# ---------- Colour tables, as SunPy's create_aia_wave_dict ----------

def aia_tables(idl3):
    r0, g0, b0 = idl3[:, 0], idl3[:, 1], idl3[:, 2]
    c0 = np.arange(256, dtype='f')
    c1 = np.sqrt(c0) * np.sqrt(255.0)
    c2 = np.arange(256) ** 2 / 255.0
    c3 = (c1 + c2 / 2.0) * 255.0 / (c1.max() + c2.max() / 2.0)
    return {
        '1600': (c3, c3, c2), '94': (c2, c3, c0), '131': (g0, r0, r0),
        '171': (r0, c0, b0), '193': (c1, c0, c2), '211': (c1, c0, c3),
        '304': (r0, g0, b0), '335': (c2, c0, c1),
    }


def render_png(key, data, cx, cy, rsun, stretch, tables, out):
    from PIL import Image
    if key == 'mag':
        v = np.clip(data / 1000.0 * 0.5 + 0.5, 0, 1)
        rgb = np.stack([v, v, v], -1) * 255
    else:
        quiet = stretch['quiet']
        x = np.clip(data / (quiet * stretch['vmax_over_quiet']), 0, 1)
        a = stretch['asinh_a']
        v = np.arcsinh(x / a) / np.arcsinh(1 / a)
        idx = np.clip((v * 255).astype(int), 0, 255)
        tr, tg, tb = tables[key]
        rgb = np.stack([np.asarray(tr)[idx], np.asarray(tg)[idx], np.asarray(tb)[idx]], -1)
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)[::-1], 'RGB')
    img = img.resize((512, 512), Image.LANCZOS)
    img.save(os.path.join(out, 'aia-' + key + '.png'))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--cache', default='.star-references')
    ap.add_argument('--out', default=None, help='write reference PNGs here')
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    idl3 = np.loadtxt(fetch(IDL3, os.path.join(args.cache, 'idl_3.csv')), delimiter=',')
    tables = aia_tables(idl3)
    results = {}
    for key in FILES:
        data, cx, cy, rsun = load(args.cache, key)
        m = measure(key, data, cx, cy, rsun)
        results[key] = m
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            st = None
            if key != 'mag':
                st = dict(m['stretch'], quiet=m['quiet_dn_s'])
            render_png(key, data, cx, cy, rsun, st, tables, args.out)
    json.dump(results, sys.stdout, indent=1)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
