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

  let tickFails = 0;
  function tick() {
    if (stopped) return;
    if (!alive()) return stop(); // 拡張機能が読み込み直された(新しい自分が別に動いている)
    if (inFlight) return;
    inFlight = true;
    lastTickAt = Date.now();
    const sending = results;
    results = [];
    try {
      const page = { path: location.pathname, playlist: onPlaylistPage() };
      chrome.runtime.sendMessage({ type: 'tick', body: { state: latestState, results: sending, page } }, (resp) => {
        inFlight = false;
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // 拡張機能の裏側が起き直している時などに一瞬失敗しても、右下の表示は消さない(3秒続いたら消す)
          if (++tickFails >= 6) render(null);
          return;
        }
        tickFails = 0;
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
      const r = e.data.result;
      if (r && typeof r.id === 'string' && r.id.startsWith('rev-')) onReverseResult(r);
      else results.push(r);
    }
  }

  // ------------------------------------------------------------ プレイリストを逆順で再生(Apple Music を選んだ人だけ)
  let reverse = { busy: false, text: null, until: 0 };
  const onApple = location.hostname === 'music.apple.com';
  // プレイリストのページか(住所のどこかにプレイリストの番号 p.〜 / pl.〜 がある)
  //   例: /jp/library/playlist/p.XXXX  /library/playlist/p.XXXX  /jp/playlist/名前/pl.XXXX  /jp/playlist/pl.u-XXXX
  function playlistIdFromPath(path) {
    const m = String(path || '').match(/\/((?:p|pl)\.[A-Za-z0-9_-]+)(?=[/?#]|$)/);
    return m ? m[1] : null;
  }
  function onPlaylistPage() {
    return onApple && /playlist/i.test(location.pathname) && !!playlistIdFromPath(location.pathname);
  }
  function playReversed() {
    if (reverse.busy) return;
    reverse = { busy: true, text: null, until: 0 };
    if (lastUi) render(lastUi);
    window.postMessage({ source: SRC_CMD, cmd: { id: 'rev-' + Date.now(), action: 'reverse-playlist' } }, '*');
  }
  function onReverseResult(r) {
    let text;
    if (r.ok) text = ['reverseDone', r.count];
    else if (r.error === 'login') text = ['reverseLogin'];
    else if (r.error === 'empty') text = ['reverseEmpty'];
    else text = ['reverseFailed', r.error || ''];
    reverse = { busy: false, text, until: Date.now() + 6000 };
    if (lastUi) render(lastUi);
    setTimeout(() => lastUi && render(lastUi), 6100);
  }
  // ページの移動(プレイリストを開いた・閉じた)に合わせて、ボタンを出したり消したりする
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (lastUi) render(lastUi);
    }
  }, 700);

  // ------------------------------------------------------------ 画面右下の表示
  const host = document.createElement('div');
  host.id = 'pcs-music-share';
  host.style.cssText = 'position:fixed;right:16px;bottom:96px;z-index:2147483647;pointer-events:none;';
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
      .col { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      /* 見えている物だけがクリックを受け取る(すき間や見えないボタンの場所は、下のページに通す) */
      .col, .wrap { pointer-events: none; }
      .wrap > * { pointer-events: auto; }
      /* 右下のヘッドフォン。カーソルを合わせると、上に丸いボタンが出てくる */
      /* 開いていない時は、ヘッドフォン以外の場所(見えないボタンの場所)はページのクリックを邪魔しない */
      .dock { display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
      .dock[hidden] { display: none; }
      .dock.hover, .dock.open { pointer-events: auto; }
      .menu { display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
      .icon-btn { position: relative; display: grid; place-items: center; padding: 0; border-radius: 50%; cursor: pointer;
                  color: rgba(255,255,255,.9); background: rgba(30,31,39,.9); border: 1px solid rgba(255,255,255,.12);
                  box-shadow: 0 6px 18px rgba(0,0,0,.28); transition: background .15s, color .15s, transform .15s, opacity .2s; }
      .icon-btn:hover { background: rgba(48,50,62,.9); color: #fff; filter: none; }
      .icon-btn:active { transform: scale(.94); }
      .icon-btn:focus-visible { outline: 2px solid #fa2d48; outline-offset: 2px; }
      .icon-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .fab { width: 40px; height: 40px; opacity: .75; pointer-events: auto; }
      .fab::before { content: ''; position: absolute; inset: -8px; border-radius: 50%; } /* 少し外れていても反応するように */
      .fab svg { width: 20px; height: 20px; }
      .dock.hover .fab, .dock.open .fab { opacity: 1; }
      .opt { width: 36px; height: 36px; opacity: 0; transform: translateY(10px) scale(.85); }
      .dock.hover .menu, .dock.open .menu, .dock:focus-within .menu { pointer-events: auto; }
      .dock.hover .opt, .dock.open .opt, .dock:focus-within .opt { opacity: 1; transform: none; }
      .dock.hover .opt:nth-last-child(2), .dock.open .opt:nth-last-child(2) { transition-delay: .04s; }
      .opt.done { color: #4ade80; }
      .opt.fail { color: #f87171; }
      .opt.busy svg { animation: pcs-spin .9s linear infinite; }
      @keyframes pcs-spin { to { transform: rotate(360deg); } }
      /* 名前の吹き出し(左に出る) */
      .icon-btn[data-tip]::after { content: attr(data-tip); position: absolute; right: calc(100% + 10px); top: 50%; transform: translate(4px, -50%);
                  white-space: nowrap; font-size: 12px; font-weight: 500; letter-spacing: .01em; color: #fff; background: rgba(20,21,27,.92);
                  border: 1px solid rgba(255,255,255,.1); padding: 5px 9px; border-radius: 8px; pointer-events: none; opacity: 0;
                  transition: opacity .12s, transform .12s; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
      .icon-btn[data-tip]:hover::after, .icon-btn[data-tip]:focus-visible::after, .icon-btn.show-tip::after { opacity: 1; transform: translate(0, -50%); }
      @media (prefers-reduced-motion: reduce) { .icon-btn, .icon-btn::after { transition: none; } .opt.busy svg { animation: none; } }
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
    <div class="col"><div class="wrap"></div><div class="dock" hidden><div class="menu"></div></div></div>`;
  const wrap = root.querySelector('.wrap');
  const dock = root.querySelector('.dock');
  const menu = root.querySelector('.menu');

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

  // 線で描くアイコン(d は SVG の線の形)
  const ICONS = {
    headphones: ['M3 18v-6a9 9 0 0 1 18 0v6', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z', 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z'],
    invite: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M19 8v6', 'M22 11h-6'],
    reverse: ['M3 8l4-4 4 4', 'M7 4v16', 'M21 16l-4 4-4-4', 'M17 20V4'],
    spinner: ['M21 12a9 9 0 1 1-6.2-8.56'],
    check: ['M20 6 9 17l-5-5'],
    alert: ['M12 8v5', 'M12 16.5v.01', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  };
  function lineIcon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  // 右下のヘッドフォンと、その上に出てくるボタン(招待・新しい曲から再生)。文字は出さず、名前は吹き出しで出す
  let dockKey = null;
  function iconButton(cls, icon, tip, onclick) {
    const b = el('button', { class: 'icon-btn ' + cls, type: 'button', 'aria-label': tip, 'data-tip': tip });
    b.appendChild(lineIcon(icon));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onclick();
    });
    return b;
  }
  // ヘッドフォンは最初に1つだけ作って、ずっと同じものを使う(作り直すと、カーソルが乗っていても「乗っていない」扱いになるため)
  let fab = null;
  function ensureFab(T) {
    if (!fab) {
      fab = iconButton('fab', 'headphones', '', () => dock.classList.toggle('open'));
      fab.removeAttribute('data-tip');
      dock.appendChild(fab);
    }
    fab.setAttribute('aria-label', T('dockTitle'));
  }
  // カーソルが乗ったらすぐ開き、離れても少しの間は開いたままにする(ボタンの間を動く時に閉じないように)
  let hoverTimer = null;
  dock.addEventListener('pointerenter', () => {
    clearTimeout(hoverTimer);
    dock.classList.add('hover');
  });
  dock.addEventListener('pointerleave', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => dock.classList.remove('hover'), 280);
  });
  function setOptButton(b, o) {
    const icon = o.id === 'invite' ? 'invite' : o.state === 'busy' ? 'spinner' : o.state === 'done' ? 'check' : o.state === 'fail' ? 'alert' : 'reverse';
    if (b.dataset.icon !== icon) {
      b.dataset.icon = icon;
      b.textContent = '';
      b.appendChild(lineIcon(icon));
    }
    b.className = 'icon-btn opt opt-' + o.id + (o.state ? ' ' + o.state : '') + (o.state === 'done' || o.state === 'fail' ? ' show-tip' : '');
    b.setAttribute('aria-label', o.tip);
    b.setAttribute('data-tip', o.tip);
    b.disabled = o.state === 'busy';
  }
  function updateDock(opts, T) {
    const k = JSON.stringify(opts);
    if (k === dockKey) return;
    dockKey = k;
    if (!opts.length) {
      dock.hidden = true;
      dock.classList.remove('open', 'hover');
      menu.textContent = '';
      return;
    }
    ensureFab(T);
    dock.hidden = false;
    // 今あるボタンはそのまま使い、中身だけ変える(変わる度に作り直すと、ちらついて見える)
    const have = new Map(Array.from(menu.children).map((b) => [b.dataset.opt, b]));
    const want = [];
    for (const o of opts) {
      let b = have.get(o.id);
      if (!b) {
        b = iconButton('opt', o.id === 'invite' ? 'invite' : 'reverse', o.tip, o.id === 'invite' ? () => sendAction('request') : playReversed);
        b.dataset.opt = o.id;
      }
      setOptButton(b, o);
      want.push(b);
    }
    for (const b of Array.from(menu.children)) if (!want.includes(b)) b.remove();
    want.forEach((b, i) => {
      if (menu.children[i] !== b) menu.insertBefore(b, menu.children[i] || null);
    });
  }
  document.addEventListener('click', () => dock.classList.remove('open'));

  let lastUi = null;
  function render(ui) {
    lastUi = ui;
    const showReverse = !!(ui && ui.myService === 'apple' && onPlaylistPage());
    const revText = reverse.text && Date.now() < reverse.until ? reverse.text : null;
    const key = JSON.stringify([ui, showReverse, reverse.busy, revText]);
    if (key === lastKey) return;
    lastKey = key;
    wrap.textContent = '';
    const T = (k, ...a) => PcsI18n.t(ui ? ui.lang : 'en', k, ...a); // 画面の言語(アイコンの画面で切り替える)
    // 右下のボタン: 招待(PC Status の人)と、新しい曲から再生(Apple Music を選んだ人が、プレイリストを開いている時)
    const opts = [];
    if (showReverse) {
      const state = reverse.busy ? 'busy' : revText ? (revText[0] === 'reverseDone' ? 'done' : 'fail') : '';
      opts.push({ id: 'reverse', state, tip: revText ? T(...revText) : reverse.busy ? T('reverseBusy') : T('playFromNewest') });
    }
    if (ui && ui.mode === 'agent' && !(ui.incoming || []).length) opts.push({ id: 'invite', tip: T('inviteTip') });
    updateDock(opts, T);
    if (!ui || (ui.mode === 'none' && !(ui.invites || []).length)) return; // 部屋にも入っておらず、招待も無い
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
    // 届いた曲が、自分のサービスで見つからなかった → 自分で探して流してもらう(その曲を代わりにする)
    if (ui.findSong) {
      wrap.appendChild(
        pill([text(T('notFoundTitle', ui.findSong.title)), text(T('notFoundHint'), 'muted')], [
          button(T('search'), () => sendAction('find-song'), true),
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
