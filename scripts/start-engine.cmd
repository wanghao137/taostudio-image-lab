@echo off
REM TaoStudio Image Engine launcher wrapper for the Windows Task Scheduler.
REM
REM The scheduler runs this .cmd in a transient session; a child started with
REM "start /b" is tied to that session and is reaped when the task completes,
REM so the engine dies shortly after logon. Instead we use PowerShell
REM Start-Process, which spawns a detached, independent process that survives
REM the task session. -WindowStyle Hidden keeps it background; the Node
REM launcher itself sets windowsHide=true for the engine child too.
cd /d "D:\codesolo\taostudio-image-lab"
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'D:\codesolo\taostudio-image-lab\scripts\start-engine.mjs','--daemon' -WorkingDirectory 'D:\codesolo\taostudio-image-lab' -WindowStyle Hidden"
