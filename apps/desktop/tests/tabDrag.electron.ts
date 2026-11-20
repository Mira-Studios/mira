// Start the renderer on localhost:5173, then run: electron tests/tabDrag.electron.ts
import { app, BrowserWindow, screen, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const tempRoot = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
mkdirSync(tempRoot, { recursive: true });
const profile = mkdtempSync(path.join(tempRoot, 'tab-drag-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const originalSetPath = app.setPath.bind(app);
app.setPath = (name, value) => originalSetPath(name, name === 'userData' || name === 'sessionData' ? profile : value);
app.disableHardwareAcceleration();
app.setAsDefaultProtocolClient = () => false;
app.setUserTasks = () => false;
app.requestSingleInstanceLock = () => true;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  try { return await listener(...args); }
  catch (error) { console.error('IPC failed', channel, error); throw error; }
});
writeFileSync(path.join(profile, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
let cursor = { x: 500, y: 500 };
app.whenReady().then(() => { screen.getCursorScreenPoint = () => cursor; });
const originalLoad = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function(url, options) {
  return originalLoad.call(this, url.replace('localhost:5173', `localhost:${process.env.MIRA_TEST_RENDERER_PORT ?? '5173'}`), options);
};
// Enable OS input checks only on an idle foreground desktop.
const nativeInput = process.env.MIRA_TEST_NATIVE_INPUT === '1';
const deadline = setTimeout(() => { console.error('Tab drag test timed out'); app.exit(1); }, 45_000);

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 12_000;
  while (!await check()) {
    assert.ok(Date.now() < end, message);
    await delay(40);
  }
}
// Drive renderer gestures deterministically; native window state and IPC remain real.
async function input(win: BrowserWindow, event: { type: string; x: number; y: number; button?: string; clickCount?: number; modifiers?: string[] }) {
  const type = event.type === 'mouseDown' ? 'pointerdown' : event.type === 'mouseUp' ? 'pointerup' : 'pointermove';
  const buttons = event.type === 'mouseDown' || event.modifiers?.includes('leftButtonDown') ? 1 : 0;
  await win.webContents.executeJavaScript(`(() => {
    const target = ${type === 'pointerdown' ? `document.elementFromPoint(${event.x}, ${event.y})` : 'window'};
    const capture = Element.prototype.setPointerCapture;
    // Synthetic pointers have no native capture identity. Moves/releases target the shell directly.
    Element.prototype.setPointerCapture = () => {};
    try { target.dispatchEvent(new PointerEvent('${type}', {
      bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      clientX: ${event.x}, clientY: ${event.y}, button: 0, buttons: ${buttons},
    })); } finally { Element.prototype.setPointerCapture = capture; }
  })()`);
}
const tabIds = (win: BrowserWindow): Promise<string[]> => win.webContents.executeJavaScript(
  '[...document.querySelectorAll("[data-tab-id]")].map(tab => tab.dataset.tabId)',
);

async function run() {
  try {
    await import('../electron/main.ts');
    await until(() => BrowserWindow.getAllWindows().length > 0, 'Initial window opens');
    const source = BrowserWindow.getAllWindows()[0];
    await until(async () => (await tabIds(source)).length === 1, 'Tab strip renders');
    await source.webContents.executeJavaScript(`document.querySelector('.tab-new-tab-btn').click()`);
    await until(async () => (await tabIds(source)).length === 2, 'Second tab opens');
    await delay(300);
    const originalIds = await tabIds(source);
    source.focus();
    source.webContents.focus();
    await delay(150);
    for (const index of [0, 1]) {
      const point = await source.webContents.executeJavaScript(`(() => {
        const r = document.querySelectorAll('[data-tab-id]')[${index}].getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (nativeInput) {
        source.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        await delay(50);
        source.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        await delay(30);
        source.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      } else {
        await source.webContents.executeJavaScript(`document.querySelectorAll('[data-tab-id]')[${index}].click()`);
      }
      await until(async () => await source.webContents.executeJavaScript(`document.querySelector('[data-tab-id].theme-tab-selected')?.dataset.tabId === ${JSON.stringify(originalIds[index])}`), 'Ordinary clicks switch tabs');
    }
    const blankRegion = await source.webContents.executeJavaScript(`(() => {
      const strip = document.querySelector('.tab-strip-scroll');
      const plus = document.querySelector('.tab-new-tab-btn').getBoundingClientRect();
      const rect = strip.parentElement.parentElement.getBoundingClientRect();
      let target = document.elementFromPoint(Math.min(rect.right - 5, plus.right + 30), (rect.top + rect.bottom) / 2);
      let result = 'none';
      while (target) {
        const region = getComputedStyle(target).webkitAppRegion;
        if (region === 'no-drag') return region;
        if (region === 'drag') result = region;
        target = target.parentElement;
      }
      return result;
    })()`);
    assert.equal(blankRegion, 'drag', 'Empty tab-strip space remains a native window drag region');

    source.unmaximize();
    await until(() => !source.isMaximized(), 'Sizing test window restores');
    source.setBounds({ x: 200, y: 200, width: 640, height: 700 });
    await until(() => source.getBounds().width === 640, 'Sizing test window reaches its narrow width');
    await source.webContents.executeJavaScript(`document.querySelector('[data-tab-id] .tab-title').textContent = 'A much longer tab title that must not change the width distribution';`);
    await delay(300);
    const widths = await source.webContents.executeJavaScript(`[...document.querySelectorAll('[data-tab-id]')].map(tab => tab.getBoundingClientRect().width)`);
    assert.ok(Math.abs(widths[0] - widths[1]) <= 1, 'Normal tabs retain equal flex widths with different title lengths');
    source.maximize();
    await until(() => source.isMaximized(), 'Window maximizes after the scroll checks');
    await delay(300);
    await source.webContents.executeJavaScript(`
      window.previewAnimationCount = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(...args) {
        if (this.hasAttribute('data-tab-id')) window.previewAnimationCount++;
        return animate.apply(this, args);
      };
      document.documentElement.style.setProperty('--tabBorderHover', 'rgb(40, 150, 90)');
    `);

    source.focus();
    source.webContents.focus();
    await until(() => source.isVisible() && source.isFocused(), 'Source window is ready for native input');
    await delay(100);
    const rect = await source.webContents.executeJavaScript(`(() => {
      const r = document.querySelectorAll('[data-tab-id]')[1].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const move = async (x: number, y: number) => {
      const bounds = source.getContentBounds();
      cursor = { x: bounds.x + x, y: bounds.y + y };
      await input(source, { type: 'mouseMove', x, y, modifiers: ['leftButtonDown'] });
    };
    await input(source, { type: 'mouseMove', ...rect });
    await delay(50);
    await input(source, { type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
    await delay(50);
    await move(rect.x, rect.y + 160);
    await until(() => BrowserWindow.getAllWindows().length === 2, 'Dragging out creates a window');
    const detached = BrowserWindow.getAllWindows().find(win => win.id !== source.id)!;
    assert.equal(detached.isMaximized(), false);
    assert.ok(detached.getBounds().width <= 900);
    assert.ok(detached.getBounds().height <= 650);
    await until(async () => !(await tabIds(source)).includes(originalIds[1]), 'Outgoing tab disappears before mouse release');
    await until(async () => (await tabIds(detached)).includes(originalIds[1]), 'Detached tab loads');
    await move(rect.x + 200, rect.y + 220);
    await delay(100);
    const movedBounds = detached.getBounds();
    cursor = { x: cursor.x + 80, y: cursor.y + 60 };
    await source.webContents.executeJavaScript(`window.dispatchEvent(new Event('blur'))`);
    await until(() => detached.getBounds().x === movedBounds.x + 80, 'Drag continues through focus changes');
    assert.equal(detached.getBounds().y, movedBounds.y + 60);
    await move(rect.x, rect.y);
    await until(async () => await source.webContents.executeJavaScript(`!!document.querySelector('[data-tab-drop-preview]')`), 'Hover shows a tab in the destination strip');
    writeFileSync(path.join(tempRoot, 'tab-drag-hover.png'), (await source.webContents.capturePage({ x: 0, y: 0, width: 1000, height: 80 })).toPNG());
    assert.equal(detached.getOpacity(), 0, 'Dragged window gets out of the way of the destination preview');
    const previewStyle = await source.webContents.executeJavaScript(`(() => {
      const style = getComputedStyle(document.querySelector('[data-tab-drop-preview]'));
      return { border: style.borderTopColor, outline: style.outlineWidth };
    })()`);
    assert.equal(previewStyle.border, 'rgb(40, 150, 90)', 'Preview border follows the active theme');
    assert.equal(previewStyle.outline, '0px', 'Preview has no extra fixed-color outline');
    await move(85, rect.y);
    await delay(220);
    assert.equal(await source.webContents.executeJavaScript('window.previewAnimationCount'), 0, 'Preview movement stays immediate when animations are off');
    await move(rect.x, rect.y);
    await delay(220);
    await source.webContents.executeJavaScript(`
      const settings = JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}');
      localStorage.setItem('mira.settings.browser.v1', JSON.stringify({ ...settings, animationsEnabled: true }));
      window.dispatchEvent(new CustomEvent('mira:settings-changed'));
    `);
    await delay(50);

    await move(85, rect.y);
    await until(async () => await source.webContents.executeJavaScript(`document.querySelector('[data-tab-drop-preview]')?.nextElementSibling?.dataset.tabId === ${JSON.stringify(originalIds[0])}`), 'Moving across the strip changes the insertion preview');
    await until(async () => await source.webContents.executeJavaScript('window.previewAnimationCount > 0'), 'Preview movement uses the normal reorder animation when enabled');
    await move(rect.x, rect.y + 160);
    await until(async () => !await source.webContents.executeJavaScript(`!!document.querySelector('[data-tab-drop-preview]')`), 'Leaving the strip clears the preview');
    assert.equal(detached.getOpacity(), 1, 'Leaving the strip restores the dragged window');
    await move(rect.x, rect.y);
    await until(async () => await source.webContents.executeJavaScript(`!!document.querySelector('[data-tab-drop-preview]')`), 'Returning restores the preview');
    await input(source, { type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
    await until(() => detached.isDestroyed(), 'Dropping back closes the temporary window');
    await until(async () => JSON.stringify(await tabIds(source)) === JSON.stringify(originalIds), 'Original window has both tabs exactly once');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    console.log('PASS compact detach, continued dragging, focus changes, and drop back without duplicates');

    await source.webContents.executeJavaScript(`window.electron.ipcRenderer.invoke('window-new')`);
    await until(() => BrowserWindow.getAllWindows().length === 2, 'Another window opens');
    const single = BrowserWindow.getAllWindows().find(win => win.id !== source.id)!;
    await until(async () => (await tabIds(single)).length === 1, 'Single tab renders');
    single.unmaximize();
    single.setBounds({ x: 400, y: 300, width: 800, height: 600 });
    await delay(300);
    const singleId = (await tabIds(single))[0];
    const grab = await single.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-tab-id]').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await input(single, { type: 'mouseDown', ...grab, button: 'left', clickCount: 1 });
    cursor = { x: 400 + grab.x + 100, y: 300 + grab.y + 160 };
    await input(single, { type: 'mouseMove', x: grab.x + 100, y: grab.y + 160, modifiers: ['leftButtonDown'] });
    await until(() => single.getBounds().x === 500 && single.getBounds().y === 460, 'Single-tab window follows the tab');
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'No temporary window for a single tab');
    assert.equal(single.getBounds().width, 800, 'Restored window retains its size');
    const destination = source.getContentBounds();
    cursor = { x: destination.x + rect.x, y: destination.y + rect.y };
    await input(single, { type: 'mouseUp', ...grab, button: 'left', clickCount: 1 });
    await until(() => single.isDestroyed(), 'Moving the last tab into another window closes the empty window');
    await until(async () => (await tabIds(source)).includes(singleId), 'Tab joins the other window');
    assert.equal((await tabIds(source)).length, 3, 'Existing tabs survive the merge');
    console.log('PASS single-tab window moves intact and merges into another window');

    await source.webContents.executeJavaScript(`window.electron.ipcRenderer.invoke('window-new')`);
    await until(() => BrowserWindow.getAllWindows().length === 2, 'Maximized test window opens');
    const maximized = BrowserWindow.getAllWindows().find(win => win.id !== source.id)!;
    await until(async () => (await tabIds(maximized)).length === 1 && maximized.isMaximized(), 'Single-tab window starts maximized');
    await delay(250);
    const maxGrab = await maximized.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-tab-id]').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    maximized.focus();
    if (nativeInput) maximized.webContents.sendInputEvent({ type: 'mouseMove', ...maxGrab });
    else await input(maximized, { type: 'mouseMove', ...maxGrab });
    await delay(50);
    if (nativeInput) maximized.webContents.sendInputEvent({ type: 'mouseDown', ...maxGrab, button: 'left', clickCount: 1 });
    else await input(maximized, { type: 'mouseDown', ...maxGrab, button: 'left', clickCount: 1 });
    await delay(50);
    cursor = { x: 600, y: 400 };
    if (nativeInput) maximized.webContents.sendInputEvent({ type: 'mouseMove', x: maxGrab.x + 100, y: maxGrab.y + 160, modifiers: ['leftButtonDown'] });
    else await input(maximized, { type: 'mouseMove', x: maxGrab.x + 100, y: maxGrab.y + 160, modifiers: ['leftButtonDown'] });
    await until(() => !maximized.isMaximized() && maximized.getBounds().width <= 900, 'Dragging restores a maximized window to a compact size');
    const restored = maximized.getBounds();
    cursor = { x: cursor.x + 90, y: cursor.y + 60 };
    await until(() => maximized.getBounds().x === restored.x + 90 && maximized.getBounds().y === restored.y + 60, 'Restored window keeps following the drag');
    if (nativeInput) maximized.webContents.sendInputEvent({ type: 'mouseUp', ...maxGrab, button: 'left', clickCount: 1 });
    else await input(maximized, { type: 'mouseUp', ...maxGrab, button: 'left', clickCount: 1 });
    await delay(100);
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'Restoring keeps the same window');
    console.log('PASS dragging a maximized single-tab window restores it and continues moving');

    const fullscreenTabId = (await tabIds(maximized))[0];
    maximized.setFullScreen(true);
    await until(() => maximized.isFullScreen(), 'Native fullscreen starts');
    cursor = { x: 700, y: 500 };
    const fullscreenPayload = { tab: { id: fullscreenTabId, url: 'mira://NewTab', title: 'New Tab',
      history: ['mira://NewTab'], historyIndex: 0 }, dragMode: true, moveExistingWindow: true,
      windowPointerOffsetX: 100, windowPointerOffsetY: 18 };
    await maximized.webContents.executeJavaScript(`window.electron.ipcRenderer.invoke('window-detach-tab-to-new-window', ${JSON.stringify(fullscreenPayload)})`);
    await until(() => !maximized.isFullScreen() && !maximized.isMaximized() && maximized.getBounds().width <= 900, 'Native fullscreen exits before dragging');
    cursor = { x: 800, y: 600 };
    await until(() => maximized.getBounds().x === 700 && maximized.getBounds().y === 582, 'Fullscreen restore keeps the pointer anchor');
    await maximized.webContents.executeJavaScript(`window.electron.ipcRenderer.invoke('window-release-detached-tab-drag')`);
    console.log('PASS native fullscreen restoration and continued dragging');
    const existingIds = new Set(BrowserWindow.getAllWindows().map(win => win.id));
    await source.webContents.executeJavaScript(`window.electron.ipcRenderer.invoke('window-new')`);
    await until(() => BrowserWindow.getAllWindows().some(win => !existingIds.has(win.id)), 'Crowded-layout test window opens');
    const crowded = BrowserWindow.getAllWindows().find(win => !existingIds.has(win.id))!;
    await until(async () => (await tabIds(crowded)).length === 1, 'Crowded-layout shell renders');
    crowded.unmaximize();
    await until(() => !crowded.isMaximized(), 'Crowded-layout window restores');
    crowded.setBounds({ x: 200, y: 200, width: 640, height: 700 });
    await crowded.webContents.executeJavaScript(`for (let i = 0; i < 8; i++) document.querySelector('.tab-new-tab-btn').click();`);
    await until(async () => (await tabIds(crowded)).length === 9, 'Extra tabs create real overflow');
    await delay(300);
    await until(async () => await crowded.webContents.executeJavaScript(`(() => {
      const strip = document.querySelector('.tab-strip-scroll');
      return !!document.querySelector('.topbar-brand-hidden') && strip.scrollWidth > strip.clientWidth;
    })()`), 'Crowded tabs collapse the brand and overflow the strip');
    await crowded.webContents.executeJavaScript(`(() => {
      const strip = document.querySelector('.tab-strip-scroll'); strip.scrollLeft = 0;
      strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    })()`);
    await until(async () => await crowded.webContents.executeJavaScript(`document.querySelector('.tab-strip-scroll').scrollLeft > 0`), 'Wheel input scrolls crowded tabs');
    for (const scrollFraction of [0, 0.5, 1, 0]) {
      await crowded.webContents.executeJavaScript(`(() => { const strip = document.querySelector('.tab-strip-scroll'); strip.scrollLeft = (strip.scrollWidth - strip.clientWidth) * ${scrollFraction}; })()`);
      await delay(80);
      const logoDrag = await crowded.webContents.executeJavaScript(`(() => {
        const logo = document.querySelector('.topbar-brand img');
        const r = logo.getBoundingClientRect();
        const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const blockers = [...document.querySelectorAll('*')].filter(element => {
          if (getComputedStyle(element).webkitAppRegion !== 'no-drag') return false;
          const bounds = element.getBoundingClientRect();
          let left = bounds.left, right = bounds.right, top = bounds.top, bottom = bounds.bottom;
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
            if (style.overflowX !== 'visible') { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
            if (style.overflowY !== 'visible') { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
          }
          return x >= left && x < right && y >= top && y < bottom;
        }).map(element => element.className?.baseVal ?? element.className);
        return { region: getComputedStyle(logo.closest('.browser-topbar')).webkitAppRegion, draggable: logo.draggable, blockers };
      })()`);
      assert.equal(logoDrag.region, 'drag', 'Compact logo is a native drag region');
      assert.equal(logoDrag.draggable, false, 'Logo cannot start an image drag');
      assert.deepEqual(logoDrag.blockers, [], 'Overflowing tabs do not block the compact logo drag region');
    }
    crowded.destroy();
    console.log('PASS compact logo remains draggable at the start, middle, and end of overflowing tabs');
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
}
void run();
