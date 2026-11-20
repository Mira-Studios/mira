/* eslint-disable @typescript-eslint/no-require-imports */
/* global require */
const { contextBridge, ipcRenderer } = require('electron');
const isMacOS = process.platform === 'darwin';
const privatePartition = process.argv.find((arg) => arg.startsWith('--mira-private-partition='))?.split('=')[1];
const profileId = process.argv.find((arg) => arg.startsWith('--mira-profile-id='))?.slice('--mira-profile-id='.length);
const appVersion = process.env.MIRA_VERSION || null;
const rendererListeners = new Map();
let nextRendererListenerId = 0;

// Bootstrap synced preferences before React reads settings or paints a window.
// Main validates this allowlist; nothing else in localStorage can be synced.
if (profileId && !privatePartition) {
  const keys = ['mira.settings.browser.v1', 'mira.themes.custom.v1', 'mira.layouts.custom.v1'];
  let applying = false;
  let publishTimer;
  let pendingChangedAt = 0;
  let publishRevision = 0;
  const applySettings = (update) => {
    if (!update?.settings || update.updatedAt < pendingChangedAt) return;
    const bundle = update.settings;
    clearTimeout(publishTimer);
    pendingChangedAt = 0;
    publishRevision++;
    applying = true;
    let changed = false;
    try {
      for (const key of keys) {
        const next = bundle[key];
        const previous = localStorage.getItem(key);
        if (previous === next) continue;
        changed = true;
        if (next === null) localStorage.removeItem(key);
        else if (typeof next === 'string') localStorage.setItem(key, next);
      }
      if (changed) {
        window.dispatchEvent(new Event('mira:profile-settings-applied'));
        window.dispatchEvent(new Event('mira:settings-changed'));
      }
    } finally { applying = false; }
  };
  const publish = (initial = false) => {
    if (applying) return;
    clearTimeout(publishTimer);
    const revision = ++publishRevision;
    const changedAt = initial ? 0 : Date.now();
    pendingChangedAt = changedAt;
    publishTimer = setTimeout(() => {
      const bundle = Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
      void ipcRenderer.invoke('profile-settings-publish', { settings: bundle, changedAt, initial }).then(update => {
        if (revision !== publishRevision) return;
        pendingChangedAt = 0;
        applySettings(update);
      }).catch(() => { if (revision === publishRevision) pendingChangedAt = 0; });
    }, 100);
  };
  try { applySettings(ipcRenderer.sendSync('profile-settings-bootstrap')); } catch { /* A utility window has no profile bridge. */ }
  ipcRenderer.on('profile-settings-sync', (_event, bundle) => applySettings(bundle));
  window.addEventListener('mira:settings-changed', () => publish());
  window.addEventListener('storage', event => { if (!event.key || keys.includes(event.key)) publish(); });
  window.addEventListener('DOMContentLoaded', () => publish(true), { once: true });
}

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  isPrivate: !!privatePartition,
  privatePartition,
  profileId: privatePartition ? undefined : profileId,
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
