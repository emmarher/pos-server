@echo off
REM installer/windows/bin/garage-init.bat — LEGACY wrapper (Garage -> RustFS).
REM Redirige a rustfs-init.bat para compatibilidad. Idempotente.
setlocal
if exist "%~dp0rustfs-init.bat" (
  call "%~dp0rustfs-init.bat"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0garage-init.ps1"
)
