@echo off
rem ============================================================
rem  Huge Number Poker - launcher
rem
rem  NOTE: Keep this file ASCII-only.
rem
rem  A .bat containing Japanese text in UTF-8 breaks together with
rem  `chcp 65001`. cmd.exe tracks its position in the file by byte
rem  offset, so once the code page changes it loses sync on
rem  multi-byte characters and starts executing from the MIDDLE of
rem  a line. Symptom: garbled text followed by
rem      '...' is not recognized as an internal or external command
rem
rem  All Japanese output lives in tools\start.js instead, where
rem  Node controls the encoding. Do not move it back here.
rem ============================================================

chcp 65001 >nul
title Huge Number Poker
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [ERROR] Node.js not found.
    echo.
    echo   Install it from https://nodejs.org/ and run this again.
    echo.
    pause
    exit /b 1
)

node tools\start.js

echo.
pause
