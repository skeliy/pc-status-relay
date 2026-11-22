# Listen Together - install (一緒に聴く 拡張機能を入れる)
#
# 使い方(PowerShell に貼り付けて Enter):
#   irm https://pc-status-relay.onrender.com/listen-install.ps1 | iex
#
# 1. GitHub から拡張機能を %LOCALAPPDATA%\ListenTogether にダウンロードする
# 2. 更新係(listen-update.ps1)を %LOCALAPPDATA%\ListenTogether-updater に保存して、
#    2時間ごとにそのファイルを実行するタスクを、タスクスケジューラに登録する(管理者の権限はいらない)
# 3. フォルダの場所をクリップボードにコピーする(拡張機能ページの「読み込む」で貼り付ける)
#
# やめる時:
#   irm https://pc-status-relay.onrender.com/listen-uninstall.ps1 | iex

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ltUpdateUrl = 'https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/listen-update.ps1'
if ($env:LT_UPDATE_SCRIPT) { $ltUpdateUrl = $env:LT_UPDATE_SCRIPT }
$ltRoot = Join-Path $env:LOCALAPPDATA 'ListenTogether'
$ltExt = $ltRoot
if (Test-Path (Join-Path $ltRoot 'extension\manifest.json')) { $ltExt = Join-Path $ltRoot 'extension' } # 前の版の入れ方
$ltHad = Test-Path (Join-Path $ltExt 'manifest.json') # もう入っている(新しい版にするだけ)

Write-Host ''
Write-Host 'Listen Together: downloading the extension... / 拡張機能をダウンロードしています…' -ForegroundColor Cyan
# 前の入れ方の残り
$ltDl = Join-Path $env:LOCALAPPDATA 'ListenTogether-setup'
if (Test-Path $ltDl) { Remove-Item $ltDl -Recurse -Force }
# 更新係をファイルとして保存して、その中身を実行する(拡張機能のダウンロードもこれがする)。
# Windows は最初の設定でスクリプトのファイルを直接実行できない(「running scripts is disabled」)ので、
# ここでは中身を読んで実行する。タスクやアプリからは「-ExecutionPolicy Bypass -File」で実行するので、それで動く
$ltUpdDir = Join-Path $env:LOCALAPPDATA 'ListenTogether-updater'
New-Item -ItemType Directory -Force -Path $ltUpdDir | Out-Null
$ltScript = Join-Path $ltUpdDir 'update.ps1'
Invoke-WebRequest -UseBasicParsing -Uri $ltUpdateUrl -OutFile $ltScript
Invoke-Expression (Get-Content -Raw -Encoding UTF8 -Path $ltScript)

$ltAuto = $false
if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
    try {
        # 保存した更新係のファイルを実行する(ネットから取ったものを直接実行する形は、ウイルスと間違われるので使わない)
        $ltArgs = '--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ltScript + '"'
        $ltAction = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument $ltArgs
        $ltTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Hours 2)
        $ltSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
        Register-ScheduledTask -TaskName 'ListenTogetherUpdater' -Action $ltAction -Trigger $ltTrigger -Settings $ltSettings -Description 'Keeps the Listen Together browser extension up to date from GitHub (skeliy/pc-status-relay).' -Force | Out-Null
        $ltAuto = $true
    } catch {
        Write-Host ('Could not set up automatic updates / 自動更新を設定できませんでした: ' + $_.Exception.Message) -ForegroundColor Yellow
    }
}

if ($ltHad) {
    Write-Host ''
    Write-Host 'Updated! The extension reloads itself in a few seconds. / 新しい版にしました。拡張機能は数秒で自分で読み込み直します。' -ForegroundColor Green
    Write-Host ''
    return
}

$ltCopied = $false
try { Set-Clipboard -Value $ltExt; $ltCopied = $true } catch {}

Write-Host ''
Write-Host 'Done! / 完了しました' -ForegroundColor Green
Write-Host ''
Write-Host ('Extension folder / 拡張機能のフォルダ:  ' + $ltExt)
if ($ltCopied) { Write-Host '(copied to the clipboard / クリップボードにコピーしました)' }
Write-Host ''
Write-Host 'Next: open chrome://extensions, turn on Developer mode, click "Load unpacked", press Ctrl+V and click "Select Folder".'
Write-Host '次に: chrome://extensions を開いてデベロッパーモードをオンにし、「パッケージ化されていない拡張機能を読み込む」を押して、Ctrl+V を押してから「フォルダーの選択」を押します。'
Write-Host ''
if ($ltAuto) {
    Write-Host 'Updates install automatically every 2 hours. / 2時間ごとに自動で新しい版になります。' -ForegroundColor Green
} else {
    Write-Host 'To update later, run this command again. / 新しい版にする時は、このコマンドをもう一度実行してください。' -ForegroundColor Yellow
}
Write-Host ''
