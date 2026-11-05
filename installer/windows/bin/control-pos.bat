@echo off
REM installer/windows/bin/control-pos.bat - Arranca/detiene/reinicia POS + RustFS.
REM Uso: control-pos.bat [start^|stop^|restart^|status]  (default: status)
REM Se auto-eleva: la tarea POSRustFS corre como SYSTEM y sin admin
REM Get-ScheduledTask devuelve "missing" (estado falso) y Start/Stop fallan.
setlocal
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"

net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando permisos de administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '%ACTION%' -Verb RunAs -ErrorAction Stop } catch { Write-Host '[ERROR] Permisos de administrador rechazados.'; Start-Sleep -Seconds 3 }"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0control-pos.ps1" -Action %ACTION%
set "CODE=%ERRORLEVEL%"
REM status sale con 0 y la ventana se cerraba antes de poder leerla.
if /i "%ACTION%"=="status" pause
if not "%CODE%"=="0" pause
exit /b %CODE%
