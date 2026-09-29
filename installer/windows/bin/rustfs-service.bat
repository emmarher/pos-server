@echo off
REM installer/windows/bin/rustfs-service.bat — RustFS nativo como tarea programada.
REM Uso: rustfs-service.bat [Install|Start|Stop|Uninstall]  (default Install)
REM Requiere administrador. Datos en %%ProgramData%%\POS Server\rustfs (se conservan).
setlocal
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=Install"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rustfs-service.ps1" -Action %ACTION%
