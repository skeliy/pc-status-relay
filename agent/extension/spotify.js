// Spotify(open.spotify.com、ブラウザ版)のページの中で動く部品。
//
// Spotify には、ページから操作するための公開された仕組みが無いので、聞く人が自分の手でやるのと
// 同じ操作だけで動かす:
//   - 今の曲 … 画面下の「再生中」の表示と、ページが OS に知らせている再生情報(Media Session)を読む
//   - 再生・一時停止・シーク … ページが OS のメディアキー用に用意している操作を呼ぶ(無ければボタンを押す)
//   - 曲を流す … 検索画面で曲を探し、その曲のページを開いて再生ボタンを押す
// Spotify の内部の仕組み(非公開のAPIや合言葉)は使わない。Spotify の利用規約で禁止されているため。
// 画面の作りが変わると動かなくなることがあるので、問題の調査用に window.__pcsSpotifyDebug() を用意してある。
(function () {
  const SERVICE = 'spotify';
  const SRC_PAGE = 'pcs-page';
  const SRC_EXT = 'pcs-ext-cmd';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const M = () => window.__pcsMatch;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // --- ページが OS に知らせる再生情報を受け取っておく(ページより先に動く必要があるので document_start) ---
  const captured = window.__pcsSpotifyCaptured || { handlers: {}, position: null };
  window.__pcsSpotifyCaptured = captured;
  if (navigator.mediaSession && !navigator.mediaSession.__pcsWrapped) {
    const ms = navigator.mediaSession;
    const origSet = ms.setActionHandler.bind(ms);
    ms.setActionHandler = function (action, handler) {
      captured.handlers[action] = handler;
      return origSet(action, handler);
    };
    if (ms.setPositionState) {
      const origPos = ms.setPositionState.bind(ms);
      ms.setPositionState = function (state) {
        if (state) captured.position = { duration: state.duration, position: state.position, rate: state.playbackRate || 1, at: Date.now() };
        return origPos(state);
      };
    }
    ms.__pcsWrapped = true;
  }

  if (window.__pcsAdapter) {
    try {
      window.__pcsAdapter.stop();
    } catch (e) {}
  }

  function trackIdFromHref(href) {
    const m = String(href || '').match(/track[/:]([A-Za-z0-9]{22})/);
    return m ? m[1] : null;
  }

  function nowPlayingRoot() {
    return $('[data-testid="now-playing-widget"]') || $('[data-testid="now-playing-widget-v2"]') || $('[data-testid="now-playing-bar"]') || $('footer');
  }

  function norm(s) {
    return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // 今の曲の曲名とアーティスト(OS に知らせている再生情報 → 画面下の表示、の順に見る)
  function currentMeta() {
    const meta = navigator.mediaSession && navigator.mediaSession.metadata;
    if (meta && meta.title) return { title: meta.title, artist: meta.artist || '', album: meta.album || '' };
    const root = nowPlayingRoot();
    if (!root) return { title: '', artist: '', album: '' };
    const titleEl = $('[data-testid="context-item-info-title"]', root) || $('[data-testid="context-item-link"]', root) || $('a[href*="/album/"], a[href*="/track/"]', root);
    const artists = $$('a[href*="/artist/"]', root).map((a) => a.textContent.trim()).filter(Boolean);
    return { title: titleEl ? titleEl.textContent.trim() : '', artist: artists.join(', '), album: '' };
  }

  function metaKey(m) {
    return norm(m.title) + '|' + norm(m.artist);
  }

  // こちらで流した曲(曲名・アーティスト → Spotify の曲の番号)。
  // 今の Spotify の画面下の表示には曲そのもののリンクが無いので、曲名で見分ける
  const loadedIds = new Map();

  function currentTrackId() {
    const root = nowPlayingRoot();
    if (root) {
      for (const a of $$('a[href]', root)) {
        let href = a.getAttribute('href') || '';
        try {
          href = decodeURIComponent(href);
        } catch (e) {}
        const id = trackIdFromHref(href);
        if (id) return id;
      }
    }
    const m = currentMeta();
    return m.title ? loadedIds.get(metaKey(m)) || null : null;
  }

  // 再生ボタンの表示(言語によって違う)。'pause' = 今流れている(押すと止まる)、'play' = 止まっている
  function buttonState(btn) {
    const label = String((btn && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || '');
    if (/pause|一時停止|일시정지|暂停|暫停|pausa|pausar/i.test(label)) return 'pause';
    if (/play|再生|재생|播放|reproducir|lecture/i.test(label)) return 'play';
    return null;
  }

  function readPosition() {
    const pos = captured.position;
    const playing = isPlayingNow();
    const range = $('[data-testid="playback-progressbar"] input[type="range"]');
    if (range && Number(range.max) > 0) {
      const max = Number(range.max);
      const scale = max > 10000 ? 1000 : 1; // ミリ秒か秒か
      return { position: Number(range.value) / scale, duration: max / scale };
    }
    if (pos && pos.duration) {
      const extra = playing ? ((Date.now() - pos.at) / 1000) * pos.rate : 0;
      return { position: Math.min(pos.duration, pos.position + extra), duration: pos.duration };
    }
    const p = M() ? M().parseClock(($('[data-testid="playback-position"]') || {}).textContent) : 0;
    const d = M() ? M().parseClock(($('[data-testid="playback-duration"]') || {}).textContent) : 0;
    return { position: p, duration: d };
  }

  // 再生中かどうか: Media Session の状態 → 再生位置が進んでいるか、の順に見る
  let lastPosText = null;
  let lastPosChange = 0;
  function isPlayingNow() {
    const s = navigator.mediaSession && navigator.mediaSession.playbackState;
    if (s === 'playing') return true;
    if (s === 'paused') return false;
    const b = buttonState($('[data-testid="control-button-playpause"]'));
    if (b) return b === 'pause';
    const text = ($('[data-testid="playback-position"]') || {}).textContent || '';
    if (text !== lastPosText) {
      lastPosText = text;
      lastPosChange = Date.now();
    }
    return Date.now() - lastPosChange < 1600;
  }

  function loggedIn() {
    return !$('[data-testid="login-button"]');
  }

  function readState() {
    if (!$('[data-testid="now-playing-bar"]') && !$('[data-testid="player-controls"]')) return { available: false, service: SERVICE };
    const meta = currentMeta();
    const trackId = currentTrackId();
    // 曲の番号が分からない曲(自分で選んだ曲)は、曲名とアーティストで見分ける。番号は相手に送らず、曲名で探してもらう
    const id = trackId || (meta.title ? 'meta:' + metaKey(meta) : null);
    const playing = isPlayingNow();
    const { position, duration } = readPosition();
    return {
      available: true,
      loggedIn: loggedIn(),
      service: SERVICE,
      quietResolve: false, // 曲を探すと検索画面に移動してしまうので、先読みはしない
      queue: [],
      song: id
        ? {
            id,
            localOnly: !trackId,
            title: meta.title || null,
            artist: meta.artist || null,
            album: meta.album || null,
            duration,
            isrc: null,
          }
        : null,
      isPlaying: playing,
      phase: !id ? 'idle' : playing ? 'playing' : 'paused',
      position,
    };
  }

  // --- 画面の操作 ---
  function spaNavigate(path) {
    // ページの中の移動(ページを読み込み直さないので、音も止まらない)
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  }

  function rowCandidates() {
    return $$('[data-testid="tracklist-row"]').map((row) => {
      const link = $('a[href*="/track/"]', row) || $('[data-testid="internal-track-link"]', row);
      const artists = $$('a[href*="/artist/"]', row).map((a) => a.textContent).join(', ');
      const clock = $$('div, span', row)
        .map((e) => e.childElementCount === 0 && e.textContent.trim())
        .find((t) => t && /^\d{1,2}:\d{2}$/.test(t));
      return {
        id: link ? trackIdFromHref(link.getAttribute('href')) : null,
        title: link ? link.textContent : '',
        artist: artists,
        duration: M().parseClock(clock),
      };
    }).filter((c) => c.id);
  }

  async function searchUi(query) {
    spaNavigate('/search/' + encodeURIComponent(query) + '/tracks');
    await sleep(600);
    await waitFor(() => $$('[data-testid="tracklist-row"]').length > 0, 8000);
    await sleep(400);
    return rowCandidates();
  }

  async function resolve(desc) {
    if (desc.ids && desc.ids.spotify) return desc.ids.spotify;
    const queries = [];
    if (desc.isrc) queries.push('isrc:' + desc.isrc);
    queries.push([desc.title, desc.artist].filter(Boolean).join(' '));
    for (const q of queries) {
      const candidates = await searchUi(q);
      if (q.startsWith('isrc:') && candidates.length === 1) return candidates[0].id;
      const hit = M().best(candidates, desc);
      if (hit) return hit.id;
    }
    return null;
  }

  function clickPlayPause() {
    const btn = $('[data-testid="control-button-playpause"]');
    if (btn) btn.click();
  }

  async function setPlaying(want) {
    if (isPlayingNow() === want) return;
    const h = captured.handlers[want ? 'play' : 'pause'];
    if (h) {
      try {
        h({ action: want ? 'play' : 'pause' });
        return;
      } catch (e) {}
    }
    // 下の再生ボタンは「再生/一時停止」の切り替え。表示を確かめて、逆にしてしまう時は押さない
    const st = buttonState($('[data-testid="control-button-playpause"]'));
    if (st === null || st === (want ? 'play' : 'pause')) clickPlayPause();
  }

  function seekTo(sec) {
    const h = captured.handlers.seekto;
    if (h) {
      try {
        h({ action: 'seekto', seekTime: sec });
        return;
      } catch (e) {}
    }
    const range = $('[data-testid="playback-progressbar"] input[type="range"]');
    if (range) {
      const scale = Number(range.max) > 10000 ? 1000 : 1;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, String(Math.round(sec * scale)));
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function adjusted(cmd) {
    const elapsed = cmd.play ? Math.max(0, (Date.now() - cmd.issuedAt) / 1000) : 0;
    return Math.max(0, (cmd.position || 0) + elapsed);
  }

  async function load(cmd) {
    if (!loggedIn()) return { ok: false, error: 'not logged in to Spotify' };
    const before = readState();
    const id = cmd.songId || (await resolve(cmd.desc || {}));
    if (!id) return { ok: false, error: 'notfound', localId: before.song ? before.song.id : null };
    if (currentTrackId() !== id) {
      spaNavigate('/track/' + id);
      const btn = await waitFor(() => {
        const page = $('[data-testid="track-page"]');
        return page && ($('[data-testid="action-bar-row"] [data-testid="play-button"]', page) || $('[data-testid="play-button"]', page));
      }, 8000);
      if (!btn) return { ok: false, error: 'no play button on the track page' };
      await sleep(300);
      const page = $('[data-testid="track-page"]');
      const pageTitle = norm((($('[data-testid="entityTitle"]', page) || $('h1', page) || {}).textContent) || '');
      const before = metaKey(currentMeta());
      // 曲のページの再生ボタンは「再生/一時停止」の切り替え。もう流れている曲で押すと止まってしまうので、その時は押さない
      if (buttonState(btn) !== 'pause') btn.click();
      const ok = await waitFor(() => {
        const m = currentMeta();
        return m.title && ((pageTitle && norm(m.title) === pageTitle) || metaKey(m) !== before);
      }, 8000);
      if (!ok) return { ok: false, error: 'could not start the song' };
      loadedIds.set(metaKey(currentMeta()), id); // 次からは、この曲名ならこの番号の曲と分かる
    }
    if (cmd.play) await setPlaying(true);
    else await setPlaying(false);
    await sleep(400);
    const pos = adjusted(cmd);
    if (pos > 1) seekTo(pos);
    return { ok: true, resolvedId: id };
  }

  async function run(cmd) {
    if (cmd.action === 'load') return load(cmd);
    if (cmd.action === 'seek') seekTo(adjusted(cmd));
    else if (cmd.action === 'play') await setPlaying(true);
    else if (cmd.action === 'pause') await setPlaying(false);
    return { ok: true };
  }

  function post(kind, payload) {
    window.postMessage(Object.assign({ source: SRC_PAGE, kind }, payload), '*');
  }

  function onMessage(e) {
    if (e.source !== window || !e.data || e.data.source !== SRC_EXT) return;
    const cmd = e.data.cmd;
    run(cmd)
      .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      .then((res) => post('result', { result: Object.assign({ id: cmd.id }, res) }))
      .finally(() => post('state', { state: readState() }));
  }

  window.addEventListener('message', onMessage);
  const timer = setInterval(() => {
    if (document.readyState !== 'loading') post('state', { state: readState() });
  }, 400);

  // 動かない時の調査用(ブラウザの開発者ツールのコンソールで window.__pcsSpotifyDebug() と打つ)
  window.__pcsSpotifyDebug = () => ({
    state: readState(),
    handlers: Object.keys(captured.handlers),
    positionState: captured.position,
    mediaSession: navigator.mediaSession && {
      playbackState: navigator.mediaSession.playbackState,
      title: navigator.mediaSession.metadata && navigator.mediaSession.metadata.title,
    },
    testids: Array.from(new Set($$('[data-testid]').map((e) => e.getAttribute('data-testid')))).slice(0, 120),
  });

  window.__pcsAdapter = {
    service: SERVICE,
    readState,
    resolve,
    stop() {
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
    },
  };
})();
