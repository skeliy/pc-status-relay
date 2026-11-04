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
let passes = {}; // 部屋 -> { room, owner, pass: { nonce, sig } } … パスワードか招待で一度入った部屋の通行証(途中参加に使う)
const roomStatus = new Map(); // 部屋 -> { open, owner, members, playing, at } … 通行証で確かめた部屋の様子
let learned = {}; // 見つからなかった曲の代わりに自分で選んだ曲 「サービス|曲名|アーティスト」→ 番号(次からは最初からこの曲を流す)
let friends = {}; // 一緒に聴いたことのある人の拡張機能の番号 -> { f, s, l } … 友達カード(その人が曲を流している部屋に入れる)
let friendRooms = []; // 友達が今いる部屋 [{ room, owner, friends, members, playing }]
const invites = new Map(); // 招待コード -> { room, owner, fromLabel, code, expiresAt, members }
const agent = { data: null, okAt: 0, checkingPromise: null, retryAt: 0, failSince: 0 };
const AGENT_GRACE_MS = 20000; // エージェントの返事が一時的に途切れても、この間は前の部屋のまま続ける
const room = { key: null, creds: null, since: -1, members: [], known: [], you: null, owner: null, connected: false, polling: false, lastTickAt: 0 };
let reloadScheduled = false;
let notice = null; // { msg: { key, args }, until } 画面に一時的に出す知らせ(表示する時に今の言語で文にする)
let lang = 'en'; // 画面の言語(初期は英語。アイコンの画面で切り替える)
const L = (key, ...args) => PcsI18n.t(lang, key, ...args);

const engine = new PcsSync.SyncEngine({
  send: (data) => roomSend('state', data),
  log,
  lookupOwnId: (service, song) => learnedId(service, song),
  onLearn: (service, desc, id) => learnSubstitute(service, desc, id),
});

function setNotice(key, args, seconds) {
  notice = { msg: { key, args: args || [] }, until: Date.now() + (seconds || 8) * 1000 };
}

async function loadAll() {
  if (loaded) return;
  const st = await chrome.storage.local.get(['guestCreds', 'client', 'lang', 'passes', 'friends', 'learned']);
  passes = st.passes || {};
  learned = st.learned || {};
  friends = st.friends || {};
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
    await savePass(inv.room, j.owner, j.pass);
    useCreds(currentCreds());
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

// 部屋に入った時: 自分で選んだ音楽サービスのタブを前に出す。無ければ開く
// (ほかのサービスのタブ、たとえば動画を見ている YouTube が開いていても、選んだサービスのタブを使う)
async function openServiceIfNeeded(service) {
  const key = SERVICE_URLS[service] ? service : 'apple';
  const pattern = MUSIC_URL_PATTERNS[Object.keys(SERVICE_URLS).indexOf(key)];
  const existing = await chrome.tabs.query({ url: pattern });
  if (existing.length) {
    const tab = existing.find((t) => t.active) || existing.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {}
    return false;
  }
  await chrome.tabs.create({ url: SERVICE_URLS[key] });
  return true;
}

// 拡張機能だけで入っている時は、自分で選んだサービスのタブを優先して使う
function preferredService() {
  const c = room.creds;
  if (c && c.mode === 'guest') return (guest && guest.service) || (client && client.service) || null;
  return null;
}

// ツールバーのアイコンの印: 招待が来ていれば赤い「!」、一緒に聴いていれば人数
function updateBadge() {
  const others = room.connected ? room.members.filter((m) => m.id !== room.you).length : 0;
  const live = liveRooms();
  if (invites.size > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#fa2d48' });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setTitle({ title: L('titleInvite') });
  } else if (others > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#3ecf8e' });
    chrome.action.setBadgeText({ text: String(others + 1) });
    chrome.action.setTitle({ title: L('titleListening', room.members.map((m) => m.label).join(L('sep'))) });
  } else if (live.length) {
    // 前に入った部屋で、今だれかが曲を流している → 押せば途中から参加できる
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
    chrome.action.setBadgeText({ text: '♪' });
    chrome.action.setTitle({ title: L('titleLive', live[0].owner || live[0].room) });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: L('brand') });
  }
}

// ---------------------------------------------------------------- 通行証(途中参加)
async function savePass(roomId, owner, pass) {
  if (!roomId || !pass || !pass.nonce || !pass.sig) return;
  // k は部屋の鍵を暗号化したもの(中継サーバーが再起動しても、これでホストとして開き直せる)
  const p = { nonce: pass.nonce, sig: pass.sig };
  if (typeof pass.k === 'string') p.k = pass.k;
  passes[roomId] = { room: roomId, owner: owner || roomId, pass: p };
  await chrome.storage.local.set({ passes });
}

// 前に入った部屋が開いていて、自分以外のだれかが曲を流している(今その部屋に入っていない時だけ)
function liveRooms() {
  const out = [];
  for (const [id, st] of roomStatus) {
    if (!st.open || !st.playing) continue;
    if (room.creds && room.creds.id === id && room.connected) continue;
    out.push({ room: id, owner: st.owner });
  }
  for (const r of friendRooms) {
    if (!r.playing || out.some((x) => x.room === r.room)) continue;
    if (room.creds && room.creds.id === r.room && room.connected) continue;
    out.push({ room: r.room, owner: r.owner });
  }
  return out;
}

// 一緒に聴いた人の友達カードを覚える(同じ部屋にいる間、中継サーバーが渡してくる)
function saveCards(cards) {
  let changed = false;
  for (const c of cards || []) {
    if (!c || !c.f || !c.s) continue;
    const cur = friends[c.f];
    if (!cur || cur.s !== c.s || cur.l !== c.l) {
      friends[c.f] = { f: c.f, s: c.s, l: c.l || (cur && cur.l) || '' };
      changed = true;
    }
  }
  if (changed) chrome.storage.local.set({ friends });
}

function friendAuth() {
  return {
    client: client && client.client,
    key: client && client.key,
    friends: Object.values(friends).map((x) => ({ f: x.f, s: x.s })),
    agent: (agent.data && agent.data.agentCard) || undefined,
  };
}

// 友達が今どの部屋で曲を流しているか
async function checkFriends() {
  if (!client || !client.client) return;
  try {
    const resp = await fetch(`${RELAY}/api/client/friends`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(friendAuth()),
    });
    if (!resp.ok) return;
    const j = await resp.json();
    friendRooms = j.rooms || [];
  } catch (e) {}
}

// 友達のいる部屋に入る(入っていた部屋からは出る。同時に2つは入らない)
async function joinFriend(roomId) {
  await loadAll();
  if (!client) await registerClient();
  if (!client) return { ok: false, error: 'noServer' };
  try {
    // PC Status で友達の部屋に入っていれば、先にそこから出る
    if (agent.data && agent.data.room && agent.data.room.role === 'friend') {
      try {
        await postAgent('/ext/action', { action: 'stop' });
      } catch (e) {}
      agent.okAt = 0;
      await refreshAgent();
    }
    const resp = await fetch(`${RELAY}/api/room/join-friend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ room: roomId, label: client.label || undefined, service: client.service }, friendAuth())),
    });
    const j = await resp.json();
    if (!resp.ok) return { ok: false, error: 'joinFailedClosed' };
    if (guest && guest.room !== roomId) await leaveGuestRoom('switch');
    const fr = friendRooms.find((r) => r.room === roomId);
    guest = { relay: RELAY, room: roomId, token: j.token, label: client.label || 'guest', service: client.service || 'apple', owner: j.owner || (fr && fr.owner) };
    await chrome.storage.local.set({ guestCreds: guest });
    if (j.pass) await savePass(roomId, j.owner, j.pass);
    useCreds(currentCreds());
    const opened = await openServiceIfNeeded(guest.service);
    friendRooms = friendRooms.filter((r) => r.room !== roomId);
    updateBadge();
    return { ok: true, opened };
  } catch (e) {
    return { ok: false, error: 'noServer' };
  }
}

// 拡張機能だけの人が、どの部屋にも入らずに曲を流している時は、自分の部屋を開いておく
// (一緒に聴いたことのある人が、アイコンから入ってこられるように)
let selfHostAt = 0;
async function hostSelfIfNeeded(state) {
  if (currentCreds() || !client || !client.client) return;
  if (agent.data) return; // PC Status の人は、エージェントがいつも自分の部屋を開いている
  if (!state || !state.isPlaying || !state.song) return;
  if (Date.now() - selfHostAt < 15000) return;
  selfHostAt = Date.now();
  try {
    const resp = await fetch(`${RELAY}/api/room/host-self`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: client.client, key: client.key, label: client.label || undefined, service: client.service || state.service }),
    });
    const j = await resp.json();
    if (!resp.ok || !j.token || currentCreds()) return;
    guest = { relay: RELAY, room: j.room, token: j.token, label: client.label || 'guest', service: client.service || state.service, owner: j.owner, self: true };
    await chrome.storage.local.set({ guestCreds: guest });
    useCreds(currentCreds());
    log('自分の部屋を開きました', j.room);
  } catch (e) {}
}

// ---------------------------------------------------------------- 言語の違う曲名
// 日本のストア・日本語の画面で選ばれた曲は、曲名・アーティスト名が日本語(カタカナ)で届く。受け取った側は
//   1. まず送った人の言語で探す(YouTube 系は送った人の言語で検索、Apple Music は送った人の国のストアでも探す)
//   2. 見つからなければ、Apple の公開カタログ(iTunes Search API)で、その曲の「受け取った人の国・言語での名前」を調べて探し直す
//   3. それでも見つからなければ、「探す」ボタンで自分で探してもらい、流した曲をその曲の代わりにする(覚えておく)
let myLocale = { lang: null, cc: null, service: null };
const retried = new Set(); // 調べ直した曲

function nameKey(d) {
  const n = (x) => String(x || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return n(d && d.title) + '|' + n(d && d.artist);
}

function countryFor(lang, cc) {
  if (cc && /^[a-z]{2}$/i.test(cc)) return cc.toLowerCase();
  return { ja: 'jp', ko: 'kr', zh: 'tw', fr: 'fr', de: 'de', es: 'es', pt: 'br', it: 'it' }[lang] || 'us';
}

async function itunes(path, params) {
  const u = new URL('https://itunes.apple.com' + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(u.toString(), { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return [];
    return (await r.json()).results || [];
  } finally {
    clearTimeout(timer);
  }
}

function looseName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・·\-‐–—_.,!?'"“”‘’()（）\[\]【】「」『』]/g, '');
}

function nameScore(a, b) {
  a = looseName(a);
  b = looseName(b);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  return 0;
}

// その曲の、受け取った人の国・言語での名前(と英語の名前)を調べる
async function namesInMyLanguage(desc) {
  const fromCc = countryFor(desc.lang, desc.cc);
  const toCc = countryFor(myLocale.lang, myLocale.cc);
  const dur = Number(desc.duration) || 0;
  let list = await itunes('/search', { term: [desc.title, desc.artist].filter(Boolean).join(' '), entity: 'song', country: fromCc, limit: 25 });
  if (!list.length && desc.title) list = await itunes('/search', { term: desc.title, entity: 'song', country: fromCc, limit: 25 });
  const ranked = list
    .filter((x) => nameScore(x.trackName, desc.title) > 0)
    .map((x) => ({
      x,
      s: nameScore(x.trackName, desc.title) * 2 + nameScore(x.artistName, desc.artist) - (dur && x.trackTimeMillis ? Math.min(4, Math.abs(x.trackTimeMillis / 1000 - dur) / 4) : 0),
    }))
    .sort((a, b) => b.s - a.s);
  const hit = ranked[0] && ranked[0].x;
  if (!hit) return [];
  const names = [];
  const seen = new Set([nameKey(desc)]);
  const add = (x) => {
    if (!x || !x.trackName) return;
    const n = { title: x.trackName, artist: x.artistName || '' };
    if (seen.has(nameKey(n))) return;
    seen.add(nameKey(n));
    names.push(n);
  };
  // Apple の曲の番号はどの国のストアでも共通なので、受け取った人の国のストアでの名前を直接調べられる
  const tries = [[toCc, null], [toCc, 'en_us'], [fromCc, 'en_us']];
  for (const [cc, lang] of tries) {
    try {
      add((await itunes('/lookup', { id: hit.trackId, country: cc, lang }))[0]);
    } catch (e) {}
  }
  // 受け取った人の国のストアに同じ番号が無い時は、アーティストと長さで探す
  if (!names.length) {
    try {
      const artist = (names[0] && names[0].artist) || hit.artistName;
      const near = (await itunes('/search', { term: artist, entity: 'song', country: toCc, limit: 100 })).filter(
        (x) => x.trackTimeMillis && hit.trackTimeMillis && Math.abs(x.trackTimeMillis - hit.trackTimeMillis) < 1500
      );
      if (near.length === 1) add(near[0]);
    } catch (e) {}
  }
  return names;
}

let retryBusy = false;
async function retryInMyLanguage() {
  const sh = engine.shared;
  if (retryBusy || !engine.notFound || !sh || sh.mine || engine.substitute) return;
  const key = (myLocale.service || '') + '|' + nameKey(sh.desc);
  if (retried.has(key)) return;
  retried.add(key);
  retryBusy = true;
  try {
    const names = await namesInMyLanguage(sh.desc);
    log('別の名前:', JSON.stringify(names));
    if (names.length) engine.retryWithAlts(sh.desc, names);
  } catch (e) {
    log('別の名前を調べられませんでした', String(e));
  } finally {
    retryBusy = false;
  }
}

// それでも見つからない時: 「探す」を押すと、自分のサービスの検索画面を開く。そこで流した曲を、その曲の代わりにする
function findSongUi() {
  const sh = engine.shared;
  if (!engine.notFound || !sh || sh.mine || engine.substitute) return null;
  if (retryBusy || !retried.has((myLocale.service || '') + '|' + nameKey(sh.desc))) return null; // まだ調べ直している
  return { title: sh.desc.title || '', artist: sh.desc.artist || '' };
}

function searchUrl(service, q) {
  const e = encodeURIComponent(q);
  if (service === 'spotify') return `https://open.spotify.com/search/${e}/tracks`;
  if (service === 'ytm') return `https://music.youtube.com/search?q=${e}`;
  if (service === 'youtube') return `https://www.youtube.com/results?search_query=${e}`;
  return `https://music.apple.com/${countryFor(myLocale.lang, myLocale.cc)}/search?term=${e}`;
}

async function findSongManually() {
  const sh = engine.shared;
  const p = primaryTab();
  if (!sh || !p || !p.state) return;
  const alts = (sh.desc.alts || []).filter((n) => n && n.title);
  const name = alts.length ? alts[alts.length - 1] : sh.desc; // 調べた「自分の言語での名前」があればそちら
  engine.startSubstitute(180);
  setNotice('pickSubstitute', [sh.desc.title || ''], 30);
  try {
    await chrome.tabs.update(p.id, { url: searchUrl(p.state.service, [name.title, name.artist].filter(Boolean).join(' ')), active: true });
  } catch (e) {}
}

function learnedKey(service, d) {
  return service + '|' + nameKey(d);
}

function learnedId(service, song) {
  return learned[learnedKey(service, song)] || (song.isrc && learned[service + '|isrc:' + song.isrc]) || null;
}

function learnSubstitute(service, desc, id) {
  learned[learnedKey(service, desc)] = id;
  if (desc.isrc) learned[service + '|isrc:' + desc.isrc] = id;
  const keys = Object.keys(learned);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete learned[k];
  chrome.storage.local.set({ learned });
}

let peekAt = 0;
async function peekRooms(force) {
  await loadAll();
  const ids = Object.keys(passes);
  if (!force && Date.now() - peekAt < 20000) return;
  peekAt = Date.now();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const resp = await fetch(`${RELAY}/api/room/peek`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: id, pass: passes[id].pass }),
        });
        const j = await resp.json();
        if (resp.status === 403 && j.error === 'bad-pass') {
          // パスワードが変わった → この通行証はもう使えない
          delete passes[id];
          roomStatus.delete(id);
          await chrome.storage.local.set({ passes });
          return;
        }
        if (!resp.ok) return;
        roomStatus.set(id, {
          open: !!j.open,
          canHost: !j.open && j.canHost !== false,
          owner: j.owner || passes[id].owner,
          members: j.members || [],
          playing: j.playing || null,
          at: Date.now(),
        });
        if (j.owner && passes[id].owner !== j.owner) {
          passes[id].owner = j.owner;
          await chrome.storage.local.set({ passes });
        }
      } catch (e) {}
    })
  );
  await checkFriends();
  updateBadge();
}

// 前に入った部屋に通行証で入る。部屋が閉じていれば、自分がホストとして開く(ホストは同時に1人だけ。
// もう誰かがホストをしていれば、その部屋に参加する)
async function hostRoom(roomId) {
  await loadAll();
  const p = passes[roomId];
  if (!p) return { ok: false, error: 'passInvalid' };
  if (!client) await registerClient();
  const body = {
    room: roomId,
    pass: p.pass,
    label: client ? client.label : undefined,
    service: client ? client.service : undefined,
    client: client ? client.client : undefined,
    key: client ? client.key : undefined,
  };
  const post = (action) =>
    fetch(`${RELAY}/api/room/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let resp = await post('host');
    let j = await resp.json();
    if (resp.status === 404 && j.error === 'not found') {
      resp = await post('rejoin'); // 中継サーバーが古い
      j = await resp.json();
    }
    if (!resp.ok) {
      if (j.error === 'bad-pass') {
        delete passes[roomId];
        roomStatus.delete(roomId);
        await chrome.storage.local.set({ passes });
        return { ok: false, error: 'passInvalid' };
      }
      return { ok: false, error: 'joinFailedClosed' };
    }
    if (guest && guest.room !== roomId) await leaveGuestRoom('switch');
    guest = { relay: RELAY, room: roomId, token: j.token, label: client ? client.label : 'guest', service: client ? client.service : 'apple', owner: j.owner };
    await chrome.storage.local.set({ guestCreds: guest });
    if (j.pass) await savePass(roomId, j.owner, j.pass);
    useCreds(currentCreds());
    if (j.host) setNotice('youHost', [], 8);
    const opened = await openServiceIfNeeded(guest.service);
    peekAt = 0;
    updateBadge();
    return { ok: true, opened, host: !!j.host };
  } catch (e) {
    return { ok: false, error: 'noServer' };
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

// 更新係(GitHub から2時間ごとに新しい版を入れるタスク)やエージェントが、このフォルダの中身を新しくした時は、
// 自分で読み込み直す。一緒に聴いている最中は、曲が途切れないよう、終わるまで待つ
async function checkOwnFolder() {
  try {
    const resp = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const diskVersion = (await resp.json()).version;
    if (!diskVersion || diskVersion === MY_VERSION) return;
    const others = room.connected ? room.members.filter((m) => m.id !== room.you).length : 0;
    if (others > 0) return;
    log('新しい版が入ったので読み込み直します:', MY_VERSION, '→', diskVersion);
    await maybeReload(diskVersion);
  } catch (e) {}
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
  const a = agent.data && agent.data.room && agent.data.room.token ? agent.data.room : null;
  const g = guest ? Object.assign({ mode: 'guest', role: guest.self ? 'self' : 'guest', id: guest.room }, guest) : null;
  // PC Status の人でも、アイコンの画面や参加ページから自分で入った・ホストした部屋があれば、そちらを使う
  // (エージェントが友達の部屋に入っている時と、同じ部屋の時はエージェントのほう)
  if (a && g && a.role !== 'friend' && a.id !== g.id) return g;
  if (a) return Object.assign({ relay: RELAY, mode: 'agent' }, a);
  return g;
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
  room.host = null;
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
        // 自分の拡張機能の番号も付ける(友達に「今この部屋にいる」と分かるように)
        const who = client && client.client ? `&client=${encodeURIComponent(client.client)}&key=${encodeURIComponent(client.key)}` : '';
        const url = `${c.relay}/api/room/poll?room=${encodeURIComponent(c.id)}&token=${encodeURIComponent(c.token)}&since=${room.since}${who}`;
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
        room.host = data.host || null;
        room.since = data.seq;
        wait = 1000;
        saveCards(data.cards);
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
  } else if (m.type === 'host') {
    if (m.from === room.you) setNotice('youHostNow', [], 8);
    else setNotice('hostNotice', [m.fromLabel], 6);
  }
}

function onKicked(c) {
  log('部屋から外れました');
  room.connected = false;
  if (c.mode === 'guest') {
    // 自分で出た後(タブを閉じた・退出を押した)に届いた「もう部屋にいない」は、知らせない
    const leftOnPurpose = !guest || guest.token !== c.token;
    if (guest && guest.token === c.token) {
      guest = null;
      chrome.storage.local.remove('guestCreds');
    }
    if (!leftOnPurpose) setNotice('kicked', [], 10);
    useCreds(currentCreds());
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
  // 部屋に自分しかいなくても送る(一緒に聴いたことのある人に、今流れている曲が見えるように)
  const p = primaryTab();
  await roomPost('send', { type, data, service: p && p.state ? p.state.service : undefined });
}

// 拡張機能だけの人が部屋を出る(タブを閉じた時・「退出」を押した時)
async function leaveGuestRoom(reason) {
  const c = room.creds;
  if (!guest) return;
  // 先に「自分で出た」ことにしておく(出る途中に届く「もう部屋にいない」を、追い出されたと勘違いしないため)
  guest = null;
  await chrome.storage.local.remove('guestCreds');
  if (c && c.mode === 'guest') {
    try {
      await fetch(`${c.relay}/api/room/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: c.id, token: c.token }),
      });
    } catch (e) {}
  }
  useCreds(currentCreds());
  log('部屋を出ました', reason);
}

// 自分の部屋を終わらせる(入ってきた人も全員出る。1人で流し続けていれば、また自分の部屋が開く)
async function endSelfRoom() {
  const c = room.creds;
  if (!guest || !guest.self || !c) return;
  const g = guest;
  guest = null;
  await chrome.storage.local.remove('guestCreds');
  try {
    await fetch(`${c.relay}/api/room/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: g.room, token: g.token }),
    });
  } catch (e) {}
  selfHostAt = Date.now();
  useCreds(currentCreds());
}

// ---------------------------------------------------------------- タブ
function primaryTab() {
  const now = Date.now();
  for (const [id, t] of tabs) if (now - t.at > TAB_ALIVE_MS) tabs.delete(id);
  const pref = preferredService();
  const hasPref = !!pref && Array.from(tabs.values()).some((t) => t.state && t.state.available && t.state.service === pref);
  let best = null;
  for (const t of tabs.values()) {
    if (!t.state || !t.state.available) continue;
    if (hasPref && t.state.service !== pref) continue;
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
  if (state && state.service) myLocale = { lang: state.lang || myLocale.lang, cc: state.cc || myLocale.cc, service: state.service };
  if (engine.notFound) retryInMyLanguage();

  await refreshAgent();
  // PC Status で友達の部屋に入った(Ctrl+Alt+M の許可)→ アイコンなどから入っていた部屋からは出る(同時に2つは入らない)
  if (guest && agent.data && agent.data.room && agent.data.room.role === 'friend') await leaveGuestRoom('agent-joined');
  if (state && state.isPlaying && !currentCreds()) await hostSelfIfNeeded(state);
  const creds = currentCreds();
  useCreds(creds);
  if (creds && !room.polling) pollLoop(room.key);

  let commands = [];
  const primary = primaryTab();
  const isPrimary = primary && primary.id === tabId;
  if (isPrimary && room.connected && state && state.available) {
    // 1人の時も、今流している曲を部屋に送っておく(一緒に聴いたことのある人のアイコンに「流れている曲」と「参加する」が出るように)
    commands = engine.onLocal(state, { broadcast: true });
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
      ? {
          id: creds.id,
          owner: room.owner || creds.owner || null,
          members: room.members,
          known: room.known,
          you: room.you,
          host: room.host || null,
          role: creds.role || 'guest',
        }
      : null,
    connected: room.connected,
    incoming: aui.incoming || [],
    invites: Array.from(invites.values()).map((i) => ({ code: i.code, fromLabel: i.fromLabel, owner: i.owner })),
    pending: !!aui.pending,
    hotkey: aui.hotkey || null,
    needsClick: !!(isPrimary && engine.needsClick && room.members.length > 1),
    notice: (isPrimary && !findSongUi() && engine.currentNotice()) || n,
    findSong: isPrimary ? findSongUi() : null,
    substituting: !!(isPrimary && engine.substitute),
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
  } else if (action === 'find-song') {
    await findSongManually();
  } else if (action === 'join-friend') {
    const r = await joinFriend(body.room);
    if (!r.ok) setNotice(r.error, [], 8);
  } else if (action === 'end-self') {
    await endSelfRoom();
  } else if (action === 'rejoin' || action === 'host') {
    const r = await hostRoom(body.room);
    if (!r.ok) setNotice(r.error, [], 8);
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
  await savePass(creds.room, creds.owner, creds.pass);
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
  useCreds(currentCreds());
  const opened = await openServiceIfNeeded(creds.service);
  return { ok: true, opened };
}

// ツールバーのアイコンを押した時の画面(popup.js)に渡す情報
async function popupState() {
  await loadAll();
  await refreshAgent();
  const p = primaryTab();
  await Promise.race([peekRooms(false), new Promise((r) => setTimeout(r, 1500))]);
  const rooms = Object.values(passes).map((p) => {
    const st = roomStatus.get(p.room) || null;
    return {
      room: p.room,
      owner: (st && st.owner) || p.owner,
      known: !!st,
      open: !!(st && st.open),
      canHost: !!(st && st.canHost),
      members: st ? st.members : [],
      playing: st ? st.playing : null,
      current: !!(room.creds && room.creds.id === p.room),
      pass: true,
    };
  });
  // 一緒に聴いたことのある人が、今曲を流している部屋(通行証の部屋と同じなら、そちらにまとめる)
  for (const r of friendRooms) {
    if (!r.playing) continue;
    const same = rooms.find((x) => x.room === r.room);
    if (same) {
      same.friend = true;
      same.open = true;
      same.playing = r.playing;
      same.members = r.members;
      continue;
    }
    rooms.push({ room: r.room, owner: r.owner, known: true, open: true, members: r.members, playing: r.playing, friend: true, current: !!(room.creds && room.creds.id === r.room) });
  }
  return {
    version: MY_VERSION,
    rooms,
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
  if (a.name === 'keep-offscreen') {
    ensureOffscreen();
    await loadAll();
    checkOwnFolder();
    peekRooms(true);
  }
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
