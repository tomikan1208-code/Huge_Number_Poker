# allow-firewall.ps1
# 巨大数ポーカーのサーバー（TCP 3000）を、同じLAN内の他端末から開けるようにする。
#
# Windows ファイアウォールの既定は「受信ブロック」で、既存の node.exe 許可規則は
# 実行ファイルのパス単位。nvm と Program Files で node のパスが変わると効かなくなるため、
# ここでは「ポート番号」に対して規則を作る（どの node が動いても有効）。
#
# 管理者権限が必要。start.bat から呼ばれる。

param(
    [int]$Port = 3000,
    [switch]$Remove
)

$RuleName = "Huge Number Poker (TCP $Port)"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "管理者権限が必要です。管理者として実行し直してください。" -ForegroundColor Red
    Read-Host "Enter キーで閉じます"
    exit 1
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

if ($Remove) {
    if ($existing) {
        $existing | Remove-NetFirewallRule
        Write-Host "規則を削除しました: $RuleName" -ForegroundColor Yellow
    } else {
        Write-Host "規則は存在しません: $RuleName"
    }
    Read-Host "Enter キーで閉じます"
    exit 0
}

if ($existing) {
    Write-Host "既に設定済みです: $RuleName" -ForegroundColor Green
} else {
    New-NetFirewallRule `
        -DisplayName $RuleName `
        -Description "巨大数ポーカーのローカルサーバーへの受信を許可します" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort $Port `
        -Action Allow `
        -Profile Any | Out-Null
    Write-Host "ファイアウォール規則を追加しました: $RuleName" -ForegroundColor Green
}

Write-Host ""
Write-Host "同じLANの端末からは、次のURLで参加できます:" -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -ne '127.0.0.1' } |
    ForEach-Object { Write-Host ("  http://{0}:{1}/online" -f $_.IPAddress, $Port) }

Write-Host ""
Write-Host "元に戻すには次を実行してください:" -ForegroundColor DarkGray
Write-Host "  powershell -ExecutionPolicy Bypass -File allow-firewall.ps1 -Remove" -ForegroundColor DarkGray
Write-Host ""
Read-Host "Enter キーで閉じます"
