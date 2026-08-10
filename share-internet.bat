@echo off
rem ============================================================
rem  Huge Number Poker - publish to the internet (Cloudflare Tunnel)
rem
rem  Thin wrapper so share-internet.ps1 can be double-clicked.
rem
rem  NOTE: Keep this file ASCII-only. A .bat with Japanese text in
rem  UTF-8 loses sync with `chcp 65001` and cmd.exe starts running
rem  lines from the middle. See tools\start.js for the details.
rem ============================================================

chcp 65001 >nul
title Huge Number Poker - share
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0share-internet.ps1"

echo.
pause
