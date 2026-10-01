#!/usr/bin/env sh
# Start Octopus in Docker, plus the laptop-side folder picker so "Open project folder" shows your OS's own dialog.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python || true)
if [ -n "$PY" ]; then
  "$PY" scripts/folder_bridge.py &
  BRIDGE=$!
  trap 'kill $BRIDGE 2>/dev/null' EXIT INT TERM
else
  echo "Python not found: the in-app folder browser will be used instead of your system's folder dialog."
fi
echo "Octopus → http://localhost:8080"
docker compose up --build
