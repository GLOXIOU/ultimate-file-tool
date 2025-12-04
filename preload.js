const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld("electronAPI", {
  compressFile: (input, output) => ipcRenderer.invoke('compress-file', input, output),
  openExternal: (url) => ipcRenderer.send('open-external', url)
});
