# share-internet.ps1
# 巨大数ポーカーをインターネットに公開して、遠くの友達と対戦できるようにする。
#
# ngrok の代わりに Cloudflare Tunnel の「クイックトンネル」を使う。
#   - アカウント登録・認証トークン不要
#   - HTTPS で公開される
#   - WebSocket に対応しているので Socket.io がそのまま動く
#   - ルーターのポート開放は不要（PC から外向きに繋ぐだけ）
#
# 発行される URL は起動のたびに変わる。使い終わったらウィンドウを閉じれば公開は止まる。

param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Head($text) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkCyan
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

Write-Head "巨大数ポーカー: インターネット公開"

# ------------------------------------------------------------
# [1] cloudflared の確認 / インストール
# ------------------------------------------------------------
Write-Host "[1/3] cloudflared を確認しています..."
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue

if (-not $cf) {
    Write-Host "      見つかりませんでした。" -ForegroundColor Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "      winget が使えないため自動インストールできません。" -ForegroundColor Red
        Write-Host "      次のページから cloudflared をダウンロードしてください:" -ForegroundColor Red
        Write-Host "        https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        Read-Host "Enter キーで閉じます"
        exit 1
    }

    $ans = Read-Host "      winget でインストールしますか? [Y/n]"
    if ($ans -and $ans -notmatch '^[Yy]') {
        Write-Host "      中止しました。"
        exit 0
    }

    Write-Host "      インストール中... (数分かかることがあります)"
    winget install --id Cloudflare.cloudflared -e --silent `
        --accept-source-agreements --accept-package-agreements
    Refresh-Path
    $cf = Get-Command cloudflared -ErrorAction SilentlyContinue

    if (-not $cf) {
        Write-Host ""
        Write-Host "      インストールは終わりましたが、まだ PATH に見つかりません。" -ForegroundColor Yellow
        Write-Host "      このウィンドウを閉じて、もう一度実行してください。" -ForegroundColor Yellow
        Read-Host "Enter キーで閉じます"
        exit 1
    }
}
Write-Host "      OK: $($cf.Source)" -ForegroundColor Green

# ------------------------------------------------------------
# [2] ゲームサーバーの確認 / 起動
# ------------------------------------------------------------
Write-Host "[2/3] ゲームサーバーを確認しています..."
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if (-not $listening) {
    Write-Host "      起動していないので起動します..."
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/k", "title 巨大数ポーカー サーバー && node server.js" `
        -WorkingDirectory $ProjectDir
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { break }
    }
}

if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "      サーバーを起動できませんでした。start.bat を先に実行してください。" -ForegroundColor Red
    Read-Host "Enter キーで閉じます"
    exit 1
}
Write-Host "      OK: http://localhost:$Port" -ForegroundColor Green

# ------------------------------------------------------------
# [3] トンネルを張って公開 URL を取り出す
# ------------------------------------------------------------
Write-Host "[3/3] トンネルを開いています..."

$outLog = Join-Path $env:TEMP "hnp-cloudflared.out.log"
$errLog = Join-Path $env:TEMP "hnp-cloudflared.err.log"
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $cf.Source `
    -ArgumentList 'tunnel', '--url', "http://localhost:$Port" `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$url = $null
for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    $text = ''
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path $f) { $text += (Get-Content $f -Raw -ErrorAction SilentlyContinue) }
    }
    if ($text -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
        $url = $Matches[0]
        break
    }
    if ($proc.HasExited) { break }
}

if (-not $url) {
    Write-Host ""
    Write-Host "      公開 URL を取得できませんでした。ログ:" -ForegroundColor Red
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path $f) { Get-Content $f -Tail 20 | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray } }
    }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Read-Host "Enter キーで閉じます"
    exit 1
}

$joinUrl = "$url/online"
try { Set-Clipboard -Value $joinUrl } catch { }

Write-Head "公開しました"
Write-Host ""
Write-Host "  友達に伝える URL (クリップボードにコピー済み)" -ForegroundColor Yellow
Write-Host ""
Write-Host "      $joinUrl" -ForegroundColor White -BackgroundColor DarkBlue
Write-Host ""
Write-Host "  遊びかた" -ForegroundColor Cyan
Write-Host "    1. あなたがこの URL を開いて「部屋を作る」"
Write-Host "    2. 表示された 4 文字の部屋コードを友達に伝える"
Write-Host "    3. 友達も同じ URL を開いて、コードを入れて「部屋に入る」"
Write-Host ""
Write-Host "  注意" -ForegroundColor DarkYellow
Write-Host "    - URL は起動のたびに変わります"
Write-Host "    - このウィンドウを閉じると公開は止まります"
Write-Host "    - URL を知っている人は誰でも入れます。SNS に貼らないでください"
Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  終了するには Ctrl+C、またはこのウィンドウを閉じてください" -ForegroundColor DarkGray
Write-Host ""

try {
    Wait-Process -Id $proc.Id
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "公開を停止しました。" -ForegroundColor Yellow
}
