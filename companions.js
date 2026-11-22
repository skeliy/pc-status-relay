// Listen Together アプリ(PC に入れるアプリ)の受け付けと、Discord の通話の見張り。
//
//  - Discord のボット(環境変数 DISCORD_BOT_TOKEN)で、サーバー(DISCORD_GUILD_ID)の通話を見張る。
//    だれもいなかった通話に1人目が入った時だけ、アプリを入れた人に知らせる
//  - アプリは、ゲームを起動した時に知らせてくる。それを、アプリを入れたほかの人に配る
//  - アプリを入れた人が Discord のだれなのかは、持ち主(skeliy)が /admin のページで選ぶ。
//    選ばれるまでは、その人には何も届かない(知らない人に通話の様子が伝わらないように)
//  - 選んだ結果には署名を付けてアプリに渡す。このサーバーが再起動して覚えていたことを忘れても、
//    アプリが署名を見せれば元に戻る(サーバーに保存場所が無いため)
'use strict';

const crypto = require('crypto');

const GUILD_ID = process.env.DISCORD_GUILD_ID || '1377680403904598177';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const API = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/$/, '');
const GATEWAY = process.env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json';
const OWNER_DISCORD_ID = process.env.DISCORD_OWNER_ID || '';
const SIGN_KEY = crypto
  .createHash('sha256')
  .update('listen-together-companion:' + (process.env.OWNER_TOKEN || process.env.WRITE_TOKEN || 'dev'))
  .digest();
const POLL_WAIT_MS = 25000;
const QUEUE_TTL_MS = 2 * 60 * 1000;
const MAX_COMPANIONS = 60;
const GAME_REPEAT_MS = 10 * 60 * 1000; // 同じ人が同じゲームを、すぐ起動し直した時は知らせない

const companions = Object.create(null); // id -> { key, label, lang, discordId, sig, lastSeen, seq, queue, waiters, created }
const lastGame = new Map(); // `${discordId}|${game}` -> 時刻

// ---------------------------------------------------------------- Discord
const discord = {
  ready: false,
  status: BOT_TOKEN ? 'connecting' : 'no-token',
  guild: { id: GUILD_ID, name: '', icon: null, ownerId: null },
  channels: new Map(), // id -> name
  overwrites: new Map(), // チャンネル id -> 権限の上書き [{ id, type, allow, deny }]
  roles: new Map(), // ロール id -> 権限(BigInt)
  members: new Map(), // id -> { id, name, username, avatar, bot, roles }
  voice: new Map(), // userId -> channelId
};

function avatarUrl(userId, user, member) {
  if (member && member.avatar) return `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${userId}/avatars/${member.avatar}.png?size=128`;
  if (user && user.avatar) return `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png?size=128`;
  let n = 0;
  try {
    n = Number((BigInt(userId) >> 22n) % 6n);
  } catch (e) {}
  return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}

function rememberMember(m) {
  if (!m || !m.user || !m.user.id) return null;
  const u = m.user;
  const rec = {
    id: u.id,
    name: m.nick || u.global_name || u.username || u.id,
    username: u.username || '',
    avatar: avatarUrl(u.id, u, m),
    bot: !!u.bot,
    roles: Array.isArray(m.roles) ? m.roles.map(String) : null,
  };
  discord.members.set(u.id, rec);
  return rec;
}

function rememberChannel(c) {
  if (!c || !c.id) return;
  discord.channels.set(c.id, c.name);
  discord.overwrites.set(c.id, Array.isArray(c.permission_overwrites) ? c.permission_overwrites : []);
}
function rememberRole(r) {
  if (!r || !r.id) return;
  try {
    discord.roles.set(r.id, BigInt(r.permissions || '0'));
  } catch (e) {}
}

// その人が、そのチャンネルを見られるか(Discord の権限の決まりと同じ順で計算する)
//  1. @everyone と持っているロールの権限を合わせる(管理者なら何でも見られる)
//  2. チャンネルの上書き: @everyone → ロール(拒否をまとめて外してから、許可をまとめて足す)→ その人だけの上書き
// 分からない時(ロールやチャンネルの情報が無い)は「見られない」として、知らせない
const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;
function canView(userId, channelId) {
  if (!userId || !channelId) return false;
  if (discord.guild.ownerId && userId === discord.guild.ownerId) return true;
  const m = discord.members.get(userId);
  const ow = discord.overwrites.get(channelId);
  if (!m || !m.roles || !ow || !discord.roles.has(GUILD_ID)) return false;
  let perms = discord.roles.get(GUILD_ID);
  for (const r of m.roles) perms |= discord.roles.get(r) || 0n;
  if (perms & ADMINISTRATOR) return true;
  const big = (v) => {
    try {
      return BigInt(v || '0');
    } catch (e) {
      return 0n;
    }
  };
  const everyone = ow.find((o) => o.id === GUILD_ID);
  if (everyone) perms = (perms & ~big(everyone.deny)) | big(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of ow) {
    if (o.type === 0 && o.id !== GUILD_ID && m.roles.includes(o.id)) {
      allow |= big(o.allow);
      deny |= big(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const mine = ow.find((o) => o.type === 1 && o.id === userId);
  if (mine) perms = (perms & ~big(mine.deny)) | big(mine.allow);
  return (perms & VIEW_CHANNEL) !== 0n;
}

function guildIcon() {
  return discord.guild.icon ? `https://cdn.discordapp.com/icons/${GUILD_ID}/${discord.guild.icon}.png?size=64` : null;
}

async function rest(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: Object.assign({ Authorization: `Bot ${BOT_TOKEN}` }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function memberInfo(userId) {
  if (discord.members.has(userId)) return discord.members.get(userId);
  if (!BOT_TOKEN) return null;
  try {
    return rememberMember(await rest('GET', `/guilds/${GUILD_ID}/members/${userId}`));
  } catch (e) {
    return null;
  }
}

// 持ち主(skeliy)に DM を送る(新しくアプリを入れた人がいた時)
let ownerIdCache = OWNER_DISCORD_ID || null;
async function dmOwner(text) {
  if (!BOT_TOKEN) return;
  try {
    if (!ownerIdCache) {
      const app = await rest('GET', '/oauth2/applications/@me');
      ownerIdCache = (app.team && app.team.owner_user_id) || (app.owner && app.owner.id) || null;
    }
    if (!ownerIdCache) return;
    const ch = await rest('POST', '/users/@me/channels', { recipient_id: ownerIdCache });
    await rest('POST', `/channels/${ch.id}/messages`, { content: text });
  } catch (e) {
    console.warn('[discord] DM failed:', e.message);
  }
}

// だれもいなかった通話に、1人目(ボット以外)が入った時
function onVoiceState(d) {
  if (!d || d.guild_id !== GUILD_ID || !d.user_id) return;
  const member = d.member ? rememberMember(d.member) : discord.members.get(d.user_id);
  const isBot = !!(member && member.bot);
  const before = discord.voice.get(d.user_id) || null;
  if (d.channel_id) discord.voice.set(d.user_id, d.channel_id);
  else discord.voice.delete(d.user_id);
  if (!d.channel_id || d.channel_id === before || isBot) return;
  let count = 0;
  for (const [uid, ch] of discord.voice) {
    if (ch !== d.channel_id) continue;
    const m = discord.members.get(uid);
    if (!(m && m.bot)) count += 1;
  }
  if (count !== 1) return;
  const who = member || { id: d.user_id, name: d.user_id, avatar: avatarUrl(d.user_id) };
  notifyVoice(who, d.channel_id).catch((e) => console.warn('[discord] voice notify failed:', e.message));
}

async function notifyVoice(who, channelId) {
  const msg = {
    type: 'voice',
    guild: { name: discord.guild.name, icon: guildIcon() },
    user: { id: who.id, name: who.name, avatar: who.avatar },
    channel: { id: channelId, name: discord.channels.get(channelId) || '' },
  };
  // 受け取る人のロールが分からない時は、先に Discord に聞いておく
  const ids = new Set(Object.values(companions).map((c) => c.discordId).filter((id) => id && id !== who.id));
  for (const id of ids) {
    const m = discord.members.get(id);
    if (!m || !m.roles) {
      discord.members.delete(id);
      await memberInfo(id);
    }
  }
  broadcast(
    msg,
    // 自分が入った時は自分には知らせない。その通話チャンネルを見る権限が無い人にも知らせない
    (c) => c.discordId !== who.id && canView(c.discordId, channelId)
  );
}

function onGuildCreate(g) {
  if (!g || g.id !== GUILD_ID) return;
  discord.guild.name = g.name || '';
  discord.guild.icon = g.icon || null;
  discord.guild.ownerId = g.owner_id || null;
  discord.channels.clear();
  discord.overwrites.clear();
  for (const c of g.channels || []) rememberChannel(c);
  discord.roles.clear();
  for (const r of g.roles || []) rememberRole(r);
  for (const m of g.members || []) rememberMember(m);
  discord.voice.clear();
  for (const v of g.voice_states || []) if (v.channel_id) discord.voice.set(v.user_id, v.channel_id); // 今いる人は数えるだけ(知らせない)
  discord.ready = true;
  discord.status = 'ready';
}

let ws = null;
let hbTimer = null;
let acked = true;
let seqNo = null;
let intents = (1 << 0) | (1 << 1) | (1 << 7); // GUILDS + GUILD_MEMBERS + GUILD_VOICE_STATES
let backoff = 2000;
let stopped = false;

function connect() {
  if (!BOT_TOKEN || stopped || typeof WebSocket !== 'function') {
    if (BOT_TOKEN && typeof WebSocket !== 'function') discord.status = 'no-websocket';
    return;
  }
  discord.status = 'connecting';
  const sock = new WebSocket(GATEWAY);
  ws = sock;
  sock.addEventListener('message', (ev) => {
    let p;
    try {
      p = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch (e) {
      return;
    }
    if (p.s != null) seqNo = p.s;
    if (p.op === 10) {
      clearInterval(hbTimer);
      acked = true;
      const send = () => {
        if (!acked) return sock.close(4000); // 返事が来ない時は繋ぎ直す
        acked = false;
        sock.send(JSON.stringify({ op: 1, d: seqNo }));
      };
      hbTimer = setInterval(send, p.d.heartbeat_interval);
      sock.send(
        JSON.stringify({
          op: 2,
          d: { token: BOT_TOKEN, intents, large_threshold: 250, properties: { os: 'linux', browser: 'pc-status-relay', device: 'pc-status-relay' } },
        })
      );
    } else if (p.op === 11) {
      acked = true;
    } else if (p.op === 1) {
      sock.send(JSON.stringify({ op: 1, d: seqNo }));
    } else if (p.op === 7 || p.op === 9) {
      sock.close(4001);
    } else if (p.op === 0) {
      backoff = 2000;
      const d = p.d;
      if (p.t === 'GUILD_CREATE') onGuildCreate(d);
      else if (p.t === 'VOICE_STATE_UPDATE') onVoiceState(d);
      else if ((p.t === 'GUILD_MEMBER_ADD' || p.t === 'GUILD_MEMBER_UPDATE') && d.guild_id === GUILD_ID) rememberMember(d);
      else if ((p.t === 'CHANNEL_CREATE' || p.t === 'CHANNEL_UPDATE') && d.guild_id === GUILD_ID) rememberChannel(d);
      else if (p.t === 'CHANNEL_DELETE' && d.guild_id === GUILD_ID) {
        discord.channels.delete(d.id);
        discord.overwrites.delete(d.id);
      } else if ((p.t === 'GUILD_ROLE_CREATE' || p.t === 'GUILD_ROLE_UPDATE') && d.guild_id === GUILD_ID) rememberRole(d.role);
      else if (p.t === 'GUILD_ROLE_DELETE' && d.guild_id === GUILD_ID) discord.roles.delete(d.role_id);
      else if (p.t === 'GUILD_UPDATE' && d.id === GUILD_ID) {
        discord.guild.name = d.name || discord.guild.name;
        discord.guild.icon = d.icon || null;
        discord.guild.ownerId = d.owner_id || discord.guild.ownerId;
        for (const r of d.roles || []) rememberRole(r);
      }
    }
  });
  sock.addEventListener('close', (ev) => {
    clearInterval(hbTimer);
    if (ws === sock) ws = null;
    discord.ready = false;
    if (ev.code === 4004) {
      discord.status = 'bad-token';
      return; // トークンが違う。何度やっても同じなので止める
    }
    if (ev.code === 4014 && intents & (1 << 1)) {
      intents &= ~(1 << 1); // メンバーの一覧を見る許可が無い時は、無しで繋ぎ直す
    }
    discord.status = 'reconnecting';
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  });
  sock.addEventListener('error', () => {});
}

// ---------------------------------------------------------------- アプリ
const sign = (id, discordId) => crypto.createHmac('sha256', SIGN_KEY).update(`${id}|${discordId}`).digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function push(c, msg) {
  c.seq += 1;
  c.queue.push(Object.assign({ seq: c.seq, at: Date.now() }, msg));
  const now = Date.now();
  while (c.queue.length && (now - c.queue[0].at > QUEUE_TTL_MS || c.queue.length > 30)) c.queue.shift();
  const waiters = c.waiters;
  c.waiters = [];
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.done({ seq: c.seq, messages: c.queue.filter((m) => m.seq > w.since) });
  }
}

function broadcast(msg, filter) {
  for (const id of Object.keys(companions)) {
    const c = companions[id];
    if (!c.discordId) continue; // 持ち主が選ぶまでは届けない
    if (filter && !filter(c)) continue;
    push(c, msg);
  }
}

function auth(data) {
  const c = companions[String(data.id || '')];
  if (!c || !data.key || !safeEqual(c.key, data.key)) return null;
  c.lastSeen = Date.now();
  return c;
}

async function publicMember(discordId) {
  const m = discordId ? await memberInfo(discordId) : null;
  return m ? { id: m.id, name: m.name, avatar: m.avatar } : discordId ? { id: discordId, name: discordId, avatar: avatarUrl(discordId) } : null;
}

async function hello(data) {
  const label = String(data.label || '').slice(0, 40) || '?';
  const lang = data.lang === 'ja' ? 'ja' : 'en';
  let id = typeof data.id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(data.id) ? data.id : null;
  let key = typeof data.key === 'string' && data.key.length >= 16 && data.key.length <= 128 ? data.key : null;
  let c = id ? companions[id] : null;
  if (c && !(key && safeEqual(c.key, key))) return { error: 'bad-key', status: 403 };
  const isNew = !c && !id;
  if (!c) {
    if (Object.keys(companions).length >= MAX_COMPANIONS) return { error: 'full', status: 503 };
    if (!id || !key) {
      id = crypto.randomBytes(12).toString('base64url');
      key = crypto.randomBytes(24).toString('base64url');
    }
    c = companions[id] = { key, label, lang, discordId: null, sig: null, lastSeen: Date.now(), seq: 0, queue: [], waiters: [], created: Date.now() };
  }
  c.label = label;
  c.lang = lang;
  c.lastSeen = Date.now();
  // 前に選ばれた人(署名付き)なら、そのまま元に戻す
  if (!c.discordId && typeof data.discordId === 'string' && typeof data.sig === 'string' && safeEqual(sign(id, data.discordId), data.sig)) {
    c.discordId = data.discordId;
    c.sig = data.sig;
  }
  if (isNew) {
    dmOwner(`🔔 **${label}** さんが Listen Together アプリを入れました。\nだれなのかを選ぶまで、通知は届きません。https://pc-status-relay.onrender.com/admin で選んでください。`);
  }
  return { id, key, approved: !!c.discordId, discordId: c.discordId, sig: c.sig, me: await publicMember(c.discordId), seq: c.seq };
}

async function reportGame(c, game) {
  const name = String(game || '').trim().slice(0, 60);
  if (!name) return { error: 'missing-game', status: 400 };
  if (!c.discordId) return { error: 'not-approved', status: 403 };
  const k = `${c.discordId}|${name.toLowerCase()}`;
  const now = Date.now();
  if (now - (lastGame.get(k) || 0) < GAME_REPEAT_MS) return { ok: true, skipped: true };
  lastGame.set(k, now);
  const me = await publicMember(c.discordId);
  broadcast({ type: 'game', user: me, game: name }, (o) => o.discordId !== c.discordId);
  return { ok: true };
}

async function adminList() {
  if (BOT_TOKEN && discord.members.size < 2) {
    try {
      const list = await rest('GET', `/guilds/${GUILD_ID}/members?limit=1000`);
      for (const m of list) rememberMember(m);
    } catch (e) {}
  }
  const members = [...discord.members.values()].filter((m) => !m.bot).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const list = [];
  for (const id of Object.keys(companions)) {
    const c = companions[id];
    list.push({ id, label: c.label, lang: c.lang, lastSeen: c.lastSeen, created: c.created, online: Date.now() - c.lastSeen < 90000, member: await publicMember(c.discordId) });
  }
  list.sort((a, b) => (a.member ? 1 : 0) - (b.member ? 1 : 0) || b.created - a.created);
  return { discord: { status: discord.status, guild: discord.guild.name }, members: members.map(({ id, name, username, avatar }) => ({ id, name, username, avatar })), companions: list };
}

async function assign(companionId, discordId) {
  const c = companions[companionId];
  if (!c) return { error: 'unknown', status: 404 };
  c.discordId = discordId || null;
  c.sig = discordId ? sign(companionId, discordId) : null;
  push(c, { type: 'assigned', discordId: c.discordId, sig: c.sig, me: await publicMember(c.discordId) });
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP
function handle(req, res, url, h) {
  const p = url.pathname;
  const json = (fn) =>
    h.readJsonBody(req, 64 * 1024, async (err, data) => {
      if (err) return h.sendJson(res, 400, { error: err.message });
      try {
        const r = await fn(data || {});
        h.sendJson(res, r && r.status ? r.status : 200, r);
      } catch (e) {
        h.sendJson(res, 500, { error: 'internal' });
      }
    });

  if (p === '/api/companion/hello' && req.method === 'POST') {
    json(hello);
    return true;
  }
  if (p === '/api/companion/game' && req.method === 'POST') {
    json(async (d) => {
      const c = auth(d);
      return c ? reportGame(c, d.game) : { error: 'unauthorized', status: 401 };
    });
    return true;
  }
  if (p === '/api/companion/poll' && req.method === 'GET') {
    const c = auth({ id: url.searchParams.get('id'), key: url.searchParams.get('key') });
    if (!c) {
      h.sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const ready = c.queue.filter((m) => m.seq > since);
    if (ready.length || since > c.seq) {
      h.sendJson(res, 200, { seq: c.seq, messages: ready });
      return true;
    }
    const w = { since, done: (body) => h.sendJson(res, 200, body) };
    w.timer = setTimeout(() => {
      c.waiters = c.waiters.filter((x) => x !== w);
      h.sendJson(res, 200, { seq: c.seq, messages: [] });
    }, POLL_WAIT_MS);
    c.waiters.push(w);
    req.on('close', () => {
      clearTimeout(w.timer);
      c.waiters = c.waiters.filter((x) => x !== w);
    });
    return true;
  }
  if (p === '/api/admin/companions' && req.method === 'GET') {
    if (!h.isOwnerAuthorized(req, url)) {
      h.sendJson(res, 404, { error: 'not found' });
      return true;
    }
    adminList().then((r) => h.sendJson(res, 200, r), () => h.sendJson(res, 500, { error: 'internal' }));
    return true;
  }
  if (p === '/api/admin/assign' && req.method === 'POST') {
    if (!h.isOwnerAuthorized(req, url)) {
      h.sendJson(res, 404, { error: 'not found' });
      return true;
    }
    json((d) => assign(String(d.companion || ''), d.discordId ? String(d.discordId) : null));
    return true;
  }
  if (p === '/admin' && req.method === 'GET') {
    h.sendFile(res, 'admin.html');
    return true;
  }
  return false;
}

function start() {
  connect();
}
function stop() {
  stopped = true;
  if (ws) ws.close();
}

module.exports = { handle, start, stop, _test: { discord, companions, sign, onVoiceState, onGuildCreate, canView } };
