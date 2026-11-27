// Gives the Flick page a tiny, safe bridge for Edge Drop.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flickDesktop', {
  onFiles: (cb) => ipcRenderer.on('edge-files', (_e, list) => cb(list)),
  result: (ok) => ipcRenderer.send('edge-result', !!ok),
  target: (t) => ipcRenderer.send('edge-target', t),
});
