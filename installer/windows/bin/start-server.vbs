' installer/windows/bin/start-server.vbs — Arranca POS Server SIN ventana.
' Uso: acceso en shell Startup (auto-arranque) y acceso "Iniciar (fondo)".
' La ruta se deriva del propio script (bin\.. = carpeta de programa):
' nunca hardcodear Program Files (x86 vs 64 bits rompe, error 80070002).
' La salida va a %ProgramData%\POS Server\logs\server-AAAAMMDD.log
' (sin log, un crash de arranque es invisible: esa fue la causa del HTTP 000).
Dim shell, fso, appDir, logDir, logFile, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logDir = shell.ExpandEnvironmentStrings("%ProgramData%") & "\POS Server\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logFile = logDir & "\server-" & Year(Date) & Right("0" & Month(Date), 2) & Right("0" & Day(Date), 2) & ".log"
cmd = "cmd /c """"" & appDir & "\node\node.exe"" """ & appDir & "\dist\server.js"" >> """ & logFile & """ 2>&1"""
shell.CurrentDirectory = appDir
shell.Run cmd, 0, False
