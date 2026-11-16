const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jengaUpdater', {
  getVersion: () => ipcRenderer.invoke('updater:get-version'),
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  startUpdate: (downloadUrl) => ipcRenderer.invoke('updater:start', downloadUrl),
  onProgress: (callback) => {
    const listener = (_event, percent) => callback(percent);
    ipcRenderer.on('updater:progress', listener);
    return () => ipcRenderer.removeListener('updater:progress', listener);
  },
  onError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('updater:error', listener);
    return () => ipcRenderer.removeListener('updater:error', listener);
  },
});
