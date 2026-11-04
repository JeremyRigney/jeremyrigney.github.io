#!/usr/bin/env python3
"""Builds the earth texture for the /aurora globe.

Run manually from the repo root, in a venv with numpy, scipy and Pillow:

    python3 tools/build-aurora-earth.py [cache-dir]

Writes assets/data/aurora/earth.png, which is committed; the page never
touches the sources itself. It is WIDTH x HEIGHT, equirectangular, west edge
at 180 W, top row at 90 N, pixel-centred, and aurora-globe.js samples it with
the same layout and the same SDF_K and TOP_M, so they must change together:

  R  Night lights. NASA Earth Observatory's Black Marble 2016, greyscale,
     3 km: public domain (credit NASA Earth Observatory, Suomi NPP VIIRS).
     Upward light from the ground, as a stand-in until the page shows measured
     sky brightness.
  G  Land, as a signed distance to the coast in output texels: 128 is the
     coast, SDF_K codes a texel, land above. Natural Earth 50m land with the
     big lakes cut out, the same rings build-aurora-globe.py draws the coasts
     from, rasterised at SUPER times the output size by even-odd scanlines.
     The shader draws a crisp coast from it at any zoom.
  B  The land's height, for contours: sqrt(h / TOP_M) over 0..255, so a code
     is about 15 m at 500 m and under 40 m at 3,000 m, fine enough for 500 m
     contours once the GPU interpolates between texels. The sea is 0: it has
     no contours. NOAA ETOPO1 (ice surface), from NOAA's ERDDAP server at
     every 5th arc-minute: public domain.

Fetches go through curl, as in the other builders.
"""

import importlib.util
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.io import netcdf_file

WIDTH, HEIGHT = 2048, 1024
SUPER = 4  # land is rasterised at this multiple of the output size
SDF_K = 32  # codes per output texel in the land field: +-4 texels in range
TOP_M = 6500.0  # the height channel's top

ETOPO = ("https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.nc"
         "?altitude[(-90):5:(90)][(-180):5:(180)]")
LIGHTS = ("https://assets.science.nasa.gov/content/dam/science/esd/eo/images/"
          "imagerecords/144000/144897/BlackMarble_2016_3km_gray.jpg")

OUT = "assets/data/aurora/earth.png"


def globe_builder():
    """build-aurora-globe.py, for its Natural Earth source and scanlines."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "build_aurora_globe", os.path.join(here, "build-aurora-globe.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cached(cache, name, url):
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        print("fetching %s" % url)
        subprocess.run(["curl", "-g", "-sSfL", "--max-time", "600", "-o", path, url], check=True)
    else:
        print("reading %s" % path)
    return path


def pixel_centres(width, height):
    lons = -180.0 + (np.arange(width) + 0.5) * 360.0 / width
    lats = 90.0 - (np.arange(height) + 0.5) * 180.0 / height
    return lons, lats


def geojson(cache, gb, name):
    with open(cached(cache, name, gb.BASE + name)) as handle:
        return json.load(handle)


def land_field(cache, gb):
    """Signed distance to the coast in output texels, land positive."""
    land_rings = []
    for feature in geojson(cache, gb, gb.LAND)["features"]:
        for polygon in gb.polygons(feature["geometry"]):
            land_rings.extend(polygon)
    lake_rings = []
    for feature in geojson(cache, gb, gb.LAKES)["features"]:
        for polygon in gb.polygons(feature["geometry"]):
            if gb.span(polygon[0]) >= gb.LAKE_MIN_SPAN:
                lake_rings.extend(polygon)

    w, h = WIDTH * SUPER, HEIGHT * SUPER
    lons, lats = pixel_centres(w, h)
    land, lakes = gb.Scanner(land_rings), gb.Scanner(lake_rings)
    mask = np.zeros((h, w), dtype=bool)
    for j, lat in enumerate(lats):
        row = np.zeros(w, dtype=bool)
        for scanner, value in ((land, True), (lakes, False)):
            xs = scanner.crossings(lat)
            if not xs:
                continue
            # Crossings east of each pixel: odd means inside.
            east = len(xs) - np.searchsorted(np.array(xs), lons, side="right")
            hit = (east % 2) == 1
            row = np.where(hit, value, row) if value else row & ~hit
        mask[j] = row
    print("land: %.1f%% of the raster" % (100.0 * mask.mean()))

    # Distances in raster pixels, wrapping east-west so the antimeridian has no seam.
    pad = w // 8
    wide = np.concatenate([mask[:, -pad:], mask, mask[:, :pad]], axis=1)
    outside = ndimage.distance_transform_edt(~wide)[:, pad:-pad]
    inside = ndimage.distance_transform_edt(wide)[:, pad:-pad]
    sd = np.where(mask, inside - 0.5, -(outside - 0.5)) / SUPER

    # Down to the output grid, at its pixel centres.
    ys = (np.arange(HEIGHT) + 0.5) * SUPER - 0.5
    xs = (np.arange(WIDTH) + 0.5) * SUPER - 0.5
    gy, gx = np.meshgrid(ys, xs, indexing="ij")
    small = ndimage.map_coordinates(sd, [gy, gx], order=1, mode="nearest")
    return np.clip(np.round(128 + small * SDF_K), 0, 255).astype(np.uint8)


def height(cache):
    """The land's height, sea at zero."""
    path = cached(cache, "etopo1_s5.nc", ETOPO)
    nc = netcdf_file(path, "r", mmap=False)
    lat = nc.variables["latitude"][:].astype(float)  # -90 .. 90
    lon = nc.variables["longitude"][:].astype(float)  # -180 .. 180
    alt = nc.variables["altitude"][:].astype(float)
    nc.close()
    alt, lat = alt[::-1], lat[::-1]  # north at the top, as the texture
    alt, lon = alt[:, :-1], lon[:-1]  # 180 E repeats 180 W

    # Down to the output grid: a little smoothing first, so it doesn't alias.
    sigma = 0.5 * alt.shape[1] / WIDTH
    smooth = ndimage.gaussian_filter(np.maximum(alt, 0.0), sigma, mode=["nearest", "wrap"])
    lons, lats = pixel_centres(WIDTH, HEIGHT)
    fy = (lat[0] - lats) / abs(lat[1] - lat[0])
    fx = (lons - lon[0]) / (lon[1] - lon[0])
    gy, gx = np.meshgrid(fy, fx, indexing="ij")
    h = ndimage.map_coordinates(smooth, [gy, gx], order=1, mode="grid-wrap")
    print("land height up to %.0f m" % h.max())
    return np.clip(np.round(np.sqrt(np.clip(h, 0.0, TOP_M) / TOP_M) * 255.0), 0, 255).astype(np.uint8)


def lights(cache):
    path = cached(cache, "blackmarble_2016_3km_gray.jpg", LIGHTS)
    Image.MAX_IMAGE_PIXELS = None  # 13500 x 6750, from NASA
    img = Image.open(path).convert("L")
    return np.asarray(img.resize((WIDTH, HEIGHT), Image.BOX), dtype=np.uint8)


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    os.chdir(root)
    cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join("tools", ".cache")
    os.makedirs(cache, exist_ok=True)

    gb = globe_builder()
    rgb = np.dstack([lights(cache), land_field(cache, gb), height(cache)])
    Image.fromarray(rgb, "RGB").save(OUT, optimize=True)
    print("wrote %s (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
