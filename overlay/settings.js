(async function () {
  const ja = new URLSearchParams(location.search).get('lang') === 'ja';
  const TEXT = ja
    ? {
        title: 'Listen Together の設定',
        notifyTitle: '通知',
        lyricsTitle: '歌詞',
        voiceNotify: '通話の通知(Discord の通話に人が入った時)',
        voiceHelp: 'だれもいない通話に1人目が入った時に、右下に出して音を鳴らします。全画面のゲーム中は音だけ鳴ります。',
        gameNotify: 'ゲームの通知(友達がゲームを始めた時)',
        gameHelp: '友達がゲームを起動した時に、右下に小さく出します(音なし)。オンの間は、あなたのゲームも友達に知らせます。Steam のゲームは知らせません。',
        test: 'テスト',
        stateWait: 'skeliy があなたを設定するまで、通知は届きません(テストは試せます)。',
        stateOk: (n) => `${n} として通知を受け取ります。`,
        stateOff: '中継サーバーに繋がっていません。インターネットの接続を確かめてください。',
        enabled: '歌詞を表示する',
        opacity: '透明度(不透明さ)',
        fontSize: '文字の大きさ',
        width: '表示の幅',
        height: '表示の高さ',
        x: '横の位置',
        y: '縦の位置',
        move: 'ドラッグで位置を移動',
        moveDone: '移動を完了',
        moveHelp: '押すと歌詞の表示に枠が出て、マウスでつかんで動かせます。完了すると、クリックはまた下の画面に通り抜けます。',
        offsetMs: '歌詞のタイミング',
        offsetHelp: 'プラスにすると歌詞が早く進みます。音楽とずれる時に調整してください。',
        display: '表示するディスプレイ',
        shadow: '文字に薄い影を付ける(明るい画面でも読みやすくなります)',
        autoStart: 'Windows の起動時に開始する',
      }
    : {
        title: 'Listen Together settings',
        notifyTitle: 'Notifications',
        lyricsTitle: 'Lyrics',
        voiceNotify: 'Call notifications (when someone joins a Discord call)',
        voiceHelp: 'When someone joins an empty call, a small card appears at the bottom right with a sound. During full-screen games, only the sound plays.',
        gameNotify: 'Game notifications (when a friend starts a game)',
        gameHelp: 'Shows a small card at the bottom right when a friend starts a game (no sound). While this is on, your games are shared with friends too. Steam games are not shared.',
        test: 'Test',
        stateWait: 'Notifications start after skeliy sets you up (you can still try the test).',
        stateOk: (n) => `Receiving notifications as ${n}.`,
        stateOff: 'Cannot reach the server. Check your internet connection.',
        enabled: 'Show lyrics',
        opacity: 'Opacity',
        fontSize: 'Text size',
        width: 'Width',
        height: 'Height',
        x: 'Horizontal position',
        y: 'Vertical position',
        move: 'Drag to move',
        moveDone: 'Finish moving',
        moveHelp: 'Shows a frame around the lyrics that you can drag. When you finish, clicks pass through to the screen below again.',
        offsetMs: 'Lyrics timing',
        offsetHelp: 'Higher values move the lyrics earlier. Adjust this if they drift from the music.',
        display: 'Display',
        shadow: 'Add a soft text shadow (easier to read on bright screens)',
        autoStart: 'Start with Windows',
      };

  document.title = TEXT.title;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = TEXT[el.dataset.t];

  // 通知
  const stateEl = document.getElementById('notifyState');
  const showNotify = (n) => {
    if (!n) return;
    const off = n.relay === false;
    stateEl.textContent = off ? TEXT.stateOff : n.approved ? TEXT.stateOk((n.me && n.me.name) || '?') : TEXT.stateWait;
    stateEl.className = 'state' + (n.approved && !off ? '' : ' wait');
  };
  for (const b of document.querySelectorAll('[data-test]')) b.addEventListener('click', () => window.settingsApi.test(b.dataset.test));
  setInterval(async () => showNotify(await window.settingsApi.notifyState()), 3000);

  const { settings, status, displays, moveMode, notify } = await window.settingsApi.get();
  showNotify(notify);
  const statusEl = document.getElementById('status');
  statusEl.textContent = status;
  window.settingsApi.onStatus((s) => (statusEl.textContent = s));

  const FORMAT = {
    opacity: (v) => `${v}%`,
    fontSize: (v) => `${v}px`,
    width: (v) => `${v}px`,
    height: (v) => `${v}px`,
    x: (v) => `${Math.round(v)}%`,
    y: (v) => `${Math.round(v)}%`,
    offsetMs: (v) => `${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)}${ja ? '秒' : 's'}`,
  };

  for (const key of Object.keys(FORMAT)) {
    const input = document.getElementById(key);
    const output = document.querySelector(`output[for="${key}"]`);
    input.value = settings[key];
    output.textContent = FORMAT[key](settings[key]);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      output.textContent = FORMAT[key](value);
      window.settingsApi.set({ [key]: value });
    });
  }

  for (const key of ['enabled', 'shadow', 'autoStart', 'voiceNotify', 'gameNotify']) {
    const input = document.getElementById(key);
    input.checked = settings[key];
    input.addEventListener('change', () => window.settingsApi.set({ [key]: input.checked }));
  }

  const select = document.getElementById('displayId');
  for (const d of displays) {
    const option = document.createElement('option');
    option.value = String(d.id);
    option.textContent = d.label;
    option.selected = settings.displayId === d.id || (settings.displayId == null && d.primary);
    select.appendChild(option);
  }
  document.getElementById('displayField').hidden = displays.length < 2;
  select.addEventListener('change', () => window.settingsApi.set({ displayId: Number(select.value) }));

  // ドラッグで位置を変えるボタン
  const moveBtn = document.getElementById('moveBtn');
  const showMoveMode = (on) => {
    moveBtn.setAttribute('aria-pressed', String(on));
    moveBtn.textContent = on ? TEXT.moveDone : TEXT.move;
  };
  showMoveMode(moveMode);
  moveBtn.addEventListener('click', () => window.settingsApi.setMoveMode(moveBtn.getAttribute('aria-pressed') !== 'true'));
  window.settingsApi.onMoveMode(showMoveMode);

  // ほかの場所(拡張機能・ドラッグ)で変わった設定を、画面に反映する
  window.settingsApi.onSettings((next) => {
    for (const key of Object.keys(FORMAT)) {
      document.getElementById(key).value = next[key];
      document.querySelector(`output[for="${key}"]`).textContent = FORMAT[key](next[key]);
    }
    for (const key of ['enabled', 'shadow', 'autoStart', 'voiceNotify', 'gameNotify']) document.getElementById(key).checked = next[key];
    if (next.displayId != null) select.value = String(next.displayId);
  });
})();
