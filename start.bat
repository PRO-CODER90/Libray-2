@echo off
setlocal
title Poornima University Library
cd /d "%~dp0"

REM ================================================================
REM  Poornima University Library Entry System
REM
REM  Double-click             start the system and open the browser
REM  Drop .xlsx/.csv on it    import members into the database
REM  start.bat pull           copy the online Turso database into
REM                           the local SQLite file (data\library.db)
REM ================================================================

set "PORT=5000"
set "URL=http://localhost:%PORT%"
set "NODE_RUN=node --disable-warning=ExperimentalWarning"

REM --- Check Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install Node.js 22 LTS or newer from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Update it from https://nodejs.org
  pause
  exit /b 1
)

REM --- Install dependencies on first run ---
if not exist "node_modules\" (
  echo Installing dependencies, first run only...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Installing dependencies failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

if /i "%~1"=="pull" goto pull
if not "%~1"=="" goto import

REM --- Start the server and open the browser ---
call :is_up
if not errorlevel 1 (
  echo The library system is already running.
  start "" "%URL%"
  exit /b 0
)

echo Starting library server...
start "Library Server" cmd /k "%NODE_RUN% server.js"

set /a tries=0
:wait
timeout /t 1 /nobreak >nul
call :is_up
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% lss 30 goto wait
echo The server did not start. Check the "Library Server" window for errors.
pause
exit /b 1

:ready
start "" "%URL%"
echo.
echo Library system is running at %URL%
echo Admin panel: %URL%/admin.html
echo To stop it, close the "Library Server" window.
timeout /t 5 >nul
exit /b 0

REM --- Import members from a dropped file ---
:import
echo Importing members from "%~nx1"...
%NODE_RUN% scripts\seed.js %*
pause
exit /b

REM --- Copy the online database to local SQLite ---
:pull
if "%TURSO_DATABASE_URL%"=="" set /p "TURSO_DATABASE_URL=Turso database URL (libsql://...): "
if "%TURSO_AUTH_TOKEN%"=="" set /p "TURSO_AUTH_TOKEN=Turso auth token: "
%NODE_RUN% scripts\pull-db.js %2
set "TURSO_DATABASE_URL="
set "TURSO_AUTH_TOKEN="
pause
exit /b

REM --- Exit code 0 when the server answers ---
:is_up
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%URL%/api/status'; exit 0 } catch { exit 1 }" >nul 2>nul
exit /b %errorlevel%
