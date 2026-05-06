#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_DIR/../.." && pwd)"
SCREENSHOT_DIR="$REPO_ROOT/docs/screenshots/agent-livestream"

mkdir -p "$SCREENSHOT_DIR"

# Cleanup on exit
cleanup() {
  if [ -n "${DEV_PID:-}" ]; then
    kill "$DEV_PID" 2>/dev/null || true
  fi
  if [ -n "${EMIT_PID:-}" ]; then
    kill "$EMIT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Start Vite dev server
cd "$PROJECT_DIR"
npx vite --host 2>&1 &
DEV_PID=$!

# Wait for the dev server to be ready
PORT=""
for i in $(seq 1 30); do
  PORT=$(ss -tlnp 2>/dev/null | grep "$DEV_PID" | grep -oP ':\K[0-9]+' | head -1 || true)
  if [ -z "$PORT" ]; then
    # Try common Vite ports
    for p in 5173 5174 5175; do
      if curl -s -o /dev/null "http://localhost:$p" 2>/dev/null; then
        PORT=$p
        break
      fi
    done
  fi
  if [ -n "$PORT" ]; then
    break
  fi
  sleep 1
done

if [ -z "$PORT" ]; then
  echo "ERROR: Could not detect Vite dev server port"
  exit 1
fi

URL="http://localhost:$PORT"
echo "Dev server running at $URL"

# Let the app fully load
sleep 3

# Open the page in agent-browser
/usr/local/bin/agent-browser open "$URL"
sleep 3

# Start emitting test events in the background
cd "$PROJECT_DIR"
node scripts/emit-test-events.mjs &
EMIT_PID=$!

# Round 1: wait ~3 seconds from emit start
sleep 3
echo "Taking screenshot A (Round 1)..."
/usr/local/bin/agent-browser screenshot "$SCREENSHOT_DIR/cursor-A.png"

# Round 2: wait ~2 more seconds
sleep 2
echo "Taking screenshot B (Round 2)..."
/usr/local/bin/agent-browser screenshot "$SCREENSHOT_DIR/cursor-B.png"

# Round 3: wait ~2 more seconds
sleep 2
echo "Taking screenshot C (Round 3)..."
/usr/local/bin/agent-browser screenshot "$SCREENSHOT_DIR/cursor-C.png"

# Wait for emit script to finish
wait "$EMIT_PID" 2>/dev/null || true
EMIT_PID=""

echo "Screenshots saved to $SCREENSHOT_DIR"
