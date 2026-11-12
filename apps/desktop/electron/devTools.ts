import { BrowserWindow, WebContentsView, ipcMain, type WebContents } from 'electron';

type DevToolsMode = 'left' | 'right' | 'bottom' | 'undocked' | 'detach';
type Entry = { target: WebContents; win: BrowserWindow; view: WebContentsView; close: () => void };
export type DevToolsDockState = { hostId: number; ids: number[] };

export function createDevToolsController() {
  const modes = new WeakMap<BrowserWindow, 'side' | 'window'>();
  const entries = new Map<WebContents, Entry>();
  const visible = new WeakMap<BrowserWindow, Entry>();
  const active = new WeakMap<BrowserWindow, number>();
  const state = (win: BrowserWindow): DevToolsDockState => ({
    hostId: win.webContents.id,
    ids: [...entries.values()].filter((entry) => entry.win === win).map((entry) => entry.target.id),
  });
  const notify = (win: BrowserWindow) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('devtools-dock-state', state(win));
    }
  };
  const show = (win: BrowserWindow, entry?: Entry) => {
    const previous = visible.get(win);
    if (previous) previous.view.setVisible(false);
    if (entry) {
      visible.set(win, entry);
      entry.view.setVisible(true);
    } else visible.delete(win);
    notify(win);
  };
  const setActive = (win: BrowserWindow, id: number) => {
    active.set(win, id);
    show(win, entries.get(win.webContents) ?? [...entries.values()].find(
      (entry) => entry.win === win && entry.target.id === id,
    ));
  };
  const isOpen = (target: WebContents) => entries.has(target) || target.isDevToolsOpened();
  const close = (target: WebContents) => {
    const entry = entries.get(target);
    target.closeDevTools();
    entry?.close();
  };

  return {
    isOpen,
    close,
    hasOpen: (win: BrowserWindow) => [...entries.values()].some((entry) => entry.win === win),
    setMode(win: BrowserWindow, value: unknown): boolean {
      if (value !== 'side' && value !== 'window') return false;
      modes.set(win, value);
      return true;
    },
    setActive,
    setupIpc() {
      const senderWindow = (sender: WebContents) => {
        const win = BrowserWindow.fromWebContents(sender);
        return win && !win.isDestroyed() && win.webContents === sender ? win : null;
      };
      ipcMain.handle('devtools-dock-get-state', (event) => {
        const win = senderWindow(event.sender);
        return win ? state(win) : null;
      });
      ipcMain.handle('devtools-dock-close', (event, id: unknown) => {
        const win = senderWindow(event.sender);
        const entry = [...entries.values()].find((item) => item.win === win && item.target.id === id);
        if (entry && !entry.target.isDestroyed()) close(entry.target);
      });
      ipcMain.handle('devtools-dock-set-bounds', (event, payload: unknown) => {
        const win = senderWindow(event.sender);
        const entry = win && visible.get(win);
        if (!entry || typeof payload !== 'object' || !payload) return false;
        const rect = payload as Record<string, unknown>;
        if (rect.webContentsId !== entry.target.id || ![rect.x, rect.y, rect.width, rect.height].every(
          (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
        )) return false;
        const [width, height] = entry.win.getContentSize();
        const x = Math.min(width, Math.round(rect.x as number));
        const y = Math.min(height, Math.round(rect.y as number));
        entry.view.setBounds({
          x, y,
          width: Math.min(width - x, Math.round(rect.width as number)),
          height: Math.min(height - y, Math.round(rect.height as number)),
        });
        return true;
      });
    },
    open(target: WebContents, win: BrowserWindow, options?: { mode?: DevToolsMode; activate?: boolean }): boolean {
      if (win.isDestroyed() || target.isDestroyed()) return false;
      if (isOpen(target)) return true;
      const mode = options?.mode ?? (modes.get(win) === 'window' ? 'detach' : 'right');
      if (mode !== 'right') {
        target.openDevTools({ mode, activate: options?.activate !== false });
        return true;
      }
      // Windows' title-bar overlay forces built-in docking to detach. A separate
      // view lets each tab retain its own DevTools while keeping native controls.
      const view = new WebContentsView({ webPreferences: {
        session: target.session, nodeIntegration: false, contextIsolation: true, sandbox: true,
      } });
      const cleanup = () => {
        if (!entries.has(target)) return;
        target.removeListener('devtools-closed', cleanup);
        target.removeListener('destroyed', cleanup);
        view.webContents.removeListener('destroyed', cleanup);
        entries.delete(target);
        if (!win.isDestroyed()) win.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close();
        if (visible.get(win) === entry) {
          visible.delete(win);
          if (!win.isDestroyed()) setActive(win, active.get(win) ?? -1);
        }
        notify(win);
      };
      const entry: Entry = { target, win, view, close: cleanup };
      try {
        entries.set(target, entry);
        win.contentView.addChildView(view);
        view.setVisible(false);
        target.once('devtools-closed', cleanup);
        target.once('destroyed', cleanup);
        view.webContents.once('destroyed', cleanup);
        target.setDevToolsWebContents(view.webContents);
        target.openDevTools({ mode: 'detach', activate: options?.activate !== false });
        show(win, entry);
        if (options?.activate !== false) view.webContents.focus();
        return true;
      } catch {
        cleanup();
        return false;
      }
    },
  };
}
