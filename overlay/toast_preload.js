// 右下の通知(toast.html)から使える機能。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', {
  onData: (fn) => ipcRenderer.on('toast-data', (_e, data) => fn(data)),
  onLeave: (fn) => ipcRenderer.on('toast-leave', () => fn()),
  hold: (on) => ipcRenderer.send('toast-hold', !!on),
  close: () => ipcRenderer.send('toast-close'),
});
