// Apple Music のページそのものの中で動く部分。
// ページが使っている MusicKit(Apple の再生プレイヤー)は拡張機能の普通の場所からは触れないので、
// ここで「今の曲・再生状態」を読み取り、content.js から来た指示(この曲を再生して等)を実行する。
(function () {
  const VERSION = "1.0.0";
  const SRC_PAGE = "pcs-music-page";
  const SRC_EXT = "pcs-music-ext";

  // 拡張機能が読み込み直された時は、古い自分を止めてから入れ替わる
  if (window.__pcsMusicPage) {
    try {
      window.__pcsMusicPage.stop();
    } catch (e) {}
  }

  function getMusic() {
    try {
      return window.MusicKit && window.MusicKit.getInstance ? window.MusicKit.getInstance() : null;
    } catch (e) {
      return null;
    }
  }

  // 相手のPCでも同じ曲を開けるよう、「カタログの番号」を取り出す。
  // ライブラリの曲(i.xxxx のような番号)は本人のライブラリの中でしか通じないので、カタログ番号に直す。
  function catalogInfo(item) {
    const attrs = item.attributes || {};
    const pp = item.playParams || attrs.playParams || {};
    let kind = pp.kind || null;
    if (!kind) {
      if (item.type === "songs" || item.type === "library-songs") kind = "song";
      else if (item.type === "music-videos" || item.type === "library-music-videos") kind = "musicVideo";
    }
    const candidates = [pp.catalogId, item.songId, pp.isLibrary ? null : pp.id, pp.isLibrary ? null : item.id];
    let songId = null;
    for (const c of candidates) {
      if (c && !String(c).startsWith("i.") && /^\d+$/.test(String(c))) {
        songId = String(c);
        break;
      }
    }
    if (kind !== "song" && kind !== "musicVideo") songId = null;
    return { songId, kind };
  }

  function readState() {
    const music = getMusic();
    if (!music) return { available: false };
    const item = music.nowPlayingItem;
    if (!item) {
      return { available: true, songId: null, isPlaying: false, playbackState: music.playbackState };
    }
    const attrs = item.attributes || {};
    const info = catalogInfo(item);
    return {
      available: true,
      songId: info.songId,
      kind: info.kind,
      title: item.title || attrs.name || null,
      artist: item.artistName || attrs.artistName || null,
      isPlaying: !!music.isPlaying,
      playbackState: music.playbackState,
      position: music.currentPlaybackTime || 0,
      duration: music.currentPlaybackDuration || 0,
    };
  }

  function postState() {
    window.postMessage({ source: SRC_PAGE, kind: "state", state: readState() }, "*");
  }

  function postResult(id, ok, error) {
    window.postMessage({ source: SRC_PAGE, kind: "result", result: { id, ok, error } }, "*");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 指示を受けてから実行するまでの時間の分だけ、再生位置を先に進める
  function adjustedPosition(cmd) {
    const elapsed = cmd.play ? Math.max(0, (Date.now() - cmd.issuedAt) / 1000) : 0;
    return Math.max(0, (cmd.position || 0) + elapsed);
  }

  async function runCommand(cmd) {
    const music = getMusic();
    if (!music) throw new Error("MusicKit が見つかりません");
    if (cmd.action === "load") {
      const key = cmd.kind === "musicVideo" ? "musicVideo" : "song";
      await music.setQueue({ [key]: cmd.songId });
      if (cmd.play) {
        await music.play();
        // 再生が始まってから位置を合わせる(始まる前のシークは無視されることがあるため)
        for (let i = 0; i < 20 && !music.isPlaying; i++) await sleep(100);
      }
      const pos = adjustedPosition(cmd);
      if (pos > 1) await music.seekToTime(pos);
    } else if (cmd.action === "seek") {
      await music.seekToTime(adjustedPosition(cmd));
    } else if (cmd.action === "play") {
      await music.play();
    } else if (cmd.action === "pause") {
      await music.pause();
    }
  }

  function onMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== SRC_EXT) return;
    if (event.data.kind !== "cmd") return;
    const cmd = event.data.cmd;
    runCommand(cmd)
      .then(() => postResult(cmd.id, true, null))
      .catch((e) => {
        // ブラウザが「ユーザーが操作していないのに音を出すな」と止めた場合
        const autoplay = e && (e.name === "NotAllowedError" || /user (gesture|interaction)|not allowed/i.test(String(e.message || e)));
        postResult(cmd.id, false, autoplay ? "autoplay" : String((e && e.message) || e));
      })
      .finally(postState);
  }

  // MusicKit の出来事(曲が変わった・再生/停止した)をすぐ知らせる。0.4秒ごとの定期送信もする。
  let hooked = null;
  const EVENTS = ["playbackStateDidChange", "nowPlayingItemDidChange", "playbackTimeDidChange"];
  let lastTimeEvent = 0;
  function onMusicEvent(e) {
    if (e && e.type === "playbackTimeDidChange") {
      // 再生中はとても頻繁に来るので、間引く
      const now = Date.now();
      if (now - lastTimeEvent < 1000) return;
      lastTimeEvent = now;
    }
    postState();
  }
  function hookEvents() {
    const music = getMusic();
    if (!music || hooked === music) return;
    try {
      for (const name of EVENTS) music.addEventListener(name, onMusicEvent);
      hooked = music;
    } catch (e) {}
  }

  window.addEventListener("message", onMessage);
  const timer = setInterval(() => {
    hookEvents();
    postState();
  }, 400);

  window.__pcsMusicPage = {
    version: VERSION,
    stop() {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
      if (hooked) {
        try {
          for (const name of EVENTS) hooked.removeEventListener(name, onMusicEvent);
        } catch (e) {}
      }
    },
  };
})();
