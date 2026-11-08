"""
OpenF1's live stream, as a source for f1_live's session state.

f1_live polls OpenF1's REST API, and in a race that spends nearly the whole call allowance
on a refresh table that still only sees each car's position every six seconds and race
control every eight. The sponsor tier also publishes every stream over MQTT (here, over a
secure WebSocket), pushed about three seconds behind the track, outside the call limit:
car positions and telemetry at ~3.7 Hz per car, race control the moment it is issued.

This module is only the upstream end. It holds one connection, parses each message and
queues it; f1_live drains the queue into the same _Session accumulators the REST refresh
fills, so _compose cannot tell the two apart. Whatever the stream is not delivering — it is
down, reconnecting, or quiet because nobody is on track — f1_live's REST polling covers, as
it always has. See _covered there.

The connection is made on demand, by the app's /f1/stream, and dropped a minute after the
last one closes: OpenF1 allows ten connections per account, and Cloud Run only gives the
container CPU while a request is open, which a held-open stream is.

F1_STREAM_SIMULATE=<session_key>@<iso instant> swaps the connection for a simulator that
plays a past session's rows into the same queue at the pace they happened, for testing the
whole path — fold, compose, push, app — away from a race weekend. Local use only.
"""

import heapq
import json
import os
import queue
import statistics
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone

try:
    import certifi
    import paho.mqtt.client as mqtt
except ImportError:  # the REST path still works without it
    certifi = None
    mqtt = None

HOST = "mqtt.openf1.org"
PORT = 8084
PATH = "/mqtt"

# Streams taken from the broker. Named, not `#`, so overtakes, championship and the
# session index don't cost a byte; f1_live has no use for them.
TOPICS = ("location", "car_data", "position", "intervals", "laps", "race_control", "pit",
          "stints", "weather", "team_radio", "drivers", "session_result")

# Connected and heard from within this long counts as healthy. Positions and telemetry flow
# continuously while cars are on track, so ten seconds of silence means a problem, or
# nobody on track — either way REST should take over.
HEALTHY_WITHIN = 10.0

# How long the connection outlives the last stream that wanted it.
IDLE_DISCONNECT = 60.0

# Tokens last an hour; reconnect with a fresh one comfortably before that.
TOKEN_ROTATE = 50 * 60

QUEUE_MAX = 50000


def _when(row):
    """The instant a row describes: `date`, or `date_start` for laps."""
    value = row.get("date") or row.get("date_start")
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


class _Stats:
    """Per-topic counts, rates and delay, for /f1/stream/status."""

    def __init__(self):
        self._lock = threading.Lock()
        self.count = {}
        self.recent = {}      # topic -> deque of (arrived, lag seconds or None)
        self.last = {}

    def note(self, topic, arrived, row, clock_offset=0.0):
        when = _when(row)
        lag = arrived - clock_offset - when.timestamp() if when is not None else None
        with self._lock:
            self.count[topic] = self.count.get(topic, 0) + 1
            recent = self.recent.setdefault(topic, deque())
            recent.append((arrived, lag))
            while recent and arrived - recent[0][0] > 60.0:
                recent.popleft()
            self.last[topic] = arrived

    def report(self):
        now = time.time()
        out = {}
        with self._lock:
            for topic in sorted(self.count):
                recent = [r for r in self.recent.get(topic, ()) if now - r[0] <= 60.0]
                lags = sorted(lag for _, lag in recent if lag is not None)
                out[topic] = {
                    "count": self.count[topic],
                    "perSecond": round(len(recent) / 60.0, 2),
                    "lagMedian": round(statistics.median(lags), 2) if lags else None,
                    "lagP90": round(lags[int(len(lags) * 0.9)], 2) if lags else None,
                    "lastAgo": round(now - self.last[topic], 1),
                }
        return out


class _Source:
    """What f1_live sees of either source: a queue of (stream, row), and whether to trust it."""

    kind = None

    def __init__(self):
        self.rows = queue.Queue(maxsize=QUEUE_MAX)
        self.stats = _Stats()
        self.session_key = None
        self.wanted = time.time()
        self.last_message = 0.0
        self.connected_at = None
        self.reconnects = 0
        self.dropped = 0

    def want(self, session_key):
        """Called by every open /f1/stream on each tick: keep the connection, follow the session."""
        self.session_key = session_key
        self.wanted = time.time()

    def drain(self, limit=20000):
        out = []
        while len(out) < limit:
            try:
                out.append(self.rows.get_nowait())
            except queue.Empty:
                break
        return out

    def _offer(self, topic, row, arrived, clock_offset=0.0):
        self.last_message = arrived
        self.stats.note(topic, arrived, row, clock_offset)
        try:
            self.rows.put_nowait((topic, row))
        except queue.Full:
            self.dropped += 1

    def connected(self):
        return self.connected_at is not None

    def healthy(self):
        return self.connected() and time.time() - self.last_message < HEALTHY_WITHIN

    def covered(self):
        """The streams f1_live may stop polling while this source is healthy."""
        return set(TOPICS) if self.healthy() else set()

    def idle(self):
        return time.time() - self.wanted > IDLE_DISCONNECT

    def status(self):
        return {
            "source": self.kind,
            "connected": self.connected(),
            "healthy": self.healthy(),
            "connectedAt": (datetime.fromtimestamp(self.connected_at, timezone.utc).isoformat()
                            if self.connected_at else None),
            "reconnects": self.reconnects,
            "sessionKey": self.session_key,
            "queued": self.rows.qsize(),
            "dropped": self.dropped,
            "topics": self.stats.report(),
        }

    def stop(self):
        pass


class _Upstream(_Source):
    """The OpenF1 broker, over a secure WebSocket."""

    kind = "mqtt"

    def __init__(self, user, bearer):
        super().__init__()
        self.user = user
        self.bearer = bearer
        self.token_at = 0.0
        self.client = None
        self._start()
        threading.Thread(target=self._janitor, name="f1-stream-janitor", daemon=True).start()

    def _start(self):
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            transport="websockets",
        )
        client.ws_set_options(path=PATH)
        client.tls_set(ca_certs=certifi.where())
        client.username_pw_set(self.user, self.bearer())
        self.token_at = time.time()
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        client.connect_async(HOST, PORT, keepalive=30)
        client.loop_start()
        self.client = client

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            # Most often an expired or revoked token: mint a new one for the next attempt,
            # which paho makes by itself.
            if "author" in str(reason_code).lower() or "password" in str(reason_code).lower():
                try:
                    client.username_pw_set(self.user, self.bearer(force=True))
                    self.token_at = time.time()
                except Exception:
                    pass
            return
        if self.connected_at is not None:
            self.reconnects += 1
        self.connected_at = time.time()
        client.subscribe([("v1/" + topic, 0) for topic in TOPICS])

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        self.connected_at = None
        # paho reconnects with the credentials it holds; make sure they're current.
        try:
            client.username_pw_set(self.user, self.bearer())
        except Exception:
            pass

    def _on_message(self, client, userdata, message):
        arrived = time.time()
        try:
            row = json.loads(message.payload)
        except ValueError:
            return
        if not isinstance(row, dict):
            return
        if self.session_key is not None and row.get("session_key") not in (None, self.session_key):
            return
        self._offer(message.topic.rsplit("/", 1)[-1], row, arrived)

    def _janitor(self):
        """Rotate the token before it lapses; let go once nothing has wanted the stream."""
        while self.client is not None:
            time.sleep(5)
            if self.idle():
                _release(self)
                return
            if time.time() - self.token_at > TOKEN_ROTATE:
                old, self.client = self.client, None
                try:
                    old.disconnect()
                    old.loop_stop()
                except Exception:
                    pass
                self.connected_at = None
                self.reconnects += 1
                try:
                    self._start()
                except Exception:
                    self.client = old  # try again on the next pass

    def stop(self):
        client, self.client = self.client, None
        self.connected_at = None
        if client is not None:
            try:
                client.disconnect()
                client.loop_stop()
            except Exception:
                pass


class _Simulator(_Source):
    """
    A past session played through the stream path at the pace it happened.

    Rows are fetched from OpenF1's history a minute ahead of the simulated clock, on a thread
    of their own, and released when the clock reaches them. Laps are released twice, the way
    the live feed reports them: as the lap starts, with no time on it, and complete once it
    is done. Stints and the session result have no timestamps to pace them by, so they are
    left to f1_live's REST polling, bounded by the same clock.
    """

    kind = "simulator"
    PACED = ("location", "car_data", "position", "intervals", "laps", "race_control", "pit",
             "weather", "team_radio")
    WINDOW = 60.0
    LAP_ONLY = ("lap_duration", "duration_sector_1", "duration_sector_2", "duration_sector_3",
                "st_speed", "i1_speed", "i2_speed")

    def __init__(self, key, start, fetch):
        super().__init__()
        self.key = key
        self.session_key = key
        self.start = start
        self.fetch = fetch
        self.offset = time.time() - start.timestamp()
        self.drop = os.environ.get("F1_STREAM_SIMULATE_DROP") == "1"
        self.heap = []              # (release instant, sequence, topic, row)
        self.sequence = 0
        self.heap_lock = threading.Lock()
        self.loaded_to = start - timedelta(seconds=5)
        self.running = True
        threading.Thread(target=self._loader, name="f1-stream-sim-load", daemon=True).start()
        threading.Thread(target=self._run, name="f1-stream-sim", daemon=True).start()

    def now(self):
        return datetime.fromtimestamp(time.time() - self.offset, timezone.utc)

    def covered(self):
        return (set(self.PACED) | {"drivers"}) if self.healthy() else set()

    def _push(self, when, topic, row):
        self.sequence += 1
        heapq.heappush(self.heap, (when, self.sequence, topic, row))

    def _load(self, a, b):
        stamp = lambda dt: dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        for topic in self.PACED:
            field = "date_start" if topic == "laps" else "date"
            try:
                rows = self.fetch(topic, [("session_key", self.key), (field + ">=", stamp(a)),
                                          (field + "<", stamp(b))])
            except Exception:
                continue
            with self.heap_lock:
                for row in rows:
                    when = _when(row)
                    if when is None:
                        continue
                    if topic == "laps" and row.get("lap_duration"):
                        started = {k: v for k, v in row.items() if k not in self.LAP_ONLY}
                        self._push(when, topic, started)
                        self._push(when + timedelta(seconds=row["lap_duration"]), topic, row)
                    else:
                        self._push(when, topic, row)

    def _loader(self):
        try:
            for row in self.fetch("drivers", [("session_key", self.key)]):
                self._offer("drivers", row, time.time())
        except Exception:
            pass
        while self.running:
            if self.loaded_to < self.now() + timedelta(seconds=30):
                a, b = self.loaded_to, self.loaded_to + timedelta(seconds=self.WINDOW)
                self._load(a, b)
                self.loaded_to = b
                if self.connected_at is None:
                    self.connected_at = time.time()
            time.sleep(0.5)

    def _run(self):
        while self.running:
            if self.idle():
                _release(self)
                return
            now = self.now()
            due = []
            with self.heap_lock:
                while self.heap and self.heap[0][0] <= now:
                    due.append(heapq.heappop(self.heap))
            if not self.drop:
                for when, _, topic, row in due:
                    # Its delay is measured against the simulated clock, so the stats read
                    # as they would live: how long after the moment it describes it arrived.
                    self._offer(topic, row, time.time(), clock_offset=self.offset)
            time.sleep(0.05)

    def stop(self):
        self.running = False


# ---------------------------------------------------------------------------
# The one source
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_source = None
_config = {"user": "", "bearer": None, "fetch": None}


def _simulate_setting():
    raw = os.environ.get("F1_STREAM_SIMULATE", "")
    if "@" not in raw:
        return None
    key, start = raw.split("@", 1)
    try:
        return int(key), datetime.fromisoformat(start.replace("Z", "+00:00"))
    except ValueError:
        return None


SIMULATE = _simulate_setting()


def configure(user, bearer, fetch):
    """Wire in f1_live's credentials and REST fetch, without either module importing the other."""
    _config.update(user=user, bearer=bearer, fetch=fetch)


def sim_now():
    """The simulated clock, or None on the real feed."""
    source = _source
    if isinstance(source, _Simulator):
        return source.now()
    if SIMULATE:
        return SIMULATE[1]
    return None


def current():
    return _source


def ensure(session_key):
    """The source for `session_key`, connecting it if nothing is yet. None if it can't be."""
    global _source
    with _lock:
        if _source is None:
            try:
                if SIMULATE:
                    _source = _Simulator(SIMULATE[0], SIMULATE[1], _config["fetch"])
                elif mqtt is not None and _config["user"] and _config["bearer"]:
                    _source = _Upstream(_config["user"], _config["bearer"])
            except Exception:
                _source = None
        if _source is not None:
            _source.want(session_key)
        return _source


def _release(source):
    global _source
    with _lock:
        if _source is source:
            _source = None
    source.stop()


def set_drop(drop):
    """Silence the simulator, to watch f1_live fall back to REST. Simulator only."""
    source = _source
    if isinstance(source, _Simulator):
        source.drop = bool(drop)
        return True
    return False
