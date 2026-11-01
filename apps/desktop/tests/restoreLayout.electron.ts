// Build the renderer first, then run this file with Electron.
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.resolve(root, '../../../.tmp');
mkdirSync(tempRoot, { recursive: true });
const profile = mkdtempSync(path.join(tempRoot, 'restore-layout-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 45_000);
type Sample = {
  tabs: Array<{ id: string; x: number; y: number; width: number; height: number; opacity: number }>;
  tabHeight: string;
};
const tabs = Array.from({ length: 6 }, (_, index) => ({
  id: `restored-${index}`,
  url: 'mira://NewTab',
  title: `Restored ${index}`,
  history: ['mira://NewTab'],
  historyIndex: 0,
  reloadToken: 0,
  isPinned: index === 0,
  isSleeping: false,
  lastActiveAt: Date.now(),
  ...(index === 1 || index === 2
    ? { group: { id: 'test-group', name: 'Group', color: 'blue', collapsed: false } }
    : {}),
}));
const snapshot = { tabs, activeId: tabs[3].id, savedAt: Date.now() };
let mode: 'boot' | 'prompt' = 'boot';
let readyCount = 0;
ipcMain.handle('restore-layout-test-call', async (_event, channel: string) => {
  switch (channel) {
    case 'session-take-window-restore':
      await delay(100);
      return mode === 'boot' ? snapshot : null;
    case 'session-get-restore-state':
      return { hasPendingRestore: true, tabCount: tabs.length, windowCount: 1 };
    case 'session-accept-restore':
      return snapshot;
    case 'recently-closed-restore':
      return { tabs: [{ ...tabs[4], id: 'reopened' }], activeId: 'reopened' };
    case 'window-suspension-ready':
      readyCount++;
      return true;
    case 'window-is-titlebar-overlay-enabled':
      return true;
    case 'window-is-fullscreen':
    case 'window-is-maximized':
      return false;
    case 'window-consume-initial-url':
      return '';
    case 'incoming-urls-consume':
    case 'recently-closed-get':
    case 'device-connections-state':
      return [];
    default:
      return null;
  }
});

async function until(check: () => Promise<boolean>, message: string) {
  const expires = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < expires, message);
    await delay(25);
  }
}

async function verifySamples(win: BrowserWindow, ids: string[], label: string) {
  await until(
    async () =>
      await win.webContents.executeJavaScript(
        `document.querySelectorAll('[data-tab-id]').length === ${ids.length}`,
      ),
    `${label}: tabs missing`,
  );
  await delay(300);
  const samples: Sample[] = await win.webContents.executeJavaScript(
    'window.__restoreLayoutSamples',
  );
  const first = samples.findIndex((sample) => sample.tabs.some((tab) => tab.id === ids.at(-1)));
  assert.ok(first >= 0, `${label}: no restored frames recorded`);
  for (const sample of samples.slice(first)) {
    assert.deepEqual(
      sample.tabs.map((tab) => tab.id),
      ids,
      `${label}: placeholder or exiting tabs visible`,
    );
    assert.equal(sample.tabHeight, '32px', `${label}: saved layout missing at paint`);
    for (const tab of sample.tabs) {
      const final = samples.at(-1)!.tabs.find((candidate) => candidate.id === tab.id)!;
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        assert.ok(
          Math.abs(tab[key] - final[key]) < 1,
          `${label}: ${tab.id} ${key} moved ${tab[key]} -> ${final[key]}`,
        );
      }
    }
  }
}

async function run() {
  try {
    await app.whenReady();
    for (const position of ['top', 'left', 'right']) {
      for (const restoreMode of ['boot', 'prompt'] as const) {
        mode = restoreMode;
        readyCount = 0;
        const win = new BrowserWindow({
          show: false,
          width: 1000,
          height: 700,
          frame: false,
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#12161d', symbolColor: '#ffffff', height: 38 },
          webPreferences: {
            preload: path.join(root, 'fixtures/restore-layout-preload.cjs'),
            backgroundThrottling: false,
            additionalArguments: [`--test-tab-position=${position}`],
          },
        });
        await win.loadFile(path.resolve(root, '../dist/index.html'));
        win.showInactive();
        if (restoreMode === 'prompt') {
          await until(
            async () =>
              await win.webContents.executeJavaScript(
                `[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Restore Tabs')`,
              ),
            'Restore prompt missing',
          );
          await win.webContents.executeJavaScript(
            `window.__restoreLayoutSamples = []; [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Restore Tabs').click()`,
          );
        }
        await verifySamples(
          win,
          tabs.map((tab) => tab.id),
          `${position} ${restoreMode}`,
        );
        await until(async () => readyCount > 0, 'Screenshot revealed before layout readiness');
        if (restoreMode === 'boot') {
          const samples: Sample[] = await win.webContents.executeJavaScript(
            'window.__restoreLayoutSamples',
          );
          assert.deepEqual(
            samples[0].tabs.map((tab) => tab.id),
            tabs.map((tab) => tab.id),
            'Startup painted a placeholder tab',
          );
        }
        await win.webContents.executeJavaScript('window.__restoreLayoutSamples = []');
        win.webContents.send('app-shortcut', 'reopen-closed-tab');
        await verifySamples(win, [...tabs.map((tab) => tab.id), 'reopened'], `${position} recent`);
        assert.equal(
          await win.webContents.executeJavaScript(
            'document.querySelector("[data-tab-id=reopened]").classList.contains("theme-tab-selected")',
          ),
          true,
        );
        await win.webContents.executeJavaScript(
          'window.__restoreLayoutSamples = []; document.querySelector(".tab-new-tab-btn").click()',
        );
        await until(
          async () =>
            await win.webContents.executeJavaScript(
              'document.querySelectorAll("[data-tab-id]").length === 8',
            ),
          'Normal new tab missing',
        );
        await delay(300);
        const normalSamples: Sample[] = await win.webContents.executeJavaScript(
          'window.__restoreLayoutSamples',
        );
        const createdId = normalSamples.at(-1)!.tabs.at(-1)!.id;
        const dimension = position === 'top' ? 'width' : 'opacity';
        const sizes = normalSamples.flatMap((sample) =>
          sample.tabs.filter((tab) => tab.id === createdId).map((tab) => tab[dimension]),
        );
        assert.ok(
          Math.max(...sizes) - Math.min(...sizes) > (position === 'top' ? 10 : 0.2),
          `${position}: normal tab opening should still animate`,
        );
        win.destroy();
      }
    }
    console.log(
      'Restore layout stays stable for startup/suspended restores, manual restores, and reopened tabs in all three tab positions.',
    );
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
}
void run();
