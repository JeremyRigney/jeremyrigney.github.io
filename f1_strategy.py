"""
The pit-wall numbers behind /f1-wall's Wall tab: how long a lap is taking, and what a stop
costs right now.

Pure functions over the accumulators `_Session` already keeps — `lap_history`, `stops`,
`position` — and the flag periods from `_flag_periods`. No upstream calls of its own, and
no state between frames: a replay rebuilt at any instant gets the same answer as a live
race did at that instant.

What a stop costs depends on the flag, and that is the whole reason the view exists.

  * **Green.** Seeded per circuit from published pre-race figures, then pulled towards what
    the race itself shows: in-lap + out-lap, minus twice the driver's own pace either
    side. Weighted 2:1 in favour of the seed per stop, so one slow stop moves it a little
    and a dozen stops own it.

  * **VSC and SC.** A stop is cheaper because the field is slower everywhere except the pit
    lane, whose speed limit is unchanged. Stretch the stretch of track the pit lane
    bypasses by the slowdown factor k (neutralised lap ÷ green lap) and the gain is
    (k − 1) × that stretch. The stretch is taken as a fixed share of the lap, BYPASS.
    Where stops have actually been made under the neutralisation, those are measured the
    same way (against the field's laps rather than the driver's own) and blended in.

    Lane time is reported, but it is not used to derive the neutralised loss: OpenF1's
    `lane_duration` is measured between the pit lane's own lines, and at Zandvoort 2025
    it was 18.7s against a green loss of over 20s — the slowing down and speeding up
    outside the lines is a real part of the cost, and the lane alone cannot see it.
"""

from statistics import median

# Green-flag pit loss per circuit, in seconds: pit entry to pit exit at the speed limit
# plus a typical stop, minus the same stretch at racing speed. Approximate pre-race
# figures; they are a starting point that each green stop in the race corrects.
# Keyed on Formula 1's circuit id (OpenF1's `circuit_key`).
SEED_PIT_LOSS = {
    2: 20.0,     # Silverstone
    4: 20.5,     # Hungaroring
    7: 20.5,     # Spa-Francorchamps
    9: 20.0,     # Austin
    10: 19.5,    # Melbourne
    14: 21.0,    # Interlagos
    15: 22.0,    # Barcelona
    19: 20.5,    # Red Bull Ring
    22: 19.5,    # Monaco
    23: 18.5,    # Montreal
    39: 24.0,    # Monza
    46: 22.5,    # Suzuka
    49: 23.0,    # Shanghai
    55: 21.5,    # Zandvoort
    61: 28.0,    # Marina Bay
    63: 23.0,    # Sakhir
    65: 22.0,    # Mexico City
    70: 22.0,    # Yas Marina
    144: 20.0,   # Baku
    149: 20.0,   # Jeddah
    150: 25.0,   # Lusail
    151: 20.0,   # Miami
    152: 20.5,   # Las Vegas
}
DEFAULT_PIT_LOSS = 22.0

# Each green stop counts once; the seed counts this many times.
SEED_WEIGHT = 2.0

# The share of a green lap the pit lane bypasses, entry slowdown to exit merge included.
# Tuned so the model lands where pit walls quote it: a stop under SC costs roughly 55% of a
# green one, under VSC roughly 65%. At Zandvoort 2025 the measured SC slowdown was 1.38,
# which with 0.30 gives 12.4s against 19.0s green.
BYPASS = 0.30

# How much slower the field runs, until a fully neutralised lap has been completed to
# measure it. A VSC is a delta the drivers must stay above; a safety car is slower still.
DEFAULT_K = {"vsc": 1.30, "sc": 1.45}

# With no green lap yet to scale by, the neutralised loss as a share of green.
FALLBACK_RATIO = {"vsc": 0.65, "sc": 0.50}

# Bounds on any single measured loss: anything outside is a repair, a penalty served in
# the box, or timing noise — not a pit stop.
SAMPLE_RANGE = (5.0, 45.0)
# A stationary time outside this range is a drive-through (no stop) or a problem stop.
STATIONARY_RANGE = (1.5, 10.0)


def _norm(state):
    """Flag state as the strategy sees it. A local yellow is still a racing lap."""
    if state in ("GREEN", "YELLOW"):
        return "green"
    if state == "VSC":
        return "vsc"
    if state == "SAFETY_CAR":
        return "sc"
    return "other"


def _state_at(periods, moment):
    state = "GREEN"
    for start, _end, name in periods:
        if start > moment:
            break
        state = name
    return state


class _Laps:
    """Every completed lap of the race, classified by the flag it was run under."""

    def __init__(self, history, periods, until, parse):
        self.by_driver = {}      # num -> {lap_number: (duration, state, pit)}
        self.until = until
        for num, laps in history.items():
            mine = {}
            for number, row in laps.items():
                duration = row.get("lap_duration")
                begin = parse(row.get("date_start"))
                if not duration or begin is None or number is None:
                    continue
                end = begin.timestamp() + duration
                # Under replay a lap's row already carries the time it will finish in;
                # it has not happened yet at this instant.
                if until is not None and end > until.timestamp():
                    continue
                mine[number] = [duration, self._classify(periods, begin, end), False]
            self.by_driver[num] = mine

    @staticmethod
    def _classify(periods, begin, end):
        states = {_norm(_state_at(periods, begin))}
        for start, _stop, name in periods:
            at = start.timestamp()
            if begin.timestamp() < at <= end:
                states.add(_norm(name))
        return states.pop() if len(states) == 1 else "mixed"

    def mark_pits(self, stops, history):
        """In-laps from the pit stream, out-laps from the laps stream's own flag."""
        for num, rows in stops.items():
            mine = self.by_driver.get(num, {})
            for row in rows:
                n = row.get("lap_number")
                if n in mine:
                    mine[n][2] = True
                if n is not None and n + 1 in mine:
                    mine[n + 1][2] = True
        for num, laps in history.items():
            mine = self.by_driver.get(num, {})
            for number, row in laps.items():
                if row.get("is_pit_out_lap") and number in mine:
                    mine[number][2] = True

    def clean(self, num, state="green"):
        """A driver's racing laps under one flag: no lap 1, no in- or out-laps."""
        return {n: lap[0] for n, lap in self.by_driver.get(num, {}).items()
                if n > 1 and lap[1] == state and not lap[2]}


def _median(values):
    values = [v for v in values if v is not None]
    return median(values) if values else None


def _ref_lap(laps, order):
    """Green pace now: the leading cars' last five clean laps, pooled."""
    pool = []
    for num in order[:10]:
        clean = laps.clean(num)
        pool.extend(clean[n] for n in sorted(clean)[-5:])
    return _median(pool)


def _neutral_lap(laps, state):
    """
    Median lap of the field under the neutralisation that is out now, from laps run wholly
    inside it. None until at least three cars have completed one.
    """
    pool = []
    for num in laps.by_driver:
        clean = laps.clean(num, state)
        pool.extend(clean.values())
    # Laps from an earlier SC count too; the speed a safety car runs at is the same one.
    return _median(pool) if len(pool) >= 3 else None


def _field_lap(laps, number, state):
    """The field's median time for one lap number, run wholly under `state`."""
    pool = [lap[0] for mine in laps.by_driver.values()
            for n, lap in mine.items() if n == number and lap[1] == state and not lap[2]]
    return _median(pool) if len(pool) >= 3 else None


def _observed(laps, stops):
    """Measured losses per flag, one per stop whose in- and out-laps share a flag."""
    out = {"green": [], "vsc": [], "sc": []}
    for num, rows in stops.items():
        mine = laps.by_driver.get(num, {})
        for row in rows:
            n = row.get("lap_number")
            stationary = row.get("stop_duration")
            if n is None or n < 2:
                continue
            if stationary is not None and not (
                    STATIONARY_RANGE[0] <= stationary <= STATIONARY_RANGE[1]):
                continue
            inlap, outlap = mine.get(n), mine.get(n + 1)
            if not inlap or not outlap or inlap[1] != outlap[1] or inlap[1] not in out:
                continue
            state = inlap[1]
            if state == "green":
                clean = laps.clean(num)
                pace = _median([t for k, t in clean.items() if n - 4 <= k <= n + 5])
                near = len([k for k in clean if n - 4 <= k <= n + 5])
                if pace is None or near < 2:
                    continue
                baseline = 2 * pace
            else:
                a, b = _field_lap(laps, n, state), _field_lap(laps, n + 1, state)
                if a is None or b is None:
                    continue
                baseline = a + b
            loss = inlap[0] + outlap[0] - baseline
            if SAMPLE_RANGE[0] <= loss <= SAMPLE_RANGE[1]:
                out[state].append(loss)
    return out


def _blend(prior, samples):
    return (SEED_WEIGHT * prior + sum(samples)) / (SEED_WEIGHT + len(samples))


def _round(value, places=1):
    return None if value is None else round(value, places)


def compute(state, periods, flag_state, circuit_key, order, until, parse):
    """
    The `strategy` block of the composed payload, for a race.

    `periods` is _flag_periods' output, `order` the driver numbers in running order, and
    `until` the instant the frame describes (now, or the replay playhead).
    """
    laps = _Laps(state.lap_history, periods, until, parse)
    stops = {num: [r for r in rows.values()
                   if until is None or (parse(r.get("date")) or until) <= until]
             for num, rows in state.stops.items()}
    laps.mark_pits(stops, state.lap_history)

    ref = _ref_lap(laps, order)
    observed = _observed(laps, stops)

    seed = SEED_PIT_LOSS.get(circuit_key, DEFAULT_PIT_LOSS)
    green = _blend(seed, observed["green"])

    now_state = _norm(flag_state)
    k = {}
    for name in ("vsc", "sc"):
        measured = _neutral_lap(laps, name)
        k[name] = (measured / ref) if (measured and ref) else DEFAULT_K[name]
        # A neutralised lap can only be slower; anything else is a lap misfiled.
        k[name] = max(1.05, min(k[name], 2.5))

    loss = {"green": green}
    for name in ("vsc", "sc"):
        if ref:
            model = green - (k[name] - 1) * BYPASS * ref
        else:
            model = green * FALLBACK_RATIO[name]
        value = _blend(model, observed[name])
        loss[name] = max(0.3 * green, min(value, green))

    # The lap the ring is drawn on: green pace, stretched under a neutralisation.
    ring = ref
    if ref and now_state in k:
        ring = ref * k[now_state]

    lanes = [r.get("lane_duration") or r.get("pit_duration")
             for rows in stops.values() for r in rows]
    stationary = [r.get("stop_duration") for rows in stops.values() for r in rows
                  if r.get("stop_duration") and
                  STATIONARY_RANGE[0] <= r["stop_duration"] <= STATIONARY_RANGE[1]]

    return {
        "refLap": _round(ref, 3),
        "ringLap": _round(ring, 3),
        "k": {name: _round(value, 3) for name, value in k.items()},
        "pitLoss": {
            "green": _round(loss["green"]),
            "vsc": _round(loss["vsc"]),
            "sc": _round(loss["sc"]),
            "now": _round(loss.get(now_state, loss["green"])),
            "seed": seed,
            "basis": "calibrated" if observed["green"] else "seed",
            "samples": {name: len(values) for name, values in observed.items()},
        },
        "lane": _round(_median(lanes), 2),
        "stationary": _round(_median(stationary), 2),
    }
