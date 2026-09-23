@echo off
REM installer/windows/bin/backup.bat — Respalda pos.sqlite (+WAL/SHM) a backups\pos-AAAAMMDD_HHMMSS.db
setlocal enabledelayedexpansion
set "DATA_DIR=%ProgramData%\POS Server"
set "STAMP=%date:~6,4%%date:~3,2%%date:~0,2%_%time:~0,2%%time:~3,2%%time:~6,2%"
set "STAMP=!STAMP: =0!"
set "DEST=%DATA_DIR%\backups\pos-!STAMP!.db"
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups"
echo Respaldando a !DEST! ...
copy /Y "%DATA_DIR%\data\pos.sqlite" "!DEST!" >nul
if exist "%DATA_DIR%\data\pos.sqlite-wal" copy /Y "%DATA_DIR%\data\pos.sqlite-wal" "!DEST!-wal" >nul
if exist "%DATA_DIR%\data\pos.sqlite-shm" copy /Y "%DATA_DIR%\data\pos.sqlite-shm" "!DEST!-shm" >nul
echo Respaldo listo.
