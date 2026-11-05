@echo off
rem LAN battle one-click launcher (content kept ASCII to avoid codepage issues)
rem Double-click me, or run from a terminal. Requires Python in PATH.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found in PATH. Install Python or run: python start_lan.py
  pause
  exit /b 1
)
python start_lan.py
pause
