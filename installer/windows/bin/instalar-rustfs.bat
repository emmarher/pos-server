@echo off
REM installer/windows/bin/instalar-rustfs.bat — Instala Docker + RustFS con doble clic.
REM Requiere: Windows 10/11 x64, cuenta de administrador, internet (~600MB descarga).
REM El asistente muestra el paso actual; ante reinicios CONTINÚA SOLO al volver a entrar.
REM Log: %ProgramData%\POS Server\rustfs\install-rustfs.log
net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Clic derecho sobre este archivo -^> "Ejecutar como administrador".
  pause
  exit /b 10
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-rustfs.ps1"
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
