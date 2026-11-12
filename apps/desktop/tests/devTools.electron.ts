// Run with ELECTRON_RUN_AS_NODE unset: electron tests/devTools.electron.ts
import { app, BrowserWindow, webContents, WebContentsView } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { setTimeout as delay } from 'node:timers/promises';
import { createDevToolsController } from '../electron/devTools.ts';

const tempRoot = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
mkdirSync(tempRoot, { recursive: true });
const userData = mkdtempSync(path.join(tempRoot, 'devtools-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => {
  console.error('DevTools smoke test timed out');
  app.exit(1);
}, 45_000);

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const expires = Date.now() + 8000;
  while (!(await check())) {
    assert.ok(Date.now() < expires, message);
    await delay(50);
  }
}

async function run() {
  await app.whenReady();
  buildSync({
    entryPoints: [fileURLToPath(new URL('./fixtures/devToolsDock.tsx', import.meta.url))],
    outfile: path.join(userData, 'fixture.js'), bundle: true, jsx: 'automatic', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
  });
  writeFileSync(path.join(userData, 'fixture.html'), `
    <body style="margin:0;background:#fff"><div id="root"></div>
    <script>
      const { ipcRenderer } = require('electron');
      window.electron = { ipcRenderer: {
        on: (channel, listener) => { ipcRenderer.on(channel, listener); },
        off: (channel, listener) => { ipcRenderer.off(channel, listener); },
        invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      } };
    </script><script src="fixture.js"></script>
  `);
  const controller = createDevToolsController();
  controller.setupIpc();
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    titleBarStyle: 'hidden', titleBarOverlay: process.platform === 'win32',
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(userData, 'fixture.html'));
  const guests = () => webContents.getAllWebContents().filter((wc) => wc.hostWebContents === win.webContents);
  await until(() => guests().length === 2 && guests().every((wc) => !wc.isLoading()), 'Two guests load');
  const ids: number[] = await win.webContents.executeJavaScript(
    '[...document.querySelectorAll("webview")].map(view => view.getWebContentsId())',
  );
  const [first, second] = ids.map((id) => webContents.fromId(id)!);
  const views = () => win.contentView.children.filter((view): view is WebContentsView =>
    view instanceof WebContentsView && view.webContents !== win.webContents);
  const switchTab = async (index: number) => {
    await win.webContents.executeJavaScript(`window.selectTab(${index})`);
    controller.setActive(win, index === 0 ? first.id : second.id);
    await delay(100);
  };
  const fullWidth = await first.executeJavaScript('innerWidth');
  controller.setMode(win, 'side');
  controller.setActive(win, first.id);
  assert.equal(controller.open(first, win, { activate: false }), true);
  await until(() => controller.isOpen(first) && views()[0]?.getBounds().width === 415, 'First DevTools is embedded');
  await until(async () => (await first.executeJavaScript('innerWidth')) < fullWidth - 100, 'First guest makes space');
  const firstView = views()[0];
  const firstFrontend = firstView.webContents;
  await until(() => firstFrontend.getURL().startsWith('devtools://') && !firstFrontend.isLoading(), 'DevTools frontend loads');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'No separate DevTools window');
  assert.equal(controller.open(first, win), true);
  assert.equal(views().length, 1, 'Opening existing DevTools does not duplicate it');
  await win.webContents.executeJavaScript(`
    const separator = document.querySelector('[role="separator"]');
    for (let i = 0; i < 7; i++) separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    undefined;
  `);
  await until(() => firstView.getBounds().width === 555, 'Resize control updates native DevTools bounds');
  assert.equal(await win.webContents.executeJavaScript('localStorage.getItem("mira:devtools-dock-width")'), '560', 'Resized width is saved');
  await first.loadURL('data:text/html,<title>Refreshed page</title>');
  first.reload();
  await until(() => !first.isLoading(), 'Page refresh completes');
  assert.equal(controller.isOpen(first), true, 'DevTools remains connected through navigation and refresh');
  assert.equal(views()[0].webContents, firstFrontend, 'Refresh retains the DevTools session');
  assert.equal(firstView.getBounds().width, 555, 'Refresh retains dock width');
  await until(async () => (await firstFrontend.executeJavaScript(`(async () => {
    const SDK = await import('devtools://devtools/bundled/core/sdk/sdk.js');
    const target = SDK.TargetManager.TargetManager.instance().primaryPageTarget();
    if (!target) return null;
    const result = await target.runtimeAgent().invoke_evaluate({ expression: 'document.title', returnByValue: true });
    return result.result?.value;
  })()`)) === 'Refreshed page', 'DevTools inspects the refreshed page');
  if (process.env.MIRA_DEVTOOLS_SCREENSHOT) {
    win.showInactive();
    await delay(500);
    writeFileSync(path.join(tempRoot, 'devtools-test.png'), (await win.capturePage()).toPNG());
    writeFileSync(path.join(tempRoot, 'devtools-frontend-test.png'), (await firstFrontend.capturePage()).toPNG());
    win.hide();
  }

  await switchTab(1);
  await until(async () => (await second.executeJavaScript('innerWidth')) === fullWidth, 'Second tab reaches full width');
  assert.equal(firstView.getVisible(), false, 'First DevTools hides when its tab is inactive');
  assert.equal(controller.isOpen(first), true, 'First DevTools stays alive');
  assert.equal(await second.executeJavaScript('innerWidth'), fullWidth, 'Second tab remains full width');
  assert.equal(controller.open(second, win, { activate: false }), true);
  await until(() => controller.isOpen(second) && views().length === 2, 'Second tab gets independent DevTools');
  const secondView = views().find((view) => view !== firstView)!;
  const secondFrontend = secondView.webContents;
  await until(() => secondView.getBounds().width === 415, 'Second dock is laid out');
  await switchTab(0);
  assert.equal(firstView.getVisible(), true);
  assert.equal(secondView.getVisible(), false);
  assert.equal(controller.isOpen(first) && controller.isOpen(second), true);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="Close Developer Tools"]').click()`);
  await until(() => views().length === 1, 'Closing first dock releases its native view');
  assert.equal(controller.isOpen(second), true, 'Closing first dock does not affect second');
  await until(async () => (await first.executeJavaScript('innerWidth')) === fullWidth, 'First guest returns to full width');

  controller.setMode(win, 'window');
  assert.equal(controller.setMode(win, 'invalid'), false);
  assert.equal(controller.open(first, win, { activate: false }), true);
  await until(() => controller.isOpen(first), 'Separate-window mode opens');
  assert.equal(views().length, 1, 'Separate-window mode creates no embedded view');
  assert.equal(await first.executeJavaScript('innerWidth'), fullWidth);
  controller.close(first);
  await until(() => !controller.isOpen(first), 'Detached tools closes');

  assert.equal(controller.open(first, win, { mode: 'right', activate: false }), true);
  await until(() => controller.isOpen(first) && views().length === 2, 'Explicit side mode overrides previous detached mode');
  await until(() => views().find(view => view !== secondView)?.getBounds().width === 555, 'Reopening restores the resized width');
  await win.webContents.executeJavaScript('document.querySelector("webview").remove()');
  await until(() => views().length === 1, 'Destroying a guest releases its dock');
  win.destroy();
  await until(() => firstFrontend.isDestroyed() && secondFrontend.isDestroyed(), 'Closing window releases DevTools views');
  const freshWindow = new BrowserWindow({
    show: false, width: 1200, height: 800,
    titleBarStyle: 'hidden', titleBarOverlay: process.platform === 'win32',
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  await freshWindow.loadFile(path.join(userData, 'fixture.html'));
  await until(() => webContents.getAllWebContents().some(wc => wc.hostWebContents === freshWindow.webContents && !wc.isLoading()), 'Fresh window loads');
  const freshId = await freshWindow.webContents.executeJavaScript('document.querySelector("webview").getWebContentsId()');
  const freshGuest = webContents.fromId(freshId)!;
  controller.setActive(freshWindow, freshId);
  controller.open(freshGuest, freshWindow, { activate: false });
  await until(() => freshWindow.contentView.children.some(view => view.getBounds().width === 555), 'New panel restores saved width from storage');
  freshWindow.destroy();
  console.log('DevTools per-tab docking, switching, independent close, separate windows, and cleanup passed.');
}

void run().then(() => {
  clearTimeout(deadline);
  app.quit();
}).catch((error) => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
