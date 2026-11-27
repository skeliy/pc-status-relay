// 予定の変更のお願い(ハブの「とろ の予定」の横のペンから送る)を受け取って、Claude に渡す係。
//
//  流れ:
//   1. とろ(など)がハブのペンを押して「来週の水曜5限に授業が増えた」のように書いて送る
//      → POST /api/sched-requests (閲覧用トークン)
//   2. Claude(skeliy のスケジュールタスク)が1時間ごとに取りに来る
//      → GET /api/claude/sched (Claude 用の鍵)
//   3. Claude が予定表を直して、その人の予定を丸ごと送り返す → POST /api/claude/schedule-person
//      分からないところがあれば質問を返す → POST /api/claude/sched-requests/<id> {status:"question", reply}
//      ハブのペンの所に質問が出て、そこで答えると、その答えも次の回に Claude に届く
//
//  Claude 用の鍵そのものはここには書かない(公開リポジトリなので)。鍵の SHA-256 だけを置く。
//  記録は backup.js で持ち主の PC に預けるので、サーバーが再起動しても消えない。
'use strict';

const crypto = require('crypto');

const CLAUDE_KEY_SHA256 = process.env.CLAUDE_KEY_SHA256 || '828881361ad97ec056239fee534e66e6ecee567dcf1f34d65eb8fb0fde941943';
const PEOPLE = ['toro'];               // ペンから予定を変えられる人
const MAX_TEXT = 500;
const MAX_KEEP = 200;                  // 覚えておくお願いの数
const KEEP_MS = 45 * 24 * 3600 * 1000; // 45日より古いものは忘れる
const MAX_OPEN = 20;                   // まだ片付いていないお願いの上限(いたずら対策)
const STATUSES = ['new', 'seen', 'question', 'done', 'rejected'];

let requests = [];          // {id, person, text, replyTo, at, status, reply, repliedAt}
const personData = {};      // Claude が送ってきた、その人の予定表まるごと({tz,data,allday,range})
let personAt = {};

function isClaude(req) {
  const k = String(req.headers['x-claude-key'] || '');
  if (!k || !CLAUDE_KEY_SHA256) return false;
  const h = crypto.createHash('sha256').update(k).digest('hex');
  return h.length === CLAUDE_KEY_SHA256.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(CLAUDE_KEY_SHA256));
}

function prune() {
  const cut = Date.now() - KEEP_MS;
  requests = requests.filter((r) => r.at >= cut).slice(-MAX_KEEP);
}

function publicView(r) {
  return { id: r.id, person: r.person, text: r.text, replyTo: r.replyTo || null, at: r.at, status: r.status, reply: r.reply || '', repliedAt: r.repliedAt || null };
}

function create(body) {
  const person = String((body && body.person) || '');
  const text = String((body && body.text) || '').replace(/\r\n?/g, '\n').trim();
  const replyTo = body && body.replyTo ? String(body.replyTo) : null;
  if (!PEOPLE.includes(person)) return { status: 400, error: 'person' };
  if (!text) return { status: 400, error: 'empty' };
  if (text.length > MAX_TEXT) return { status: 400, error: 'too-long' };
  if (replyTo && !requests.some((r) => r.id === replyTo)) return { status: 400, error: 'reply-to' };
  prune();
  if (requests.filter((r) => r.status === 'new' || r.status === 'seen').length >= MAX_OPEN) return { status: 429, error: 'too-many' };
  const r = { id: crypto.randomBytes(6).toString('hex'), person, text, replyTo, at: Date.now(), status: 'new', reply: '', repliedAt: null };
  requests.push(r);
  // 質問に答えたら、その質問は「答えた」扱いにする(Claude は答えの方を見て、元のお願いと合わせて考える)
  if (replyTo) {
    const q = requests.find((x) => x.id === replyTo);
    if (q && q.status === 'question') q.answered = true;
  }
  return { ok: true, request: publicView(r) };
}

function update(id, body) {
  const r = requests.find((x) => x.id === id);
  if (!r) return { status: 404, error: 'not found' };
  const st = String((body && body.status) || '');
  if (!STATUSES.includes(st)) return { status: 400, error: 'status' };
  r.status = st;
  if (body.reply != null) r.reply = String(body.reply).slice(0, 1000);
  r.repliedAt = Date.now();
  return { ok: true, request: publicView(r) };
}

// GET /api/schedule で返す予定表に、Claude が直した人の分を重ねる
function mergeSchedule(schedule) {
  const names = Object.keys(personData);
  if (!names.length) return schedule;
  const out = Object.assign({}, schedule || {});
  names.forEach((k) => { out[k] = personData[k]; });
  return out;
}

function snapshot() {
  prune();
  return { requests, personData, personAt };
}

function restore(d) {
  if (!d || typeof d !== 'object') return;
  if (Array.isArray(d.requests)) {
    const have = new Set(requests.map((r) => r.id));
    d.requests.forEach((r) => { if (r && r.id && !have.has(r.id)) requests.push(r); });
    requests.sort((a, b) => a.at - b.at);
    prune();
  }
  if (d.personData && typeof d.personData === 'object') {
    Object.keys(d.personData).forEach((k) => {
      const at = (d.personAt && d.personAt[k]) || 0;
      if (!personData[k] || (personAt[k] || 0) < at) { personData[k] = d.personData[k]; personAt[k] = at; }
    });
  }
}

function handle(req, res, url, h) {
  const p = url.pathname;
  if (p === '/api/sched-requests') {
    if (!h.isViewAuthorized(req, url)) { h.sendJson(res, 401, { error: 'unauthorized' }); return true; }
    if (req.method === 'GET') {
      prune();
      h.sendJson(res, 200, { requests: requests.slice(-60).map(publicView) });
      return true;
    }
    if (req.method === 'POST') {
      h.readJsonBody(req, 8 * 1024, (err, body) => {
        if (err) return h.sendJson(res, 400, { error: err.message });
        const r = create(body);
        h.sendJson(res, r.status || 200, r);
      });
      return true;
    }
    h.sendJson(res, 405, { error: 'method' });
    return true;
  }
  if (!p.startsWith('/api/claude/')) return false;
  if (!isClaude(req)) { h.sendJson(res, 404, { error: 'not found' }); return true; }
  if (p === '/api/claude/sched' && req.method === 'GET') {
    prune();
    const sched = h.getSchedule();
    h.sendJson(res, 200, { now: Date.now(), requests: requests.map((r) => Object.assign(publicView(r), { answered: !!r.answered })), schedule: mergeSchedule(sched.schedule), pcScheduleAt: sched.updatedAt, personAt });
    return true;
  }
  const m = p.match(/^\/api\/claude\/sched-requests\/([0-9a-f]{12})$/);
  if (m && req.method === 'POST') {
    h.readJsonBody(req, 8 * 1024, (err, body) => {
      if (err) return h.sendJson(res, 400, { error: err.message });
      const r = update(m[1], body || {});
      h.sendJson(res, r.status || 200, r);
    });
    return true;
  }
  if (p === '/api/claude/schedule-person' && req.method === 'POST') {
    h.readJsonBody(req, 1024 * 1024, (err, body) => {
      if (err) return h.sendJson(res, 400, { error: err.message });
      const person = String((body && body.person) || '');
      const d = body && body.data;
      if (!PEOPLE.includes(person) || !d || typeof d !== 'object' || typeof d.data !== 'object' || typeof d.tz !== 'string') return h.sendJson(res, 400, { error: 'bad data' });
      personData[person] = d;
      personAt[person] = Date.now();
      h.sendJson(res, 200, { ok: true, at: personAt[person] });
    });
    return true;
  }
  h.sendJson(res, 405, { error: 'method' });
  return true;
}

module.exports = { handle, mergeSchedule, snapshot, restore, _test: { create, update, isClaude, reset: () => { requests = []; Object.keys(personData).forEach((k) => delete personData[k]); personAt = {}; } } };
