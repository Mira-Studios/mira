import { app, BrowserWindow, ipcMain, webContents, type WebContents } from 'electron';
import { nextPageZoom, type PageZoomAction } from './pageZoomPolicy.ts';

export function setupPageZoom(
  getHostWindow: (source: WebContents) => BrowserWindow | null,
  getActiveContents: (host: BrowserWindow) => WebContents | undefined,
): void {
  const hostFor = (source: WebContents): BrowserWindow | null => {
    let host = getHostWindow(source);
    while (host?.getParentWindow()) host = host.getParentWindow();
    return host;
  };
  const publish = (source: WebContents, showPopup = false) => {
    if (source.isDestroyed()) return;
    const host = hostFor(source);
    if (host && !host.isDestroyed() && !host.webContents.isDestroyed())
      host.webContents.send('page-zoom-changed', {
        webContentsId: source.id,
        factor: source.getZoomFactor(),
        showPopup,
      });
  };
  const change = (source: WebContents, action: PageZoomAction) => {
    if (source.isDestroyed()) return null;
    const factor = nextPageZoom(source.getZoomFactor(), action);
    source.setZoomFactor(factor);
    publish(source, true);
    // Chromium shares site zoom across pages of the same origin.
    for (const other of webContents.getAllWebContents()) {
      if (other !== source && other.getType() === 'webview' && !other.isDestroyed()) publish(other);
    }
    return factor;
  };
  const authorized = (sender: WebContents, id: unknown): WebContents | null => {
    if (typeof id !== 'number' || !Number.isInteger(id)) return null;
    const target = webContents.fromId(id);
    return target &&
      !target.isDestroyed() &&
      target !== sender &&
      hostFor(target)?.webContents.id === sender.id
      ? target
      : null;
  };
  const wheelTarget = (contents: WebContents): WebContents | null => {
    if (contents.getType() === 'webview') return contents;
    const host = getHostWindow(contents);
    const active = host && getActiveContents(host);
    if (active && !active.isDestroyed()) return active;
    return host?.getParentWindow() ? contents : null;
  };
  ipcMain.on('page-zoom-wheel', (event, direction: unknown) => {
    if (direction !== 'in' && direction !== 'out') return;
    const target = wheelTarget(event.sender);
    if (target) change(target, direction);
  });
  ipcMain.on('page-zoom-dismiss', (event) => {
    if (event.sender.getType() !== 'webview') return;
    const host = hostFor(event.sender);
    if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.send('page-zoom-dismiss', event.sender.id);
  });
  ipcMain.handle(
    'page-zoom-get',
    (event, id: unknown) => authorized(event.sender, id)?.getZoomFactor() ?? null,
  );
  ipcMain.handle('page-zoom-change', (event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload as { webContentsId?: number; action?: PageZoomAction };
    if (!['in', 'out', 'reset'].includes(data.action ?? '')) return null;
    const target = authorized(event.sender, data.webContentsId);
    return target ? change(target, data.action!) : null;
  });
  app.on('web-contents-created', (_event, contents) => {
    if (!['webview', 'window'].includes(contents.getType())) return;
    contents.on('zoom-changed', (_event, direction) => {
      const target = wheelTarget(contents);
      if (target) change(target, direction);
    });
    if (contents.getType() !== 'webview') return;
    contents.on('dom-ready', () => publish(contents));
    contents.on('did-navigate', () => publish(contents));
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown') return;
      const host = hostFor(contents);
      if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.send('page-zoom-dismiss', contents.id);
    });
  });
}
