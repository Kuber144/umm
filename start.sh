#!/bin/bash
# builds what is missing and opens umm.app, ./stop.sh quits it
cd "$(dirname "$0")"
app/build.sh && open build/umm.app
echo "umm running, hotkey Ctrl+Shift+Space, ./stop.sh to quit"
