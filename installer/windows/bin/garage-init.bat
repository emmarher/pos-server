@echo off
REM installer/windows/bin/garage-init.bat — Bootstrap de Garage (llama al .ps1).
REM Idempotente: seguro re-ejecutar. Requiere Docker Desktop corriendo.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0garage-init.ps1"
