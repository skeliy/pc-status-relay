// 音楽サービスのページに付く部分(拡張機能側。Apple Music / Spotify / YouTube Music で共通)。
//  - ページの中の部品(apple.js / spotify.js / ytm.js)から届いた「今の曲・再生状態」を、
//    0.5秒ごとに裏方(background.js)へ送る
//  - 裏方からの指示(この曲を流して等)をページの中の部品に渡す
//  - 画面の右下に、一緒に聴いている人や、リクエスト・退出のボタンを出す
(function () {
  const SRC_PAGE = 'pcs-page';
  const SRC_CMD = 'pcs-ext-cmd';
  const TICK_MS = 500;
  const SERVICE_NAMES = { apple: 'Apple Music', spotify: 'Spotify', ytm: 'YouTube Music', youtube: 'YouTube', none: '?' };

  if (window.__pcsMusicContent) {
    try {
      window.__pcsMusicContent.stop();
    } catch (e) {}
  }

  let latestState = null;
  let results = [];
  let inFlight = false;
  let lastTickAt = 0;
  let stopped = false;
  let lastKey = null;

  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function tick() {
    if (stopped) return;
    if (!alive()) return stop(); // 拡張機能が読み込み直された(新しい自分が別に動いている)
    if (inFlight) return;
    inFlight = true;
    lastTickAt = Date.now();
    const sending = results;
    results = [];
    try {
      chrome.runtime.sendMessage({ type: 'tick', body: { state: latestState, results: sending } }, (resp) => {
        inFlight = false;
        if (chrome.runtime.lastError || !resp || !resp.ok) return render(null);
        for (const cmd of resp.data.commands || []) window.postMessage({ source: SRC_CMD, cmd }, '*');
        render(resp.data.ui);
      });
    } catch (e) {
      inFlight = false;
      stop();
    }
  }

  function sendAction(action, extra) {
    if (!alive()) return;
    chrome.runtime.sendMessage({ type: 'action', body: Object.assign({ action }, extra || {}) }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.ok && resp.data && resp.data.ui) render(resp.data.ui);
    });
  }

  function onMessage(e) {
    if (e.source !== window || !e.data || e.data.source !== SRC_PAGE) return;
    if (e.data.kind === 'state') {
      const prev = latestState;
      latestState = e.data.state;
      const p = prev && prev.song;
      const n = latestState && latestState.song;
      const changed = !prev || (p && p.id) !== (n && n.id) || prev.isPlaying !== latestState.isPlaying || prev.phase !== latestState.phase;
      if (changed && Date.now() - lastTickAt > 150) tick(); // 曲が変わった・再生/停止した時はすぐ知らせる
    } else if (e.data.kind === 'result') {
      results.push(e.data.result);
    }
  }

  // ------------------------------------------------------------ 画面右下の表示
  const host = document.createElement('div');
  host.id = 'pcs-music-share';
  host.style.cssText = 'position:fixed;right:16px;bottom:96px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { font: 13px/1.45 -apple-system, "Segoe UI", "Yu Gothic UI", "Hiragino Sans", sans-serif; color: #fff; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      .pill { display: flex; align-items: center; gap: 10px; background: rgba(32,34,44,.95); border: 1px solid rgba(255,255,255,.12);
              border-radius: 12px; padding: 8px 10px 8px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: 380px; }
      .pill .text { flex: 1; min-width: 0; }
      .muted { color: #b9bccb; font-size: 12px; }
      button { font: inherit; font-size: 12px; font-weight: 600; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer;
               color: #fff; background: #40435a; white-space: nowrap; }
      button.primary { background: #fa2d48; }
      button:hover { filter: brightness(1.12); }
      .fab { width: 34px; height: 34px; border-radius: 50%; padding: 0; background: rgba(32,34,44,.85); border: 1px solid rgba(255,255,255,.15);
             font-size: 16px; opacity: .55; transition: opacity .15s; }
      .fab:hover { opacity: 1; }
    </style>
    <div class="wrap"></div>`;
  const wrap = root.querySelector('.wrap');

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') e.addEventListener('click', v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const c of children || []) e.appendChild(c);
    return e;
  }

  const text = (t, cls) => el('div', cls ? { class: cls, text: t } : { text: t });
  const pill = (lines, buttons) => el('div', { class: 'pill' }, [el('div', { class: 'text' }, lines), ...(buttons || [])]);
  const button = (label, onclick, primary) => el('button', primary ? { class: 'primary', text: label, onclick } : { text: label, onclick });

  function render(ui) {
    const key = JSON.stringify(ui);
    if (key === lastKey) return;
    lastKey = key;
    wrap.textContent = '';
    if (!ui || (ui.mode === 'none' && !(ui.invites || []).length)) return; // 部屋にも入っておらず、招待も無い

    if (ui.versionMismatch) {
      wrap.appendChild(pill([text('拡張機能が古いままです。拡張機能のページで、読み込み元のフォルダを確認して「更新」を押してください', 'muted')]));
    }
    if (ui.loginNeeded) {
      wrap.appendChild(pill([text('Spotify にログインすると、一緒に聴けます', 'muted')]));
    }
    if (ui.notice) {
      wrap.appendChild(pill([text(ui.notice, 'muted')]));
    }
    for (const req of ui.incoming || []) {
      wrap.appendChild(
        pill([text(`🎵 ${req.label} が一緒に聴くのをリクエストしています`)], [
          button('許可', () => sendAction('accept', { sessionId: req.sessionId }), true),
          button('拒否', () => sendAction('decline', { sessionId: req.sessionId })),
        ])
      );
    }
    if (ui.needsClick) {
      wrap.appendChild(
        pill([text('▶ ブラウザが自動再生を止めました'), text('押すと、みんなと同じ曲が流れます', 'muted')], [
          button('再生', () => window.postMessage({ source: SRC_CMD, cmd: { id: -1, action: 'play' } }, '*'), true),
        ])
      );
    }

    for (const inv of ui.invites || []) {
      wrap.appendChild(
        pill([text(`🎵 ${inv.fromLabel} から「一緒に聴く」の招待が届いています`), text(`${inv.owner} の部屋`, 'muted')], [
          button('参加する', () => sendAction('accept-invite', { code: inv.code }), true),
          button('断る', () => sendAction('decline-invite', { code: inv.code })),
        ])
      );
    }

    const room = ui.room;
    const members = room ? room.members || [] : [];
    const others = room ? members.filter((m) => m.id !== room.you) : [];
    if (room && !ui.connected) {
      wrap.appendChild(pill([text('🎧 部屋に接続しています…', 'muted')]));
    } else if (room && others.length > 0) {
      // 誰が参加しているかを、自分も含めて全員並べる
      const names = members.map((m) => `${m.id === room.you ? 'あなた' : m.label}(${SERVICE_NAMES[m.service] || '?'})`).join('、');
      const leaveLabel = room.role === 'owner' ? '終了' : '退出';
      const lines = [text(`🎧 一緒に聴いています(${members.length}人)`), text(`参加中: ${names}`, 'muted')];
      if ((ui.queue || []).length) {
        lines.push(text('次: ' + ui.queue.map((q) => q.title).join(' → '), 'muted'));
      }
      lines.push(text(room.role === 'owner' ? '「終了」を押すと、全員が部屋から出ます' : 'このタブを閉じると部屋から出ます', 'muted'));
      wrap.appendChild(pill(lines, [button(leaveLabel, () => sendAction(ui.mode === 'guest' ? 'leave' : 'stop'))]));
    } else if (ui.pending) {
      wrap.appendChild(
        pill([text('📨 一緒に聴くのをリクエスト中…'), text('相手の許可を待っています', 'muted')], [button('取り消し', () => sendAction('cancel'))])
      );
    } else if (ui.mode === 'guest') {
      wrap.appendChild(
        pill([text(`🎧 ${(room && room.owner) || ''} の部屋に入っています`), text('ほかの人が来ると、同じ曲が流れ始めます', 'muted')], [
          button('退出', () => sendAction('leave')),
        ])
      );
    } else if (ui.mode === 'agent' && !(ui.incoming || []).length) {
      wrap.appendChild(
        el('button', { class: 'fab', title: `友達に「一緒に聴く」をリクエスト(${ui.hotkey || ''})`, text: '🎧', onclick: () => sendAction('request') })
      );
    }

    // 前に参加した人(今いない人)に、1人ずつ招待を送る
    const known = room && ui.connected ? (room.known || []).filter((k) => k.online).slice(0, 4) : [];
    if (known.length) {
      wrap.appendChild(
        pill(
          [text('前に参加した人を招待', 'muted'), ...known.map((k) => text(`${k.label}(${SERVICE_NAMES[k.service] || '?'})`))],
          known.length === 1
            ? [button('招待', () => sendAction('invite', { target: known[0].key }), true)]
            : [button('全員を招待', () => known.forEach((k) => sendAction('invite', { target: k.key })), true)]
        )
      );
    }
  }

  window.addEventListener('message', onMessage);
  (document.body || document.documentElement).appendChild(host);
  const timer = setInterval(tick, TICK_MS);

  function stop() {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener('message', onMessage);
    host.remove();
  }

  window.__pcsMusicContent = { stop };
})();
