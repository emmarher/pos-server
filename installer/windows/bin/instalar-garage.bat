@echo off
REM installer/windows/bin/instalar-garage.bat — LEGACY wrapper (Garage -> RustFS).
REM Redirige a instalar-rustfs.bat.
REM Log: %ProgramData%\POS Server\garage\install-garage.log
net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Clic derecho sobre este archivo -^> "Ejecutar como administrador".
  pause
  exit /b 10
)
if exist "%~dp0instalar-rustfs.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-rustfs.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-garage.ps1"
)
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="20" (
  echo El equipo se reiniciara. Al volver a entrar, el asistente continua solo.
  pause
  exit /b 20
)
if not "%CODE%"=="0" (
  echo [ERROR] Codigo %CODE% (1=chequeos 2=wsl 3=docker 4=rustfs; ver install-rustfs.log).
  pause
  exit /b %CODE%
)
echo.
echo Instalacion completa. Pulsa una tecla para cerrar.
pause >nul
