@echo off
REM installer/windows/bin/diagnostico.bat — Diagnóstico del servidor POS.
REM Revisa archivos, proceso, puerto, /health, UDP discovery y muestra la cola
REM del log. Solo lectura (no cambia nada). Salida: nº de fallos (0 = sano).
REM Pega la salida completa al reportar un problema.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnostico.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo Servidor sano.
) else (
  echo Se detectaron %CODE% problema^(s^). Revisa los [FAIL] de arriba.
)
pause
