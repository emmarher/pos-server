' installer/windows/bin/start-server.vbs — Arranca POS Server SIN ventana.
' Uso: acceso en shell Startup (auto-arranque) y acceso "Iniciar (fondo)".
Dim shell, appDir
Set shell = CreateObject("WScript.Shell")
appDir = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\POS Server"
shell.CurrentDirectory = appDir
shell.Run """" & appDir & "\node\node.exe"" """ & appDir & "\dist\server.js""", 0, False
