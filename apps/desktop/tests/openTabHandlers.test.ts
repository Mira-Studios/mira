import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../electron/openTabHandlers.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['electron'],
});

function fixture() {
  const app = new EventEmitter();
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const windows = new Map<number, FakeWindow>();
  class FakeWindow extends EventEmitter {
    id: number;
    scope: string;
    ready = true;
    minimized = false;
    destroyed = false;
    sent: unknown[][] = [];
    calls: string[] = [];
    webContents = {
      isDestroyed: () => this.destroyed,
      send: (...args: unknown[]) => { this.sent.push(args); },
    };
    constructor(id: number, scope = 'regular') {
      super(); this.id = id; this.scope = scope;
      windows.set(id, this);
      app.emit('browser-window-created', undefined, this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.calls.push('restore'); this.minimized = false; }
    show() { this.calls.push('show'); }
    focus() { this.calls.push('focus'); }
    static fromWebContents(contents: unknown) { return [...windows.values()].find(win => win.webContents === contents); }
    static fromId(id: number) { return windows.get(id); }
    static getAllWindows() { return [...windows.values()].filter(win => !win.destroyed); }
  }
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, setTimeout, clearTimeout,
    require: () => ({ app, BrowserWindow: FakeWindow, ipcMain: {
      handle: (name: string, handler: (event: unknown, payload?: unknown) => unknown) => handlers.set(name, handler),
    } }),
  });
  (module.exports as { setupOpenTabHandlers: (options: unknown) => void }).setupOpenTabHandlers({
    scope: (win: FakeWindow) => win.scope,
    ready: (win: FakeWindow) => win.ready,
  });
  const invoke = (win: FakeWindow, channel: string, payload?: unknown) => handlers.get(channel)!({ sender: win.webContents }, payload);
  const source = new FakeWindow(1);
  const target = new FakeWindow(2);
  const tab = { id: 'target-tab', title: 'Example', url: 'https://example.com/' };
  invoke(target, 'open-tabs-update', [tab]);
  return { FakeWindow, invoke, source, target, tab };
}

test('confirms success only after the destination tab is activated', async () => {
  const { invoke, source, target } = fixture();
  target.minimized = true;
  const activation = invoke(source, 'open-tabs-activate', { windowId: target.id, tabId: 'target-tab' });
  let confirmed = false;
  void Promise.resolve(activation).then(() => { confirmed = true; });
  await Promise.resolve();
  assert.equal(confirmed, false);
  assert.deepEqual(target.calls, ['restore', 'show', 'focus']);
  const request = target.sent.find(args => args[0] === 'open-tab-activate')![1] as { requestId: string; tabId: string };
  assert.equal(request.tabId, 'target-tab');
  assert.equal(invoke(source, 'open-tabs-activation-result', { ...request, activated: true }), false);
  invoke(target, 'open-tabs-activation-result', { ...request, activated: true });
  assert.equal(await activation, true);
});

test('defers success until a suspended shell restores and confirms activation', async () => {
  const { invoke, source, target, tab } = fixture();
  target.ready = false;
  target.minimized = true;
  const activation = invoke(source, 'open-tabs-activate', { windowId: target.id, tabId: tab.id });
  assert.equal(target.sent.some(args => args[0] === 'open-tab-activate'), false);
  target.ready = true;
  invoke(target, 'open-tabs-update', [tab]);
  assert.equal(target.sent.filter(args => args[0] === 'open-tab-activate').length, 1);
  const request = target.sent.find(args => args[0] === 'open-tab-activate')![1] as { requestId: string };
  invoke(target, 'open-tabs-activation-result', { ...request, activated: true });
  assert.equal(await activation, true);
  invoke(target, 'open-tabs-update', [tab]);
  assert.equal(target.sent.filter(args => args[0] === 'open-tab-activate').length, 1);
});

test('failed activation and a destination closing never report success', async () => {
  const { invoke, source, target, tab } = fixture();
  const rejected = invoke(source, 'open-tabs-activate', { windowId: target.id, tabId: tab.id });
  const request = target.sent.find(args => args[0] === 'open-tab-activate')![1] as { requestId: string };
  invoke(target, 'open-tabs-activation-result', { ...request, activated: false });
  assert.equal(await rejected, false);
  const closed = invoke(source, 'open-tabs-activate', { windowId: target.id, tabId: tab.id });
  target.destroyed = true;
  target.emit('closed');
  assert.equal(await closed, false);
});

test('rejects stale tabs, closed windows, and cross-session activation', () => {
  const { FakeWindow, invoke, source, target, tab } = fixture();
  const privateWindow = new FakeWindow(3, 'private-partition');
  invoke(privateWindow, 'open-tabs-update', [tab]);
  assert.equal(invoke(source, 'open-tabs-activate', { windowId: privateWindow.id, tabId: tab.id }), false);
  assert.equal(invoke(source, 'open-tabs-activate', { windowId: target.id, tabId: 'closed-tab' }), false);
  target.destroyed = true;
  target.emit('closed');
  assert.equal((invoke(source, 'open-tabs-list') as unknown[]).length, 0);
  assert.equal(invoke(source, 'open-tabs-activate', { windowId: target.id, tabId: tab.id }), false);
});
