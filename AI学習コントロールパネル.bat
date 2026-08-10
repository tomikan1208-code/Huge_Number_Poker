@echo off
rem ============================================================
rem  Huge Number Poker - AI training control panel (console)
rem
rem  NOTE: Keep this file ASCII-only.
rem
rem  A .bat that contains Japanese text in UTF-8 breaks when
rem  combined with `chcp 65001`. cmd.exe tracks its position in
rem  the file by byte offset, and once the code page changes it
rem  loses sync on multi-byte characters and starts executing
rem  from the MIDDLE of a line. The symptom is garbled text
rem  followed by:
rem
rem      '...' is not recognized as an internal or external
rem      command, operable program or batch file.
rem
rem  So all Japanese messages live in train\launcher.py instead,
rem  where Python controls the encoding properly.
rem ============================================================

chcp 65001 >nul
cd /d "%~dp0"

set PY=
where python >nul 2>&1 && set PY=python
if "%PY%"=="" (
    where py >nul 2>&1 && set PY=py
)

if "%PY%"=="" (
    echo.
    echo   [ERROR] Python not found.
    echo.
    echo   Install it from https://python.org and make sure
    echo   "Add Python to PATH" is checked in the installer.
    echo.
    pause
    exit /b 1
)

%PY% train\launcher.py --console

echo.
pause
