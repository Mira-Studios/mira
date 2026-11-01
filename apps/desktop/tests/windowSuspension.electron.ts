// Run with node_modules/electron/dist/electron.exe apps/desktop/tests/windowSuspension.electron.ts
import {
  app,
  BrowserWindow,
  webContents,
  session,
  ipcMain,
  nativeImage,
  ImageView,
} from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  setupWindowSuspension,
  createWindowPreviewImage,
  revealRestoredWindow,
} from '../electron/windowSuspension.ts';
import { areWindowContentsIdle } from '../electron/windowSuspensionSafety.ts';
import { setupDeviceConnections, hasWindowDeviceActivity } from '../electron/deviceConnections.ts';
import { setupWindowSuspensionFrames } from '../electron/windowSuspensionFrames.ts';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.resolve(testRoot, '../../../.tmp');
mkdirSync(tempRoot, { recursive: true });
const userData = mkdtempSync(path.join(tempRoot, 'window-suspension-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.on('window-all-closed', () => {});
const deadline = globalThis.setTimeout(() => {
  console.error('Suspension smoke test timed out');
  app.exit(1);
}, 45_000);

async function until(check: () => boolean, message: string) {
  const expires = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < expires, message);
    await delay(50);
  }
}

async function run() {
  try {
    await app.whenReady();
    const largeImage = nativeImage.createFromBitmap(Buffer.alloc(3840 * 2160 * 4), {
      width: 3840,
      height: 2160,
    });
    const previewImage = createWindowPreviewImage(largeImage, 3840);
    assert.equal(previewImage.getSize().width, 3840, 'Preview retains logical window size');
    assert.ok(
      previewImage.getScaleFactors()[0] < 1,
      'Preview retains only its low-resolution representation',
    );
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(true),
    );
    setupDeviceConnections((contents) =>
      BrowserWindow.fromWebContents(contents.hostWebContents ?? contents),
    );
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') setupWindowSuspensionFrames(contents);
    });
    ipcMain.on('webview-site-dialog-sync', (event) => {
      event.returnValue = false;
      throw new Error('Safety checks must not show dialogs');
    });
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: { webviewTag: true, backgroundThrottling: false },
    });
    win.webContents.on('will-attach-webview', (_event, preferences) => {
      preferences.preload = path.resolve(testRoot, '../electron/webview-preload.js');
      preferences.nodeIntegrationInSubFrames = true;
      preferences.contextIsolation = true;
      preferences.sandbox = true;
      preferences.nodeIntegration = false;
      preferences.backgroundThrottling = false;
    });
    const guests = () =>
      webContents
        .getAllWebContents()
        .filter(
          (content) =>
            content.getType() === 'webview' &&
            content.hostWebContents === win.webContents &&
            !content.isDestroyed(),
        );
    const fixture = pathToFileURL(path.join(testRoot, 'fixtures/suspension-host.html')).href;
    await win.loadURL(fixture);
    await until(
      () => guests().length === 2 && guests().every((content) => !content.isLoading()),
      'Tabs did not load',
    );
    const visibleTabId = await win.webContents.executeJavaScript(
      'document.querySelector("webview").getWebContentsId()',
    );
    const tab = webContents.fromId(visibleTabId)!;
    assert.equal(await areWindowContentsIdle(guests()), true, 'Idle preload instrumentation');
    const embedded = tab.mainFrame.framesInSubtree.find((frame) =>
      frame.url.startsWith('data:text/html'),
    )!;
    const empty = tab.mainFrame.framesInSubtree.find(
      (frame) => frame !== tab.mainFrame && frame.url === 'about:blank',
    )!;
    assert.ok(embedded, 'Cross-origin embed is present');
    assert.ok(empty, 'Initial empty helper iframe is present');
    for (const frame of [tab.mainFrame, embedded, empty]) {
      assert.equal(
        await frame.executeJavaScript('!!window.__miraSuspensionActivity'),
        true,
        'Every frame is monitored',
      );
      assert.equal(
        await frame.executeJavaScript(
          'typeof require === "undefined" && typeof process === "undefined"',
        ),
        true,
        'Website scripts cannot access Node',
      );
    }
    await embedded.executeJavaScript('window.onbeforeunload = () => "Draft"; undefined');
    assert.equal(
      await areWindowContentsIdle(guests()),
      false,
      'Unsaved work inside an embed is protected',
    );
    await embedded.executeJavaScript('window.onbeforeunload = null');
    await embedded.executeJavaScript('window.addEventListener("beforeunload", () => {})');
    assert.equal(
      await areWindowContentsIdle(guests()),
      true,
      'An idle embedded leave-page listener does not block',
    );
    await empty.executeJavaScript('window.peer = new RTCPeerConnection(); undefined');
    assert.equal(
      await areWindowContentsIdle(guests()),
      false,
      'Active work in initial blank frames is protected',
    );
    await empty.executeJavaScript('window.peer.close()');
    await empty.executeJavaScript(
      'window.unloadHandler = () => {}; window.addEventListener("beforeunload", window.unloadHandler)',
    );
    assert.equal(await areWindowContentsIdle(guests()), true);
    await empty.executeJavaScript(
      'window.removeEventListener("beforeunload", window.unloadHandler); window.onbeforeunload = () => "Draft"; undefined',
    );
    assert.equal(
      await areWindowContentsIdle(guests()),
      false,
      'Unsaved work in empty helper frames is protected',
    );
    await empty.executeJavaScript('window.onbeforeunload = null');
    await win.webContents.executeJavaScript('document.body.dataset.miraPreventSuspension = "true"');
    assert.equal(
      await areWindowContentsIdle(guests(), win.webContents),
      false,
      'Built-in drafts block',
    );
    await win.webContents.executeJavaScript('delete document.body.dataset.miraPreventSuspension');

    await tab.executeJavaScript('window.onbeforeunload = () => "Unsaved"; undefined');
    assert.equal(await areWindowContentsIdle(guests()), false, 'Beforeunload property blocks');
    await tab.executeJavaScript(
      'window.onbeforeunload = null; window.unloadHandler = () => {}; window.addEventListener("beforeunload", window.unloadHandler)',
    );
    assert.equal(
      await areWindowContentsIdle(guests()),
      true,
      'Routine beforeunload listeners do not block an idle page',
    );
    await tab.executeJavaScript('window.removeEventListener("beforeunload", window.unloadHandler)');
    assert.equal(await areWindowContentsIdle(guests()), true);
    await tab.executeJavaScript(
      'window.unloadHandler = () => {}; window.addEventListener("beforeunload", window.unloadHandler, true); window.addEventListener("beforeunload", window.unloadHandler, false); window.removeEventListener("beforeunload", window.unloadHandler, false)',
    );
    assert.equal(
      await areWindowContentsIdle(guests()),
      true,
      'Routine capture listener does not block',
    );
    await tab.executeJavaScript(
      'window.removeEventListener("beforeunload", window.unloadHandler, true)',
    );
    await tab.executeJavaScript(
      'window.unloadHandler = event => event.preventDefault(); window.addEventListener("beforeunload", window.unloadHandler)',
    );
    assert.equal(
      await areWindowContentsIdle(guests()),
      false,
      'A real unload veto still protects work without a dialog',
    );
    await tab.executeJavaScript('window.removeEventListener("beforeunload", window.unloadHandler)');

    await tab.executeJavaScript('window.peer = new RTCPeerConnection(); undefined');
    assert.equal(await areWindowContentsIdle(guests()), false, 'WebRTC blocks');
    await tab.executeJavaScript('window.peer.close()');
    assert.equal(await areWindowContentsIdle(guests()), true);
    await tab.executeJavaScript(
      'navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(stream => { window.stream = stream })',
    );
    assert.equal(await areWindowContentsIdle(guests()), false, 'Camera/microphone blocks');
    await tab.executeJavaScript('window.stream.getTracks().forEach(track => track.stop())');
    assert.equal(await areWindowContentsIdle(guests()), true);

    await tab.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.getContext('2d').fillRect(0,0,100,100);
    window.video = document.createElement('video');
    video.muted = true; video.srcObject = canvas.captureStream(1);
    document.body.appendChild(video); await video.play();
  })()`);
    assert.equal(await areWindowContentsIdle(guests()), false, 'Muted video blocks');
    await tab.executeJavaScript(
      'video.pause(); video.srcObject.getTracks().forEach(track => track.stop()); video.remove()',
    );
    assert.equal(await areWindowContentsIdle(guests()), true);

    await tab.executeJavaScript(
      'window.__miraDeviceBridge.update({id:"test-device",kind:"usb",connected:true})',
    );
    await until(() => hasWindowDeviceActivity(win.id), 'Device activity not tracked');
    await tab.executeJavaScript(
      'window.__miraDeviceBridge.update({id:"test-device",kind:"usb",connected:false})',
    );
    await until(() => !hasWindowDeviceActivity(win.id), 'Device disconnect not tracked');

    win.show();
    await win.webContents.executeJavaScript('document.querySelector("webview").focus()');
    tab.focus();
    tab.debugger.attach();
    await tab.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await tab.executeJavaScript('document.getElementById("draft").focus()');
    await tab.debugger.sendCommand('Input.insertText', { text: 'Unsaved draft' });
    assert.equal(
      await tab.executeJavaScript('document.getElementById("draft").value'),
      'Unsaved draft',
    );
    tab.debugger.detach();
    assert.equal(await areWindowContentsIdle(guests()), false, 'Trusted edits block');
    await tab.reload();
    await until(() => !tab.isLoading(), 'Reload did not finish');
    assert.equal(await areWindowContentsIdle(guests()), true);

    const beforeMetrics = app.getAppMetrics();
    const originalShellView = win.contentView;
    const before = {
      renderers: beforeMetrics.filter((metric) => metric.type === 'Tab').length,
      workingSetKB: beforeMetrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
    };
    let snapshotCommitted = false;
    const lifecycle = setupWindowSuspension(
      win,
      () => () => {
        snapshotCommitted = true;
      },
      () => {
        void win.loadURL(`${fixture}#restored`);
      },
      async () =>
        !hasWindowDeviceActivity(win.id) &&
        (await areWindowContentsIdle(guests(), win.webContents)),
    );
    lifecycle.configure({ enabled: true, delayMs: 1000 });
    win.minimize();
    await until(
      () => lifecycle.isUnloaded && win.webContents.isCrashed(),
      'Renderer was not released',
    );
    assert.equal(snapshotCommitted, true);
    await until(() => guests().length === 0, 'Live tabs remained allocated');
    assert.notEqual(
      win.contentView,
      originalShellView,
      'Screenshot has a stable native parent independent of Chromium',
    );
    assert.ok(
      win.contentView.children.includes(originalShellView),
      'Original browser surface is retained',
    );
    assert.equal(
      BrowserWindow.fromWebContents(win.webContents),
      win,
      'Native window ownership survives the overlay container',
    );
    assert.ok(
      win.contentView.children.at(-1) instanceof ImageView,
      'Native screenshot stays above the browser surface',
    );
    await delay(300);
    const afterMetrics = app.getAppMetrics();
    const after = {
      renderers: afterMetrics.filter((metric) => metric.type === 'Tab').length,
      workingSetKB: afterMetrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
    };
    assert.ok(after.renderers < before.renderers, 'Suspension should reduce renderer count');
    console.log(JSON.stringify({ before, suspended: after }));
    win.restore();
    await until(
      () => guests().length === 1 && guests().every((content) => !content.isLoading()),
      'Active tab did not restore',
    );
    const originalCapturePage = win.webContents.capturePage;
    let completePaint = () => {};
    const paintBarrier = new Promise<void>((resolve) => {
      completePaint = resolve;
    });
    Object.defineProperty(win.webContents, 'capturePage', {
      configurable: true,
      writable: true,
      value: async (
        rect?: Electron.Rectangle,
        options?: { stayHidden?: boolean; stayAwake?: boolean },
      ) => {
        await paintBarrier;
        return originalCapturePage.call(win.webContents, rect, options);
      },
    });
    const reveal = revealRestoredWindow(win, lifecycle);
    await delay(50);
    assert.ok(
      win.contentView.children.at(-1) instanceof ImageView,
      'Image remains until the replacement native window has painted',
    );
    completePaint();
    assert.equal(await reveal, true);
    win.webContents.capturePage = originalCapturePage;
    assert.equal(
      win.contentView.children.length,
      1,
      'Only the live browser surface remains after the compositor is ready',
    );
    lifecycle.close();
    win.destroy();
    console.log(
      'Electron suspension, activity protections, renderer release, and restoration passed.',
    );
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
}

app.once('will-quit', () => {
  if (userData.startsWith(`${tempRoot}${path.sep}`)) {
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      /* Chromium may still own cache files at exit. */
    }
  }
});
void run();
