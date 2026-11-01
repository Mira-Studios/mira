/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, localStorage, window, document, requestAnimationFrame, getComputedStyle */
const { contextBridge, ipcRenderer } = require('electron');
const position =
  process.argv.find((arg) => arg.startsWith('--test-tab-position='))?.split('=')[1] ?? 'top';
contextBridge.executeInMainWorld({
  func: (tabStripPosition) => {
    localStorage.setItem(
      'mira.settings.browser.v1',
      JSON.stringify({
        animationsEnabled: true,
        startupRestoreBehavior: 'ask',
        tabStripPosition,
        disableNewTabIntro: true,
        autoUpdateOnLaunch: 'off',
        layoutId: 'restore-test-layout',
      }),
    );
    localStorage.setItem(
      'mira.layouts.custom.v1',
      JSON.stringify([
        {
          id: 'restore-test-layout',
          layout: {
            name: 'Restore test',
            author: 'Test',
            values: { layoutTabTargetWidth: '180px', layoutTabHeight: '32px' },
          },
        },
      ]),
    );
    window.__restoreLayoutSamples = [];
    const sample = () => {
      const tabs = [...document.querySelectorAll('[data-tab-id]')].map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.dataset.tabId,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
            opacity: Number(getComputedStyle(element).opacity),
        };
      });
      if (tabs.length)
        window.__restoreLayoutSamples.push({
          tabs,
          tabHeight: getComputedStyle(document.documentElement)
            .getPropertyValue('--layoutTabHeight')
            .trim(),
        });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  },
  args: [position],
});

contextBridge.exposeInMainWorld('electron', {
  platform: 'win32',
  isMacOS: false,
  ipcSubscriptionIds: true,
  ipcRenderer: {
    invoke: (channel, ...args) => ipcRenderer.invoke('restore-layout-test-call', channel, args),
    send: () => {},
    on: (channel, listener) => {
      const wrapped = (_event, ...args) => listener(undefined, ...args);
      const id = ++nextId;
      listeners.set(id, { channel, wrapped });
      ipcRenderer.on(channel, wrapped);
      return id;
    },
    off: (_channel, id) => {
      const entry = listeners.get(id);
      if (entry) ipcRenderer.removeListener(entry.channel, entry.wrapped);
      listeners.delete(id);
    },
  },
});
let nextId = 0;
const listeners = new Map();
