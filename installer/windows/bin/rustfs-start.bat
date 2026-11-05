@echo off
REM installer/windows/bin/rustfs-start.bat - Asegura RustFS antes de arrancar el POS.
REM Arranca la tarea POSRustFS y, si la tarea no existe, la reinstala sola
REM (requiere admin; sin admin y con :3900 arriba termina sin error).
REM Salida a %ProgramData%\POS Server\logs\rustfs-start.log (no bloquea la ventana).
setlocal
set "LOG_DIR=%ProgramData%\POS Server\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
echo [%date% %time%] preflight RustFS >> "%LOG_DIR%\rustfs-start.log"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rustfs-service.ps1" -Action Start >> "%LOG_DIR%\rustfs-start.log" 2>&1
exit /b %ERRORLEVEL%
