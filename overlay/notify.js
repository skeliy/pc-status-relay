// 通話とゲームの通知(Listen Together アプリの一部)。
//  - 中継サーバーに「このPCのアプリ」として登録し、通知を待ち続ける(ブラウザを閉じていても動く)
//  - だれもいなかった Discord の通話に人が入った時: Discord に似た小さな通知を右下に出し、決まった音を鳴らす
//  - 友達がゲームを起動した時: Steam に似た小さな通知を右下に出す(音なし)
//  - 自分がゲームを起動した時: 中継サーバーに知らせる(Steam のゲームは知らせない)
//  - 全画面(専用の全画面)でゲームをしている間は、通知を出さない。通話の通知は音だけ鳴らす。
//    ボーダーレス(ウィンドウの全画面)の時は、ふつうに出す
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GameWatcher } = require('./games');

const RELAY = (process.env.LISTEN_TOGETHER_RELAY || 'https://pc-status-relay.onrender.com').replace(/\/$/, '');
const CARD_GAP = 8; // 通知どうしのすき間
const PAD = 10; // 通知の窓の中の、影のための余白(toast.css の --pad と同じ)
const MAX_CARDS = 4;
const SHOW_MS = { voice: 3500, game: 6000 }; // 表示しておく時間(カーソルを乗せている間は消えない)
const SIZE = { voice: { width: 380, height: 132 }, game: { width: 320, height: 96 } }; // 影の分の余白を含む

// Windows の状態を2秒ごとに知らせる係は watch.ps1(PowerShell)。
//  q: 通知を出してよいか(SHQueryUserNotificationState。3 = 専用の全画面のゲーム、1 = 画面ロックなど)。調べられない時は -1
//  p: 動いているプログラムの一覧 [番号, 名前, 場所]

function createNotifier({ app, BrowserWindow, screen, ipcMain, getSettings, appLang, dir, testMode }) {
  const statePath = () => path.join(app.getPath('userData'), 'companion.json');
  // names: 拡張機能の名前(ext)・PC Status の名前(pc)。client / pc は拡張機能と PC Status の番号
  // (中継サーバーが「前に一緒に聴いたことのある人」を探すのに使う)
  let me = { id: null, key: null, discordId: null, sig: null, me: null, label: '', lang: '', names: {}, client: null, pc: null };
  let relayOk = null; // null = まだ分からない / true / false
  let approved = false;
  let since = 0;
  let quns = -1; // Windows が今、通知を受け付ける状態か
  let checkWorks = false; // 全画面かどうかを調べられるか
  let cards = []; // { win, kind, height }
  let soundWin = null;
  let helper = null;
  let sentKey = null; // 最後に中継サーバーへ送った名前など(変わったら送り直す)
  // 調べるための記録(拡張機能の「Copy debug info」に入る)。鍵などは入れない
  const logLines = [];
  const watch = { at: 0, count: 0, noPath: 0, lines: 0, started: 0, exits: 0 };
  function dlog(msg) {
    const d = new Date();
    const hh = (n) => String(n).padStart(2, '0');
    logLines.push(`${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())} ${msg}`);
    if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  }
  const blockedWhy = () => `q=${quns} check=${checkWorks ? 'ok' : 'no'} playing=[${[...games.playing].join(', ')}]`;

  const lang = () => (me.lang === 'ja' || me.lang === 'en' ? me.lang : appLang());
  const T = (j, e) => (lang() === 'ja' ? j : e);
  const active = () => {
    const s = getSettings();
    return !!(s.voiceNotify || s.gameNotify);
  };

  // ---- 覚えておくこと(中継サーバーでの番号・だれに割り当てられたか) ----
  function load() {
    try {
      me = Object.assign(me, JSON.parse(fs.readFileSync(statePath(), 'utf8')));
    } catch (e) {}
    approved = !!me.discordId;
    me.names = me.names && typeof me.names === 'object' ? me.names : {};
    if (me.label && !me.names.ext) me.names.ext = me.label; // 1.3.0 までの覚え方
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify(me, null, 2));
    } catch (e) {}
  }

  // ---- 中継サーバー ----
  async function call(method, p, body) {
    const res = await fetch(RELAY + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 40000 : 15000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const winUser = () => {
    try {
      return os.userInfo().username || '';
    } catch (e) {
      return '';
    }
  };
  const displayName = () => me.names.ext || me.names.pc || winUser() || 'PC';
  const profileKey = () => JSON.stringify([me.names.ext || '', me.names.pc || '', me.client || '', me.pc || '', lang()]);

  // PC Status(エージェント)が動いていれば、その名前と番号を聞く(拡張機能から名前が届かない時の代わり)
  async function askAgent() {
    if (testMode && !process.env.LISTEN_TOGETHER_AGENT) return;
    const base = process.env.LISTEN_TOGETHER_AGENT || 'http://127.0.0.1:8787';
    try {
      const res = await fetch(base + '/whoami', { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return;
      const d = await res.json();
      let changed = false;
      const label = typeof d.label === 'string' ? d.label.trim().slice(0, 40) : '';
      if (label && label !== me.names.pc) (me.names.pc = label), (changed = true);
      if (typeof d.pc === 'string' && d.pc && d.pc !== me.pc) (me.pc = d.pc.slice(0, 80)), (changed = true);
      if (changed) save();
    } catch (e) {}
  }

  async function hello() {
    await askAgent();
    const label = displayName();
    const key = profileKey();
    const r = await call('POST', '/api/companion/hello', {
      id: me.id,
      key: me.key,
      label, // 古い中継サーバー向け
      extLabel: me.names.ext || '',
      pcLabel: me.names.pc || '',
      winUser: winUser(),
      client: me.client || '',
      pc: me.pc || '',
      lang: lang(),
      discordId: me.discordId,
      sig: me.sig,
    });
    if (r.status === 403 && r.data.error === 'bad-key') {
      me.id = me.key = null; // 番号が使えなくなっていたら、新しく登録し直す
      return hello();
    }
    if (r.status !== 200 || !r.data.id) throw new Error('hello ' + r.status);
    me.id = r.data.id;
    me.key = r.data.key;
    if (r.data.approved) {
      me.discordId = r.data.discordId;
      me.sig = r.data.sig;
      me.me = r.data.me || me.me;
    }
    approved = !!r.data.approved;
    if (r.data.id !== me.lastId) since = 0; // 新しく登録し直した時だけ、受信箱を最初から読む
    me.lastId = r.data.id;
    sentKey = key;
    save();
    relayOk = true;
  }

  async function loop() {
    let needHello = true;
    const startedAt = Date.now();
    let askedAt = 0;
    for (;;) {
      if (!active()) {
        await sleep(3000);
        continue;
      }
      // はじめて登録する時は、拡張機能から名前が届くのを少し待つ(skeliy に届く知らせに、分かる名前を出すため)
      if (!me.id && !me.names.ext && !me.names.pc && Date.now() - startedAt < 60000) {
        if (Date.now() - askedAt >= 10000) {
          askedAt = Date.now();
          await askAgent();
          if (me.names.pc) continue;
        }
        await sleep(1000);
        continue;
      }
      try {
        if (needHello) {
          await hello();
          needHello = false;
        }
        const r = await call('GET', `/api/companion/poll?id=${encodeURIComponent(me.id)}&key=${encodeURIComponent(me.key)}&since=${since}`);
        if (r.status === 401) {
          dlog('poll 401: relay forgot us, hello again');
          needHello = true; // 中継サーバーが再起動して、こちらを忘れた
          continue;
        }
        if (r.status !== 200) throw new Error('poll ' + r.status);
        if (!relayOk) dlog('relay connected');
        relayOk = true;
        if (r.data.seq < since) since = 0;
        else since = r.data.seq;
        for (const m of r.data.messages || []) handle(m);
      } catch (e) {
        if (relayOk) dlog('relay error: ' + e.message);
        relayOk = false;
        needHello = true;
        await sleep(5000);
      }
    }
  }

  function handle(m) {
    const s = getSettings();
    const who = (m.user && m.user.name) || '?';
    if (m.type === 'game') dlog(`got game: ${who} ${m.game} (game notify ${s.gameNotify ? 'on' : 'off'})`);
    else if (m.type === 'voice') dlog(`got voice: ${who} (voice notify ${s.voiceNotify ? 'on' : 'off'})`);
    else dlog('got ' + m.type);
    if (m.type === 'assigned') {
      me.discordId = m.discordId || null;
      me.sig = m.sig || null;
      me.me = m.me || null;
      approved = !!me.discordId;
      save();
    } else if (m.type === 'voice' && s.voiceNotify) {
      if (Date.now() - (m.at || Date.now()) > 60000) return dlog('  -> not shown: too old'); // 古すぎるお知らせは出さない
      notifyVoice(m);
    } else if (m.type === 'game' && s.gameNotify) {
      if (Date.now() - (m.at || Date.now()) > 60000) return dlog('  -> not shown: too old');
      notifyGame(m);
    }
  }

  async function reportGame(game) {
    const s = getSettings();
    dlog(`game started here: ${game}`);
    // ゲームの通知を切っている人は、自分のゲームも知らせない
    if (!s.gameNotify) return dlog('  -> not sent: game notify is off');
    if (!me.id) return dlog('  -> not sent: not registered yet');
    if (!approved) return dlog('  -> not sent: not assigned on /admin yet');
    try {
      const r = await call('POST', '/api/companion/game', { id: me.id, key: me.key, game });
      const d = r.data || {};
      if (r.status !== 200) dlog(`  -> relay said ${r.status} ${d.error || ''}`);
      else if (d.skipped) dlog(`  -> relay skipped: ${d.skipped} (same game within 10 min)`);
      else if (Array.isArray(d.to)) dlog(`  -> sent to ${d.sent}: ${d.to.map((t) => t.name + (t.online ? '' : ' (offline)')).join(', ') || 'nobody'}`);
      else dlog('  -> sent');
    } catch (e) {
      dlog('  -> send failed: ' + e.message);
    }
  }

  // ---- 全画面かどうか ----
  // 専用の全画面(3)・画面ロック(1)の時は、通知を出さない。
  // 調べられない PC では、ゲームが動いている間は全画面だとみなす(ゲームの邪魔をしないため)
  function blocked() {
    if (quns === 3 || quns === 1) return true;
    if (!checkWorks) return games.playing.size > 0;
    return false;
  }

  const games = new GameWatcher({ onStart: (g) => reportGame(g) });
  let lastPlaying = '';

  function startHelper() {
    const fake = process.env.LISTEN_TOGETHER_WATCH_CMD; // テストで使う
    if (!fake && process.platform !== 'win32') return;
    const child = fake
      ? spawn('node', [fake], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(dir, 'watch.ps1')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    helper = child;
    watch.started++;
    dlog('watcher started');
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          watch.lines++;
          const q = Number.isFinite(j.q) ? j.q : -1;
          if (q !== quns) dlog(`screen state ${quns} -> ${q} (3 = fullscreen, 1 = locked)`);
          quns = q;
          if (quns > 0) checkWorks = true;
          if (j.full !== false && Array.isArray(j.p)) {
            watch.at = Date.now();
            watch.count = j.p.length;
            watch.noPath = j.p.filter((x) => !x[2]).length;
            games.update(j.p);
            const now = [...games.playing].sort().join(', ');
            if (now !== lastPlaying) dlog(`games running: [${now}]`);
            lastPlaying = now;
          }
        } catch (e) {}
      }
    });
    child.on('exit', (code) => {
      watch.exits++;
      dlog('watcher stopped (code ' + code + '), restart in 10s');
      helper = null;
      setTimeout(startHelper, 10000); // 止まったら少し待って起動し直す
    });
  }

  // ---- 音 ----
  function ensureSound() {
    if (soundWin && !soundWin.isDestroyed()) return soundWin;
    soundWin = new BrowserWindow({ show: false, width: 10, height: 10, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    soundWin.loadFile(path.join(dir, 'sound.html'));
    soundWin.on('closed', () => (soundWin = null));
    return soundWin;
  }
  function playSound() {
    const w = ensureSound();
    const go = () => w.webContents.executeJavaScript('window.play && window.play()').catch(() => {});
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go);
    else go();
  }

  // ---- 右下の通知 ----
  function layout() {
    const area = screen.getPrimaryDisplay().workArea;
    let bottom = area.y + area.height - 12 + PAD; // 見える通知の下端が、画面の下から 12px になるように
    for (const c of cards) {
      const size = SIZE[c.kind];
      const y = bottom - size.height;
      if (!c.win.isDestroyed()) c.win.setBounds({ x: area.x + area.width - size.width - 12 + PAD, y, width: size.width, height: size.height });
      bottom = y + 2 * PAD - CARD_GAP; // 影の余白の分だけ重ねて、見えるすき間を CARD_GAP にする
    }
  }

  function closeCard(card) {
    clearTimeout(card.timer);
    cards = cards.filter((c) => c !== card);
    if (!card.win.isDestroyed()) card.win.destroy();
    layout();
  }

  function showCard(kind, data) {
    while (cards.length >= MAX_CARDS) closeCard(cards[0]);
    const size = SIZE[kind];
    const win = new BrowserWindow({
      ...size,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { preload: path.join(dir, 'toast_preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    const card = { win, kind, timer: null };
    cards.unshift(card); // 新しいものを一番下に
    layout();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.loadFile(path.join(dir, 'toast.html'), { query: { kind, lang: lang() } });
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('toast-data', data);
      win.showInactive(); // 今使っている画面からフォーカスを奪わない
      win.setAlwaysOnTop(true, 'screen-saver');
    });
    const arm = () => {
      clearTimeout(card.timer);
      card.timer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send('toast-leave');
        setTimeout(() => closeCard(card), 260);
      }, SHOW_MS[kind]);
    };
    card.arm = arm;
    arm();
    return card;
  }

  const findCard = (sender) => cards.find((c) => !c.win.isDestroyed() && c.win.webContents === sender);
  ipcMain.on('toast-hold', (e, hold) => {
    const c = findCard(e.sender);
    if (!c) return;
    if (hold) clearTimeout(c.timer);
    else c.arm();
  });
  ipcMain.on('toast-close', (e) => {
    const c = findCard(e.sender);
    if (c) closeCard(c);
  });

  function notifyVoice(m) {
    playSound(); // 全画面の時も、音だけは鳴らす
    if (blocked()) return dlog('  -> sound only (fullscreen/locked): ' + blockedWhy());
    dlog('  -> shown');
    showCard('voice', {
      guildName: (m.guild && m.guild.name) || 'Discord',
      guildIcon: (m.guild && m.guild.icon) || null,
      name: (m.user && m.user.name) || '?',
      avatar: (m.user && m.user.avatar) || null,
      text: T(`${(m.channel && m.channel.name) || ''} の通話に参加しました`, `joined the call in ${(m.channel && m.channel.name) || ''}`),
    });
  }

  function notifyGame(m) {
    if (blocked()) return dlog('  -> not shown (fullscreen/locked/in a game): ' + blockedWhy()); // ゲームの通知は音なし。全画面の時は何もしない
    dlog('  -> shown');
    showCard('game', {
      name: (m.user && m.user.name) || '?',
      avatar: (m.user && m.user.avatar) || null,
      playing: T('プレイ中', 'is playing'),
      game: m.game || '',
    });
  }

  // ---- 外から使うもの ----
  function start() {
    load();
    if (!testMode || process.env.LISTEN_TOGETHER_RELAY) loop();
    startHelper();
  }

  // 拡張機能から届く: extLabel(拡張機能の名前)、label(古い拡張機能用。PC Status の名前のこともある)、
  // pcLabel(PC Status の名前)、client / pc(番号)、lang
  function setProfile(p) {
    const { label, lang: l } = p || {};
    let changed = false;
    const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    const ext = str(p && typeof p.extLabel === 'string' ? p.extLabel : label, 40); // 新しい拡張機能は extLabel を別に送る
    if (ext && ext !== me.names.ext) (me.names.ext = ext), (me.label = ext), (changed = true);
    const pcl = str(p && p.pcLabel, 40);
    if (pcl && pcl !== me.names.pc) (me.names.pc = pcl), (changed = true);
    const client = str(p && p.client, 80);
    if (client && client !== me.client) (me.client = client), (changed = true);
    const pc = str(p && p.pc, 80);
    if (pc && pc !== me.pc) (me.pc = pc), (changed = true);
    if ((l === 'ja' || l === 'en') && l !== me.lang) {
      me.lang = l;
      changed = true;
    }
    if (changed) save();
    // 名前が変わったら、中継サーバーにも伝える(割り当てのページに新しい名前で出るように)
    if (me.id && sentKey !== null && profileKey() !== sentKey) hello().catch((e) => dlog('hello failed: ' + e.message));
  }

  function test(kind) {
    const who = me.me || { name: me.names.ext || me.names.pc || T('あなた', 'You'), avatar: null };
    if (kind === 'game') {
      notifyGameForce({ user: who, game: 'VALORANT' });
    } else {
      playSound();
      showCard('voice', {
        guildName: T('テスト', 'Test'),
        guildIcon: null,
        name: who.name,
        avatar: who.avatar,
        text: T('General の通話に参加しました', 'joined the call in General'),
      });
    }
  }
  function notifyGameForce(m) {
    showCard('game', { name: m.user.name, avatar: m.user.avatar, playing: T('プレイ中', 'is playing'), game: m.game });
  }

  function state() {
    return {
      voice: !!getSettings().voiceNotify,
      game: !!getSettings().gameNotify,
      registered: !!me.id,
      approved,
      me: me.me || null,
      relay: relayOk,
      fullscreenCheck: checkWorks,
      showing: cards.length,
    };
  }

  // 拡張機能の「Copy debug info」に入れるもの(鍵・署名は入れない)
  function debug() {
    const s = getSettings();
    return {
      registered: !!me.id,
      id: me.id ? me.id.slice(0, 6) + '…' : null,
      assigned: approved,
      me: me.me ? me.me.name : null,
      names: me.names,
      settings: { voice: !!s.voiceNotify, game: !!s.gameNotify },
      relay: relayOk,
      screen: { q: quns, check: checkWorks },
      watcher: {
        running: !!helper,
        started: watch.started,
        stopped: watch.exits,
        lines: watch.lines,
        lastList: watch.at ? Math.round((Date.now() - watch.at) / 1000) + 's ago' : 'never',
        processes: watch.count,
        withoutPath: watch.noPath,
      },
      playing: [...games.playing],
      showing: cards.length,
      log: logLines.slice(),
    };
  }

  return { start, setProfile, test, state, debug, _debug: { handle, blocked, games, setQuns: (q, works) => ((quns = q), (checkWorks = works)), cards: () => cards } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { createNotifier };
