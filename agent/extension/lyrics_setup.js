// 歌詞アプリのインストールや起動の時に、ブラウザの確認で何を押せばいいかを案内するページ。
(function () {
  const INSTALL_CMD = 'irm https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/lyrics-install.ps1 | iex';
  const LINKS = { install: 'lyricsoverlay-setup://install', start: 'lyricsoverlay://start', settings: 'lyricsoverlay://settings' };
  const STUCK_MS = 3 * 60 * 1000; // インストールが進まないとみなすまでの時間
  const NOT_STARTING_MS = 12 * 1000; // 起動しないとみなすまでの時間

  const params = new URLSearchParams(location.search);
  const mode = LINKS[params.get('mode')] ? params.get('mode') : 'install';
  const reinstalling = params.get('force') === '1'; // アプリが動いたまま入れ直す時は、いったん止まるのを待つ
  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
  const closeTab = () => send({ type: 'lyrics-close-tab' });
  const startedAt = Date.now();
  let finished = false;
  let sawStopped = false;

  function fillText(lang) {
    const T = (k) => PcsI18n.t(lang, k);
    document.documentElement.lang = lang;
    const install = mode === 'install';
    const title = T(install ? 'guideInstallTitle' : mode === 'start' ? 'guideStartTitle' : 'guideSettingsTitle');
    document.title = title;
    const texts = {
      title,
      pressOpen: T('guidePressOpen'),
      mockTitle: T(install ? 'guideMockInstall' : 'guideMockStart'),
      mockBody: T('guideMockBody'),
      mockOpen: T('guideMockOpen'),
      mockCancel: T('guideMockCancel'),
      dontCancel: T('guideDontCancel'),
      waiting: T('guideWaiting'),
      again: T('guideShowAgain'),
      close: T('guideCancel'),
      notStarting: T('guideNotStarting'),
      reinstall: T('guideReinstall'),
      stuck: T('guideStuck'),
      cmd: INSTALL_CMD,
      copy: T('copy'),
      doneTitle: T('guideDoneTitle'),
      doneBody: T('guideDoneBody'),
      doneClose: T('guideCancel'),
      oldTitle: T('guideOldTitle'),
      oldBody: T('guideOldBody'),
      oldUpdate: T('guideOldUpdate'),
      oldClose: T('guideCancel'),
    };
    for (const [id, text] of Object.entries(texts)) $(id).textContent = text;
    $('working').textContent = install ? T('guideWorking') : '';
    $('working').hidden = !install;
    $('copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(INSTALL_CMD);
        $('copy').textContent = T('copied');
        setTimeout(() => ($('copy').textContent = T('copy')), 1800);
      } catch (e) {}
    });
  }

  function askBrowser() {
    location.href = LINKS[mode];
  }

  async function onStarted() {
    finished = true;
    if (mode === 'start') {
      await send({ type: 'lyrics-set-enabled', enabled: true });
      return closeTab();
    }
    if (mode === 'settings') {
      const opened = await send({ type: 'lyrics-try-settings' });
      if (opened && opened.ok) return closeTab();
      // 古い版のアプリは、拡張機能から設定画面を開けない。黙って閉じずに、更新を案内する
      $('guide').hidden = true;
      $('oldApp').hidden = false;
      return undefined;
    }
    $('guide').hidden = true;
    $('done').hidden = false;
  }

  async function poll() {
    if (finished) return;
    const state = await send({ type: 'lyrics-state' });
    if (state && !state.running) sawStopped = true;
    if (state && state.running && (!reinstalling || sawStopped)) return onStarted();
    const waited = Date.now() - startedAt;
    if (mode === 'install') $('stuckBox').hidden = waited < STUCK_MS;
    else $('reinstallBox').hidden = waited < NOT_STARTING_MS;
    setTimeout(poll, 1000);
  }

  $('again').addEventListener('click', askBrowser);
  $('close').addEventListener('click', async () => {
    if (mode === 'install') await send({ type: 'lyrics-install-cancel' });
    closeTab();
  });
  $('doneClose').addEventListener('click', closeTab);
  const reinstall = () => {
    location.href = chrome.runtime.getURL('lyrics_setup.html?mode=install&force=1');
  };
  $('reinstall').addEventListener('click', reinstall);
  $('oldUpdate').addEventListener('click', reinstall);
  $('oldClose').addEventListener('click', closeTab);

  chrome.storage.local.get('lang', async (stored) => {
    fillText(PcsI18n.norm(stored && stored.lang));
    const state = await send({ type: 'lyrics-state' });
    if (state && state.running && !reinstalling) return onStarted();
    if (mode === 'install') await send({ type: 'lyrics-install-mark' });
    askBrowser();
    poll();
  });
})();
