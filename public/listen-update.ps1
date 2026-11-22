# Listen Together - updater (一緒に聴く 拡張機能の更新係)
#
# GitHub (skeliy/pc-status-relay の agent/extension) に新しい版があれば、
# %LOCALAPPDATA%\ListenTogether の中身を新しくする(前の版で ListenTogether\extension に入れた人は、そちらを新しくする)。
# 拡張機能は中身が新しくなったことに自分で気付いて、読み込み直す。
#
# このファイルは %LOCALAPPDATA%\ListenTogether-updater\update.ps1 に保存され、タスクスケジューラから2時間ごとに
#   powershell.exe -File "%LOCALAPPDATA%\ListenTogether-updater\update.ps1"
# の形で実行される。実行のたびに GitHub の新しい版で自分のファイルを置き換えるので、更新係の直しも次から届く。
# (前は「irm … | iex」で毎回ネットから取って直接実行していたが、Windows Defender にウイルスと間違われるのでやめた)
# Listen Together アプリが入っている PC では、アプリが拡張機能を更新するので、このタスクは使わない。
#
# 引数 install-app: 拡張機能の「インストール」ボタンから呼ばれた時。歌詞アプリ(Listen Together アプリ)を入れる。
# スマートアプリコントロールなどで「制限付きの言語モード」になっていても動くよう、
# .NET を直接呼ばず、普通のコマンドだけで書いている。

function Update-ListenTogether {
    param([switch]$Force)
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    $base = 'https://raw.githubusercontent.com/skeliy/pc-status-relay/main/agent'
    if ($env:LT_UPDATE_BASE) { $base = $env:LT_UPDATE_BASE }
    $root = Join-Path $env:LOCALAPPDATA 'ListenTogether'
    $ext = $root
    $legacy = Join-Path $root 'extension'
    if (Test-Path (Join-Path $legacy 'manifest.json')) { $ext = $legacy } # 前の版の入れ方(ブラウザはこちらを読み込んでいる)
    $tmp = Join-Path $env:LOCALAPPDATA 'ListenTogether-download'
    $log = Join-Path $root 'update.log'
    $updDir = Join-Path $env:LOCALAPPDATA 'ListenTogether-updater'
    $updFile = Join-Path $updDir 'update.ps1'
    $selfUrl = 'https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/listen-update.ps1'
    if ($env:LT_UPDATE_SCRIPT) { $selfUrl = $env:LT_UPDATE_SCRIPT }

    # 文字のファイルを取ってくる(サーバーが文字として送ってこなくても読めるよう、いったんファイルに保存して読む)
    function Get-LtText([string]$uri) {
        $p = Join-Path $tmp 'fetch.tmp'
        Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $p
        $text = Get-Content -Raw -Encoding UTF8 -Path $p
        Remove-Item $p -Force
        return $text
    }

    function Write-LtLog([string]$message) {
        $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $message
        Write-Host $line
        try {
            if ((Test-Path $log) -and ((Get-Item $log).Length -gt 200000)) { Remove-Item $log -Force }
            Add-Content -Path $log -Value $line -Encoding UTF8
        } catch {}
    }

    # 自分(この更新係)の新しい版を、次に実行する時のために保存しておく。
    # 中身がちゃんと更新係のものか確かめてから置き換える(途中で切れたファイルで上書きしない)
    try {
        New-Item -ItemType Directory -Force -Path $updDir | Out-Null
        $newSelf = Join-Path $updDir 'update.ps1.new'
        Invoke-WebRequest -UseBasicParsing -Uri $selfUrl -OutFile $newSelf
        $selfText = Get-Content -Raw -Encoding UTF8 -Path $newSelf
        if ($selfText -and $selfText.Contains('function Update-ListenTogether') -and $selfText.TrimEnd().EndsWith('# end of listen-update.ps1')) {
            Move-Item -Path $newSelf -Destination $updFile -Force
        } else {
            Remove-Item $newSelf -Force
        }
    } catch {
        Write-LtLog ('could not refresh the updater: ' + $_.Exception.Message)
    }

    # 前の形(ネットから取って直接実行する)のタスクが残っていたら、保存したファイルを実行する形に直す
    try {
        if ((Test-Path $updFile) -and (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
            $task = Get-ScheduledTask -TaskName 'ListenTogetherUpdater' -ErrorAction SilentlyContinue
            if ($task -and (($task.Actions | ForEach-Object { $_.Arguments }) -join ' ') -match 'iex') {
                $taskArgs = '--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $updFile + '"'
                $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument $taskArgs
                Set-ScheduledTask -TaskName 'ListenTogetherUpdater' -Action $action | Out-Null
                Write-LtLog 'switched the update task to the saved file'
            }
        }
    } catch {
        Write-LtLog ('could not switch the update task: ' + $_.Exception.Message)
    }

    # 拡張機能の「インストール」から歌詞アプリを入れられるよう、決まった動きだけをするリンクを登録する。
    # リンクの中身(%1)はコマンドに渡さない。押されるまで何もインストールしない。
    # 押された時は、保存してある更新係を「install-app」で実行する(ネットから取ったものを直接実行しない)
    try {
        $linkKey = 'HKCU:\Software\Classes\lyricsoverlay-setup'
        $conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
        $linkCommand = '"' + $conhost + '" --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $updFile + '" install-app'
        New-Item -Path "$linkKey\shell\open\command" -Force | Out-Null
        Set-ItemProperty -Path $linkKey -Name '(default)' -Value 'Lyrics Overlay Setup'
        Set-ItemProperty -Path $linkKey -Name 'URL Protocol' -Value ''
        Set-ItemProperty -Path "$linkKey\shell\open\command" -Name '(default)' -Value $linkCommand
    } catch {
        Write-LtLog ('could not register the install link: ' + $_.Exception.Message)
    }

    try {
        New-Item -ItemType Directory -Force -Path $ext | Out-Null
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null

        $remote = ((Get-LtText "$base/extension/manifest.json") | ConvertFrom-Json).version
        if (-not $remote) { throw 'could not read the latest version' }

        $localManifest = Join-Path $ext 'manifest.json'
        $local = ''
        if (Test-Path $localManifest) {
            try { $local = (Get-Content -Raw -Path $localManifest | ConvertFrom-Json).version } catch { $local = '' }
        }
        if (($remote -eq $local) -and (-not $Force)) {
            Remove-Item $tmp -Recurse -Force
            Write-LtLog "up to date ($local)"
            return
        }

        # FILES に書かれた extension/ のファイルを全部、いったん別の場所にダウンロードする
        $list = (Get-LtText "$base/FILES") -split "`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -like 'extension/*' -and $_ -notlike '*..*' }
        if (-not $list) { throw 'could not read the file list' }

        foreach ($f in $list) {
            $rel = $f.Substring('extension/'.Length)
            $dest = Join-Path $tmp $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$f" -OutFile $dest
        }

        # 全部そろってから入れ替える。manifest.json は最後(拡張機能はこれを見て読み込み直すため)
        foreach ($f in $list) {
            $rel = $f.Substring('extension/'.Length)
            if ($rel -eq 'manifest.json') { continue }
            $dest = Join-Path $ext $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
            Copy-Item -Path (Join-Path $tmp $rel) -Destination $dest -Force
        }
        Copy-Item -Path (Join-Path $tmp 'manifest.json') -Destination $localManifest -Force
        Remove-Item $tmp -Recurse -Force

        if ($local) { Write-LtLog "updated $local -> $remote" } else { Write-LtLog "installed $remote" }
    } catch {
        Write-LtLog ('update failed: ' + $_.Exception.Message)
        throw
    }
}

# 歌詞アプリ(Listen Together アプリ)を入れる。インストール用のファイルを保存してから、そのファイルを実行する
function Install-ListenTogetherApp {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $updDir = Join-Path $env:LOCALAPPDATA 'ListenTogether-updater'
    $url = 'https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/lyrics-install.ps1'
    if ($env:LT_APP_INSTALL_SCRIPT) { $url = $env:LT_APP_INSTALL_SCRIPT }
    New-Item -ItemType Directory -Force -Path $updDir | Out-Null
    $file = Join-Path $updDir 'lyrics-install.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
    # スクリプトのファイルを直接実行できない設定でも動くよう、中身を読んで実行する
    Invoke-Expression (Get-Content -Raw -Encoding UTF8 -Path $file)
}

if ($args -contains 'install-app') {
    Install-ListenTogetherApp
} else {
    Update-ListenTogether
}
# end of listen-update.ps1
