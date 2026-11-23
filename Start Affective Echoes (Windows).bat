@echo off
title Affective Echoes
cd /d "%~dp0"
echo Starting Affective Echoes... your browser will open in a moment.
echo The built-in AI model takes up to a minute to load the first time.
echo Keep this window open during the session. Close it to stop.
echo.
if exist "runtime\python\python.exe" (
  "runtime\python\python.exe" server.py
) else (
  where py >nul 2>nul && (py server.py) || (python server.py)
)
if errorlevel 1 (
  echo.
  echo Something went wrong. See the messages above, or logs\llama-server.log.
  pause
)
