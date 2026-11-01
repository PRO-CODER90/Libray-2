@echo off
REM === Copy the online (Turso) database into the local SQLite file ===
REM Run once when moving from the Vercel test setup to the offline start.bat setup.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev
)

if "%TURSO_DATABASE_URL%"=="" set /p TURSO_DATABASE_URL=Turso database URL (libsql://...): 
if "%TURSO_AUTH_TOKEN%"=="" set /p TURSO_AUTH_TOKEN=Turso auth token: 

node --disable-warning=ExperimentalWarning scripts\pull-db.js %*
pause
