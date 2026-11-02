# Listen Together - uninstall (一緒に聴く 拡張機能の更新係をやめる)
#
# 使い方(PowerShell に貼り付けて Enter):
#   irm https://pc-status-relay.onrender.com/listen-uninstall.ps1 | iex
#
# 先にブラウザの拡張機能ページで Listen Together を「削除」してから実行してください。
# 自動更新のタスクを消し、%LOCALAPPDATA%\ListenTogether フォルダを消す。

$ErrorActionPreference = 'Stop'
$ltRoot = Join-Path $env:LOCALAPPDATA 'ListenTogether'

if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
    if (Get-ScheduledTask -TaskName 'ListenTogetherUpdater' -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName 'ListenTogetherUpdater' -Confirm:$false
        Write-Host 'Automatic updates stopped. / 自動更新を止めました。'
    }
}
if (Test-Path $ltRoot) {
    Remove-Item $ltRoot -Recurse -Force
    Write-Host ('Removed / 消しました: ' + $ltRoot)
}
Write-Host 'Done. Remove "Listen Together" on the extensions page if it is still there. / 完了しました。拡張機能ページに Listen Together が残っていたら「削除」してください。' -ForegroundColor Green
