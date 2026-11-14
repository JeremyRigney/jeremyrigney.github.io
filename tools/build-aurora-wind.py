#!/usr/bin/env python3
"""Reduces NOAA's WSA-Enlil solar wind run to what the /aurora page draws.

Run by the scheduled workflow (.github/workflows/aurora-wind.yml), or by hand from the
repo root in a throwaway venv:

    python3 -m venv /tmp/wind-venv
    /tmp/wind-venv/bin/pip install numpy netCDF4 pillow
    /tmp/wind-venv/bin/python -I tools/build-aurora-wind.py --out /tmp/aurora-data

Unlike the other tools/ builders, what this writes is not committed to main: the model
is run again every day, so the workflow publishes the two files to the aurora-data
branch, one commit, replaced each time, and the page reads them from there.

WSA-Enlil is the heliospheric model NOAA's Space Weather Prediction Center forecasts
with: WSA turns a GONG magnetogram into the solar wind at 21.5 solar radii, and Enlil, a
3D MHD code, carries it out to 1.7 AU. SWPC publishes each run's 2D cuts as one NetCDF
file of about 130 MB,

    https://nomads.ncep.noaa.gov/pub/data/nccf/com/wsa_enlil/prod/
        wsa_enlil.YYYYMMDD/wsa_enlil.mridNNNNNNNN.suball.nc

kept for two days. mrid00000000 is the daily ambient run, written about 01:25 UTC; a
run a forecaster makes for a CME carries its run number instead. Each holds 169 hourly
frames, from two days before the run's reference date to five days after, on a grid of
512 radii (0.1 to 1.7 AU) x 60 latitudes x 180 longitudes, in coordinates that keep the
Earth at longitude 0. The page uses one of the cuts,

    vv13_3d  (t, lon, r)  radial speed at the Earth's latitude: the pinwheel seen
                          from the north

and the time series at the Earth (Earth_V1, Earth_Density, Earth_Temperature,
Earth_B1..3). The cuts are int16, scaled by each variable's own *_min and *_max. (The
file also has the cut through the Earth's longitude, vv12_3d, north to south. The page
drew it for a while and it did not earn its place, so it is no longer sent.)

Written to --out:

    wind.png   One greyscale tile per frame, 8 across. A tile is R_BINS rows, the Sun
               end at the top, and 180 columns of longitude (-179 to 179). One byte is
               a speed, from speed.min to
               speed.max in wind.json. Every FRAME_STEP-th hour is kept and radius is
               averaged in fours: on the run this was built against, the speed changes
               by 0.75 km/s from one radial cell to the next and by 0.3 km/s between
               a frame dropped and the blend of its neighbours, both under the 3 km/s
               a byte resolves.
    wind-density.png
               The density in the same layout: protons per cm^3, times r^2 (AU) so
               that it reads as at 1 AU whatever the distance, a byte on a log scale
               from density.min to density.max.
    wind.json  The run it came from, the frame times, the axes and the bytes' scales,
               and the series at the Earth by the half hour.

Which run: the newest CME run on NOMADS if there is one, otherwise the newest ambient
run. A CME run is then held for HOLD_DAYS from its reference date, even after NOMADS
drops it and whatever ambient runs follow, because an ambient run has no CME in it and
would take the storm off the page while it is still on its way. That hold is a guess at
how SWPC's runs relate: no CME run was on NOMADS when this was written. With --published
(the wind.json now on the branch), nothing is written when that file is already the
right run, so the workflow can tell there is nothing to publish.

Fetches go through curl, as in the other tools/ builders. NOMADS sends an HTTP/2 header
curl rejects, hence --http1.1.
"""

import argparse
import datetime
import json
import math
import os
import re
import subprocess
import sys
import tempfile

VERSION = 3  # 1 carried the north-south cut beside each tile; 2 had no density

NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/wsa_enlil/prod/"
RUN_FILE = re.compile(r"wsa_enlil\.mrid(\d{8})\.suball\.nc$")

AU_M = 1.495978707e11
M_HYDROGEN = 1.6735575e-27  # kg, as SWPC's own tools take it

R_BINS = 128  # of the file's 512
FRAME_STEP = 2  # hours
ATLAS_COLS = 8
SPEED_MIN = 200.0  # km/s, byte 0
SPEED_MAX_FLOOR = 900.0  # byte 255, unless the run goes faster
DENSITY_MIN, DENSITY_MAX = 0.5, 200.0  # per cm^3 scaled to 1 AU, bytes 0 and 255 on a log scale
SERIES_STEP_MIN = 30
HOLD_DAYS = 3.0

UTC = datetime.timezone.utc


def iso(t):
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def from_iso(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def curl(args):
    return subprocess.run(["curl", "-sSfL", "--http1.1", "--retry", "3", "--retry-delay", "5"] + args,
                          check=True, capture_output=True)


# ---------------------------------------------------------------- which run

def listing(url):
    """An Apache index as (name, modified) pairs; the times are UTC."""
    html = curl(["--max-time", "60", url]).stdout.decode("utf-8", "replace")
    out = []
    for m in re.finditer(r'<a href="([^"?/][^"]*)">[^<]*</a>\s*(\d\d-\w{3}-\d{4} \d\d:\d\d)', html):
        when = datetime.datetime.strptime(m.group(2), "%d-%b-%Y %H:%M").replace(tzinfo=UTC)
        out.append((m.group(1), when))
    return out


def candidates():
    """Every run on NOMADS: its path under NOMADS, its run number and when it was written."""
    runs = []
    days = sorted(name for name, _ in listing(NOMADS) if re.match(r"wsa_enlil\.\d{8}/$", name))
    for day in days[-3:]:
        for name, when in listing(NOMADS + day):
            m = RUN_FILE.match(name)
            if m:
                runs.append({"file": day + name, "run_id": int(m.group(1)), "modified": when})
    return runs


def choose(runs, published, now):
    """The run to publish, or None to leave what is published alone.

    published is the wind.json on the branch, or None. See the header for the rule.
    """
    current = published if published and published.get("version") == VERSION else None
    held = None
    if current and current["source"]["run_id"] != 0:
        age = (now - from_iso(current["source"]["ref"])).total_seconds() / 86400.0
        if age < HOLD_DAYS:
            held = current

    cme = [r for r in runs if r["run_id"] != 0]
    pool = cme or ([] if held else runs)
    if not pool:
        return None
    pick = max(pool, key=lambda r: r["modified"])
    if held and pick["modified"] <= from_iso(held["source"]["modified"]):
        return None
    if current and current["source"]["file"] == pick["file"] and current["source"]["modified"] == iso(pick["modified"]):
        return None
    return pick


# ---------------------------------------------------------------- the reduction

def reduce(path, source, out_dir):
    import netCDF4
    import numpy as np
    from PIL import Image

    ds = netCDF4.Dataset(path)
    ds.set_auto_maskandscale(False)
    v = ds.variables

    def unpack(name):
        """A packed cut in the file's own units (SI)."""
        var = v[name]
        lo = float(var.getncattr(name[:4] + "_min"))
        hi = float(var.getncattr(name[:4] + "_max"))
        raw = var[:].astype(np.float32)
        return (raw + 32768.0) * ((hi - lo) / 65535.0) + lo

    def cut(name):
        """A packed speed cut as km/s."""
        return unpack(name) / 1e3

    ref = datetime.datetime.strptime(ds.getncattr("REFDATE_CAL"), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
    r = v["x_coord"][:].astype(np.float64) / AU_M
    lon = np.degrees(v["z_coord"][:].astype(np.float64) - math.pi)
    t = v["time"][:].astype(np.float64)  # seconds from ref

    nr, nlon = len(r), len(lon)
    if nr % R_BINS:
        raise SystemExit("the radial grid (%d) does not divide into %d bins" % (nr, R_BINS))
    for name, axis in (("longitude", lon), ("radius", r)):
        steps = np.diff(axis)
        if not np.allclose(steps, steps[0], rtol=0, atol=abs(steps[0]) * 0.01):
            raise SystemExit("the %s axis is not evenly spaced; the page assumes it is" % name)

    # Every FRAME_STEP-th hour from the first frame: the nearest frame to each mark. The
    # frames run a few seconds off the hour, so the last mark is given half an hour's grace.
    marks = np.arange(t[0], t[-1] + 1800.0, FRAME_STEP * 3600.0)
    keep = sorted(set(int(np.argmin(np.abs(t - m))) for m in marks))

    ecl = cut("vv13_3d")[keep]  # t, lon, r
    top = float(ecl.max())
    speed_max = float(min(3000.0, max(SPEED_MAX_FLOOR, math.ceil(top / 100.0) * 100.0)))

    # (t, lon, r) in km/s to bytes as (t, R_BINS, lon).
    binned = ecl.reshape(ecl.shape[0], nlon, R_BINS, nr // R_BINS).mean(axis=3)
    frames = np.clip(np.rint((binned - SPEED_MIN) / (speed_max - SPEED_MIN) * 255.0), 0, 255)
    frames = frames.astype(np.uint8).transpose(0, 2, 1)
    n, th, tw = frames.shape
    rows = -(-n // ATLAS_COLS)

    def tile(frames):
        atlas = np.zeros((rows * th, ATLAS_COLS * tw), np.uint8)
        for k in range(n):
            y, x = (k // ATLAS_COLS) * th, (k % ATLAS_COLS) * tw
            atlas[y:y + th, x:x + tw] = frames[k]
        return atlas

    atlas = tile(frames)

    # The density likewise: mass density to protons per cm^3, as for the Earth series,
    # then times r^2 so it reads as at 1 AU, binned, and a byte on a log scale.
    dens = unpack("dd13_3d")[keep] / M_HYDROGEN / 1e6  # t, lon, r
    dens1au = dens * (r[np.newaxis, np.newaxis, :] ** 2)
    dbinned = dens1au.reshape(dens1au.shape[0], nlon, R_BINS, nr // R_BINS).mean(axis=3)
    span = math.log(DENSITY_MAX / DENSITY_MIN)
    dbytes = np.clip(np.rint(np.log(np.maximum(dbinned, 1e-6) / DENSITY_MIN) / span * 255.0), 0, 255)
    datlas = tile(dbytes.astype(np.uint8).transpose(0, 2, 1))

    # The series at the Earth, by the half hour across the frames' span.
    et = v["Earth_TIME"][:].astype(np.float64)
    step = SERIES_STEP_MIN * 60.0
    edges = np.arange(t[keep[0]] - step / 2, t[keep[-1]] + step, step)
    which = np.digitize(et, edges) - 1
    count = len(edges) - 1

    def series(values, digits):
        out = []
        for i in range(count):
            sel = values[which == i]
            out.append(None if not len(sel) else round(float(sel.mean()), digits))
        return out

    b = np.sqrt(v["Earth_B1"][:].astype(np.float64) ** 2 + v["Earth_B2"][:].astype(np.float64) ** 2
                + v["Earth_B3"][:].astype(np.float64) ** 2) * 1e9
    earth_v = v["Earth_V1"][:].astype(np.float64) / 1e3
    earth = {
        "r": round(float(np.median(v["Earth_X1"][:])) / AU_M, 4),
        "start": iso(ref + datetime.timedelta(seconds=float(edges[0] + step / 2))),
        "step_min": SERIES_STEP_MIN,
        "speed": series(earth_v, 1),  # km/s
        "density": series(v["Earth_Density"][:].astype(np.float64) / M_HYDROGEN / 1e6, 2),  # per cm^3
        "temperature": series(v["Earth_Temperature"][:].astype(np.float64), 0),  # K
        "b": series(b, 2),  # nT, magnitude
    }

    # The cut at the Earth should say what the series does: a check on every axis above.
    ir = int(np.argmin(np.abs(r - earth["r"])))
    i0 = int(np.searchsorted(lon, 0.0)) - 1
    w = (0.0 - lon[i0]) / (lon[i0 + 1] - lon[i0])
    worst = 0.0
    for k in range(0, n, 12):
        at = ecl[k, i0, ir] * (1 - w) + ecl[k, i0 + 1, ir] * w
        said = float(np.interp(t[keep[k]], et, earth_v))
        worst = max(worst, abs(float(at) - said))
    if worst > 25.0:
        raise SystemExit("the ecliptic cut at the Earth is %.0f km/s from the Earth series: "
                         "the file's layout is not what this script assumes" % worst)

    # And the density, as a ratio: within 15% of the Earth series wherever it is checked.
    earth_n = v["Earth_Density"][:].astype(np.float64) / M_HYDROGEN / 1e6
    dworst = 0.0
    for k in range(0, n, 12):
        at = dens[k, i0, ir] * (1 - w) + dens[k, i0 + 1, ir] * w
        said = float(np.interp(t[keep[k]], et, earth_n))
        if said > 0:
            dworst = max(dworst, abs(math.log(float(at) / said)))
    if dworst > math.log(1.15):
        raise SystemExit("the density cut at the Earth is %.0f%% from the Earth series" % ((math.exp(dworst) - 1) * 100))

    meta = {
        "version": VERSION,
        "built": iso(datetime.datetime.now(UTC)),
        "source": {
            "model": "WSA-Enlil",
            "enlil": str(ds.getncattr("enlil_version")),
            "wsa": str(ds.getncattr("wsa_version")),
            "observatory": str(ds.getncattr("observatory")),
            "run_id": source["run_id"],
            "cme": source["run_id"] != 0,
            "file": source["file"],
            "modified": iso(source["modified"]),
            "ref": iso(ref),
        },
        "atlas": {"file": "wind.png", "cols": ATLAS_COLS, "tile": [tw, th], "frames": n},
        "times": [iso(ref + datetime.timedelta(seconds=float(t[k]))) for k in keep],
        "r": {"first": round(float(r[:nr // R_BINS].mean()), 5),
              "step": round(float(r[nr // R_BINS] - r[0]), 6), "count": R_BINS},  # AU, bin centres
        "lon": {"first": round(float(lon[0]), 3), "step": round(float(lon[1] - lon[0]), 3), "count": nlon},
        "speed": {"min": SPEED_MIN, "max": speed_max},  # km/s at bytes 0 and 255
        # per cm^3 at 1 AU (n r^2) at bytes 0 and 255, log between
        "density": {"file": "wind-density.png", "min": DENSITY_MIN, "max": DENSITY_MAX, "scale": "log", "at": "1 AU"},
        "earth": earth,
        "stereo_a": {
            "r": round(float(np.median(v["STEREO_A_X1"][:])) / AU_M, 4),
            "lon": round(float(np.degrees(np.interp(0.0, et, v["STEREO_A_X3"][:].astype(np.float64)) - math.pi)), 2),
        },
    }

    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, "wind.png")
    Image.fromarray(atlas, "L").save(png, "PNG", optimize=True)
    dpng = os.path.join(out_dir, "wind-density.png")
    Image.fromarray(datlas, "L").save(dpng, "PNG", optimize=True)
    with open(os.path.join(out_dir, "wind.json"), "w") as handle:
        json.dump(meta, handle, separators=(",", ":"))
        handle.write("\n")

    print("run %s of %s, %d frames from %s to %s" % (
        source["run_id"] or "ambient", meta["source"]["ref"], n, meta["times"][0], meta["times"][-1]))
    print("speed %.0f to %.0f km/s in the cut, bytes span %.0f to %.0f" % (
        float(ecl.min()), top, SPEED_MIN, speed_max))
    print("cut at the Earth within %.1f km/s of the Earth series" % worst)
    print("density at the Earth within %.1f%% of its series; %.1f to %.1f per cm^3 at 1 AU in the cut" % (
        (math.exp(dworst) - 1) * 100, float(dens1au.min()), float(dens1au.max())))
    print("wind-density.png %.0f KB" % (os.path.getsize(dpng) / 1e3))
    print("wind.png %dx%d, %.0f KB; wind.json %.0f KB" % (
        atlas.shape[1], atlas.shape[0], os.path.getsize(png) / 1e3,
        os.path.getsize(os.path.join(out_dir, "wind.json")) / 1e3))


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True, help="directory to write wind.png and wind.json to")
    ap.add_argument("--file", help="reduce this suball.nc instead of looking on NOMADS")
    ap.add_argument("--published", help="the wind.json now published, to skip a run already out")
    ap.add_argument("--cache", help="directory to keep the download in")
    args = ap.parse_args()

    if args.file:
        m = RUN_FILE.search(args.file)
        when = datetime.datetime.fromtimestamp(os.path.getmtime(args.file), UTC).replace(microsecond=0)
        reduce(args.file, {"file": os.path.basename(args.file), "run_id": int(m.group(1)) if m else 0,
                           "modified": when}, args.out)
        return

    published = None
    if args.published and os.path.exists(args.published) and os.path.getsize(args.published):
        try:
            with open(args.published) as handle:
                published = json.load(handle)
        except ValueError:
            published = None

    pick = choose(candidates(), published, datetime.datetime.now(UTC))
    if pick is None:
        print("nothing new: the published run stands")
        return

    cache = args.cache or tempfile.mkdtemp(prefix="aurora-wind-")
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, pick["file"].replace("/", "_"))
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        print("fetching %s" % (NOMADS + pick["file"]))
        curl(["--max-time", "900", "-o", path, NOMADS + pick["file"]])
    reduce(path, pick, args.out)


if __name__ == "__main__":
    sys.exit(main())
