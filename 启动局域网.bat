@echo off
rem LAN battle one-click launcher (content kept ASCII to avoid codepage issues)
rem Double-click me, or run from a terminal. Requires Python AND Node.js in PATH.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found in PATH. Install Python or run: python start_lan.py
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. The game rules engine needs it.
  echo         Python alone is NOT enough: each room runs the engine in Node.
  echo         Install Node.js LTS from https://nodejs.org then double-click again.
  pause
  exit /b 1
)
python start_lan.py
pause
