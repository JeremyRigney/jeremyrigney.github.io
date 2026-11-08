#!/usr/bin/env bash
#
# Run /f1-wall (and /f1-lab) locally.
#
# Two servers are needed, for two different reasons:
#
#   :8080  the Flask API — f1_live.py, which composes the timing payload. The pages talk
#          to the deployed Cloud Run service by default, so this is only reached because
#          the page is opened with ?api=http://localhost:8080. That override is
#          loopback-only by design (see pitwall-net.js and f1-lab.js), which is why the
#          port matters.
#
#   :8000  a plain static server for the site itself. Opening the page from disk does not
#          work — file:// blocks the fetches the map and the season index need, and
#          f1-map.js will tell you so on the canvas.
#
# Ctrl-C stops both. For a live session when there isn't one, the API can replay a past
# one as if it were live (see docs/f1-wall.md):
#
#   F1_STREAM_SIMULATE=11731@2026-10-04T09:10:00Z tools/serve-f1.sh
#
# Usage:  tools/serve-f1.sh [--wall|--lab] [--no-open]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# OpenF1 credentials, if there are any.
#
# Without them /f1/live cannot run at all, and — less obviously — OpenF1 locks its *whole*
# API, historical data included, to authenticated users for as long as a session is on
# track, so the replay side stops working too. Kept in a gitignored file rather than in the
# shell so they survive a restart without being retyped or landing in shell history.
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

API_PORT=8080
WEB_PORT=8000
PAGE="f1-wall.html"
OPEN_BROWSER=1

while [ $# -gt 0 ]; do
  case "$1" in
    --wall)     PAGE="f1-wall.html" ;;
    --lab)      PAGE="f1-lab.html" ;;
    --no-open)  OPEN_BROWSER=0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -x .venv/bin/python ]; then
  echo "No .venv here. Create it once with:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# A port left occupied by an earlier run is the usual reason this appears to start and then
# serve nothing, so say so plainly rather than letting Flask fail into the log.
for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop whatever is on it, or:" >&2
    echo "  lsof -nP -iTCP:$port -sTCP:LISTEN" >&2
    exit 1
  fi
done

API_PID=""
WEB_PID=""
cleanup() {
  trap - INT TERM EXIT
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo ""
  echo "Stopped."
}
trap cleanup INT TERM EXIT

PORT="$API_PORT" .venv/bin/python app.py > /tmp/f1-api.log 2>&1 &
API_PID=$!

.venv/bin/python -m http.server "$WEB_PORT" --bind 127.0.0.1 > /tmp/f1-web.log 2>&1 &
WEB_PID=$!

URL="http://localhost:$WEB_PORT/$PAGE?api=http://localhost:$API_PORT"

# Wait for the API to answer rather than guessing at a sleep — the first request also warms
# the session list, so the page is not left staring at "Loading…".
printf "Starting"
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$API_PORT/f1/replay/sessions?year=2025" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo ""
    echo "The API exited on startup. Last lines of /tmp/f1-api.log:" >&2
    tail -20 /tmp/f1-api.log >&2
    exit 1
  fi
  printf "."
  sleep 0.5
done
echo ""

if [ "$PAGE" = "f1-wall.html" ]; then
  NOTE="  Live by default. To replay, open the badge's + and pick a session; the first frame of
  a session takes a few seconds while the server pulls that race from OpenF1 and caches
  it. ?demo=green|sc|yellow|chequered|quali|idle draws a captured frame instead."
else
  NOTE="  Pick a season and session from the toolbar. The first frame of a session takes a few
  seconds — the server pulls that race from OpenF1 and caches it, after which scrubbing
  costs no network at all. Play is disabled until that first frame lands."
fi

cat <<EOF

  ${PAGE%.html}   $URL

  api    http://localhost:$API_PORT   (log: /tmp/f1-api.log)
  static http://localhost:$WEB_PORT   (log: /tmp/f1-web.log)

$NOTE

  Ctrl-C to stop both.

EOF

if [ "$OPEN_BROWSER" = "1" ]; then
  open "$URL" 2>/dev/null || true
fi

wait
