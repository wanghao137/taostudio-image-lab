@echo off
chcp 65001 >nul

echo Stopping TaoStudio Image Engine...
powershell -NoProfile -Command "$stopped=0; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*start-engine*' -or $_.CommandLine -like '*task-api*cli.mjs*' } | ForEach-Object { Write-Host ('Stopping PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force; $stopped++ }; if($stopped -eq 0){Write-Host 'No running engine process found'}"
echo.
pause
