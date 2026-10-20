#!/bin/bash
# kill switch: stops the backend and the hotkey menu
pkill -f "uvicorn api:app"
pkill -x umm-menu
echo "umm stopped"
