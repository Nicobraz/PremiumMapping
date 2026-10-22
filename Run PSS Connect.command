#!/bin/bash
cd "$(dirname "$0")"
PORT=8000
if ! python3 -c "import flask" 2>/dev/null; then
  echo "Installing Flask (one time)…"
  pip3 install -r requirements.txt || exit 1
fi
(sleep 1 && open "http://localhost:$PORT") &
PORT=$PORT python3 app.py
