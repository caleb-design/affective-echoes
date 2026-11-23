#!/bin/bash
# Double-click to start. Keep this window open during the session; close it to stop.
cd "$(dirname "$0")"
echo "Starting Affective Echoes... Chrome will open in a moment."
python3 server.py || { echo; echo "Something went wrong. Check that Python 3 is installed: https://www.python.org"; read -n 1 -s -r -p "Press any key to close."; }
