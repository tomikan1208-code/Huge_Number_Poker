@echo off
setlocal
chcp 65001 >nul
title 巨大数ポーカー ランチャー
cd /d "%~dp0"

set PORT=3000

echo ========================================================
echo   巨大数ポーカー ランチャー
echo ========================================================
echo.

:: --------------------------------------------------------
:: [1] ポートを使っている古いプロセスを止める
:: --------------------------------------------------------
echo [1/5] ポート %PORT% を使っているプロセスを確認しています...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo       PID %%a を終了します
    taskkill /PID %%a /F >nul 2>&1
)
echo       完了

:: --------------------------------------------------------
:: [2] 依存パッケージ
:: --------------------------------------------------------
echo [2/5] 依存パッケージを確認しています...
if not exist "node_modules" (
    echo       node_modules がありません。npm install を実行します...
    call npm install
)
echo       完了

:: --------------------------------------------------------
:: [3] ファイアウォール
::     Windows の受信規則は「実行ファイルのパス」単位なので、
::     node のインストール先が変わると既存の許可が効かなくなる。
::     ここではポート番号に対する規則があるかを確認する。
:: --------------------------------------------------------
echo [3/5] ファイアウォールの設定を確認しています...
powershell -NoProfile -Command "if (Get-NetFirewallRule -DisplayName 'Huge Number Poker (TCP %PORT%)' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto FW_OK

echo.
echo       [注意] TCP %PORT% の受信許可がまだありません。
echo              この PC だけで遊ぶ分には問題ありません。
echo              同じ Wi-Fi / LAN の他の端末から参加するには許可が必要です。
echo.
choice /C YN /N /M "       今すぐ設定しますか？ 管理者の確認が出ます [Y/N]: "
if errorlevel 2 goto FW_SKIP

powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0allow-firewall.ps1'"
echo       別ウィンドウで設定しています。完了してから続けてください。
timeout /t 3 >nul
goto FW_OK

:FW_SKIP
echo       スキップしました。後から allow-firewall.ps1 を実行しても設定できます。

:FW_OK
echo       完了

:: --------------------------------------------------------
:: [4] サーバー起動
:: --------------------------------------------------------
echo [4/5] サーバーを起動しています...
start "巨大数ポーカー サーバー" cmd /k "node server.js"
timeout /t 2 >nul
echo       完了

:: --------------------------------------------------------
:: [5] 接続先の案内
:: --------------------------------------------------------
echo [5/5] 接続先を調べています...
set LANIP=
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } ^| Select-Object -First 1).IPAddress"`) do set LANIP=%%i

echo.
echo --------------------------------------------------------
echo   この PC で遊ぶ
echo     http://localhost:%PORT%
echo.
if defined LANIP (
    echo   同じ Wi-Fi / LAN の他の端末から参加する
    echo     http://%LANIP%:%PORT%/online
) else (
    echo   LAN アドレスが見つかりませんでした。
    echo   ネットワークに接続されているか確認してください。
)
echo.
echo   遠くの友達と対戦する
echo     share-internet.bat を実行してください。
echo     インターネット公開用の URL が発行されます。
echo.
echo   ホストが「部屋を作る」で出た 4 文字のコードを
echo   参加者に伝えてください。
echo --------------------------------------------------------
echo.

start "" "http://localhost:%PORT%"

echo このウィンドウは閉じて構いません。
echo サーバーを止めるときは「巨大数ポーカー サーバー」のウィンドウを閉じてください。
echo.
pause
