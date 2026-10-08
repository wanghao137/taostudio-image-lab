' TaoStudio Image Engine scheduler launcher (windowless).
' Task Scheduler runs this via wscript.exe (GUI subsystem -> never creates a console window).
' Start node daemon detached with window style 0 (hidden); return immediately.
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""D:\codesolo\taostudio-image-lab\scripts\start-engine.mjs"" --daemon", 0, False
