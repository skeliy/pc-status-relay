// このサーバー(Render)は、更新や再起動のたびに覚えていたことを全部忘れる(保存場所が無いため)。
// そこで、忘れると困る記録だけを暗号化して、持ち主(skeliy)の PC のエージェントに1分ごとに預ける。
// サーバーが起動し直したら、エージェントが預かっていた控えを送り返してきて、それで元に戻す。
//
//  預けるもの:
//   - 部屋ごとの「前に一緒に聴いたことのある人」の記録と、最後のホストの名前
//   - Listen Together アプリを入れた人の一覧(名前、だれなのかの割り当て、いつ入れたか)
//  暗号の鍵は OWNER_TOKEN から作るので、控えのファイルを見ても中身は読めない。
//  OWNER_TOKEN が設定されていない時は、この仕組みは使わない。
'use strict';

const crypto = require('crypto');
const rooms = require('./rooms');
const companions = require('./companions');

const OWNER_TOKEN = process.env.OWNER_TOKEN || '';
const KEY = OWNER_TOKEN ? crypto.createHash('sha256').update('pc-status-relay-backup:' + OWNER_TOKEN).digest() : null;
const MAX_BLOB = 2 * 1024 * 1024;

let restored = false; // 起動してから、控えを受け取った(または「控えは無い」と言われた)か
let restoredAt = 0;

function enabled() {
  return !!KEY;
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

function open(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.') || blob.length > MAX_BLOB) throw new Error('bad-blob');
  const buf = Buffer.from(blob.slice(3), 'base64url');
  if (buf.length < 29) throw new Error('bad-blob');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const text = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  return JSON.parse(text);
}

function current() {
  return { v: 1, at: Date.now(), rooms: rooms.snapshot(), companions: companions.snapshot() };
}

// GET: 今の控えを渡す。まだ受け取っていない間は、空っぽの控えで上書きされないように渡さない
function get() {
  if (!restored) return { restored: false };
  return { restored: true, blob: seal(current()) };
}

// POST: 預けていた控えを受け取って、今の記録に足す(今の方を優先)
function restore(blob) {
  if (blob == null) {
    restored = true;
    restoredAt = Date.now();
    return { ok: true, restored: true, companions: 0 };
  }
  let data;
  try {
    data = open(blob);
  } catch (e) {
    return { error: 'bad-blob', status: 400 };
  }
  rooms.restore(data && data.rooms);
  const n = companions.restore(data && data.companions);
  restored = true;
  restoredAt = Date.now();
  return { ok: true, restored: true, companions: n, savedAt: data && data.at };
}

function handle(req, res, url, h) {
  if (url.pathname !== '/api/backup' && url.pathname !== '/api/backup/restore') return false;
  // 書き込み用の合言葉を持つエージェントだけ。OWNER_TOKEN が無ければ何も無いことにする
  if (!enabled() || !h.isWriteAuthorized(req)) {
    h.sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (url.pathname === '/api/backup' && req.method === 'GET') {
    h.sendJson(res, 200, get());
    return true;
  }
  if (url.pathname === '/api/backup/restore' && req.method === 'POST') {
    h.readJsonBody(req, MAX_BLOB + 1024, (err, data) => {
      if (err) return h.sendJson(res, 400, { error: err.message });
      const r = restore(data ? data.blob : null);
      h.sendJson(res, r.status || 200, r);
    });
    return true;
  }
  h.sendJson(res, 405, { error: 'method' });
  return true;
}

module.exports = { handle, _test: { seal, open, get, restore, current, reset: () => { restored = false; } } };
