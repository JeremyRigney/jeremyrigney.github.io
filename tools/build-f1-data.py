#!/usr/bin/env python3
"""
Build the vendored data behind /f1.

The page itself is static: it ships with everything it needs and makes at most one
best-effort network call at runtime. All the expensive work — resampling circuit
geometry, sampling a digital elevation model along it, and tallying race history —
happens here, offline, and lands in assets/data/f1/.

Run it after a race weekend to refresh last-winner and fastest-lap figures:

    python3 tools/build-f1-data.py            # current season
    python3 tools/build-f1-data.py --season 2027
    python3 tools/build-f1-data.py --only nl-1948
    python3 tools/build-f1-data.py --corners-only       # turns/markers, from disk
    python3 tools/build-f1-data.py --silhouettes-only   # offline, from disk

Sources
  Circuit geometry   bacinger/f1-circuits (GeoJSON, 2D lon/lat, ~40 m point spacing)
  Corner numbers     api.multiviewer.app (the same maps FastF1 exposes as
                     get_circuit_info(); hand-built by MultiViewer)
  Elevation          api.opentopodata.org (EU-DEM 25 m / NED 10 m / Mapzen global)
  Race history       api.jolpi.ca (the Ergast successor; Ergast shut down early 2025)

Stdlib only, no pip installs. Note that HTTP goes through curl rather than urllib:
the python.org 3.13 build on macOS ships without a usable CA bundle, so urllib
raises CERTIFICATE_VERIFY_FAILED on every one of these hosts.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), 'assets', 'data', 'f1')

GEOJSON_URL = 'https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson'
JOLPICA = 'https://api.jolpi.ca/ergast/f1'
TOPO = 'https://api.opentopodata.org/v1'

# Resample spacing along the track, in metres. The source polylines are only
# accurate to ~35-46 m between points, so this is a smoothing/rendering choice
# rather than added precision: 15 m gives the ribbon enough vertices to look
# continuous at the tilt without bloating the per-circuit JSON past ~15 KB.
STEP_M = 15.0

# Circular moving-average window applied to the sampled elevations, in samples.
# 5 * 15 m = 75 m, which is just above the DEM's own resolution — enough to kill
# per-pixel noise, short enough to keep Eau Rouge and Raidillon distinct.
ELEV_SMOOTH_WINDOW = 5

# opentopodata's free tier: 100 locations per call, 1 call/sec, 1000 calls/day.
TOPO_BATCH = 100
TOPO_SLEEP = 1.3
JOLPICA_SLEEP = 1.0

M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON = 111320.0

# MultiViewer's circuit maps, which is where the real corner numbers come from.
# Public, unauthenticated, and the same data FastF1 surfaces as get_circuit_info();
# MultiViewer hand-build it and FastF1 credit them for it. The year in the path is
# lenient — it falls back to the newest map on file for that circuit.
#
# It works in decimetres: trackPosition, the x/y outline and a corner's `length`
# are all in the same units, so the ratios taken below cancel them out.
MULTIVIEWER = 'https://api.multiviewer.app/api/v1/circuits'

# geo id (bacinger) -> MultiViewer circuit key. Written out rather than matched on
# name because there are three US circuits and two Italian ones in the set, and a
# near-miss here silently numbers the wrong track.
#
# Absent: es-2026 (Madrid, too new for MultiViewer) and my-1999 (Sepang, a stale
# file from an older calendar). Those fall back to detect_turns().
MV_CIRCUIT_KEYS = {
    'ae-2009': 70,   # Yas Marina
    'at-1969': 19,   # Spielberg
    'au-1953': 10,   # Melbourne
    'az-2016': 144,  # Baku
    'be-1925': 7,    # Spa-Francorchamps
    'br-1940': 14,   # Interlagos
    'ca-1978': 23,   # Montreal
    'cn-2004': 49,   # Shanghai
    'es-1991': 15,   # Catalunya
    'gb-1948': 2,    # Silverstone
    'hu-1986': 4,    # Hungaroring
    'it-1922': 39,   # Monza
    'jp-1962': 46,   # Suzuka
    'mc-1929': 22,   # Monte Carlo
    'mx-1962': 65,   # Mexico City
    'nl-1948': 55,   # Zandvoort
    'qa-2004': 150,  # Losail
    'sg-2008': 61,   # Singapore
    'us-2012': 9,    # Austin
    'us-2022': 151,  # Miami
    'us-2023': 152,  # Las Vegas
}

# How far a corner may be moved off the arc-length model when it is snapped onto
# our own path, in metres. This window is load-bearing: an unconstrained nearest-
# point search puts Baku's turn 6 two and a half kilometres away, by snapping onto
# the wrong branch where the track runs back alongside itself.
MV_SNAP_WINDOW_M = 100.0

# When to distrust the fit and fall back to the provisional detector.
#
# The test is whether each numbered corner lands on a curvature peak of our own
# path, within MV_PEAK_TOLERANCE_M. That is a far better signal than how well the
# two outlines overlap: Las Vegas overlaps poorly (70 m) yet numbers correctly,
# while Singapore overlaps well (24 m) and numbers wrongly, because the source
# geometry there is the pre-2023 layout and MultiViewer's map is the current one.
#
# A good fit scores 0.9-1.0 — Zandvoort 14/14, Austin 19/20. Singapore manages
# 12/19 and is rejected.
MV_PEAK_TOLERANCE_M = 45.0
MV_FIT_MIN_ON_PEAK = 0.75

# How far the fitted map transform may leave the MultiViewer outline from our own path
# before the live map gives up and draws no cars. A modern circuit is 12-15 m wide, so a
# residual inside this keeps a car on the tarmac it is actually on; beyond it, the dots
# would be visibly beside the track and no map is better than a wrong one.
MAP_FIT_MAX_RESIDUAL_M = 12.0


# ---------------------------------------------------------------- http


def fetch(url, params=None, retries=3):
    """GET JSON via curl. See the module docstring for why this isn't urllib."""
    cmd = ['curl', '-s', '-S', '-m', '90', '-G', url]
    for key, value in (params or {}).items():
        cmd += ['--data-urlencode', '%s=%s' % (key, value)]

    for attempt in range(retries):
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0 and proc.stdout.strip():
            try:
                return json.loads(proc.stdout)
            except json.JSONDecodeError:
                pass  # rate-limit pages and gateway errors arrive as HTML
        if attempt < retries - 1:
            time.sleep(3 * (attempt + 1))
    raise SystemExit('failed to fetch %s\n%s' % (url, proc.stdout[:400] or proc.stderr[:400]))


# ---------------------------------------------------------------- geometry


def local_metres(coords, lat0):
    """Equirectangular projection about lat0. Fine over a ~7 km circuit."""
    scale = M_PER_DEG_LON * math.cos(math.radians(lat0))
    return [(lon * scale, lat * M_PER_DEG_LAT) for lon, lat in coords]


def centroid(coords):
    return (sum(c[0] for c in coords) / len(coords),
            sum(c[1] for c in coords) / len(coords))


def catmull_rom(coords, subdivisions=6):
    """
    Densify a closed polyline with a centripetal Catmull-Rom spline.

    The source geometry is coarse enough that resampling it directly leaves
    visible facets on tight corners. Splining first rounds those out, and the
    curve passes through every original point so the racing line stays honest.
    """
    n = len(coords)
    out = []
    for i in range(n):
        p0 = coords[(i - 1) % n]
        p1 = coords[i]
        p2 = coords[(i + 1) % n]
        p3 = coords[(i + 2) % n]
        for k in range(subdivisions):
            t = k / float(subdivisions)
            t2 = t * t
            t3 = t2 * t
            out.append((
                0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t
                       + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                       + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t
                       + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                       + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
            ))
    return out


def resample(coords, step):
    """
    Walk a closed lon/lat ring at uniform arc length.

    Returns (points, perimeter_m). Points are lon/lat; spacing is uniform in
    metres, which is what lets every downstream marker be addressed by a single
    scalar `s` (distance from start/finish) instead of an index into a ragged array.
    """
    lat0 = centroid(coords)[1]
    metres = local_metres(coords, lat0)

    cumulative = [0.0]
    for a, b in zip(metres, metres[1:]):
        cumulative.append(cumulative[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    perimeter = cumulative[-1]

    count = int(perimeter // step)
    points = []
    j = 0
    for k in range(count):
        s = k * step
        while j < len(cumulative) - 2 and cumulative[j + 1] < s:
            j += 1
        span = cumulative[j + 1] - cumulative[j]
        t = (s - cumulative[j]) / span if span > 1e-9 else 0.0
        points.append((
            round(coords[j][0] + (coords[j + 1][0] - coords[j][0]) * t, 6),
            round(coords[j][1] + (coords[j + 1][1] - coords[j][1]) * t, 6),
        ))
    return points, perimeter


def curvature(points, lat0):
    """
    Signed heading change per point, in degrees per metre.

    Positive is a left turn. Used only to place provisional corner markers —
    see detect_turns for the caveat about official numbering.
    """
    metres = local_metres(points, lat0)
    n = len(metres)
    out = []
    for i in range(n):
        a = metres[(i - 1) % n]
        b = metres[i]
        c = metres[(i + 1) % n]
        h1 = math.atan2(b[1] - a[1], b[0] - a[0])
        h2 = math.atan2(c[1] - b[1], c[0] - b[0])
        delta = math.degrees(h2 - h1)
        while delta > 180:
            delta -= 360
        while delta < -180:
            delta += 360
        out.append(delta / STEP_M)
    return out


def smooth_circular(values, window):
    n = len(values)
    half = window // 2
    return [sum(values[(i + k) % n] for k in range(-half, half + 1)) / float(window)
            for i in range(n)]


# ---------------------------------------------------------------- markers


def detect_turns(points, lat0, threshold=0.09):
    """
    Provisional corner markers, derived from geometry alone.

    These are NOT official FIA corner numbers. The detector finds contiguous runs
    of sustained curvature and takes the apex of each, numbering them from
    start/finish. It gets the count roughly right on most circuits but will
    disagree with the official map wherever a sequence is numbered as one corner
    or split into lettered ones (Suzuka's Esses, Spa's Eau Rouge/Raidillon).

    Everything is emitted with provisional=True so the page can label it honestly.
    Replacing it later means overwriting the `turns` array with real numbers at
    real `s` values — nothing else in the pipeline or the renderer needs to change.
    """
    curv = smooth_circular(curvature(points, lat0), 5)
    n = len(curv)

    runs = []
    current = None
    for i in range(n * 2):  # two laps, so a corner straddling s=0 isn't split
        idx = i % n
        if abs(curv[idx]) >= threshold:
            if current is None:
                current = [idx]
            else:
                current.append(idx)
        elif current is not None:
            if i <= n or current[0] > current[-1]:
                runs.append(current)
            current = None
            if i >= n:
                break
    if current is not None:
        runs.append(current)

    seen = set()
    turns = []
    for run in runs:
        # A corner has to be long enough to be a corner and not DEM-grade wobble.
        if len(run) * STEP_M < 25:
            continue
        apex = max(run, key=lambda i: abs(curv[i]))
        if any(abs(apex - s) * STEP_M < 60 for s in seen):
            continue
        seen.add(apex)
        turns.append({
            's': round(apex * STEP_M, 1),
            'dir': 'left' if curv[apex] > 0 else 'right',
            'provisional': True,
        })

    turns.sort(key=lambda t: t['s'])
    for i, turn in enumerate(turns):
        turn['n'] = i + 1
    return [{'n': t['n'], 's': t['s'], 'dir': t['dir'], 'provisional': True} for t in turns]


def detect_straights(points, lat0, min_length=350.0):
    """Contiguous low-curvature runs, longest first, as (start_s, end_s, length)."""
    curv = smooth_circular(curvature(points, lat0), 5)
    n = len(curv)

    straights = []
    start = None
    for i in range(n * 2):
        idx = i % n
        if abs(curv[idx]) < 0.03:
            if start is None:
                start = i
        elif start is not None:
            length = (i - start) * STEP_M
            if length >= min_length:
                straights.append((start % n * STEP_M, idx * STEP_M, length))
            start = None
            if i >= n:
                break

    straights.sort(key=lambda s: -s[2])
    return straights


def place_markers(start_s):
    """
    Trackside markers. Currently just the start/finish line.

    This used to also emit DRS detection, DRS activation and speed-trap markers,
    placed by geometry on the longest straight. DRS does not exist under the 2026
    regulations — Overtake Mode is armed at a detection line instead — and the FIA
    have not published where those lines sit, so there is nothing honest to draw
    there yet. detect_straights() is kept above for when they do.

    `start_s` is 0 — the start of the source polyline — on every circuit whose ring
    genuinely begins on the pit straight, and align_corners' correction on the two
    where it does not. See the note there.
    """
    return [{'type': 'start-finish', 's': round(start_s, 1), 'provisional': False}]


# ---------------------------------------------------------------- real corners


def _centroid_xy(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def _rotate_one(x, y, theta):
    c, s = math.cos(theta), math.sin(theta)
    return (x * c - y * s, x * s + y * c)


def _pca_angle(pts):
    """The angle of the point cloud's principal axis, about its own centroid."""
    cx, cy = _centroid_xy(pts)
    sxx = sum((p[0] - cx) ** 2 for p in pts)
    syy = sum((p[1] - cy) ** 2 for p in pts)
    sxy = sum((p[0] - cx) * (p[1] - cy) for p in pts)
    return 0.5 * math.atan2(2 * sxy, sxx - syy)


def _ring_perimeter(pts):
    n = len(pts)
    return sum(math.hypot(pts[(i + 1) % n][0] - pts[i][0],
                          pts[(i + 1) % n][1] - pts[i][1]) for i in range(n))


def _chamfer(a, b):
    """RMS distance from every point of a to its nearest neighbour in b."""
    total = 0.0
    for qx, qy in a:
        best = float('inf')
        for rx, ry in b:
            d = (qx - rx) ** 2 + (qy - ry) ** 2
            if d < best:
                best = d
        total += best
    return math.sqrt(total / len(a))


def _subsample(pts, target):
    return pts[::max(1, len(pts) // target)]


def _circular_offset(residuals, period):
    """
    A robust average of offsets that live on a loop.

    Plain median is wrong when the values straddle the wrap (359 and 1 average to
    180, not 0), so take the circular mean first, fold every residual into the half
    period either side of it, and median those.

    Spread comes back as the interquartile range rather than min-to-max: a couple
    of corners always land on the wrong branch at this stage, where the track runs
    back alongside itself, and one such outlier would otherwise make a good fit
    look like a lap-wide disagreement. Returns (offset, spread).
    """
    sin_sum = sum(math.sin(2 * math.pi * r / period) for r in residuals)
    cos_sum = sum(math.cos(2 * math.pi * r / period) for r in residuals)
    mean = (math.atan2(sin_sum, cos_sum) / (2 * math.pi)) * period

    folded = []
    for r in residuals:
        d = (r - mean + period / 2) % period - period / 2
        folded.append(d)
    folded.sort()
    mid = folded[len(folded) // 2] if len(folded) % 2 else \
        (folded[len(folded) // 2 - 1] + folded[len(folded) // 2]) / 2.0

    spread = folded[(3 * len(folded)) // 4] - folded[len(folded) // 4]
    return (mean + mid) % period, spread


def _similarity_from(src, dst):
    """
    The rotation, uniform scale and translation that best carries src onto dst.

    Closed form, and in two dimensions it needs no SVD: for centred correspondences the
    optimal angle is atan2 of the cross and dot sums, and the scale follows from their
    magnitude. Reflection is deliberately not a free parameter — handedness has already been
    settled by the search above, and letting it flip here could mirror a circuit.
    """
    n = len(src)
    sx = sum(p[0] for p in src) / n
    sy = sum(p[1] for p in src) / n
    dx = sum(p[0] for p in dst) / n
    dy = sum(p[1] for p in dst) / n

    dot = cross = norm = 0.0
    for (px, py), (qx, qy) in zip(src, dst):
        px, py, qx, qy = px - sx, py - sy, qx - dx, qy - dy
        dot += px * qx + py * qy
        cross += px * qy - py * qx
        norm += px * px + py * py
    if norm <= 0:
        return 1.0, 0.0, 0.0, 0.0

    scale = math.hypot(dot, cross) / norm
    theta = math.atan2(cross, dot)
    cos_t, sin_t = math.cos(theta) * scale, math.sin(theta) * scale
    return (cos_t, sin_t,
            dx - (cos_t * sx - sin_t * sy),
            dy - (sin_t * sx + cos_t * sy))


def _fit_location_transform(place, mv_ring, repo, rounds=12):
    """
    Refine the corner placement into a transform good enough to draw cars with.

    Iterated closest point: carry the outline over with the current estimate, pair each of
    its points with the nearest point on our path, re-solve, repeat. Converges in a handful
    of rounds because the starting placement is already close.

    Returns (affine, median residual in metres). The residual is what tells us whether the
    result can be trusted; a circuit whose outline simply does not match ours produces a
    large one, and the caller drops the transform rather than drawing cars off the track.
    """
    src = [place(x, y) for x, y in mv_ring]
    cos_t, sin_t, tx, ty = 1.0, 0.0, 0.0, 0.0

    for _ in range(rounds):
        moved = [(cos_t * x - sin_t * y + tx, sin_t * x + cos_t * y + ty) for x, y in src]
        paired = [min(repo, key=lambda r: (r[0] - px) ** 2 + (r[1] - py) ** 2)
                  for px, py in moved]
        step = _similarity_from(moved, paired)
        # Compose this step onto the running estimate.
        ncos = step[0] * cos_t - step[1] * sin_t
        nsin = step[1] * cos_t + step[0] * sin_t
        ntx = step[0] * tx - step[1] * ty + step[2]
        nty = step[1] * tx + step[0] * ty + step[3]
        cos_t, sin_t, tx, ty = ncos, nsin, ntx, nty

    def final(x, y):
        px, py = place(x, y)
        return (cos_t * px - sin_t * py + tx, sin_t * px + cos_t * py + ty)

    residuals = []
    for x, y in mv_ring:
        px, py = final(x, y)
        residuals.append(math.sqrt(min((px - rx) ** 2 + (py - ry) ** 2 for rx, ry in repo)))
    residuals.sort()

    ox, oy = final(0.0, 0.0)
    ux, uy = final(1.0, 0.0)
    vx, vy = final(0.0, 1.0)
    return ({'a': ux - ox, 'b': vx - ox, 'c': ox,
             'd': uy - oy, 'e': vy - oy, 'f': oy},
            residuals[len(residuals) // 2])


def align_corners(points, perimeter, lat0, mv):
    """
    Put MultiViewer's official corner numbers onto our own path.

    MultiViewer works in Formula 1's internal coordinate frame; we work in lon/lat.
    Neither the origin, the rotation, the handedness nor the start of the lap is
    shared, so the two have to be fitted to each other:

      1. Procrustes. Centre both rings, scale MultiViewer's by the ratio of
         perimeters, rotate each onto its own principal axis, then search the four
         axis-sign combinations and a small rotation sweep for the lowest Chamfer
         distance. PCA alone is ambiguous on the rounder circuits, which is what
         the sweep is there to recover from.
      2. Arc length. Corners now sit near our path, so each one gives an estimate
         of where the timing line is; the robust average of those is the offset
         between MultiViewer's lap distance and ours.
      3. Refine. Recompute every corner from the arc-length model — which cannot
         jump branches — and only then snap it onto the nearest path point within
         MV_SNAP_WINDOW_M.

    Returns (turns, start_s, report), or (None, None, report) if the fit is too
    poor to trust, in which case the caller falls back to detect_turns().
    """
    corners = mv.get('corners') or []
    if not corners or not mv.get('x'):
        return None, None, {'error': 'no corner data'}

    repo = local_metres(points, lat0)
    rcx, rcy = _centroid_xy(repo)
    repo = [(x - rcx, y - rcy) for x, y in repo]

    mv_ring = [(float(x), float(y)) for x, y in zip(mv['x'], mv['y'])]
    mv_per = _ring_perimeter(mv_ring)
    if mv_per <= 0:
        return None, None, {'error': 'degenerate outline'}
    mcx, mcy = _centroid_xy(mv_ring)
    scale = perimeter / mv_per

    theta_repo = _pca_angle(repo)
    theta_mv = _pca_angle([((x - mcx) * scale, (y - mcy) * scale) for x, y in mv_ring])

    def place(x, y, flip_x, flip_y, dtheta):
        x, y = (x - mcx) * scale, (y - mcy) * scale
        x, y = _rotate_one(x, y, -theta_mv)
        x, y = x * flip_x, y * flip_y
        x, y = _rotate_one(x, y, dtheta)
        return _rotate_one(x, y, theta_repo)

    repo_sub = _subsample(repo, 200)
    mv_sub = _subsample(mv_ring, 200)

    def score(flip_x, flip_y, dtheta):
        return _chamfer([place(x, y, flip_x, flip_y, dtheta) for x, y in mv_sub],
                        repo_sub)

    # Coarse over all four handedness combinations, then refine only the winner —
    # Chamfer at this point count is the expensive part of the whole build.
    best = None
    for flip_x in (1, -1):
        for flip_y in (1, -1):
            for deg in range(-16, 17, 2):
                err = score(flip_x, flip_y, math.radians(deg))
                if best is None or err < best[0]:
                    best = (err, flip_x, flip_y, math.radians(deg))

    chamfer, flip_x, flip_y, dtheta = best
    for quarter in range(-8, 9):
        theta = dtheta + math.radians(quarter * 0.25)
        err = score(flip_x, flip_y, theta)
        if err < chamfer:
            chamfer, dtheta = err, theta

    placed = [place(c['trackPosition']['x'], c['trackPosition']['y'],
                    flip_x, flip_y, dtheta) for c in corners]

    count = len(points)
    # The renderer resolves a marker as round(s / circuit.step), so s has to be
    # measured in STEP_M units, not in perimeter/count.
    step = STEP_M

    def nearest_index(px, py, centre_index=None):
        """Nearest path point, optionally restricted to a window around one index."""
        if centre_index is None:
            candidates = range(count)
        else:
            span = int(MV_SNAP_WINDOW_M / step)
            candidates = [(centre_index + k) % count for k in range(-span, span + 1)]
        best_i, best_d = 0, float('inf')
        for i in candidates:
            d = (px - repo[i][0]) ** 2 + (py - repo[i][1]) ** 2
            if d < best_d:
                best_d, best_i = d, i
        return best_i, math.sqrt(best_d)

    # Step 2: line up MultiViewer's lap distance with ours. Each corner's geometric
    # position, minus the distance MultiViewer says it sits at, is one estimate of
    # the offset between the two; the robust average of all of them is the model.
    #
    # This is deliberately fitted to the corners rather than anchored to either
    # ring's first point. MultiViewer's outline starts wherever the telemetry lap
    # it was traced from happened to be cut, which is up to ~300 m off the timing
    # line, and our own resampled path runs a percent or two long, so an anchored
    # offset drifts by more than the snap window allows by the far side of the lap.
    residuals = []
    for corner, (px, py) in zip(corners, placed):
        idx, _ = nearest_index(px, py)
        along = corner['length'] / mv_per * perimeter
        residuals.append((idx * step - along) % perimeter)
    offset, spread = _circular_offset(residuals, perimeter)

    # Step 3: rebuild from the model, then snap within the window.
    curv = smooth_circular(curvature(points, lat0), 5)
    turns = []
    max_snap = 0.0
    for corner, (px, py) in zip(corners, placed):
        along = corner['length'] / mv_per * perimeter
        model = (along + offset) % perimeter
        idx, dist = nearest_index(px, py, int(round(model / step)) % count)
        max_snap = max(max_snap, dist)
        turns.append({
            'n': int(corner['number']),
            'letter': corner.get('letter') or '',
            's': round(idx * step, 1),
            'index': idx,
            'dir': 'left' if curv[idx] > 0 else 'right',
            'provisional': False,
        })

    # Two corners landing on the same path point would draw on top of each other,
    # since the renderer addresses markers as round(s / step). Nudge them apart.
    turns.sort(key=lambda t: t['n'])
    for i in range(1, len(turns)):
        if turns[i]['index'] == turns[i - 1]['index']:
            turns[i]['index'] = (turns[i - 1]['index'] + 1) % count
            turns[i]['s'] = round(turns[i]['index'] * step, 1)

    # Corner numbers run in lap order, so their positions must ascend all the way
    # round with exactly one wrap back past the timing line. More than one wrap
    # means corners have been placed out of sequence and the fit is not usable.
    wraps = sum(1 for i in range(len(turns))
                if turns[i]['s'] <= turns[i - 1]['s'])

    # The strongest check available: does each numbered corner actually land on a
    # corner of *our* track? Chamfer only says the two outlines overlap, which can
    # be true while the numbering is still sliding along the lap.
    peaks = [i for i in range(count)
             if abs(curv[i]) >= abs(curv[(i - 1) % count])
             and abs(curv[i]) >= abs(curv[(i + 1) % count])
             and abs(curv[i]) > 0.05]
    on_peak = 0
    if peaks:
        for turn in turns:
            i = int(round(turn['s'] / step)) % count
            gap = min(min(abs(i - p), count - abs(i - p)) for p in peaks) * step
            if gap <= MV_PEAK_TOLERANCE_M:
                on_peak += 1

    # The source polylines are supposed to begin on the start/finish straight, and
    # on 18 of the 20 circuits here they do. Monaco and Silverstone are the
    # exceptions: their rings begin mid-lap, which puts the chequered flag several
    # corners away from the pit straight.
    #
    # Now that the corner numbers are real, that is detectable without any outside
    # data — turn 1 is by definition the first corner after the line, so s = 0 has
    # to fall in the arc between the last corner and turn 1. Where it doesn't, the
    # line is moved to sit turn 1's own stated distance back from turn 1. That is a
    # short measurement along the track, so it carries almost none of the scale
    # error that fitting across the whole lap would.
    #
    # Where the ring does start on the straight, leave it alone: that is the more
    # accurate of the two, and re-deriving it would only add error.
    first = min(turns, key=lambda t: (t['n'], t['letter']))
    last = max(turns, key=lambda t: (t['n'], t['letter']))
    consistent = (first['s'] % perimeter) < ((first['s'] - last['s']) % perimeter)
    if consistent:
        start_s = 0.0
    else:
        lead = min(corners, key=lambda c: c['number'])['length'] / mv_per * perimeter
        start_s = round((first['s'] - lead) % perimeter, 1)

    # The fitted placement, as six numbers the browser can apply, for putting live cars on
    # the track map. OpenF1's `location` stream is in the same F1 coordinate frame as
    # MultiViewer's outline (verified — their extents agree to 0.2%), so a transform that
    # lands the outline on our path lands the telemetry on it too.
    #
    # The placement above is *not* good enough for this on its own. It is tuned to put corner
    # numbers in the right place, which is why onPeak is what gates it, and it takes its scale
    # from the ratio of perimeters — and a MultiViewer outline traced round a racing line is
    # systematically shorter than our resampled centreline. At Monza that left real telemetry
    # a median 19.5 m off the track and 102 m off at worst, which is plainly visible.
    #
    # So the map gets its own refinement: a few rounds of closest-point fitting against our
    # path, solving for rotation, uniform scale and translation each time. It only ever feeds
    # locationTransform, so the corner placement scored above is untouched by it.
    transform, residual = _fit_location_transform(
        lambda x, y: place(x, y, flip_x, flip_y, dtheta), mv_ring, repo)

    report = {
        'fitResidual': residual,
        'corners': len(turns),
        'chamfer': chamfer,
        'spread': spread,
        'maxSnap': max_snap,
        'wraps': wraps,
        'onPeak': on_peak / float(len(turns)),
        'lineMoved': not consistent,
        'transform': transform,
    }
    for turn in turns:
        del turn['index']
    return turns, start_s, report


def fetch_mv_circuit(geo_id, season):
    """MultiViewer's map for a circuit, or None if we have no key for it."""
    key = MV_CIRCUIT_KEYS.get(geo_id)
    if key is None:
        return None
    try:
        return fetch('%s/%d/%s' % (MULTIVIEWER, key, season))
    except SystemExit:
        return None


# ---------------------------------------------------------------- elevation


def dem_for(lon, lat):
    """
    Pick the sharpest DEM covering a point.

    EU-DEM is 25 m across the EEA, NED is 10 m across the continental US, and
    Mapzen is a global blend of whatever is best available. Ordered best-first;
    sample_elevation falls back down the list when a dataset returns null.
    """
    if -12 <= lon <= 35 and 34 <= lat <= 62:
        return ['eudem25m', 'mapzen']
    if -125 <= lon <= -66 and 24 <= lat <= 50:
        return ['ned10m', 'mapzen']
    return ['mapzen', 'srtm30m']


def sample_elevation(points):
    """
    Sample a DEM along the track.

    This is terrain, not track surface: bridges, tunnels and cuttings will read
    wrong, and DEMs predating a circuit's rebuild will miss new banking. It is
    accurate enough for a vertically exaggerated ribbon, and the page says so.
    """
    datasets = dem_for(points[0][0], points[0][1])
    elevations = [None] * len(points)

    for dataset in datasets:
        missing = [i for i, e in enumerate(elevations) if e is None]
        if not missing:
            break
        for start in range(0, len(missing), TOPO_BATCH):
            chunk = missing[start:start + TOPO_BATCH]
            locations = '|'.join('%f,%f' % (points[i][1], points[i][0]) for i in chunk)
            payload = fetch('%s/%s' % (TOPO, dataset), {'locations': locations})
            if payload.get('status') != 'OK':
                print('      %s: %s' % (dataset, payload.get('error', '?')[:80]))
                break
            for i, result in zip(chunk, payload['results']):
                elevations[i] = result['elevation']
            time.sleep(TOPO_SLEEP)

    if any(e is None for e in elevations):
        # Bridge isolated gaps from their neighbours rather than dropping the circuit.
        n = len(elevations)
        known = [i for i, e in enumerate(elevations) if e is not None]
        if not known:
            raise SystemExit('no elevation data returned')
        for i, e in enumerate(elevations):
            if e is None:
                nearest = min(known, key=lambda k: min(abs(k - i), n - abs(k - i)))
                elevations[i] = elevations[nearest]

    return [round(e, 1) for e in smooth_circular(elevations, ELEV_SMOOTH_WINDOW)]


# ---------------------------------------------------------------- race history


def parse_lap_time(text):
    """'1:12.271' -> seconds."""
    try:
        minutes, seconds = text.split(':')
        return int(minutes) * 60 + float(seconds)
    except (ValueError, AttributeError):
        return None


def driver_name(driver):
    return ('%s %s' % (driver.get('givenName', ''), driver.get('familyName', ''))).strip()


def circuit_stats(circuit_id):
    """
    Winners, most-wins tallies, and the fastest lap of the most recent race there.

    Two calls per circuit. Jolpica allows 200 requests/hour unauthenticated, which
    is why this runs here and not in the browser.
    """
    stats = {
        'lastWinner': None, 'fastestLap': None,
        'mostWinsDrivers': [], 'mostWinsConstructors': [],
        'laps': None, 'raceDistanceKm': None, 'racesHeld': 0,
    }

    payload = fetch('%s/circuits/%s/results/1/' % (JOLPICA, circuit_id),
                    {'format': 'json', 'limit': 100})
    time.sleep(JOLPICA_SLEEP)
    races = payload['MRData']['RaceTable']['Races']
    if not races:
        return stats  # a brand-new circuit, e.g. Madring in 2026

    stats['racesHeld'] = int(payload['MRData']['total'])

    drivers = {}
    constructors = {}
    for race in races:
        result = race['Results'][0]
        key = driver_name(result['Driver'])
        drivers[key] = drivers.get(key, 0) + 1
        team = result['Constructor']['name']
        constructors[team] = constructors.get(team, 0) + 1

    stats['mostWinsDrivers'] = [
        {'name': name, 'wins': wins}
        for name, wins in sorted(drivers.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    ]
    stats['mostWinsConstructors'] = [
        {'name': name, 'wins': wins}
        for name, wins in sorted(constructors.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    ]

    latest = races[-1]
    winner = latest['Results'][0]
    stats['lastWinner'] = {
        'season': latest['season'],
        'raceName': latest['raceName'],
        'driver': driver_name(winner['Driver']),
        'code': winner['Driver'].get('code'),
        'constructor': winner['Constructor']['name'],
        'time': (winner.get('Time') or {}).get('time'),
        'grid': winner.get('grid'),
    }
    if winner.get('laps'):
        stats['laps'] = int(winner['laps'])

    payload = fetch('%s/%s/circuits/%s/results/' % (JOLPICA, latest['season'], circuit_id),
                    {'format': 'json', 'limit': 100})
    time.sleep(JOLPICA_SLEEP)
    full = payload['MRData']['RaceTable']['Races']
    if full:
        timed = [r for r in full[0]['Results']
                 if r.get('FastestLap', {}).get('Time', {}).get('time')]
        if timed:
            best = min(timed, key=lambda r: parse_lap_time(r['FastestLap']['Time']['time']))
            stats['fastestLap'] = {
                'season': full[0]['season'],
                'driver': driver_name(best['Driver']),
                'constructor': best['Constructor']['name'],
                'time': best['FastestLap']['Time']['time'],
                'lap': best['FastestLap'].get('lap'),
                'speed': (best['FastestLap'].get('AverageSpeed') or {}).get('speed'),
            }

    return stats


# ---------------------------------------------------------------- build


def match_geo_id(features, lat, lon):
    """
    Match a Jolpica circuit to a bacinger feature by proximity.

    Nearest centroid rather than a hardcoded id table, so a new circuit joining the
    calendar needs no code change. Circuits sharing a country are hundreds of km
    apart, so the 25 km guard is generous and still unambiguous.
    """
    best = None
    best_distance = None
    for feature in features:
        coords = feature['geometry']['coordinates']
        clon, clat = centroid(coords)
        dx = (clon - lon) * M_PER_DEG_LON * math.cos(math.radians(lat))
        dy = (clat - lat) * M_PER_DEG_LAT
        distance = math.hypot(dx, dy)
        if best_distance is None or distance < best_distance:
            best, best_distance = feature, distance
    if best_distance is not None and best_distance > 25000:
        return None, best_distance
    return best, best_distance


def resolve_turns(points, perimeter, lat0, geo_id, season):
    """
    Official corners where MultiViewer has the circuit, curvature where it doesn't.

    Returns (turns, start_s, source). The fit is rejected — and the provisional
    detector used instead — when the shapes don't agree well enough for the corner
    numbers to be trustworthy, so a bad map never silently mislabels a circuit.
    """
    mv = fetch_mv_circuit(geo_id, season)
    if mv:
        turns, start_s, report = align_corners(points, perimeter, lat0, mv)
        if turns and report['onPeak'] >= MV_FIT_MIN_ON_PEAK and report['wraps'] <= 1:
            print('    %d corners from MultiViewer (%.0f%% on a corner, '
                  'outlines %.1f m apart, snap %.1f m)%s'
                  % (report['corners'], report['onPeak'] * 100,
                     report['chamfer'], report['maxSnap'],
                     '; start/finish moved to %.0f m' % start_s
                     if report['lineMoved'] else ''))
            # The map's own acceptance test, separate from the corner fit's. A circuit can
            # have perfectly placed corner numbers and still be too loosely aligned to draw
            # cars on, so this is gated on the measured residual rather than inherited.
            transform = None
            if report['fitResidual'] <= MAP_FIT_MAX_RESIDUAL_M:
                transform = dict(report['transform'])
                transform['residual'] = round(report['fitResidual'], 2)
                transform['source'] = 'multiviewer'
                print('    map transform fitted, telemetry lands %.1f m from the centreline'
                      % report['fitResidual'])
            else:
                print('    map transform rejected (%.1f m residual) — the map will draw no cars'
                      % report['fitResidual'])
            return turns, start_s, 'multiviewer', transform
        print('    MultiViewer fit rejected (%s) — falling back to curvature'
              % (report.get('error')
                 or '%.0f%% on a corner, %d wraps'
                 % (report['onPeak'] * 100, report['wraps'])))

    # No usable fit means no transform, and the map simply draws no cars rather than
    # drawing them in the wrong place.
    turns = detect_turns(points, lat0)
    print('    %d provisional turns from curvature' % len(turns))
    return turns, 0.0, 'curvature', None


def build_circuit(feature, round_info, season):
    props = feature['properties']
    coords = feature['geometry']['coordinates']
    if coords[0] == coords[-1]:
        coords = coords[:-1]  # the ring closes itself; resample walks it as a loop

    dense = catmull_rom(coords)
    points, perimeter = resample(dense, STEP_M)
    lat0 = centroid(points)[1]

    print('    %d points, %d m lap' % (len(points), round(perimeter)))
    elevations = sample_elevation(points)
    print('    elevation %.1f-%.1f m, delta %.1f m'
          % (min(elevations), max(elevations), max(elevations) - min(elevations)))

    turns, start_s, source, transform = resolve_turns(
        points, perimeter, lat0, props['id'], season)
    markers = place_markers(start_s)

    return {
        'id': props['id'],
        'name': props['Name'],
        'location': props['Location'],
        'country': props['id'][:2],
        'countryName': round_info['country'],
        'length': props['length'],
        'altitude': props['altitude'],
        'opened': props.get('opened'),
        'firstgp': props.get('firstgp'),
        'perimeter': round(perimeter, 1),
        'step': STEP_M,
        'path': points,
        'elev': elevations,
        'turns': turns,
        'markers': markers,
        'turnSource': source,
        # Maps OpenF1 `location` (F1-frame decimetres) onto this circuit's path, in metres
        # about the path centroid: X = a*x + b*y + c, Y = d*x + e*y + f. Absent when the
        # MultiViewer fit was rejected, in which case the live map draws no cars.
        'locationTransform': transform,
        'elevationSource': dem_for(points[0][0], points[0][1])[0],
    }


def silhouette_for(points):
    """
    A circuit reduced to one closed SVG path, in metres.

    The rotation here deliberately mirrors prepareGeometry() in
    assets/js/f1-circuit.js: centre on the centroid, rotate the point cloud onto
    its principal axis, then recentre on the bounding box. A silhouette therefore
    sits at the same orientation the 3D scene draws the circuit at, so the glyph
    in the season strip reads as the same shape you just scrolled through.

    Coordinates stay in metres and are NOT normalised per circuit. That is the
    whole point of the strip: one shared scale across the season means Monaco
    renders visibly smaller than Spa. Normalising each path to its own box would
    make every circuit the same size and throw the comparison away.
    """
    lat0 = centroid(points)[1]
    metres = local_metres(points, lat0)

    cx0 = sum(p[0] for p in metres) / len(metres)
    cy0 = sum(p[1] for p in metres) / len(metres)
    centred = [(p[0] - cx0, p[1] - cy0) for p in metres]

    sxx = sum(x * x for x, _ in centred)
    syy = sum(y * y for _, y in centred)
    sxy = sum(x * y for x, y in centred)
    theta = 0.5 * math.atan2(2 * sxy, sxx - syy)

    cos = math.cos(-theta)
    sin = math.sin(-theta)
    rotated = [(x * cos - y * sin, x * sin + y * cos) for x, y in centred]

    min_x = min(p[0] for p in rotated)
    max_x = max(p[0] for p in rotated)
    min_y = min(p[1] for p in rotated)
    max_y = max(p[1] for p in rotated)
    mid_x = (min_x + max_x) / 2.0
    mid_y = (min_y + max_y) / 2.0

    # Every 3rd point of a 15 m resample is a vertex every 45 m, which is about
    # the accuracy of the source geometry anyway, and rounding to the metre is
    # well under one screen pixel at the size these glyphs are drawn.
    # SVG's y axis points down; negate so the glyph is not drawn mirrored.
    step = 3
    parts = []
    for i in range(0, len(rotated), step):
        x = int(round(rotated[i][0] - mid_x))
        y = int(round(-(rotated[i][1] - mid_y)))
        parts.append('%s%d %d' % ('M' if not parts else 'L', x, y))

    return {
        'd': ' '.join(parts) + ' Z',
        'w': int(round(max_x - min_x)),
        'h': int(round(max_y - min_y)),
    }


def rebuild_corners(season, only=None):
    """
    Redo turns and markers on the circuit files already on disk.

    Elevation sampling is by far the slowest part of a full build and none of it
    changes here, so this reads each file back, recomputes from its stored path,
    and writes it out again. Only MultiViewer is called.
    """
    index_path = os.path.join(OUT_DIR, 'season-%s.json' % season)
    if not os.path.exists(index_path):
        print('no %s — run a full build first' % index_path)
        return 1
    with open(index_path) as handle:
        season_data = json.load(handle)

    seen = set()
    for round_info in season_data['rounds']:
        geo_id = round_info['geoId']
        if geo_id in seen or (only and only != geo_id):
            continue
        seen.add(geo_id)
        path = os.path.join(OUT_DIR, '%s.json' % geo_id)
        if not os.path.exists(path):
            print('%s: no circuit file, skipped' % geo_id)
            continue
        with open(path) as handle:
            circuit = json.load(handle)

        print('%s (%s)' % (geo_id, circuit['name']))
        points = circuit['path']
        lat0 = centroid(points)[1]
        turns, start_s, source, transform = resolve_turns(
            points, circuit['perimeter'], lat0, geo_id, season)

        circuit['turns'] = turns
        circuit['markers'] = place_markers(start_s)
        circuit['turnSource'] = source
        circuit['locationTransform'] = transform
        with open(path, 'w') as handle:
            json.dump(circuit, handle, separators=(',', ':'))
    return 0


def build_silhouettes(rounds, season):
    """
    Post-pass: one small file holding every circuit of the season as an outline.

    Reads the per-circuit files back off disk rather than re-deriving anything, so
    it costs no network and runs correctly after --only or --skip-elevation.
    """
    circuits = {}
    for round_info in rounds:
        geo_id = round_info['geoId']
        if geo_id in circuits:
            continue
        path = os.path.join(OUT_DIR, '%s.json' % geo_id)
        if not os.path.exists(path):
            print('  %s: no circuit file, skipped' % geo_id)
            continue
        with open(path) as handle:
            circuit = json.load(handle)
        entry = silhouette_for(circuit['path'])
        entry['length'] = circuit['length']
        circuits[geo_id] = entry

    out_path = os.path.join(OUT_DIR, 'silhouettes-%s.json' % season)
    with open(out_path, 'w') as handle:
        json.dump({
            'season': int(season),
            'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'scale': 'metres',
            'circuits': circuits,
        }, handle, separators=(',', ':'))
    print('wrote %s (%.1f KB, %d circuits)'
          % (out_path, os.path.getsize(out_path) / 1024, len(circuits)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--season', default='2026')
    parser.add_argument('--only', help='rebuild a single circuit by geo id, e.g. nl-1948')
    parser.add_argument('--skip-elevation', action='store_true',
                        help='reuse elevations already on disk (fast iteration on stats)')
    parser.add_argument('--silhouettes-only', action='store_true',
                        help='rebuild only silhouettes-<season>.json, from the files '
                             'already on disk (no network)')
    parser.add_argument('--corners-only', action='store_true',
                        help='redo turns and markers on the files already on disk '
                             '(MultiViewer only, no elevation resampling)')
    args = parser.parse_args()

    if args.corners_only:
        return rebuild_corners(args.season, args.only)

    if args.silhouettes_only:
        index_path = os.path.join(OUT_DIR, 'season-%s.json' % args.season)
        if not os.path.exists(index_path):
            print('no %s — run a full build first' % index_path)
            return 1
        with open(index_path) as handle:
            season_data = json.load(handle)
        build_silhouettes(season_data['rounds'], args.season)
        return 0

    os.makedirs(OUT_DIR, exist_ok=True)

    print('fetching circuit geometry')
    geo = fetch(GEOJSON_URL)
    features = geo['features']

    print('fetching %s calendar' % args.season)
    calendar = fetch('%s/%s/races/' % (JOLPICA, args.season), {'format': 'json', 'limit': 50})
    races = calendar['MRData']['RaceTable']['Races']
    print('  %d rounds\n' % len(races))

    rounds = []
    for race in races:
        circuit = race['Circuit']
        location = circuit['Location']
        lat, lon = float(location['lat']), float(location['long'])
        feature, distance = match_geo_id(features, lat, lon)

        label = '%s round %s: %s' % (args.season, race['round'], race['raceName'])
        if feature is None:
            print('%s\n    NO GEOMETRY (nearest %d km) - skipping' % (label, distance / 1000))
            continue

        geo_id = feature['properties']['id']
        print('%s -> %s (%.1f km)' % (label, geo_id, distance / 1000))

        path = os.path.join(OUT_DIR, '%s.json' % geo_id)
        if args.only and args.only != geo_id:
            if os.path.exists(path):
                print('    skipped (--only)')
        elif args.skip_elevation and os.path.exists(path):
            print('    skipped (--skip-elevation)')
        else:
            circuit_data = build_circuit(feature, location, args.season)
            with open(path, 'w') as handle:
                json.dump(circuit_data, handle, separators=(',', ':'))
            print('    wrote %s (%.1f KB)' % (path, os.path.getsize(path) / 1024))

        stats = circuit_stats(circuit['circuitId'])
        if stats['laps'] and feature['properties'].get('length'):
            stats['raceDistanceKm'] = round(
                stats['laps'] * feature['properties']['length'] / 1000.0, 3)
        if stats['lastWinner']:
            print('    last winner %s (%s), %d races held'
                  % (stats['lastWinner']['driver'], stats['lastWinner']['season'],
                     stats['racesHeld']))
        else:
            print('    no race history at this circuit')

        sessions = {}
        for key, label in (('FirstPractice', 'fp1'), ('SecondPractice', 'fp2'),
                           ('ThirdPractice', 'fp3'), ('Qualifying', 'qualifying'),
                           ('Sprint', 'sprint'), ('SprintQualifying', 'sprintQualifying')):
            if race.get(key) and race[key].get('date'):
                sessions[label] = '%sT%s' % (race[key]['date'],
                                             race[key].get('time', '00:00:00Z'))

        rounds.append({
            'round': int(race['round']),
            'name': race['raceName'],
            'circuitId': circuit['circuitId'],
            'circuitName': circuit['circuitName'],
            'geoId': geo_id,
            # Formula 1's own id for the circuit, which is what MultiViewer keys its maps on
            # and what OpenF1 reports as `circuit_key`. It is the only reliable way to get
            # from a timing feed back to our geometry: the short names disagree constantly
            # ("Interlagos" against "Autódromo José Carlos Pace", "Spa-Francorchamps"
            # against "Spa"), and matching on them silently loses circuits.
            'circuitKey': MV_CIRCUIT_KEYS.get(geo_id),
            'locality': location['locality'],
            'country': location['country'],
            'date': race['date'],
            'start': '%sT%s' % (race['date'], race.get('time', '00:00:00Z')),
            'wikipedia': race.get('url'),
            'sessions': sessions,
            'stats': stats,
        })
        print()

    index_path = os.path.join(OUT_DIR, 'season-%s.json' % args.season)
    with open(index_path, 'w') as handle:
        json.dump({
            'season': int(args.season),
            'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'rounds': rounds,
        }, handle, separators=(',', ':'))
    print('wrote %s (%.1f KB, %d rounds)'
          % (index_path, os.path.getsize(index_path) / 1024, len(rounds)))

    build_silhouettes(rounds, args.season)


if __name__ == '__main__':
    sys.exit(main())
