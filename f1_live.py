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
import json
import os
import re
import socket
import threading
import time
from collections import OrderedDict, deque
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests
from flask import Blueprint, Response, jsonify, request, stream_with_context

import f1_stream
import f1_strategy

bp = Blueprint("f1_live", __name__)

OPENF1 = "https://api.openf1.org/v1"
OPENF1_TOKEN_URL = "https://api.openf1.org/token"
OPENF1_USER = os.environ.get("OPENF1_USER", "")
OPENF1_PASS = os.environ.get("OPENF1_PASS", "")

# How long a composed payload is served before the streams underneath it are refreshed.
# This is what stops ten viewers costing ten times the upstream.
#
# Cheap to lower: composing again does not call upstream, it only re-reads accumulators that
# a stale stream may or may not have refreshed. What it buys is latency — at 2s a payload
# could be two seconds old before the client even asked for it, on top of each stream's own
# interval. The upstream cost is set by the TTL table below, not by this.
COMPOSE_TTL = 1.0

# Per-stream refresh intervals, in seconds, and the whole rate-limit budget in one place.
#
# A continuously-watched race costs the sum of 60/TTL over this table, whatever the number
# of viewers, because the compose is cached. As set below that is:
#
#   intervals 15 + position 12 + race_control 10 + laps 6 + team_radio 3 + pit 2
#   + stints 1.3 + session_result 1 + sessions 1 + weather 1 + drivers 0.2  ~=  52/minute
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
    # Air and track temperature move over tens of minutes, not seconds. One a minute is
    # already finer than the number ever changes, and it costs 1 of the 12 spare calls.
    "weather": 60.0,
    # Radio clips arrive a handful a minute at the busiest and are listened to, not read off
    # a timing screen, so a few seconds of latency is invisible. 20s costs 3 a minute.
    "team_radio": 20.0,
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
    "weather": "date",
    "team_radio": "date",
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
    "weather": 300,
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
    # Wide enough that a session joined mid-way still has a reading, since the stream only
    # emits once a minute and a 60s window can fall between two of them.
    "weather": 300,
}

# Streams that may be skipped when the minute's call budget is nearly spent. Order matters:
# the running order and the flags are what the page is for, so position, intervals and
# race_control are never dropped.
OPTIONAL = ("session_result", "weather", "team_radio", "stints", "pit", "laps", "location")

# Faster refreshes for the sessions that can afford them.
#
# `intervals` is fetched only for a race, and at 4s it is the single most expensive stream
# in the table — 15 of the 52.5 calls a minute above. So a practice or qualifying session
# runs at 37.5/min and leaves a third of the allowance unspent, while the things you
# actually watch in a practice session (where cars are on track, and what they just lapped)
# refresh no faster than they do in a race.
#
# These are the overrides for those sessions. They bring the total to ~51/min, still inside
# the 55 the throttle allows and leaving room for the OPTIONAL skid to do its job:
#
#   position 15 + location 15 + race_control 7.5 + laps 7.5 + pit 2 + stints 1.3
#   + session_result 0.5 + sessions 1 + weather 1 + drivers 0.2  ~=  51 calls a minute
#
# A race keeps the values above, where there is no headroom to spend.
TTL_NO_INTERVALS = {
    "position": 4.0,
    "location": 4.0,
    # 15s meant a completed lap could take a quarter of a minute to appear on screen, which
    # is the most obviously laggy thing on a timing page.
    "laps": 8.0,
}

# Outbound rate limiting. OpenF1 publishes 6 req/s and 60 req/min for an authenticated
# account and 3 req/s and 30 req/min without one, and answers a breach with a 429. Replay
# runs unauthenticated on the free tier, so the ceiling depends on which we are using.
LIMITS = {
    True: (5, 55),    # authenticated
    False: (2, 25),   # free tier, as used by replay
}


def _replay_authed():
    """
    Whether the replay path should authenticate.

    Replay is deliberately a free-tier citizen: the lab costs nothing to run and works on a
    checkout with no credentials at all, which is worth keeping. But OpenF1 locks its
    *entire* API — past seasons included — to authenticated users for as long as any session
    is on track, answering everything else with a 401 and "Live F1 session in progress". So
    on exactly the weekends the lab is most useful, the free tier is not available, and a
    replay of a race from last March fails because a practice session is running now.

    Where credentials are configured, use them rather than be locked out of our own history.
    Where they are not, nothing changes.
    """
    return bool(OPENF1_USER and OPENF1_PASS)

_calls = deque()          # timestamps of recent upstream calls, for the throttle
_calls_lock = threading.Lock()

_token = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()

# One lock around the whole refresh-and-compose. Held while upstream calls are in flight, so
# a burst of visitor polls collapses into a single refresh rather than a stampede.
_refresh_lock = threading.Lock()
_composed = {"payload": None, "ts": 0.0}

# Around every change to, and every read of, the live _Session's accumulators. REST folds
# them inside _refresh and the stream folds them from its queue on other threads; _compose
# reads them. Held only for the fold or the read itself, never across a network call, so
# the stream's 250 ms ticks never wait on an upstream request.
_state_lock = threading.RLock()


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

    headers = {"User-Agent": "jeremy.ie-f1/1.0 (+https://jeremy.ie/#contact)"}
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
    since = {}
    triggered = {}
    sectors = {}
    ending = False
    for when, state, row, sectors, ending in _flag_steps(messages, until):
        # Only the moment a state was entered, so "since" does not reset on every repeat.
        if since.get("state") != state:
            since["state"] = state
            since["at"] = when
            triggered["message"] = row.get("message") or ""

    return (
        since.get("state", "GREEN"),
        since.get("at"),
        triggered.get("message", ""),
        sorted(s for s in sectors if s is not None),
        ending,
    )


def _flag_steps(messages, until=None):
    """
    The state machine behind _fold_flag, one step per race-control record.

    Yields (when, state, row, sectors, ending) after each record up to `until`. A generator
    so that _fold_flag (the state now) and _flag_periods (every state the race has been in)
    run the same machine in one pass each, rather than the second re-folding from the top
    at every record.
    """
    sectors = {}
    safety = None            # "SAFETY_CAR" | "VSC" | None
    ending = False           # safety car called in, but not yet green
    track = "GREEN"          # the track-wide flag: GREEN, RED or CHEQUERED
    suspended = False        # the session itself is stopped, not merely neutralised
    finished = False
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
        yield when, state, row, sectors, ending and safety is not None


def _flag_periods(messages, until=None):
    """
    Every flag state the session has been through, as [(start, end, state)] in order.

    `end` is None for the period still running. Records that share a timestamp settle
    into one period rather than leaving zero-length ones between them.
    """
    periods = []
    for when, state, _row, _sectors, _ending in _flag_steps(messages, until):
        if when is None:
            continue
        if periods and periods[-1][0] == when:
            periods.pop()
        if periods and periods[-1][2] == state:
            continue
        periods.append((when, None, state))
    return [(start, periods[i + 1][0] if i + 1 < len(periods) else None, state)
            for i, (start, _end, state) in enumerate(periods)]


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

# The penalty itself, reduced to something that fits beside a driver code.
#
# Race control writes the sentence, not a field, so this reads the wording. Order matters
# for the same reason it does above: "10 SECOND STOP AND GO PENALTY" has to be caught by the
# stop-and-go pattern before anything looks for a plain time penalty.
#
# A miss is not a failure — the caller falls back to the existing "P" badge, which is what
# every page did before this existed. So an unrecognised wording costs the detail, not the
# fact that there is a penalty at all.
PENALTY_FORMS = (
    (re.compile(r"(\d+)\s*SECOND\s+STOP\s*(?:AND|&)?\s*GO"), lambda m: "S&G " + m.group(1) + "s"),
    (re.compile(r"STOP\s*(?:AND|&)\s*GO"),                   lambda m: "S&G"),
    (re.compile(r"DRIVE[\s-]*THROUGH"),                      lambda m: "DT"),
    (re.compile(r"(\d+)\s*SECONDS?\s+TIME\s+PENALTY"),       lambda m: "+" + m.group(1) + "s"),
    (re.compile(r"(\d+)\s*GRID\s+(?:PLACE|POSITION)"),       lambda m: m.group(1) + " GRID"),
)


def penalty_label(upper):
    """A short form of the penalty in this message, or None if the wording is unfamiliar."""
    for pattern, render in PENALTY_FORMS:
        match = pattern.search(upper)
        if match:
            return render(match)
    return None


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
        # Only meaningful on a penalty row; None everywhere else.
        "penalty": penalty_label(upper) if kind == "penalty" else None,
    }


def build_events(messages, until=None):
    """
    The event feed, newest first, plus the per-driver standing state folded out of it:
    the badges, and the wording of the most recent penalty.
    """
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
    penalties = {}
    served = set()
    for event in events:
        for num in event["drivers"]:
            held = badges.setdefault(num, set())
            if event["type"] == "cleared":
                held.discard("investigation")
            elif event["type"] in ("investigation", "penalty", "deletion"):
                held.add(event["type"])
            # The chip shows what a driver still owes, so race control announcing the
            # penalty has been served takes it back off. Note this deliberately does not
            # touch the `penalty` badge above: that is what /f1 renders today, and its
            # behaviour is left exactly as it was.
            #
            # The latest penalty otherwise wins rather than accumulating: a driver carrying
            # two at once is rare, and a timing screen shows the one still outstanding.
            if event["type"] == "penalty":
                if "PENALTY SERVED" in event["text"].upper():
                    penalties.pop(num, None)
                    served.add(num)
                elif event.get("penalty"):
                    penalties[num] = event["penalty"]
                    served.discard(num)

    events.reverse()
    return (events,
            {num: sorted(held) for num, held in badges.items() if held},
            penalties,
            served)


def build_radio(rows, until=None):
    """
    The team radio feed, newest first.

    Shaped like build_events and rewound the same way: sort by date, stop at `until`. That
    bound is the whole reason replay does not leak clips from the future into the past.

    There is no lap number here, deliberately. The rows do not carry one, and the only lap
    to hand is `state.laps` — the latest lap per driver, not the lap as it stood when the
    clip was recorded. Stamping a clip from lap 10 with lap 58 because that is where the
    car is now is worse than saying nothing, and the live path has no lap history to do
    better with. The client captions clips with the clock instead.
    """
    clips = []
    for row in sorted(rows, key=lambda r: str(r.get("date") or "")):
        when = _parse_dt(row.get("date"))
        if until is not None and when is not None and when > until:
            break
        url = row.get("recording_url")
        num = row.get("driver_number")
        # Both are load-bearing on the page: the url is what plays, the number is what the
        # client looks the driver's code and team colour up by.
        if not url or num is None:
            continue
        clips.append({"t": _iso(when), "num": num, "url": url})

    clips.reverse()
    return clips


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
        self.laps = {}           # num -> latest lap record, finished or not
        # num -> the latest lap record that actually has a time on it.
        #
        # Kept apart from `laps` because the two answer different questions. `laps` is "what
        # lap is this car on", which has to follow the in-progress lap for the lap counter
        # and the pit-out flag. The timing screen's LAST LAP column is "what did they last
        # do", and the in-progress lap has no duration yet — so reading it from `laps` blanked
        # the whole column the instant a car crossed the line to start a new lap.
        self.timed = {}
        self.best = {}           # num -> best lap_duration seen
        # Sector bests, for the purple/green colouring. `best_sectors` is the session's,
        # a list of three; `driver_best` is the same per car. Both accumulate in _merge_laps
        # alongside `best`, off rows already fetched — no extra upstream call.
        self.best_sectors = [None, None, None]
        self.driver_best_sectors = {}   # num -> [s1, s2, s3]
        self.stints = {}         # num -> list of stint records
        self.pit = {}            # num -> {"stops", "last"}
        # The history the strategy view needs and nothing above keeps: every completed lap
        # per car, and every stop rather than only the last. Both fill from rows already
        # fetched for `laps` and `pit`, so they cost no upstream calls. See f1_strategy.
        self.lap_history = {}    # num -> {lap_number: lap row}
        self.stops = {}          # num -> {date: pit row}
        self.race_control = []
        # Radio clips, held flat like race_control rather than per driver: it is an
        # append-only log, and the page groups it by driver itself.
        self.team_radio = []
        self.result = {}         # num -> session_result record
        self.location = {}       # num -> latest {"x", "y", "date"}
        # Session-wide, not per-driver, so it is a flat list like race_control rather than
        # a dict keyed on driver_number.
        self.weather = []
        # num -> latest telemetry sample (speed, throttle, brake, gear, rpm). Only the
        # stream carries it: polling it at 3.7 Hz a car is far outside the REST budget.
        self.car_data = {}
        # Refresh intervals for this session; _refresh retunes once the type is known.
        self.ttl = dict(TTL)

    def tune(self, is_race):
        """Pick the refresh table for this session — see TTL_NO_INTERVALS."""
        self.ttl = dict(TTL)
        if not is_race:
            self.ttl.update(TTL_NO_INTERVALS)

    def stale(self, stream):
        last = self.fetched.get(stream)
        return last is None or (time.monotonic() - last) >= self.ttl[stream]

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

# While the stream is delivering a stream, REST still reads these now and then: the broker
# sends at most once, so a message lost in a reconnect is otherwise lost for good. Race
# control drives the flag and the voice alerts, and `position` only reports changes, so a
# missed one would leave a car in the wrong place until it next moved.
SAFETY_TTL = {"race_control": 60.0, "position": 60.0}


def _refresh(state, session, until=None, authed=True, covered=frozenset()):
    """
    Bring every stale stream up to date. Individual failures leave the last good data.

    `covered` is what the stream is delivering right now (see _covered): those are left to
    it, apart from SAFETY_TTL's occasional check. Everything else polls on its TTL, as it
    did before there was a stream, so the moment the stream falters the table carries on.
    """
    key = session["session_key"]
    is_race = (session.get("session_type") == "Race")
    state.tune(is_race)
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
            # A race reads its laps whole the first time. The strategy view calibrates pit
            # loss from every stop so far, and a server that cold-starts at lap 40 would
            # otherwise know nothing before lap 38. It is about 1,200 rows for a full
            # race — nothing like the intervals stream FIRST_WINDOW exists to bound.
            if stream == "laps" and is_race:
                lookback = None
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
        ("position", lambda rows: _merge_latest(state.position, rows)),
        # Replaced wholesale rather than merged: the whole stream is about a hundred rows a
        # race, and the fold that reads it is stateless, so there is nothing to accumulate.
        ("race_control", lambda rows: _replace(state.race_control, rows)),
    ]
    if is_race:
        plan.append(("intervals", lambda rows: _merge_latest(state.intervals, rows)))
    plan.extend([
        ("location", lambda rows: _merge_latest(state.location, rows)),
        ("laps", lambda rows: _merge_laps(state, rows)),
        ("pit", lambda rows: _merge_pit(state, rows)),
        ("stints", lambda rows: _merge_stints(state, rows)),
        ("drivers", lambda rows: _by_driver(state.drivers, rows)),
        ("session_result", lambda rows: _by_driver(state.result, rows)),
        # Replaced rather than merged, like race_control: only the latest reading is ever
        # read out of it, so there is nothing to accumulate.
        ("weather", lambda rows: _replace(state.weather, rows)),
        # Replaced rather than merged, for race_control's reason: no WINDOW entry means it
        # is always read whole, so there is nothing to accumulate.
        ("team_radio", lambda rows: _replace(state.team_radio, rows)),
    ])

    for stream, fold in plan:
        if stream in covered:
            safety = SAFETY_TTL.get(stream)
            last = state.fetched.get(stream)
            if safety is None or (last is not None and time.monotonic() - last < safety):
                continue
        elif not state.stale(stream):
            continue
        # Under budget pressure, keep the running order and the flags and drop the rest.
        if stream in OPTIONAL and budget < 8 and not state.first_time(stream):
            continue
        try:
            # The request outside the lock, the fold inside it: the stream's ticks must
            # never wait on an upstream call.
            rows = _get(stream, filters(stream), authed)
            with _state_lock:
                fold(rows)
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


SECTOR_FIELDS = ("duration_sector_1", "duration_sector_2", "duration_sector_3")


def _sectors(row):
    """The three sector splits of one lap row, as a list with None for anything missing."""
    return [row.get(field) or None for field in SECTOR_FIELDS]


def _merge_laps(state, rows):
    _merge_latest(state.laps, rows, key="lap_number")
    # The same merge, over only the laps that were actually completed.
    _merge_latest(state.timed, [r for r in rows if r.get("lap_duration")], key="lap_number")
    for row in rows:
        num = row.get("driver_number")
        if num is None:
            continue

        duration = row.get("lap_duration")
        if duration:
            if state.best.get(num) is None or duration < state.best[num]:
                state.best[num] = duration
            if row.get("lap_number") is not None:
                state.lap_history.setdefault(num, {})[row["lap_number"]] = row

        # Sector bests ride along on rows already in hand. A sector is timed even on a lap
        # that never completes — an in-lap has a good S1 and S2 — so these are folded per
        # sector rather than only from laps with a duration.
        mine = state.driver_best_sectors.setdefault(num, [None, None, None])
        for i, value in enumerate(_sectors(row)):
            if value is None:
                continue
            if mine[i] is None or value < mine[i]:
                mine[i] = value
            if state.best_sectors[i] is None or value < state.best_sectors[i]:
                state.best_sectors[i] = value


def _merge_pit(state, rows):
    for row in rows:
        num = row.get("driver_number")
        if num is None:
            continue
        entry = state.pit.setdefault(num, {"laps": set(), "last": None})
        entry["laps"].add(row.get("lap_number"))
        if entry["last"] is None or str(row.get("date") or "") >= str(entry["last"].get("date") or ""):
            entry["last"] = row
        state.stops.setdefault(num, {})[str(row.get("date") or "")] = row


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
# Stream ingest
# ---------------------------------------------------------------------------

# What makes two rows of a session-wide stream the same row. Not the broker's `_key`: rows
# read over REST don't carry one, and the same message arriving both ways must count once.
_SAME_ROW = {
    "race_control": ("date", "message"),
    "team_radio": ("date", "driver_number"),
    "weather": ("date",),
}


def _append_unique(target, row, fields):
    """Add one row to a date-ordered log, replacing it if it is already there."""
    identity = tuple(row.get(f) for f in fields)
    for i, existing in enumerate(target):
        if tuple(existing.get(f) for f in fields) == identity:
            target[i] = row
            return
    stamp = str(row.get("date") or "")
    if not target or stamp >= str(target[-1].get("date") or ""):
        target.append(row)
    else:
        at = bisect.bisect_right([str(r.get("date") or "") for r in target], stamp)
        target.insert(at, row)


def _upsert_stint(state, row):
    """One stint row from the stream: the stint is updated as it runs, so replace by number."""
    num = row.get("driver_number")
    if num is None:
        return
    stints = [s for s in state.stints.get(num, []) if s.get("stint_number") != row.get("stint_number")]
    stints.append(row)
    state.stints[num] = sorted(stints, key=lambda r: r.get("stint_number") or 0)


def _ingest(state, stream, row):
    """Fold one row from the stream with the same merges REST uses. Under _state_lock."""
    # `_id` and `_key` are the broker's bookkeeping, not part of the data.
    row = {k: v for k, v in row.items() if not k.startswith("_")}
    if stream in ("position", "intervals", "location", "car_data"):
        _merge_latest(getattr(state, stream), [row])
    elif stream == "laps":
        _merge_laps(state, [row])
    elif stream == "pit":
        _merge_pit(state, [row])
    elif stream == "stints":
        _upsert_stint(state, row)
    elif stream == "drivers":
        _by_driver(state.drivers, [row])
    elif stream == "session_result":
        _by_driver(state.result, [row])
    elif stream in _SAME_ROW:
        _append_unique(getattr(state, stream), row, _SAME_ROW[stream])


def _pump():
    """Fold whatever the stream has delivered since the last call into the live session."""
    source = f1_stream.current()
    state = _session
    if source is None or state is None:
        return
    rows = source.drain()
    if not rows:
        return
    with _state_lock:
        for stream, row in rows:
            if row.get("session_key") not in (None, state.key):
                continue
            try:
                _ingest(state, stream, row)
            except Exception:
                pass


def _covered():
    """The streams the stream is delivering for this session, which REST can leave alone."""
    source = f1_stream.current()
    if source is None or _session is None or source.session_key != _session.key:
        return frozenset()
    return frozenset(source.covered())


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


def _weather_now(rows):
    """
    The most recent weather reading, or None if the stream gave us nothing.

    Kept as a flat list rather than a per-driver dict because the weather is the same for
    everybody — which also means it cannot go through the replay's `_index`, since that
    groups on a `driver_number` these rows do not have.
    """
    latest = None
    for row in rows or ():
        if latest is None or str(row.get("date") or "") >= str(latest.get("date") or ""):
            latest = row
    if latest is None:
        return None
    return {
        "air": latest.get("air_temperature"),
        "track": latest.get("track_temperature"),
        "humidity": latest.get("humidity"),
        "wind": latest.get("wind_speed"),
        "windDir": latest.get("wind_direction"),
        "pressure": latest.get("pressure"),
        "rain": bool(latest.get("rainfall")),
    }


def _compose(state, session, flag_until=None):
    start = _parse_dt(session.get("date_start"))
    flag_state, flag_since, flag_message, flag_sectors, flag_ending = _fold_flag(
        state.race_control, flag_until)
    events, badges, penalties, served = build_events(state.race_control, flag_until)

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
        # What they last completed, which is not the lap they are on — see _Session.timed.
        timed = state.timed.get(num) or {}
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
            # All three read the last *completed* lap: a lap in progress has no time, no
            # finished sectors and no trap speed yet, and showing its blanks would empty the
            # column every time a car started a new lap.
            "lastLap": timed.get("lap_duration"),
            "bestLap": state.best.get(num),
            # The three splits of that last lap, and the best each car and the session have
            # managed, so a client can colour them green and purple without keeping history.
            "sectors": _sectors(timed) if timed else [None, None, None],
            "bestSectors": state.driver_best_sectors.get(num) or [None, None, None],
            # Speed through the trap on the last lap, km/h.
            "speed": timed.get("st_speed"),
            # The lap they are on now, which is the in-progress one.
            "lap": lap.get("lap_number"),
            # When the lap in progress began. The Wall tab anchors its ring on the leader's,
            # so the field turns at the pace of the lap rather than jumping a poll at a time.
            "lapStart": lap.get("date_start"),
            "compound": compound,
            "tyreAge": tyre_age,
            "inPit": in_pit,
            "pitStops": len([n for n in pit_laps if n is not None]),
            "dnf": (bool(result.get("dnf") or result.get("dns") or result.get("dsq"))
                    if over else num in retired),
            # Standing race-control state for this car: investigation, penalty, deletion.
            # Deliberately still a list of bare strings — /f1's live panel reads it directly
            # and ships on race Sundays, so the detail goes in `penalty` beside it instead.
            "badges": badges.get(num, []),
            # The penalty in short form ("+5s", "DT"), when race control's wording parsed.
            "penalty": penalties.get(num),
            # Whether race control has since said it was served. The badge above cannot
            # say this — it is unchanged /f1 behaviour — so a view that wants to stop
            # showing a penalty the driver has already taken needs to be told separately.
            "penaltyServed": num in served,
            # The whole stint history, not just the tyre currently on the car.
            "stints": [
                {"compound": s.get("compound"), "lapStart": s.get("lap_start"),
                 "lapEnd": s.get("lap_end"), "age": s.get("tyre_age_at_start")}
                for s in stints
            ],
            # F1-frame decimetres. The browser maps these onto the circuit path with the
            # affine in the circuit's locationTransform.
            #
            # A literal (0, 0) is not a position, it is the absence of one: before a session
            # the stream publishes zeros for every car, and Madring FP2 sat like that for
            # the half hour before the pit lane opened. Passing them through put the whole
            # field on one point — wherever the transform happens to send the origin —
            # which reads as a bug rather than as "nobody is on track yet".
            "xy": ([where.get("x"), where.get("y")]
                   if where.get("x") is not None
                   and (where.get("x") or where.get("y")) else None),
        })

    # Cars without a position yet sort to the back, in driver-number order.
    rows.sort(key=lambda r: (r["pos"] is None, r["pos"] or 0, r["num"]))

    current_lap = max(
        [r["lap"] for r in rows if r["lap"] is not None] or [None],
        key=lambda v: -1 if v is None else v,
    )

    # The fastest lap of the session and who holds it. Ties go to the driver who set it
    # first, which sorting by number cannot know — but a genuine tie to the millisecond is
    # rare enough that the stable choice is worth more than the pedantry.
    timed = [(t, n) for n, t in state.best.items() if t]
    fastest, fastest_num = min(timed) if timed else (None, None)

    # Pit loss and the ring's lap, for the Wall tab. Only a race has gaps to put a car
    # on the ring by, or a pit window worth projecting. Never allowed to cost the frame.
    strategy = None
    if session.get("session_type") == "Race":
        try:
            strategy = f1_strategy.compute(
                state,
                _flag_periods(state.race_control, flag_until),
                flag_state,
                session.get("circuit_key"),
                [r["num"] for r in rows if not r["dnf"]],
                flag_until or _now(),
                _parse_dt,
            )
        except Exception:
            strategy = None

    payload = {
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
            **_meeting_fields(session),
        },
        "flag": {
            "state": flag_state,
            "since": _iso(flag_since),
            "message": flag_message,
            "sectors": flag_sectors,
            "ending": flag_ending,
        },
        "lap": {"current": current_lap},
        # The session's own bests, so a client can mark a purple lap without holding the
        # history itself. `num` is whoever set the fastest lap; None before anyone has.
        "best": {
            "lap": fastest,
            "num": fastest_num,
            "sectors": list(state.best_sectors),
        },
        "weather": _weather_now(state.weather),
        "drivers": rows,
        "events": events[:40],
        # Capped like the feed above: a race is a few hundred clips and the dock shows the
        # last handful. Bounded by the same `flag_until` that rewinds everything else.
        "radio": build_radio(state.team_radio, flag_until)[:40],
    }
    if strategy is not None:
        payload["strategy"] = strategy
    return payload


# ---------------------------------------------------------------------------
# Meetings
# ---------------------------------------------------------------------------

# What each weekend is called. A session carries only its circuit's short name, so the 2026
# Bahrain Grand Prix, held at Sepang, arrives as "Kuala Lumpur" and the two pre-season tests
# at Sakhir are told apart by nothing at all. OpenF1 rebuilds its meetings index once a day,
# so one call per season every few hours covers every payload that names a session.
MEETINGS_TTL = 6 * 3600.0
# After a failed fetch, how long to go without names before asking again. Long enough that
# a 429 during a race is not retried on every compose.
MEETINGS_RETRY = 600.0
_meetings_cache = {}      # year -> (fetched at, {meeting_key: row})
_meetings_lock = threading.Lock()


def _meetings(year):
    """The season's meetings by meeting_key; empty, not an error, when they can't be had."""
    now = time.time()
    with _meetings_lock:
        cached = _meetings_cache.get(year)
        if cached is not None and now < cached[0]:
            return cached[1]
        try:
            rows = _get("meetings", [("year", int(year))], authed=_replay_authed())
            by_key = {r.get("meeting_key"): r for r in rows if r.get("meeting_key") is not None}
            _meetings_cache[year] = (now + MEETINGS_TTL, by_key)
        except Exception:
            by_key = cached[1] if cached is not None else {}
            _meetings_cache[year] = (now + MEETINGS_RETRY, by_key)
        return by_key


def _meeting_fields(session):
    """`meeting` and `meetingKey` for a session's payload; nothing when the name is unknown."""
    key = session.get("meeting_key")
    if key is None:
        return {}
    year = session.get("year")
    if year is None:
        start = _parse_dt(session.get("date_start"))
        year = start.year if start is not None else None
    if year is None:
        return {"meetingKey": key}
    row = _meetings(year).get(key) or {}
    return {"meeting": row.get("meeting_name"), "meetingKey": key}


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
            **_meeting_fields(session),
        }
    return payload


@bp.route("/f1/replay/sessions")
def f1_replay_sessions():
    """Sessions the lab can load, newest first. Free tier, so 2023 onwards."""
    year = request.args.get("year") or _now().year
    try:
        rows = _get("sessions", [("year", int(year))], authed=_replay_authed())
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
        **_meeting_fields(s),
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
    end = replay.end

    # The real state machine, stepped once through the whole race, so the marks cannot
    # disagree with the panel.
    periods = [
        {"state": state, "from": _iso(begin), "to": _iso(until or end) if (until or end) else None}
        for begin, until, state in _flag_periods(replay.race_control)
    ]

    events, _, _, _ = build_events(replay.race_control)
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
            **_meeting_fields(session),
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

    payload, status = _live_payload()
    return jsonify(payload), status


def _live_payload():
    """
    The live frame and its HTTP status, composed at most once a COMPOSE_TTL however many
    pollers and streams ask for it.
    """
    now = time.time()
    cached = _composed["payload"]
    if cached is not None and (now - _composed["ts"]) < COMPOSE_TTL:
        return cached, 200

    with _refresh_lock:
        # Another thread may have refreshed while this one waited for the lock.
        now = time.time()
        if _composed["payload"] is not None and (now - _composed["ts"]) < COMPOSE_TTL:
            return _composed["payload"], 200

        try:
            payload = _build()
        except Exception as error:
            if _composed["payload"] is not None:
                stale = dict(_composed["payload"])
                stale["stale"] = True
                return stale, 200
            return {"live": False, "error": str(error)}, 502

        _composed["payload"] = payload
        _composed["ts"] = time.time()
        return payload, 200


# ---------------------------------------------------------------------------
# Push: /f1/stream
# ---------------------------------------------------------------------------

# Server-Sent Events for the app: the same frame /f1/live serves, sent when it changes, and
# between frames every car's position and telemetry as fast as the stream brings them. The
# frame keeps a two-second floor so the tower isn't re-sent four times a second, except when
# the flag or race control changes: those go at once, because the app speaks them.
STREAM_MAX = 3              # held-open streams; each holds one of gunicorn's eight threads
STREAM_TICK = 0.2           # how often positions and telemetry go out: above their 3.7 Hz
STREAM_FRAME_EVERY = 2.0
STREAM_PING = 15.0
STREAM_LIFETIME = 55 * 60   # inside Cloud Run's request limit; the app reconnects on `bye`
_streams = {"open": 0}
# Reentrant because a stream the dev server abandons is closed by the garbage collector, which
# can run on a thread that is already holding it.
_streams_lock = threading.RLock()


class _Slot:
    """One stream's place under STREAM_MAX, given back once however the stream ends."""

    def __init__(self):
        self.held = True

    def release(self):
        with _streams_lock:
            if self.held:
                self.held = False
                _streams["open"] -= 1


def _client_gone(sock):
    """
    Whether the client has hung up, without waiting for a write to fail.

    A write fails only once the client's reset has come back, and in a stoppage the next
    write can be a ping 15 s away; all that time the stream holds a slot nobody is using.
    Clients send nothing after the request, so an end-of-file or a reset on the socket means
    the client has gone.
    """
    if sock is None:
        return False
    try:
        return sock.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
    except BlockingIOError:
        return False    # nothing to read: still connected
    except ValueError:
        return False    # a socket that can't peek, such as TLS: a failed write still tells
    except OSError:
        return True     # reset, or already closed


def _live_payload_nowait():
    """
    The cached frame at once, rebuilding it in the background when it has aged.

    A stream must not wait on its own rebuild: a rebuild can include a REST call, and a
    second spent on that is a second of cars standing still on the map.
    """
    if _composed["payload"] is None:
        return _live_payload()
    if time.time() - _composed["ts"] >= COMPOSE_TTL and not _refresh_lock.locked():
        threading.Thread(target=_live_payload, name="f1-compose", daemon=True).start()
    return _composed["payload"], 200


def _sse(event, data):
    return "event: %s\ndata: %s\n\n" % (event, json.dumps(data, separators=(",", ":"), default=str))


def _frame_signature(frame):
    """
    (what the frame says, what in it is urgent). The first decides whether to send it at all,
    the second whether to send it now. Positions are left out of both: `cars` carries them.
    """
    drivers = [{k: v for k, v in d.items() if k != "xy"} for d in frame.get("drivers") or ()]
    body = dict(frame, drivers=drivers)
    body.pop("generated", None)
    body.pop("stale", None)
    flag = frame.get("flag") or {}
    newest = (frame.get("events") or [None])[0]
    urgent = (flag.get("state"), flag.get("message"), flag.get("ending"),
              json.dumps(newest, sort_keys=True, default=str))
    return hash(json.dumps(body, sort_keys=True, default=str)), urgent


def _cars_since(sent):
    """
    Every position and telemetry sample newer than this stream last sent, or None.

    `sent` is the stream's own record of what it has sent, by car, so each stream gets every
    car once per new sample however its ticks fall. Positions of exactly (0, 0) are skipped,
    as in _compose: that is the feed saying it has none.
    """
    c, tel, newest = [], [], ""
    with _state_lock:
        state = _session
        if state is None:
            return None
        for num, row in state.location.items():
            date = row.get("date")
            if not date or sent.get(("c", num)) == date:
                continue
            sent[("c", num)] = date
            x, y = row.get("x"), row.get("y")
            if x is not None and (x or y):
                c.append([num, x, y])
                newest = max(newest, str(date))
        for num, row in state.car_data.items():
            date = row.get("date")
            if not date or sent.get(("t", num)) == date:
                continue
            sent[("t", num)] = date
            tel.append([num, row.get("speed"), row.get("throttle"), row.get("brake"),
                        row.get("n_gear"), row.get("rpm")])
            newest = max(newest, str(date))
    if not c and not tel:
        return None
    return {"t": newest or None, "c": c, "tel": tel}


def _stream_events(slot, sock):
    # The slot is given back here, not only when the server closes the response. Flask's dev
    # server skips that close when the client resets the connection: its cleanup reads the
    # dead socket, the read raises, and the close after it never runs. The generator is then
    # dropped, and dropping it still runs this finally.
    try:
        yield "retry: 3000\n\n"
        payload, _ = _live_payload()
        if not payload.get("live"):
            # Nothing on track: say so and close. The app polls slowly until a session starts.
            yield _sse("idle", payload)
            return

        key = (payload.get("session") or {}).get("key")
        sent = {}
        last_payload, signature, urgent = None, None, None
        last_signature, last_urgent, last_frame, last_ping = None, None, 0.0, 0.0
        deadline = time.time() + STREAM_LIFETIME
        while time.time() < deadline:
            # Checked before ensure(), so a client that has gone stops keeping the feed alive.
            if _client_gone(sock):
                return
            # Every tick says the stream is still wanted, and reconnects one that was let go.
            f1_stream.ensure(key)
            _pump()
            payload, _ = _live_payload_nowait()
            if not payload.get("live"):
                yield _sse("idle", payload)
                return
            session_key = (payload.get("session") or {}).get("key")
            if session_key != key:
                key = session_key
                sent.clear()

            if payload is not last_payload:
                signature, urgent = _frame_signature(payload)
                last_payload = payload
            now = time.time()
            if signature != last_signature and (urgent != last_urgent or now - last_frame >= STREAM_FRAME_EVERY):
                yield _sse("frame", payload)
                last_signature, last_urgent, last_frame = signature, urgent, now

            cars = _cars_since(sent)
            if cars:
                yield _sse("cars", cars)
            if now - last_ping >= STREAM_PING:
                # An event, not an SSE comment, so the app can count it as a sign of life: in a
                # stoppage nothing else may change for minutes.
                yield _sse("ping", {})
                last_ping = now
            time.sleep(STREAM_TICK)
        yield _sse("bye", {})
    finally:
        slot.release()


@bp.route("/f1/stream")
def f1_stream_route():
    with _streams_lock:
        if _streams["open"] >= STREAM_MAX:
            return jsonify({"error": "too many open streams; poll /f1/live instead"}), 503
        _streams["open"] += 1

    slot = _Slot()
    sock = request.environ.get("gunicorn.socket") or request.environ.get("werkzeug.socket")
    response = Response(stream_with_context(_stream_events(slot, sock)), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    # For a body that is never read, such as a HEAD's: the generator never starts, so its
    # finally can't run. Releasing twice is harmless.
    response.call_on_close(slot.release)
    return response


@bp.route("/f1/stream/status")
def f1_stream_status():
    """The stream's health, rates and delay per topic. `?drop=1|0` silences the simulator."""
    drop = request.args.get("drop")
    if drop is not None:
        f1_stream.set_drop(drop == "1")
    source = f1_stream.current()
    out = source.status() if source is not None else {"source": None, "connected": False, "healthy": False}
    out["streamsOpen"] = _streams["open"]
    out["covered"] = sorted(_covered())
    out["frameAge"] = round(time.time() - _composed["ts"], 1) if _composed["payload"] is not None else None
    if f1_stream.SIMULATE:
        out["simulatedNow"] = _iso(f1_stream.sim_now())
    return jsonify(out)


_session_cache = {"session": None, "ts": 0.0}
_simulated = {}


def _current_session():
    """
    The session to show, chosen by the clock rather than by `session_key=latest`.

    `latest` means the most recently *started* session. Two hours before lights out at Monza
    it still names the previous day's qualifying, even though the race session already
    exists in the index — so a page keyed on it would not wake up until the race was
    already under way. Asking for the day's sessions and picking the one whose window
    contains now makes the panel appear at the lead-in, every time.

    Cached for a minute: this is called on every compose, and the calendar does not move.

    Under F1_STREAM_SIMULATE it is the simulated session, whatever the date.
    """
    if f1_stream.SIMULATE:
        key = f1_stream.SIMULATE[0]
        if key not in _simulated:
            rows = _get("sessions", [("session_key", key)], authed=_replay_authed())
            _simulated[key] = rows[0] if rows else None
        return _simulated[key]

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
        with _state_lock:
            _session = _Session(session["session_key"])

    # Under the simulator the "live" session is a past one, read up to its clock from
    # history. On the real feed both are what they always were: now, authenticated.
    until = f1_stream.sim_now() if f1_stream.SIMULATE else None
    authed = _replay_authed() if f1_stream.SIMULATE else True
    _pump()
    _refresh(_session, session, until=until, authed=authed, covered=_covered())
    with _state_lock:
        return _compose(_session, session, flag_until=until)


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------

# Streams loaded whole for a replay. `location` is excluded on purpose: at 3.6 Hz for
# twenty-odd cars a race is roughly half a million rows, so the lab fetches it per scrub in a
# short window instead — see _replay_location.
REPLAY_STREAMS = ("race_control", "position", "intervals", "laps", "pit",
                  "stints", "drivers", "session_result", "weather", "team_radio")

# Streams that belong to the session rather than to any car. They cannot go through
# `_index`, which groups on a `driver_number` these rows do not carry and would quietly
# return an empty set for; they are held as flat lists sorted by date and bisected whole.
#
# `team_radio` rows do carry a driver_number, but they are held flat anyway to match the
# live `_Session.team_radio` that `_compose` reads — one shape, one fold, both paths.
SESSION_STREAMS = ("race_control", "weather", "team_radio")

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
        self.session_streams = {}   # stream -> [rows sorted by date]
        self.start = _parse_dt(session.get("date_start"))
        self.end = None          # set below, once the laps are in hand
        # Car positions, in time blocks, loaded as the playhead reaches them.
        self.location_blocks = OrderedDict()

        for name in REPLAY_STREAMS:
            rows = _get(name, [("session_key", key)], authed=_replay_authed())
            if name in SESSION_STREAMS:
                self.session_streams[name] = sorted(
                    rows, key=lambda r: str(r.get("date") or ""))
                continue
            self.streams[name] = self._index(name, rows)

        self.end = self._actual_end()

    def _actual_end(self):
        """
        When the session really finished, which is not always when it was scheduled to.

        OpenF1's `date_end` is the timetable's. The 2026 Singapore sprint is listed as
        09:00-09:30, but the start was delayed with the cars on the grid until 09:30 and
        the flag fell at 10:16. Bounded by the timetable, the scrubber covered only the
        wait on the grid, and every flag period of the actual race fell off its end. So
        the end is the later of the timetable and the last completed lap, plus a couple
        of minutes for the in-lap.
        """
        scheduled = _parse_dt(self.session.get("date_end"))
        latest = None
        for _keys, rows in self.streams.get("laps", {}).values():
            for row in rows:
                begun = _parse_dt(row.get("date_start"))
                duration = row.get("lap_duration")
                if begun is not None and duration:
                    finished = begun + timedelta(seconds=duration)
                    if latest is None or finished > latest:
                        latest = finished
        if latest is None:
            return scheduled
        latest += timedelta(minutes=2)
        return latest if scheduled is None or latest > scheduled else scheduled

    @property
    def race_control(self):
        return self.session_streams.get("race_control", [])

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

    def _session_upto(self, name, moment):
        """Every row of a session-wide stream at or before `moment`."""
        return [r for r in self.session_streams.get(name, ())
                if (_parse_dt(r.get("date")) or moment) <= moment]

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
        ], authed=_replay_authed())

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
        state.race_control = self._session_upto("race_control", moment)
        state.weather = self._session_upto("weather", moment)
        state.team_radio = self._session_upto("team_radio", moment)

        for num in self.drivers_seen():
            for name, target in (("position", state.position), ("intervals", state.intervals)):
                rows = self._upto(name, num, moment)
                if rows:
                    target[num] = rows[-1]

            # Through the same fold the live path uses, rather than a second copy of it:
            # it sets the latest lap, the driver's best, and both sets of sector bests, so
            # a replay and a live race cannot disagree about what is purple.
            laps = self._upto("laps", num, moment)
            if laps:
                _merge_laps(state, laps)

            stops = self._upto("pit", num, moment)
            if stops:
                state.pit[num] = {
                    "laps": set(r.get("lap_number") for r in stops),
                    "last": stops[-1],
                }
                state.stops[num] = {str(r.get("date") or ""): r for r in stops}

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

    sessions = _get("sessions", [("session_key", key)], authed=_replay_authed())
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
    end = replay.end
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


# The stream module needs the credentials and the REST fetch, and must not import this one.
f1_stream.configure(
    OPENF1_USER,
    _bearer,
    lambda stream, filters: _get(stream, filters, authed=_replay_authed()),
)
