@echo off
REM installer/windows/bin/rustfs-init.bat - Bootstrap de RustFS (llama al .ps1).
REM Idempotente: instala/arranca la tarea POSRustFS o levanta Docker en dev.
REM Se auto-eleva (UAC): desde el menu Inicio debe funcionar con doble clic.
REM Deja log en %ProgramData%\POS Server\logs porque el instalador lo ejecuta
REM sin poder leer su codigo de salida.
setlocal

net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando permisos de administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { Write-Host '[ERROR] Permisos de administrador rechazados.'; Start-Sleep -Seconds 3 }"
  exit /b 0
)

set "LOG_DIR=%ProgramData%\POS Server\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\rustfs-init.log"

echo [%date% %time%] rustfs-init >> "%LOG_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rustfs-init.ps1" >> "%LOG_FILE%" 2>&1
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [ERROR] RustFS no quedo configurado ^(codigo %CODE%^).
  echo   Log: "%LOG_FILE%"
  echo   Detalle: "%LOG_DIR%\rustfs-install.log"
  echo   Solucion: revisa ese log o reinstala POS Server.
  echo   El POS funciona igual; solo las fotos de productos quedan desactivadas.
  timeout /t 10 >nul
)

exit /b %CODE%
