import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { OpenTabsRegistry } from './openTabs.ts';

export function setupOpenTabHandlers(options: {
  scope: (win: BrowserWindow) => string | null;
  ready: (win: BrowserWindow) => boolean;
}) {
  const registry = new OpenTabsRegistry();
  const pendingActivation = new Map<number, string>();
  let nextActivationId = 0;
  const activations = new Map<string, {
    sourceWindowId: number; windowId: number; tabId: string;
    resolve: (activated: boolean) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  const finish = (requestId: string, activated: boolean) => {
    const request = activations.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    activations.delete(requestId);
    if (pendingActivation.get(request.windowId) === requestId) pendingActivation.delete(request.windowId);
    request.resolve(activated);
  };
  const source = (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() && event.sender === win.webContents ? win : null;
  };
  const notify = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed() && options.scope(win) !== null)
        win.webContents.send('open-tabs-changed');
    }
  };
  app.on('browser-window-created', (_event, win) => {
    win.once('closed', () => {
      pendingActivation.delete(win.id);
      for (const [id, request] of activations) {
        if (request.windowId === win.id || request.sourceWindowId === win.id) finish(id, false);
      }
      if (registry.remove(win.id)) notify();
    });
  });
  ipcMain.handle('open-tabs-update', (event, value: unknown) => {
    const win = source(event);
    const scope = win && options.scope(win);
    if (!win || scope === null) return false;
    if (registry.update(win.id, scope, value)) notify();
    const requestId = pendingActivation.get(win.id);
    const request = requestId && activations.get(requestId);
    if (request && registry.has(win.id, scope, request.tabId)) {
      pendingActivation.delete(win.id);
      win.webContents.send('open-tab-activate', { requestId, tabId: request.tabId });
    }
    return true;
  });
  ipcMain.handle('open-tabs-list', event => {
    const win = source(event);
    const scope = win && options.scope(win);
    return win && scope !== null ? registry.list(win.id, scope) : [];
  });
  ipcMain.handle('open-tabs-activation-result', (event, payload: unknown) => {
    const win = source(event);
    if (!win || !payload || typeof payload !== 'object') return false;
    const { requestId, activated } = payload as { requestId?: unknown; activated?: unknown };
    if (typeof requestId !== 'string') return false;
    const request = activations.get(requestId);
    if (!request || request.windowId !== win.id) return false;
    finish(requestId, activated === true);
    return true;
  });
  ipcMain.handle('open-tabs-activate', (event, payload: unknown) => {
    const win = source(event);
    const scope = win && options.scope(win);
    if (!win || scope === null || !payload || typeof payload !== 'object') return false;
    const { windowId, tabId } = payload as { windowId?: unknown; tabId?: unknown };
    if (typeof windowId !== 'number' || typeof tabId !== 'string' || !registry.has(windowId, scope, tabId)) return false;
    const target = BrowserWindow.fromId(windowId);
    if (!target || target.isDestroyed() || target.webContents.isDestroyed() || options.scope(target) !== scope) return false;
    const previous = pendingActivation.get(windowId);
    if (previous) finish(previous, false);
    const requestId = String(++nextActivationId);
    const result = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => finish(requestId, false), 15_000);
      timer.unref?.();
      activations.set(requestId, { sourceWindowId: win.id, windowId, tabId, resolve, timer });
    });
    // Only acknowledge success once the destination renderer selected the tab.
    if (options.ready(target)) target.webContents.send('open-tab-activate', { requestId, tabId });
    else pendingActivation.set(windowId, requestId);
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    return result;
  });
}
