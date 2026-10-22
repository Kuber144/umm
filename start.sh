#!/bin/bash
# builds what is missing and opens umm.app, ./stop.sh quits it
cd "$(dirname "$0")"
app/build.sh && open build/umm.app || exit 1
echo "umm running, hotkey Option+Space, ./stop.sh to quit"
echo "agents: claude mcp add umm -s user -- uv run --project \"$PWD/backend\" \"$PWD/backend/mcp_server.py\""
echo "cli:    uv tool install --editable \"$PWD/cli\""
