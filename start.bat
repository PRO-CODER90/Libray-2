@echo off
REM === Poornima University Library Entry System ===
REM Requires Node.js 22.13 or newer (https://nodejs.org)
cd /d "%~dp0"

REM === Step 1: Install dependencies on first run ===
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev
)

REM === Step 2: Start the server ===
echo Starting library server...
start "Library Server" cmd /k "node --disable-warning=ExperimentalWarning server.js"

REM === Step 3: Wait 3 seconds ===
timeout /t 3 >nul

REM === Step 4: Open the home screen in the default browser ===
start "" "http://localhost:5000"
