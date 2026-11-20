/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  isMacOS: process.platform === 'darwin',
  ipcRenderer: {
    on: (channel, listener) => ipcRenderer.on(channel, listener),
    off: (channel, listener) => ipcRenderer.removeListener(channel, listener),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    invoke: (channel, ...args) =>
      /^(git-|editor-|site-interaction|app-dialog)/.test(channel)
        ? ipcRenderer.invoke(channel, ...args)
        : ipcRenderer.invoke('git-test-call', channel, ...args),
  },
});
