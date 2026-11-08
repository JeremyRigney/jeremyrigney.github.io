"""
/magie — Ireland's magnetometers for jeremy.ie/aurora: the last 24 hours of the
horizontal field at Dunsink and Valentia, and a local K index for each, from MagIE (the
Magnetic Network of Ireland, run by DIAS).

Why this sits on the server: data.magie.ie sends no CORS headers, so a page on jeremy.ie
can't read it. And it comes as raw daily text (Dunsink's is a line a second, about 4.5 MB
a day), so the reduction to minutes, the quiet-day curve and the K index are done here
once rather than in every visitor's browser.

Upstream there is one file per station per UT day,

    https://data.magie.ie/YYYY/MM/DD/txt/<station>YYYYMMDD.txt

tab-separated "DD/MM/YYYY HH:MM:SS  index  Bx  By  Bz", in nT, X north, Y east, Z down.
Dunsink's runs about a minute behind; Valentia's has a line a minute and runs about a
quarter of an hour behind. The server honours byte ranges, so after the first read each
poll asks only for what has been appended (Range: bytes=<offset>-), and the day before
yesterday, needed only for its last hours, is read as a suffix (Range: bytes=-<n>).

The K index is the FMI method (Sucksdorff, Pirjola and Hakkinen 1991), as FMI publish it
in their reference K_index.h and as MagIE describe it, on MagIE's scale (K9 = 540 nT):

  1. minute means, dropping any more than 3 sigma from the hour around it (MagIE's step);
  2. a first K for each 3-hour block from the range of X and of Y, whichever is larger;
  3. for each hour, the mean of X and Y over that hour widened by 30 min, plus a margin
     by local time (90 min at night, 60 at dawn and dusk, none by day), plus K^3.3 min,
     either side;
  4. a fifth-order harmonic fit through the 24 hourly means: the quiet-day curve;
  5. K again from the range of the data minus that curve; then 3 to 5 once more, and that
     K stands.

Each UT day is fitted with the days either side of it, as FMI's routine requires. Real
time changes two things. A window that reaches past the latest data has no mean, so it is
filled from the hours around it, as FMI fills gaps. And the block still running gets a K
from what it holds so far, marked as running.

dH is H = sqrt(X^2 + Y^2) minus the same from the quiet-day curve: the disturbance the K
index measures, in nT. Substorms show as bays: usually upward at Irish latitudes, downward
when a big storm brings the electrojet overhead. Neighbouring days' curves are blended over
the hour either side of midnight, so there is no step there.

The composed payload is cached for a minute and rebuilt by one thread at a time. There is
one worker and threads share this module's state (see the Dockerfile).
"""

import threading
import time
import warnings
from datetime import date, datetime, timedelta, timezone

import numpy as np
import requests
from flask import Blueprint, jsonify

bp = Blueprint("magie", __name__)

BASE = "https://data.magie.ie"

# id, name, latitude, longitude, roughly how many bytes of file an hour fills
STATIONS = (
    ("dun", "Dunsink", 53.387, -6.338, 190000),
    ("val", "Valentia", 51.933, -10.250, 3200),
)

DAY = 1440  # minutes
K9 = 540.0
K_LIMITS = [K9 * c / 500.0 for c in (5, 10, 20, 40, 70, 120, 200, 330, 500)]

# FMI's fitting margins by hour, in minutes. Ireland's local midnight is within half an
# hour of UT's, so FMI's table needs no rotation (its Longitude/15 is 0 at both stations).
MARGIN = [90] * 3 + [60] * 3 + [0] * 12 + [60] * 3 + [90] * 3
HARMONICS = 5
MAX_GAP = 15  # minutes: shorter gaps are interpolated, longer ones leave K unset
RUNNING_MIN = 30  # minutes of a running block before it gets a K at all

TAIL_HOURS = 8  # of the day before yesterday: enough for the widest night window to K 6
FINAL_AFTER = timedelta(minutes=30)  # a day's file is read once more this long after it ends
CACHE_S = 55
TIMEOUT = 20

_session = requests.Session()
_session.headers["User-Agent"] = "jeremy.ie aurora relay (+https://jeremy.ie/aurora)"
# MagIE's Apache gzips on request, and a gzipped reply ignores Range: every poll would
# fetch the whole day's file. Uncompressed, ranges work.
_session.headers["Accept-Encoding"] = "identity"

_lock = threading.Lock()
_days = {}  # (station id, date) -> _Day
_payload = None
_built = 0.0


class _Day:
    """One station's file for one UT day, read a piece at a time into per-minute sums."""

    def __init__(self, station, day, tail_bytes=None):
        sid = station[0]
        self.day = day
        self.url = "%s/%s/txt/%s%s.txt" % (BASE, day.strftime("%Y/%m/%d"), sid, day.strftime("%Y%m%d"))
        self.stamp = day.strftime("%d/%m/%Y").encode()
        self.tail_bytes = tail_bytes
        self.offset = 0
        self.rest = b""
        self.final = False
        self._reset()

    def _reset(self):
        self.sx = np.zeros(DAY)
        self.sy = np.zeros(DAY)
        self.n = np.zeros(DAY)
        self.rest = b""

    def read(self, now):
        if self.final:
            return
        headers = {}
        if self.offset:
            headers["Range"] = "bytes=%d-" % self.offset
        elif self.tail_bytes:
            headers["Range"] = "bytes=-%d" % self.tail_bytes
        r = _session.get(self.url, headers=headers, timeout=TIMEOUT)
        if r.status_code == 200:
            # The whole file, asked for or not.
            self._reset()
            self._parse(r.content)
            self.offset = len(r.content)
        elif r.status_code == 206:
            body = r.content
            if not self.offset and self.tail_bytes:
                body = body[body.find(b"\n") + 1:]  # the suffix starts mid-line
            self._parse(body)
            total = r.headers.get("Content-Range", "").rsplit("/", 1)[-1]
            self.offset = int(total) if total.isdigit() else self.offset + len(r.content)
        elif r.status_code not in (404, 416):  # not written yet; nothing new
            r.raise_for_status()
        end = datetime.combine(self.day, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=1)
        if now >= end + FINAL_AFTER:
            self.final = True

    def _parse(self, body):
        lines = (self.rest + body).split(b"\n")
        self.rest = lines.pop()
        sx, sy, n, stamp = self.sx, self.sy, self.n, self.stamp
        for line in lines:
            parts = line.split()
            if len(parts) < 6 or parts[0] != stamp:
                continue
            try:
                m = int(parts[1][0:2]) * 60 + int(parts[1][3:5])
                x, y = float(parts[3]), float(parts[4])
            except ValueError:
                continue
            if not (5000.0 < x < 40000.0 and -15000.0 < y < 15000.0) or not 0 <= m < DAY:
                continue
            sx[m] += x
            sy[m] += y
            n[m] += 1

    def minutes(self):
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(self.n > 0, self.sx / self.n, np.nan), np.where(self.n > 0, self.sy / self.n, np.nan)


# ---------------------------------------------------------------- cleaning

def _despike(v):
    """MagIE's clean: NaN wherever a minute is more than 3 sigma from the hour around it
    (sigma at least 1 nT, so quiet noise is never cut)."""
    pad = np.concatenate([np.full(30, np.nan), v, np.full(30, np.nan)])
    win = np.lib.stride_tricks.sliding_window_view(pad, 61)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(win, axis=1)
        sd = np.maximum(np.nanstd(win, axis=1), 1.0)
    out = v.copy()
    out[np.abs(v - mean) > 3.0 * sd] = np.nan
    return out


def _fill_gaps(v):
    """Interpolate interior gaps up to MAX_GAP minutes; longer ones stay missing."""
    out = v.copy()
    good = np.flatnonzero(~np.isnan(v))
    for a, b in zip(good[:-1], good[1:]):
        if 1 < b - a <= MAX_GAP + 1:
            out[a + 1:b] = np.interp(np.arange(a + 1, b), [a, b], [v[a], v[b]])
    return out


# ---------------------------------------------------------------- the FMI method

def _k_of(span):
    k = 0
    while k < 9 and span > K_LIMITS[k]:
        k += 1
    return k


def _block_ks(x, y, upto):
    """K for the eight blocks of one day from the range of x and y (a day's minutes, raw
    or less the quiet curve). upto: minutes of the day with data. A block with gaps gets
    None, a block still running a K from what it holds, if it holds RUNNING_MIN minutes."""
    ks = []
    for b in range(8):
        lo, hi = b * 180, b * 180 + 180
        if lo >= upto:
            ks.append(None)
            continue
        sx, sy = x[lo:min(hi, upto)], y[lo:min(hi, upto)]
        if hi > upto:
            ok = ~(np.isnan(sx) | np.isnan(sy))
            if ok.sum() < RUNNING_MIN:
                ks.append(None)
                continue
            sx, sy = sx[ok], sy[ok]
        elif np.isnan(sx).any() or np.isnan(sy).any():
            ks.append(None)
            continue
        ks.append(max(_k_of(sx.max() - sx.min()), _k_of(sy.max() - sy.min())))
    return ks


def _hour_means(v3, ks):
    """The 24 widened hourly means of the middle day of a three-day minute array, gaps
    filled from the hours around them as FMI does. None if no hour has a mean."""
    means = np.full(24, np.nan)
    for h in range(24):
        k = ks[h // 3]
        widen = 0 if not k else min(18 * 60, int(60 * k ** 3.3) // 60)
        wing = min(DAY, 30 + MARGIN[h] + widen)
        mid = DAY + h * 60 + 30
        seg = v3[mid - wing:mid + wing + 1]
        if not np.isnan(seg).any():
            means[h] = seg.mean()
    good = np.flatnonzero(~np.isnan(means))
    if not len(good):
        return None
    return np.interp(np.arange(24), good, means[good])


def _harmonic(means):
    """FMI's quiet-day curve: the hourly means less the straight line from the first to
    the last, fitted to HARMONICS harmonics of a day, the line added back. Returns a
    function of minutes since the day's midnight, good a little either side of the day."""
    t0 = 30.0
    slope = (means[23] - means[0]) / (23 * 60.0)
    m = means - slope * np.arange(24) * 60.0
    k = np.arange(24)
    terms = []
    for i in range(1, HARMONICS + 1):
        a = i * k * 2.0 * np.pi / 24.0
        terms.append((i, np.sum(m * np.cos(a)), -np.sum(m * np.sin(a))))
    base = m.mean()

    def curve(t):
        th = (np.asarray(t, dtype=float) - t0) * 2.0 * np.pi / DAY
        v = np.full(th.shape, base)
        for i, re, im in terms:
            v += (2.0 / 24.0) * (re * np.cos(i * th) - im * np.sin(i * th))
        return v + slope * (np.asarray(t, dtype=float) - t0)

    return curve


def _fmi(x3, y3, upto):
    """K for the middle day of three days of minutes, and its quiet curves for X and Y."""
    day = slice(DAY, 2 * DAY)
    ks = _block_ks(x3[day], y3[day], upto)
    curves = None
    t = np.arange(DAY)
    for _ in range(2):
        mx, my = _hour_means(x3, ks), _hour_means(y3, ks)
        if mx is None or my is None:
            return [None] * 8, None
        curves = (_harmonic(mx), _harmonic(my))
        ks = _block_ks(x3[day] - curves[0](t), y3[day] - curves[1](t), upto)
    return ks, curves


# ---------------------------------------------------------------- composing

def _day_list(today):
    return [today - timedelta(days=d) for d in (2, 1, 0)]


def _station(station, today, now):
    """Four days of cleaned minutes (the day before yesterday to tomorrow), FMI on
    yesterday and today, and how far the data reaches."""
    sid = station[0]
    xs, ys = [], []
    for i, d in enumerate(_day_list(today)):
        key = (sid, d)
        if key not in _days:
            _days[key] = _Day(station, d, station[4] * TAIL_HOURS if i == 0 else None)
        _days[key].read(now)
        x, y = _days[key].minutes()
        xs.append(x)
        ys.append(y)
    xs.append(np.full(DAY, np.nan))  # tomorrow
    ys.append(np.full(DAY, np.nan))
    x, y = np.concatenate(xs), np.concatenate(ys)
    have = np.flatnonzero(~(np.isnan(x) | np.isnan(y)))
    upto = int(have[-1]) + 1 if len(have) else 0
    x, y = _fill_gaps(_despike(x)), _fill_gaps(_despike(y))

    fits = {}
    blocks = []
    for d in (1, 2):  # yesterday, today
        ks, curves = _fmi(x[(d - 1) * DAY:(d + 2) * DAY], y[(d - 1) * DAY:(d + 2) * DAY],
                          max(0, min(DAY, upto - d * DAY)))
        if curves:
            fits[d] = curves
        for b, k in enumerate(ks):
            start = d * DAY + b * 180
            if start < upto:
                blocks.append((start, k, start + 180 > upto))
    return x, y, upto, fits, blocks


def _quiet_h(fits, i):
    """H of the quiet curve at minute i of the four-day array, blending the days either
    side of midnight; minutes of a day with no curve borrow the nearest day's."""
    d, t = divmod(i, DAY)
    if d not in fits:
        if not fits:
            return np.nan
        near = min(fits, key=lambda k: abs(k - d))
        fx, fy = fits[near]
        tt = i - near * DAY
        return float(np.hypot(fx(tt), fy(tt)))
    fx, fy = fits[d]
    h = float(np.hypot(fx(t), fy(t)))
    other, w = None, 1.0
    if t < 60 and d - 1 in fits:
        other, w = d - 1, 0.5 + t / 120.0
    elif t >= DAY - 60 and d + 1 in fits:
        other, w = d + 1, 0.5 + (DAY - t) / 120.0
    if other is not None:
        ox, oy = fits[other]
        tt = i - other * DAY
        h = w * h + (1.0 - w) * float(np.hypot(ox(tt), oy(tt)))
    return h


def _compose(now):
    today = now.date()
    midnight = datetime.combine(today - timedelta(days=2), datetime.min.time(), tzinfo=timezone.utc)
    origin = int(midnight.timestamp() * 1000)  # ms at minute 0 of the four-day array
    per = [(s, _station(s, today, now)) for s in STATIONS]
    end = max(r[2] for _, r in per)
    if not end:
        return None
    start = max(0, end - DAY)

    for key in [k for k in _days if k[1] < today - timedelta(days=2)]:
        del _days[key]

    out = []
    for s, (x, y, upto, fits, blocks) in per:
        dh = []
        for i in range(start, start + DAY):
            if i >= upto or np.isnan(x[i]) or np.isnan(y[i]):
                dh.append(None)
                continue
            q = _quiet_h(fits, i)
            dh.append(None if np.isnan(q) else round(float(np.hypot(x[i], y[i])) - q, 1))
        out.append({
            "id": s[0],
            "name": s[1],
            "lat": s[2],
            "lon": s[3],
            "latest": origin + (upto - 1) * 60000 if upto else None,
            "dH": dh,
            "k": [{"start": origin + b * 60000, "k": k, "running": running}
                  for b, k, running in blocks if b + 180 > start],
        })
    return {
        "source": "MagIE, the Magnetic Network of Ireland (DIAS)",
        "k9": K9,
        "start": origin + start * 60000,
        "step": 60000,
        "built": int(now.timestamp() * 1000),
        "stations": out,
    }


@bp.route("/magie")
def magie():
    global _payload, _built
    fresh = _payload is not None and time.time() - _built < CACHE_S
    if not fresh:
        # One rebuild at a time; anyone else gets the last payload rather than waiting.
        if _lock.acquire(blocking=_payload is None):
            try:
                if _payload is None or time.time() - _built >= CACHE_S:
                    try:
                        payload = _compose(datetime.now(timezone.utc))
                    except (requests.RequestException, ValueError) as err:
                        if _payload is None:
                            return jsonify({"error": "MagIE unavailable: %s" % err}), 502
                        payload = None
                    if payload is not None:
                        _payload, _built = payload, time.time()
            finally:
                _lock.release()
    if _payload is None:
        return jsonify({"error": "No MagIE data yet"}), 503
    resp = jsonify(_payload)
    resp.headers["Cache-Control"] = "public, max-age=30"
    return resp
