@echo off
setlocal
cd /d "%~dp0"

if not exist "package.json" (
  echo package.json was not found.
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

if not exist "dev-proxy.config.json" (
  if exist "dev-proxy.config.example.json" (
    copy "dev-proxy.config.example.json" "dev-proxy.config.json" >nul
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } exit 1"
if not errorlevel 1 (
  echo Local server is already running.
  start "" "http://127.0.0.1:5173/"
  exit /b 0
)

start "" "http://127.0.0.1:5173/"
call npm run start:local
