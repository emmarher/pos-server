@echo off
REM installer/windows/bin/stop-server.bat — Detiene POS Server (ventana o fondo).
REM Delega en stop-server.ps1 (fiable: ubica el proceso por el puerto/PID, no por
REM titulo de ventana, que no existe cuando el server corre oculto via .vbs).
REM La ruta se deriva del propio script (%~dp0.. = programa).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1"
