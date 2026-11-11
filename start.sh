#!/usr/bin/env sh
# Start Octopus: build the UI when it is stale, then serve everything on one URL (http://127.0.0.1:8000 by default).
set -e
cd "$(dirname "$0")"
if [ ! -x backend/.venv/bin/python ]; then
  echo "Backend is not installed. Run: make setup" >&2
  exit 1
fi
cd backend
exec .venv/bin/python -m app.cli start "$@"
