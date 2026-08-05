@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0\.."

echo.
echo [1/3] Registering logon auto-start scheduled task...
schtasks /create /tn "TaoStudioImageEngine" /tr "%~dp0start-engine.cmd" /sc onlogon /rl limited /f
if errorlevel 1 (
  echo.
  echo *** FAILED: right-click this file and choose "Run as administrator". ***
  pause
  exit /b 1
)

echo.
echo [2/3] Starting the engine now...
call "%~dp0start-engine.cmd"

echo.
echo [3/3] Waiting for engine to be ready...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 15;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9789/v1/capabilities' -Headers @{Authorization='Bearer 123456'} -TimeoutSec 2; if($r.StatusCode -eq 200){$ok=$true;break} } catch {}; Start-Sleep -Milliseconds 500 }; if($ok){Write-Host 'Engine ready: http://127.0.0.1:9789 (HTTP 200)'} else {Write-Host 'Engine not ready in time, check .local-task-api\engine.log'}"

echo.
echo Done. The engine will auto-start at every Windows logon.
echo Task Scheduler name: TaoStudioImageEngine
echo Log: D:\codesolo\taostudio-image-lab\.local-task-api\engine.log
echo Stop:  double-click scripts\stop-engine.cmd
echo Uninstall: right-click scripts\uninstall-engine-autostart.cmd as admin
echo.
pause
