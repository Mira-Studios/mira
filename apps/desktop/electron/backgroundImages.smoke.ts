// Run after building the renderer: electron electron/backgroundImages.smoke.ts
import { app, BrowserWindow, dialog, nativeImage, net, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupBackgroundImages } from './backgroundImages.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
const profile = mkdtempSync(path.join(os.tmpdir(), 'mira-background-smoke-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const timeout = setTimeout(() => app.exit(1), 45_000);
let requests = 0;
let png: Buffer;
const server = http.createServer((request, response) => {
  requests++;
  if (request.url === '/invalid') return response.end('not an image');
  if (request.url === '/missing') {
    response.writeHead(404);
    return response.end();
  }
  if (request.url === '/blocked') {
    response.writeHead(403);
    return response.end();
  }
  if (request.url === '/page') {
    response.setHeader('Content-Type', 'text/html');
    return response.end('<html></html>');
  }
  if (request.url === '/oversize') {
    response.setHeader('Content-Length', 51 * 1024 * 1024);
    return response.end('x');
  }
  response.setHeader('Content-Type', 'image/png');
  if (request.url === '/large')
    return response.end(Buffer.concat([png, Buffer.alloc(12 * 1024 * 1024)]));
  response.end(png);
});
async function runSmoke() {
  try {
    await app.whenReady();
    png = nativeImage
      .createFromBitmap(Buffer.alloc(32 * 24 * 4, 180), { width: 32, height: 24 })
      .toPNG();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/image.png`;
    let backgroundLoads = 0;
    const registerHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) =>
      registerHandle(
        channel,
        channel === 'background-image-load'
          ? (event, ...args) => {
              backgroundLoads++;
              return listener(event, ...args);
            }
          : listener,
      );
    setupBackgroundImages();
    ipcMain.handle = registerHandle;
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { preload: path.join(directory, 'preload.js'), webviewTag: true },
    });
    const run = (script: string) => win.webContents.executeJavaScript(script);
    const invoke = (channel: string, ...args: unknown[]) =>
      run(
        `window.electron.ipcRenderer.invoke(${[channel, ...args].map((value) => JSON.stringify(value)).join(',')})`,
      );
    const waitFor = async (script: string) => {
      for (let i = 0; i < 100; i++) {
        if (await run(script)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out: ${script}`);
    };
    const patchSettings = async (patch: Record<string, unknown>) =>
      run(`(() => {
    const key = 'mira.settings.browser.v1';
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), ...${JSON.stringify(patch)} }));
    window.dispatchEvent(new CustomEvent('mira:settings-changed'));
  })()`);
    await win.loadFile(path.join(directory, '../dist/index.html'));
    const loaded = await invoke('background-image-load', url);
    assert.match(loaded, /^mira-background:\/\/image\/[a-f0-9]{64}\.png$/);
    assert(loaded.length < 120, 'IPC returns a short URL, never an image payload');
    assert.equal(requests, 1);
    await assert.rejects(invoke('background-image-load', 'file:///test.png'));
    await assert.rejects(
      invoke('background-image-load', `http://127.0.0.1:${address.port}/invalid`),
      /Could not read this image/,
    );
    for (const [route, expected] of [
      ['missing', /Image not found \(404\)/],
      ['blocked', /blocks the download \(403\)/],
      ['page', /direct image URL/],
      ['oversize', /exceeds 50 MB/],
    ] as const) {
      await assert.rejects(
        invoke('background-image-load', `http://127.0.0.1:${address.port}/${route}`),
        expected,
      );
    }
    const largeUrl = await invoke(
      'background-image-load',
      `http://127.0.0.1:${address.port}/large`,
    );
    const largeBytes = await (await net.fetch(largeUrl)).arrayBuffer();
    assert(
      largeBytes.byteLength > 10 * 1024 * 1024,
      'Large images stay in their original format without main-thread conversion',
    );
    const localFile = path.join(profile, 'selected.png');
    await fs.writeFile(localFile, Buffer.concat([png, Buffer.alloc(12 * 1024 * 1024)]));
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [localFile],
    })) as typeof dialog.showOpenDialog;
    const local = await invoke('background-image-choose');
    assert.match(local, /^local:[a-f0-9]{64}$/);
    await fs.unlink(localFile);
    const localUrl = await invoke('background-image-load', local);
    assert.deepEqual(await (await net.fetch(localUrl)).arrayBuffer(), largeBytes);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.equal(await invoke('background-image-load', url), loaded, 'URL image must work offline');
    await waitFor(`!!document.querySelector('input[placeholder="Search anything..."]')`);
    await patchSettings({
      backgroundImage: url,
      backgroundImageFit: 'stretch',
      backgroundImagePositionX: 25,
      backgroundImagePositionY: 75,
    });
    await waitFor(
      `document.querySelector('input[placeholder="Search anything..."]')?.closest('form')?.parentElement?.style.backgroundImage.includes('mira-background://')`,
    );
    assert.equal(
      await run(
        `document.querySelector('input[placeholder="Search anything..."]').closest('form').parentElement.style.backgroundSize`,
      ),
      '100% 100%',
    );
    assert.equal(
      await run(
        `document.querySelector('input[placeholder="Search anything..."]').closest('form').parentElement.style.backgroundPosition`,
      ),
      '25% 75%',
    );
    const firstTab = await run(`document.querySelector('[data-tab-id]').dataset.tabId`);
    const afterWarmup = backgroundLoads;
    await run(`document.querySelector('.tab-new-tab-btn').click()`);
    await waitFor(
      `document.querySelectorAll('input[placeholder="Search anything..."]').length === 2`,
    );
    assert.equal(
      backgroundLoads,
      afterWarmup,
      'Opening another New Tab reuses the decoded image without IPC',
    );
    win.webContents.send('background-window-visible', false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(backgroundLoads, afterWarmup, 'Minimizing on New Tab retains the image');
    win.webContents.send('background-window-visible', true);
    win.webContents.send('open-url-in-new-tab', 'mira://History');
    await waitFor(
      `document.querySelectorAll('input[placeholder="Search anything..."]').length === 1`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      backgroundLoads,
      afterWarmup,
      'Visible window keeps the image when switching away',
    );
    win.webContents.send('background-window-visible', false);
    await waitFor(
      `document.querySelector('input[placeholder="Search anything..."]')?.closest('form')?.parentElement?.style.backgroundImage === 'none'`,
    );
    const beforeRestore = backgroundLoads;
    win.webContents.send('background-window-visible', true);
    await waitFor(
      `document.querySelector('input[placeholder="Search anything..."]')?.closest('form')?.parentElement?.style.backgroundImage.includes('mira-background://')`,
    );
    assert.equal(backgroundLoads, beforeRestore + 1, 'Restoring warms the shared image once');
    await run(`document.querySelector('[data-tab-id="${firstTab}"]').click()`);
    assert.equal(
      await run(`document.documentElement.style.backgroundImage`),
      '',
      'Wallpaper must not affect browser chrome',
    );
    await patchSettings({ showNewTabSearch: false });
    await waitFor(`!document.querySelector('input[placeholder="Search anything..."]')`);
    await win.reload();
    await waitFor(
      `document.querySelector('input[placeholder="Search anything..."]') === null && !!document.querySelector('#root')?.children.length`,
    );
    await patchSettings({ showNewTabSearch: true });
    await waitFor(`!!document.querySelector('input[placeholder="Search anything..."]')`);
    await run(`localStorage.setItem('mira.themes.custom.v1', JSON.stringify([{ id: 'wallpaper-test', theme: {
    version: 'v1', name: 'Wallpaper test', author: 'Test', mode: 'dark', colors: { bg: '#123456' }, backgroundImageUrl: ${JSON.stringify(url)}
  } }]))`);
    await patchSettings({
      themeId: 'wallpaper-test',
      backgroundImage: '',
      useThemeBackgroundImage: true,
    });
    await waitFor(
      `document.querySelector('input[placeholder="Search anything..."]')?.closest('form')?.parentElement?.style.backgroundImage.includes('mira-background://')`,
    );
    await patchSettings({ useThemeBackgroundImage: false });
    await waitFor(
      `document.querySelector('input[placeholder="Search anything..."]')?.closest('form')?.parentElement?.style.backgroundImage === 'none'`,
    );
    await patchSettings({ newTabPage: 'mira://Settings#section=appearance', backgroundImage: url });
    win.reload();
    await waitFor(`!!document.querySelector('#newtab-background-url')`);
    assert.equal(
      await run(`!!document.querySelector('#newtab-background-url').closest('.settings-card')`),
      true,
    );
    await run(`(() => {
    const label = [...document.querySelectorAll('label')].find(label => label.textContent.includes('Show center search bar'));
    label.querySelector('input').click();
  })()`);
    assert.equal(
      await run(`JSON.parse(localStorage.getItem('mira.settings.browser.v1')).showNewTabSearch`),
      false,
    );
    await run(`(() => {
      const input = document.querySelector('#newtab-background-url');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'invalid');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await run(`document.querySelector('#newtab-background-url').closest('form').requestSubmit()`);
    await waitFor(
      `document.querySelector('#newtab-background-error')?.textContent.includes('http:// or https://')`,
    );
    assert.equal(
      await run(
        `document.querySelector('#newtab-background-error').textContent.includes('Error invoking remote method')`,
      ),
      false,
    );
    assert.equal(
      await run(`JSON.parse(localStorage.getItem('mira.settings.browser.v1')).backgroundImage`),
      url,
      'Failed changes preserve the current background',
    );
    await run(
      `document.querySelector('#newtab-background-url').scrollIntoView({ block: 'start' })`,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const preview = path.resolve(directory, '../../../.tmp/newtab-appearance-preview.png');
    await fs.mkdir(path.dirname(preview), { recursive: true });
    await fs.writeFile(preview, (await win.webContents.capturePage()).toPNG());
    win.destroy();
    console.log(
      'Background smoke passed: URL download, validation, local import, offline cache, New Tab sizing/position, search visibility, persistence, and theme opt-in.',
    );
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
}
void runSmoke();
