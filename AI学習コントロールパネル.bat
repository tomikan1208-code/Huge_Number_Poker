@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title 巨大数ポーカー AI 学習コントロールパネル
cd /d "%~dp0"

echo ========================================================
echo   巨大数ポーカー AI 学習コントロールパネル
echo ========================================================
echo.
echo   普段は「AI学習コントロールパネル.vbs」を使ってください。
echo   （コンソールが出ず、アプリらしく開きます）
echo   こちらは起動しないときに原因を見るためのものです。
echo.

:: --------------------------------------------------------
:: [1] Python を探す
:: --------------------------------------------------------
echo [1/3] Python を確認しています...

set PY=
where python >nul 2>&1 && set PY=python
if "!PY!"=="" (
    where py >nul 2>&1 && set PY=py
)

if "!PY!"=="" (
    echo.
    echo   [エラー] Python が見つかりません。
    echo.
    echo   https://python.org からインストールしてください。
    echo   インストーラの「Add Python to PATH」に必ずチェックを入れること。
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('!PY! --version 2^>^&1') do echo       %%v
echo.

:: --------------------------------------------------------
:: [2] 依存パッケージ
::     flask … GUI に必要。無いと画面が出ない
::     torch / numpy … 学習に必要
:: --------------------------------------------------------
echo [2/3] 依存パッケージを確認しています...

set MISSING=
!PY! -c "import flask" >nul 2>&1 || set MISSING=!MISSING! flask
!PY! -c "import torch" >nul 2>&1 || set MISSING=!MISSING! torch
!PY! -c "import numpy" >nul 2>&1 || set MISSING=!MISSING! numpy

if not "!MISSING!"=="" (
    echo       足りないもの:!MISSING!
    echo.
    set /p ANSWER="      いま入れますか？ [Y/n]: "
    if /i not "!ANSWER!"=="n" (
        echo.
        !PY! -m pip install -r train\requirements.txt
        echo.
    ) else (
        echo       スキップしました。学習は開始できません。
    )
) else (
    echo       すべて揃っています
)

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo       [注意] Node.js が見つかりません。
    echo              環境（ゲームのルール）は Node 側にあるので、
    echo              これが無いと学習を開始できません。
    echo              https://nodejs.org/ からインストールしてください。
)
echo.

:: --------------------------------------------------------
:: [3] 起動
:: --------------------------------------------------------
echo [3/3] コントロールパネルを開いています...
echo.
echo   ウィンドウを閉じるとサーバーも止まります。
echo   学習中に閉じた場合は「停止」と同じ扱いです
echo   （世代ごとに保存しているので、失うのは進行中の1世代分だけ）。
echo.

!PY! train\launcher.py

echo.
echo ========================================================
echo   終了しました
echo ========================================================
pause
