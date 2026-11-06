# Pitwall test fixtures

Copied unchanged from Pocket Pitwall (`f1_app/app/src/test/resources/`, commit `f399442`), so the web wall's tests run on the same captured data as the app's.

| File | What it is |
|---|---|
| `frame-race-green.json`, `-sc.json`, `-yellow.json`, `-chequered.json` | `/f1/live` frames from the 2026 Singapore Grand Prix (session 11388) under each flag |
| `frame-quali.json` | A qualifying frame: best laps, no gaps or strategy |
| `live-idle.json` | `/f1/live` with no session running |
| `timeline-11388.json` | `/f1/replay/timeline` for the Singapore race |
| `sessions-2026.json`, `sessions-meetings.json` | `/f1/replay/sessions`, without and with meeting names |
| `sepang-cars.json`, `sakhir-cars.json`, `jeddah-cars.json` | Car positions from the stream, for the map's tests |

`f1-wall_2.html?demo=green|sc|yellow|chequered|quali|idle` draws the frames from here too.
