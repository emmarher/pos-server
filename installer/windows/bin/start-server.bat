@echo off
REM installer/windows/bin/start-server.bat — Arranca POS Server en ventana visible.
REM Uso: doble clic o acceso "Iniciar POS Server". Ctrl+C para detener.
setlocal
set "APP_DIR=%~dp0.."
set "DATA_DIR=%ProgramData%\POS Server\data"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
cd /d "%APP_DIR%"
"%APP_DIR%\node\node.exe" "%APP_DIR%\dist\server.js"
