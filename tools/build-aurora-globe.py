#!/usr/bin/env python3
"""Builds the coastlines for the /aurora globe.

Run manually from the repo root:

    python3 tools/build-aurora-globe.py [path/to/dir-with-geojson]

Writes assets/data/aurora/globe.json, which is committed. The page fetches the
committed JSON and never touches Natural Earth itself. Natural Earth is public
domain, which is the reason it is used here rather than any tiled basemap.

The coastlines are open polylines, Douglas-Peucker simplified, as integers in
hundredths of a degree: an absolute first point, then deltas. The page draws
them as 1-CSS-px lines. The land itself, its height and the night lights come
from build-aurora-earth.py, which also borrows this file's fetch and scanlines.

Source is Natural Earth 50m land, with the largest lakes cut out of it. 50m
rather than 110m because the opening view sits close over Ireland, where the
110m coast is a polygon of a dozen points. The lakes matter in the auroral
zone: Great Bear, Great Slave, Winnipeg and the Great Lakes are how Canada is
recognised from above.

Scanner below finds land by scanline, not by testing each point against each
polygon: every edge is filed under the latitude bands it crosses, and the
crossings of one latitude are sorted once. build-aurora-earth.py rasterises
the land with it.

Stdlib only. Fetches go through curl, as in build-speaking-map.py: the
python.org build ships no CA bundle and urlopen fails on GitHub without one.
"""

import datetime
import json
import math
import os
import subprocess
import sys

BASE = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
        "master/geojson/")
LAND = "ne_50m_land.geojson"
LAKES = "ne_50m_lakes.geojson"

OUT = "assets/data/aurora/globe.json"

# Latitude bands for filing edges, in degrees.
BAND = 0.5

# Only lakes this big are cut out of the land (bounding-box diagonal, degrees).
# Smaller ones would only be noise at the globe's scale.
LAKE_MIN_SPAN = 1.6

# Douglas-Peucker tolerance in degrees of arc. The opening view draws a degree
# at about 12 CSS px at most, so this stays under a pixel.
TOLERANCE = 0.05

# Drop coastline runs smaller than this (bounding-box diagonal, degrees):
# the land field already shows islets, and a ring of four points is just a scratch.
COAST_MIN_SPAN = 0.35

PRECISION = 100  # hundredths of a degree


def fetch(name):
    if len(sys.argv) > 1:
        path = os.path.join(sys.argv[1], name)
        print("reading %s" % path)
        with open(path) as handle:
            return json.load(handle)
    url = BASE + name
    print("fetching %s" % url)
    raw = subprocess.run(["curl", "-sSfL", "--max-time", "90", url],
                         check=True, capture_output=True).stdout
    return json.loads(raw)


def polygons(geometry):
    kind = geometry["type"]
    if kind == "Polygon":
        yield geometry["coordinates"]
    elif kind == "MultiPolygon":
        for polygon in geometry["coordinates"]:
            yield polygon


def span(points):
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return math.hypot(max(lons) - min(lons), max(lats) - min(lats))


class Scanner:
    """Even-odd membership for a set of rings, by sorted scanline crossings."""

    def __init__(self, rings):
        self.bands = {}
        for ring in rings:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if y1 == y2:
                    continue
                lo, hi = min(y1, y2), max(y1, y2)
                for b in range(int(math.floor(lo / BAND)),
                               int(math.floor(hi / BAND)) + 1):
                    self.bands.setdefault(b, []).append((x1, y1, x2, y2))

    def crossings(self, y):
        xs = []
        for x1, y1, x2, y2 in self.bands.get(int(math.floor(y / BAND)), ()):
            if (y1 > y) != (y2 > y):
                xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        return xs


def is_cut(a, b):
    """Edges Natural Earth adds to close rings: the antimeridian and the pole."""
    if abs(a[0]) >= 179.999 and abs(b[0]) >= 179.999:
        return True
    if a[1] <= -89.99 and b[1] <= -89.99:
        return True
    return False


def runs(ring):
    """A closed ring as the open polylines left after dropping cut edges."""
    out, run = [], []
    for a, b in zip(ring, ring[1:]):
        if is_cut(a, b):
            if len(run) > 1:
                out.append(run)
            run = []
            continue
        if not run:
            run.append(a)
        run.append(b)
    if len(run) > 1:
        out.append(run)
    return out


def simplify(points, tol):
    """Douglas-Peucker, with longitude scaled by cos(latitude) so the
    tolerance is a true angle everywhere, not just at the equator."""
    if len(points) < 3:
        return points
    mid = sum(p[1] for p in points) / len(points)
    kx = math.cos(math.radians(mid))
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = points[i][0] * kx, points[i][1]
        bx, by = points[j][0] * kx, points[j][1]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, at = -1.0, -1
        for k in range(i + 1, j):
            px, py = points[k][0] * kx, points[k][1]
            if norm == 0.0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dx * (ay - py) - dy * (ax - px)) / norm
            if d > best:
                best, at = d, k
        if at >= 0 and best > tol:
            keep[at] = True
            stack.append((i, at))
            stack.append((at, j))
    return [p for p, k in zip(points, keep) if k]


def encode(points):
    flat = []
    px = py = 0
    for n, (lon, lat) in enumerate(points):
        x = int(round(lon * PRECISION))
        y = int(round(lat * PRECISION))
        if n == 0:
            flat += [x, y]
        elif x != px or y != py:
            flat += [x - px, y - py]
        px, py = x, y
    return flat


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    os.chdir(root)

    land_rings = []
    for feature in fetch(LAND)["features"]:
        for polygon in polygons(feature["geometry"]):
            land_rings.extend(polygon)

    lake_rings, lake_names = [], []
    for feature in fetch(LAKES)["features"]:
        for polygon in polygons(feature["geometry"]):
            if span(polygon[0]) >= LAKE_MIN_SPAN:
                lake_rings.extend(polygon)
                lake_names.append(feature["properties"].get("name") or "?")
    print("cutting %d lakes: %s" % (len(lake_names), ", ".join(sorted(set(lake_names)))))

    coast = []
    vertices = 0
    for ring in land_rings + lake_rings:
        for run in runs(ring):
            if span(run) < COAST_MIN_SPAN:
                continue
            simple = simplify(run, TOLERANCE)
            if len(simple) < 2:
                continue
            coast.append(encode(simple))
            vertices += len(simple)

    out = {
        "source": "Natural Earth 50m land and lakes (public domain)",
        "built": datetime.date.today().isoformat(),
        "precision": PRECISION,
        "coast": coast,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as handle:
        json.dump(out, handle, separators=(",", ":"))

    print("wrote %s — %d coast runs, %d vertices, %.1f KB"
          % (OUT, len(coast), vertices, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
