@echo off
:: 巨大数ポーカーをインターネットに公開する（遠くの友達と対戦する用）
:: 実体は share-internet.ps1。ダブルクリックで実行できるようにするためのラッパー。
chcp 65001 >nul
title 巨大数ポーカー インターネット公開
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0share-internet.ps1"
pause
