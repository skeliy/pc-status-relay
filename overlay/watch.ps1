# Listen Together アプリの見張り係(2秒ごとに全画面かどうかを、6秒ごとに動いているプログラムの一覧を書き出す)
# notify.js が起動する。このファイルを書き換えたら VERSION を上げる
$ErrorActionPreference = 'SilentlyContinue'
$ok = $false
try {
  Add-Type -Namespace LT -Name Q -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);' -ErrorAction Stop
  $ok = $true
} catch {}
$n = 0
while ($true) {
  $q = -1
  if ($ok) { $s = 0; if ([LT.Q]::SHQueryUserNotificationState([ref]$s) -eq 0) { $q = $s } }
  $p = @()
  if ($n % 3 -eq 0) {
    $p = @(Get-Process | Where-Object { $_.Path -and $_.Path -notlike 'C:\Windows\*' } | ForEach-Object { ,@($_.Id, ($_.ProcessName + '.exe'), $_.Path) })
  }
  $line = @{ q = $q; p = $p; full = ($n % 3 -eq 0) } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  $n++
  Start-Sleep -Seconds 2
}
