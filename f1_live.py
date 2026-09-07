"""
/f1/live — the current Formula 1 session, composed into one payload for jeremy.ie/f1.

Why this sits on the server at all: OpenF1's live feed needs an OAuth2 bearer token, and
minting one means transmitting a username and password. In browser JS those are readable
by anyone who opens the page, so the credentials live here and the browser only ever sees
the composed JSON below. The rate limit makes a server cache a good idea too — the
authenticated allowance is 6 req/s and 60 req/min *per account*, a budget shared by every
visitor at once — but the credentials are the reason this module exists.

The shape of the upstream API drives most of the design here:

  * Every endpoint is a time series, not a current state. To know who is P7 you read the
    `position` stream and keep the most recent record per driver — and a driver who has
    held P7 for twenty laps has no record in the last ninety seconds at all. So each
    stream is merged into a persistent per-driver accumulator (_Session below) rather than
    read fresh each poll.
  * Comparison operators go in the query string as `date>=2026-09-06T13:00:00`. They must
    be built into the URL by hand: requests' `params=` dict encodes the operator itself,
    turning `date>=` into `date%3E%3D=`, which the API answers with a 404.
  * Safety car state carries no `flag` field — it has to be read out of the message text.
    See _fold_flag.

Replay mode (`?replay=<session_key>&t=<iso>`) serves the same composed shape from historical
data as of a given instant, unauthenticated. The whole front end and the flag state machine
can be built and tested against a past race on the free tier.
"""

import bisect
import os
import re
import threading
import time
from collections import OrderedDict, deque
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests
from flask import Blueprint, jsonify, request

bp = Blueprint("f1_live", __name__)

OPENF1 = "https://api.openf1.org/v1"
OPENF1_TOKEN_URL = "https://api.openf1.org/token"
OPENF1_USER = os.environ.get("OPENF1_USER", "")
OPENF1_PASS = os.environ.get("OPENF1_PASS", "")

# How long a composed payload is served before the streams underneath it are refreshed.
# The client polls every 3s; this is what stops ten viewers costing ten times the upstream.
COMPOSE_TTL = 2.0

# Per-stream refresh intervals, in seconds, and the whole rate-limit budget in one place.
#
# A continuously-watched race costs the sum of 60/TTL over this table, whatever the number
# of viewers, because the compose is cached. As set below that is:
#
#   intervals 15 + position 12 + race_control 10 + laps 6 + pit 2 + stints 1.3
#   + session_result 1 + sessions 1 + drivers 0.2  ~=  48 calls a minute
#
# against a ceiling of 60. The earlier, tighter set ran at ~53 and left so little headroom
# that the OPTIONAL skid below engaged on and off through a race for no real benefit.
# `intervals` is the one that has to stay fast: it is what the gap column is made of, and
# upstream only republishes it every 4s anyway. `position` can lag it by a second without
# anything being visible, since both land in the same table on the same 3s client poll.
# Rebalanced when `location` was added for the track map. `location` is 3.6 Hz per car and
# cannot be polled fast enough for smooth motion inside this budget, so the client fetches a
# window and plays it back against the wall clock instead — see the buffer in f1-map.js. The
# streams that gave up time here are the ones whose extra latency is invisible on screen.
TTL = {
    "sessions": 60.0,
    "drivers": 300.0,
    "position": 6.0,
    "intervals": 4.0,
    "location": 6.0,
    "race_control": 8.0,
    "laps": 15.0,
    "stints": 45.0,
    "pit": 30.0,
    "session_result": 120.0,
}

# The timestamp column each stream can be filtered on. Endpoints missing from this map have
# no date column at all — `drivers`, `stints` and `session_result` are flat per-driver
# tables — and filtering them by date returns an empty set rather than everything.
DATE_FIELD = {
    "position": "date",
    "intervals": "date",
    "location": "date",
    "race_control": "date",
    "laps": "date_start",
    "pit": "date",
}

# How far back each windowed stream looks on a routine refresh. Comfortably longer than the
# matching TTL, so a slow refresh cycle cannot step over records. The first refresh of a
# session ignores these entirely and reads the stream whole — see filters() in _refresh.
WINDOW = {
    "position": 90,
    "intervals": 30,
    "location": 8,
    "laps": 180,
    "pit": 300,
}

# The lookback for the *first* read of a session, where one is safe.
#
# `position` and `pit` emit only when something changes, so their first read has no lower
# bound at all — a leader who has held P1 since lights out last appeared on the grid, and
# windowing him out leaves a hole at the top of the order. `intervals` and `laps` produce a
# record for every car continuously, so a window wide enough to cover a slow lap under a
# safety car is guaranteed to see all of them, and reading the whole race instead would
# pull tens of thousands of rows to use twenty.
FIRST_WINDOW = {
    "intervals": 120,
    "laps": 300,
    # Positions on track are only ever wanted as "where is everyone now"; there is no history
    # to rebuild, and the whole session would be half a million rows.
    "location": 8,
}

# Streams that may be skipped when the minute's call budget is nearly spent. Order matters:
# the running order and the flags are what the page is for, so position, intervals and
# race_control are never dropped.
OPTIONAL = ("session_result", "stints", "pit", "laps", "location")

# Outbound rate limiting. OpenF1 publishes 6 req/s and 60 req/min for an authenticated
# account and 3 req/s and 30 req/min without one, and answers a breach with a 429. Replay
# runs unauthenticated on the free tier, so the ceiling depends on which we are using.
LIMITS = {
    True: (5, 55),    # authenticated
    False: (2, 25),   # free tier, as used by replay
}

_calls = deque()          # timestamps of recent upstream calls, for the throttle
_calls_lock = threading.Lock()

_token = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()

# One lock around the whole refresh-and-compose. Held while upstream calls are in flight, so
# a burst of visitor polls collapses into a single refresh rather than a stampede.
_refresh_lock = threading.Lock()
_composed = {"payload": None, "ts": 0.0}


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def _now():
    return datetime.now(timezone.utc)


def _parse_dt(value):
    """
    Parse an OpenF1 timestamp into an aware UTC datetime.

    They arrive as '...+00:00' and occasionally as '...Z'. A replay's ?t= is typed by hand
    and usually carries no offset at all; anything naive is read as UTC, so that every
    datetime in this module is comparable with every other.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _iso(dt):
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _api_time(dt):
    """The timestamp format OpenF1's filters expect: naive UTC, no offset, no 'Z'."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def _bearer(force=False):
    """
    A valid bearer token, minted on demand.

    OpenF1 documents no refresh token, and none is needed: the credentials themselves are
    the refresh mechanism, and re-posting them buys another hour. At roughly one call per
    55 minutes this is invisible next to the rest of the traffic.
    """
    now = time.time()
    with _token_lock:
        if _token["value"] and not force and now < _token["expires"]:
            return _token["value"]
        if not OPENF1_USER or not OPENF1_PASS:
            raise RuntimeError("OPENF1_USER / OPENF1_PASS are not set")

        response = requests.post(
            OPENF1_TOKEN_URL,
            data={"username": OPENF1_USER, "password": OPENF1_PASS},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()

        _token["value"] = data["access_token"]
        # expires_in comes back as a string ("3600"), not a number. Renew five minutes
        # early so no in-flight request can straddle the expiry.
        _token["expires"] = now + int(data["expires_in"]) - 300
        return _token["value"]


# ---------------------------------------------------------------------------
# Upstream fetch
# ---------------------------------------------------------------------------

def _throttle(authed=True):
    """Block just long enough to stay inside the per-second allowance."""
    per_second = LIMITS[bool(authed)][0]
    while True:
        with _calls_lock:
            now = time.time()
            while _calls and now - _calls[0] > 60.0:
                _calls.popleft()
            recent = sum(1 for t in _calls if now - t < 1.0)
            if recent < per_second:
                _calls.append(now)
                return
        time.sleep(0.08)


def _budget_left(authed=True):
    """Upstream calls still available in the trailing minute."""
    with _calls_lock:
        now = time.time()
        while _calls and now - _calls[0] > 60.0:
            _calls.popleft()
        return LIMITS[bool(authed)][1] - len(_calls)


def _get(path, filters, authed=True):
    """
    One upstream GET.

    `filters` is a list of (key, value) pairs where the key carries its own operator, e.g.
    ("date>=", "2026-09-06T13:00:00"). The query string is assembled by hand because
    requests' params= would encode the operator into the key and the API would 404.
    """
    parts = []
    for key, value in filters:
        if value is None:
            continue
        parts.append(key + ("" if key.endswith(("=", ">", "<")) else "=") + quote(str(value), safe=":"))
    url = OPENF1 + "/" + path + ("?" + "&".join(parts) if parts else "")

    headers = {"User-Agent": "jeremy.ie-f1/1.0 (mailto:jeremy.rigney@gmail.com)"}
    if authed:
        headers["Authorization"] = "Bearer " + _bearer()

    _throttle(authed)
    response = requests.get(url, headers=headers, timeout=12)

    # A token revoked early, or clock skew. Mint a fresh one and try once more.
    if response.status_code == 401 and authed:
        headers["Authorization"] = "Bearer " + _bearer(force=True)
        _throttle(authed)
        response = requests.get(url, headers=headers, timeout=12)

    # The throttle above keeps us inside the published allowance, but it cannot see calls
    # made by anything else on the same account. Back off and retry rather than dropping
    # the stream — a 429 on `position` would empty the running order.
    for attempt in range(2):
        if response.status_code != 429:
            break
        time.sleep(float(response.headers.get("Retry-After") or (0.6 * (attempt + 1))))
        _throttle(authed)
        response = requests.get(url, headers=headers, timeout=12)

    # "No results found" is how this API says an empty set, on endpoints that have not
    # started producing yet — intervals before the race, session_result before the flag.
    if response.status_code == 404:
        return []

    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, list) else []


# ---------------------------------------------------------------------------
# The flag state machine
# ---------------------------------------------------------------------------

# Verified against the 2025 Dutch GP (session_key 9920), which had three safety cars and a
# virtual safety car. Two things there are easy to get wrong:
#
#   * SafetyCar records carry flag: null and scope: null. The state is only in the message.
#   * The return to green after a safety car is CLEAR/Track ("TRACK CLEAR"), not GREEN.
#     GREEN/Track fires at pit-exit-open, so a machine keyed on GREEN stays yellow all race.

FLAG_PRECEDENCE = ("RED", "SAFETY_CAR", "VSC", "YELLOW", "CHEQUERED", "GREEN")


def _fold_flag(messages, until=None):
    """
    Fold the race_control stream forward into a single current flag state.

    The governing rule, and the one the data forces: **only a track-wide green or clear
    ends anything.** Two observed behaviours in the 2025 Dutch GP make that necessary.

    Sector yellows are frequently never cleared individually. Six sectors went yellow for a
    pit-entry incident before the race and stayed that way in the feed; what actually
    cleared them was `GREEN LIGHT - PIT EXIT OPEN` at the start. Expiring them only on a
    matching per-sector CLEAR leaves the page yellow for a whole green-flag race.

    And `SAFETY CAR IN THIS LAP` / `VIRTUAL SAFETY CAR ENDING` are advisories, not the
    restart — the car comes in at the end of the lap and the race stays neutralised until
    the green. They are reported through `ending` so the panel can read "SAFETY CAR — IN
    THIS LAP", the way a timing screen does, without leaving the state early.

    Returns (state, since, message, sectors, ending).
    """
    sectors = {}
    safety = None            # "SAFETY_CAR" | "VSC" | None
    ending = False           # safety car called in, but not yet green
    track = "GREEN"          # the track-wide flag: GREEN, RED or CHEQUERED
    suspended = False        # the session itself is stopped, not merely neutralised
    finished = False
    since = {}
    triggered = {}

    def mark(state, when, text):
        # Only the moment a state was entered, so "since" does not reset on every repeat.
        if since.get("state") != state:
            since["state"] = state
            since["at"] = when
            triggered["message"] = text

    for row in sorted(messages, key=lambda r: str(r.get("date") or "")):
        when = _parse_dt(row.get("date"))
        if until is not None and when is not None and when > until:
            break

        category = row.get("category")
        flag = (row.get("flag") or "").upper()
        scope = row.get("scope")
        text = (row.get("message") or "").upper()

        if category == "SafetyCar":
            if "DEPLOYED" in text:
                safety = "VSC" if "VIRTUAL" in text else "SAFETY_CAR"
                ending = False
            elif "IN THIS LAP" in text or "ENDING" in text:
                ending = True

        elif category == "Flag":
            if scope == "Sector":
                sector = row.get("sector")
                if flag in ("YELLOW", "DOUBLE YELLOW"):
                    sectors[sector] = flag
                elif flag == "CLEAR":
                    sectors.pop(sector, None)
            elif scope == "Track":
                if flag == "RED":
                    track = "RED"
                elif flag == "CHEQUERED":
                    track = "CHEQUERED"
                elif flag in ("GREEN", "CLEAR"):
                    # The restart. GREEN is pit-exit-open at a start or after a red;
                    # CLEAR ("TRACK CLEAR") is what follows a safety car. Either one means
                    # the track is wholly green, so everything outstanding goes with it.
                    track = "GREEN"
                    sectors.clear()
                    safety = None
                    ending = False

        elif category == "SessionStatus":
            if "FINISHED" in text:
                finished = True
            elif "ABORTED" in text:
                # A stopped session, which is not the same thing as a red flag on the
                # track. Marshals clear the circuit long before the race resumes — at
                # Zandvoort in 2026, TRACK CLEAR came 25 minutes before the restart — so
                # this deliberately cannot be lifted by any flag, only by the session
                # starting again below.
                suspended = True
            elif "STARTED" in text:
                # Running again, so neither stopped nor over. Test days in particular
                # report several finishes and restarts under one session key.
                suspended = False
                finished = False

        # The red flag does not always arrive as a flag. Zandvoort 2026 reported it only as
        # prose — category "Other", no flag field, no scope — while 2025 sessions used a
        # proper Flag/RED/Track record. Both forms have to count, or a suspended race reads
        # as whatever sector yellows happen to be out at the time.
        if category != "Flag" and "RED FLAG" in text:
            track = "RED"

        # Resolve after each record so `since` tracks the true moment of the transition.
        #
        # Once the session is over the chequered flag latches. Marshals go on recovering cars
        # through the cool-down lap and race control keeps issuing sector yellows for it, and
        # without this the panel announces a yellow flag several minutes after the race has
        # finished — which is what the 2025 Dutch GP timeline showed.
        # A stopped session outranks a finished one: a red flag shown after the flag is
        # still the more urgent thing on the page.
        if suspended or track == "RED":
            state = "RED"
        elif finished:
            state = "CHEQUERED"
        elif safety:
            state = safety
        elif sectors:
            state = "YELLOW"
        elif track == "CHEQUERED":
            state = "CHEQUERED"
        else:
            state = "GREEN"
        mark(state, when, row.get("message") or "")

    return (
        since.get("state", "GREEN"),
        since.get("at"),
        triggered.get("message", ""),
        sorted(s for s in sectors if s is not None),
        ending and safety is not None,
    )


# ---------------------------------------------------------------------------
# Race events
# ---------------------------------------------------------------------------

# Race control's prose, turned into something the page can render and group by driver.
#
# Every message that concerns a car names it as `CAR 16 (LEC)`, including the multi-car form
# `CARS 16 (LEC) AND 44 (HAM)`, so one expression finds the drivers for all of them.
#
# The classifier is deliberately a table rather than a chain of ifs: "more information as I
# go" means new message types arrive regularly, and adding one should be adding a row here.
# Order matters — the first match wins, so the specific patterns sit above the general ones.
_CAR_RE = re.compile(r"CAR[S]?\s+(\d+)\s*\(([A-Z]{3})\)(?:\s+AND\s+(\d+)\s*\(([A-Z]{3})\))?")

EVENT_TYPES = (
    # (type,            severity, test applied to the upper-cased message)
    ("penalty",         "high",   lambda m: "PENALTY" in m),
    ("deletion",        "low",    lambda m: "DELETED" in m),
    # "NO FURTHER ACTION" and "REVIEWED" close an investigation; they must be caught before
    # the investigation test below, or a car is left showing as under scrutiny all race.
    ("cleared",         "low",    lambda m: "NO FURTHER ACTION" in m or "NO FURTHER INVESTIGATION" in m),
    ("investigation",   "high",   lambda m: "INVESTIGAT" in m or " NOTED" in m),
    ("pit-lane",        "info",   lambda m: m.startswith("PIT ") or "PIT LANE" in m or "PIT EXIT" in m),
    ("override",        "info",   lambda m: m.startswith("OVERTAKE ")),
    ("weather",         "info",   lambda m: "RISK OF RAIN" in m),
    ("start",           "info",   lambda m: m in ("RACE START", "SESSION STARTED")),
)


def parse_event(row):
    """
    One race-control row as a renderable event, or None if it is not worth showing.

    Flag and safety-car rows are excluded: those already drive the flag state at the top of
    the panel, and repeating them in the feed would just be noise next to it.
    """
    message = (row.get("message") or "").strip()
    if not message:
        return None

    category = row.get("category")
    if category in ("Flag", "SafetyCar"):
        return None

    upper = message.upper()
    kind, severity = "note", "info"
    for name, level, test in EVENT_TYPES:
        if test(upper):
            kind, severity = name, level
            break

    drivers = []
    match = _CAR_RE.search(upper)
    if match:
        drivers.append(int(match.group(1)))
        if match.group(3):
            drivers.append(int(match.group(3)))

    return {
        "t": _iso(_parse_dt(row.get("date"))),
        "type": kind,
        "severity": severity,
        "drivers": drivers,
        "lap": row.get("lap_number"),
        "text": message,
    }


def build_events(messages, until=None):
    """The event feed, newest first, plus the per-driver badges folded out of it."""
    events = []
    for row in sorted(messages, key=lambda r: str(r.get("date") or "")):
        when = _parse_dt(row.get("date"))
        if until is not None and when is not None and when > until:
            break
        event = parse_event(row)
        if event:
            events.append(event)

    # Badges are the standing state per car, so a later "no further action" clears the
    # investigation that an earlier message raised rather than sitting alongside it.
    badges = {}
    for event in events:
        for num in event["drivers"]:
            held = badges.setdefault(num, set())
            if event["type"] == "cleared":
                held.discard("investigation")
            elif event["type"] in ("investigation", "penalty", "deletion"):
                held.add(event["type"])

    events.reverse()
    return events, {num: sorted(held) for num, held in badges.items() if held}


# ---------------------------------------------------------------------------
# Per-session accumulators
# ---------------------------------------------------------------------------

class _Session:
    """
    The merged state of one session.

    Each stream is a time series that only reports changes, so every refresh merges its
    window into these dicts rather than replacing them. Reset when the session key changes.
    """

    def __init__(self, key):
        self.key = key
        self.fetched = {}        # stream -> monotonic time of last successful refresh
        self.drivers = {}        # num -> driver record
        self.position = {}       # num -> {"position", "date"}
        self.intervals = {}      # num -> {"gap_to_leader", "interval", "date"}
        self.laps = {}           # num -> latest lap record
        self.best = {}           # num -> best lap_duration seen
        self.stints = {}         # num -> list of stint records
        self.pit = {}            # num -> {"stops", "last"}
        self.race_control = []
        self.result = {}         # num -> session_result record
        self.location = {}       # num -> latest {"x", "y", "date"}

    def stale(self, stream):
        last = self.fetched.get(stream)
        return last is None or (time.monotonic() - last) >= TTL[stream]

    def first_time(self, stream):
        return stream not in self.fetched


_session = None


def _sortable(row, key):
    """
    A comparable form of one field, so `date` strings and `lap_number` integers can both be
    ordered by the same merge. Comparing lap numbers as text would put lap 9 after lap 10.
    """
    value = row.get(key)
    if value is None:
        return (0, 0.0, "")
    if isinstance(value, (int, float)):
        return (1, float(value), "")
    return (1, 0.0, str(value))


def _merge_latest(target, rows, key="date"):
    """Keep the most recent record per driver, comparing on `key`."""
    for row in rows:
        num = row.get("driver_number")
        if num is None:
            continue
        current = target.get(num)
        if current is None or _sortable(row, key) >= _sortable(current, key):
            target[num] = row


# ---------------------------------------------------------------------------
# Refresh
# ---------------------------------------------------------------------------

def _refresh(state, session, until=None, authed=True):
    """Bring every stale stream up to date. Individual failures leave the last good data."""
    key = session["session_key"]
    is_race = (session.get("session_type") == "Race")
    budget = _budget_left(authed)

    def filters(stream):
        """
        The query for one stream.

        The date field differs per endpoint and several endpoints have none at all —
        `drivers`, `stints` and `session_result` are flat per-driver tables, and sending
        them a `date<=` filters on a column that does not exist and returns nothing.
        `laps` keys on `date_start` rather than `date`.
        """
        out = [("session_key", key)]
        field = DATE_FIELD.get(stream)
        if not field:
            return out

        if state.first_time(stream):
            lookback = FIRST_WINDOW.get(stream)
        else:
            lookback = WINDOW.get(stream)

        if lookback is not None:
            # Anchored on the replay instant rather than the wall clock. Under replay those
            # are years apart, and a lower bound of "now minus 90 seconds" against an upper
            # bound in a past season selects nothing at all.
            anchor = until if until is not None else _now()
            out.append((field + ">=", _api_time(anchor - timedelta(seconds=lookback))))
        if until is not None:
            out.append((field + "<=", _api_time(until)))
        return out

    plan = [
        ("position", lambda: _merge_latest(state.position, _get("position", filters("position"), authed))),
        # Replaced wholesale rather than merged: the whole stream is about a hundred rows a
        # race, and the fold that reads it is stateless, so there is nothing to accumulate.
        ("race_control", lambda: _replace(state.race_control, _get("race_control", filters("race_control"), authed))),
    ]
    if is_race:
        plan.append(
            ("intervals", lambda: _merge_latest(state.intervals, _get("intervals", filters("intervals"), authed)))
        )
    plan.extend([
        ("location", lambda: _merge_latest(state.location, _get("location", filters("location"), authed))),
        ("laps", lambda: _merge_laps(state, _get("laps", filters("laps"), authed))),
        ("pit", lambda: _merge_pit(state, _get("pit", filters("pit"), authed))),
        ("stints", lambda: _merge_stints(state, _get("stints", filters("stints"), authed))),
        ("drivers", lambda: _by_driver(state.drivers, _get("drivers", filters("drivers"), authed))),
        ("session_result", lambda: _by_driver(state.result, _get("session_result", filters("session_result"), authed))),
    ])

    for stream, run in plan:
        if not state.stale(stream):
            continue
        # Under budget pressure, keep the running order and the flags and drop the rest.
        if stream in OPTIONAL and budget < 8 and not state.first_time(stream):
            continue
        try:
            run()
            state.fetched[stream] = time.monotonic()
        except Exception:
            # A single bad refresh must not blank the page; the previous values stand.
            pass


def _replace(target, rows):
    target[:] = rows


def _by_driver(target, rows):
    """One record per driver, latest write wins. For streams that report a whole set."""
    for row in rows:
        num = row.get("driver_number")
        if num is not None:
            target[num] = row


def _merge_laps(state, rows):
    _merge_latest(state.laps, rows, key="lap_number")
    for row in rows:
        num = row.get("driver_number")
        duration = row.get("lap_duration")
        if num is None or not duration:
            continue
        if state.best.get(num) is None or duration < state.best[num]:
            state.best[num] = duration


def _merge_pit(state, rows):
    for row in rows:
        num = row.get("driver_number")
        if num is None:
            continue
        entry = state.pit.setdefault(num, {"laps": set(), "last": None})
        entry["laps"].add(row.get("lap_number"))
        if entry["last"] is None or str(row.get("date") or "") >= str(entry["last"].get("date") or ""):
            entry["last"] = row


def _merge_stints(state, rows):
    grouped = {}
    for row in rows:
        num = row.get("driver_number")
        if num is None:
            continue
        grouped.setdefault(num, []).append(row)
    for num, items in grouped.items():
        state.stints[num] = sorted(items, key=lambda r: r.get("stint_number") or 0)


# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------

# How far behind the rest of the field a car's timing can fall before it is treated as out.
DNF_SILENCE_S = 150

# How long after lights out to start believing any of it. In the opening minutes the field
# is still completing its first laps and cars have not all reported an interval yet, so
# staleness means nothing — without this the leader was briefly shown as retired thirty
# seconds into the race.
DNF_WARMUP_S = 360


def _infer_retired(state, start=None):
    """
    Cars that have gone quiet while the rest of the field is still reporting.

    `session_result` is the only thing that actually says who retired, and it carries no
    timestamp at all — it is the final classification, nothing more. Using it directly meant
    every car that would eventually retire was greyed out from lap one, which is worse than
    useless in a replay.

    Every running car gets an `intervals` record every few seconds, so silence is the
    signal. The subtlety is what to measure silence against: not the clock, because a red
    flag stops the timing for the whole field at once — Zandvoort 2026 went 26 minutes
    without a single record — and a clock-based rule would retire all twenty-two cars. So
    staleness is measured against the newest record anywhere in the field, which moves with
    the field, sits still through a stoppage, and jumps forward on the restart, leaving only
    the genuinely stopped cars behind it.
    """
    stamps = {}
    for num, row in state.intervals.items():
        when = _parse_dt((row or {}).get("date"))
        if when is not None:
            stamps[num] = when
    # Too early to tell: before the field has settled there is nothing to compare against.
    if len(stamps) < 6:
        return set()

    # The median, not the newest. A single stray record moves the newest and takes the whole
    # field with it — one car reporting at 13:16 during Zandvoort's stoppage, when everyone
    # else had been silent since 13:07, retired twenty-one cars at once. The median sits
    # among the runners whatever one car does, and only a genuine minority falls behind it.
    reference = sorted(stamps.values())[len(stamps) // 2]

    # Nothing is stale before the race has run long enough for staleness to mean anything.
    if start is not None and (reference - start).total_seconds() < DNF_WARMUP_S:
        return set()

    cutoff = reference - timedelta(seconds=DNF_SILENCE_S)
    return set(num for num, when in stamps.items() if when < cutoff)


def _gap(value):
    """gap_to_leader and interval are floats, except when they are '+1 LAP' strings."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return round(float(value), 3)
    return str(value)


def _compose(state, session, flag_until=None):
    start = _parse_dt(session.get("date_start"))
    flag_state, flag_since, flag_message, flag_sectors, flag_ending = _fold_flag(
        state.race_control, flag_until)
    events, badges = build_events(state.race_control, flag_until)

    # The final classification is only trustworthy once there is one. Until the flag falls,
    # who is out has to be read from the timing itself.
    over = (flag_state == "CHEQUERED")
    retired = _infer_retired(state, start)

    numbers = set(state.drivers) | set(state.position)
    rows = []
    for num in numbers:
        driver = state.drivers.get(num, {})
        position = (state.position.get(num) or {}).get("position")
        interval = state.intervals.get(num) or {}
        lap = state.laps.get(num) or {}
        result = state.result.get(num) or {}

        stints = state.stints.get(num) or []
        stint = stints[-1] if stints else {}
        compound = stint.get("compound")
        tyre_age = None
        if stint and lap.get("lap_number") is not None and stint.get("lap_start") is not None:
            age = (stint.get("tyre_age_at_start") or 0) + (lap["lap_number"] - stint["lap_start"])
            tyre_age = max(age, 0)

        pit = state.pit.get(num) or {}
        pit_laps = pit.get("laps") or set()
        last_pit = pit.get("last") or {}
        # A stop is reported once the car leaves, so "in the pits" is really "pitted on the
        # lap the timing screen still shows them on".
        in_pit = bool(lap.get("is_pit_out_lap")) or (
            last_pit.get("lap_number") is not None
            and last_pit.get("lap_number") == lap.get("lap_number")
        )

        where = state.location.get(num) or {}

        rows.append({
            "pos": position,
            "num": num,
            "code": driver.get("name_acronym"),
            "name": driver.get("full_name") or driver.get("broadcast_name"),
            "team": driver.get("team_name"),
            "colour": driver.get("team_colour"),
            "gapToLeader": _gap(interval.get("gap_to_leader")),
            "interval": _gap(interval.get("interval")),
            "lastLap": lap.get("lap_duration"),
            "bestLap": state.best.get(num),
            "lap": lap.get("lap_number"),
            "compound": compound,
            "tyreAge": tyre_age,
            "inPit": in_pit,
            "pitStops": len([n for n in pit_laps if n is not None]),
            "dnf": (bool(result.get("dnf") or result.get("dns") or result.get("dsq"))
                    if over else num in retired),
            # Standing race-control state for this car: investigation, penalty, deletion.
            "badges": badges.get(num, []),
            # The whole stint history, not just the tyre currently on the car.
            "stints": [
                {"compound": s.get("compound"), "lapStart": s.get("lap_start"),
                 "lapEnd": s.get("lap_end"), "age": s.get("tyre_age_at_start")}
                for s in stints
            ],
            # F1-frame decimetres. The browser maps these onto the circuit path with the
            # affine in the circuit's locationTransform.
            "xy": [where.get("x"), where.get("y")] if where.get("x") is not None else None,
        })

    # Cars without a position yet sort to the back, in driver-number order.
    rows.sort(key=lambda r: (r["pos"] is None, r["pos"] or 0, r["num"]))

    current_lap = max(
        [r["lap"] for r in rows if r["lap"] is not None] or [None],
        key=lambda v: -1 if v is None else v,
    )

    return {
        "live": True,
        "generated": _iso(_now()),
        "session": {
            "key": session.get("session_key"),
            "name": session.get("session_name"),
            "type": session.get("session_type"),
            "circuit": session.get("circuit_short_name"),
            # Formula 1's own circuit id, which is how the page matches a session back to
            # our circuit geometry. Names are unreliable for this; see f1-lab.js.
            "circuitKey": session.get("circuit_key"),
            "location": session.get("location"),
            "start": _iso(start),
            "end": _iso(_parse_dt(session.get("date_end"))),
        },
        "flag": {
            "state": flag_state,
            "since": _iso(flag_since),
            "message": flag_message,
            "sectors": flag_sectors,
            "ending": flag_ending,
        },
        "lap": {"current": current_lap},
        "drivers": rows,
        "events": events[:40],
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# A session is treated as live from 15 minutes before its scheduled start until 30 minutes
# after its scheduled end — wide enough to cover a delayed start and a red-flag stoppage
# running long, narrow enough that the page shows nothing on a Tuesday.
LEAD_IN = timedelta(minutes=15)
LEAD_OUT = timedelta(minutes=30)


def _is_live(session):
    start = _parse_dt(session.get("date_start"))
    end = _parse_dt(session.get("date_end"))
    if start is None:
        return False
    if end is None:
        end = start + timedelta(hours=2)
    now = _now()
    return (start - LEAD_IN) <= now <= (end + LEAD_OUT)


def _idle(session=None, reason="no session"):
    payload = {"live": False, "generated": _iso(_now()), "reason": reason}
    if session:
        payload["session"] = {
            "key": session.get("session_key"),
            "name": session.get("session_name"),
            "circuit": session.get("circuit_short_name"),
            "start": _iso(_parse_dt(session.get("date_start"))),
        }
    return payload


@bp.route("/f1/replay/sessions")
def f1_replay_sessions():
    """Sessions the lab can load, newest first. Free tier, so 2023 onwards."""
    year = request.args.get("year") or _now().year
    try:
        rows = _get("sessions", [("year", int(year))], authed=False)
    except Exception as error:
        return jsonify({"error": str(error)}), 502

    out = [{
        "key": s.get("session_key"),
        "name": s.get("session_name"),
        "type": s.get("session_type"),
        "circuit": s.get("circuit_short_name"),
        "circuitKey": s.get("circuit_key"),
        "country": s.get("country_name"),
        "start": _iso(_parse_dt(s.get("date_start"))),
        "end": _iso(_parse_dt(s.get("date_end"))),
    } for s in rows if not s.get("is_cancelled")]
    out.sort(key=lambda s: str(s["start"] or ""), reverse=True)
    return jsonify({"year": int(year), "sessions": out})


@bp.route("/f1/replay/timeline")
def f1_replay_timeline():
    """
    What the scrubber draws its marks from: every flag period and every event in one pass.

    This is the whole reason the lab exists — being able to see that a safety car came out at
    14:12 and jump straight to it, rather than hunting for the moment a feature has to handle.
    """
    try:
        key = int(request.args.get("session_key") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "session_key must be numeric"}), 400

    replay = _replay_session(key)
    if replay is None:
        return jsonify({"error": "unknown session_key %s" % key}), 404

    session = replay.session
    start = _parse_dt(session.get("date_start"))
    end = _parse_dt(session.get("date_end"))

    # Re-fold the flag machine at each race-control timestamp and record where the answer
    # changes. Using the real state machine means the marks cannot disagree with the panel.
    periods = []
    for row in replay.race_control:
        when = _parse_dt(row.get("date"))
        if when is None:
            continue
        state = _fold_flag(replay.race_control, when)[0]
        if periods and periods[-1]["state"] == state:
            continue
        if periods:
            periods[-1]["to"] = _iso(when)
        periods.append({"state": state, "from": _iso(when), "to": None})
    if periods:
        periods[-1]["to"] = _iso(end) if end else None

    events, _ = build_events(replay.race_control)
    events.reverse()  # chronological, for laying marks along a timeline

    return jsonify({
        "session": {
            "key": key,
            "name": session.get("session_name"),
            "circuit": session.get("circuit_short_name"),
            # Formula 1's own circuit id. The only reliable way back to our geometry — the
            # short names above disagree with our circuit names on a third of the calendar.
            "circuitKey": session.get("circuit_key"),
            "country": session.get("country_name"),
        },
        "start": _iso(start),
        "end": _iso(end),
        "periods": periods,
        "events": events,
    })


@bp.route("/f1/live")
def f1_live():
    replay = request.args.get("replay")
    if replay:
        return jsonify(_replay(
            replay,
            request.args.get("t"),
            with_location=request.args.get("nolocation") != "1",
        ))

    now = time.time()
    cached = _composed["payload"]
    if cached is not None and (now - _composed["ts"]) < COMPOSE_TTL:
        return jsonify(cached)

    with _refresh_lock:
        # Another thread may have refreshed while this one waited for the lock.
        now = time.time()
        if _composed["payload"] is not None and (now - _composed["ts"]) < COMPOSE_TTL:
            return jsonify(_composed["payload"])

        try:
            payload = _build()
        except Exception as error:
            if _composed["payload"] is not None:
                stale = dict(_composed["payload"])
                stale["stale"] = True
                return jsonify(stale)
            return jsonify({"live": False, "error": str(error)}), 502

        _composed["payload"] = payload
        _composed["ts"] = time.time()
        return jsonify(payload)


_session_cache = {"session": None, "ts": 0.0}


def _current_session():
    """
    The session to show, chosen by the clock rather than by `session_key=latest`.

    `latest` means the most recently *started* session. Two hours before lights out at Monza
    it still names the previous day's qualifying, even though the race session already
    exists in the index — so a page keyed on it would not wake up until the race was
    already under way. Asking for the day's sessions and picking the one whose window
    contains now makes the panel appear at the lead-in, every time.

    Cached for a minute: this is called on every compose, and the calendar does not move.
    """
    now = time.time()
    if _session_cache["session"] is not None and (now - _session_cache["ts"]) < TTL["sessions"]:
        return _session_cache["session"]

    moment = _now()
    sessions = _get("sessions", [
        ("date_start>=", _api_time(moment - timedelta(hours=8))),
        ("date_start<=", _api_time(moment + timedelta(hours=8))),
    ])

    running = [s for s in sessions if _is_live(s)]
    # Practice and qualifying windows never overlap in practice; if two ever did, the one
    # that started most recently is the one on track.
    chosen = sorted(running, key=lambda s: str(s.get("date_start") or ""))[-1] if running else None

    _session_cache["session"] = chosen
    _session_cache["ts"] = now
    return chosen


def _build():
    global _session

    session = _current_session()
    if session is None:
        return _idle(reason="no session running")

    if _session is None or _session.key != session["session_key"]:
        _session = _Session(session["session_key"])

    _refresh(_session, session)
    return _compose(_session, session)


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------

# Streams loaded whole for a replay. `location` is excluded on purpose: at 3.6 Hz for
# twenty-odd cars a race is roughly half a million rows, so the lab fetches it per scrub in a
# short window instead — see _replay_location.
REPLAY_STREAMS = ("race_control", "position", "intervals", "laps", "pit",
                  "stints", "drivers", "session_result")

# How many sessions to keep loaded. Each is a few megabytes; two or three is enough to flip
# between the race being worked on and one being compared against.
REPLAY_CACHE_MAX = 3
_replay_cache = OrderedDict()
_replay_lock = threading.Lock()


class _ReplaySession:
    """
    A whole past session, held raw so it can be replayed at any instant.

    The live `_Session` keeps merged snapshots — latest-per-driver — which cannot be rewound,
    so scrubbing backwards needs the underlying series. Each stream is therefore kept as
    raw rows grouped by driver and sorted by date, and `snapshot(t)` bisects each driver's
    list to find what was true at `t`.

    What it produces is an ordinary `_Session`, so `_compose` and `_fold_flag` run over a
    replay exactly as they run over a live race. That identity is the entire point of the
    lab: a feature developed against a replay is developed against the real code path.
    """

    def __init__(self, key, session):
        self.key = key
        self.session = session
        self.loaded = time.time()
        self.streams = {}        # stream -> {driver_number: ([sort keys], [rows])}
        self.race_control = []
        self.start = _parse_dt(session.get("date_start"))
        # Car positions, in time blocks, loaded as the playhead reaches them.
        self.location_blocks = OrderedDict()

        for name in REPLAY_STREAMS:
            rows = _get(name, [("session_key", key)], authed=False)
            if name == "race_control":
                self.race_control = sorted(rows, key=lambda r: str(r.get("date") or ""))
                continue
            self.streams[name] = self._index(name, rows)

    @staticmethod
    def _index(name, rows):
        """Group by driver and sort by the stream's own time column."""
        field = DATE_FIELD.get(name)
        grouped = {}
        for row in rows:
            num = row.get("driver_number")
            if num is None:
                continue
            grouped.setdefault(num, []).append(row)

        indexed = {}
        for num, items in grouped.items():
            if field:
                items.sort(key=lambda r: str(r.get(field) or ""))
                keys = [str(r.get(field) or "") for r in items]
            else:
                # drivers, stints, session_result carry no timestamp at all. They are
                # session-constant, so every snapshot sees the whole list.
                keys = None
            indexed[num] = (keys, items)
        return indexed

    def _upto(self, name, num, moment):
        """Every row for this driver at or before `moment`."""
        entry = self.streams.get(name, {}).get(num)
        if not entry:
            return []
        keys, items = entry
        if keys is None:
            return items
        return items[:bisect.bisect_right(keys, _api_time(moment) + "￿")]

    def load_location_block(self, index):
        """Fetch and index one block of car positions, once."""
        if index < 0 or index in self.location_blocks:
            if index in self.location_blocks:
                self.location_blocks.move_to_end(index)
            return

        begin = self.start + timedelta(seconds=index * LOCATION_BLOCK_S)
        rows = _get("location", [
            ("session_key", self.key),
            ("date>=", _api_time(begin)),
            ("date<=", _api_time(begin + timedelta(seconds=LOCATION_BLOCK_S))),
        ], authed=False)

        self.location_blocks[index] = self._index("location", rows)
        self.location_blocks.move_to_end(index)
        while len(self.location_blocks) > LOCATION_BLOCKS_MAX:
            self.location_blocks.popitem(last=False)

    def drivers_seen(self):
        seen = set()
        for name in ("drivers", "position"):
            seen |= set(self.streams.get(name, {}))
        return seen

    def snapshot(self, moment):
        """A `_Session` as it stood at `moment`."""
        state = _Session(self.key)
        state.race_control = [
            r for r in self.race_control
            if (_parse_dt(r.get("date")) or moment) <= moment
        ]

        for num in self.drivers_seen():
            for name, target in (("position", state.position), ("intervals", state.intervals)):
                rows = self._upto(name, num, moment)
                if rows:
                    target[num] = rows[-1]

            laps = self._upto("laps", num, moment)
            if laps:
                state.laps[num] = laps[-1]
                timed = [r.get("lap_duration") for r in laps if r.get("lap_duration")]
                if timed:
                    state.best[num] = min(timed)

            stops = self._upto("pit", num, moment)
            if stops:
                state.pit[num] = {
                    "laps": set(r.get("lap_number") for r in stops),
                    "last": stops[-1],
                }

            for name, target in (("drivers", state.drivers), ("session_result", state.result)):
                rows = self._upto(name, num, moment)
                if rows:
                    target[num] = rows[-1]

            # Stints have no timestamp, so they are bounded by the lap the car is on.
            lap_now = (state.laps.get(num) or {}).get("lap_number")
            stints = self._upto("stints", num, moment)
            if lap_now is not None:
                stints = [s for s in stints
                          if s.get("lap_start") is None or s["lap_start"] <= lap_now]
            if stints:
                state.stints[num] = sorted(stints, key=lambda r: r.get("stint_number") or 0)

        return state


def _replay_session(key):
    """The cached replay for one session key, loading it on first use."""
    with _replay_lock:
        cached = _replay_cache.get(key)
        if cached is not None:
            _replay_cache.move_to_end(key)
            return cached

    sessions = _get("sessions", [("session_key", key)], authed=False)
    if not sessions:
        return None
    loaded = _ReplaySession(key, sessions[0])

    with _replay_lock:
        _replay_cache[key] = loaded
        _replay_cache.move_to_end(key)
        while len(_replay_cache) > REPLAY_CACHE_MAX:
            _replay_cache.popitem(last=False)
    return loaded


# Car positions are held in blocks rather than fetched per frame.
#
# A whole session of `location` is around half a million rows, far too much to load in one
# go, but fetching a fresh window for every frame is worse: playback asks for four frames a
# second, and each one was an unauthenticated call against a 2/sec, 25/min allowance. That
# throttled, then stalled for a minute, then delivered a burst — playback that sat still and
# then jumped. Blocks make a scrub or a played second cost nothing once its neighbourhood is
# loaded.
#
# Three minutes is the balance: about fourteen thousand rows a block, and forty blocks for a
# two-hour race, so even a 300x run through the whole thing stays inside the rate limit.
LOCATION_BLOCK_S = 180
LOCATION_BLOCKS_MAX = 12


def _replay_location(replay, moment):
    """Car positions at one replay instant, from the block cache."""
    if replay.start is None:
        return {}

    index = int((moment - replay.start).total_seconds() // LOCATION_BLOCK_S)
    # The previous block too: a car that has not moved — sitting in the pit lane under a red
    # flag — may have no sample in the current one at all.
    for wanted in (index - 1, index):
        replay.load_location_block(wanted)

    latest = {}
    for wanted in (index - 1, index):
        block = replay.location_blocks.get(wanted)
        if not block:
            continue
        for num, (keys, rows) in block.items():
            cut = bisect.bisect_right(keys, _api_time(moment) + "￿")
            if cut:
                row = rows[cut - 1]
                current = latest.get(num)
                if current is None or str(row.get("date") or "") >= str(current.get("date") or ""):
                    latest[num] = row
    return latest


def _replay(session_key, at, with_location=True):
    """
    The same composed shape, from historical data, as of `t`.

    Unauthenticated: this runs on the free tier, so the whole lab costs nothing and works
    without the sponsor credentials.
    """
    try:
        key = int(session_key)
    except (TypeError, ValueError):
        return {"live": False, "error": "replay must be a numeric session_key"}

    replay = _replay_session(key)
    if replay is None:
        return {"live": False, "error": "unknown session_key %s" % key}

    session = replay.session
    start = _parse_dt(session.get("date_start"))
    end = _parse_dt(session.get("date_end"))
    moment = _parse_dt(at) or end or start
    if moment is None:
        return {"live": False, "error": "could not resolve a replay time"}

    state = replay.snapshot(moment)
    if with_location:
        try:
            state.location = _replay_location(replay, moment)
        except Exception:
            # The map simply has no cars for this frame; the rest of the panel is unaffected.
            pass

    payload = _compose(state, session, flag_until=moment)
    payload["replay"] = {
        "session_key": key,
        "at": _iso(moment),
        "start": _iso(start),
        "end": _iso(end),
    }
    payload["generated"] = _iso(moment)
    return payload
