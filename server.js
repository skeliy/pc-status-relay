// PC status relay server
//
// 役割:
//   - 各PC上で動くエージェント(agent.py)から「今の状態」をPOSTで受け取り、メモリ上に保持する
//   - GET /api/status で全PCの最新状態をJSONで返す
//   - GET /dashboard でダッシュボード画面(HTML)そのものを配信する
//     -> みんなが同じURL(+閲覧用トークン)を開くだけで、同じ画面を見られる
//   - 状態が変わるたびに履歴(いつ何をしていたか)も記録し、
//     GET /api/history で「過去○日間、何にどれくらいの時間を使ったか」の集計を返す
//   - さらにアプリごとに、実際のウィンドウタイトル(ブラウザのページ名・Discordのサーバー/
//     チャンネル名など、エージェントが元々フォアグラウンドウィンドウから取得して送ってきている
//     文字列)の内訳も記録し、GET /api/history/detail で「そのアプリの中で何を見ていたか」を返す
//   - GET /history で、その履歴をスマホでも読みやすい簡易ページとして配信する
//     -> この履歴機能は OWNER_TOKEN を知っている人(自分だけ)専用。
//        VIEW_TOKEN(友達にも共有する閲覧用トークン)では見られないし、
//        ダッシュボード上にも「履歴」へのリンクは一切表示されない(自分のトークンで開いた時だけ出る)。
//
//   - 曲の共有(Apple Music)のために、エージェント同士のメッセージを中継する
//     POST /api/music/send でメッセージを送り、GET /api/music/poll で受け取る(ロングポーリング)。
//     中身(リクエスト・許可・再生中の曲など)はサーバーでは解釈せず、届けるだけ。
//     どちらも WRITE_TOKEN が必要(エージェントだけが使う)。
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
const HISTORY_TITLE_MAX_SEGMENTS = parseInt(process.env.HISTORY_TITLE_MAX_SEGMENTS || '4000', 10);

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

// PCごとの「ウィンドウタイトルの内訳」履歴(アプリ内の詳細用)。
// 各要素: { appKey, title, startedAt, endedAt }
//   appKey: どのアプリ区間の最中だったか ("app:chrome.exe" など。history の key と対応)
//   title:  実際のウィンドウタイトル文字列(ブラウザのページ名、Discordのサーバー/チャンネル名など。
//           エージェントが元々フォアグラウンドウィンドウから取得して毎回送ってきているもの)
// AFK中・カスタムステータス中はタイトルの内訳を取らない(意味が薄いため)。
const titleHistory = Object.create(null);

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

  return info;
}

// ウィンドウタイトルの内訳を記録する(アプリ区間中のみ)。ロジックはrecordHistoryと同じ考え方:
// 同じタイトルが続く間は延長、変われば新しい区間を開始。AFK中・カスタム中は記録しない。
function recordTitleHistory(id, data, info, now) {
  if (info.kind !== 'app') return;
  const title = typeof data.status === 'string' && data.status.trim() ? data.status.trim() : null;
  if (!title) return;

  if (!titleHistory[id]) titleHistory[id] = [];
  const segments = titleHistory[id];
  const last = segments[segments.length - 1];

  if (last && last.appKey === info.key && last.title === title) {
    last.endedAt = now;
  } else {
    if (last) last.endedAt = now;
    segments.push({ appKey: info.key, title, startedAt: now, endedAt: now });
  }

  const cutoff = now - HISTORY_RETENTION_MS;
  while (segments.length > 0 && segments[0].endedAt < cutoff) {
    segments.shift();
  }
  while (segments.length > HISTORY_TITLE_MAX_SEGMENTS) {
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

// 指定PC・指定アプリ(appKey)・指定期間について、実際のウィンドウタイトルごとの合計時間を集計する。
// 「このアプリの中で何を見ていたか」(ブラウザのページ名、Discordのサーバー/チャンネル名など)の内訳。
function buildHistoryDetail(id, appKey, windowDays) {
  const now = Date.now();
  const windowMs = Math.min(windowDays, HISTORY_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const windowStart = now - windowMs;
  const segments = titleHistory[id] || [];
  const isOnline = !!(state[id] && now - state[id].lastSeen <= OFFLINE_THRESHOLD_MS);

  const totalsByTitle = new Map();
  let trackedMs = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.appKey !== appKey) continue;
    const isLast = i === segments.length - 1;
    const effectiveEndedAt = isLast && isOnline ? now : seg.endedAt;
    const start = Math.max(seg.startedAt, windowStart);
    const end = Math.max(effectiveEndedAt, start);
    if (end <= windowStart) continue;
    const durationMs = end - start;
    if (durationMs <= 0) continue;

    trackedMs += durationMs;
    const existing = totalsByTitle.get(seg.title);
    if (existing) {
      existing.durationMs += durationMs;
    } else {
      totalsByTitle.set(seg.title, { title: seg.title, durationMs });
    }
  }

  const breakdown = Array.from(totalsByTitle.values()).sort((a, b) => b.durationMs - a.durationMs);

  return { id, appKey, windowDays, windowStart, windowEnd: now, trackedMs, breakdown, serverTime: now };
}

// ---------------------------------------------------------------------------
// 曲の共有(Apple Music)用のメッセージ中継
// ---------------------------------------------------------------------------
// エージェントは GET /api/music/poll を出しっぱなしにしておき(最大 MUSIC_POLL_WAIT_MS 待つ)、
// 自分宛てのメッセージが来た瞬間に返事をもらう。こうすると数百ミリ秒で相手に届く。
// メッセージはメモリ上に短時間(MUSIC_MESSAGE_TTL_MS)だけ置いておき、取りに来なければ捨てる。
const MUSIC_POLL_WAIT_MS = 25000;
const MUSIC_MESSAGE_TTL_MS = 120000;
const MUSIC_ONLINE_MS = 90000; // この時間内に poll してきたPCを「曲の共有ができる相手」とみなす
const MUSIC_TYPES = new Set(['request', 'accept', 'decline', 'state', 'stop', 'busy']);

let musicSeq = 0;
const musicQueues = Object.create(null); // pcId -> [{ seq, ... }]
const musicWaiters = Object.create(null); // pcId -> [{ res, since, timer }]
const musicLastPoll = Object.create(null); // pcId -> { at, label }

function musicMessagesFor(pcId, since) {
  const now = Date.now();
  const queue = (musicQueues[pcId] || []).filter((m) => m.seq > since && now - m.at <= MUSIC_MESSAGE_TTL_MS);
  musicQueues[pcId] = queue;
  return queue;
}

function musicRespond(res, pcId, messages) {
  sendJson(res, 200, { seq: musicSeq, serverNow: Date.now(), messages });
}

function musicWake(pcId) {
  const waiters = musicWaiters[pcId];
  if (!waiters || waiters.length === 0) return;
  musicWaiters[pcId] = [];
  for (const w of waiters) {
    clearTimeout(w.timer);
    musicRespond(w.res, pcId, musicMessagesFor(pcId, w.since));
  }
}

function musicRecipients(from, to) {
  const now = Date.now();
  const online = Object.keys(musicLastPoll).filter((id) => id !== from && now - musicLastPoll[id].at <= MUSIC_ONLINE_MS);
  if (to === '*') return online;
  return online.includes(to) ? [to] : [];
}

function handleMusicSend(req, res) {
  if (!isWriteAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  readJsonBody(req, 16 * 1024, (err, data) => {
    if (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const from = typeof data.from === 'string' ? data.from.trim() : '';
    const to = typeof data.to === 'string' ? data.to.trim() : '';
    const type = typeof data.type === 'string' ? data.type : '';
    if (!from || !to || !MUSIC_TYPES.has(type)) {
      sendJson(res, 400, { error: 'missing "from" / "to" / valid "type"' });
      return;
    }
    const recipients = musicRecipients(from, to);
    const now = Date.now();
    for (const pcId of recipients) {
      const message = {
        seq: ++musicSeq,
        at: now,
        from,
        fromLabel: typeof data.fromLabel === 'string' ? data.fromLabel.slice(0, 60) : from,
        to: pcId,
        type,
        sessionId: typeof data.sessionId === 'string' ? data.sessionId.slice(0, 64) : '',
        data: data.data && typeof data.data === 'object' ? data.data : {},
      };
      if (!musicQueues[pcId]) musicQueues[pcId] = [];
      musicQueues[pcId].push(message);
      if (musicQueues[pcId].length > 200) musicQueues[pcId].shift();
      musicWake(pcId);
    }
    sendJson(res, 200, {
      ok: true,
      delivered: recipients.length,
      recipients: recipients.map((id) => ({ id, label: musicLastPoll[id].label })),
    });
  });
}

function handleMusicPoll(req, res, parsedUrl) {
  if (!isWriteAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const pcId = (parsedUrl.searchParams.get('pc') || '').trim();
  if (!pcId) {
    sendJson(res, 400, { error: 'missing "pc"' });
    return;
  }
  const label = (parsedUrl.searchParams.get('label') || pcId).slice(0, 60);
  musicLastPoll[pcId] = { at: Date.now(), label };

  const since = parseInt(parsedUrl.searchParams.get('since') || '-1', 10);
  if (!Number.isFinite(since) || since < 0) {
    // 起動直後: 古いメッセージは渡さず、今の番号だけ教える
    musicRespond(res, pcId, []);
    return;
  }
  const pending = musicMessagesFor(pcId, since);
  if (pending.length > 0) {
    musicRespond(res, pcId, pending);
    return;
  }
  const waiter = { res, since, timer: null };
  waiter.timer = setTimeout(() => {
    musicWaiters[pcId] = (musicWaiters[pcId] || []).filter((w) => w !== waiter);
    musicLastPoll[pcId] = { at: Date.now(), label };
    musicRespond(res, pcId, []);
  }, MUSIC_POLL_WAIT_MS);
  // 相手(エージェント)が接続を切ったら待つのをやめる。
  // ※ req ではなく res の close を使う(Node 16以降、req の close は本文を読み終えた時点で来てしまうため)
  res.on('close', () => {
    clearTimeout(waiter.timer);
    musicWaiters[pcId] = (musicWaiters[pcId] || []).filter((w) => w !== waiter);
  });
  if (!musicWaiters[pcId]) musicWaiters[pcId] = [];
  musicWaiters[pcId].push(waiter);
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
      const info = recordHistory(id, data, now);
      recordTitleHistory(id, data, info, now);
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

  if (pathname === '/api/history/detail' && req.method === 'GET') {
    if (!isOwnerAuthorized(req, parsedUrl)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const id = (parsedUrl.searchParams.get('id') || '').trim();
    const key = (parsedUrl.searchParams.get('key') || '').trim();
    if (!id || !key) {
      sendJson(res, 400, { error: 'missing "id" or "key" query parameter' });
      return;
    }
    let days = parseFloat(parsedUrl.searchParams.get('days') || '7');
    if (!Number.isFinite(days) || days <= 0) days = 7;
    days = Math.min(days, HISTORY_RETENTION_DAYS);
    sendJson(res, 200, buildHistoryDetail(id, key, days));
    return;
  }

  if (pathname === '/api/music/send' && req.method === 'POST') {
    handleMusicSend(req, res);
    return;
  }

  if (pathname === '/api/music/poll' && req.method === 'GET') {
    handleMusicPoll(req, res, parsedUrl);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`PC status relay server listening on port ${PORT}`);
});
