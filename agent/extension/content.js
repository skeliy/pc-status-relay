// Apple Music のページに付く部分(拡張機能側)。
//  - page.js から届いた「今の曲・再生状態」を0.5秒ごとに裏方(background.js)経由でエージェントへ送る
//  - エージェントからの指示を page.js に渡す
//  - 画面の右下に、共有の状態を表す小さな表示とボタンを出す
(function () {
  const SRC_PAGE = "pcs-music-page";
  const SRC_EXT = "pcs-music-ext";
  const TICK_MS = 500;

  // 拡張機能が読み込み直された時は、古い自分を片付けてから動く
  if (window.__pcsMusicContent) {
    try {
      window.__pcsMusicContent.stop();
    } catch (e) {}
  }

  let latestState = null;
  let results = [];
  let inFlight = false;
  let lastTickAt = 0;
  let stopped = false;
  let lastUi = null;
  let agentOnline = false;
  let versionMismatch = false;

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function tick() {
    if (stopped) return;
    if (!extensionAlive()) {
      stop(); // 拡張機能が読み込み直された(新しい自分が別に動いている)
      return;
    }
    if (inFlight) return;
    inFlight = true;
    lastTickAt = Date.now();
    const sending = results;
    results = [];
    try {
      chrome.runtime.sendMessage({ type: "tick", body: { state: latestState, results: sending } }, (resp) => {
        inFlight = false;
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          agentOnline = false;
          render(null);
          return;
        }
        agentOnline = true;
        versionMismatch = !!resp.versionMismatch;
        for (const cmd of resp.data.commands || []) {
          window.postMessage({ source: SRC_EXT, kind: "cmd", cmd }, "*");
        }
        render(resp.data.ui);
      });
    } catch (e) {
      inFlight = false;
      stop();
    }
  }

  function sendAction(action, sessionId) {
    if (!extensionAlive()) return;
    chrome.runtime.sendMessage({ type: "action", body: { action, sessionId } }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.ok) render(resp.data.ui);
    });
  }

  function onMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== SRC_PAGE) return;
    if (event.data.kind === "state") {
      const prev = latestState;
      latestState = event.data.state;
      // 曲が変わった・再生/停止した時は、0.5秒を待たずにすぐ知らせる
      const changed =
        !prev ||
        prev.songId !== latestState.songId ||
        prev.isPlaying !== latestState.isPlaying ||
        prev.playbackState !== latestState.playbackState;
      if (changed && Date.now() - lastTickAt > 150) tick();
    } else if (event.data.kind === "result") {
      results.push(event.data.result);
    }
  }

  // ---------------------------------------------------------------- 画面右下の小さな表示
  const host = document.createElement("div");
  host.id = "pcs-music-share";
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { font: 13px/1.4 -apple-system, "Segoe UI", "Yu Gothic UI", sans-serif; color: #fff; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      .pill { display: flex; align-items: center; gap: 10px; background: rgba(32,34,44,.94); border: 1px solid rgba(255,255,255,.12);
              border-radius: 12px; padding: 8px 10px 8px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: 360px; }
      .pill .text { flex: 1; min-width: 0; }
      .muted { color: #b9bccb; font-size: 12px; }
      button { font: inherit; font-size: 12px; font-weight: 600; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer;
               color: #fff; background: #40435a; white-space: nowrap; }
      button.primary { background: #fa2d48; }
      button:hover { filter: brightness(1.12); }
      .fab { width: 34px; height: 34px; border-radius: 50%; padding: 0; background: rgba(32,34,44,.85); border: 1px solid rgba(255,255,255,.15);
             font-size: 16px; opacity: .55; transition: opacity .15s; }
      .fab:hover { opacity: 1; }
    </style>
    <div class="wrap"></div>`;
  const wrap = root.querySelector(".wrap");

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "onclick") e.addEventListener("click", v);
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const c of children || []) e.appendChild(c);
    return e;
  }

  function pill(textNodes, buttons) {
    return el("div", { class: "pill" }, [el("div", { class: "text" }, textNodes), ...buttons]);
  }

  function render(ui) {
    const key = JSON.stringify([ui, agentOnline, versionMismatch]);
    if (key === lastUi) return;
    lastUi = key;
    wrap.textContent = "";
    if (!agentOnline || !ui) return; // エージェントが動いていなければ何も出さない

    if (versionMismatch) {
      wrap.appendChild(
        pill([el("div", { class: "muted", text: "曲の共有: 拡張機能が古いままです。拡張機能のページで、エージェントの extension フォルダを読み込み直してください" })], [])
      );
    }
    for (const req of ui.incoming || []) {
      wrap.appendChild(
        pill(
          [el("div", { text: `🎵 ${req.label} が曲の共有をリクエストしています` })],
          [
            el("button", { class: "primary", text: "許可", onclick: () => sendAction("accept", req.sessionId) }),
            el("button", { text: "拒否", onclick: () => sendAction("decline", req.sessionId) }),
          ]
        )
      );
    }
    if (ui.needsClick) {
      wrap.appendChild(
        pill(
          [el("div", { text: "▶ ブラウザが自動再生を止めました" }), el("div", { class: "muted", text: "クリックすると共有中の曲が流れます" })],
          [
            el("button", {
              class: "primary",
              text: "再生",
              onclick: () => window.postMessage({ source: SRC_EXT, kind: "cmd", cmd: { id: -1, action: "play" } }, "*"),
            }),
          ]
        )
      );
    }
    if (ui.sharing) {
      wrap.appendChild(
        pill(
          [el("div", { text: `🎧 ${ui.partners} と共有中` }), el("div", { class: "muted", text: `どちらかが曲を選ぶと両方で流れます(${ui.hotkey} で終了)` })],
          [el("button", { text: "終了", onclick: () => sendAction("stop") })]
        )
      );
    } else if (ui.pending) {
      wrap.appendChild(
        pill([el("div", { text: "📨 共有のリクエスト中…" }), el("div", { class: "muted", text: "相手の許可を待っています" })], [
          el("button", { text: "取り消し", onclick: () => sendAction("cancel") }),
        ])
      );
    } else if (!(ui.incoming || []).length) {
      wrap.appendChild(
        el("button", {
          class: "fab",
          title: `友達に曲の共有をリクエスト(${ui.hotkey})`,
          text: "🎧",
          onclick: () => sendAction("request"),
        })
      );
    }
  }

  window.addEventListener("message", onMessage);
  (document.body || document.documentElement).appendChild(host);
  const timer = setInterval(tick, TICK_MS);

  function stop() {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("message", onMessage);
    host.remove();
  }

  window.__pcsMusicContent = { stop };
})();
