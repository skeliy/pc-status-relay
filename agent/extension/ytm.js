// YouTube Music(music.youtube.com)のページの中で動く部品。
// ページにある再生プレイヤー(#movie_player)で、今の曲を読み取ったり、指定の曲を流したりする。
// 曲の検索は、ページ自身が検索の時に使う仕組みを、ページの中からそのまま使う。
(function () {
  const SERVICE = 'ytm';
  const SRC_PAGE = 'pcs-page';
  const SRC_EXT = 'pcs-ext-cmd';

  if (window.__pcsAdapter) {
    try {
      window.__pcsAdapter.stop();
    } catch (e) {}
  }

  const M = () => window.__pcsMatch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player');

  function artistFromBar() {
    const byline = document.querySelector('ytmusic-player-bar .byline');
    const text = byline ? byline.textContent || '' : '';
    const first = text.split('•')[0].trim();
    return first || null;
  }

  function readState() {
    const p = player();
    if (!p || !p.getVideoData) return { available: false, service: SERVICE };
    const data = p.getVideoData() || {};
    const state = p.getPlayerState ? p.getPlayerState() : -1;
    const ad = p.classList && p.classList.contains('ad-showing');
    const phase = ad
      ? 'ad'
      : { 1: 'playing', 2: 'paused', 3: 'loading', 0: 'ended', '-1': 'idle', 5: 'paused' }[state] || 'idle';
    if (!data.video_id) return { available: true, service: SERVICE, song: null, isPlaying: false, phase };
    return {
      available: true,
      service: SERVICE,
      quietResolve: true,
      queue: readQueue(),
      song: {
        id: data.video_id,
        title: data.title || null,
        artist: artistFromBar() || (data.author || '').replace(/\s*-\s*Topic$/i, '') || null,
        duration: p.getDuration ? p.getDuration() : 0,
        isrc: null,
      },
      isPlaying: !ad && state === 1,
      phase,
      position: ad ? 0 : p.getCurrentTime ? p.getCurrentTime() : 0,
    };
  }

  // 画面右側の「次に再生」の一覧(キュー)から、今の曲より後ろを読む
  function readQueue() {
    const items = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
    const cur = items.findIndex((e) => e.hasAttribute('selected'));
    if (cur < 0) return [];
    const runs = (x) => ((x || {}).runs || []).map((r) => r.text).join('');
    return items.slice(cur + 1, cur + 6).map((e) => {
      const d = e.data || {};
      return {
        ids: d.videoId ? { ytm: d.videoId } : {},
        title: runs(d.title) || null,
        artist: runs(d.shortBylineText) || null,
        duration: M().parseClock(runs(d.lengthText)),
      };
    }).filter((q) => q.title);
  }

  // 「曲」だけに絞った検索(ページの検索と同じ仕組み)
  // 届いた名前と、別の名前(英語・日本語など)のすべてで探して混ぜる
  // (カナダなどの Apple Music では日本の曲がローマ字になるので、日本語の名前でも探す)
  function senderFirst(desc) {
    const mine = locale();
    if (!desc.lang || desc.lang === mine.lang) return [null];
    return [{ hl: desc.lang, gl: desc.cc ? desc.cc.toUpperCase() : undefined }, null];
  }

  async function search(desc, loc) {
    const lists = await Promise.all(M().queries(desc, 3).map((q) => searchOnce(q, loc).catch(() => [])));
    const seen = new Set();
    const out = [];
    for (const c of [].concat(...lists)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }

  // loc: 検索結果の言語と国を変える時 { hl, gl }(送った人の言語で探すため)
  function searchContext(loc) {
    const ctx = JSON.parse(JSON.stringify(window.ytcfg.get('INNERTUBE_CONTEXT') || {}));
    if (loc) {
      ctx.client = ctx.client || {};
      if (loc.hl) ctx.client.hl = loc.hl;
      if (loc.gl) ctx.client.gl = loc.gl;
    }
    return ctx;
  }

  async function searchOnce(query, loc) {
    const cfg = window.ytcfg;
    if (!cfg || !cfg.get) throw new Error('ytcfg が見つかりません');
    const resp = await fetch('/youtubei/v1/search?prettyPrint=false&key=' + encodeURIComponent(cfg.get('INNERTUBE_API_KEY')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: searchContext(loc), query, params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' }),
    });
    const json = await resp.json();
    const items = [];
    (function walk(o) {
      if (!o || typeof o !== 'object' || items.length >= 10) return;
      if (o.musicResponsiveListItemRenderer) {
        items.push(o.musicResponsiveListItemRenderer);
        return;
      }
      for (const k in o) walk(o[k]);
    })(json);
    return items
      .map((it) => {
        const cols = (it.flexColumns || []).map((c) =>
          (((c.musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || []).map((r) => r.text).join('')
        );
        const id = (it.playlistItemData || {}).videoId || (JSON.stringify(it).match(/"videoId":"([\w-]{11})"/) || [])[1];
        const parts = (cols[1] || '').split('•').map((s) => s.trim());
        if (parts.length && /^(song|曲|video|動画)$/i.test(parts[0])) parts.shift();
        const type = (JSON.stringify(it).match(/"musicVideoType":"(\w+)"/) || [])[1] || '';
        // MUSIC_VIDEO_TYPE_ATV = YouTube Music の「曲」(公式の音源)。ミュージックビデオ(OMV)より優先する
        return { id, title: cols[0], artist: parts[0] || '', duration: M().parseClock(parts[parts.length - 1]), preferred: type === 'MUSIC_VIDEO_TYPE_ATV' };
      })
      .filter((c) => c.id);
  }

  async function resolve(desc) {
    // YouTube と YouTube Music は動画の番号が共通なので、どちらの番号でもそのまま開ける
    if (desc.ids && (desc.ids.ytm || desc.ids.youtube)) return desc.ids.ytm || desc.ids.youtube;
    // まず送った人の言語(画面の言語が違えば、その言語で検索する)、見つからなければ自分の言語で探す
    for (const loc of senderFirst(desc)) {
      const hit = M().closest(await search(desc, loc), desc); // 長さがいちばん近いもの
      if (hit) return hit.id;
    }
    return null;
  }

  function adjusted(cmd) {
    const elapsed = cmd.play ? Math.max(0, (Date.now() - cmd.issuedAt) / 1000) : 0;
    return Math.max(0, (cmd.position || 0) + elapsed);
  }

  async function load(cmd) {
    const before = readState();
    const id = cmd.songId || (await resolve(cmd.desc || {}));
    if (!id) return { ok: false, error: 'notfound', localId: before.song ? before.song.id : null };
    const p = player();
    const app = document.querySelector('ytmusic-app');
    if ((p.getVideoData() || {}).video_id !== id) {
      if (app) {
        // ページの中の移動として曲を開く(画面の表示も一緒に切り替わる)
        app.dispatchEvent(
          new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint: { watchEndpoint: { videoId: id } } } })
        );
      } else {
        p.loadVideoById(id);
      }
      for (let i = 0; i < 80 && (p.getVideoData() || {}).video_id !== id; i++) await sleep(100);
    }
    for (let i = 0; i < 40 && p.classList.contains('ad-showing'); i++) await sleep(250); // 広告が終わるのを少し待つ
    if (cmd.play) {
      p.playVideo();
      for (let i = 0; i < 30 && p.getPlayerState() !== 1; i++) await sleep(100);
    } else {
      p.pauseVideo();
    }
    const pos = adjusted(cmd);
    if (pos > 1) p.seekTo(pos, true);
    return { ok: true, resolvedId: id };
  }

  async function run(cmd) {
    const p = player();
    if (!p) return { ok: false, error: 'no-player' };
    if (cmd.action === 'load') return load(cmd);
    if (cmd.action === 'resolve') {
      const id = await resolve(cmd.desc || {});
      return id ? { ok: true, resolvedId: id } : { ok: false, error: 'notfound' };
    }
    if (cmd.action === 'seek') p.seekTo(adjusted(cmd), true);
    else if (cmd.action === 'play') p.playVideo();
    else if (cmd.action === 'pause') p.pauseVideo();
    return { ok: true };
  }

  // この画面の言語と国(曲名がどの言語で書かれているか。受け取った人が、まずこの言語で探す)
  function locale() {
    const cfg = window.ytcfg;
    const hl = (cfg && cfg.get && cfg.get('HL')) || document.documentElement.lang || '';
    const gl = (cfg && cfg.get && cfg.get('GL')) || '';
    return { lang: String(hl).slice(0, 2).toLowerCase() || null, cc: String(gl).toLowerCase() || null };
  }

  function post(kind, payload) {
    if (kind === 'state' && payload && payload.state) {
      try {
        Object.assign(payload.state, locale());
      } catch (e) {}
    }
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
  const timer = setInterval(() => post('state', { state: readState() }), 400);
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
