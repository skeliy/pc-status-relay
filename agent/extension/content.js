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
      .card { background: rgba(32,34,44,.95); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 10px 12px;
              box-shadow: 0 6px 24px rgba(0,0,0,.35); width: 230px; }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .head .title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .person { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
      .person svg { flex: none; width: 18px; height: 18px; color: #b9bccb; }
      .person.me svg { color: #fa2d48; }
      .pname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .psvc { color: #8f93a6; font-size: 11px; white-space: nowrap; }
      .ptag { color: #fbbf24; background: rgba(251,191,36,.14); border-radius: 6px; padding: 1px 6px; font-size: 10px; font-weight: 600; white-space: nowrap; }
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
    for (const c of children || []) if (c) e.appendChild(c);
    return e;
  }

  const text = (t, cls) => el('div', cls ? { class: cls, text: t } : { text: t });
  const pill = (lines, buttons) => el('div', { class: 'pill' }, [el('div', { class: 'text' }, lines), ...(buttons || [])]);
  const button = (label, onclick, primary) => el('button', primary ? { class: 'primary', text: label, onclick } : { text: label, onclick });
  // 人のアイコン
  function personIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const head = document.createElementNS(NS, 'circle');
    head.setAttribute('cx', '12');
    head.setAttribute('cy', '8');
    head.setAttribute('r', '4');
    const body = document.createElementNS(NS, 'path');
    body.setAttribute('d', 'M4 20.5c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5c0 .3-.2.5-.5.5h-15c-.3 0-.5-.2-.5-.5z');
    svg.appendChild(head);
    svg.appendChild(body);
    return svg;
  }

  function render(ui) {
    const key = JSON.stringify(ui);
    if (key === lastKey) return;
    lastKey = key;
    wrap.textContent = '';
    if (!ui || (ui.mode === 'none' && !(ui.invites || []).length)) return; // 部屋にも入っておらず、招待も無い
    const T = (k, ...a) => PcsI18n.t(ui.lang, k, ...a); // 画面の言語(アイコンの画面で切り替える)
    const person = (label, service) => (ui.lang === 'ja' ? `${label}(${SERVICE_NAMES[service] || '?'})` : `${label} (${SERVICE_NAMES[service] || '?'})`);

    if (ui.versionMismatch) {
      wrap.appendChild(pill([text(T('extOutdated'), 'muted')]));
    }
    if (ui.loginNeeded) {
      wrap.appendChild(pill([text(T('spotifyLogin'), 'muted')]));
    }
    if (ui.notice) {
      wrap.appendChild(pill([text(PcsI18n.fmt(ui.lang, ui.notice), 'muted')]));
    }
    for (const req of ui.incoming || []) {
      wrap.appendChild(
        pill([text(T('requestFrom', req.label))], [
          button(T('allow'), () => sendAction('accept', { sessionId: req.sessionId }), true),
          button(T('deny'), () => sendAction('decline', { sessionId: req.sessionId })),
        ])
      );
    }
    if (ui.needsClick) {
      wrap.appendChild(
        pill([text(T('autoplayBlocked')), text(T('autoplayHint'), 'muted')], [
          button(T('play'), () => window.postMessage({ source: SRC_CMD, cmd: { id: -1, action: 'play' } }, '*'), true),
        ])
      );
    }

    for (const inv of ui.invites || []) {
      wrap.appendChild(
        pill([text(T('inviteFrom', inv.fromLabel)), text(T('roomOf', inv.owner), 'muted')], [
          button(T('join'), () => sendAction('accept-invite', { code: inv.code }), true),
          button(T('decline'), () => sendAction('decline-invite', { code: inv.code })),
        ])
      );
    }

    const room = ui.room;
    const members = room ? room.members || [] : [];
    const others = room ? members.filter((m) => m.id !== room.you) : [];
    if (room && !ui.connected) {
      wrap.appendChild(pill([text(T('connecting'), 'muted')]));
    } else if (room && others.length > 0) {
      // 誰が参加しているかを、自分も含めて1人ずつ(人のアイコンと名前)並べる
      const leaveLabel = room.role === 'owner' || room.role === 'self' ? T('end') : T('leave');
      wrap.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'head', title: room.role === 'owner' ? T('ownerHint') : T('guestHint') }, [
            el('span', { class: 'title', text: '🎧 ' + T('listeningHeader', members.length) }),
            button(leaveLabel, () => sendAction(room.role === 'self' ? 'end-self' : ui.mode === 'guest' ? 'leave' : 'stop')),
          ]),
          ...members.map((m) =>
            el('div', { class: 'person' + (m.id === room.you ? ' me' : '') }, [
              personIcon(),
              el('span', { class: 'pname', text: m.id === room.you ? m.label + T('youSuffix') : m.label }),
              m.host || m.id === room.host ? el('span', { class: 'ptag', text: T('hostTag') }) : null,
              el('span', { class: 'psvc', text: SERVICE_NAMES[m.service] || '' }),
            ])
          ),
        ])
      );
    } else if (ui.pending) {
      wrap.appendChild(
        pill([text(T('requesting')), text(T('waitingApproval'), 'muted')], [button(T('cancel'), () => sendAction('cancel'))])
      );
    } else if (ui.mode === 'guest' && room && room.role === 'self') {
      // 1人で流している(自分の部屋)。一緒に聴いたことのある人が入ってこられる
      wrap.appendChild(pill([text(T('selfRoom')), text(T('selfRoomHint'), 'muted')]));
    } else if (ui.mode === 'guest') {
      const hosting = !!(room && room.you && room.host === room.you);
      wrap.appendChild(
        pill(hosting ? [text(T('hosting')), text(T('hostingHint'), 'muted')] : [text(T('inRoom', (room && room.owner) || '')), text(T('inRoomHint'), 'muted')], [
          button(T('leave'), () => sendAction('leave')),
        ])
      );
    } else if (ui.mode === 'agent' && !(ui.incoming || []).length) {
      wrap.appendChild(
        el('button', { class: 'fab', title: T('fabTitle', ui.hotkey || ''), text: '🎧', onclick: () => sendAction('request') })
      );
    }

    // 前に参加した人(今いない人)に、1人ずつ招待を送る
    const known = room && ui.connected ? (room.known || []).filter((k) => k.online).slice(0, 4) : [];
    if (known.length) {
      wrap.appendChild(
        pill(
          [text(T('inviteKnown'), 'muted'), ...known.map((k) => text(person(k.label, k.service)))],
          known.length === 1
            ? [button(T('invite'), () => sendAction('invite', { target: known[0].key }), true)]
            : [button(T('inviteAll'), () => known.forEach((k) => sendAction('invite', { target: k.key })), true)]
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
