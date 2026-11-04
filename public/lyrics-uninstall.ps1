# Lyrics Overlay - uninstall (歌詞オーバーレイを消す)
#
# 使い方(PowerShell に貼り付けて Enter):
#   irm https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/lyrics-uninstall.ps1 | iex

$ProgressPreference = 'SilentlyContinue'
Get-Process -Name 'LyricsOverlay' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LyricsOverlay' -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\lyricsoverlay' -Recurse -Force -ErrorAction SilentlyContinue
foreach ($loDir in @((Join-Path $env:LOCALAPPDATA 'LyricsOverlay'), (Join-Path $env:LOCALAPPDATA 'LyricsOverlay-setup'), (Join-Path $env:APPDATA 'lyrics-overlay'))) {
    if (Test-Path $loDir) { Remove-Item $loDir -Recurse -Force }
}
Write-Host 'Removed. / 削除しました' -ForegroundColor Green
