(async function () {
  const ja = new URLSearchParams(location.search).get('lang') === 'ja';
  const TEXT = ja
    ? {
        title: '歌詞オーバーレイの設定',
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
        title: 'Lyrics Overlay settings',
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

  const { settings, status, displays, moveMode } = await window.settingsApi.get();
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

  for (const key of ['enabled', 'shadow', 'autoStart']) {
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
    for (const key of ['enabled', 'shadow', 'autoStart']) document.getElementById(key).checked = next[key];
    if (next.displayId != null) select.value = String(next.displayId);
  });
})();
