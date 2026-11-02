// 画面に出ないページ(offscreen document)。
// 拡張機能の裏方(background.js)は、しばらく何も無いとブラウザに止められてしまうので、
// 「招待が届くのを待つ」のと「通知音を鳴らす」のは、ずっと動いていられるこのページが受け持つ。
// 届いた招待は裏方に渡し、裏方がアイコンの印・通知・画面の表示を行う。
(function () {
  const RELAY = 'https://pc-status-relay.onrender.com';
  let since = -1;
  let wait = 2000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function ask(type, extra) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (resp) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function loop() {
    for (;;) {
      const client = await ask('offscreen-get-client');
      if (!client || !client.client) {
        await sleep(5000);
        continue;
      }
      try {
        const url = `${RELAY}/api/client/poll?client=${encodeURIComponent(client.client)}&key=${encodeURIComponent(client.key)}&since=${since}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (resp.status === 403) {
          await ask('client-invalid'); // サーバーが再起動して登録が消えた → 登録し直してもらう
          since = -1;
          await sleep(2000);
          continue;
        }
        if (!resp.ok) throw new Error('poll ' + resp.status);
        const data = await resp.json();
        since = data.seq;
        wait = 2000;
        if (data.messages && data.messages.length) await ask('inbox', { messages: data.messages, serverNow: data.serverNow });
      } catch (e) {
        await sleep(wait);
        wait = Math.min(wait * 2, 30000);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'play-sound') {
      try {
        const audio = new Audio(chrome.runtime.getURL('notify.wav'));
        audio.volume = 1.0;
        audio.play().catch(() => {});
      } catch (e) {}
    }
    return false;
  });

  loop();
})();
