// Apple Music(music.apple.com)と Spotify(open.spotify.com)のページの中で動く、歌詞オーバーレイ用の部品。
//  - 今の曲と、再生している秒数を 0.25 秒ごとに知らせる
//  - Apple Music では、オーバーレイが「この曲の歌詞がほしい」と言った時だけ、その人の Apple Music のログインで歌詞を取ってくる
//  - Spotify の歌詞は、オーバーレイのアプリが公開の歌詞の図書館(LRCLIB)から自分で取る
// オーバーレイを入れていない人のPCでは、歌詞を取りに行くことはない。
// 歌詞を取る仕組みは Apple が公開しているものではないので、変更されると動かなくなることがある。
(function () {
  const SRC_PAGE = 'pcs-lyrics';
  const SRC_CMD = 'pcs-lyrics-cmd';
  const TICK_MS = 250;

  if (window.__pcsLyrics) {
    try {
      window.__pcsLyrics.stop();
    } catch (e) {}
  }

  const asked = new Set();

  function music() {
    try {
      return window.MusicKit && window.MusicKit.getInstance ? window.MusicKit.getInstance() : null;
    } catch (e) {
      return null;
    }
  }

  // MusicKit の currentPlaybackTime は細かさが足りないことがあるので、音を流している要素の秒数を優先する
  function position(m) {
    const coarse = Number(m.currentPlaybackTime) || 0;
    const el = document.getElementById('apple-music-player') || document.querySelector('audio');
    if (el && Number.isFinite(el.currentTime) && Math.abs(el.currentTime - coarse) < 2) return el.currentTime;
    return coarse;
  }

  function post(kind, body) {
    window.postMessage(Object.assign({ source: SRC_PAGE, kind }, body), '*');
  }

  // Apple Music と Spotify のページで、今の曲と再生している秒数を知らせる
  function tick() {
    const adapter = window.__pcsAdapter;
    if (!adapter || !adapter.readState || !['apple', 'spotify'].includes(adapter.service)) return;
    const service = adapter.service;
    const m = service === 'apple' ? music() : null;
    if (service === 'apple' && !m) return;
    let state = null;
    try {
      state = adapter.readState();
    } catch (e) {
      return;
    }
    if (!state || state.phase === 'loading') return; // 曲が変わった直後で、位置がまだ前の曲のまま
    const song = state.song;
    if (!song || !song.id) {
      post('tick', { tick: { service, id: null, playing: false, at: Date.now() } });
      return;
    }
    post('tick', {
      tick: {
        service,
        // Apple Music では、カタログに無い自分の曲(番号で歌詞を探せない)は送らない
        id: service === 'apple' && song.localOnly ? null : String(song.id),
        title: song.title || '',
        artist: song.artist || '',
        album: song.album || '',
        duration: Number(song.duration) || 0,
        playing: !!state.isPlaying,
        pos: service === 'apple' ? position(m) : Number(state.position) || 0,
        at: Date.now(),
      },
    });
  }

  function ttmlOf(res) {
    const body = res && res.data !== undefined ? res.data : res;
    const item = body && body.data && body.data[0];
    const a = item && item.attributes;
    return (a && (a.ttml || a.ttmlLocalizations)) || null;
  }

  // 単語ごとの時間がある歌詞を先に探し、無ければ行ごとの歌詞を使う
  async function fetchLyrics(id) {
    const m = music();
    if (!m) return { status: 'error' };
    if (!m.isAuthorized) return { status: 'denied' }; // 歌詞は Apple Music にログインしていないと取れない
    const sf = m.storefrontId || m.storefrontCountryCode || 'us';
    let sawDenied = false;
    for (const kind of ['syllable-lyrics', 'lyrics']) {
      try {
        const ttml = ttmlOf(await m.api.music(`/v1/catalog/${sf}/songs/${id}/${kind}`));
        if (ttml) return { status: 'ok', ttml, kind };
      } catch (e) {
        const code = (e && (e.status || e.errorCode || (e.response && e.response.status))) || 0;
        if (code === 401 || code === 403) sawDenied = true;
      }
      // MusicKit の仕組みで取れない時は、Web版 Apple Music が使っているのと同じ宛先に、本人のログインで直接聞く
      try {
        const res = await fetch(`https://amp-api.music.apple.com/v1/catalog/${sf}/songs/${id}/${kind}`, {
          credentials: 'include',
          headers: { Authorization: `Bearer ${m.developerToken}`, 'Media-User-Token': m.musicUserToken },
        });
        if (res.status === 401 || res.status === 403) sawDenied = true;
        if (res.ok) {
          const ttml = ttmlOf(await res.json());
          if (ttml) return { status: 'ok', ttml, kind };
        }
      } catch (e) {}
    }
    return { status: sawDenied ? 'denied' : 'none' };
  }

  function onMessage(e) {
    if (e.source !== window || !e.data || e.data.source !== SRC_CMD) return;
    const id = e.data.need;
    if (!id || !/^\d+$/.test(String(id)) || asked.has(id) || !music()) return;
    asked.add(id);
    if (asked.size > 200) asked.clear();
    fetchLyrics(id)
      .catch(() => ({ status: 'error' }))
      .then((r) => {
        if (r.status !== 'ok') asked.delete(id); // オーバーレイ側が間を空けて聞き直す
        post('lyrics', { lyrics: Object.assign({ id }, r) });
      });
  }

  window.addEventListener('message', onMessage);
  const timer = setInterval(tick, TICK_MS);

  window.__pcsLyrics = {
    stop() {
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
    },
  };
})();
