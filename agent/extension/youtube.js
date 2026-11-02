// YouTube(www.youtube.com、普通の YouTube)のページの中で動く部品。
// 動画のページ(/watch)にある再生プレイヤー(#movie_player)で、今の曲を読み取ったり、指定の曲を流したりする。
//
// YouTube Music と YouTube は動画の番号が共通なので、YouTube Music の人が流した曲はそのまま開ける。
// Apple Music や Spotify の人のために、曲名とアーティストは動画のタイトルから取り出す。
// (YouTube の画面のタイトルは自動翻訳されていることがあるので、元のタイトルを oEmbed で取ってくる)
(function () {
  const SERVICE = 'youtube';
  const SRC_PAGE = 'pcs-page';
  const SRC_EXT = 'pcs-ext-cmd';

  if (window.__pcsAdapter) {
    try {
      window.__pcsAdapter.stop();
    } catch (e) {}
  }

  const M = () => window.__pcsMatch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const metaCache = new Map(); // 動画の番号 -> { title, artist } (調べ中は null)
  const metaStarted = new Map(); // 動画の番号 -> 調べ始めた時刻
  const loadedIds = new Set(); // 一緒に聴くために、こちらで開いた動画(音楽のカテゴリでなくても曲として扱う)

  // YouTube の動画のカテゴリ(「Music」など)。まだ分からなければ null
  function category(p, id) {
    try {
      const pr = p.getPlayerResponse() || {};
      if (!pr.videoDetails || pr.videoDetails.videoId !== id) return null;
      const mf = (pr.microformat || {}).playerMicroformatRenderer || {};
      return mf.category || '';
    } catch (e) {
      return null;
    }
  }

  function onWatchPage() {
    return location.pathname === '/watch';
  }

  function player() {
    return document.querySelector('ytd-watch-flexy #movie_player') || (onWatchPage() ? document.getElementById('movie_player') : null);
  }

  // 「YOASOBI「アイドル」 Official Music Video」→ 曲名「アイドル」、アーティスト「YOASOBI」のように取り出す
  function parseTitle(rawTitle, author) {
    let artist = String(author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*(official|公式).*$/i, '').trim();
    let t = String(rawTitle || '')
      .replace(/[\(\[【（](?=[^\)\]】）]*(official|music video|mv|lyric|audio|video|hd|4k|公式|歌詞))[^\)\]】）]*[\)\]】）]/gi, ' ')
      .replace(/\b(official\s+)?(music\s+video|lyric\s+video|audio|mv|m\/v)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const quoted = t.match(/^(.*?)[「『"](.+?)[」』"](.*)$/);
    if (quoted) {
      if (quoted[1].trim()) artist = quoted[1].trim();
      return { title: quoted[2].trim(), artist };
    }
    const dash = t.split(/\s+[-–—]\s+/);
    if (dash.length >= 2) return { title: dash.slice(1).join(' - ').trim(), artist: dash[0].trim() || artist };
    const slash = t.split(/\s+\/\s+/);
    if (slash.length === 2) return { title: slash[0].trim(), artist: slash[1].trim() || artist };
    return { title: t, artist };
  }

  function fetchMeta(id) {
    if (metaStarted.has(id)) return;
    metaStarted.set(id, Date.now());
    fetch('/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))
      .then((r) => r.json())
      .then((j) => metaCache.set(id, parseTitle(j.title, j.author_name)))
      .catch(() => {});
  }

  function readState() {
    if (!onWatchPage()) return { available: true, service: SERVICE, song: null, isPlaying: false, phase: 'idle' };
    const p = player();
    if (!p || !p.getVideoData) return { available: false, service: SERVICE };
    const data = p.getVideoData() || {};
    const state = p.getPlayerState ? p.getPlayerState() : -1;
    const ad = p.classList && p.classList.contains('ad-showing');
    const phase = ad ? 'ad' : { 1: 'playing', 2: 'paused', 3: 'loading', 0: 'ended', '-1': 'idle', 5: 'paused' }[state] || 'idle';
    if (!data.video_id) return { available: true, service: SERVICE, song: null, isPlaying: false, phase };
    // 音楽ではない動画(ゲーム実況・解説など)は、曲としてみんなに送らない
    if (!loadedIds.has(data.video_id)) {
      const cat = category(p, data.video_id);
      const topic = / - Topic$/i.test(String(data.author || ''));
      if (cat === null && !topic) return { available: true, service: SERVICE, song: null, isPlaying: false, phase: 'loading' };
      if (cat !== 'Music' && !topic) return { available: true, service: SERVICE, song: null, isPlaying: false, phase: 'idle', notMusic: true };
    }
    fetchMeta(data.video_id);
    let meta = metaCache.get(data.video_id);
    if (!meta) {
      // 元のタイトルが届くまで(ふつう1秒以内)は、曲として知らせない(翻訳されたタイトルを送らないため)
      if (Date.now() - (metaStarted.get(data.video_id) || 0) < 3000) {
        return { available: true, service: SERVICE, song: null, isPlaying: false, phase: 'loading' };
      }
      meta = parseTitle(data.title, data.author);
    }
    return {
      available: true,
      service: SERVICE,
      quietResolve: true,
      queue: readQueue(),
      song: { id: data.video_id, title: meta.title, artist: meta.artist, duration: p.getDuration ? p.getDuration() : 0, isrc: null },
      isPlaying: !ad && state === 1,
      phase,
      position: ad ? 0 : p.getCurrentTime ? p.getCurrentTime() : 0,
    };
  }

  // 再生リストを流している時は、右側の一覧から今の動画より後ろを読む
  function readQueue() {
    const items = Array.from(document.querySelectorAll('ytd-playlist-panel-video-renderer'));
    const cur = items.findIndex((e) => e.hasAttribute('selected'));
    if (cur < 0) return [];
    const runs = (x) => (x && (x.simpleText || ((x.runs || []).map((r) => r.text).join('')))) || '';
    return items.slice(cur + 1, cur + 6).map((e) => {
      const d = e.data || {};
      const meta = parseTitle(runs(d.title), runs(d.shortBylineText));
      return { ids: d.videoId ? { youtube: d.videoId } : {}, title: meta.title, artist: meta.artist, duration: M().parseClock(runs(d.lengthText)) };
    }).filter((q) => q.title);
  }

  // ページ自身の検索と同じ仕組みで動画を探す。
  // 公式の音源(「アーティスト - Topic」の動画)はふつうの検索では出てこないことが多いので、「topic」を付けた検索もして混ぜる
  async function search(desc) {
    // 届いた名前と、別の名前(英語・日本語など)のすべてで探す。それぞれ「topic」を付けた検索もする
    const qs = M().queries(desc, 3);
    const lists = await Promise.all(
      qs.map((q) =>
        Promise.all([searchOnce(q).catch(() => []), searchOnce(q + ' topic').catch(() => [])]).then(([plain, topic]) =>
          plain.concat(topic.filter((x) => x.preferred))
        )
      )
    );
    const seen = new Set();
    const out = [];
    for (const c of [].concat(...lists)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }

  async function searchOnce(query) {
    const cfg = window.ytcfg;
    if (!cfg || !cfg.get) throw new Error('ytcfg が見つかりません');
    const resp = await fetch('/youtubei/v1/search?prettyPrint=false&key=' + encodeURIComponent(cfg.get('INNERTUBE_API_KEY')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: cfg.get('INNERTUBE_CONTEXT'), query }),
    });
    const json = await resp.json();
    const vids = [];
    (function walk(o) {
      if (!o || typeof o !== 'object' || vids.length >= 12) return;
      if (o.videoRenderer) {
        vids.push(o.videoRenderer);
        return;
      }
      for (const k in o) walk(o[k]);
    })(json);
    return vids.map((v) => {
      const artist = ((v.ownerText || {}).runs || []).map((r) => r.text).join('');
      return {
        id: v.videoId,
        title: ((v.title || {}).runs || []).map((r) => r.text).join(''),
        artist,
        duration: M().parseClock((v.lengthText || {}).simpleText),
        preferred: / - Topic\b/i.test(artist), // YouTube が自動で作る公式の音源
      };
    });
  }

  async function candidates(desc) {
    const known = desc.ids && (desc.ids.youtube || desc.ids.ytm);
    if (known) return [known];
    const list = await search(desc);
    const ranked = [];
    let rest = list.slice();
    for (let i = 0; i < 3 && rest.length; i++) {
      const hit = M().closest(rest, desc); // 長さがいちばん近いもの(流せなければ次に近いもの)
      if (!hit) break;
      ranked.push(hit.id);
      rest = rest.filter((c) => c.id !== hit.id);
    }
    return ranked;
  }

  async function resolve(desc) {
    const list = await candidates(desc);
    return list[0] || null;
  }

  function adjusted(cmd) {
    const elapsed = cmd.play ? Math.max(0, (Date.now() - cmd.issuedAt) / 1000) : 0;
    return Math.max(0, (cmd.position || 0) + elapsed);
  }

  function navigateTo(id) {
    const app = document.querySelector('ytd-app');
    if (app && onWatchPage()) {
      // ページの中の移動として動画を開く(画面の表示も一緒に切り替わる)
      app.dispatchEvent(
        new CustomEvent('yt-navigate', {
          bubbles: true,
          composed: true,
          detail: {
            endpoint: {
              commandMetadata: { webCommandMetadata: { url: '/watch?v=' + id, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
              watchEndpoint: { videoId: id },
            },
          },
        })
      );
      return true;
    }
    // 動画のページ以外(トップページなど)にいる時は、動画のページを開き直す
    location.assign('/watch?v=' + encodeURIComponent(id));
    return false;
  }

  function playable(p) {
    try {
      const status = ((p.getPlayerResponse() || {}).playabilityStatus || {}).status;
      return !status || status === 'OK';
    } catch (e) {
      return true;
    }
  }

  async function load(cmd) {
    const before = readState();
    const list = cmd.songId ? [cmd.songId] : await candidates(cmd.desc || {});
    if (!list.length) return { ok: false, error: 'notfound', localId: before.song ? before.song.id : null };
    for (const id of list) {
      loadedIds.add(id);
      const p = player();
      if (!p || (p.getVideoData() || {}).video_id !== id) {
        if (!navigateTo(id)) return { ok: true, resolvedId: id }; // ページを開き直す(続きは開き直した後に合わせる)
        for (let i = 0; i < 80 && ((player() && player().getVideoData()) || {}).video_id !== id; i++) await sleep(100);
      }
      const q = player();
      if (!q || (q.getVideoData() || {}).video_id !== id) continue;
      await sleep(800);
      if (!playable(q)) continue; // 年齢制限・地域制限などで流せない → 次の候補
      for (let i = 0; i < 40 && q.classList.contains('ad-showing'); i++) await sleep(250); // 広告が終わるのを少し待つ
      if (cmd.play) {
        q.playVideo();
        for (let i = 0; i < 30 && q.getPlayerState() !== 1; i++) await sleep(100);
      } else {
        q.pauseVideo();
      }
      const pos = adjusted(cmd);
      if (pos > 1) q.seekTo(pos, true);
      return { ok: true, resolvedId: id };
    }
    return { ok: false, error: 'notfound', localId: before.song ? before.song.id : null };
  }

  async function run(cmd) {
    if (cmd.action === 'load') return load(cmd);
    if (cmd.action === 'resolve') {
      const id = await resolve(cmd.desc || {});
      return id ? { ok: true, resolvedId: id } : { ok: false, error: 'notfound' };
    }
    const p = player();
    if (!p) return { ok: false, error: 'no-player' };
    if (cmd.action === 'seek') p.seekTo(adjusted(cmd), true);
    else if (cmd.action === 'play') p.playVideo();
    else if (cmd.action === 'pause') p.pauseVideo();
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
  const timer = setInterval(() => post('state', { state: readState() }), 400);
  window.__pcsAdapter = {
    service: SERVICE,
    readState,
    resolve,
    parseTitle,
    stop() {
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
    },
  };
})();
