@echo off
REM installer/windows/bin/stop-server.bat — Detiene POS Server (ventana y fondo).
REM Cierra node.exe lanzados desde la carpeta de instalación.
setlocal
set "APP_DIR=%ProgramFiles%\POS Server"
echo Deteniendo POS Server...
taskkill /FI "WINDOWTITLE eq POS Server*" /F >nul 2>&1
wmic process where "ExecutablePath like '%POS Server%node\\node.exe%'" delete >nul 2>&1
echo Listo. Verifica: curl http://127.0.0.1:3000/health (debe fallar si se detuvo)
