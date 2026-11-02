# Listen Together - updater (一緒に聴く 拡張機能の更新係)
#
# GitHub (skeliy/pc-status-relay の agent/extension) に新しい版があれば、
# %LOCALAPPDATA%\ListenTogether の中身を新しくする(前の版で ListenTogether\extension に入れた人は、そちらを新しくする)。
# 拡張機能は中身が新しくなったことに自分で気付いて、読み込み直す。
#
# Windows のタスクスケジューラから2時間ごとに
#   irm https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/listen-update.ps1 | iex
# の形で実行される(このファイル自体も GitHub から毎回取ってくるので、更新係の直しも自動で届く)。
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

Update-ListenTogether
