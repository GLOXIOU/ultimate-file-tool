const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld("electronAPI", {
  compressFile: (input, output) => ipcRenderer.invoke('compress-file', input, output)
});