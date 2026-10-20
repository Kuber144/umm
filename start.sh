#!/bin/bash
# starts the backend and the hotkey menu in the background, ./stop.sh kills both
cd "$(dirname "$0")"
mkdir -p data
[ menu/umm-menu -nt menu/umm-menu.swift ] || swiftc -O menu/umm-menu.swift -o menu/umm-menu
[ -d ui/dist ] || (cd ui && npm install && npm run build)
pgrep -x umm-menu > /dev/null || { nohup menu/umm-menu >> data/umm.log 2>&1 & }
pgrep -f "uvicorn api:app" > /dev/null || (cd backend; nohup uv run uvicorn api:app --port 8000 --no-access-log >> ../data/umm.log 2>&1 &)
echo "umm running. UI at http://localhost:8000, hotkey Ctrl+Shift+Space, ./stop.sh to kill"
