// 曲の共有の「部屋」
//
// 部屋は、エージェントを動かしているPC(持ち主)ごとに1つある。中にいる人は全員が曲を変えられ、
// 誰かが曲を選ぶ・再生・一時停止・シークすると、ほかの人のブラウザ拡張機能がそれぞれ自分の
// サービス(Apple Music / Spotify / YouTube Music)で同じ状態にする。
//
// 入り方は4つ:
//   - 持ち主のエージェント            … WRITE_TOKEN で部屋を開く(POST /api/room/open)
//   - 友達のエージェント(Ctrl+Alt+M) … WRITE_TOKEN で参加用の鍵をもらう(POST /api/room/member-token)
//   - Discord のリンクから来た人      … /listen/<部屋> のページでパスワードを入れる(POST /api/room/join)
//   - 一度入ったことがある人          … 部屋の中の人から招待を受け取って入る(POST /api/room/accept-invite)
//
// 拡張機能だけの人(PC Status を入れていない人)も招待を受け取れるよう、拡張機能ごとに「受信箱」がある
// (POST /api/client/register で登録、GET /api/client/poll で待つ)。曲のタブを閉じた人は部屋から出るので、
// もう一度入るには、部屋の中の人から1人ずつ招待を送ってもらう(前に入ったことがある人は部屋が覚えている)。
//
// サーバーはメッセージの中身(曲など)を解釈せず、部屋の中の他の人に届けるだけ。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OWNER_TIMEOUT_MS = 150000; // 持ち主のエージェントからこの時間連絡が無ければ部屋を閉じる
const MEMBER_TIMEOUT_MS = 90000; // 参加者からこの時間連絡が無ければ抜けたとみなす(拡張機能は30秒ごとに知らせてくる)
const POLL_WAIT_MS = 25000;
const MESSAGE_TTL_MS = 120000;
const SERVICES = new Set(['apple', 'spotify', 'ytm', 'youtube', 'none']);
const MESSAGE_TYPES = new Set(['state']);
const JOIN_FAIL_LIMIT = 8; // 同じIPからパスワードを間違えられる回数(10分あたり)
const JOIN_FAIL_WINDOW_MS = 10 * 60 * 1000;

const INVITE_TTL_MS = 120000; // 招待の有効時間
const CLIENT_ONLINE_MS = 90000;
const CLIENT_FORGET_MS = 3 * 24 * 60 * 60 * 1000;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

const rooms = Object.create(null);
const joinFailures = new Map(); // ip -> [timestamps]
const clients = Object.create(null); // 拡張機能ごとの受信箱 clientId -> { key, label, service, lastSeen, seq, queue, waiters }

// エージェント(PC Status)向けのやり取りは server.js 側にあるので、そこから仕組みを受け取る
let agentHooks = { online: () => false, push: () => {} };
function setAgentHooks(hooks) {
  agentHooks = Object.assign(agentHooks, hooks);
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

// 「通行証」: パスワードで一度入った人(と招待で入った人)に渡し、次からはパスワード無しで途中参加できるようにする。
// 中継サーバーが再起動しても使えるよう、合言葉(WRITE_TOKEN など)と部屋のパスワードから作る。
// 持ち主がパスワードを変えると、前の通行証は使えなくなる
const PASS_SECRET = process.env.PASS_SECRET || process.env.WRITE_TOKEN || crypto.randomBytes(32).toString('hex');

function passKeyFor(id, password) {
  return crypto.createHmac('sha256', PASS_SECRET).update('room-pass\n' + id + '\n' + password).digest();
}

function signPass(room, nonce) {
  return crypto.createHmac('sha256', room.passKey).update(nonce).digest('base64url');
}

function makePass(room) {
  if (!room.passKey) return null;
  const nonce = crypto.randomBytes(12).toString('base64url');
  return { nonce, sig: signPass(room, nonce) };
}

function checkPass(room, data) {
  const p = data && data.pass;
  if (!room || !room.passKey || !p || typeof p.nonce !== 'string' || typeof p.sig !== 'string') return false;
  if (p.nonce.length > 64 || p.sig.length > 100) return false;
  return safeEqual(p.sig, signPass(room, p.nonce));
}

// 今その部屋で流れている曲(誰かが再生中の時だけ)
function nowPlaying(room, now) {
  const last = room.lastState;
  if (!last || !last.data || !last.data.song || !last.data.isPlaying) return null;
  const from = Array.from(room.members.values()).find((m) => m.id === last.from);
  if (!from) return null;
  const age = (now - last.at) / 1000;
  const duration = Number(last.data.song.duration) || 0;
  if (age > 900) return null;
  if (duration && (Number(last.data.position) || 0) + age > duration + 20) return null; // 曲が終わったまま次が来ていない
  return { title: last.data.song.title || null, artist: last.data.song.artist || null, from: last.fromLabel || from.label };
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function cleanLabel(v, fallback) {
  const s = typeof v === 'string' ? v.trim().slice(0, 40) : '';
  return s || fallback;
}

function isOpen(room, now) {
  return !!room && now - room.ownerSeen <= OWNER_TIMEOUT_MS;
}

function memberList(room) {
  return Array.from(room.members.values()).map((m) => ({
    id: m.id,
    label: m.label,
    service: m.service,
    kind: m.kind,
  }));
}

// 前に部屋に入ったことがある人(今いない人だけ)。部屋の中の人は、ここから1人ずつ招待を送れる
function knownKeyOf(member) {
  if (member.clientId) return 'c:' + member.clientId;
  if (member.pc && member.kind !== 'owner') return 'a:' + member.pc;
  return null;
}

function recordKnown(room, member) {
  const key = knownKeyOf(member);
  if (!key) return;
  room.known.set(key, {
    key,
    kind: key.startsWith('c:') ? 'client' : 'agent',
    id: key.slice(2),
    label: member.label,
    service: member.service,
    lastAt: Date.now(),
  });
}

function knownList(room) {
  const present = new Set(Array.from(room.members.values()).map(knownKeyOf).filter(Boolean));
  const now = Date.now();
  return Array.from(room.known.values())
    .filter((k) => !present.has(k.key))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 20)
    .map((k) => {
      const c = k.kind === 'client' ? clients[k.id] : null;
      const online = k.kind === 'client' ? !!(c && now - c.lastSeen <= CLIENT_ONLINE_MS) : !!agentHooks.online(k.id);
      return { key: k.key, kind: k.kind, label: (c && c.label) || k.label, service: (c && c.service) || k.service, online };
    });
}

// ---------------------------------------------------------------- 受信箱(拡張機能だけの人)
function clientPush(clientId, msg) {
  const c = clients[clientId];
  if (!c) return false;
  c.seq += 1;
  c.queue.push(Object.assign({ seq: c.seq, at: Date.now() }, msg));
  const now = Date.now();
  while (c.queue.length > 0 && (now - c.queue[0].at > MESSAGE_TTL_MS || c.queue.length > 50)) c.queue.shift();
  const waiters = c.waiters;
  c.waiters = [];
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.sendJson(w.res, 200, { seq: c.seq, serverNow: Date.now(), messages: c.queue.filter((m) => m.seq > w.since) });
  }
  return true;
}

function clientAuth(data) {
  const id = typeof data.client === 'string' ? data.client : '';
  const key = typeof data.key === 'string' ? data.key : '';
  const c = clients[id];
  if (!c || !key || !safeEqual(c.key, key)) return null;
  c.lastSeen = Date.now();
  return Object.assign({ id }, { rec: c });
}

function pushMessage(room, msg, exceptMemberId) {
  room.seq += 1;
  const message = Object.assign({ seq: room.seq, at: Date.now() }, msg);
  room.queue.push({ message, except: exceptMemberId || null });
  if (message.type === 'state') room.lastState = message; // 後から繋がった人に「今の曲」をすぐ渡すため
  const now = Date.now();
  while (room.queue.length > 0 && (now - room.queue[0].message.at > MESSAGE_TTL_MS || room.queue.length > 300)) {
    room.queue.shift();
  }
  wake(room);
}

function messagesFor(room, member, since) {
  return room.queue
    .filter((q) => q.message.seq > since && q.except !== member.id)
    .map((q) => q.message);
}

function respondPoll(res, room, member, messages, sendJson) {
  sendJson(res, 200, {
    seq: room.seq,
    serverNow: Date.now(),
    messages,
    members: memberList(room),
    you: member.id,
    owner: room.ownerLabel,
    known: knownList(room),
  });
}

function wake(room) {
  const waiters = room.waiters;
  room.waiters = [];
  for (const w of waiters) {
    clearTimeout(w.timer);
    const member = room.members.get(w.token);
    if (!member) {
      w.sendJson(w.res, 403, { error: 'not-member' });
      continue;
    }
    respondPoll(w.res, room, member, messagesFor(room, member, w.since), w.sendJson);
  }
}

function addMember(room, { label, service, kind, pc, clientId }) {
  // 同じPC(エージェント)が鍵をもらい直した時は、前の鍵を消して入れ替える
  if (pc || clientId) {
    for (const [token, m] of room.members) {
      if ((pc && m.pc === pc) || (clientId && m.clientId === clientId)) room.members.delete(token);
    }
  }
  const token = randomToken();
  const member = {
    id: crypto.randomBytes(6).toString('hex'),
    token,
    label,
    service: SERVICES.has(service) ? service : 'none',
    kind,
    pc: pc || null,
    clientId: clientId || null,
    lastSeen: Date.now(),
  };
  room.members.set(token, member);
  recordKnown(room, member);
  pushMessage(room, { type: 'joined', from: member.id, fromLabel: member.label, data: { service: member.service, kind } }, member.id);
  return member;
}

function removeMember(room, token, reason) {
  const member = room.members.get(token);
  if (!member) return;
  room.members.delete(token);
  pushMessage(room, { type: 'left', from: member.id, fromLabel: member.label, data: { reason } });
}

// 連絡が途絶えた参加者・持ち主がいなくなった部屋を片付ける
function sweep() {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    for (const [token, m] of room.members) {
      if (m.kind !== 'owner' && now - m.lastSeen > MEMBER_TIMEOUT_MS) removeMember(room, token, 'timeout');
    }
    for (const [code, inv] of room.invites) {
      if (now > inv.expires) room.invites.delete(code);
    }
    if (!isOpen(room, now) && room.waiters.length === 0 && now - room.ownerSeen > OWNER_TIMEOUT_MS * 4) {
      delete rooms[id];
    }
  }
  for (const [id, c] of Object.entries(clients)) {
    if (c.waiters.length === 0 && now - c.lastSeen > CLIENT_FORGET_MS) delete clients[id];
  }
}
setInterval(sweep, 10000).unref();

function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

function tooManyFailures(ip) {
  const now = Date.now();
  const list = (joinFailures.get(ip) || []).filter((t) => now - t < JOIN_FAIL_WINDOW_MS);
  joinFailures.set(ip, list);
  return list.length >= JOIN_FAIL_LIMIT;
}

function noteFailure(ip) {
  const list = joinFailures.get(ip) || [];
  list.push(Date.now());
  joinFailures.set(ip, list);
}

// ---------------------------------------------------------------------------
// 拡張機能の zip を、その場で作って配る(agent/extension フォルダの中身)
// ---------------------------------------------------------------------------
const EXTENSION_DIR = path.join(__dirname, 'agent', 'extension');
let zipCache = null; // { key, buffer }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 圧縮しない(store)だけの最小限の zip を作る。外部ライブラリを使わないため。
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // ファイル名は UTF-8
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// zip に入れるのは、agent/FILES に書かれている extension/ のファイルだけ
// (エージェントの自動アップデートで配るものと同じ。古いファイルが GitHub に残っていても配らないため)
function extensionFiles() {
  const list = fs.readFileSync(path.join(__dirname, 'agent', 'FILES'), 'utf8').split(/\r?\n/);
  return list
    .map((l) => l.trim())
    .filter((l) => l.startsWith('extension/') && !l.includes('..'))
    .map((l) => l.slice('extension/'.length))
    .filter((n) => fs.existsSync(path.join(EXTENSION_DIR, n)))
    .sort();
}

function extensionZip() {
  const names = extensionFiles();
  const key = names.map((n) => `${n}:${fs.statSync(path.join(EXTENSION_DIR, n)).mtimeMs}`).join('|');
  if (zipCache && zipCache.key === key) return zipCache.buffer;
  const entries = names.map((n) => ({ name: `pcs-music-share/${n}`, data: fs.readFileSync(path.join(EXTENSION_DIR, n)) }));
  zipCache = { key, buffer: buildZip(entries) };
  return zipCache.buffer;
}

function extensionVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ルーティング(server.js から呼ばれる)。担当したら true を返す
// ---------------------------------------------------------------------------
function handle(req, res, parsedUrl, ctx) {
  const { sendJson, sendHtml, sendPlain, readJsonBody, isWriteAuthorized } = ctx;
  const pathname = parsedUrl.pathname;

  const listenMatch = pathname.match(/^\/listen\/([a-z0-9-]{1,32})\/?$/);
  if (listenMatch && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'public', 'listen.html'), 'utf8', (err, html) => {
      if (err) return sendPlain(res, 500, 'listen.html not found on server');
      sendHtml(res, 200, html);
    });
    return true;
  }

  // 拡張機能だけの人向けの「更新係」(PowerShell に貼り付けて使う)
  const scriptMatch = pathname.match(/^\/listen-(install|update|uninstall)\.ps1$/);
  if (scriptMatch && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'public', `listen-${scriptMatch[1]}.ps1`), 'utf8', (err, text) => {
      if (err) return sendPlain(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
    });
    return true;
  }

  if (pathname === '/listen-ext.zip' && req.method === 'GET') {
    let buf;
    try {
      buf = extensionZip();
    } catch (e) {
      sendPlain(res, 500, 'extension not found on server');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="pcs-music-share.zip"',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return true;
  }

  if (pathname.startsWith('/api/client/')) {
    handleClient(req, res, parsedUrl, ctx);
    return true;
  }

  if (!pathname.startsWith('/api/room/')) return false;
  const action = pathname.slice('/api/room/'.length);

  if (action === 'info' && req.method === 'GET') {
    const id = (parsedUrl.searchParams.get('room') || '').trim();
    const room = rooms[id];
    const now = Date.now();
    sendJson(res, 200, {
      room: id,
      open: isOpen(room, now),
      owner: room ? room.ownerLabel : null,
      guestsAllowed: !!(room && room.passwordHash),
      extVersion: extensionVersion(),
    });
    return true;
  }

  if (action === 'poll' && req.method === 'GET') {
    const id = parsedUrl.searchParams.get('room') || '';
    const token = parsedUrl.searchParams.get('token') || '';
    const room = rooms[id];
    const member = room && room.members.get(token);
    if (!member || !isOpen(room, Date.now())) {
      sendJson(res, 403, { error: 'not-member' });
      return true;
    }
    member.lastSeen = Date.now();
    const since = parseInt(parsedUrl.searchParams.get('since') || '-1', 10);
    if (!Number.isFinite(since) || since < 0) {
      // 繋がった直後: 古いメッセージは渡さないが、「今の曲」(最後に送られた状態)だけはすぐ渡す
      const last = room.lastState;
      const fresh = last && last.from !== member.id && Date.now() - last.at < 15 * 60 * 1000;
      respondPoll(res, room, member, fresh ? [last] : [], sendJson);
      return true;
    }
    const pending = messagesFor(room, member, since);
    if (pending.length > 0) {
      respondPoll(res, room, member, pending, sendJson);
      return true;
    }
    const waiter = { res, token, since, sendJson, timer: null };
    waiter.timer = setTimeout(() => {
      room.waiters = room.waiters.filter((w) => w !== waiter);
      const m = room.members.get(token);
      if (!m) return sendJson(res, 403, { error: 'not-member' });
      m.lastSeen = Date.now();
      respondPoll(res, room, m, [], sendJson);
    }, POLL_WAIT_MS);
    res.on('close', () => {
      clearTimeout(waiter.timer);
      room.waiters = room.waiters.filter((w) => w !== waiter);
    });
    room.waiters.push(waiter);
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }

  readJsonBody(req, 16 * 1024, (err, data) => {
    if (err) return sendJson(res, 400, { error: err.message });
    const id = typeof data.room === 'string' ? data.room.trim().toLowerCase() : '';
    const now = Date.now();

    if (action === 'open') {
      if (!isWriteAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      if (!ROOM_ID_RE.test(id)) return sendJson(res, 400, { error: 'invalid room id' });
      const pc = typeof data.pc === 'string' ? data.pc.slice(0, 64) : '';
      let room = rooms[id];
      if (room && room.ownerPc !== pc && isOpen(room, now)) {
        return sendJson(res, 409, { error: 'room is owned by another PC' });
      }
      if (!room || room.ownerPc !== pc) {
        room = {
          id,
          ownerPc: pc,
          members: new Map(),
          queue: [],
          seq: 0,
          waiters: [],
          salt: null,
          passwordHash: null,
          known: new Map(),
          invites: new Map(),
        };
        rooms[id] = room;
      }
      room.ownerLabel = cleanLabel(data.label, id);
      room.ownerSeen = now;
      const password = typeof data.password === 'string' ? data.password : '';
      if (password) {
        if (!room.salt || !room.passwordHash || !safeEqual(room.passwordHash, hashPassword(password, room.salt))) {
          room.salt = crypto.randomBytes(16).toString('hex');
          room.passwordHash = hashPassword(password, room.salt);
        }
        room.passKey = passKeyFor(id, password);
      } else {
        room.salt = null;
        room.passwordHash = null;
        room.passKey = null;
      }
      let owner = Array.from(room.members.values()).find((m) => m.kind === 'owner');
      if (!owner || data.newToken) owner = addMember(room, { label: room.ownerLabel, service: data.service, kind: 'owner', pc });
      owner.lastSeen = now;
      if (SERVICES.has(data.service)) owner.service = data.service;
      return sendJson(res, 200, { ok: true, room: id, token: owner.token, you: owner.id, members: memberList(room) });
    }

    // 通行証を持っている人が、部屋の様子(誰がいるか・何が流れているか)を見る
    if (action === 'peek') {
      const r = rooms[id];
      if (!r || !isOpen(r, now)) return sendJson(res, 200, { open: false });
      if (!checkPass(r, data)) return sendJson(res, 403, { error: 'bad-pass' });
      return sendJson(res, 200, {
        open: true,
        owner: r.ownerLabel,
        members: memberList(r).map((m) => ({ label: m.label, service: m.service, kind: m.kind })),
        playing: nowPlaying(r, now),
      });
    }

    const room = rooms[id];
    if (!room || !isOpen(room, now)) return sendJson(res, 404, { error: 'room is not open' });

    // 通行証で途中参加する(パスワードを入れ直さなくてよい)
    if (action === 'rejoin') {
      if (!room.passKey) return sendJson(res, 403, { error: 'guests-not-allowed' });
      if (!checkPass(room, data)) return sendJson(res, 403, { error: 'bad-pass' });
      const auth = clientAuth(data);
      const m = addMember(room, {
        label: cleanLabel(data.label || (auth && auth.rec.label), 'guest'),
        service: SERVICES.has(data.service) ? data.service : auth && auth.rec.service,
        kind: 'guest',
        clientId: auth ? auth.id : null,
      });
      return sendJson(res, 200, { ok: true, room: id, token: m.token, you: m.id, owner: room.ownerLabel });
    }

    if (action === 'member-token') {
      if (!isWriteAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const member = addMember(room, {
        label: cleanLabel(data.label, 'friend'),
        service: data.service,
        kind: 'friend',
        pc: typeof data.pc === 'string' ? data.pc.slice(0, 64) : null,
      });
      return sendJson(res, 200, { ok: true, room: id, token: member.token, you: member.id, owner: room.ownerLabel });
    }

    if (action === 'join') {
      const ip = clientIp(req);
      if (!room.passwordHash) return sendJson(res, 403, { error: 'guests-not-allowed' });
      if (tooManyFailures(ip)) return sendJson(res, 429, { error: 'too-many-attempts' });
      const password = typeof data.password === 'string' ? data.password : '';
      if (!safeEqual(room.passwordHash, hashPassword(password, room.salt))) {
        noteFailure(ip);
        return sendJson(res, 403, { error: 'wrong-password' });
      }
      const auth = clientAuth(data); // 拡張機能が入っていれば、その受信箱とつなげておく(後で招待を受け取れるように)
      const member = addMember(room, {
        label: cleanLabel(data.label, 'guest'),
        service: data.service,
        kind: 'guest',
        clientId: auth ? auth.id : null,
      });
      return sendJson(res, 200, { ok: true, room: id, token: member.token, you: member.id, owner: room.ownerLabel, pass: makePass(room) });
    }

    if (action === 'accept-invite' || action === 'decline-invite') {
      const auth = clientAuth(data);
      const code = typeof data.code === 'string' ? data.code : '';
      const inv = room.invites.get(code);
      if (!auth) return sendJson(res, 403, { error: 'unknown client' });
      if (!inv || inv.key !== 'c:' + auth.id) return sendJson(res, 404, { error: 'invite not found' });
      room.invites.delete(code);
      if (now > inv.expires) return sendJson(res, 410, { error: 'invite expired' });
      if (action === 'decline-invite') {
        pushMessage(room, { type: 'declined', from: null, fromLabel: auth.rec.label || 'guest', data: {} });
        return sendJson(res, 200, { ok: true });
      }
      const m = addMember(room, { label: auth.rec.label || 'guest', service: auth.rec.service, kind: 'guest', clientId: auth.id });
      return sendJson(res, 200, { ok: true, room: id, token: m.token, you: m.id, owner: room.ownerLabel, pass: makePass(room) });
    }

    const token = typeof data.token === 'string' ? data.token : '';
    const member = room.members.get(token);
    if (!member) return sendJson(res, 403, { error: 'not-member' });
    member.lastSeen = now;

    if (action === 'send') {
      const type = typeof data.type === 'string' ? data.type : '';
      if (!MESSAGE_TYPES.has(type)) return sendJson(res, 400, { error: 'invalid type' });
      if (SERVICES.has(data.service)) member.service = data.service;
      pushMessage(
        room,
        {
          type,
          from: member.id,
          fromLabel: member.label,
          fromService: member.service,
          data: data.data && typeof data.data === 'object' ? data.data : {},
        },
        member.id
      );
      return sendJson(res, 200, { ok: true, members: memberList(room).length });
    }

    if (action === 'members') {
      if (SERVICES.has(data.service)) member.service = data.service;
      return sendJson(res, 200, { ok: true, members: memberList(room), you: member.id, owner: room.ownerLabel });
    }

    if (action === 'link') {
      // 参加ページで入った人の拡張機能が、自分の受信箱とつなげる(後で招待を受け取れるように)
      const auth = clientAuth(data);
      if (!auth) return sendJson(res, 403, { error: 'unknown client' });
      member.clientId = auth.id;
      if (auth.rec.label) member.label = auth.rec.label;
      if (SERVICES.has(auth.rec.service)) member.service = auth.rec.service;
      recordKnown(room, member);
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'invite') {
      // 前に入ったことがある人を招待する(target: known の key、または 'all')
      // target: known の key / 'all'(前に入った人全員) / 'clients'(そのうち拡張機能だけの人)
      let targets;
      if (data.target === 'all') targets = knownList(room).map((k) => k.key);
      else if (data.target === 'clients') targets = knownList(room).filter((k) => k.kind === 'client').map((k) => k.key);
      else targets = [String(data.target || '')];
      const invited = [];
      for (const key of targets) {
        const k = room.known.get(key);
        if (!k) continue;
        if (Array.from(room.members.values()).some((m) => knownKeyOf(m) === key)) continue;
        const code = randomToken();
        room.invites.set(code, { key, expires: now + INVITE_TTL_MS, fromLabel: member.label });
        if (k.kind === 'client') {
          if (!clients[k.id]) continue;
          clientPush(k.id, {
            type: 'invite',
            room: room.id,
            owner: room.ownerLabel,
            fromLabel: member.label,
            code,
            expiresAt: now + INVITE_TTL_MS,
            members: memberList(room).map((m) => m.label),
          });
        } else {
          // PC Status のエージェントには、いつものリクエスト(Ctrl+Alt+M と同じ形)で届ける
          agentHooks.push(k.id, {
            type: 'request',
            from: room.ownerPc,
            fromLabel: member.label,
            sessionId: code.slice(0, 16),
            data: { room: room.id, timeoutSec: INVITE_TTL_MS / 1000 },
          });
        }
        invited.push({ key, label: k.label });
      }
      return sendJson(res, 200, { ok: true, invited });
    }

    if (action === 'leave') {
      if (member.kind === 'owner') return sendJson(res, 400, { error: 'owner cannot leave; use end' });
      removeMember(room, token, 'leave');
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'end') {
      if (member.kind !== 'owner') return sendJson(res, 403, { error: 'only the owner can end' });
      for (const [t, m] of Array.from(room.members)) {
        if (m.kind !== 'owner') room.members.delete(t);
      }
      pushMessage(room, { type: 'ended', from: member.id, fromLabel: member.label, data: {} });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found' });
  });
  return true;
}

// ---------------------------------------------------------------------------
// 受信箱(拡張機能だけの人): 登録と待ち受け
// ---------------------------------------------------------------------------
function handleClient(req, res, parsedUrl, ctx) {
  const { sendJson, readJsonBody } = ctx;
  const action = parsedUrl.pathname.slice('/api/client/'.length);

  if (action === 'poll' && req.method === 'GET') {
    const auth = clientAuth({ client: parsedUrl.searchParams.get('client'), key: parsedUrl.searchParams.get('key') });
    if (!auth) return sendJson(res, 403, { error: 'unknown client' });
    const c = auth.rec;
    const since = parseInt(parsedUrl.searchParams.get('since') || '-1', 10);
    if (!Number.isFinite(since) || since < 0) return sendJson(res, 200, { seq: c.seq, serverNow: Date.now(), messages: [] });
    if (since > c.seq) return sendJson(res, 200, { seq: c.seq, serverNow: Date.now(), messages: [] }); // サーバーが再起動した
    const pending = c.queue.filter((m) => m.seq > since && Date.now() - m.at <= MESSAGE_TTL_MS);
    if (pending.length) return sendJson(res, 200, { seq: c.seq, serverNow: Date.now(), messages: pending });
    const waiter = { res, since, sendJson, timer: null };
    waiter.timer = setTimeout(() => {
      c.waiters = c.waiters.filter((w) => w !== waiter);
      c.lastSeen = Date.now();
      sendJson(res, 200, { seq: c.seq, serverNow: Date.now(), messages: [] });
    }, POLL_WAIT_MS);
    res.on('close', () => {
      clearTimeout(waiter.timer);
      c.waiters = c.waiters.filter((w) => w !== waiter);
    });
    c.waiters.push(waiter);
    return;
  }

  if (action === 'register' && req.method === 'POST') {
    readJsonBody(req, 4096, (err, data) => {
      if (err) return sendJson(res, 400, { error: err.message });
      let id = typeof data.client === 'string' ? data.client : '';
      let key = typeof data.key === 'string' ? data.key : '';
      const existing = clients[id];
      if (existing && !(key && safeEqual(existing.key, key))) {
        id = ''; // 他人の番号は使えない → 新しく作る
      }
      if (!existing && !(CLIENT_ID_RE.test(id) && key.length >= 16 && key.length <= 64)) {
        id = '';
      }
      if (!id) {
        id = crypto.randomBytes(12).toString('base64url');
        key = randomToken();
      }
      const c = clients[id] || (clients[id] = { key, label: '', service: 'none', lastSeen: 0, seq: 0, queue: [], waiters: [] });
      c.label = cleanLabel(data.label, c.label || '');
      if (SERVICES.has(data.service)) c.service = data.service;
      c.lastSeen = Date.now();
      sendJson(res, 200, { ok: true, client: id, key: c.key });
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

module.exports = { handle, buildZip, crc32, setAgentHooks };
