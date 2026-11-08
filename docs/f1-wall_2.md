# /f1-wall_2 — Pitwall

A live Formula 1 timing wall: the flag, the running order, the track, the pit wall's view of
the race, race control, team radio and the weather. It is a web port of **Pocket Pitwall**,
the Android app that grew out of the first `/f1-wall`, styled in `/aurora`'s design language.

It is a **draft**, built beside the old wall. It is `noindex`, off the nav, and nothing else
on the site loads its files. The [swap checklist](#swapping-it-in) at the end covers
replacing `/f1-wall` with it.

The app (`~/Documents/code/f1_app`, private) is the reference implementation. Each
`pitwall-*.js` names the Kotlin file it ports. When behaviour is in doubt, the app is right.

---

## Running it

The page needs the timing API, `app.py` in the repo root. Locally, serve both:

```bash
tools/serve-f1.sh --no-open                     # the API on :8080 (and the site on :8000)
python3 -m http.server 8001 --bind 127.0.0.1    # or serve a worktree on its own port
```

Then open `http://localhost:8001/f1-wall_2.html?api=http://localhost:8080`.

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
  fixes the leak.

### The URL

| Parameter | What it does |
|---|---|
| `?api=http://localhost:8080` | Use a local API. Loopback addresses only; anything else is ignored. |
| `?session=11404&t=2026-11-01T20:45:00Z` | Open a replay at that moment. The page keeps this up to date as it plays, so the address is always a link to the moment on screen. |
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

**Load order.** `f1-wall_2.html` loads `pitwall-intro.js` first, straight after its element
at the top of the page, so the wall never shows before it. Then come the pure modules, then
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
$JSC tests/pitwall/parse-check.js    # every pitwall-*.js parses: "PARSE OK (22)"
$JSC tests/pitwall/run.js            # the suites: "ALL PASS (140)"
```

Read the last line rather than the exit status. Most cases are the app's own unit tests,
with its fixtures in `tests/pitwall/fixtures/` (see the README there). The live and replay
feeds run on a fake clock (`fake-time.js`). A new suite or module must be added to the lists
in `run.js` and `parse-check.js`, because `jsc` can't list a directory.

Bump the `?v=` on every asset in `f1-wall_2.html` when anything changes.

---

## Swapping it in

To replace the old `/f1-wall` with this page:

1. **Merge the stack in order.**
   - #16 commits the old wall and the API as they stood.
   - #17–#26 are this page, phases 1 to 10.
   - #20 fixes the stream-slot leak. Redeploy Cloud Run after it.
   - Optionally, raise `STREAM_MAX` to 4–5 for the app and a couple of browsers, in its own PR, with a redeploy.
2. **Check it during a real session:** live, with the stream, the delay, the voice and radio,
   and the Wall's ring. Check it on a laptop, an iPad and a phone.
3. **Rename the page.** `git mv f1-wall_2.html f1-wall.html`, replacing the old one. Then:
   - change the wordmark's link (`<a class="logo" href="f1-wall_2.html">`);
   - change the page path in `tests/pitwall/lint.test.js` (it reads `f1-wall_2.html`);
   - move this file to `docs/f1-wall.md`, replacing the old doc.
4. **Delete the old wall's own files:** `assets/js/f1-dash.js`, `assets/js/f1-doom.js` and
   `assets/css/f1-dash.css`.
   - **Keep `f1-lab.js` and `f1-map.js`.** `/f1-lab` and `/f1` use them.
   - **Keep the `f1-wall-radio` key.** The new page reads its followed drivers once, the first time it opens.
5. **Update `tools/serve-f1.sh`.** `--wall` (the default) should open the new page with
   `?api=`; the old `?live=1` mode is gone. Its usage comment should match.
6. **Update `privacy.html`'s list of other services.** Add:
   - Wikimedia Commons (the standby photographs);
   - Formula 1's live timing site (team radio clips);
   - the timing API on Google Cloud Run.

   Also say that settings stay in the browser (`pitwall.*` in local storage), and that
   reminders are notifications the browser shows itself, with nothing sent anywhere.
7. **Decide whether it goes public.** If so, remove `noindex` (and the lint test's check for
   it), add the page to the nav, `sitemap.xml` and `llms.txt`, and link it from `/f1`.
8. **Bump the cache-busters, and check the deployed page against the deployed API.**
