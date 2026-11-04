// 画面(overlay.html / settings.html)から使える機能を、必要なものだけ渡す。
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld('overlayApi', {
  ready: () => ipcRenderer.send('overlay-ready'),
  setVisible: (visible) => ipcRenderer.send('overlay-visible', !!visible),
  requestLyrics: () => ipcRenderer.send('overlay-request-lyrics'),
  onTick: on('tick'),
  onLyrics: on('lyrics'),
  onSettings: on('settings'),
  onPreview: on('preview'),
  onMoveMode: on('move-mode'),
  moveStart: () => ipcRenderer.send('overlay-move-start'),
  moveEnd: () => ipcRenderer.send('overlay-move-end'),
  moveDone: () => ipcRenderer.send('overlay-move-done'),
});

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings-get'),
  set: (patch) => ipcRenderer.send('settings-set', patch),
  setMoveMode: (value) => ipcRenderer.send('settings-move-mode', !!value),
  onStatus: on('status'),
  onSettings: on('settings'),
  onMoveMode: on('move-mode'),
});
