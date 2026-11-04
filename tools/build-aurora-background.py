#!/usr/bin/env python3
"""Builds the background the /aurora Drivers charts measure against.

Run manually from the repo root, in the relay's venv (numpy, requests, flask):

    .venv/bin/python tools/build-aurora-background.py [cache-dir]

Writes assets/data/aurora/background.json, which is committed; rebuild it every month
or two. For each series the Drivers view draws as half-hour columns it holds the
background level and its scatter, sigma, over the latest twelve months each source has.
A trailing year rather than a longer record, so the background follows the solar cycle:
2012-2025 would average two maxima with a minimum, and storms would look rarer or
commoner than they are now.

Each series is reduced to half-hour medians, as the page's columns are, and the level and
sigma come from iterative 3-sigma clipping about the median, as an astronomer measures a
sky background. The storms clip themselves out, so sigma is the quiet scatter and a storm
stands out against it. The page shades a column from 3 sigma to 5.

  Solar wind  NASA OMNI 5-minute (HRO): Bz in GSM, flow speed and proton density,
              time-shifted to the bow shock. SWPC's real-time feed is the same
              quantities at L1, 30-60 minutes upstream. Public domain (NASA SPDF).
  dH          MagIE's daily files for Dunsink and Valentia, each day put through the
              relay's own FMI quiet-day fit (magie.py) with the days either side, so dH
              means here what it means on the page. Gzipped, a Dunsink day is about 1 MB.

Fetches go through curl (OMNI) and requests (MagIE, gzipped); both are cached.
"""

import json
import os
import subprocess
import sys
import warnings
from datetime import date, datetime, timedelta, timezone

import numpy as np
import requests

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
import magie  # noqa: E402  the relay: its file parser, cleaning and FMI fit

OMNI = "https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/omni_5min{year}.asc"
OMNI_COLS = {"bz": (18, 9999.0), "speed": (21, 99999.0), "density": (25, 999.0)}  # 0-based, fill
YEAR_DAYS = 365
HALF_HOUR = 30  # minutes
OUT = "assets/data/aurora/background.json"


def clipped(values, k=3.0):
    """Level and sigma by iterative k-sigma clipping about the median."""
    v = values[np.isfinite(values)]
    n0 = len(v)
    for _ in range(20):
        med, sd = np.median(v), np.std(v)
        keep = np.abs(v - med) < k * sd
        if keep.all():
            break
        v = v[keep]
    return {"level": round(float(np.median(v)), 2), "sigma": round(float(np.std(v)), 2),
            "n": int(n0), "clipped": round(1.0 - len(v) / n0, 3)}


def half_hours(v, per, need):
    """Half-hour medians of a regular series with `per` samples a half hour."""
    n = len(v) // per * per
    blocks = v[:n].reshape(-1, per)
    good = np.isfinite(blocks).sum(axis=1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # half hours with no data at all
        med = np.nanmedian(blocks, axis=1)
    return np.where(good >= need, med, np.nan)


# ---------------------------------------------------------------- solar wind

def omni(cache):
    years = {}
    for year in (datetime.now(timezone.utc).year - 1, datetime.now(timezone.utc).year):
        path = os.path.join(cache, "omni_5min%d.asc" % year)
        if not os.path.exists(path):
            print("fetching OMNI %d" % year)
            subprocess.run(["curl", "-sSfL", "--max-time", "600", "-o", path, OMNI.format(year=year)], check=True)
        cols = [0, 1, 2, 3] + [c for c, _ in OMNI_COLS.values()]
        years[year] = np.loadtxt(path, usecols=cols)
    a = np.concatenate([years[y] for y in sorted(years)])
    base = np.array([datetime(int(y), 1, 1, tzinfo=timezone.utc).timestamp() for y in a[:, 0]])
    t = base + (a[:, 1] - 1) * 86400 + a[:, 2] * 3600 + a[:, 3] * 60
    series = {}
    for i, (name, (_, fill)) in enumerate(OMNI_COLS.items()):
        v = a[:, 4 + i].copy()
        v[v >= fill] = np.nan
        series[name] = v
    valid = np.flatnonzero(np.all([np.isfinite(series[k]) for k in series], axis=0))
    end = t[valid[-1]] + 300
    end -= end % 1800  # whole half hours
    start = end - YEAR_DAYS * 86400
    sel = (t >= start) & (t < end)
    out = {}
    for name, v in series.items():
        hh = half_hours(v[sel], 6, 3)
        out[name] = dict(clipped(hh), start=start, end=end)
    return out


# ---------------------------------------------------------------- magnetometers

def magie_minutes(cache, station, day, session):
    """One station-day of minute means (x, y), from the cache or MagIE; None if missing."""
    path = os.path.join(cache, "magie-%s-%s.npz" % (station[0], day.isoformat()))
    if os.path.exists(path):
        z = np.load(path)
        return (z["x"], z["y"]) if z["ok"] else None
    d = magie._Day(station, day)
    r = session.get(d.url, timeout=60)
    ok = r.status_code == 200
    if ok:
        d._parse(r.content + b"\n")
        x, y = d.minutes()
    else:
        x = y = np.full(magie.DAY, np.nan)
    np.savez_compressed(path, x=x, y=y, ok=ok)
    return (x, y) if ok else None


def dh_year(cache, station, last_day):
    session = requests.Session()
    session.headers["User-Agent"] = "jeremy.ie aurora background build (+https://jeremy.ie/aurora)"
    days = [last_day - timedelta(days=i) for i in range(YEAR_DAYS + 1, -1, -1)]  # a day either side
    mins = {}
    for i, d in enumerate(days):
        mins[d] = magie_minutes(cache, station, d, session)
        if i % 30 == 0:
            print("  %s %s" % (station[1], d.isoformat()))
    blank = np.full(magie.DAY, np.nan)
    halves = []
    for d in days[1:-1]:
        if mins[d] is None:
            continue
        trio = [mins.get(d + timedelta(days=k)) or (blank, blank) for k in (-1, 0, 1)]
        x = magie._fill_gaps(magie._despike(np.concatenate([p[0] for p in trio])))
        y = magie._fill_gaps(magie._despike(np.concatenate([p[1] for p in trio])))
        ks, curves = magie._fmi(x, y, magie.DAY)
        if not curves:
            continue
        tt = np.arange(magie.DAY)
        xd, yd = x[magie.DAY:2 * magie.DAY], y[magie.DAY:2 * magie.DAY]
        dh = np.hypot(xd, yd) - np.hypot(curves[0](tt), curves[1](tt))
        halves.append(half_hours(dh, HALF_HOUR, 10))
    hh = np.concatenate(halves)
    start = datetime.combine(days[1], datetime.min.time(), tzinfo=timezone.utc).timestamp()
    end = datetime.combine(days[-1], datetime.min.time(), tzinfo=timezone.utc).timestamp()
    return dict(clipped(hh), start=start, end=end, days=len(halves))


def main():
    os.chdir(ROOT)
    cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join("tools", ".cache")
    os.makedirs(cache, exist_ok=True)

    series = omni(cache)
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=2)  # its next day is complete too
    for station in magie.STATIONS:
        print("MagIE %s" % station[1])
        series[station[0]] = dh_year(cache, station, yesterday)

    def day(ts):
        return datetime.fromtimestamp(ts, timezone.utc).date().isoformat()

    out = {
        "built": date.today().isoformat(),
        "rule": "half-hour medians; level and sigma by iterative 3-sigma clipping about the median",
        "sources": {
            "solar wind": "NASA OMNI 5-minute (HRO), bow-shock shifted",
            "dH": "MagIE (DIAS), through magie.py's FMI quiet-day fit",
        },
        "series": {},
    }
    for name, s in series.items():
        entry = {k: s[k] for k in ("level", "sigma", "n", "clipped")}
        entry["from"], entry["to"] = day(s["start"]), day(s["end"] - 1)
        if "days" in s:
            entry["days"] = s["days"]
        out["series"][name] = entry
        print("%-8s level %8.2f  sigma %7.2f  (%s to %s, %d half hours, %.1f%% clipped)"
              % (name, s["level"], s["sigma"], entry["from"], entry["to"], s["n"], 100 * s["clipped"]))
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print("wrote %s" % OUT)


if __name__ == "__main__":
    main()
