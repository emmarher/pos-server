@echo off
REM installer/windows/bin/healthcheck.bat — Verifica que la API responde.
setlocal
set "PORT=3000"
if not "%~1"=="" set "PORT=%~1"
curl -s -o nul -w "HTTP %%{http_code}\n" http://127.0.0.1:%PORT%/health
curl -s http://127.0.0.1:%PORT%/health
echo.
