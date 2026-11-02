// 拡張機能の裏方。
//
//  - 音楽サービスのページ(content.js)から、今の曲・再生状態が0.5秒ごとに届く
//    (Apple Music / Spotify / YouTube Music / YouTube)
//  - どの「部屋」に入っているかを決める
//      * このPCでエージェント(PC Status)が動いていれば、エージェントが教えてくれる部屋
//        (自分の部屋、または Ctrl+Alt+M で許可した友達の部屋)
//      * エージェントが無い人(拡張機能だけの人)は、参加ページか招待で入った部屋
//  - 部屋の他の人とは中継サーバー経由でやり取りし、同期の判断は sync_engine.js が行う
//  - 拡張機能だけの人への招待は、画面に出ないページ(offscreen.js)が待ち受ける。
//    届いたら通知音を鳴らし、ツールバーのアイコンに印を付け、通知を出す(アイコンを押すと参加できる)
//  - 曲のタブを閉じたら、部屋から出る(また入るには、もう一度招待を受け取る)
importScripts('sync_engine.js', 'i18n.js');

const RELAY = 'https://pc-status-relay.onrender.com';
const AGENT_URL = 'http://127.0.0.1:8788';
const MY_VERSION = chrome.runtime.getManifest().version;
const TAB_ALIVE_MS = 3000;
const SERVICE_URLS = { apple: 'https://music.apple.com/', spotify: 'https://open.spotify.com/', ytm: 'https://music.youtube.com/', youtube: 'https://www.youtube.com/' };
const MUSIC_URL_PATTERNS = ['https://music.apple.com/*', 'https://open.spotify.com/*', 'https://music.youtube.com/*', 'https://www.youtube.com/*'];
const SITE_SCRIPTS = [
  { match: 'https://music.apple.com/*', main: ['match.js', 'apple.js'] },
  { match: 'https://open.spotify.com/*', main: ['match.js', 'spotify.js'] },
  { match: 'https://music.youtube.com/*', main: ['match.js', 'ytm.js'] },
  { match: 'https://www.youtube.com/*', main: ['match.js', 'youtube.js'] },
];

const log = (...a) => console.log('[一緒に聴く]', ...a);
const tabs = new Map(); // tabId -> { at, state, lastPlaying }
let guest = null; // 参加ページ・招待で入った部屋 { relay, room, token, label, service, owner }
let client = null; // この拡張機能の受信箱 { client, key, label, service }
let loaded = false;
const invites = new Map(); // 招待コード -> { room, owner, fromLabel, code, expiresAt, members }
const agent = { data: null, okAt: 0, checkingPromise: null, retryAt: 0, failSince: 0 };
const AGENT_GRACE_MS = 20000; // エージェントの返事が一時的に途切れても、この間は前の部屋のまま続ける
const room = { key: null, creds: null, since: -1, members: [], known: [], you: null, owner: null, connected: false, polling: false, lastTickAt: 0 };
let reloadScheduled = false;
let notice = null; // { msg: { key, args }, until } 画面に一時的に出す知らせ(表示する時に今の言語で文にする)
let lang = 'en'; // 画面の言語(初期は英語。アイコンの画面で切り替える)
const L = (key, ...args) => PcsI18n.t(lang, key, ...args);

const engine = new PcsSync.SyncEngine({ send: (data) => roomSend('state', data), log });

function setNotice(key, args, seconds) {
  notice = { msg: { key, args: args || [] }, until: Date.now() + (seconds || 8) * 1000 };
}

async function loadAll() {
  if (loaded) return;
  const st = await chrome.storage.local.get(['guestCreds', 'client', 'lang']);
  lang = PcsI18n.norm(st.lang);
  guest = st.guestCreds || null;
  client = st.client || null;
  loaded = true;
  if (!client || !client.client) registerClient();
}

// ---------------------------------------------------------------- 受信箱(招待を受け取るため)
async function registerClient(profile) {
  const cur = client || {};
  const body = {
    client: cur.client,
    key: cur.key,
    label: (profile && profile.label) || cur.label || '',
    service: (profile && profile.service) || cur.service || 'none',
  };
  try {
    const resp = await fetch(`${RELAY}/api/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await resp.json();
    if (j.client) {
      client = { client: j.client, key: j.key, label: body.label, service: body.service };
      await chrome.storage.local.set({ client });
    }
  } catch (e) {
    log('受信箱の登録に失敗', String(e));
  }
  return client;
}

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: '音楽のタブが開いていない時も、一緒に聴く招待を待ち受けて通知音を鳴らすため',
    });
  } catch (e) {
    // すでに作られている途中など
  }
}

function playSound() {
  ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: 'play-sound' }).catch(() => {}));
}

async function handleInbox(messages) {
  await loadAll();
  for (const m of messages || []) {
    if (m.type !== 'invite' || Date.now() > m.expiresAt) continue;
    invites.set(m.code, m);
    log('招待が届いた', m.fromLabel, m.room);
    playSound();
    try {
      chrome.notifications.create('invite:' + m.code, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: L('brand'),
        message: L('notifyMessage', m.fromLabel, m.owner),
        buttons: [{ title: L('join') }, { title: L('decline') }],
        priority: 2,
      });
    } catch (e) {}
    setTimeout(() => {
      if (invites.get(m.code) === m) {
        invites.delete(m.code);
        chrome.notifications.clear('invite:' + m.code);
        updateBadge();
      }
    }, Math.max(0, m.expiresAt - Date.now()));
  }
  updateBadge();
}

async function acceptInvite(code) {
  const inv = invites.get(code);
  if (!inv) return { ok: false, error: 'inviteExpired' };
  invites.delete(code);
  chrome.notifications.clear('invite:' + code);
  try {
    const resp = await fetch(`${RELAY}/api/room/accept-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: inv.room, code, client: client.client, key: client.key }),
    });
    const j = await resp.json();
    if (!resp.ok) {
      updateBadge();
      return { ok: false, error: j.error === 'invite expired' ? 'inviteExpired' : 'joinFailedClosed' };
    }
    guest = { relay: RELAY, room: inv.room, token: j.token, label: client.label, service: client.service, owner: j.owner };
    await chrome.storage.local.set({ guestCreds: guest });
    if (!(agent.data && agent.data.room)) useCreds(currentCreds());
    const opened = await openServiceIfNeeded(client.service);
    updateBadge();
    return { ok: true, opened };
  } catch (e) {
    updateBadge();
    return { ok: false, error: 'noServer' };
  }
}

async function declineInvite(code) {
  const inv = invites.get(code);
  invites.delete(code);
  chrome.notifications.clear('invite:' + code);
  updateBadge();
  if (!inv) return { ok: true };
  try {
    await fetch(`${RELAY}/api/room/decline-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: inv.room, code, client: client.client, key: client.key }),
    });
  } catch (e) {}
  return { ok: true };
}

async function openServiceIfNeeded(service) {
  const existing = await chrome.tabs.query({ url: MUSIC_URL_PATTERNS });
  if (existing.length) return false;
  const url = SERVICE_URLS[service] || SERVICE_URLS.apple;
  await chrome.tabs.create({ url });
  return true;
}

// ツールバーのアイコンの印: 招待が来ていれば赤い「!」、一緒に聴いていれば人数
function updateBadge() {
  const others = room.connected ? room.members.filter((m) => m.id !== room.you).length : 0;
  if (invites.size > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#fa2d48' });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setTitle({ title: L('titleInvite') });
  } else if (others > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#3ecf8e' });
    chrome.action.setBadgeText({ text: String(others + 1) });
    chrome.action.setTitle({ title: L('titleListening', room.members.map((m) => m.label).join(L('sep'))) });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: L('brand') });
  }
}

// ---------------------------------------------------------------- エージェント
async function refreshAgent() {
  const now = Date.now();
  if (now < agent.retryAt) return;
  if (agent.checkingPromise) return agent.checkingPromise;
  if (now - agent.okAt < 1000 && agent.data) return;
  agent.checkingPromise = (async () => {
    try {
      const primary = primaryTab();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(AGENT_URL + '/ext/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PCS-Ext': '1' },
        body: JSON.stringify({
          extVersion: MY_VERSION,
          service: primary && primary.state ? primary.state.service : null,
          members: room.members,
          you: room.you,
          connected: room.connected,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('agent ' + resp.status);
      agent.data = await resp.json();
      agent.okAt = Date.now();
      agent.failSince = 0;
      maybeReload(agent.data.extVersion);
    } catch (e) {
      const t = Date.now();
      if (!agent.failSince) agent.failSince = t;
      if (agent.data && t - agent.failSince < AGENT_GRACE_MS) {
        agent.retryAt = t + 2000; // 少し前まで繋がっていた(再起動中など)→ すぐまた試す
      } else {
        if (agent.data) log('エージェントに繋がらなくなりました');
        agent.data = null;
        agent.retryAt = t + 10000; // エージェントが無いPCでは、10秒おきにだけ確かめる
      }
    } finally {
      agent.checkingPromise = null;
    }
  })();
  return agent.checkingPromise;
}

// エージェントのフォルダにある拡張機能が自動アップデートで新しくなったら、自分を読み込み直す
async function maybeReload(diskVersion) {
  if (!diskVersion || diskVersion === MY_VERSION || reloadScheduled) return;
  const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
  if (reloadedFor === diskVersion) return; // 別のフォルダから読み込まれている(読み込み直しても変わらない)
  reloadScheduled = true;
  await chrome.storage.local.set({ reloadedFor: diskVersion });
  setTimeout(() => chrome.runtime.reload(), 300);
}

async function postAgent(path, body) {
  const resp = await fetch(AGENT_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PCS-Ext': '1' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ---------------------------------------------------------------- 部屋
function currentCreds() {
  if (agent.data && agent.data.room && agent.data.room.token) {
    return Object.assign({ relay: RELAY, mode: 'agent' }, agent.data.room);
  }
  if (guest) return Object.assign({ mode: 'guest', role: 'guest', id: guest.room }, guest);
  return null;
}

function useCreds(creds) {
  const key = creds ? `${creds.relay}|${creds.id}|${creds.token}` : null;
  if (key === room.key) return;
  log('部屋を切り替え:', creds ? `${creds.id} (${creds.mode})` : 'なし');
  room.key = key;
  room.creds = creds;
  room.since = -1;
  room.members = [];
  room.known = [];
  room.you = null;
  room.connected = false;
  engine.reset();
  updateBadge();
  if (creds) pollLoop(key);
}

async function pollLoop(key) {
  if (room.polling) return;
  room.polling = true;
  let wait = 1000;
  try {
    while (room.key === key && Date.now() - room.lastTickAt < 6000) {
      const c = room.creds;
      try {
        const url = `${c.relay}/api/room/poll?room=${encodeURIComponent(c.id)}&token=${encodeURIComponent(c.token)}&since=${room.since}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (room.key !== key) break;
        if (resp.status === 403) {
          onKicked(c);
          break;
        }
        if (!resp.ok) throw new Error('poll ' + resp.status);
        const data = await resp.json();
        if (room.key !== key) break;
        const before = room.members.map((m) => m.id).join(',');
        room.connected = true;
        room.members = data.members || [];
        room.known = data.known || [];
        room.you = data.you;
        room.owner = data.owner;
        room.since = data.seq;
        wait = 1000;
        if (before !== room.members.map((m) => m.id).join(',')) updateBadge();
        for (const m of data.messages || []) handleRoomMessage(m, data.serverNow);
      } catch (e) {
        room.connected = false;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 15000);
      }
    }
  } finally {
    room.polling = false;
  }
}

function handleRoomMessage(m, serverNow) {
  const age = Math.max(0, (serverNow - m.at) / 1000);
  if (m.type === 'state') {
    engine.onRemote(m.data || {}, age, m.fromLabel);
  } else if (m.type === 'joined') {
    if (m.from !== room.you) setNotice('joinedNotice', [m.fromLabel], 6);
    // 新しく来た人にも今の曲を流すため、こちらで流れていれば送り直す
    const p = primaryTab();
    if (p) setTimeout(() => engine.announce(p.state), 300);
  } else if (m.type === 'left') {
    setNotice('leftNotice', [m.fromLabel], 6);
  } else if (m.type === 'declined') {
    setNotice('declinedNotice', [m.fromLabel], 6);
  }
}

function onKicked(c) {
  log('部屋から外れました');
  room.connected = false;
  if (c.mode === 'guest') {
    guest = null;
    chrome.storage.local.remove('guestCreds');
    setNotice('kicked', [], 10);
    useCreds(null);
  } else {
    agent.okAt = 0; // エージェントに新しい鍵をもらい直す
    useCreds(null);
  }
}

async function roomPost(action, body) {
  const c = room.creds;
  if (!c) return null;
  try {
    const resp = await fetch(`${c.relay}/api/room/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ room: c.id, token: c.token }, body || {})),
    });
    return await resp.json();
  } catch (e) {
    log(`${action} に失敗`, e);
    return null;
  }
}

async function roomSend(type, data) {
  if (!room.creds || !room.connected) return;
  if (room.members.length < 2) return; // 部屋に自分しかいなければ送る必要がない
  const p = primaryTab();
  await roomPost('send', { type, data, service: p && p.state ? p.state.service : undefined });
}

// 拡張機能だけの人が部屋を出る(タブを閉じた時・「退出」を押した時)
async function leaveGuestRoom(reason) {
  const c = room.creds;
  if (!guest) return;
  if (c && c.mode === 'guest') await roomPost('leave', {});
  guest = null;
  await chrome.storage.local.remove('guestCreds');
  useCreds(currentCreds());
  log('部屋を出ました', reason);
}

// ---------------------------------------------------------------- タブ
function primaryTab() {
  const now = Date.now();
  for (const [id, t] of tabs) if (now - t.at > TAB_ALIVE_MS) tabs.delete(id);
  let best = null;
  for (const t of tabs.values()) {
    if (!t.state || !t.state.available) continue;
    if (!best || (t.lastPlaying || 0) > (best.lastPlaying || 0) || ((t.lastPlaying || 0) === (best.lastPlaying || 0) && t.at > best.at)) best = t;
  }
  return best;
}

// 曲のタブが全部閉じられたら、部屋から出る(また入るには、もう一度招待を受け取る)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadAll();
  const wasMusic = tabs.has(tabId);
  tabs.delete(tabId);
  if (!wasMusic) return;
  const remaining = await chrome.tabs.query({ url: MUSIC_URL_PATTERNS });
  if (remaining.length) return;
  const c = room.creds;
  if (c && c.mode === 'guest') {
    await leaveGuestRoom('tab-closed');
  } else if (c && c.mode === 'agent' && c.role === 'friend') {
    try {
      await postAgent('/ext/action', { action: 'tab-closed' });
    } catch (e) {}
    agent.okAt = 0;
  }
});

async function handleTick(tabId, body) {
  await loadAll();
  const now = Date.now();
  room.lastTickAt = now;
  const state = body.state || null;
  const prev = tabs.get(tabId) || {};
  const entry = { id: tabId, at: now, state, lastPlaying: state && state.isPlaying ? now : prev.lastPlaying };
  tabs.set(tabId, entry);
  for (const r of body.results || []) engine.onResult(r);

  await refreshAgent();
  const creds = currentCreds();
  useCreds(creds);
  if (creds && !room.polling) pollLoop(room.key);

  let commands = [];
  const primary = primaryTab();
  const isPrimary = primary && primary.id === tabId;
  if (isPrimary && room.connected && state && state.available) {
    const others = room.members.length > 1;
    if (others || engine.target) commands = engine.onLocal(state, { broadcast: others });
    // みんなのキューにある次の曲を、前もって自分のサービスで探しておく(曲が変わった時にすぐ流せるように)
    if (others && !commands.length) {
      const pre = engine.nextPrefetch(state);
      if (pre) commands = [pre];
    }
  }
  return { commands, ui: buildUi(isPrimary, state) };
}

function buildUi(isPrimary, state) {
  const creds = room.creds;
  const a = agent.data || {};
  const aui = a.ui || {};
  const mode = creds ? creds.mode : agent.data ? 'agent' : 'none';
  const n = notice && Date.now() < notice.until ? notice.msg : null;
  return {
    lang,
    mode,
    room: creds
      ? { id: creds.id, owner: room.owner || creds.owner || null, members: room.members, known: room.known, you: room.you, role: creds.role || 'guest' }
      : null,
    connected: room.connected,
    incoming: aui.incoming || [],
    invites: Array.from(invites.values()).map((i) => ({ code: i.code, fromLabel: i.fromLabel, owner: i.owner })),
    pending: !!aui.pending,
    hotkey: aui.hotkey || null,
    needsClick: !!(isPrimary && engine.needsClick && room.members.length > 1),
    notice: (isPrimary && engine.currentNotice()) || n,
    queue: room.members.length > 1 ? engine.displayQueue() : [],
    loginNeeded: !!(state && state.service === 'spotify' && state.loggedIn === false && creds),
    versionMismatch: !!(a.extVersion && a.extVersion !== MY_VERSION),
  };
}

async function handleAction(body) {
  await loadAll();
  const action = body.action;
  if (action === 'leave') {
    await leaveGuestRoom('button');
  } else if (action === 'invite') {
    const r = await roomPost('invite', { target: body.target });
    const names = ((r && r.invited) || []).map((x) => x.label).join(L('sep'));
    if (names) setNotice('invitedTo', [names], 6);
    else setNotice('inviteFailed', [], 6);
  } else if (action === 'accept-invite') {
    const r = await acceptInvite(body.code);
    if (!r.ok) setNotice(r.error, [], 8);
  } else if (action === 'decline-invite') {
    await declineInvite(body.code);
  } else if (['request', 'cancel', 'stop', 'accept', 'decline'].includes(action) && agent.data) {
    try {
      await postAgent('/ext/action', { action, sessionId: body.sessionId });
    } catch (e) {}
    agent.okAt = 0;
    await refreshAgent();
    useCreds(currentCreds());
  }
  const p = primaryTab();
  return { ui: buildUi(true, p && p.state) };
}

// 参加ページでパスワードが通った(listen.js から)
async function handleGuestJoin(creds, sender) {
  await loadAll();
  const origin = sender && sender.url ? new URL(sender.url).origin : '';
  if (origin !== RELAY || !creds || creds.relay !== RELAY || !creds.token || !creds.room) {
    return { ok: false, error: '参加ページ以外からは参加できません' };
  }
  guest = { relay: RELAY, room: creds.room, token: creds.token, label: creds.label, service: creds.service, owner: creds.owner };
  await chrome.storage.local.set({ guestCreds: guest });
  // 名前とサービスを受信箱に登録し、部屋とつなげる(次からは招待で入れるように)
  await registerClient({ label: creds.label, service: creds.service });
  if (client) {
    try {
      await fetch(`${RELAY}/api/room/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: creds.room, token: creds.token, client: client.client, key: client.key }),
      });
    } catch (e) {}
  }
  if (!(agent.data && agent.data.room)) useCreds(currentCreds());
  const opened = await openServiceIfNeeded(creds.service);
  return { ok: true, opened };
}

// ツールバーのアイコンを押した時の画面(popup.js)に渡す情報
async function popupState() {
  await loadAll();
  await refreshAgent();
  const p = primaryTab();
  return {
    version: MY_VERSION,
    client: client ? { label: client.label, service: client.service } : null,
    hasAgent: !!agent.data,
    ui: buildUi(true, p && p.state),
    musicTabOpen: !!p,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  let work = null;
  if (message.type === 'tick' && sender.tab) work = handleTick(sender.tab.id, message.body || {}).then((d) => ({ ok: true, data: d }));
  else if (message.type === 'action') work = handleAction(message.body || {}).then((d) => ({ ok: true, data: d }));
  else if (message.type === 'guest-join') work = handleGuestJoin(message.creds, sender);
  else if (message.type === 'popup-state') work = popupState().then((d) => ({ ok: true, data: d }));
  else if (message.type === 'set-profile')
    work = registerClient({ label: message.label, service: message.service }).then(() => ({ ok: true }));
  else if (message.type === 'offscreen-get-client') work = loadAll().then(() => client);
  else if (message.type === 'client-invalid') work = registerClient().then(() => ({ ok: true }));
  else if (message.type === 'inbox') work = handleInbox(message.messages).then(() => ({ ok: true }));
  if (!work) return false;
  work.then((data) => sendResponse(data)).catch((e) => {
    log('エラー', e);
    sendResponse({ ok: false, error: String(e) });
  });
  return true;
});

// 通知のボタン(参加する / 断る)と、通知そのものを押した時
chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  if (!id.startsWith('invite:')) return;
  await loadAll();
  const code = id.slice('invite:'.length);
  if (index === 0) await acceptInvite(code);
  else await declineInvite(code);
});
chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('invite:')) return;
  await loadAll();
  await acceptInvite(id.slice('invite:'.length));
});

// 画面に出ないページを、ブラウザの起動時や、裏方が起こされた時に用意しておく
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
  loadAll();
});
chrome.alarms.create('keep-offscreen', { periodInMinutes: 1 });
// 一時停止したまま裏に回したタブは、ブラウザが1分に1回くらいしか動かさなくなる。
// タブを閉じていない限り部屋に残れるよう、30秒ごとに「まだいる」と中継サーバーに知らせる
chrome.alarms.create('room-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'keep-offscreen') ensureOffscreen();
  if (a.name === 'room-keepalive') {
    await loadAll();
    const open = await chrome.tabs.query({ url: MUSIC_URL_PATTERNS });
    if (!open.length) return;
    if (!room.creds) {
      await refreshAgent();
      useCreds(currentCreds());
    }
    if (room.creds) await roomPost('members', {});
  }
});
ensureOffscreen();
loadAll();

// アイコンの画面で言語を切り替えた時
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lang) return;
  lang = PcsI18n.norm(changes.lang.newValue);
  updateBadge();
});

// 読み込み直した・入れた直後は、もう開いている音楽サービスのタブにも仕組みを入れ直す
// (タブを再読み込みすると曲が止まってしまうので、再読み込みはしない)
chrome.runtime.onInstalled.addListener(async () => {
  ensureOffscreen();
  for (const site of SITE_SCRIPTS) {
    const list = await chrome.tabs.query({ url: site.match });
    for (const tab of list) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: site.main, world: 'MAIN' });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['i18n.js', 'content.js'] });
      } catch (e) {}
    }
  }
});
