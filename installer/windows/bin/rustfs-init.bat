@echo off
REM installer/windows/bin/rustfs-init.bat — Bootstrap de RustFS (llama al .ps1).
REM Drop-in de garage-init.bat. Idempotente. Requiere node portable en {app}\node.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rustfs-init.ps1"
