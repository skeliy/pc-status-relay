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

  const UPDATE_CMDS = {
    win: 'Start-ScheduledTask -TaskName ListenTogetherUpdater',
    mac: 'launchctl kickstart -k gui/$(id -u)/com.skeliy.listentogether.updater',
  };

  function copyButton(textToCopy) {
    const b = el('button', { class: 'copy', text: T('copy') });
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textToCopy);
        b.textContent = T('copied');
        setTimeout(() => (b.textContent = T('copy')), 1800);
      } catch (e) {}
    });
    return b;
  }

  let folderTimer = null;
  function updateSection(up) {
    const parts = [el('div', { class: 'name', text: T('updateAvailable', up.latest, up.current) })];
    if (up.install === 'agent') {
      parts.push(el('div', { class: 'muted small', text: T('updateAgent') }));
    } else {
      const cmd = UPDATE_CMDS[up.os] || UPDATE_CMDS.win;
      parts.push(el('div', { class: 'muted small', text: T('updateAuto') }));
      parts.push(el('div', { class: 'cmd' }, [el('code', { text: cmd }), copyButton(cmd)]));
      parts.push(el('div', { class: 'muted small', text: up.os === 'mac' ? T('updateWhereMac') : T('updateWhereWin') }));
      parts.push(el('div', { class: 'muted small', text: T('updateReloads') }));
      if (up.install !== 'command') {
        parts.push(el('div', { class: 'muted small', text: T('updateZip') }));
        parts.push(el('a', { class: 'link', href: up.zipUrl, target: '_blank', text: T('download') }));
      }
      // 画面を開いている間は、新しい版が入ったかを3秒ごとに確かめる(入ったら拡張機能が読み込み直す)
      if (!folderTimer) folderTimer = setInterval(() => send({ type: 'check-folder' }), 3000);
    }
    return el('section', { class: 'update' }, parts);
  }

  const GEAR_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  let lyricsAsking = null; // インストールの確認を出しているか(null はまだ決めていない)

  function lyricsSection(data) {
    const lyr = data.lyrics;
    const titleRow = (note, controls) =>
      el('div', { class: 'switch-row' }, [
        el('div', { class: 'grow' }, [el('div', { class: 'name', id: 'lyricsLabel', text: T('lyricsShow') }), note ? el('div', { class: 'muted small', text: note }) : null]),
        ...controls,
      ]);

    // インストールの最中
    if (!lyr.installed && lyr.installing) {
      return section(null, [
        titleRow(T('lyricsInstalling'), []),
        el('div', { class: 'row' }, [el('button', { text: T('lyricsShowGuide'), onclick: () => send({ type: 'lyrics-guide', mode: 'install' }) })]),
      ]);
    }

    // まだ入っていない人には、はじめに一度だけ確認を出す(Apple Music と Spotify 以外を使っている人には、スイッチを押すまで出さない)
    if (!lyr.installed) {
      const service = data.client && data.client.service;
      if (lyricsAsking === null) lyricsAsking = lyr.askFirst && (!service || service === 'apple' || service === 'spotify');
      if (lyricsAsking) {
        return section(null, [
          el('div', { class: 'name', text: T('lyricsAskTitle') }),
          el('div', { class: 'muted small', text: T('lyricsAskBody') }),
          el('div', { class: 'row' }, [
            el('button', { class: 'primary', text: T('lyricsYes'), onclick: () => send({ type: 'lyrics-guide', mode: 'install' }) }),
            el('button', { text: T('lyricsNo'), onclick: async () => { lyricsAsking = false; await send({ type: 'lyrics-dismiss' }); refresh(true); } }),
          ]),
        ]);
      }
    }

    const sw = el('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-labelledby': 'lyricsLabel',
      'aria-checked': String(lyr.running && lyr.enabled),
      onclick: async () => {
        if (!lyr.installed) {
          lyricsAsking = true;
          return refresh(true);
        }
        const next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(next));
        if (lyr.running) {
          await send({ type: 'lyrics-set-enabled', enabled: next });
          refresh(true);
        } else if (next) {
          send({ type: 'lyrics-guide', mode: 'start' });
        }
      },
    });
    const controls = [sw];
    if (lyr.installed) {
      const gear = el('button', {
        class: 'icon-btn',
        type: 'button',
        title: T('lyricsSettings'),
        'aria-label': T('lyricsSettings'),
        onclick: () => {
          send({ type: 'lyrics-open-settings' });
          setTimeout(() => window.close(), 150);
        },
      });
      gear.innerHTML = GEAR_ICON;
      controls.unshift(gear);
    }
    return section(null, [titleRow(lyr.installed && !lyr.running ? T('lyricsNotRunning') : null, controls)]);
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

    // 新しい版(アイコンの画面を開くたびに確かめる)
    const up = data.update;
    const verEl = document.getElementById('ver');
    verEl.classList.toggle('new', !!(up && up.available));
    verEl.title = up && up.latest && !up.available ? T('upToDate') : '';
    if (up && up.available) app.appendChild(updateSection(up));

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

    // 前に入った部屋(通行証がある部屋)。開いていれば「参加する」で途中から入れる
    const joinable = (data.rooms || []).filter((r) => !(room && r.current));
    if (joinable.length) {
      app.appendChild(
        section(
          T('roomsTitle'),
          joinable.map((r) => {
            let sub;
            if (!r.known) sub = T('checking');
            else if (!r.open) sub = r.canHost ? T('roomClosedCanHost') : T('roomClosedNow');
            else sub = r.playing ? T('nowPlaying', r.playing.title || '?', r.playing.artist) : T('nobodyPlaying');
            const lines = [el('div', { class: 'name', text: T('roomOf', r.owner) }), el('div', { class: 'muted small', text: sub })];
            const names = (r.members || []).map((m) => (m.host ? `${m.label} (${T('hostTag')})` : m.label));
            if (r.open && names.length) lines.push(el('div', { class: 'muted small', text: T('inRoomNow', names.join(T('sep'))) }));
            return el('div', { class: 'roomrow' + (r.open && r.playing ? ' live' : '') }, [
              el('div', { class: 'grow' }, lines),
              // 開いていれば「参加する」、閉じていれば「ホストする」(だれかが先にホストしていたら、自動で参加になる)
              r.open || r.canHost
                ? el('button', {
                    class: 'primary',
                    text: r.open ? T('join') : T('host'),
                    onclick: (e) => {
                      e.target.disabled = true;
                      // 通行証の部屋は「ホストする/参加する」、一緒に聴いた人の部屋は友達として入る
                      action({ action: r.friend && !r.pass ? 'join-friend' : 'host', room: r.room });
                    },
                  })
                : null,
            ]);
          })
        )
      );
    }

    // 今一緒に聴いている人
    if (room) {
      const rows = (room.members || []).map((m) =>
        el('div', { class: 'row' }, [
          el('span', { class: 'dot on' }),
          el('span', { class: 'name', text: m.id === room.you ? m.label + T('youSuffix') : m.label }),
          m.host || m.id === room.host ? el('span', { class: 'tag', text: T('hostTag') }) : null,
          el('span', { class: 'svc', text: SERVICE_NAMES[m.service] || '' }),
        ])
      );
      const head = T('roomOf', room.owner || '') + (ui.connected ? '' : T('connectingSuffix'));
      const buttons = [];
      if (room.role === 'self') {
        if ((room.members || []).length > 1) buttons.push(el('button', { text: T('endAll'), onclick: () => action({ action: 'end-self' }) }));
      } else if (ui.mode === 'guest') buttons.push(el('button', { text: T('leave'), onclick: () => action({ action: 'leave' }) }));
      else if ((room.members || []).length > 1) {
        buttons.push(el('button', { text: room.role === 'owner' ? T('endAll') : T('leave'), onclick: () => action({ action: 'stop' }) }));
      }
      app.appendChild(
        section(head, [
          ...(rows.length ? rows : [el('div', { class: 'empty', text: data.musicTabOpen ? T('connectingShort') : T('openMusic') })]),
          buttons.length ? el('div', { class: 'row' }, buttons) : null,
        ])
      );
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
    } else if (!ui.invites.length && !joinable.length) {
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

    // 歌詞オーバーレイ
    if (data.lyrics && data.lyrics.supported) app.appendChild(lyricsSection(data));

    // 自分の名前とサービス。同じPCでエージェントが動いていても、ブラウザのプロフィールごとに変えられるようにする
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

    // うまく動かない時に送ってもらう情報(最近の記録と今の状態。鍵やパスワードは入らない)
    const dbg = el('button', { text: T('copyDebug') });
    const dbgNote = el('div', { class: 'muted small' });
    dbg.addEventListener('click', async () => {
      const r = await send({ type: 'debug-info' });
      if (!r || !r.ok) return;
      try {
        await navigator.clipboard.writeText(r.text);
        dbgNote.textContent = T('copyDebugDone');
      } catch (e) {
        dbgNote.textContent = '';
      }
    });
    app.appendChild(section(null, [el('div', { class: 'row' }, [dbg]), dbgNote]));
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
