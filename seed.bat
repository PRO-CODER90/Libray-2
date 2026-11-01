@echo off
REM === Load members into the library database ===
REM Drag an .xlsx or .csv file (e.g. daily_logs_2026-08-19.xlsx) onto this file,
REM or run:  seed.bat members.xlsx [--demo-logs YYYY-MM-DD] [--reset]
cd /d "%~dp0"

if "%~1"=="" (
  echo Drag an .xlsx or .csv member file onto seed.bat to import it.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev
)

node --disable-warning=ExperimentalWarning scripts\seed.js %*
pause
