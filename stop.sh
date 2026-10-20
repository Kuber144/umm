#!/bin/bash
# quits umm (SIGTERM stops the backend too), then kills leftovers
cd "$(dirname "$0")"
pkill -x umm
for i in 1 2 3 4 5 6; do pgrep -x umm > /dev/null || break; sleep 0.5; done
pkill -9 -x umm
pkill -f "uvicorn api:app --uds $HOME/Library/Application Support/umm/umm.sock"
echo "umm stopped"
