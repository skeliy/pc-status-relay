// PC status relay server
//
// 役割:
//   - 各PC上で動くエージェント(agent.py)から「今の状態」をPOSTで受け取り、メモリ上に保持する
//   - GET /api/status で全PCの最新状態をJSONで返す
//   - GET /dashboard でダッシュボード画面(HTML)そのものを配信する
//     -> みんなが同じURL(+閲覧用トークン)を開くだけで、同じ画面を見られる
//
// 外部ライブラリ不使用(Node.js標準の http / fs モジュールのみ)。
//
// 環境変数:
//   PORT                 待受ポート (デフォルト 3000。ホスティング側が自動設定する場合はそれが優先されます)
//   WRITE_TOKEN           エージェント(agent.py)が状態を書き込むための合言葉。必ず変更してください
//   VIEW_TOKEN            ダッシュボードを見るための合言葉。友達を含め「見る人全員」に共有してOK
//   OFFLINE_THRESHOLD_MS  この時間以上更新が無いPCは「オフライン」とみなす(デフォルト 30000 = 30秒)
//   MAX_PCS               登録できるPCの最大台数(デフォルト 10。荒らし対策の簡易上限)
//
// WRITE_TOKEN と VIEW_TOKEN を分けている理由:
//   VIEW_TOKENは友達にも共有する前提なので、万一漏れても「なりすまして状態を書き込まれる」
//   ことがないよう、書き込み(POST)には別の・より秘密度の高いWRITE_TOKENを使う。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const WRITE_TOKEN = process.env.WRITE_TOKEN || '';
const VIEW_TOKEN = process.env.VIEW_TOKEN || '';
const OFFLINE_THRESHOLD_MS = parseInt(process.env.OFFLINE_THRESHOLD_MS || '30000', 10);
const MAX_PCS = parseInt(process.env.MAX_PCS || '10', 10);

const DASHBOARD_HTML_PATH = path.join(__dirname, 'public', 'dashboard.html');

if (!WRITE_TOKEN) {
  console.warn('[警告] WRITE_TOKEN が未設定です。誰でも状態を書き込めてしまいます。必ず設定してください。');
}
if (!VIEW_TOKEN) {
  console.warn('[警告] VIEW_TOKEN が未設定です。誰でもダッシュボードを閲覧できてしまいます。必ず設定してください。');
}

// PCごとの最新状態を保持するだけのシンプルなインメモリストア。
// サーバーを再起動すると消えます(このユースケースでは永続化は不要という判断)。
const state = Object.create(null);
// PCが最初に報告してきた順序を覚えておく(ダッシュボードの表示順を安定させるため)
const firstSeenOrder = [];

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendPlain(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function tokenFrom(req, parsedUrl) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  const q = parsedUrl.searchParams.get('token');
  if (q) return q;
  return '';
}

function isWriteAuthorized(req) {
  if (!WRITE_TOKEN) return true; // 未設定時は素通し(起動時に警告済み)
  const header = req.headers['authorization'] || '';
  return header === `Bearer ${WRITE_TOKEN}`;
}

function isViewAuthorized(req, parsedUrl) {
  if (!VIEW_TOKEN) return true; // 未設定時は素通し(起動時に警告済み)
  return tokenFrom(req, parsedUrl) === VIEW_TOKEN;
}

function readJsonBody(req, maxBytes, cb) {
  let body = '';
  let tooLarge = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > maxBytes) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooLarge) return cb(new Error('payload too large'));
    try {
      cb(null, body ? JSON.parse(body) : {});
    } catch (e) {
      cb(new Error('invalid json'));
    }
  });
  req.on('error', (e) => cb(e));
}

function buildStatusSnapshot() {
  const now = Date.now();
  const pcs = {};
  for (const [id, s] of Object.entries(state)) {
    pcs[id] = {
      ...s,
      online: now - s.lastSeen <= OFFLINE_THRESHOLD_MS,
      lastSeenSecondsAgo: Math.round((now - s.lastSeen) / 1000),
    };
  }
  return { pcs, order: firstSeenOrder.slice(), serverTime: now };
}

const server = http.createServer((req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    sendPlain(res, 400, 'bad request');
    return;
  }
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (pathname === '/' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, message: 'PC status relay is running', pcCount: Object.keys(state).length });
    return;
  }

  if (pathname === '/dashboard' && req.method === 'GET') {
    if (!isViewAuthorized(req, parsedUrl)) {
      sendPlain(res, 401, 'unauthorized (URLの末尾に ?token=閲覧用トークン を付けてください)');
      return;
    }
    fs.readFile(DASHBOARD_HTML_PATH, 'utf8', (err, html) => {
      if (err) {
        sendPlain(res, 500, 'dashboard.html not found on server');
        return;
      }
      sendHtml(res, 200, html);
    });
    return;
  }

  if (pathname === '/api/status' && req.method === 'POST') {
    if (!isWriteAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    readJsonBody(req, 100 * 1024, (err, data) => {
      if (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null;
      if (!id) {
        sendJson(res, 400, { error: 'missing "id"' });
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(state, id) && Object.keys(state).length >= MAX_PCS) {
        sendJson(res, 403, { error: 'too many registered PCs' });
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(state, id)) {
        firstSeenOrder.push(id);
      }
      state[id] = {
        label: typeof data.label === 'string' && data.label ? data.label : id,
        status: typeof data.status === 'string' && data.status ? data.status : '不明',
        processName: typeof data.processName === 'string' ? data.processName : null,
        isAfk: !!data.isAfk,
        isCustom: !!data.isCustom,
        customRemainingSeconds:
          typeof data.customRemainingSeconds === 'number' ? data.customRemainingSeconds : null,
        idleSeconds: typeof data.idleSeconds === 'number' ? data.idleSeconds : null,
        lastSeen: Date.now(),
      };
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    if (!isViewAuthorized(req, parsedUrl)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(res, 200, buildStatusSnapshot());
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`PC status relay server listening on port ${PORT}`);
});
