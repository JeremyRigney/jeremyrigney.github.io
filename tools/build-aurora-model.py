#!/usr/bin/env python3
"""Builds the model behind the /aurora time slider.

Run by hand from the repo root, in a throwaway venv that has aacgmv2:

    python3 -m venv /tmp/aurora-venv
    /tmp/aurora-venv/bin/pip install aacgmv2
    /tmp/aurora-venv/bin/python -I tools/build-aurora-model.py [--cache DIR]

Writes three committed files under assets/data/aurora/. The page loads them and
never touches the sources below.

NOAA publishes no gridded aurora forecast beyond its 30-90 minute OVATION nowcast,
so every frame on the slider away from "live" is modelled. That is how MagIE's
3-day animation and SWPC's "tonight" maps are made too: OVATION-Prime, driven by
a Kp forecast instead of the solar wind. This script prepares the three pieces
the browser needs to do the same.

  model.json  metadata, plus the Kp -> coupling table:
                The model's input is Newell's coupling function dPhi/dt, a
                4-hour weighted mean of hourly solar wind (each hour back
                weighted 0.65x, as OVATION-Prime's own driver does). A Kp
                forecast has no solar wind, so this measures what dPhi/dt
                usually is at each Kp: the median, quartiles and count over
                NASA's OMNI2 hourly record, 2012-2025 (words 16, 17, 25, 39:
                By and Bz GSM, flow speed, Kp x 10). Medians are made
                non-decreasing in Kp, since the top bins are thin.

  op2010.bin  OVATION-Prime 2010: total electron energy flux (diffuse +
                monoenergetic + wave; ions excluded, as SWPC does for visible
                aurora), erg cm^-2 s^-1, for each season x coupling level x
                magnetic latitude (50-90, 0.5 deg) x MLT (0-24, 15 min). One
                byte per value, log-scaled (see OP_MIN, OP_STEP). North and south are averaged
                as the original IDL does ("n_or_s=3"); the page weights the
                seasons by day of year, using 365 - doy for the south. The
                regression is evaluated here from the public coefficient files
                (NOAA's OP2010 release, as redistributed in OvationPyme): per
                bin, flux = (b1 + b2 dF) x p, p from the bin's own regression
                or its tabulated probability, with OP2010's clamps, and the
                northern dawn data gap filled ring by ring. Then despeckled
                (see clean()): a regression fitted bin by bin leaves lone bins
                of 2 erg far equatorward of the oval, right over Ireland.

  aacgm.bin   Geographic -> AACGM-v2 at 110 km for EPOCH, 1-degree grid:
                magnetic latitude and longitude, int16 hundredths of a degree
                (NO_DATA where AACGM is undefined, near the equator). Then MLT
                of magnetic longitude 0 for each UT hour of the year, uint16
                thousandths of an hour; MLT is linear in magnetic longitude, so
                that one number per hour places any cell. OVATION lives in
                these coordinates, and a dipole won't do: Valentia is 48.7 deg
                AACGM but 55 deg on a dipole, an error right over Ireland.

Downloads are cached in --cache and re-used. Fetches go through curl, as in the
other tools/ builders.
"""

import argparse
import array
import bisect
import datetime
import json
import math
import os
import subprocess
import sys
import tempfile

OUT_DIR = "assets/data/aurora"

OMNI_URL = "https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2_{year}.dat"
OMNI_YEARS = range(2012, 2026)

OP_URL = ("https://raw.githubusercontent.com/lkilcommons/OvationPyme/master/"
          "ovationpyme/data/premodel/{name}")
SEASONS = ["winter", "spring", "summer", "fall"]
TYPES = ["diff", "mono", "wave"]

# Coupling levels the table is evaluated at. The page interpolates between them.
DF_LEVELS = [0, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6500, 8000,
             10000, 12500, 15000, 20000, 25000, 30000]

NMLT, NMLAT_ALL, NDF_BINS = 96, 160, 12
NMLAT = NMLAT_ALL // 2  # per hemisphere, 50-90 deg
# Flux is stored on a log scale in one byte: 0 is no flux, 1..255 run from OP_MIN to
# OP_MAX erg cm^-2 s^-1 in steps of about 4%, finer than anything the globe can show.
OP_MIN, OP_MAX = 1e-3, 16.0
OP_STEP = (math.log10(OP_MAX) - math.log10(OP_MIN)) / 254.0
# Despeckling: walking equatorward from the oval's peak, nothing is kept past the
# first bin under CLEAN_CUT erg cm^-2 s^-1 (a twentieth of a kR, far below the eye).
CLEAN_CUT = 0.05

EPOCH = datetime.datetime(2026, 7, 1)
ALT_KM = 110
NO_DATA = -32768

R_EARTH_M = 6.371e6


def fetch(url, cache):
    path = os.path.join(cache, url.rsplit("/", 1)[1])
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        print("fetching %s" % url)
        subprocess.run(["curl", "-sSfL", "--max-time", "180", "-o", path, url], check=True)
    return path


def tokens(path):
    with open(path) as handle:
        header = handle.readline()
        return header, handle.read().split()


# ---------------------------------------------------------------- coupling

def newell(by, bz, v):
    """Newell et al. (2007) dPhi/dt: v^4/3 Bt^2/3 sin^8/3(theta/2)."""
    bt = math.hypot(by, bz)
    theta = math.atan2(by, bz)
    return v ** (4.0 / 3.0) * bt ** (2.0 / 3.0) * abs(math.sin(theta / 2.0)) ** (8.0 / 3.0)


def coupling(cache):
    hours = {}  # hour index since 2012 -> (Ec, Kp code)
    for year in OMNI_YEARS:
        path = fetch(OMNI_URL.format(year=year), cache)
        base = datetime.datetime(year, 1, 1)
        with open(path) as handle:
            for line in handle:
                w = line.split()
                if len(w) < 39:
                    continue
                by, bz, v, kp = float(w[15]), float(w[16]), float(w[24]), int(w[38])
                t = base + datetime.timedelta(days=int(w[1]) - 1, hours=int(w[2]))
                key = int((t - datetime.datetime(2012, 1, 1)).total_seconds() // 3600)
                ec = None
                if abs(by) < 999 and abs(bz) < 999 and v < 9999:
                    ec = newell(by, bz, v)
                hours[key] = (ec, kp if kp < 99 else None)

    by_kp = {}
    for key, (ec, kp) in hours.items():
        if ec is None or kp is None:
            continue
        num = den = 0.0
        for back in range(4):
            prev = hours.get(key - back)
            if prev and prev[0] is not None:
                wgt = 0.65 ** back
                num += wgt * prev[0]
                den += wgt
        by_kp.setdefault(kp, []).append(num / den)

    def pct(xs, q):
        i = q * (len(xs) - 1)
        lo = int(math.floor(i))
        hi = min(len(xs) - 1, lo + 1)
        return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)

    rows = []
    for code in sorted(by_kp):
        xs = sorted(by_kp[code])
        rows.append({
            "kp": round(round(code / 10.0 * 3) / 3.0, 3),
            "n": len(xs),
            "median": pct(xs, 0.5),
            "p25": pct(xs, 0.25),
            "p75": pct(xs, 0.75),
        })

    # Thin top bins can dip; the table the page uses never does.
    run = 0.0
    for r in rows:
        run = max(run, r["median"])
        r["used"] = run

    print("Kp -> dPhi/dt (OMNI2 %d-%d):" % (OMNI_YEARS[0], OMNI_YEARS[-1]))
    for r in rows:
        print("  Kp %4.2f  n=%6d  median %7.0f  IQR %7.0f-%7.0f%s" % (
            r["kp"], r["n"], r["median"], r["p25"], r["p75"],
            "" if r["used"] == r["median"] else "  (held at %.0f)" % r["used"]))
    return {
        "source": "NASA OMNI2 hourly, %d-%d" % (OMNI_YEARS[0], OMNI_YEARS[-1]),
        "averaging": "4-hour weighted mean of hourly Newell coupling, 0.65 per hour back",
        "kp": [round(r["kp"], 3) for r in rows],
        "dF": [round(r["used"]) for r in rows],
        "median": [round(r["median"]) for r in rows],
        "p25": [round(r["p25"]) for r in rows],
        "p75": [round(r["p75"]) for r in rows],
        "n": [r["n"] for r in rows],
    }


# ---------------------------------------------------------------- OVATION-Prime 2010

def load_type(cache, season, atype):
    """Coefficients for one season and auroral type, indexed [mlt][mlat_all]."""
    nan = float("nan")
    b1a = [[nan] * NMLAT_ALL for _ in range(NMLT)]
    b2a = [[nan] * NMLAT_ALL for _ in range(NMLT)]
    _, a = tokens(fetch(OP_URL.format(name="%s_%s.txt" % (season, atype)), cache))
    n = NMLT * NMLAT_ALL
    assert len(a) >= 5 * n, "%s_%s: %d tokens" % (season, atype, len(a))
    order = []
    for r in range(n):
        i, j = int(float(a[5 * r])), int(float(a[5 * r + 1]))
        b1a[i][j] = float(a[5 * r + 2])
        b2a[i][j] = float(a[5 * r + 3])
        order.append((i, j))

    b1p = [[0.0] * NMLAT_ALL for _ in range(NMLT)]
    b2p = [[0.0] * NMLAT_ALL for _ in range(NMLT)]
    prob = [[[0.0] * NDF_BINS for _ in range(NMLAT_ALL)] for _ in range(NMLT)]
    _, p = tokens(fetch(OP_URL.format(name="%s_prob_b_%s.txt" % (season, atype)), cache))
    assert len(p) >= 2 * n + n * NDF_BINS, "%s prob %s: %d tokens" % (season, atype, len(p))
    for r, (i, j) in enumerate(order):
        b1p[i][j] = float(p[2 * r])
        b2p[i][j] = float(p[2 * r + 1])
    # Tabulated probabilities: every position for dF bin 0, then bin 1, ...
    off = 2 * n
    for k in range(NDF_BINS):
        for r, (i, j) in enumerate(order):
            prob[i][j][k] = float(p[off + k * n + r])
    return b1a, b2a, b1p, b2p, prob


def df_bin(df):
    step = 4421.0 / 8.0
    return int(min(NDF_BINS - 1, max(0, math.floor(df / step))))


def bin_flux(c, df, i, j):
    b1a, b2a, b1p, b2p, prob = c
    b1, b2 = b1p[i][j], b2p[i][j]
    if b1 == 0.0 and b2 == 0.0:
        k = df_bin(df)
        pr = prob[i][j][k]
        if pr == 0.0:
            k1 = k - 1 if k > 0 else k + 2
            k2 = k + 1 if k < NDF_BINS - 1 else k - 2
            pr = (prob[i][j][k1] + prob[i][j][k2]) / 2.0
    else:
        pr = min(1.0, max(0.0, b1 + b2 * df))
    flux = (b1a[i][j] + b2a[i][j] * df) * pr
    if flux != flux:  # bin with no coefficients
        return float("nan")
    if flux < 0.0:
        flux = 0.0
    if flux > 10.0:  # OP2010's own clamps for electron energy flux
        flux = 0.5
    elif flux > 5.0:
        flux = 5.0
    return flux


def fill_wedge(ring_by_lat):
    """The northern dawn data gap (MLT 23-04, mlat 49-75): fill each ring's missing
    bins by linear interpolation along the ring, leaving out the six bins either side
    of the gap, whose statistics are poor (as OP2010's IDL does)."""
    for j, ring in enumerate(ring_by_lat):
        mlat = 50.0 + (j + 0.5) * 0.5
        if not 49.0 <= mlat <= 75.0:
            continue
        # Walk the ring from MLT -12 to +12 so the gap is contiguous.
        idx = list(range(NMLT // 2, NMLT)) + list(range(0, NMLT // 2))
        mlts = [((i + 0.5) * 0.25) - (24.0 if i >= NMLT // 2 else 0.0) for i in idx]
        vals = [ring[i] for i in idx]
        missing = [(-1.0 <= m <= 4.0) and not (v > 0.0) for m, v in zip(mlts, vals)]
        if not any(missing):
            continue
        first = missing.index(True)
        last = len(missing) - 1 - missing[::-1].index(True)
        lo, hi = max(0, first - 6), min(len(idx) - 1, last + 6)
        xs = [mlts[k] for k in range(len(idx)) if (k < lo or k > hi) and vals[k] == vals[k]]
        ys = [vals[k] for k in range(len(idx)) if (k < lo or k > hi) and vals[k] == vals[k]]
        for k in range(lo, hi + 1):
            m = mlts[k]
            s = bisect.bisect_left(xs, m)
            if s <= 0 or s >= len(xs):
                continue
            t = (m - xs[s - 1]) / (xs[s] - xs[s - 1])
            ring[idx[k]] = ys[s - 1] + (ys[s] - ys[s - 1]) * t


def clean(flat):
    """Despeckle one flat [mlat][mlt] table. OP2010 is a regression fitted bin by bin,
    and where DMSP seldom saw aurora a lone bin, or one ring of them, can come out at
    2 erg among neighbours at 0.03. On the globe those drew as patches of aurora well
    equatorward of the oval. So: a 3 x 5 median (latitude x MLT, MLT wrapping), which
    an oval several degrees wide passes through; then along each MLT nothing
    equatorward of the first bin under CLEAN_CUT below the oval's peak; then a
    1-degree fade into the table's 50-degree edge, so the globe shows no seam there."""
    med = [0.0] * len(flat)
    for j in range(NMLAT):
        for i in range(NMLT):
            win = []
            for jj in (max(0, j - 1), j, min(NMLAT - 1, j + 1)):
                for di in (-2, -1, 0, 1, 2):
                    win.append(flat[jj * NMLT + (i + di) % NMLT])
            win.sort()
            med[j * NMLT + i] = win[7]
    for i in range(NMLT):
        col = [med[j * NMLT + i] for j in range(NMLAT)]
        j = max(range(NMLAT), key=lambda k: col[k])
        while j >= 0 and col[j] >= CLEAN_CUT:
            j -= 1
        for k in range(j + 1):
            med[k * NMLT + i] = 0.0
        med[i] *= 0.25
        med[NMLT + i] *= 0.75
    return med


def ovation(cache):
    tables = []  # [season][level] -> flat [mlat * NMLT + mlt]
    for season in SEASONS:
        coeffs = [load_type(cache, season, t) for t in TYPES]
        per_level = []
        for df in DF_LEVELS:
            # NaN until some auroral type has coefficients for the bin.
            north = [[float("nan")] * NMLT for _ in range(NMLAT)]
            south = [[float("nan")] * NMLT for _ in range(NMLAT)]
            for c in coeffs:
                for i in range(NMLT):
                    for j in range(NMLAT):
                        fs = bin_flux(c, df, i, j)            # mlat_all 0..79: -50 -> -90
                        fn = bin_flux(c, df, i, NMLAT + j)    # 80..159: 50 -> 90
                        if fs == fs:
                            south[j][i] = (south[j][i] if south[j][i] == south[j][i] else 0.0) + fs
                        if fn == fn:
                            north[j][i] = (north[j][i] if north[j][i] == north[j][i] else 0.0) + fn
            fill_wedge(north)
            flat = []
            for j in range(NMLAT):
                for i in range(NMLT):
                    n, s = north[j][i], south[j][i]
                    if n == n and s == s:
                        flat.append((n + s) / 2.0)
                    elif n == n:
                        flat.append(n)
                    elif s == s:
                        flat.append(s)
                    else:
                        flat.append(0.0)
            per_level.append(clean(flat))
        tables.append(per_level)
        print("OVATION-Prime %s: %d levels" % (season, len(per_level)))
    return tables


def hemispheric_power(flat):
    """GW over one hemisphere for a flat [mlat][mlt] table."""
    gw = 0.0
    dlon = 2.0 * math.pi / NMLT
    for j in range(NMLAT):
        a = math.radians(50.0 + j * 0.5)
        b = math.radians(50.0 + (j + 1) * 0.5)
        area = R_EARTH_M * R_EARTH_M * dlon * (math.sin(b) - math.sin(a))
        row = sum(flat[j * NMLT:(j + 1) * NMLT])
        gw += row * 1e-3 * area / 1e9
    return gw


# ---------------------------------------------------------------- AACGM-v2

def aacgm():
    try:
        import numpy as np
        import aacgmv2
    except ImportError:
        sys.exit("aacgmv2 is missing: run this with a venv that has it (see the docstring).")

    lat, lon = np.meshgrid(np.arange(-90, 91, 1.0), np.arange(-180, 180, 1.0), indexing="ij")
    mlat, mlon, _ = aacgmv2.convert_latlon_arr(
        lat.ravel(), lon.ravel(), np.full(lat.size, float(ALT_KM)), EPOCH, method_code="G2A")
    grid = array.array("h")
    bad = 0
    for value in list(mlat) + list(mlon):
        if value != value:
            grid.append(NO_DATA)
            bad += 1
        else:
            grid.append(int(round(value * 100)))
    bad //= 2

    mlt0 = array.array("H")
    start = datetime.datetime(EPOCH.year, 1, 1)
    for doy in range(1, 367):
        for hour in range(24):
            t = start + datetime.timedelta(days=min(doy, 365) - 1, hours=hour)
            m = float(aacgmv2.convert_mlt(np.array([0.0]), t)[0]) % 24.0
            mlt0.append(int(round(m * 1000)) % 24000)

    for name, la, lo in (("Valentia", 51.94, -10.24), ("Malin Head", 55.38, -7.37)):
        m = aacgmv2.convert_latlon(la, lo, ALT_KM, EPOCH, method_code="G2A")
        print("AACGM %s: %.2f, %.2f" % (name, m[0], m[1]))
    print("AACGM grid: %d of %d cells undefined" % (bad, lat.size))
    return grid, mlt0


# ---------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "aurora-model-cache"))
    args = parser.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    os.chdir(root)
    os.makedirs(OUT_DIR, exist_ok=True)

    kp = coupling(args.cache)
    tables = ovation(args.cache)
    grid, mlt0 = aacgm()

    op = array.array("B")
    lo = math.log10(OP_MIN)
    for per_level in tables:
        for flat in per_level:
            for v in flat:
                op.append(0 if v < OP_MIN else min(255, 1 + int(round((math.log10(v) - lo) / OP_STEP))))
    if sys.byteorder != "little":
        grid.byteswap()
        mlt0.byteswap()
    with open(os.path.join(OUT_DIR, "op2010.bin"), "wb") as handle:
        op.tofile(handle)
    with open(os.path.join(OUT_DIR, "aacgm.bin"), "wb") as handle:
        grid.tofile(handle)
        mlt0.tofile(handle)

    hp = [[round(hemispheric_power(flat), 2) for flat in per_level] for per_level in tables]

    meta = {
        "built": datetime.date.today().isoformat(),
        "coupling": kp,
        "op2010": {
            "file": "op2010.bin",
            "source": "OVATION-Prime 2010 (Newell et al.), NOAA coefficients as redistributed with OvationPyme",
            "quantity": "electron energy flux, diffuse + mono + wave, erg cm^-2 s^-1",
            "layout": "uint8 [season][level][mlat][mlt]: 0 = none, else 10^(log10(min) + (code - 1) * step)",
            "min": OP_MIN,
            "step": OP_STEP,
            "seasons": SEASONS,
            "dF": DF_LEVELS,
            "mlat": [50, 90, NMLAT],
            "mlt": [0, 24, NMLT],
            "power": hp,
        },
        "aacgm": {
            "file": "aacgm.bin",
            "source": "AACGM-v2 (aacgmv2), %d km, epoch %s" % (ALT_KM, EPOCH.date().isoformat()),
            "layout": "int16 LE mlat[181][360] then mlon[181][360], centidegrees, lat -90..90, lon -180..179; "
                      "then uint16 LE mlt0[366][24], milli-hours: MLT of magnetic longitude 0 at each UT hour",
            "noData": NO_DATA,
        },
    }
    with open(os.path.join(OUT_DIR, "model.json"), "w") as handle:
        json.dump(meta, handle, separators=(",", ":"))

    for name in ("model.json", "op2010.bin", "aacgm.bin"):
        print("wrote %s/%s, %.1f KB" % (OUT_DIR, name, os.path.getsize(os.path.join(OUT_DIR, name)) / 1024))
    print("Hemispheric power by season at each dF level (GW):")
    for season, row in zip(SEASONS, hp):
        print("  %-6s %s" % (season, " ".join("%5.1f" % x for x in row)))


if __name__ == "__main__":
    main()
