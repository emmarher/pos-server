@echo off
REM installer/windows/bin/start-server.bat — Arranca POS Server en ventana visible.
REM Uso: doble clic o acceso "Iniciar POS Server". Ctrl+C para detener.
REM El log también queda en %ProgramData%\POS Server\logs\server-AAAAMMDD.log
setlocal
set "APP_DIR=%~dp0.."
set "LOG_DIR=%ProgramData%\POS Server\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
REM Fecha robusta e independiente del formato local (%date% varia por region y
REM rompia el nombre del log -> "path not found").
set "TODAY="
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "TODAY=%%i"
if not defined TODAY set "TODAY=00000000"
set "LOG_FILE=%LOG_DIR%\server-%TODAY%.log"
set "DATA_DIR=%ProgramData%\POS Server\data"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
cd /d "%APP_DIR%"
echo [%date% %time%] arranque manual >> "%LOG_FILE%"
"%APP_DIR%\node\node.exe" "%APP_DIR%\dist\server.js" >> "%LOG_FILE%" 2>&1
