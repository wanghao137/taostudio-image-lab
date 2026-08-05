@echo off
REM TaoStudio Image Engine launcher wrapper for the Windows Task Scheduler.
REM The scheduler cannot reliably pass quoted arguments with spaces, so this
REM thin wrapper exists to invoke the Node supervisor with the right working
REM directory. Driven by the "TaoStudio Image Engine" scheduled task (logon).
REM Runs hidden because windowsHide=true is set inside the Node launcher.
cd /d "D:\codesolo\taostudio-image-lab"
start "" /b "C:\Program Files\nodejs\node.exe" "D:\codesolo\taostudio-image-lab\scripts\start-engine.mjs" --daemon
