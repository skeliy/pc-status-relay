// 中継サーバーの「一緒に聴く」ページ(/listen/<部屋>)に付く部分。
// ページに「拡張機能が入っている(版はこれ)」と知らせ、ページでパスワードが通ったら、
// 部屋の鍵を裏方(background.js)に渡す。
(function () {
  const version = chrome.runtime.getManifest().version;
  const hello = () => window.postMessage({ source: 'pcs-ext', type: 'hello', version }, '*');
  hello();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'pcs-listen') return;
    if (e.data.type === 'ping') hello();
    if (e.data.type === 'join') {
      chrome.runtime.sendMessage({ type: 'guest-join', creds: e.data.creds }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          window.postMessage({ source: 'pcs-ext', type: 'join-error', error: (resp && resp.error) || '拡張機能に渡せませんでした' }, '*');
          return;
        }
        window.postMessage({ source: 'pcs-ext', type: 'joined', opened: !!resp.opened }, '*');
      });
    }
  });
})();
