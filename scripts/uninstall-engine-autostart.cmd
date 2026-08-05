@echo off
chcp 65001 >nul
setlocal

echo.
echo [1/2] Removing logon auto-start scheduled task...
schtasks /delete /tn "TaoStudioImageEngine" /f
if errorlevel 1 (
  echo Task not found or removal failed ^(can ignore if never installed^).
)

echo.
echo [2/2] Stopping any running engine process...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*start-engine*' -or $_.CommandLine -like '*task-api*cli.mjs*' } | ForEach-Object { Write-Host ('Stopping PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"

echo.
echo Done. Engine stopped, auto-start removed.
echo.
pause
