@echo off
REM installer/windows/bin/rustfs-service.bat - RustFS nativo como tarea POSRustFS.
REM Uso: rustfs-service.bat [Install|Start|Stop|Restart|Status|Uninstall]  (default Install)
REM Se auto-eleva (UAC): la tarea corre como SYSTEM y crearla exige admin.
REM Datos en %%ProgramData%%\POSRustFS (sin espacios: RustFS 1.0.0 no admite
REM espacios en la ruta del volumen). Los datos antiguos se migran solos.
setlocal
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=Install"

net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando permisos de administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '%ACTION%' -Verb RunAs -ErrorAction Stop } catch { Write-Host '[ERROR] Permisos de administrador rechazados.'; Start-Sleep -Seconds 3 }"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rustfs-service.ps1" -Action %ACTION%
set "CODE=%ERRORLEVEL%"
if /i "%ACTION%"=="Status" pause
if not "%CODE%"=="0" pause
exit /b %CODE%
