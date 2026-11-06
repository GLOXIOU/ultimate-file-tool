const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  run: (payload) => ipcRenderer.invoke('job:run', payload),
  cancel: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  onJobEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('job:event', listener);
    return () => ipcRenderer.removeListener('job:event', listener);
  },
  service: (name, ...args) => ipcRenderer.invoke('service:call', name, args),
  pickFiles: (options) => ipcRenderer.invoke('dialog:openFiles', options),
  pickFolder: (options) => ipcRenderer.invoke('dialog:openFolder', options),
  describe: (paths) => ipcRenderer.invoke('fs:describe', paths),
  listFiles: (dir, accept, recursive) => ipcRenderer.invoke('fs:listFiles', dir, accept, recursive),
  readFile: (file) => ipcRenderer.invoke('fs:read', file),
  writeFile: (file, data) => ipcRenderer.invoke('fs:write', file, data),
  outputPath: (input, options) => ipcRenderer.invoke('fs:outputPath', input, options),
  outputFolder: (input, options) => ipcRenderer.invoke('fs:outputFolder', input, options),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  show: (target) => ipcRenderer.invoke('shell:show', target),
  external: (url) => ipcRenderer.invoke('shell:external', url),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
