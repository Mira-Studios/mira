// Run with Electron after `npm run build:renderer`; uses an isolated temporary profile.
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  shell,
  webContents,
  type WebContents,
} from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { isWebAppWindow, openWebAppFromArgv, setupWebApps } from './webApps.ts';
import { setupSiteInteractions } from './siteInteractions.ts';
import { setupDeviceConnections } from './deviceConnections.ts';
import type { InstalledWebApp, WebAppState } from './webAppPolicy.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
const profile = mkdtempSync(path.join(os.tmpdir(), 'mira-pwa-smoke-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setPath('appData', profile);
app.setPath('home', profile);
app.disableHardwareAcceleration();
process.env.XDG_DATA_HOME = path.join(profile, 'xdg');
// Exercise real windows and renderers without displaying test windows.
BrowserWindow.prototype.show = function () {};
const privateShells = new Set<number>();
const routed: string[] = [];
const getHost = (contents: WebContents) =>
  BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
const timeout = setTimeout(() => {
  console.error('PWA smoke test timed out');
  app.exit(1);
}, 45000);
const waitFor = async <T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
};
const shellInvoke = (win: BrowserWindow, channel: string, ...args: unknown[]) =>
  win.webContents.executeJavaScript(
    `window.electron.ipcRenderer.invoke(${[channel, ...args].map((value) => JSON.stringify(value)).join(',')})`,
  );
let online = true;
const server = http.createServer((request, response) => {
  if (!online) {
    request.socket.destroy();
    return;
  }
  if (request.url === '/manifest.json') {
    response.setHeader('Content-Type', 'application/manifest+json');
    response.end(
      JSON.stringify({
        name: 'Mira PWA Test',
        id: '/fixture',
        start_url: '/app/start',
        scope: '/app/',
        display: 'standalone',
        icons: [{ src: '/icon.png', sizes: '192x192' }],
      }),
    );
  } else if (request.url === '/icon.png') {
    response.setHeader('Content-Type', 'image/png');
    const bitmap = Buffer.alloc(256 * 256 * 4);
    for (let i = 0; i < bitmap.length; i += 4) {
      bitmap[i] = 210;
      bitmap[i + 1] = 105;
      bitmap[i + 2] = 90;
      bitmap[i + 3] = 255;
    }
    response.end(nativeImage.createFromBitmap(bitmap, { width: 256, height: 256 }).toPNG());
  } else if (request.url === '/app/sw.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(
      `self.addEventListener('install',e=>{e.waitUntil(caches.open('fixture').then(c=>c.add('/app/start')).then(()=>self.skipWaiting()))});self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match('/app/start')))});`,
    );
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<html><head><link rel="manifest" href="/manifest.json"></head><body><h1 id="fixture">PWA fixture</h1><script>window.initialStandalone=matchMedia('(display-mode: standalone)').matches;navigator.serviceWorker.register('/app/sw.js');</script></body></html>`,
    );
  }
});

async function run() {
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    await app.whenReady();
    setupSiteInteractions(getHost);
    setupDeviceConnections(getHost);
    ipcMain.handle(
      'window-is-titlebar-overlay-enabled',
      (event) => process.platform === 'win32' && isWebAppWindow(getHost(event.sender)?.id ?? -1),
    );
    ipcMain.handle('window-is-maximized', (event) => getHost(event.sender)?.isMaximized() ?? false);
    ipcMain.handle(
      'window-is-fullscreen',
      (event) => getHost(event.sender)?.isFullScreen() ?? false,
    );
    ipcMain.handle('app-get-version', () => 'test');
    // The real browser renderer uses these unrelated host services during bootstrap.
    ipcMain.handle('window-consume-initial-url', () => `${base}/app/start`);
    ipcMain.handle('incoming-urls-consume', () => []);
    ipcMain.handle('recently-closed-get', () => []);
    ipcMain.handle('tab-navigation-history', (_event, id: number) => {
      const target = webContents.fromId(id);
      return target ? { history: [target.getURL()], index: 0 } : null;
    });
    for (const channel of [
      'session-take-window-restore',
      'session-get-restore-state',
      'session-save-window',
      'window-suspension-update-state',
      'window-suspension-ready',
      'recently-closed-update-window',
      'settings-set-window-suspension',
      'settings-set-ad-block-enabled',
      'settings-set-youtube-ad-beta-enabled',
      'settings-set-tracker-block-enabled',
      'settings-set-quit-on-last-window-close',
      'settings-set-run-on-startup',
      'settings-set-open-external-links-in-new-window',
      'window-set-titlebar-symbol-color',
      'tab-set-active-webcontents',
      'history-add',
      'history-update-title',
      'updates-check',
      'page-zoom-get',
    ])
      ipcMain.handle(channel, () => null);
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'window') return;
      contents.on('will-attach-webview', (_event, preferences) => {
        preferences.preload = path.join(directory, 'webview-preload.js');
        preferences.sandbox = true;
        preferences.nodeIntegration = false;
        preferences.contextIsolation = true;
        const host = getHost(contents);
        if (host && isWebAppWindow(host.id)) preferences.additionalArguments = ['--mira-web-app'];
      });
    });
    const launcherFolder = path.join(
      profile,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Mira Dev Apps',
    );
    const legacy: InstalledWebApp = {
      id: `${base}/legacy`,
      name: 'Older Notes',
      startUrl: `${base}/legacy/start`,
      scope: `${base}/legacy/`,
      manifestUrl: `${base}/manifest.json`,
      iconUrl: `${base}/icon.png`,
      installedAt: Date.now(),
    };
    const legacyKey = createHash('sha256').update(legacy.id).digest('hex').slice(0, 32);
    const legacyPath = path.join(launcherFolder, `Older Notes - ${legacyKey}.lnk`);
    if (process.platform === 'win32') {
      await fs.mkdir(launcherFolder, { recursive: true });
      await fs.mkdir(path.join(profile, 'web-apps'), { recursive: true });
      await fs.writeFile(path.join(profile, 'web-apps/apps.json'), JSON.stringify([legacy]));
      assert.ok(
        shell.writeShortcutLink(legacyPath, 'create', {
          target: process.execPath,
          args: `--web-app=${legacyKey}`,
        }),
      );
      assert.ok(
        shell.writeShortcutLink(path.join(launcherFolder, 'Older Notes.lnk'), 'create', {
          target: process.execPath,
          args: '--unrelated',
        }),
      );
    }
    await setupWebApps({
      getHost,
      isPrivate: (contents) => privateShells.has(getHost(contents)?.id ?? -1),
      openInBrowser: (url) => routed.push(url),
      cleanupWindow: () => undefined,
      loadShell: (win) => {
        void win.loadFile(path.join(directory, '../dist/index.html'), { query: { webApp: '1' } });
      },
    });
    const makeShell = async (isPrivate = false, fullRenderer = false) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(directory, 'preload.js'),
          webviewTag: true,
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      if (isPrivate) privateShells.add(win.id);
      const filename = fullRenderer
        ? path.join(directory, '../dist/index.html')
        : path.join(profile, `shell-${win.id}.html`);
      if (!fullRenderer)
        await fs.writeFile(
          filename,
          `<html><body><webview style="width:100%;height:90vh" src="${base}/app/start"></webview></body></html>`,
        );
      await win.loadFile(filename);
      const guest = await waitFor(
        () =>
          webContents
            .getAllWebContents()
            .find(
              (contents) =>
                contents.hostWebContents === win.webContents &&
                contents.getURL() === `${base}/app/start` &&
                !contents.isLoading(),
            ),
        'guest load',
      );
      return { win, guest };
    };
    const { win: browser, guest } = await makeShell(false, true);
    if (process.platform === 'win32') {
      const migrated = (await shellInvoke(browser, 'web-app-list'))[0] as InstalledWebApp;
      assert.equal(migrated.launcherName, 'Older Notes (127.0.0.1)');
      assert.equal(
        await fs.access(legacyPath).then(
          () => true,
          () => false,
        ),
        false,
        'legacy ID suffix should be removed',
      );
      assert.equal(
        shell.readShortcutLink(path.join(launcherFolder, 'Older Notes.lnk')).args,
        '--unrelated',
        'preserve unrelated shortcuts',
      );
      assert.equal((await shellInvoke(browser, 'web-app-uninstall', migrated.id)).ok, true);
    }
    const state = await waitFor(async () => {
      const value = (await shellInvoke(browser, 'web-app-get-state', guest.id)) as WebAppState;
      return value?.app && value;
    }, 'install detection');
    assert.equal(state.app!.name, 'Mira PWA Test');
    await browser.webContents.executeJavaScript(`(() => {
      const settings = JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}');
      settings.animationsEnabled = true;
      localStorage.setItem('mira.settings.browser.v1', JSON.stringify(settings));
      window.dispatchEvent(new Event('mira:settings-changed'));
    })()`);
    await waitFor(
      () =>
        browser.webContents.executeJavaScript(
          `!!document.querySelector('.web-app-button-visible button[aria-label="Install Mira PWA Test"]')`,
        ),
      'animated install button',
    );
    await waitFor(
      () =>
        browser.webContents.executeJavaScript(
          `document.querySelector('.web-app-button-slot').dataset.animate === 'true'`,
        ),
      'enabled animations',
    );
    assert.equal(
      await browser.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.web-app-button-slot')).transitionProperty.includes('width')`,
      ),
      await browser.webContents.executeJavaScript(
        `!matchMedia('(prefers-reduced-motion: reduce)').matches`,
      ),
    );
    browser.webContents.debugger.attach('1.3');
    await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.equal(
      await browser.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.web-app-button-slot')).transitionProperty`,
      ),
      'none',
    );
    await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    browser.webContents.debugger.detach();
    await guest.executeJavaScript(`document.querySelector('link[rel="manifest"]').remove()`);
    await waitFor(
      async () => !(await shellInvoke(browser, 'web-app-get-state', guest.id))?.app,
      'dynamic manifest removal',
    );
    await waitFor(
      () =>
        browser.webContents.executeJavaScript(`!document.querySelector('.web-app-button-visible')`),
      'install button disappearance',
    );
    await guest.executeJavaScript(
      `const link = document.createElement('link'); link.rel = 'manifest'; link.href = '/manifest.json'; document.head.append(link);`,
    );
    await waitFor(
      async () => (await shellInvoke(browser, 'web-app-get-state', guest.id))?.app,
      'dynamic manifest addition',
    );
    await guest.executeJavaScript(`localStorage.setItem('account', 'signed-in')`);
    const { win: other } = await makeShell();
    assert.equal(
      await shellInvoke(other, 'web-app-get-state', guest.id),
      null,
      'cross-window IPC must be rejected',
    );
    const { win: privateWindow, guest: privateGuest } = await makeShell(true);
    assert.deepEqual(await shellInvoke(privateWindow, 'web-app-list'), []);
    assert.equal(await shellInvoke(privateWindow, 'web-app-get-state', privateGuest.id), null);
    assert.equal(
      (await shellInvoke(browser, 'web-app-install', guest.id, 'wrong-identity')).ok,
      false,
    );
    const result = await shellInvoke(browser, 'web-app-install', guest.id, state.app!.id);
    assert.equal(result.ok, true);
    await waitFor(
      () =>
        browser.webContents.executeJavaScript(
          `!!document.querySelector('.web-app-button-visible button[aria-label="Open Mira PWA Test"]')`,
        ),
      'open app button',
    );
    assert.equal(
      result.warning,
      undefined,
      'system shortcut should be created in the isolated profile',
    );
    const appWindow = await waitFor(
      () => BrowserWindow.getAllWindows().find((win) => isWebAppWindow(win.id)),
      'app window',
    );
    const appGuest = await waitFor(
      () =>
        webContents
          .getAllWebContents()
          .find(
            (contents) =>
              contents.hostWebContents === appWindow.webContents &&
              contents.getURL() === `${base}/app/start` &&
              !contents.isLoading(),
          ),
      'installed app renderer',
    );
    assert.equal(appWindow.getTitle(), 'Mira PWA Test');
    assert.equal(await appWindow.webContents.executeJavaScript('document.title'), 'Mira PWA Test');
    assert.equal(
      await appWindow.webContents.executeJavaScript(
        `document.querySelector('.web-app-title')?.textContent`,
      ),
      'Mira PWA Test',
    );
    assert.ok(
      (await shellInvoke(appWindow, 'web-app-window-info')).iconDataUrl,
      'use the cached app icon in the title bar',
    );
    assert.equal(
      await appWindow.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="Reload"]').closest('header') !== null`,
      ),
      true,
      'navigation belongs in the title bar',
    );
    await fs.writeFile(
      path.join(profile, 'pwa-titlebar.png'),
      (await appWindow.webContents.capturePage()).toPNG(),
    );
    // Check the macOS layout geometry here; real traffic-light behavior needs macOS.
    await appWindow.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.web-app-titlebar');
      bar.classList.add('web-app-titlebar-mac');
      bar.querySelector('.web-app-native-caption')?.remove();
      bar.querySelector('.web-app-caption-controls')?.remove();
      const lights = document.createElement('div'); lights.className = 'web-app-traffic-lights';
      if (!bar.querySelector('.web-app-traffic-lights')) bar.prepend(lights);
    })()`);
    appWindow.setSize(480, 780);
    await waitFor(
      () => appWindow.webContents.executeJavaScript('innerWidth <= 480'),
      'compact macOS layout',
    );
    assert.equal(
      await appWindow.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.web-app-titlebar').getBoundingClientRect();
      const nav = document.querySelector('.web-app-titlebar-navigation').getBoundingClientRect();
      const identity = document.querySelector('.web-app-identity').getBoundingClientRect();
      const actions = document.querySelector('.web-app-titlebar-actions').getBoundingClientRect();
      return nav.left >= 82 && identity.right <= actions.left && actions.right <= bar.right;
    })()`),
      true,
      'macOS traffic lights and actions must fit at the minimum width',
    );
    await fs.writeFile(
      path.join(profile, 'pwa-macos-layout.png'),
      (await appWindow.webContents.capturePage()).toPNG(),
    );
    if (process.platform === 'win32') {
      const launchers = await fs.readdir(launcherFolder);
      assert.ok(launchers.includes('Mira PWA Test.lnk'));
      assert.ok(
        !launchers.some((name) =>
          name.includes(createHash('sha256').update(state.app!.id).digest('hex').slice(0, 32)),
        ),
      );
    }
    assert.equal(await appGuest.executeJavaScript(`localStorage.getItem('account')`), 'signed-in');
    assert.equal(
      await appGuest.executeJavaScript('window.initialStandalone'),
      true,
      'standalone must be reported before page scripts',
    );
    assert.equal(
      await appGuest.executeJavaScript('typeof window.electron'),
      'undefined',
      'remote page must not receive the privileged bridge',
    );
    await appGuest.executeJavaScript(
      `const a = document.createElement('a'); a.href = '${base}/outside'; document.body.append(a); a.click();`,
    );
    await waitFor(() => routed.includes(`${base}/outside`), 'out-of-scope link');
    assert.equal(appGuest.getURL(), `${base}/app/start`);
    await waitFor(
      () => appGuest.executeJavaScript('!!navigator.serviceWorker.controller'),
      'service worker activation',
    );
    online = false;
    await appGuest.loadURL(`${base}/app/offline`);
    assert.equal(
      await appGuest.executeJavaScript(`document.querySelector('#fixture')?.textContent`),
      'PWA fixture',
      'service worker must serve the app offline',
    );
    online = true;
    const saved = JSON.parse(
      await fs.readFile(path.join(profile, 'web-apps/apps.json'), 'utf8'),
    ) as InstalledWebApp[];
    assert.equal(saved.length, 1);
    const key = createHash('sha256').update(saved[0].id).digest('hex').slice(0, 32);
    appWindow.destroy();
    assert.equal(
      openWebAppFromArgv([`--web-app=${key}`]),
      true,
      'shortcut argument must relaunch a saved app',
    );
    const reopened = await waitFor(
      () => BrowserWindow.getAllWindows().find((win) => isWebAppWindow(win.id)),
      'app relaunch',
    );
    await waitFor(() => !reopened.webContents.isLoading(), 'relaunch shell');
    assert.equal((await shellInvoke(browser, 'web-app-list')).length, 1);
    assert.equal((await shellInvoke(browser, 'web-app-uninstall', saved[0].id)).ok, true);
    assert.deepEqual(await shellInvoke(browser, 'web-app-list'), []);
    assert.equal(
      await guest.executeJavaScript(`localStorage.getItem('account')`),
      'signed-in',
      'uninstall must preserve shared site data',
    );
    console.log(
      'PASS: detection, IPC isolation, private mode, install, shortcut, shared sign-in, standalone, scope, offline, persistence, relaunch, uninstall',
    );
    console.log(`Isolated test profile: ${profile}`);
    clearTimeout(timeout);
    server.close();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    server.close();
    app.exit(1);
  }
}
void run();
