# /f1-wall

The whole race in one window — track map, running order, race control, team radio and the
flag state.
The page has **two modes**, decided entirely by the URL:

| Mode | URL | Driven by |
|---|---|---|
| **Replay** (default) | `f1-wall.html?api=…&session=<key>` | `assets/js/f1-lab.js` — toolbar, scrubber, playback |
| **Live** | `f1-wall.html?live=1&api=…` | `assets/js/f1-dash.js` — its own poll loop |

They are mutually exclusive. `?live=1` makes `f1-dash.js` delete the scrubber from the DOM,
which is what switches `f1-lab.js` off — that file opens with `if (!el('lab-range')) return;`.
So a URL either has `live=1` or it has a session; never both.

---

## Setup

Once per machine:

```bash
cd ~/Documents/code/jeremyrigney.github.io
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then create `.env.local` in the repo root with your OpenF1 credentials:

```bash
OPENF1_USER=your-username
OPENF1_PASS=your-password
```

It's gitignored — never commit it. Credentials are not optional: without them `/f1/live`
can't run, and OpenF1 locks its *whole* API (historical data included) to authenticated
users for as long as a session is on track, so replay stops working too.

## Running it

```bash
tools/serve-f1.sh --wall
```

That starts two servers and opens the page. Both are needed:

- **:8080** — `app.py`, the Flask API that composes the timing payload (`/f1/live`)
- **:8000** — a static server for the site itself

Opening the file from disk does **not** work: `file://` gives the page a null origin, so the
browser blocks the fetches the map and season index need. `f1-map.js` will say so on the canvas.

`Ctrl-C` stops both. `--lab` serves `/f1-lab` instead; `--no-open` skips the browser.

If it refuses to start with *"Port 8080 is already in use"*, an earlier run is still alive:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN     # find it
kill <pid>
```

---

## Replay mode

```
http://localhost:8000/f1-wall.html?api=http://localhost:8080
```

Pick a **Season** and **Session** from the toolbar. The first frame takes a few seconds —
the server is pulling that session from OpenF1 and caching it — and **Play stays disabled
until it lands**. After that, scrubbing costs no network at all.

The scrubber runs from the scheduled start to whichever comes later: the scheduled end, or
two minutes after the last completed lap (`_ReplaySession._actual_end`). OpenF1's
`date_end` comes from the timetable and isn't updated for delays. The 2026 Singapore sprint
is listed as 09:00–09:30 but finished at 10:16, and when the scrubber stopped at the
scheduled end it covered only the cars waiting on the grid.

Once a session is loaded, `f1-lab.js` writes its key onto the URL, so the address bar
becomes something you can bookmark or reload:

```
http://localhost:8000/f1-wall.html?api=http://localhost:8080&session=11363
```

`session=11363` is 2026 Madring, Practice 2. A pinned session is looked up across every
season, so you don't need to know which year it belongs to.

**Controls**

| Control | What it does |
|---|---|
| Play / Pause | Paced against the wall clock, not a fixed timer |
| Speed | 1× / 5× / 10× / 60× / 300× — changing it mid-play re-anchors, so there's no jump |
| Scrubber | Painted with the session's flag periods, notched with race-control events |
| Jump to: | One button per non-green period — safety cars, yellows, red flags |
| `←` `→` | Nudge 5s (hold `Shift` for 30s) — how you pin down the instant a flag changes |
| `Space` | Play / pause |

Radio autoplay needs 1× — see [Team radio](#team-radio).

## Live mode

```
http://localhost:8000/f1-wall.html?live=1&api=http://localhost:8080
```

No toolbar — a session picker that can't pick anything is worse than none. The page polls
`/f1/live` every **1.5s** and draws whatever is on track right now.

Leave it open. Outside a session it polls slowly (60s) and says `NO SESSION RUNNING`, then
fills in by itself when one starts — no reload needed. When one ends it says `SESSION OVER`
and leaves the final order on screen. Backgrounding the tab drops it to a 30s poll.

**The Delay box** — the one control in live mode. The timing feed runs ahead of every
broadcast of it, so a wall fed straight from the feed announces the overtake before you see
it. Type however many seconds your stream is behind (0–60) and the whole wall is held back
to match.

- The badge reads `LIVE · 14:57:31 · −20s` when a delay is set, so a wall that's behind on
  purpose can't be mistaken for one that's stuck.
- It starts at 0 each load — nothing is remembered between reloads.
- **Raising** it freezes the current frame until the buffer refills to the new depth.
- **Lowering** it catches up immediately; drop it by more than 20s and the cars snap to
  position once instead of gliding.

---

## Team radio

The small dock in the top-left of the map. It works the same in both modes, because the
clips ride on the ordinary `/f1/live` payload as a `radio` array and are bounded by the same
replay instant as everything else.

**Following a driver.** Click their code in the timing tower. A followed driver is
underlined with a dot beside it, and their radio then plays by itself as it arrives.
Everyone else's clips still appear in the dock — click one to hear it. Follows are kept in
`localStorage` under `f1-wall-radio` and survive a reload and a change of session; the
audio on/off preference is kept beside them.

**Sound has to be switched on once per page.** Browsers refuse audio until the page has
been interacted with, so the header button reads `RADIO OFF` until you click it. If sound
was on last time, the first click anywhere on the page turns it back on — you don't have to
find the button. `AUDIO BLOCKED` means the browser refused anyway; clicking a clip directly
is both a gesture and a retry.

**In replay, autoplay only happens at 1×.** Above that a twenty-second clip cannot fit in
the race time it spans, so the dock fills but stays quiet, and the header says `· 1× only`.
The toolbar starts at 5×, so this is the usual answer to "why is nothing playing". Clicking
a clip pauses playback, plays it, and resumes — `f1-lab.js` re-anchors on resume, so the
race doesn't leap.

**What it deliberately doesn't do.** It holds five rows and doesn't scroll — it's a "what
did they just say" dock, not an archive. Followed clips play one at a time with at most
three waiting; a longer burst drops its oldest, which stays in the list a click away.
Anything older than two minutes of race time is listed but not played.

Notes for anyone editing it:

- The clips are served by Formula 1's own CDN **with no CORS headers**. A media element
  can play them as an opaque resource, which is why there is exactly one `<audio>` and why
  it must never be given a `crossorigin` attribute — that turns every clip into a load
  error. It also means no Web Audio, no waveforms, and no duration until metadata arrives.
- `render()` gets a whole snapshot every frame and the playhead can move backwards, so
  "a new clip" is derived from a watermark plus a seen set, and a rewind is detected on
  `data.generated` — see `radioSync` in `f1-dash.js`.
- A clip whose URL 404s is one bad file, not an audio block. Only `NotAllowedError` from
  `play()` means the browser is refusing; conflating the two turns autoplay off for the
  rest of the session after a single dead MP3.
- Server side it is one stream, `team_radio`, shaped exactly like `race_control`: always
  fetched whole, `_replace`d, in `OPTIONAL`, and folded by `build_radio` which takes the
  same `flag_until` bound. Costs about 3 calls a minute of the ~55 budget.

## Wall tab

The **Map | Wall** switch above the map. The Wall is the pit wall's "wall of doom": one lap
drawn as a ring, with every car placed round it. It replaces the map and the race control
band; the timing tower stays. `?view=wall` opens straight onto it, and the last choice is
kept in `localStorage` under `f1-wall-view`.

**The ring is time, not distance.** One trip round is one lap at current pace
(`strategy.ringLap`), and each car sits at its gap to the leader. A car 20s behind is 20s
of arc behind, whatever corner it is in. A lapped car's "+1 LAP" is replaced by summing
the intervals down from the car in front. The ring is anchored on the leader's
`lapStart`, and between polls it turns at one lap per `ringLap`: at the replay speed while
playing, and not at all while paused. Ticks every 5s (longer every 15s) let you read gaps
off it by eye. S2 and S3 are placed by the session-best sector split. The track turns
yellow under SC/VSC, and cars in the pit lane sit on the inner ring.

**Ghosts.** Pick a car on the ring, in the tower or in the stint strip, and its ghost
appears. The ghost is where it would rejoin if it pitted now: the car moved back round
the ring by the pit loss for the flag that is out. **All ghosts** shows every car's. Under
a safety car the lap stretches and the loss shrinks, so the ghosts pull in towards their
cars. That shrinkage is the cheap stop.

**The centre** shows:
- the lap count
- pit loss under green, VSC and SC, with the one that applies now outlined
- for the picked car, a pit-now projection:
  - its position after the stop (e.g. `P3 → P6`), and who it lands behind and in front of
  - `FREE STOP` when the gap behind is bigger than the loss
  - `TRAFFIC` when it rejoins within 1.5s of any car, lapped ones included
  - `UNDERCUT` when a car is within 2.5s either side
- the last four race control messages

**The stint strip** has one row per car: compound bars by lap, up to the lap the car is on,
plus `FREE` where a stop now costs no place.

### How pit loss is estimated

All of this is in `f1_strategy.py`. It is a set of pure functions over history `_Session`
now keeps (`lap_history`, `stops`) and the flag periods from `_flag_periods`. It makes no
upstream calls.

- **Green:** a per-circuit seed (`SEED_PIT_LOSS`, approximate pre-race figures, 22s if the
  circuit is missing), pulled towards each green stop in the race. A stop's loss is in-lap
  + out-lap minus twice the driver's own clean pace in the laps either side. The seed
  counts as two stops.
- **VSC and SC:** green minus `(k − 1) × BYPASS × refLap`.
  - `k` is how much slower the field runs: the median neutralised lap ÷ green pace.
    Defaults are 1.30 (VSC) and 1.45 (SC) until three cars have completed a lap wholly
    under one.
  - `BYPASS` (0.30) is the share of the lap the pit route covers, tuned so SC lands near
    55% of green and VSC near 65%.
  - Stops made wholly under a neutralisation are measured against the field's laps and
    blended in.
- **Lane time is reported, not used.** `lane_duration` is measured between the pit lane's
  lines. At Zandvoort 2025 it was 18.7s against a ~19–20s green loss, so it misses the
  slowing down and speeding up outside them.
- Laps are classified by the flag they ran under. A local yellow counts as green, and lap 1
  and in- and out-laps are excluded from pace.

Against the 2025 Dutch GP (9920), green calibrates from the 21.5s seed to about 19s. SC
comes out near 10s (measured k ≈ 1.38) and VSC near 12s.

**Payload.** Races only, and optional like everything else:

```
strategy: { refLap, ringLap, k: {vsc, sc},
            pitLoss: {green, vsc, sc, now, seed, basis: "seed"|"calibrated",
                      samples: {green, vsc, sc}},
            lane, stationary }
drivers[].lapStart   ISO start of the lap in progress
```

Without `strategy`, the ring still draws (from the field's last laps) but has no ghosts.
Without `lapStart`, it says it needs the updated server. A race now reads its whole `laps`
stream on first refresh (~1,200 rows), so a server that cold-starts mid-race still has the
history to calibrate from.

---

## Notes

- `?api=` is **loopback-only by design** — it accepts `localhost` and `127.0.0.1` and
  nothing else, so a crafted link can't feed the page content from somewhere else.
  Without it, both modes talk to the deployed Cloud Run service.
- The page is `noindex, nofollow`, not in the site nav and not in `sitemap.xml`.
- `app.py` binds `0.0.0.0`, so :8080 is reachable from your local network while it's
  running. It serves no files, but anyone who finds it spends your OpenF1 quota.
- Bump the `?v=` cache-busters in `f1-wall.html` when editing `f1-dash.js`, `f1-doom.js` or
  `f1-dash.css`, or the browser will keep serving you the old one.
- `f1_strategy.py` must be in the Dockerfile's `COPY` line beside `f1_live.py`, which
  imports it.
- Logs: `/tmp/f1-api.log` and `/tmp/f1-web.log`.
