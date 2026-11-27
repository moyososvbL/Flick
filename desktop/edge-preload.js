const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('edge', {
  open: (on) => ipcRenderer.send('edge-open', on),
  drop: (files) => ipcRenderer.send('edge-drop', [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  onTarget: (cb) => ipcRenderer.on('target', (_e, t) => cb(t)),
  onResult: (cb) => ipcRenderer.on('result', (_e, ok) => cb(ok)),
});
