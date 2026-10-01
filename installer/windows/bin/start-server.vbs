' installer/windows/bin/start-server.vbs — Arranca POS Server SIN ventana.
' Uso: acceso en shell Startup (auto-arranque) y acceso "Iniciar (fondo)".
' La ruta se deriva del propio script (bin\.. = carpeta de programa):
' nunca hardcodear Program Files (x86 vs 64 bits rompe, error 80070002).
Dim shell, fso, appDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = appDir
shell.Run """" & appDir & "\node\node.exe"" """ & appDir & "\dist\server.js""", 0, False
