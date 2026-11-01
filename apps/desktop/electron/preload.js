/* eslint-disable @typescript-eslint/no-require-imports */
/* global require */
const { contextBridge, ipcRenderer } = require('electron');
const isMacOS = process.platform === 'darwin';
const privatePartition = process.argv.find((arg) => arg.startsWith('--mira-private-partition='))?.split('=')[1];
const appVersion = process.env.MIRA_VERSION || null;
const rendererListeners = new Map();
let nextRendererListenerId = 0;

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  isPrivate: !!privatePartition,
  privatePartition,
  isMacOS,
  appVersion,
  ipcSubscriptionIds: true,
  getAppVersion: () => ipcRenderer.invoke('app-get-version'),
  ipcRenderer: {
    on: (channel, listener) => {
      const id = ++nextRendererListenerId;
      const wrapped = (_event, ...args) => listener(undefined, ...args);
      rendererListeners.set(id, { channel, wrapped });
      ipcRenderer.on(channel, wrapped);
      return id;
    },
    off: (channel, id) => {
      const subscription = rendererListeners.get(id);
      if (!subscription || subscription.channel !== channel) return;
      ipcRenderer.removeListener(channel, subscription.wrapped);
      rendererListeners.delete(id);
    },
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  },
});

contextBridge.exposeInMainWorld('mira', {
  version: appVersion,
  getVersion: () => ipcRenderer.invoke('app-get-version'),
});

// Consume Ctrl+wheel before Chromium's default page/UI zoom handling.
let zoomWheelDelta = 0;
let lastZoomWheelAt = 0;
window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || !event.isTrusted || !event.deltaY) return;
  event.preventDefault();
  const now = performance.now();
  const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 120 : 1);
  if (now - lastZoomWheelAt > 200 || Math.sign(zoomWheelDelta) !== Math.sign(delta)) zoomWheelDelta = 0;
  lastZoomWheelAt = now;
  zoomWheelDelta += delta;
  if (Math.abs(zoomWheelDelta) < 40) return;
  ipcRenderer.send('page-zoom-wheel', zoomWheelDelta < 0 ? 'in' : 'out');
  zoomWheelDelta = 0;
}, { capture: true, passive: false });
