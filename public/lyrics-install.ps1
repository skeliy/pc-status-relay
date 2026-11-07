# Lyrics Overlay - install (歌詞オーバーレイを入れる)
#
# 使い方(PowerShell に貼り付けて Enter):
#   irm https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/lyrics-install.ps1 | iex
#
# 1. Electron(公式の配布物)を %LOCALAPPDATA%\LyricsOverlay にダウンロードする(約160MB)
# 2. GitHub からオーバーレイのプログラムを入れて、起動する
# 管理者の権限はいらない。やめる時は public/lyrics-uninstall.ps1 を実行する。
# Windows の「制限付きの言語モード」でも動くよう、.NET を直接呼ばず、普通のコマンドだけで書いている。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$loElectron = '45.2.2'
$loBase = 'https://raw.githubusercontent.com/skeliy/pc-status-relay/main/overlay'
if ($env:LYRICS_OVERLAY_UPDATE_BASE) { $loBase = $env:LYRICS_OVERLAY_UPDATE_BASE }
$loRoot = Join-Path $env:LOCALAPPDATA 'LyricsOverlay'
$loExe = Join-Path $loRoot 'LyricsOverlay.exe'
$loTmp = Join-Path $env:LOCALAPPDATA 'LyricsOverlay-setup'
# 拡張機能から裏で実行された時に、失敗の理由を後から確かめられるよう記録する
try { Start-Transcript -Path (Join-Path $env:LOCALAPPDATA 'LyricsOverlay-install.log') -Force | Out-Null } catch {}

Get-Process -Name 'LyricsOverlay' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

if (Test-Path $loTmp) { Remove-Item $loTmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $loTmp | Out-Null

if (-not (Test-Path $loExe)) {
    Write-Host 'Downloading (about 160 MB)... / ダウンロードしています(約160MB)…' -ForegroundColor Cyan
    $loZip = Join-Path $loTmp 'electron.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/electron/electron/releases/download/v$loElectron/electron-v$loElectron-win32-x64.zip" -OutFile $loZip
    New-Item -ItemType Directory -Force -Path $loRoot | Out-Null
    Write-Host 'Unpacking... / 展開しています…' -ForegroundColor Cyan
    tar.exe -xf $loZip -C $loRoot
    if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $loZip -DestinationPath $loRoot -Force }
    Rename-Item -Path (Join-Path $loRoot 'electron.exe') -NewName 'LyricsOverlay.exe'
    $loDefault = Join-Path $loRoot 'resources\default_app.asar'
    if (Test-Path $loDefault) { Remove-Item $loDefault -Force }
}

Write-Host 'Installing the app... / アプリを入れています…' -ForegroundColor Cyan
$loApp = Join-Path $loRoot 'resources\app'
New-Item -ItemType Directory -Force -Path $loApp | Out-Null
$loList = Join-Path $loTmp 'FILES'
Invoke-WebRequest -UseBasicParsing -Uri "$loBase/FILES" -OutFile $loList
$loNames = Get-Content -Encoding UTF8 -Path $loList | ForEach-Object { $_.Trim() } | Where-Object { $_ -and ($_ -notlike '#*') -and ($_ -notlike '*..*') }
if (-not $loNames) { throw 'could not read the file list' }
foreach ($loName in $loNames) {
    $loDest = Join-Path $loApp ($loName -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $loDest) | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri "$loBase/$loName" -OutFile $loDest
}
Invoke-WebRequest -UseBasicParsing -Uri "$loBase/VERSION" -OutFile (Join-Path $loApp 'VERSION')
Remove-Item $loTmp -Recurse -Force

Start-Process -FilePath $loExe -ArgumentList '--settings'

Write-Host ''
Write-Host 'Done! / 完了しました' -ForegroundColor Green
Write-Host 'Play a song on Apple Music or Spotify in the browser with the Listen Together extension.'
Write-Host '拡張機能 Listen Together を入れたブラウザの Apple Music か Spotify で曲を流すと、歌詞が表示されます。'
Write-Host 'Settings: click the icon in the notification area. / 設定は、通知領域のアイコンから開けます。'
Write-Host ''
try { Stop-Transcript | Out-Null } catch {}
