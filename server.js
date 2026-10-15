// PC status relay server
//
// 役割:
//   - 各PC上で動くエージェント(agent.py)から「今の状態」をPOSTで受け取り、メモリ上に保持する
//   - GET /api/status で全PCの最新状態をJSONで返す
//   - GET /dashboard でダッシュボード画面(HTML)そのものを配信する
//     -> みんなが同じURL(+閲覧用トークン)を開くだけで、同じ画面を見られる
//   - 状態が変わるたびに履歴(いつ何をしていたか)も記録し、
//     GET /api/history で「過去○日間、何にどれくらいの時間を使ったか」の集計を返す
//   - GET /history で、その履歴をスマホでも読みやすい簡易ページとして配信する
//     -> この履歴機能は OWNER_TOKEN を知っている人(自分だけ)専用。
//        VIEW_TOKEN(友達にも共有する閲覧用トークン)では見られないし、
//        ダッシュボード上にも「履歴」へのリンクは一切表示されない(自分のトークンで開いた時だけ出る)。
//
// 外部ライブラリ不使用(Node.js標準の http / fs モジュールのみ)。
//
// 環境変数:
//   PORT                   待受ポート (デフォルト 3000。ホスティング側が自動設定する場合はそれが優先されます)
//   WRITE_TOKEN            エージェント(agent.py)が状態を書き込むための合言葉。必ず変更してください
//   VIEW_TOKEN             ダッシュボードを見るための合言葉。友達を含め「見る人全員」に共有してOK
//   OWNER_TOKEN            自分専用の合言葉。履歴機能(/history, /api/history)はこれが無いと
//                          絶対に見られない。VIEW_TOKENとは別の値にして、誰にも共有しないこと。
//                          未設定の場合、履歴機能は誰からも使えない(安全側に倒して無効化)。
//   OFFLINE_THRESHOLD_MS   この時間以上更新が無いPCは「オフライン」とみなす(デフォルト 30000 = 30秒)
//   MAX_PCS                登録できるPCの最大台数(デフォルト 10。荒らし対策の簡易上限)
//   HISTORY_RETENTION_DAYS 履歴を何日分まで保持するか(デフォルト 7)
//   HISTORY_MAX_SEGMENTS   PC1台あたり保持する履歴の最大件数(デフォルト 5000。メモリ保護用の簡易上限)
//
// WRITE_TOKEN と VIEW_TOKEN を分けている理由:
//   VIEW_TOKENは友達にも共有する前提なので、万一漏れても「なりすまして状態を書き込まれる」
//   ことがないよう、書き込み(POST)には別の・より秘密度の高いWRITE_TOKENを使う。
//   OWNER_TOKENはさらにその上で、「友達には見せたくない機能」専用の第三のトークンという位置づけ。
//
// 履歴機能についての注意:
//   履歴もステータスと同じくメモリ上にのみ保持しています(ファイルやDBへの保存はしていません)。
//   そのためサーバーが再起動(Renderの無料プランでは再デプロイ時など)すると、その時点までの
//   履歴は消えてしまいます。日々の大まかな傾向を見るための簡易機能という位置づけです。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const WRITE_TOKEN = process.env.WRITE_TOKEN || '';
const VIEW_TOKEN = process.env.VIEW_TOKEN || '';
const OWNER_TOKEN = process.env.OWNER_TOKEN || '';
const OFFLINE_THRESHOLD_MS = parseInt(process.env.OFFLINE_THRESHOLD_MS || '30000', 10);
const MAX_PCS = parseInt(process.env.MAX_PCS || '10', 10);
const HISTORY_RETENTION_DAYS = parseFloat(process.env.HISTORY_RETENTION_DAYS || '7');
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_MAX_SEGMENTS = parseInt(process.env.HISTORY_MAX_SEGMENTS || '5000', 10);

const DASHBOARD_HTML_PATH = path.join(__dirname, 'public', 'dashboard.html');
const HISTORY_HTML_PATH = path.join(__dirname, 'public', 'history.html');

if (!WRITE_TOKEN) {
  console.warn('[警告] WRITE_TOKEN が未設定です。誰でも状態を書き込めてしまいます。必ず設定してください。');
}
if (!VIEW_TOKEN) {
  console.warn('[警告] VIEW_TOKEN が未設定です。誰でもダッシュボードを閲覧できてしまいます。必ず設定してください。');
}
if (!OWNER_TOKEN) {
  console.warn('[警告] OWNER_TOKEN が未設定です。履歴機能(/history, /api/history)は誰からも使えません(安全側で無効)。自分だけが使えるようにするには設定してください。');
}

// 履歴機能のリンクをダッシュボードに注入する際、HTMLにそのまま挿し込む断片。
// このテキスト自体はOWNER_TOKENを一切含まないので、仕組みを覗かれても悪用はできない。
const OWNER_DASHBOARD_INJECTION = `
<script>
(function () {
  var TOKEN = new URLSearchParams(window.location.search).get('token') || '';
  var style = document.createElement('style');
  style.textContent = '.history-link{display:inline-block;margin-top:12px;font-size:.8rem;color:#4f7cff;text-decoration:none;}';
  document.head.appendChild(style);
  function addLinks() {
    document.querySelectorAll('.card[data-pc-id]').forEach(function (card) {
      if (card.querySelector('.history-link')) return;
      var id = card.getAttribute('data-pc-id');
      var a = document.createElement('a');
      a.className = 'history-link';
      a.href = '/history?id=' + encodeURIComponent(id) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
      a.textContent = '履歴を見る(過去7日間)→';
      card.appendChild(a);
    });
  }
  var target = document.getElementById('cards');
  if (target) new MutationObserver(addLinks).observe(target, { childList: true, subtree: true });
  addLinks();
})();
</script>
`;

// PCごとの最新状態を保持するだけのシンプルなインメモリストア。
// サーバーを再起動すると消えます(このユースケースでは永続化は不要という判断)。
const state = Object.create(null);
// PCが最初に報告してきた順序を覚えておく(ダッシュボードの表示順を安定させるため)
const firstSeenOrder = [];

// PCごとの履歴(状態が変わった区間のリスト)。
// 各要素: { key, kind, label, startedAt, endedAt }
//   key:   区間を識別するためのキー ("app:chrome.exe" / "afk" / "custom:お風呂中" など)
//   kind:  "app" | "afk" | "custom"
//   label: 画面表示用の名前(アプリ名 / "AFK" / カスタムステータス文)
// 一番最後の要素が「今も続いている区間」で、POSTが来るたびに endedAt を伸ばしていく。
const history = Object.create(null);

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
  const t = tokenFrom(req, parsedUrl);
  // OWNER_TOKENでも通常のダッシュボード/ステータスは見られる(自分は当然見られて良いので)。
  return t === VIEW_TOKEN || (!!OWNER_TOKEN && t === OWNER_TOKEN);
}

// 履歴機能(/history, /api/history)専用。VIEW_TOKENでは通さない — OWNER_TOKENのみ。
// OWNER_TOKEN が未設定の場合は、安全側に倒して誰からも使えないようにする。
function isOwnerAuthorized(req, parsedUrl) {
  if (!OWNER_TOKEN) return false;
  return tokenFrom(req, parsedUrl) === OWNER_TOKEN;
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

// data(POSTされてきた内容)から履歴区間のキー・種別・表示名を決める。
// ダッシュボード側の表示ロジック(isAfk && !isCustom -> AFK表示 など)と揃えてある。
function segmentInfoFrom(data) {
  if (data.isCustom) {
    const label = typeof data.status === 'string' && data.status ? data.status : 'カスタム';
    return { key: `custom:${label}`, kind: 'custom', label };
  }
  if (data.isAfk) {
    return { key: 'afk', kind: 'afk', label: 'AFK' };
  }
  const label =
    (typeof data.processName === 'string' && data.processName) ||
    (typeof data.status === 'string' && data.status) ||
    '不明';
  return { key: `app:${label}`, kind: 'app', label };
}

// 履歴に1件分の更新を反映する。状態が変わっていなければ現在の区間を延長するだけ、
// 変わっていれば新しい区間を開始する。古くなった区間・件数が多すぎる分は切り詰める。
function recordHistory(id, data, now) {
  if (!history[id]) history[id] = [];
  const segments = history[id];
  const info = segmentInfoFrom(data);
  const last = segments[segments.length - 1];

  if (last && last.key === info.key) {
    last.endedAt = now;
  } else {
    // 状態が切り替わったので、直前の区間はこの瞬間までだったものとして確定させる。
    if (last) last.endedAt = now;
    segments.push({ key: info.key, kind: info.kind, label: info.label, startedAt: now, endedAt: now });
  }

  const cutoff = now - HISTORY_RETENTION_MS;
  while (segments.length > 0 && segments[0].endedAt < cutoff) {
    segments.shift();
  }
  while (segments.length > HISTORY_MAX_SEGMENTS) {
    segments.shift();
  }
}

// 指定PC・指定期間(windowStart〜now)の履歴を、キーごとの合計時間に集計する。
function buildHistorySummary(id, windowDays) {
  const now = Date.now();
  const windowMs = Math.min(windowDays, HISTORY_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const windowStart = now - windowMs;
  const segments = history[id] || [];

  const isOnline = !!(state[id] && now - state[id].lastSeen <= OFFLINE_THRESHOLD_MS);

  const totalsByKey = new Map();
  let trackedMs = 0;
  let afkMs = 0;
  let customMs = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    // 一番最後の区間は「今も続いている最中」の可能性があるので、
    // PCがオンラインである限りは現在時刻まで継続しているものとして数える。
    const effectiveEndedAt = isLast && isOnline ? now : seg.endedAt;
    const start = Math.max(seg.startedAt, windowStart);
    const end = Math.max(effectiveEndedAt, start);
    if (end <= windowStart) continue;
    const durationMs = end - start;
    if (durationMs <= 0) continue;

    trackedMs += durationMs;
    if (seg.kind === 'afk') afkMs += durationMs;
    if (seg.kind === 'custom') customMs += durationMs;

    const existing = totalsByKey.get(seg.key);
    if (existing) {
      existing.durationMs += durationMs;
    } else {
      totalsByKey.set(seg.key, { key: seg.key, kind: seg.kind, label: seg.label, durationMs });
    }
  }

  const breakdown = Array.from(totalsByKey.values()).sort((a, b) => b.durationMs - a.durationMs);

  return {
    id,
    label: (state[id] && state[id].label) || id,
    online: !!(state[id] && now - state[id].lastSeen <= OFFLINE_THRESHOLD_MS),
    windowDays,
    windowStart,
    windowEnd: now,
    trackedMs,
    afkMs,
    customMs,
    breakdown,
    serverTime: now,
  };
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
      // 自分専用のOWNER_TOKENで開いた時だけ、履歴へのリンクをその場で挿し込む。
      // 友達が使うVIEW_TOKENでは何も挿し込まれないので、履歴機能の存在自体が見えない。
      const html2 = isOwnerAuthorized(req, parsedUrl)
        ? html.replace('</body>', `${OWNER_DASHBOARD_INJECTION}</body>`)
        : html;
      sendHtml(res, 200, html2);
    });
    return;
  }

  if (pathname === '/history' && req.method === 'GET') {
    if (!isOwnerAuthorized(req, parsedUrl)) {
      // あえて401ではなく404(そんなページは無い、という応答)にしている。
      // 友達がこのURLに気づいて開いてしまっても、「履歴ページが存在する」ことすら伝えないため。
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    fs.readFile(HISTORY_HTML_PATH, 'utf8', (err, html) => {
      if (err) {
        sendPlain(res, 500, 'history.html not found on server');
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
      const now = Date.now();
      state[id] = {
        label: typeof data.label === 'string' && data.label ? data.label : id,
        status: typeof data.status === 'string' && data.status ? data.status : '不明',
        processName: typeof data.processName === 'string' ? data.processName : null,
        isAfk: !!data.isAfk,
        isCustom: !!data.isCustom,
        customRemainingSeconds:
          typeof data.customRemainingSeconds === 'number' ? data.customRemainingSeconds : null,
        idleSeconds: typeof data.idleSeconds === 'number' ? data.idleSeconds : null,
        durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : null,
        lastSeen: now,
      };
      recordHistory(id, data, now);
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

  if (pathname === '/api/history' && req.method === 'GET') {
    if (!isOwnerAuthorized(req, parsedUrl)) {
      // /history と同じ理由で404にしている(存在自体を伝えない)。
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const id = (parsedUrl.searchParams.get('id') || '').trim();
    if (!id) {
      sendJson(res, 400, { error: 'missing "id" query parameter' });
      return;
    }
    let days = parseFloat(parsedUrl.searchParams.get('days') || '7');
    if (!Number.isFinite(days) || days <= 0) days = 7;
    days = Math.min(days, HISTORY_RETENTION_DAYS);
    sendJson(res, 200, buildHistorySummary(id, days));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`PC status relay server listening on port ${PORT}`);
});
