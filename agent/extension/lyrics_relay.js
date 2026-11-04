// lyrics.js(ページの中)と background.js(裏方)のあいだで、歌詞オーバーレイ用の連絡を受け渡す。
(function () {
  const SRC_PAGE = 'pcs-lyrics';
  const SRC_CMD = 'pcs-lyrics-cmd';

  if (window.__pcsLyricsRelay) {
    try {
      window.__pcsLyricsRelay.stop();
    } catch (e) {}
  }

  let inFlight = false;
  let latest = null;
  let stopped = false;

  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function flush() {
    if (stopped || inFlight || !latest) return;
    if (!alive()) return stop(); // 拡張機能が読み込み直された(新しい自分が別に動いている)
    const tick = latest;
    latest = null;
    inFlight = true;
    try {
      chrome.runtime.sendMessage({ type: 'lyrics-tick', tick }, (resp) => {
        inFlight = false;
        if (chrome.runtime.lastError) return;
        if (resp && resp.need) window.postMessage({ source: SRC_CMD, need: resp.need }, '*');
        flush();
      });
    } catch (e) {
      inFlight = false;
      stop();
    }
  }

  function onMessage(e) {
    if (e.source !== window || !e.data || e.data.source !== SRC_PAGE) return;
    if (e.data.kind === 'tick') {
      latest = e.data.tick; // 送っている間に届いた分は、いちばん新しいものだけ送る
      flush();
    } else if (e.data.kind === 'lyrics' && alive()) {
      try {
        chrome.runtime.sendMessage({ type: 'lyrics-data', lyrics: e.data.lyrics }, () => void chrome.runtime.lastError);
      } catch (err) {}
    }
  }

  function stop() {
    stopped = true;
    window.removeEventListener('message', onMessage);
  }

  window.addEventListener('message', onMessage);
  window.__pcsLyricsRelay = { stop };
})();
