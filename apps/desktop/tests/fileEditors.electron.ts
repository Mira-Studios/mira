// Build the renderer, then run with Electron (ELECTRON_RUN_AS_NODE unset).
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setupFileEditors, confirmEditorWindowClose } from '../electron/fileEditors.ts';
import { setupSiteInteractions } from '../electron/siteInteractions.ts';
import { getAddressSuggestions } from '../src/features/history/addressSuggestions.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.resolve(root, '../../../.tmp');
mkdirSync(tempRoot, { recursive: true });
const profile = mkdtempSync(path.join(tempRoot, 'file-editors-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 90_000);
const file = path.join(profile, 'hello world.ts');
writeFileSync(file, '\uFEFFconst answer = 42;\r\n');
const url = pathToFileURL(file).href;
const tab = { id: 'editor-test', url, title: url, history: [url], historyIndex: 0, reloadToken: 0, isSleeping: false, lastActiveAt: Date.now() };
const visits: { title: string; url: string }[] = [];
ipcMain.handle('editor-test-call', (_event, channel: string, payload: unknown) => {
  if (channel === 'session-take-window-restore') return { tabs: [tab, { ...tab, id: 'blank', url: 'mira://NewTab', title: 'New Tab', history: ['mira://NewTab'] }], activeId: 'blank', savedAt: Date.now() };
  if (channel === 'history-add') { visits.push(payload as typeof visits[number]); return true; }
  if (channel === 'history-list') return visits;
  if (['recently-closed-get', 'incoming-urls-consume', 'device-connections-state', 'open-tabs-list'].includes(channel)) return [];
  if (channel === 'window-consume-initial-url') return '';
  return null;
});
async function until(check: () => Promise<boolean>, message: string) {
  const expires = Date.now() + 15000;
  while (!await check()) { assert.ok(Date.now() < expires, message); await delay(40); }
}
async function run() {
  await app.whenReady(); setupFileEditors(); setupSiteInteractions(contents => BrowserWindow.fromWebContents(contents));
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { preload: path.join(root, 'fixtures/editor-preload.cjs'), backgroundThrottling: false } });
  const evaluate = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const button = (label: string) => evaluate(`(() => { const label = ${JSON.stringify(label === 'Save' ? 'Save file' : label)}; const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label); button?.click(); return !!button; })()`);
  const ready = () => until(() => evaluate(`!!document.querySelector('iframe')?.contentDocument?.querySelector('.monaco-editor textarea')`), 'Monaco loads');
  const edit = async () => {
    await evaluate(`(() => { const doc = document.querySelector('iframe').contentDocument; const input = doc.querySelector('.native-edit-context, textarea.inputarea'); input.focus(); const data = new doc.defaultView.DataTransfer(); data.setData('text/plain', '// edited '); input.dispatchEvent(new doc.defaultView.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`);
    await until(() => evaluate(`!!document.querySelector('[aria-label="Unsaved changes"]')`), 'Dirty indicator appears');
  };
  const prompt = () => until(() => evaluate(`!!document.querySelector('[role="dialog"]')`), 'Unsaved changes dialog appears');
  const unload = async () => {
    win.webContents.send('tab-native-context-command', { command: 'unload-editor', tabId: 'editor-test' });
    await delay(260);
  };
  try {
    await win.loadFile(path.resolve(root, '../dist/index.html'));
    await until(() => evaluate(`!!document.querySelector('[data-tab-id="editor-test"]')`), 'Tabs restore');
    assert.equal(await evaluate(`!!document.querySelector('iframe')`), false, 'Background file does not load Monaco');
    await evaluate(`document.querySelector('[data-tab-id="editor-test"]').click()`); await ready();
    assert.equal(await evaluate(`!!document.querySelector('[data-tab-id="editor-test"] [aria-label="TypeScript file"]')`), true, 'Tab uses TypeScript file icon');
    assert.equal(await evaluate(`!document.querySelector('[data-editor-toolbar]') && !!document.querySelector('.address-field [aria-label="Save file"]')`), true, 'Save is inside the address bar');
    assert.equal(await evaluate(`document.querySelector('[aria-label="Show file path"]').textContent.includes('hello world.ts')`), true, 'Filename is shown in address bar');
    await button('Show file path');
    assert.equal(await evaluate(`document.activeElement.value`), file, 'Clicking filename reveals native path');
    await evaluate(`document.activeElement.blur()`);
    assert.equal(await evaluate(`!!document.querySelector('iframe').contentDocument.querySelector('.minimap')`), true, 'Minimap is enabled');
    await delay(350);
    writeFileSync(path.resolve(tempRoot, 'editor-preview.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.send('app-shortcut', 'find-in-page');
    await until(() => evaluate(`!!document.querySelector('input[placeholder="Find in page"]')`), 'Find bar opens');
    await evaluate(`(() => { const input = document.querySelector('input[placeholder="Find in page"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'answer'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => evaluate(`document.querySelector('[aria-live="polite"]')?.textContent === '1/1' && !!document.querySelector('iframe').contentDocument.querySelector('.mira-find-active')`), 'Find highlights editor text and reports matches');
    await button('Close find');
    assert.equal(visits.at(-1)?.url, url, 'File enters history');
    assert.ok(getAddressSuggestions('hello', [], visits).some(s => s.kind === 'history' && s.value === url), 'File appears in suggestions');
    await edit(); await button('Reload'); await prompt(); await button('Cancel');
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Unsaved changes"]')`), true, 'Cancel keeps changes');
    await evaluate(`document.querySelector('[aria-label="Unsaved changes"]').click()`);
    assert.equal(readFileSync(file, 'utf8'), '\uFEFFconst answer = 42;\r\n', 'Dot does not save');
    assert.equal(await evaluate(`(() => { const outer = document.querySelector('[aria-label="Unsaved changes"]'); const a = outer.getBoundingClientRect(); const b = outer.firstElementChild.getBoundingClientRect(); return outer.tagName === 'SPAN' && Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 1 && Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) < 1; })()`), true, 'Passive dot is centered');
    await button('Save');
    await until(() => evaluate(`!document.querySelector('[aria-label="Unsaved changes"]')`), 'Save clears indicator');
    assert.ok(readFileSync(file, 'utf8').startsWith('\uFEFF') && readFileSync(file, 'utf8').includes('// edited '), 'Save writes text and preserves BOM');
    assert.ok(readFileSync(file, 'utf8').includes('\r\n'), 'Save preserves CRLF');
    assert.equal(await button('Unload editor'), false, 'No unload toolbar button');
    await edit(); await unload(); await prompt(); await button('Cancel');
    assert.equal(await evaluate(`!!document.querySelector('iframe')`), true, 'Cancelled unload keeps editor');
    await unload(); await prompt(); await button('Don’t Save');
    await until(() => evaluate(`!document.querySelector('iframe')`), 'Unload destroys Monaco frame');
    await delay(200); assert.equal(await evaluate(`!!document.querySelector('iframe')`), false, 'Editor stays unloaded');
    await button('Load editor'); await ready(); await edit();
    const close = confirmEditorWindowClose(win); await prompt(); await button('Cancel');
    assert.equal(await close, false, 'Window close cancelled');
    await button('Reload'); await prompt(); await button('Don’t Save'); await ready();
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Unsaved changes"]')`), false, 'Discard and reload clears indicator');
    writeFileSync(file, 'external change'); await edit(); await button('Save'); await prompt(); await button('Cancel');
    assert.equal(readFileSync(file, 'utf8'), 'external change', 'External edit is protected');
    await evaluate(`document.querySelector('[data-tab-id="editor-test"] [aria-label="Close tab"]').click()`);
    await prompt(); await button('Cancel');
    assert.equal(await evaluate(`!!document.querySelector('[data-tab-id="editor-test"]')`), true, 'Cancelled close retains tab');
    await evaluate(`document.querySelector('[data-tab-id="editor-test"] [aria-label="Close tab"]').click()`);
    await prompt(); await button('Don’t Save');
    await until(() => evaluate(`!document.querySelector('[data-tab-id="editor-test"]')`), 'Discard closes tab');
    const importsFile = path.join(profile, 'imports.ts');
    writeFileSync(importsFile, `import { importedAnswer } from './dependency';\nconsole.log(importedAnswer);`);
    writeFileSync(path.join(profile, 'dependency.ts'), 'export const importedAnswer = 42;');
    win.webContents.send('open-url-in-new-tab', pathToFileURL(importsFile).href);
    await ready();
    await delay(600);
    win.webContents.send('app-shortcut', 'find-in-page');
    await until(() => evaluate(`!!document.querySelector('input[placeholder="Find in page"]')`), 'Find opens for imported code');
    await evaluate(`(() => { const input = document.querySelector('input[placeholder="Find in page"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'importedAnswer'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => evaluate(`document.querySelector('[aria-live="polite"]')?.textContent === '1/2'`), 'Find sees both imported symbols');
    await button('Close find');
    await evaluate(`(() => { const doc = document.querySelector('iframe').contentDocument; const input = doc.querySelector('.native-edit-context, textarea.inputarea'); input.focus(); input.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'F12', code: 'F12', keyCode: 123, bubbles: true, cancelable: true })); })()`);
    await until(() => evaluate(`[...document.querySelectorAll('.tab-title')].some(node => node.textContent === 'dependency.ts')`), 'Go to Definition opens the imported file in a tab');
    console.log('PASS: lazy Monaco frame, history/suggestions, passive centered dot, address-bar filename/save/path, minimap, Find, import definitions, atomic save/BOM/CRLF, reload/cancel/discard, unload/reload, tab/window close, external conflicts');
  } finally { win.destroy(); clearTimeout(deadline); }
}
run().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
