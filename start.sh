#!/usr/bin/env bash
#
# start.sh — start the Mac → TV Streamer (server + open the control UI).
# If an instance is already running, it is stopped and restarted.
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8090}"
mkdir -p "$DIR/logs"
LOG="$DIR/logs/console.log"          # stdout/stderr + crash stacks
APPLOG="$DIR/logs/streamer.log"      # structured app log (written by server.js)
URL="http://localhost:${PORT}/"

cd "$DIR"

# --- stop any running instance ------------------------------------------
# Match this project's server.js specifically (don't touch other node procs).
PIDS="$(pgrep -f "node .*${DIR}/server.js" || true)"
if [ -n "$PIDS" ]; then
  echo "↻ Found running instance (PID: $PIDS) — stopping it…"
  # SIGTERM lets server.js run its handler and kill its caffeinate child.
  kill $PIDS 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "node .*${DIR}/server.js" >/dev/null 2>&1 || break
    sleep 0.3
  done
  # Force-kill if still alive.
  PIDS="$(pgrep -f "node .*${DIR}/server.js" || true)"
  [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
fi

# Free the port in case something else (e.g. an old prototype) holds it.
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "⚠ Port ${PORT} still in use — freeing it…"
  lsof -ti tcp:"$PORT" | xargs kill -9 2>/dev/null || true
fi

# --- ensure dependencies ------------------------------------------------
if [ ! -d "$DIR/node_modules" ]; then
  echo "📦 Installing dependencies…"
  npm install
fi

# --- start the server ---------------------------------------------------
echo "▶ Starting server on port ${PORT}…"
PORT="$PORT" nohup node "$DIR/server.js" > "$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$DIR/streamer.pid"

# --- wait until it answers ----------------------------------------------
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "${URL}api/info"; then
    break
  fi
  # Bail early if the process died on startup.
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ Server failed to start. Last log lines:"
    tail -n 20 "$LOG"
    exit 1
  fi
  sleep 0.3
done

if ! curl -sf -o /dev/null "${URL}api/info"; then
  echo "✗ Server did not respond in time. Last log lines:"
  tail -n 20 "$LOG"
  exit 1
fi

# --- open the control UI ------------------------------------------------
echo "✓ Running (PID $SERVER_PID)."
echo "  Console log: $LOG"
echo "  App log:     $APPLOG   (tail -f to watch streaming requests)"
grep -E "On your LAN|Control page" "$LOG" || true
echo "🌐 Opening control page: $URL"
open "$URL"

echo
echo "To stop:  ./stop.sh    (watch:  tail -f \"$APPLOG\")"
