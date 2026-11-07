// 歌詞オーバーレイの本体。
//  - 透明で、クリックが下の画面に通り抜ける、常に手前のウィンドウを出す
//  - ブラウザの拡張機能(Listen Together)から http://127.0.0.1:8789 で曲と歌詞を受け取る
//  - 通知領域のアイコンから設定を開く
//  - GitHub に新しい版があれば、自分で更新する
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const PORT = 8789;
const LRCLIB = process.env.LYRICS_OVERLAY_LRCLIB_BASE || 'https://lrclib.net';
const LRCLIB_DURATION_SLACK = 4; // 曲の長さがこれ以上違う歌詞は、別の版として使わない
const UPDATE_BASE = process.env.LYRICS_OVERLAY_UPDATE_BASE || 'https://raw.githubusercontent.com/skeliy/pc-status-relay/main/overlay';
const UPDATE_EVERY_MS = 30 * 60 * 1000;
const RETRY_NO_LYRICS_MS = 30 * 60 * 1000;
const RETRY_ERROR_MS = 30 * 1000;
const ASK_TIMEOUT_MS = 15 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_CACHED_SONGS = 30;
const TEST_MODE = process.argv.includes('--test-mode');

let ja = process.env.LYRICS_OVERLAY_LANG === 'ja'; // Windows の言語は、起動の準備ができてから読む
const T = (j, e) => (ja ? j : e);

const DEFAULTS = {
  enabled: true,
  opacity: 100, // 歌詞全体の不透明度(%)
  fontSize: 36,
  width: 380,
  height: 460,
  x: 3, // 画面の左端からの位置(%)
  y: 12, // 画面の上端からの位置(%)
  displayId: null,
  offsetMs: 0, // 歌詞の表示を早める(+)・遅らせる(-)ミリ秒
  shadow: true,
  autoStart: true,
};
const LIMITS = {
  opacity: [10, 100],
  fontSize: [16, 96],
  width: [160, 1600],
  height: [120, 1400],
  x: [0, 100],
  y: [0, 100],
  offsetMs: [-3000, 3000],
};

let settings = { ...DEFAULTS };
let overlay = null;
let settingsWin = null;
let tray = null;
let overlayReady = false;
let lastTick = null;
let wantVisible = false;
let previewing = false;
let statusText = '';
let moveMode = false;
let dragTimer = null;
let lyricsCache = new Map(); // 曲の番号 -> { ttml, status, at, kind }
let asking = new Map(); // 曲の番号 -> 頼んだ時刻

// ---- 設定の保存 ----
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function cleanSettings(input) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = input && input[key];
    if (key === 'displayId') {
      if (Number.isFinite(value)) out.displayId = value;
    } else if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (Number.isFinite(value)) {
      const [lo, hi] = LIMITS[key];
      out[key] = Math.min(hi, Math.max(lo, value));
    }
  }
  return out;
}

function loadSettings() {
  try {
    settings = cleanSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch (e) {
    settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('could not save settings', e);
  }
}

function applyAutoStart() {
  if (TEST_MODE || process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.autoStart, name: 'LyricsOverlay' });
}

// ---- 透明なウィンドウ ----
function targetDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find((d) => d.id === settings.displayId) || screen.getPrimaryDisplay();
}

function overlayBounds() {
  const area = targetDisplay().workArea;
  const width = Math.min(settings.width, area.width);
  const height = Math.min(settings.height, area.height);
  return {
    x: Math.round(area.x + ((area.width - width) * settings.x) / 100),
    y: Math.round(area.y + ((area.height - height) * settings.y) / 100),
    width,
    height,
  };
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayBounds(),
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    thickFrame: false,
    title: 'Lyrics Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true); // クリックもスクロールも、すべて下の画面へ通す
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (e) => e.preventDefault());
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
  });
}

function sendOverlay(channel, data) {
  if (overlay && overlayReady && !overlay.isDestroyed()) overlay.webContents.send(channel, data);
}

function refreshOverlayWindow() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(overlayBounds());
  sendOverlay('settings', settings);
}

function syncWindowVisibility() {
  if (!overlay || overlay.isDestroyed()) return;
  const show = moveMode || (settings.enabled && wantVisible);
  if (show && !overlay.isVisible()) {
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
  } else if (!show && overlay.isVisible()) {
    // すっと消えるのを待ってから隠す
    setTimeout(() => {
      if (overlay && !overlay.isDestroyed() && !moveMode && !(settings.enabled && wantVisible)) overlay.hide();
    }, 500);
  }
}

// ---- 拡張機能との連絡 ----
// 曲の見分け方: Apple Music はカタログの番号、Spotify は曲の番号(分からなければ曲名とアーティスト)
function songKey(service, rawId) {
  if (typeof rawId !== 'string') return null;
  if (service === 'apple') return /^\d{1,20}$/.test(rawId) ? rawId : null;
  if (service === 'spotify') return /^(?:[A-Za-z0-9]{22}|meta:.{1,600})$/s.test(rawId) ? 'sp:' + rawId.slice(0, 300) : null;
  return null;
}

function validTick(body) {
  if (!body || typeof body !== 'object') return null;
  const service = body.service === 'spotify' ? 'spotify' : 'apple'; // 古い拡張機能は service を送らない(Apple Music だけ)
  const id = songKey(service, body.id);
  const pos = Number(body.pos);
  const at = Number(body.at);
  return {
    id,
    service,
    title: String(body.title || '').slice(0, 300),
    artist: String(body.artist || '').slice(0, 300),
    album: String(body.album || '').slice(0, 300),
    duration: Number(body.duration) || 0,
    playing: body.playing === true,
    pos: Number.isFinite(pos) && pos >= 0 ? pos : 0,
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

// この曲の歌詞をブラウザに頼むべきか
function shouldAsk(id) {
  if (!settings.enabled || !id) return false;
  const now = Date.now();
  const cached = lyricsCache.get(id);
  if (cached) {
    if (cached.status === 'ok') return false;
    const wait = cached.status === 'none' ? RETRY_NO_LYRICS_MS : RETRY_ERROR_MS;
    if (now - cached.at < wait) return false;
  }
  const askedAt = asking.get(id);
  if (askedAt && now - askedAt < ASK_TIMEOUT_MS) return false;
  asking.set(id, now);
  return true;
}

function pushLyrics(id) {
  const cached = lyricsCache.get(id);
  const ok = cached && cached.status === 'ok';
  sendOverlay('lyrics', {
    id,
    ttml: ok ? cached.ttml || null : null,
    lrc: ok ? cached.lrc || null : null,
    duration: lastTick && lastTick.id === id ? lastTick.duration : 0,
  });
}

function storeLyrics(id, entry) {
  lyricsCache.set(id, Object.assign({ at: Date.now() }, entry));
  asking.delete(id);
  while (lyricsCache.size > MAX_CACHED_SONGS) lyricsCache.delete(lyricsCache.keys().next().value);
  if (id === currentId) pushLyrics(id);
  updateStatus();
}

// ---- Spotify の歌詞: 公開されている歌詞の図書館 LRCLIB から取る ----
// (Spotify の歌詞は、Spotify が使ってはいけないとしている非公開の仕組みでしか取れないため)
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[([](?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*\b(?:remaster(?:ed)?|version|edit|mix|live|mono|stereo|from)\b.*$/i, '')
    .trim();
}

async function lrclibGet(pathname, params) {
  const url = new URL(pathname, LRCLIB);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, String(v));
  const version = (() => {
    try {
      return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
    } catch (e) {
      return '0';
    }
  })();
  const res = await fetch(url, {
    headers: { 'User-Agent': `LyricsOverlay/${version} (https://github.com/skeliy/pc-status-relay)` },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

function bestLrclib(list, duration) {
  let best = null;
  for (const x of Array.isArray(list) ? list : [list]) {
    if (!x || x.instrumental || typeof x.syncedLyrics !== 'string' || !x.syncedLyrics.trim()) continue;
    const diff = duration && x.duration ? Math.abs(Number(x.duration) - duration) : 0;
    if (diff > LRCLIB_DURATION_SLACK) continue;
    if (!best || diff < best.diff) best = { diff, lrc: x.syncedLyrics };
  }
  return best && best.lrc;
}

async function fetchLrclib(tick) {
  const artist = tick.artist.split(/\s*,\s*/)[0] || tick.artist;
  const title = cleanTitle(tick.title) || tick.title;
  const duration = Math.round(tick.duration || 0);
  let sawInstrumental = false;
  const tries = [];
  if (tick.album && duration) tries.push(['/api/get', { track_name: tick.title, artist_name: tick.artist, album_name: tick.album, duration }]);
  tries.push(['/api/search', { track_name: tick.title, artist_name: artist }]);
  if (title !== tick.title) tries.push(['/api/search', { track_name: title, artist_name: artist }]);
  tries.push(['/api/search', { q: `${title} ${artist}` }]);
  for (const [pathname, params] of tries) {
    const found = await lrclibGet(pathname, params);
    if (found && !Array.isArray(found) && found.instrumental) sawInstrumental = true;
    const lrc = bestLrclib(found, tick.duration);
    if (lrc) return { status: 'ok', lrc, kind: 'lrclib' };
  }
  return { status: 'none', kind: 'lrclib', instrumental: sawInstrumental };
}

function askLrclib(tick) {
  fetchLrclib(tick)
    .catch((e) => {
      console.error('lyrics lookup failed:', e.message);
      return { status: 'error', kind: 'lrclib' };
    })
    .then((r) => storeLyrics(tick.id, r));
}

function describeStatus() {
  const t = lastTick;
  if (!t || !t.id) return T('曲を待っています(Apple Music か Spotify)', 'Waiting for a song (Apple Music or Spotify)');
  const name = t.title ? `${t.title}${t.artist ? ' — ' + t.artist : ''}` : '';
  const cached = lyricsCache.get(t.id);
  let note = T('歌詞を取得しています', 'Fetching lyrics');
  if (cached && cached.status === 'ok') {
    if (cached.kind === 'lrclib') note = T('行ごとの歌詞(LRCLIB)', 'Line-synced lyrics (LRCLIB)');
    else note = cached.kind === 'lyrics' ? T('行ごとの歌詞', 'Line-synced lyrics') : T('単語ごとの歌詞', 'Word-synced lyrics');
  } else if (cached && cached.status === 'none') {
    note = cached.instrumental ? T('この曲は歌のない曲です', 'This song has no vocals') : cached.kind === 'lrclib' ? T('この曲の時間付きの歌詞が見つかりません', 'No synced lyrics found for this song') : T('この曲の歌詞はありません', 'No lyrics for this song');
  }
  else if (cached && cached.status === 'denied') note = T('歌詞を取得できません(ログインを確認)', 'Could not get lyrics (check sign-in)');
  else if (cached) note = T('歌詞を取得できませんでした', 'Could not get lyrics');
  return `${note}: ${name}`.slice(0, 120);
}

function updateStatus() {
  const next = describeStatus();
  if (next === statusText) return;
  statusText = next;
  rebuildTrayMenu();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('status', statusText);
}

let currentId = null;
function handleTick(body) {
  const tick = validTick(body);
  if (!tick) return { ok: false };
  const changed = tick.id !== currentId;
  currentId = tick.id;
  lastTick = tick;
  if (changed && tick.id && lyricsCache.has(tick.id)) pushLyrics(tick.id);
  sendOverlay('tick', tick);
  if (!shouldAsk(tick.id)) {
    updateStatus();
    return { ok: true };
  }
  updateStatus();
  if (tick.service === 'spotify') {
    askLrclib(tick);
    return { ok: true };
  }
  return { ok: true, need: tick.id }; // Apple Music の歌詞は、その人のログインでブラウザに取ってもらう
}

function handleLyrics(body) {
  if (!body || typeof body.id !== 'string' || !/^\d{1,20}$/.test(body.id)) return { ok: false };
  const ok = body.status === 'ok' && typeof body.ttml === 'string' && body.ttml.length > 0;
  const status = ok ? 'ok' : ['none', 'denied'].includes(body.status) ? body.status : 'error';
  storeLyrics(body.id, { status, ttml: ok ? body.ttml : null, kind: body.kind === 'lyrics' ? 'lyrics' : 'syllable-lyrics' });
  return { ok: true };
}

function startServer() {
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // ふつうのWebページからは送れない見出しを条件にする(このPCで開いた別のサイトから操作されないように)
    const origin = String(req.headers.origin || '');
    if (req.method !== 'POST' || req.headers['x-pcs-ext'] !== '1' || (origin && !origin.startsWith('chrome-extension://'))) {
      return reply(403, { ok: false });
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return reply(400, { ok: false });
      }
      if (req.url === '/tick') return reply(200, handleTick(body));
      if (req.url === '/state') return reply(200, { ok: true, enabled: settings.enabled });
      if (req.url === '/open-settings') {
        // 窓を作るのに時間がかかっても拡張機能を待たせないよう、先に返事をする
        reply(200, { ok: true });
        setImmediate(openSettings);
        return undefined;
      }
      if (req.url === '/settings') {
        if (typeof body.enabled !== 'boolean') return reply(400, { ok: false });
        changeSettings({ enabled: body.enabled });
        return reply(200, { ok: true, enabled: settings.enabled });
      }
      if (req.url === '/lyrics') return reply(200, handleLyrics(body));
      return reply(404, { ok: false });
    });
  });
  server.on('error', (e) => console.error('server error', e.message));
  server.listen(PORT, '127.0.0.1');
}

// ---- ドラッグで位置を変える ----
// このモードの間だけ、クリックの通り抜けを止める。終わったら必ず通り抜けに戻す
function stopDrag() {
  if (!dragTimer) return false;
  clearInterval(dragTimer);
  dragTimer = null;
  return true;
}

function startDrag() {
  if (!moveMode || !overlay || overlay.isDestroyed()) return;
  stopDrag();
  const from = screen.getCursorScreenPoint();
  const start = overlay.getBounds();
  dragTimer = setInterval(() => {
    if (!overlay || overlay.isDestroyed()) return stopDrag();
    const now = screen.getCursorScreenPoint();
    overlay.setBounds({ x: start.x + now.x - from.x, y: start.y + now.y - from.y, width: start.width, height: start.height });
  }, 16);
}

// 今の位置を、ディスプレイの中の割合として保存する(はみ出していたら画面の中に戻す)
function saveOverlayPosition() {
  if (!overlay || overlay.isDestroyed()) return;
  const bounds = overlay.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const ratio = (offset, free) => (free > 0 ? (offset / free) * 100 : 0);
  changeSettings({
    displayId: display.id,
    x: Math.min(100, Math.max(0, ratio(bounds.x - area.x, area.width - bounds.width))),
    y: Math.min(100, Math.max(0, ratio(bounds.y - area.y, area.height - bounds.height))),
  });
}

function endDrag() {
  if (stopDrag()) saveOverlayPosition();
}

function setMoveMode(on) {
  on = !!on;
  if (on === moveMode) return;
  if (!on) endDrag();
  moveMode = on;
  if (overlay && !overlay.isDestroyed()) overlay.setIgnoreMouseEvents(!on);
  sendOverlay('move-mode', {
    on,
    hint: T('ドラッグして位置を移動できます', 'Drag to move'),
    done: T('完了', 'Done'),
  });
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('move-mode', on);
  syncWindowVisibility();
}

// ---- 設定の画面 ----
// ブラウザの後ろに隠れないよう、いったん最前面にしてから戻す
function bringToFront(win) {
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.setAlwaysOnTop(false);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    bringToFront(settingsWin);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 440,
    height: 790,
    resizable: true,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: T('歌詞オーバーレイの設定', 'Lyrics Overlay settings'),
    backgroundColor: '#17171a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.setMenu(null);
  settingsWin.once('ready-to-show', () => {
    if (settingsWin && !settingsWin.isDestroyed()) bringToFront(settingsWin);
  });
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { lang: ja ? 'ja' : 'en' } });
  previewing = true;
  sendOverlay('preview', true);
  settingsWin.on('closed', () => {
    settingsWin = null;
    setMoveMode(false);
    previewing = false;
    sendOverlay('preview', false);
  });
}

function changeSettings(patch) {
  const before = settings;
  settings = cleanSettings({ ...settings, ...patch });
  saveSettings();
  refreshOverlayWindow();
  syncWindowVisibility();
  if (before.autoStart !== settings.autoStart) applyAutoStart();
  if (before.enabled !== settings.enabled) rebuildTrayMenu();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings', settings);
}

// ---- 通知領域のアイコン ----
function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusText, enabled: false },
      { type: 'separator' },
      { label: T('歌詞を表示する', 'Show lyrics'), type: 'checkbox', checked: settings.enabled, click: (item) => changeSettings({ enabled: item.checked }) },
      { label: T('設定…', 'Settings…'), click: openSettings },
      { type: 'separator' },
      { label: T('終了', 'Quit'), click: () => app.quit() },
    ])
  );
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(image);
  tray.setToolTip('Lyrics Overlay');
  tray.on('click', openSettings);
  rebuildTrayMenu();
}

// ---- IPC ----
ipcMain.on('overlay-ready', () => {
  overlayReady = true;
  sendOverlay('settings', settings);
  if (previewing) sendOverlay('preview', true);
  if (currentId && lyricsCache.has(currentId)) pushLyrics(currentId);
});
ipcMain.on('overlay-visible', (_e, visible) => {
  wantVisible = !!visible;
  syncWindowVisibility();
});
ipcMain.on('overlay-request-lyrics', () => {
  if (currentId && lyricsCache.has(currentId)) pushLyrics(currentId);
});
ipcMain.on('overlay-move-start', startDrag);
ipcMain.on('overlay-move-end', endDrag);
ipcMain.on('overlay-move-done', () => setMoveMode(false));
ipcMain.on('settings-move-mode', (_e, on) => setMoveMode(on));
ipcMain.handle('settings-get', () => ({
  settings,
  moveMode,
  status: statusText,
  limits: LIMITS,
  displays: screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `${T('ディスプレイ', 'Display')} ${i + 1} (${d.size.width}×${d.size.height})`, primary: d.id === screen.getPrimaryDisplay().id })),
}));
ipcMain.on('settings-set', (_e, patch) => {
  if (patch && typeof patch === 'object') changeSettings(patch);
});

// ---- 自動更新 ----
function versionTuple(v) {
  return String(v).trim().split('.').map((n) => parseInt(n, 10) || 0);
}
function isNewer(remote, local) {
  const a = versionTuple(remote);
  const b = versionTuple(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}
function safeRelative(name) {
  if (name.includes('..') || path.isAbsolute(name) || !/^[\w./-]+$/.test(name)) return null;
  return name;
}
async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function checkForUpdate() {
  if (TEST_MODE || !app.isPackaged || wantVisible || moveMode) return; // 歌詞を表示している間は再起動しない
  try {
    const local = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
    const remote = (await fetchBuffer(`${UPDATE_BASE}/VERSION`)).toString('utf8').trim();
    if (!remote || !isNewer(remote, local)) return;
    const names = (await fetchBuffer(`${UPDATE_BASE}/FILES`))
      .toString('utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
    const files = [];
    for (const name of names) {
      const rel = safeRelative(name);
      if (!rel) continue;
      const content = await fetchBuffer(`${UPDATE_BASE}/${rel}`);
      if (!content.length) throw new Error(`${rel} is empty`);
      if (rel.endsWith('.js')) new vm.Script(content.toString('utf8'), { filename: rel }); // 壊れたコードは入れない
      files.push([rel, content]);
    }
    if (!files.length || wantVisible) return;
    for (const [rel, content] of files) {
      const dest = path.join(__dirname, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    fs.writeFileSync(path.join(__dirname, 'VERSION'), remote);
    app.relaunch();
    app.exit(0);
  } catch (e) {
    console.error('update check failed:', e.message);
  }
}

// ---- 起動 ----
if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 他のウィンドウに隠れていると判断されて描画が止まらないようにする
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // 拡張機能のスイッチから起動された時は、窓を開かずに裏で動くだけにする。決まったリンク以外の中身は読まない
  const linkIn = (argv) => argv.map((a) => String(a).toLowerCase()).find((a) => a.startsWith('lyricsoverlay:'));
  const wantsSettings = (argv) => {
    const link = linkIn(argv);
    return link ? link.startsWith('lyricsoverlay://settings') : false;
  };
  app.on('second-instance', (_e, argv) => {
    if (!linkIn(argv) || wantsSettings(argv)) openSettings();
  });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.skeliy.lyricsoverlay');
    ja = ja || String(app.getLocale()).toLowerCase().startsWith('ja');
    statusText = describeStatus();
    loadSettings();
    applyAutoStart();
    if (!TEST_MODE && app.isPackaged) {
      app.setAsDefaultProtocolClient('lyricsoverlay');
      // ブラウザの確認に分かりやすい名前で出るようにする
      if (process.platform === 'win32') {
        execFile('reg', ['add', 'HKCU\\Software\\Classes\\lyricsoverlay', '/ve', '/d', 'Lyrics Overlay', '/f'], { windowsHide: true }, () => {});
      }
    }
    createOverlay();
    if (!TEST_MODE) createTray();
    startServer();
    screen.on('display-metrics-changed', refreshOverlayWindow);
    screen.on('display-added', refreshOverlayWindow);
    screen.on('display-removed', refreshOverlayWindow);
    // ほかの「常に手前」のウィンドウに隠されないよう、表示中は手前に戻す(フォーカスは奪わない)
    setInterval(() => {
      if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.moveTop();
    }, 5000);
    setTimeout(checkForUpdate, 20000);
    setInterval(checkForUpdate, UPDATE_EVERY_MS);
    if (process.argv.includes('--settings') || wantsSettings(process.argv)) openSettings();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}

// このアプリは外部のページを開かない
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
