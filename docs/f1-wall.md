# /f1-wall — Pitwall

A live Formula 1 timing wall: the flag, the running order, the track, the pit wall's view of
the race, race control, team radio and the weather. It is a web port of **Pocket Pitwall**,
the Android app that grew out of the first `/f1-wall`, styled in `/aurora`'s design language.

It heads the homepage's projects, and /f1 links to it for replays. It stays `noindex` and
off the nav, with its live wall behind a sign-in screen over race weekends. Nothing else on
the site loads its files. It replaced the first `/f1-wall` in November 2026 (see
[History](#history) at the end).

The app (`~/Documents/code/f1_app`, private) is the reference implementation. Each
`pitwall-*.js` names the Kotlin file it ports. When behaviour is in doubt, the app is right.

---

## Signing in

Replays, the standby poster and the calendar are open to anyone. The live wall is what
costs: its stream and polling keep Cloud Run's instance busy for a whole session. So from
a day before any session until an hour after it ends (`Pitwall.Calendar.liveSoon`), live
mode puts up a sign-in screen, which also offers **Browse the replays**. If the calendar
can't be read, it asks anyway. Until a browser is signed in, the live feed never starts:
a visitor's page asks the API only for the session lists (and the replays they open). A
browser stays signed in until **Sign out** in Settings. The poster and the sign-in screen
both carry a line saying why.

This is a deterrent, not security:
- The page is static, so the check runs in the browser, and anyone who reads the source can get past it.
- The API itself stays open to anyone who calls it directly.
- `pitwall-gate.js` keeps only a SHA-256 of `username:password`, never the password itself.

To change the credentials, put the new hash in `PASS`:

```bash
printf '%s' 'username:password' | shasum -a 256
```

Protecting the API itself would take a server-side check, such as a key the page and the
app both send. That would mean changing the app too.

---

## Running it

The page needs the timing API, `app.py` in the repo root. Locally, serve both:

```bash
tools/serve-f1.sh            # the API on :8080 and the site on :8000; opens the page
```

It opens `http://localhost:8000/f1-wall.html?api=http://localhost:8080`. To try a worktree's
copy of the page against the same API, serve the worktree on another port
(`python3 -m http.server 8001 --bind 127.0.0.1`) and open it there with the same `?api=`.

For a live session when there isn't one, the API can replay a past one as if it were live.
This is Kuala Lumpur's 2026 race, from lap 1:

```bash
F1_STREAM_SIMULATE=11731@2026-10-04T09:10:00Z tools/serve-f1.sh --no-open
```

Two quirks of the simulator, neither of which a real session has:

- **The Wall's ring reads "No cars on track."** The simulator dates frames now but lap
  starts in the simulated past, so every lap start looks a month old. The ring works in
  replay.
- **Reloading many times can use up the stream slots.** The local API runs out of its three
  stream slots, and the page falls back to polling. Restarting the API frees them. PR #20
  fixes the leak; Cloud Run has the fix once it's redeployed from `main`.

### The URL

| Parameter | What it does |
|---|---|
| `?api=http://localhost:8080` | Use a local API. Loopback addresses only; anything else is ignored. |
| `?session=11404&t=2026-11-01T20:45:00Z` | Open a replay at that moment. The page keeps this up to date as it plays, so the address is always a link to the moment on screen. |
| `?race=Las Vegas Grand Prix&year=2025` (`&day=2025-11-22`) | Open that year's grand prix from its start, by its day where given and otherwise its name (`Pitwall.Calendar.findRace`); the address then becomes `?session=`. /f1's "Watch it again in Pitwall" links use it, since /f1 knows the races but not OpenF1's keys. With no match, the picker opens on that year. |
| `?view=map\|wall\|feed\|tower` | Start on that view (`tower` only on a narrow screen). |
| `?demo=green\|sc\|yellow\|chequered\|quali\|idle` | Draw a captured frame from `tests/pitwall/fixtures/` under a "Demo frame" tag, so every flag state can be looked at any time. `idle` shows the standby poster with the real calendar. |
| `?stream=off` | Poll only, as the old wall did, for comparing the two. |
| `?intro` | Play the intro even if it has played in this tab already. |

### Keys

- **Views:** M, W and F switch views, and T opens the Tower view on a narrow screen.
- **Full screen:** Shift+F.
- **Replay:** Space plays and pauses; ← and → step 5 s (30 s with Shift); Home and End go to either end; L goes back to live.
- **Tower rows:** Enter opens a driver's card, and F follows them. On a row, a right-click or a long press also follows.
- **Esc** closes whatever is open.

---

## How it's built

There is no build step. Each script is an IIFE that adds itself to `window.Pitwall`, in
`/aurora`'s pattern.

**Pure modules** never touch the page. They run under macOS's `jsc` with the app's own unit
tests, ported to JavaScript:

| File | What it is | Ports |
|---|---|---|
| `pitwall-format.js` | Times, gaps, names, team colours (OKLab lift), flag words | `wall/Format.kt`, `ui/theme/TeamColours.kt` |
| `pitwall-parse.js` | Frames, car batches, timelines, sessions | `data/Parse.kt` |
| `pitwall-season.js` | Season index, the calendar, weekend strip, backdrops, reminders, `.ics` | `data/Season.kt`, `wall/Weekend.kt`, `data/Backdrops.kt`, `wall/Reminders.kt` |
| `pitwall-sse.js` | Server-sent events over `fetch` | `data/Sse.kt` |
| `pitwall-live.js` | The live feed: stream first, polling as backup, the delay | `wall/LiveFeed.kt` |
| `pitwall-replay.js` | Replay playback, jumps and flag bands | `wall/ReplayFeed.kt`, `ui/ReplayBar.kt` |
| `pitwall-track.js` | Circuits, projection, map motion, turn callouts | `data/Track.kt`, `data/Basemap.kt`, `wall/MapMotion.kt`, `wall/TurnCallouts.kt` |
| `pitwall-doom.js` | The ring: where a stop would put a car | `wall/Strategy.kt`, `wall/RingPick.kt` |
| `pitwall-alerts.js` | Banners, the voice's words, weather, the radio queue | `wall/Alerts.kt`, `wall/Announcer.kt`, `wall/WeatherHistory.kt`, `wall/Radio.kt` |

**DOM modules** draw the page. The `jsc` tests parse-check them; checking how they look is
done by eye.

| File | Draws | Ports |
|---|---|---|
| `pitwall-gate.js` | The sign-in screen; holds back the live feed | (the page's own) |
| `pitwall-intro.js` | The opening 2.38 s | `ui/Intro.kt` |
| `pitwall-ui.js` | Saved settings, `data-bind`, switches, the round + | (`aurora-hud.js`) |
| `pitwall-net.js` | The API, the stream with Web Locks | `data/Api.kt` |
| `pitwall-header.js` | The capsule: flag, lap, fastest lap, badge | `ui/StatusBar.kt` |
| `pitwall-tower.js` | The running order | `ui/Tower.kt` |
| `pitwall-timeline.js` | The dock: replay scrubber, live progress strip | `ui/ReplayBar.kt` |
| `pitwall-map.js` | The track map | `ui/TrackMap.kt`, `ui/Basemap.kt` |
| `pitwall-ring.js` | The Wall | `ui/Ring.kt` |
| `pitwall-audio.js` | The voice, the tone, the radio player | `wall/Voice.kt` |
| `pitwall-feed.js` | Race control, conditions, team radio | `ui/Feed.kt`, `ui/Conditions.kt` |
| `pitwall-driver.js` | One car in full, with live telemetry | `ui/DriverSheet.kt`, `ui/Telemetry.kt` |
| `pitwall-standby.js` | The poster between sessions | `ui/WallScreen.kt`, `ui/Backdrop.kt` |
| `pitwall-app.js` | Modes, views, settings, the URL, keys, wiring | `wall/WallViewModel.kt`, `wall/LiveEngine.kt` |

**Load order.** `f1-wall.html` loads `pitwall-gate.js` and then `pitwall-intro.js` first,
each straight after its element at the top of the page, so the wall never shows before them. Then come the pure modules, then
the DOM modules, with `pitwall-app.js` last. `carto-basemap.js` is the only shared file the
page loads, and it is not changed.

### Data

| From | What |
|---|---|
| The timing API (Cloud Run, or `?api=`) | `/f1/live`, the `/f1/stream` SSE, `/f1/replay/sessions?year=`, `/f1/replay/timeline?session_key=`, `/f1/live?replay=&t=` |
| `assets/data/f1/` | `season-YYYY.json` (rounds, lap counts), the circuit files, `backdrops.json` |
| CARTO / OpenStreetMap | The map's street tiles |
| `livetiming.formula1.com` | Team radio clips (only that host is played) |
| Wikimedia Commons | The standby poster's photographs, loaded straight from Wikimedia |

`backdrops.json` is built by `tools/build-f1-backdrops.py`. It holds the app's 27 hand-picked,
freely licensed photographs at 1920 px wide, each with its credit, licence and Commons page. It
also has a vertical `focusY` for the tall pictures, which a wide screen crops to a band. To add
a venue, add it to `PICKS` (by OpenF1 circuit key) or `NAMED` (by the names its sessions
carry), then run the script. It fetches through curl and needs no installs.

### Being a good client of the API

The server allows three live streams in all (`STREAM_MAX`), and the app uses them too. So the
page holds one, and gives it back:

- **One per browser.** A Web Lock (`pitwall-stream`) means a second tab polls instead of
  streaming.
- **Out of sight.** After 60 s hidden, the page closes its stream and polls every 30 s. Back
  in sight, it polls at once and tries the stream again.
- **When the server is full.** A refused stream (503) means polling, and another try in 30 s.
- **Silence.** No frame for 20 s counts as a dead stream, and the page falls back to polling.

---

## What it does

- **Tower:** the running order, with every car visible without scrolling on a laptop.
  - Rows step in size with the window's height, and P1–P10 are taller.
  - When there isn't room, the sectors go first, then the last lap.
  - Rows glide when cars swap places.
  - Clicking a row opens that car's card; holding it or right-clicking follows the driver.
- **Map:**
  - turn numbers, lit for 30 s when race control names them;
  - flagged marshal sectors;
  - cars moving from the stream, several times a second;
  - wind, and zoom up to 6×;
  - Follow keeps a picked car in view.
- **Wall:**
  - each car on a ring of one lap, placed by its gap;
  - "If X pits now", showing where they'd rejoin and in what traffic;
  - pit loss under green, VSC and SC;
  - free stops, ghosts and the stint chart.
- **Feed:** race control in plain case, the conditions with a trend, and team radio. Followed
  drivers' clips play by themselves.
- **Alerts:** news worth interrupting for lights the ticker for 8–12 s (on a phone, a banner
  floats above the timeline). The voice says flag changes, after a tone, in a local en-GB
  voice.
- **The delay:** 0–60 s, set to match a broadcast. Everything waits by the same amount, and
  the setting is remembered.
- **Driver card:** gaps, laps, sectors, tyres and stints, plus live telemetry when the stream
  is up (speed, gear, throttle, brake and revs). Follow and Ghost buttons sit at its foot.
- **Standby poster:** between sessions, the next venue's photograph, with:
  - a countdown, amber in the last hour;
  - the weekend's sessions;
  - Replay a past session;
  - an `.ics` of the weekend, with an alert an hour before each session;
  - Reminders: a notification an hour before, while the page is open. Sessions to be reminded of are chosen in Settings.
- **The intro:** the wordmark and the five compounds rolling off. It plays once per tab, and
  not for replay or demo links, a background tab, or reduced motion. A click or any key skips
  it.

### Layouts

| Width | Layout |
|---|---|
| >1240 px | Designed for a 1440×900 laptop: tower on the right, capsule and ticker over the stage, dock below |
| ≤1240 px | Tower narrows and drops columns; the capsule loses the fastest lap |
| ≤900 px | The app's own layout: tabs Tower / Map / Wall / Feed along the foot, a floating banner, the driver card as a sheet from the foot, nothing scrolls but the views |
| ≤560 px | `/aurora`'s phone treatment: byline under the wordmark, panels across the screen, the ring and poster a size down |

On touch screens the chips and round buttons are 2.5rem. With reduced motion, nothing moves.

---

## Design rules

- **Tokens.** Every colour is a token in `:root` in `pitwall.css`, named for its role, and no
  rule below `:root` names a colour. Scripts read colours with `token('--x')` or
  `colour('--x')`, and those must be six-digit hex (canvas code parses only that).
- **A neutral accent.** No hue means "selected": a selected control is inverted (ink fill,
  ground text). So every colour on the page is data: the flag, team colours, timing purple
  and green, the tyres.
- **Type tiers.** Six sizes by how much a figure matters at a glance, from 34 px down to a
  13 px floor, all in Figtree with tabular figures. Text never shrinks to fit. Columns drop,
  or the badge's clock goes, but the flag's word always shows in full.
- **Contrast.** Every text colour clears 4.5:1 on the surfaces it sits on.

`tests/pitwall/lint.test.js` checks all of these, plus `noindex`, the absence of the shared
theme and nav, and the script order.

## Tests

```bash
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC tests/pitwall/parse-check.js    # every pitwall-*.js parses: "PARSE OK (23)"
$JSC tests/pitwall/run.js            # the suites: "ALL PASS (140)"
```

Read the last line rather than the exit status. Most cases are the app's own unit tests,
with its fixtures in `tests/pitwall/fixtures/` (see the README there). The live and replay
feeds run on a fake clock (`fake-time.js`). A new suite or module must be added to the lists
in `run.js` and `parse-check.js`, because `jsc` can't list a directory.

Bump the `?v=` on every asset in `f1-wall.html` when anything changes.

---

## History

The first `/f1-wall` came before Pocket Pitwall: a polling wall built on `/f1-lab`'s replay
(`f1-dash.js`, `f1-doom.js`, `f1-dash.css`), never committed until PR #16 recorded it. The
app began as a port of that wall and went well past it. This page then brought the app's
features back to the web, in ten phases (PRs #17–#27) plus the sign-in screen (#28).

It was built beside the old wall as `/f1-wall_2` and took its place in November 2026. At
that point:
- `f1-wall_2.html` became `f1-wall.html`, and this doc became `docs/f1-wall.md`;
- the old wall's own files went;
- `tools/serve-f1.sh` and `privacy.html` were updated.

`f1-lab.js` and `f1-map.js` stay, because `/f1-lab` and `/f1` use them. The old wall's list
of followed drivers (`f1-wall-radio` in local storage) is read once, the first time the
page opens.

Still worth doing:
- **Redeploy Cloud Run from `main`.** It picks up the stream-slot fix (#20).
- **Check during a real session:** live, with the stream, the delay, the voice, radio and the
  ring, on a laptop, an iPad and a phone.
- **Optionally, raise `STREAM_MAX` to 4–5,** in its own PR and with a redeploy.
- **If the page ever goes public:** remove the sign-in screen (`pitwall-gate.js`, its element
  and Sign out) and `noindex` (and the lint test's check for it). Then add the page to the
  nav, `sitemap.xml` and `llms.txt`.
