// ツールバーのアイコンを押した時の画面。
// 届いた招待(参加する/断る)、今一緒に聴いている人、前に参加した人(1人ずつ招待できる)、
// 自分の名前と使っているサービスの設定を表示する。
(function () {
  const SERVICE_NAMES = { apple: 'Apple Music', spotify: 'Spotify', ytm: 'YouTube Music', youtube: 'YouTube', none: '?' };
  const app = document.getElementById('app');

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
      app.appendChild(section(null, [el('div', { class: 'empty', text: '拡張機能の裏方に繋がりませんでした。もう一度開いてください。' })]));
      return;
    }
    document.getElementById('ver').textContent = 'v' + data.version;
    const ui = data.ui;
    const room = ui.room;

    if (ui.notice) app.appendChild(section(null, [el('div', { class: 'notice', text: ui.notice })]));

    // 届いた招待
    if (ui.invites.length || ui.incoming.length) {
      const list = [];
      for (const inv of ui.invites) {
        list.push(
          el('div', { class: 'invite' }, [
            el('div', { text: `${inv.fromLabel} から招待が届いています` }),
            el('div', { class: 'muted', text: `${inv.owner} の部屋` }),
            el('div', { class: 'row' }, [
              el('button', { class: 'primary', text: '参加する', onclick: () => action({ action: 'accept-invite', code: inv.code }) }),
              el('button', { text: '断る', onclick: () => action({ action: 'decline-invite', code: inv.code }) }),
            ]),
          ])
        );
      }
      for (const req of ui.incoming) {
        list.push(
          el('div', { class: 'invite' }, [
            el('div', { text: `${req.label} がリクエストしています` }),
            el('div', { class: 'row' }, [
              el('button', { class: 'primary', text: '許可', onclick: () => action({ action: 'accept', sessionId: req.sessionId }) }),
              el('button', { text: '拒否', onclick: () => action({ action: 'decline', sessionId: req.sessionId }) }),
            ]),
          ])
        );
      }
      app.appendChild(section('招待', list));
    }

    // 今一緒に聴いている人
    if (room) {
      const rows = (room.members || []).map((m) =>
        el('div', { class: 'row' }, [
          el('span', { class: 'dot on' }),
          el('span', { class: 'name', text: m.id === room.you ? `${m.label}(あなた)` : m.label }),
          el('span', { class: 'svc', text: SERVICE_NAMES[m.service] || '' }),
        ])
      );
      const head = `${room.owner || ''} の部屋${ui.connected ? '' : '(接続中…)'}`;
      const buttons = [];
      if (ui.mode === 'guest') buttons.push(el('button', { text: '退出', onclick: () => action({ action: 'leave' }) }));
      else if ((room.members || []).length > 1) {
        buttons.push(el('button', { text: room.role === 'owner' ? '終了(全員が出ます)' : '退出', onclick: () => action({ action: 'stop' }) }));
      }
      app.appendChild(
        section(head, [
          ...(rows.length ? rows : [el('div', { class: 'empty', text: data.musicTabOpen ? '接続しています…' : '音楽サービスのページを開くと、部屋に繋がります' })]),
          buttons.length ? el('div', { class: 'row' }, buttons) : null,
        ])
      );
      if (ui.queue && ui.queue.length) {
        app.appendChild(section('次に流れる曲', [el('ol', {}, ui.queue.map((q) => el('li', { text: `${q.title}${q.artist ? ' / ' + q.artist : ''}` })))]));
      }
      // 前に参加した人(今いない人)に、1人ずつ招待を送る
      const known = room.known || [];
      if (known.length) {
        app.appendChild(
          section(
            '前に参加した人',
            known.map((k) =>
              el('div', { class: 'row' }, [
                el('span', { class: 'dot' + (k.online ? ' on' : ''), title: k.online ? 'オンライン' : 'オフライン' }),
                el('span', { class: 'name', text: k.label }),
                el('span', { class: 'svc', text: SERVICE_NAMES[k.service] || '' }),
                el('button', { class: 'primary', text: '招待', onclick: (e) => { e.target.disabled = true; action({ action: 'invite', target: k.key }); } }),
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
              ? '部屋に繋がっていません。音楽サービスのページを開いてください。'
              : 'まだ部屋に入っていません。友達から届いた「一緒に聴く」のリンクを開くか、招待が届くのを待ってください。招待が届くと、音が鳴ってこのアイコンに印が付きます。',
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
        text: '保存',
        onclick: async () => {
          save.disabled = true;
          await send({ type: 'set-profile', label: name.value.trim(), service: svc.value });
          save.textContent = '保存しました';
          setTimeout(refresh, 600);
        },
      });
      app.appendChild(section('あなたの設定', [el('label', { text: '名前(みんなに表示されます)' }), name, el('label', { text: '使っている音楽サービス' }), svc, el('div', { class: 'row' }, [save])]));
    }
  }

  async function refresh() {
    // 名前などを入力している最中は、画面を描き直さない(入力が消えてしまうため)
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    const r = await send({ type: 'popup-state' });
    render(r && r.ok ? r.data : null);
  }

  refresh();
  setInterval(refresh, 2000);
})();
