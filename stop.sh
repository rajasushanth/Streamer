#!/usr/bin/env bash
#
# stop.sh — stop the Mac → TV Streamer (and its caffeinate keep-awake).
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PIDS="$(pgrep -f "node .*${DIR}/server.js" || true)"
if [ -z "$PIDS" ]; then
  echo "No running instance found."
  rm -f "$DIR/streamer.pid"
  exit 0
fi

echo "Stopping server (PID: $PIDS)…"
kill $PIDS 2>/dev/null || true     # SIGTERM → server.js kills its caffeinate child
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f "node .*${DIR}/server.js" >/dev/null 2>&1 || break
  sleep 0.3
done
PIDS="$(pgrep -f "node .*${DIR}/server.js" || true)"
[ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true

rm -f "$DIR/streamer.pid"
echo "✓ Stopped."
