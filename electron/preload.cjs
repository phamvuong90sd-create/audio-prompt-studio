const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studioAPI', {
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  process: (payload) => ipcRenderer.invoke('audio:process', payload),
  saveConfig: (payload) => ipcRenderer.invoke('config:save', payload),
  loadConfig: () => ipcRenderer.invoke('config:load')
});
