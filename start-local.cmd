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

powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='http://127.0.0.1:9527/'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2; if ($r.Content -match 'TaoStudio') { exit 0 } } catch {} exit 1"
if not errorlevel 1 (
  echo Local server is already running.
  start "" "http://127.0.0.1:9527/"
  exit /b 0
)

start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$u='http://127.0.0.1:9527/'; for ($i=0; $i -lt 120; $i++) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 1; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500 -and $r.Content -match 'TaoStudio') { Start-Process $u; exit 0 } } catch {} Start-Sleep -Milliseconds 500 }"
call npm run start:local
