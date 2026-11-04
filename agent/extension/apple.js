// Apple Music(music.apple.com)のページの中で動く部品。
// ページが使っている MusicKit(Apple の再生プレイヤー)で、今の曲を読み取ったり、指定の曲を流したりする。
// 曲の検索も MusicKit の仕組みで行う(ISRC が分かればそれで、分からなければ曲名とアーティストで)。
(function () {
  const SERVICE = 'apple';
  const SRC_PAGE = 'pcs-page';
  const SRC_EXT = 'pcs-ext-cmd';

  if (window.__pcsAdapter) {
    try {
      window.__pcsAdapter.stop();
    } catch (e) {}
  }

  const M = () => window.__pcsMatch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isrcCache = new Map(); // カタログ番号 -> ISRC(調べ中は null)
  // カタログ番号 -> [{ title, artist }, ...] 別の名前(英語の名前と、日本のストアの日本語の名前)。
  // ストアによって名前が違う(日本のストアはカタカナ、カナダなどのストアは日本の曲がローマ字)ので、相手が探しやすいように一緒に送る
  const namesCache = new Map();
  const enCache = new Map(); // カタログ番号 -> { title, artist } 英語の名前(前の版の相手のために alt としても送る)
  const lookupStarted = new Map(); // カタログ番号 -> 調べ始めた時刻
  const availCache = new Map(); // カタログ番号 -> この国のストアで流せるか(true/false)
  const libCache = new Map(); // ライブラリの番号 i.xxx -> カタログの番号(調べ中は null、無ければ '')

  // 約束(Promise)が返ってこない時のために、時間で区切る
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('__timeout'), ms))]);
  }

  function music() {
    try {
      return window.MusicKit && window.MusicKit.getInstance ? window.MusicKit.getInstance() : null;
    } catch (e) {
      return null;
    }
  }

  function storefront(m) {
    return m.storefrontId || m.storefrontCountryCode || 'us';
  }

  async function api(path, params) {
    const m = music();
    const res = await m.api.music(path, params || {});
    return res && res.data !== undefined ? res.data : res;
  }

  // 相手のPCでも同じ曲を開けるよう、「カタログの番号」を取り出す(ライブラリの番号 i.xxx は本人にしか通じない)
  function catalogInfo(item) {
    const attrs = item.attributes || {};
    const pp = item.playParams || attrs.playParams || {};
    let kind = pp.kind || null;
    if (!kind) {
      if (/songs$/.test(item.type || '')) kind = 'song';
      else if (/music-videos$/.test(item.type || '')) kind = 'musicVideo';
    }
    const candidates = [pp.catalogId, item.songId, pp.isLibrary ? null : pp.id, pp.isLibrary ? null : item.id];
    let id = null;
    for (const c of candidates) {
      if (c && /^\d+$/.test(String(c))) {
        id = String(c);
        break;
      }
    }
    if (kind !== 'song' && kind !== 'musicVideo') id = null;
    // ライブラリの曲(i.xxx)でカタログの番号が付いていない時は、あとでカタログの番号を調べる
    const libId = [pp.id, item.id].find((c) => c && /^i\./.test(String(c))) || null;
    return { id, kind, isrc: attrs.isrc || null, libId };
  }

  const pick = (d) => {
    const song = d && d.data && d.data[0];
    return song && song.attributes ? { id: String(song.id), title: song.attributes.name || null, artist: song.attributes.artistName || null, isrc: song.attributes.isrc || null } : null;
  };

  // ISRC と、別の名前(英語・日本語)を調べる
  function lookupIsrc(id) {
    if (isrcCache.has(id)) return;
    isrcCache.set(id, null);
    lookupStarted.set(id, Date.now());
    const sf = storefront(music());
    (async () => {
      const names = [];
      let isrc = null;
      try {
        const en = pick(await api(`/v1/catalog/${sf}/songs/${id}`, { l: 'en-US' }));
        if (en) {
          isrc = en.isrc;
          enCache.set(id, { title: en.title, artist: en.artist });
          names.push({ title: en.title, artist: en.artist });
        }
      } catch (e) {}
      if (sf !== 'jp') {
        // 日本のストアでの名前(日本の曲は、ここで日本語の曲名・アーティスト名になる)
        let jp = null;
        try {
          jp = pick(await api(`/v1/catalog/jp/songs/${id}`));
        } catch (e) {}
        if (!jp && isrc) {
          try {
            jp = pick(await api('/v1/catalog/jp/songs', { 'filter[isrc]': isrc }));
          } catch (e) {}
        }
        if (jp) names.push({ title: jp.title, artist: jp.artist });
      }
      if (isrc) isrcCache.set(id, isrc);
      namesCache.set(id, names);
    })().catch(() => namesCache.set(id, []));
  }

  function lookupLibrary(libId) {
    if (libCache.has(libId)) return;
    libCache.set(libId, null);
    api(`/v1/me/library/songs/${libId}/catalog`)
      .then((d) => {
        const song = d && d.data && d.data[0];
        const id = song && /^\d+$/.test(String(song.id)) ? String(song.id) : '';
        libCache.set(libId, id);
        if (id) lookupIsrc(id);
      })
      .catch(() => libCache.set(libId, ''));
  }

  // 届いた番号が、この国の Apple Music で流せる曲か(国によって配信されていない曲がある)
  async function available(id) {
    if (availCache.has(id)) return availCache.get(id);
    let ok = false;
    try {
      const d = await api(`/v1/catalog/${storefront(music())}/songs/${id}`);
      const song = d && d.data && d.data[0];
      ok = !!(song && song.attributes && song.attributes.playParams);
    } catch (e) {
      ok = false;
    }
    availCache.set(id, ok);
    return ok;
  }

  // その曲(キューの1曲)を表す番号ぜんぶ(カタログの番号・ライブラリの番号)
  function itemIds(item) {
    if (!item) return [];
    const out = new Set();
    try {
      const info = catalogInfo(item);
      if (info.id) out.add(String(info.id));
      if (info.libId) {
        out.add(String(info.libId));
        const cat = libCache.get(info.libId);
        if (cat) out.add(String(cat));
      }
    } catch (e) {}
    if (item.id) out.add(String(item.id));
    return Array.from(out);
  }

  function queueIndexOf(m, id) {
    try {
      const q = m.queue;
      const items = (q && q.items) || [];
      for (let i = 0; i < items.length; i++) if (itemIds(items[i]).includes(String(id))) return i;
    } catch (e) {}
    return -1;
  }

  function readState() {
    const m = music();
    if (!m) return { available: false, service: SERVICE };
    const ps = m.playbackState;
    const phase = { 2: 'playing', 3: 'paused', 1: 'loading', 6: 'loading', 8: 'loading', 9: 'loading', 5: 'ended', 10: 'ended', 0: 'idle', 4: 'idle' }[ps] || 'idle';
    const item = m.nowPlayingItem;
    if (!item) return { available: true, service: SERVICE, song: null, isPlaying: false, phase };
    const attrs = item.attributes || {};
    const info = catalogInfo(item);
    let localOnly = false;
    if (!info.id && info.libId) {
      lookupLibrary(info.libId);
      const cat = libCache.get(info.libId);
      if (cat) info.id = cat;
      else {
        // カタログに無い曲(自分で取り込んだ曲など)は、曲名とアーティストで相手に探してもらう
        info.id = info.libId;
        localOnly = true;
      }
    }
    if (info.id && !localOnly) {
      lookupIsrc(info.id);
      // 英語の名前と ISRC が届くまで(ふつう1秒以内)は、曲として知らせない(相手が正しい曲を探せるように)
      if (!namesCache.has(info.id) && Date.now() - (lookupStarted.get(info.id) || 0) < 3000) {
        return { available: true, service: SERVICE, song: null, isPlaying: false, phase: 'loading' };
      }
    }
    const en = info.id && !localOnly ? enCache.get(info.id) : null;
    const baseTitle = item.title || attrs.name || null;
    const baseArtist = item.artistName || attrs.artistName || null;
    const key = (n) => `${String(n.title || '').toLowerCase()}|${String(n.artist || '').toLowerCase()}`;
    const seenNames = new Set([key({ title: baseTitle, artist: baseArtist })]);
    const alts = [];
    for (const n of (info.id && !localOnly && namesCache.get(info.id)) || []) {
      if (!n || (!n.title && !n.artist) || seenNames.has(key(n))) continue;
      seenNames.add(key(n));
      alts.push(n);
    }
    return {
      available: true,
      service: SERVICE,
      quietResolve: true,
      queue: readQueue(m),
      song: info.id
        ? {
            id: info.id,
            localOnly, // true の時、この番号は自分のライブラリでしか通じないので相手に送らない
            kind: info.kind,
            title: item.title || attrs.name || null,
            artist: item.artistName || attrs.artistName || null,
            album: item.albumName || attrs.albumName || null,
            duration: m.currentPlaybackDuration || (attrs.durationInMillis ? attrs.durationInMillis / 1000 : 0),
            isrc: info.isrc || (localOnly ? null : isrcCache.get(info.id)) || null,
            alt: en && (en.title || en.artist) ? en : null, // 英語の曲名・アーティスト名(前の版の相手向け)
            alts, // 別の名前ぜんぶ(英語・日本語)
          }
        : null,
      isPlaying: !!m.isPlaying,
      phase,
      position: m.currentPlaybackTime || 0,
    };
  }

  // MusicKit のキューから、今の曲より後ろの曲を読む
  function readQueue(m) {
    try {
      const q = m.queue;
      const items = (q && q.items) || [];
      const pos = typeof q.position === 'number' ? q.position : -1;
      return items.slice(pos + 1, pos + 6).map((it) => {
        const a = it.attributes || {};
        const info = catalogInfo(it);
        return {
          ids: info.id ? { apple: info.id } : {},
          title: it.title || a.name || null,
          artist: it.artistName || a.artistName || null,
          duration: a.durationInMillis ? a.durationInMillis / 1000 : it.playbackDuration ? it.playbackDuration / 1000 : 0,
          isrc: info.isrc || (info.id && isrcCache.get(info.id)) || null,
        };
      }).filter((x) => x.title);
    } catch (e) {
      return [];
    }
  }

  function toCandidate(s) {
    const a = s.attributes || {};
    return { id: s.id, title: a.name, artist: a.artistName, duration: a.durationInMillis ? a.durationInMillis / 1000 : 0 };
  }

  async function resolve(desc) {
    // 相手の Apple Music の番号があっても、この国のストアに無ければ曲名などで探し直す
    if (desc.ids && desc.ids.apple && (await available(desc.ids.apple))) return desc.ids.apple;
    const m = music();
    const sf = storefront(m);
    if (desc.isrc) {
      try {
        const d = await api(`/v1/catalog/${sf}/songs`, { 'filter[isrc]': desc.isrc });
        const list = (d && d.data) || [];
        if (list.length) {
          const hit = M().best(list.map(toCandidate), desc);
          return (hit && hit.id) || list[0].id;
        }
      } catch (e) {}
    }
    const term = [desc.title, desc.artist].filter(Boolean).join(' ');
    if (!term) return null;
    // 日本のストアではアーティスト名が日本語で返ってくるので、英語の名前でも検索して候補を合わせる
    const list = [];
    for (const l of [undefined, 'en-US']) {
      try {
        const params = { term, types: 'songs', limit: 10 };
        if (l) params.l = l;
        const d = await api(`/v1/catalog/${sf}/search`, params);
        for (const s of (d && d.results && d.results.songs && d.results.songs.data) || []) {
          list.push(toCandidate(s)); // 同じ曲が日本語名・英語名の両方で入るが、どちらかが合えばよい
        }
      } catch (e) {}
    }
    const hit = M().best(list, desc);
    if (hit) return hit.id;
    // 見つからなければ、送った人の国のストア(曲名が送った人の言語で書かれている)で探し、
    // 同じ曲がこの国のストアにあればそれを使う(曲の番号はどの国でも共通。無ければ ISRC で探す)
    const from = String(desc.cc || '').toLowerCase();
    if (from && /^[a-z]{2}$/.test(from) && from !== String(sf).toLowerCase()) {
      try {
        const d = await api(`/v1/catalog/${from}/search`, { term, types: 'songs', limit: 10 });
        const there = (d && d.results && d.results.songs && d.results.songs.data) || [];
        const h2 = M().best(there.map(toCandidate), desc);
        if (h2) {
          if (await available(h2.id)) return h2.id;
          const raw = there.find((x) => x.id === h2.id);
          const isrc = raw && raw.attributes && raw.attributes.isrc;
          if (isrc) {
            const d2 = await api(`/v1/catalog/${sf}/songs`, { 'filter[isrc]': isrc });
            const mine = (d2 && d2.data) || [];
            if (mine.length) return mine[0].id;
          }
        }
      } catch (e) {}
    }
    // この国のストアの検索結果が、ローマ字など送った人と違う書き方の時は、その曲の「送った人の国のストアでの名前」を
    // 調べて比べ直す(曲の番号はどの国でも共通なので、同じ番号で名前だけ取り直せる)
    const senderSf = from && /^[a-z]{2}$/.test(from) ? from : desc.lang === 'ja' ? 'jp' : null;
    if (senderSf && senderSf !== String(sf).toLowerCase() && list.length) {
      try {
        const ids = Array.from(new Set(list.map((c) => String(c.id)))).slice(0, 15);
        const d = await api(`/v1/catalog/${senderSf}/songs`, { ids: ids.join(',') });
        const named = ((d && d.data) || []).filter((x) => ids.includes(String(x.id)));
        const h3 = M().best(named.map(toCandidate), desc);
        if (h3 && (await available(h3.id))) return h3.id;
      } catch (e) {}
    }
    return null;
  }

  function adjusted(cmd) {
    const elapsed = cmd.play ? Math.max(0, (Date.now() - cmd.issuedAt) / 1000) : 0;
    return Math.max(0, (cmd.position || 0) + elapsed);
  }

  async function run(cmd) {
    const m = music();
    if (!m) return { ok: false, error: 'MusicKit が見つかりません' };
    if (cmd.action === 'load') {
      const before = readState();
      let id = cmd.songId && (await available(cmd.songId)) ? cmd.songId : await resolve(cmd.desc || {});
      if (!id) return { ok: false, error: 'notfound', localId: before.song ? before.song.id : null };
      const kind = cmd.desc && cmd.desc.kind === 'musicVideo' ? 'musicVideo' : 'song';
      // もう流れている曲なら入れ直さない。キューの中にあれば、その曲へ移る(setQueue はキューを全部入れ替えてしまうので、
      // プレイリストやライブラリから流していた人の「次に流れる曲」が消えてしまう)
      const nowIds = itemIds(m.nowPlayingItem);
      if (nowIds.includes(String(id))) {
        // そのまま(位置と再生/停止だけ合わせる)
      } else {
        const idx = queueIndexOf(m, id);
        let moved = false;
        if (idx >= 0 && typeof m.changeToMediaAtIndex === 'function') {
          const r0 = await withTimeout(m.changeToMediaAtIndex(idx), 8000);
          moved = r0 !== '__timeout' && itemIds(m.nowPlayingItem).includes(String(id));
        }
        if (!moved) {
          const r = await withTimeout(m.setQueue({ [kind]: id }), 8000);
          if (r === '__timeout') return { ok: false, error: 'setQueue timeout' };
        }
      }
      if (cmd.play) {
        // play() が返ってこないことがある(自動再生を止められた時など)ので、時間で区切って確かめる
        await withTimeout(m.play(), 4000);
        for (let i = 0; i < 30 && !m.isPlaying; i++) await sleep(100);
        if (!m.isPlaying) return { ok: false, error: 'autoplay', resolvedId: id };
      }
      const pos = adjusted(cmd);
      if (pos > 1) await withTimeout(m.seekToTime(pos), 4000);
      return { ok: true, resolvedId: id };
    }
    if (cmd.action === 'resolve') {
      const id = await resolve(cmd.desc || {});
      return id ? { ok: true, resolvedId: id } : { ok: false, error: 'notfound' };
    }
    if (cmd.action === 'seek') await withTimeout(m.seekToTime(adjusted(cmd)), 4000);
    else if (cmd.action === 'play') {
      await withTimeout(m.play(), 4000);
      for (let i = 0; i < 20 && !m.isPlaying; i++) await sleep(100);
      if (!m.isPlaying) return { ok: false, error: 'autoplay' };
    } else if (cmd.action === 'pause') await withTimeout(m.pause(), 4000);
    return { ok: true };
  }

  // この画面の言語と国(曲名がどの言語で書かれているか。受け取った人が、まずこの言語で探す)
  function locale() {
    const m = music();
    const lang = String(document.documentElement.lang || navigator.language || '').slice(0, 2).toLowerCase() || null;
    return { lang, cc: m ? String(storefront(m)).toLowerCase() : null };
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
      .catch((err) => {
        // ブラウザが「ユーザーが操作していないのに音を出すな」と止めた場合
        const autoplay = err && (err.name === 'NotAllowedError' || /user (gesture|interaction)|not allowed/i.test(String(err.message || err)));
        return { ok: false, error: autoplay ? 'autoplay' : String((err && err.message) || err) };
      })
      .then((res) => post('result', { result: Object.assign({ id: cmd.id }, res) }))
      .finally(() => post('state', { state: readState() }));
  }

  // MusicKit の出来事(曲が変わった・再生/停止した)はすぐ知らせる。0.4秒ごとの定期送信もする
  let hooked = null;
  const EVENTS = ['playbackStateDidChange', 'nowPlayingItemDidChange'];
  const onEvent = () => post('state', { state: readState() });
  function hook() {
    const m = music();
    if (!m || hooked === m) return;
    try {
      for (const n of EVENTS) m.addEventListener(n, onEvent);
      hooked = m;
    } catch (e) {}
  }

  window.addEventListener('message', onMessage);
  const timer = setInterval(() => {
    hook();
    post('state', { state: readState() });
  }, 400);

  window.__pcsAdapter = {
    service: SERVICE,
    readState,
    resolve,
    stop() {
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
      if (hooked) {
        try {
          for (const n of EVENTS) hooked.removeEventListener(n, onEvent);
        } catch (e) {}
      }
    },
  };
})();
