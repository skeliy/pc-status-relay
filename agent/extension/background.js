// 拡張機能の裏方。Apple Music のページ(content.js)と、このPCで動いているエージェント
// (http://127.0.0.1:8788)の間を取り次ぐだけ。
// ページから直接 127.0.0.1 に送ると、ブラウザの安全のための制限に引っかかるので、ここを経由する。

const AGENT_URL = "http://127.0.0.1:8788";
const MY_VERSION = chrome.runtime.getManifest().version;
let reloadScheduled = false;

async function postToAgent(path, body) {
  const resp = await fetch(AGENT_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PCS-Ext": "1" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("agent " + resp.status);
  return resp.json();
}

// エージェントのフォルダにある拡張機能のファイルが自動アップデートで新しくなったら、
// 自分を読み込み直す(これで友達側も、拡張機能を入れ直さずに最新になる)。
async function maybeReload(data) {
  const diskVersion = data && data.extVersion;
  if (!diskVersion || diskVersion === MY_VERSION || reloadScheduled) return;
  // 別のフォルダから読み込まれていると、読み込み直しても版が変わらず延々と繰り返してしまうので、
  // 同じ版に向けた読み込み直しは1回だけにする。
  const { reloadedFor } = await chrome.storage.local.get("reloadedFor");
  if (reloadedFor === diskVersion) return;
  reloadScheduled = true;
  await chrome.storage.local.set({ reloadedFor: diskVersion });
  setTimeout(() => chrome.runtime.reload(), 300);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.type !== "tick" && message.type !== "action")) return false;
  const path = message.type === "tick" ? "/ext/tick" : "/ext/action";
  const body = Object.assign({}, message.body, {
    tabId: sender.tab ? sender.tab.id : -1,
    extVersion: MY_VERSION,
  });
  postToAgent(path, body)
    .then((data) => {
      maybeReload(data);
      const versionMismatch = !!(data.extVersion && data.extVersion !== MY_VERSION);
      sendResponse({ ok: true, data, versionMismatch });
    })
    .catch(() => sendResponse({ ok: false }));
  return true; // 非同期で返事をする
});

// 読み込み直した・入れた直後は、もう開いている Apple Music のタブにも仕組みを入れ直す
// (タブを再読み込みすると曲が止まってしまうので、再読み込みはしない)。
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: "https://music.apple.com/*" });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["page.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (e) {
      // タブが読み込み中などで入れられなかった場合は、次にページを開いた時に入る
    }
  }
});
