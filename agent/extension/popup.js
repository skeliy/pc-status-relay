// ツールバーのアイコンを押した時の画面。右上の地球のボタンで、英語と日本語を切り替える(初期は英語)。
// 届いた招待(参加する/断る)、今一緒に聴いている人、前に参加した人(1人ずつ招待できる)、
// 自分の名前と使っているサービスの設定を表示する。
(function () {
  const SERVICE_NAMES = { apple: 'Apple Music', spotify: 'Spotify', ytm: 'YouTube Music', youtube: 'YouTube', none: '?' };
  const app = document.getElementById('app');
  let lang = 'en';
  const T = (k, ...a) => PcsI18n.t(lang, k, ...a);
  const person = (label, service) => (lang === 'ja' ? `${label}(${SERVICE_NAMES[service] || '?'})` : `${label} (${SERVICE_NAMES[service] || '?'})`);

  // 言語のメニュー
  const langBtn = document.getElementById('langBtn');
  const langMenu = document.getElementById('langMenu');
  function setMenu(open) {
    langMenu.classList.toggle('hidden', !open);
    langBtn.setAttribute('aria-expanded', String(open));
  }
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(langMenu.classList.contains('hidden'));
  });
  document.addEventListener('click', () => setMenu(false));
  langMenu.querySelectorAll('[data-lang]').forEach((b) =>
    b.addEventListener('click', async () => {
      lang = b.dataset.lang;
      setMenu(false);
      applyLang();
      await chrome.storage.local.set({ lang }); // 裏方と音楽ページの表示も同じ言語になる
      refresh(true);
    })
  );
  function applyLang() {
    document.documentElement.lang = lang;
    document.getElementById('brand').textContent = T('brand');
    document.getElementById('langLabel').textContent = lang === 'ja' ? '日本語' : 'EN';
    langBtn.setAttribute('aria-label', T('language'));
    langMenu.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === lang)));
  }

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

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
  }

  async function action(body) {
    await send({ type: 'action', body });
    setTimeout(refresh, 400);
  }

  function section(title, children) {
    return el('section', {}, [title ? el('h2', { text: title }) : null, ...children]);
  }

  function render(data) {
    app.textContent = '';
    if (!data) {
      app.appendChild(section(null, [el('div', { class: 'empty', text: T('noBackground') })]));
      return;
    }
    document.getElementById('ver').textContent = 'v' + data.version;
    const ui = data.ui;
    if (ui.lang && ui.lang !== lang) {
      lang = PcsI18n.norm(ui.lang);
      applyLang();
    }
    const room = ui.room;

    if (ui.notice) app.appendChild(section(null, [el('div', { class: 'notice', text: PcsI18n.fmt(lang, ui.notice) })]));

    // 届いた招待
    if (ui.invites.length || ui.incoming.length) {
      const list = [];
      for (const inv of ui.invites) {
        list.push(
          el('div', { class: 'invite' }, [
            el('div', { text: T('inviteFrom', inv.fromLabel).replace(/^🎵 /, '') }),
            el('div', { class: 'muted', text: T('roomOf', inv.owner) }),
            el('div', { class: 'row' }, [
              el('button', { class: 'primary', text: T('join'), onclick: () => action({ action: 'accept-invite', code: inv.code }) }),
              el('button', { text: T('decline'), onclick: () => action({ action: 'decline-invite', code: inv.code }) }),
            ]),
          ])
        );
      }
      for (const req of ui.incoming) {
        list.push(
          el('div', { class: 'invite' }, [
            el('div', { text: T('requestShort', req.label) }),
            el('div', { class: 'row' }, [
              el('button', { class: 'primary', text: T('allow'), onclick: () => action({ action: 'accept', sessionId: req.sessionId }) }),
              el('button', { text: T('deny'), onclick: () => action({ action: 'decline', sessionId: req.sessionId }) }),
            ]),
          ])
        );
      }
      app.appendChild(section(T('invitesTitle'), list));
    }

    // 今一緒に聴いている人
    if (room) {
      const rows = (room.members || []).map((m) =>
        el('div', { class: 'row' }, [
          el('span', { class: 'dot on' }),
          el('span', { class: 'name', text: m.id === room.you ? m.label + T('youSuffix') : m.label }),
          el('span', { class: 'svc', text: SERVICE_NAMES[m.service] || '' }),
        ])
      );
      const head = T('roomOf', room.owner || '') + (ui.connected ? '' : T('connectingSuffix'));
      const buttons = [];
      if (ui.mode === 'guest') buttons.push(el('button', { text: T('leave'), onclick: () => action({ action: 'leave' }) }));
      else if ((room.members || []).length > 1) {
        buttons.push(el('button', { text: room.role === 'owner' ? T('endAll') : T('leave'), onclick: () => action({ action: 'stop' }) }));
      }
      app.appendChild(
        section(head, [
          ...(rows.length ? rows : [el('div', { class: 'empty', text: data.musicTabOpen ? T('connectingShort') : T('openMusic') })]),
          buttons.length ? el('div', { class: 'row' }, buttons) : null,
        ])
      );
      if (ui.queue && ui.queue.length) {
        app.appendChild(section(T('upNext'), [el('ol', {}, ui.queue.map((q) => el('li', { text: `${q.title}${q.artist ? ' / ' + q.artist : ''}` })))]));
      }
      // 前に参加した人(今いない人)に、1人ずつ招待を送る
      const known = room.known || [];
      if (known.length) {
        app.appendChild(
          section(
            T('previous'),
            known.map((k) =>
              el('div', { class: 'row' }, [
                el('span', { class: 'dot' + (k.online ? ' on' : ''), title: k.online ? T('online') : T('offline') }),
                el('span', { class: 'name', text: k.label }),
                el('span', { class: 'svc', text: SERVICE_NAMES[k.service] || '' }),
                el('button', { class: 'primary', text: T('invite'), onclick: (e) => { e.target.disabled = true; action({ action: 'invite', target: k.key }); } }),
              ])
            )
          )
        );
      }
    } else if (!ui.invites.length) {
      app.appendChild(
        section(null, [
          el('div', {
            class: 'empty',
            text: data.hasAgent
              ? T('notConnectedAgent')
              : T('notJoined'),
          }),
        ])
      );
    }

    // 自分の名前とサービス(拡張機能だけの人)
    if (!data.hasAgent) {
      const name = el('input', { type: 'text', maxlength: '40', value: (data.client && data.client.label) || '' });
      const svc = el('select', {}, Object.entries(SERVICE_NAMES).filter(([k]) => k !== 'none').map(([k, v]) => {
        const o = el('option', { value: k, text: v });
        if (data.client && data.client.service === k) o.selected = true;
        return o;
      }));
      const save = el('button', {
        text: T('save'),
        onclick: async () => {
          save.disabled = true;
          await send({ type: 'set-profile', label: name.value.trim(), service: svc.value });
          save.textContent = T('saved');
          setTimeout(refresh, 600);
        },
      });
      app.appendChild(section(T('yourSettings'), [el('label', { text: T('nameLabel') }), name, el('label', { text: T('serviceLabel') }), svc, el('div', { class: 'row' }, [save])]));
    }
  }

  async function refresh(force) {
    // 名前などを入力している最中は、画面を描き直さない(入力が消えてしまうため)
    const active = document.activeElement;
    if (!force && active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    const r = await send({ type: 'popup-state' });
    render(r && r.ok ? r.data : null);
  }

  chrome.storage.local.get('lang', (st) => {
    lang = PcsI18n.norm(st && st.lang);
    applyLang();
    refresh(true);
  });
  setInterval(() => refresh(false), 2000);
})();
