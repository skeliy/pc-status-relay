// 拡張機能(Listen Together)の更新係を、このアプリから動かす。
//
// 前は Windows のタスクスケジューラが2時間ごとに「ネットから取ったスクリプトを、見えない窓でそのまま実行する」
// 形で更新していたが、Windows Defender にウイルス(トロイの木馬)と間違われてブロックされるようになった。
// そこで、このアプリが入っている PC では、更新係(listen-update.ps1)をファイルとして保存し、
// そのファイルを窓を出さずに実行する。更新係は拡張機能を新しくして、残っている古い形のタスクも直す。
//
// - 拡張機能を PowerShell のコマンドで入れた人(%LOCALAPPDATA%\ListenTogether にある人)だけが対象。
//   PC Status(エージェント)のフォルダから読み込んでいる人は、エージェントが更新するので何もしない
// - 起動して少したってから1回と、そのあと2時間ごとに動く
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_URL = process.env.LISTEN_TOGETHER_EXT_UPDATER || 'https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/listen-update.ps1';
const END_MARK = '# end of listen-update.ps1';
const EVERY_MS = 2 * 60 * 60 * 1000;

function createExtUpdater({ localAppData = process.env.LOCALAPPDATA, run = defaultRun, fetchText = defaultFetch, log = () => {} } = {}) {
  const root = localAppData ? path.join(localAppData, 'ListenTogether') : null;
  const updDir = localAppData ? path.join(localAppData, 'ListenTogether-updater') : null;
  const file = updDir ? path.join(updDir, 'update.ps1') : null;
  let busy = false;

  // PowerShell のコマンドで拡張機能を入れた人か
  function installedByScript() {
    if (!root) return false;
    return fs.existsSync(path.join(root, 'manifest.json')) || fs.existsSync(path.join(root, 'extension', 'manifest.json'));
  }

  async function once() {
    if (busy || !installedByScript()) return 'skip';
    busy = true;
    try {
      // 更新係の新しい版を保存する(途中で切れたファイルや、違う中身は使わない)
      try {
        const text = await fetchText(SCRIPT_URL);
        if (text && text.includes('function Update-ListenTogether') && text.trimEnd().endsWith(END_MARK)) {
          fs.mkdirSync(updDir, { recursive: true });
          const tmp = file + '.new';
          fs.writeFileSync(tmp, '\uFEFF' + text.replace(/^\uFEFF/, '')); // 日本語の Windows でも UTF-8 として読まれるように
          fs.renameSync(tmp, file);
        }
      } catch (e) {
        log('could not download the updater: ' + e.message);
      }
      if (!fs.existsSync(file)) return 'no-file';
      await run(file);
      return 'ran';
    } catch (e) {
      log('extension update failed: ' + e.message);
      return 'failed';
    } finally {
      busy = false;
    }
  }

  let timers = [];
  function start(firstDelayMs = 90 * 1000) {
    timers.push(setTimeout(once, firstDelayMs));
    timers.push(setInterval(once, EVERY_MS));
  }
  function stop() {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
  }
  return { once, start, stop, installedByScript, file };
}

async function defaultFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return await res.text();
}

// 保存したファイルを、窓を出さずに実行する(歌詞アプリが watch.ps1 を動かすのと同じやり方)
function defaultRun(file) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
      { windowsHide: true, timeout: 10 * 60 * 1000 },
      () => resolve()
    );
  });
}

module.exports = { createExtUpdater };
