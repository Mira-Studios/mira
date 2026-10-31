import { app, BrowserWindow, ipcMain, webContents, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';

type Kind = 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'passkey';
type Answer = { accepted: boolean; value?: string };
type Pending = {
  source: WebContents; hostId: number; kind: Kind; clientId?: string;
  payload: Record<string, unknown>;
  reply: (answer: Answer) => void;
};
const pending = new Map<string, Pending>();
const unloadDecisions = new Map<number, 'allow' | 'stay'>();
const allowedWindows = new Set<number>();
const closingWindows = new Map<number, Promise<boolean>>();
let resolveWindow: (contents: WebContents) => BrowserWindow | null;

function hostFor(contents: WebContents): BrowserWindow | null {
  let host = resolveWindow?.(contents) ?? BrowserWindow.fromWebContents(contents);
  while (host?.getParentWindow()) host = host.getParentWindow();
  return host;
}

function finish(id: string, answer: Answer): void {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  try { request.reply(answer); } catch { /* The requesting frame may have navigated. */ }
  const host = BrowserWindow.fromId(request.hostId);
  if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.send('site-interaction-cancel', id);
}

function cancelFor(contents: WebContents): void {
  for (const [id, request] of pending) if (request.source === contents) finish(id, { accepted: false });
}

function ask(source: WebContents, kind: Kind, data: Record<string, unknown>, reply: Pending['reply']): void {
  const host = hostFor(source);
  if (!host || host.isDestroyed() || host.webContents.isDestroyed()) { reply({ accepted: false }); return; }
  if (kind === 'passkey') {
    for (const [id, request] of pending) {
      if (request.source === source && request.kind === 'passkey') finish(id, { accepted: false });
    }
  }
  const requestId = randomUUID();
  const clientId = typeof data.clientId === 'string' ? data.clientId.slice(0, 100) : undefined;
  let site = 'This page';
  try { site = new URL(typeof data.url === 'string' ? data.url : source.getURL()).hostname || site; } catch { /* Local page. */ }
  const payload = {
    requestId, kind, webContentsId: source.id, site,
    message: typeof data.message === 'string' ? data.message.slice(0, 4000) : '',
    defaultValue: typeof data.defaultValue === 'string' ? data.defaultValue.slice(0, 4000) : '',
    intent: data.intent === 'create' ? 'create' : 'get',
  };
  pending.set(requestId, { source, hostId: host.id, kind, reply, clientId, payload });
  host.webContents.send('site-interaction-request', payload);
}

export function consumeUnloadDecision(contents: WebContents): 'allow' | 'stay' | undefined {
  const decision = unloadDecisions.get(contents.id);
  unloadDecisions.delete(contents.id);
  return decision;
}

export async function confirmContentsClose(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return true;
  try {
    for (const frame of contents.mainFrame.framesInSubtree) {
      if (frame.detached) continue;
      const result = await frame.executeJavaScript(`(() => {
      if (window.__miraSiteInteractions) return window.__miraSiteInteractions.checkBeforeUnload();
      const event = new Event('beforeunload', {cancelable:true});
      let requested = false;
      Object.defineProperty(event, 'returnValue', {get:()=>'', set:()=>{requested=true;}});
      const handler = window.onbeforeunload;
      window.onbeforeunload = null;
      try {
        window.dispatchEvent(event);
        const value = handler?.call(window, event);
        return requested || event.defaultPrevented || (value !== undefined && value !== null) ? 'ask' : true;
      } finally { window.onbeforeunload = handler; }
    })()`);
      if (result === 'ask') {
        const accepted = await new Promise<boolean>((resolve) => ask(contents, 'beforeunload', { url: frame.url }, (answer) => resolve(answer.accepted)));
        if (!accepted) return false;
      } else if (result !== true) return false;
    }
    return true;
  } catch {
    // A crashed/uninitialized page has no live document state to lose.
    return contents.isDestroyed() || !contents.getURL() || contents.isCrashed();
  }
}

export async function allowContentsClose(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;
  unloadDecisions.set(contents.id, 'allow');
  await contents.executeJavaScript('window.__miraSiteInteractions?.allowNextUnload()').catch(() => undefined);
}

function windowGuests(win: BrowserWindow): WebContents[] {
  return webContents.getAllWebContents().filter((contents) =>
    contents !== win.webContents && !contents.isDestroyed() && hostFor(contents)?.id === win.id);
}

export async function allowWindowClose(win: BrowserWindow): Promise<void> {
  for (const contents of windowGuests(win)) await allowContentsClose(contents);
}

export async function confirmWindowClose(win: BrowserWindow, commit = true): Promise<boolean> {
  const guests = windowGuests(win);
  for (const contents of guests) {
    if (!await confirmContentsClose(contents)) return false;
    if (win.isDestroyed()) return true;
  }
  if (commit) for (const contents of guests) await allowContentsClose(contents);
  return true;
}

export function canCloseWindow(win: BrowserWindow): boolean { return allowedWindows.has(win.id); }
export function markWindowCloseAllowed(win: BrowserWindow): void { allowedWindows.add(win.id); }

export function requestWindowClose(win: BrowserWindow): Promise<boolean> {
  const current = closingWindows.get(win.id);
  if (current) return current;
  const closing = (async () => {
    if (!await confirmWindowClose(win)) return false;
    if (!win.isDestroyed()) { allowedWindows.add(win.id); win.close(); }
    return true;
  })().finally(() => closingWindows.delete(win.id));
  closingWindows.set(win.id, closing);
  return closing;
}

export function setupSiteInteractions(getWindow: typeof resolveWindow): void {
  resolveWindow = getWindow;
  ipcMain.handle('site-interactions-ready', (event) => {
    const hostId = BrowserWindow.fromWebContents(event.sender)?.id;
    for (const request of pending.values()) {
      if (request.hostId === hostId) event.sender.send('site-interaction-request', request.payload);
    }
  });
  ipcMain.on('webview-site-dialog-sync', (event, raw: unknown) => {
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const kind = data.type as Kind;
    if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(kind)) { event.returnValue = null; return; }
    ask(event.sender, kind, { ...data, url: event.senderFrame?.url }, (answer) => {
      if (kind === 'beforeunload' && data.trusted === true && !answer.accepted) unloadDecisions.set(event.sender.id, 'stay');
      event.returnValue = kind === 'prompt' ? (answer.accepted ? answer.value ?? '' : null) : answer.accepted;
    });
  });
  ipcMain.handle('webview-passkey-request', (event, raw: unknown) => {
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (typeof data.clientId !== 'string') return false;
    return new Promise<boolean>((resolve) => ask(event.sender, 'passkey', { ...data, url: event.senderFrame?.url }, (answer) => resolve(answer.accepted)));
  });
  ipcMain.on('webview-passkey-cancel', (event, clientId: unknown) => {
    for (const [id, request] of pending) {
      if (request.source === event.sender && request.kind === 'passkey' && request.clientId === clientId) finish(id, { accepted: false });
    }
  });
  ipcMain.handle('site-interaction-respond', (event, raw: unknown) => {
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const id = typeof data.requestId === 'string' ? data.requestId : '';
    const request = pending.get(id);
    if (!request || BrowserWindow.fromWebContents(event.sender)?.id !== request.hostId) return false;
    finish(id, { accepted: data.accepted === true, value: typeof data.value === 'string' ? data.value : undefined });
    return true;
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { cancelFor(contents); unloadDecisions.delete(contents.id); }
    });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) cancelFor(contents); });
    contents.once('destroyed', () => { cancelFor(contents); unloadDecisions.delete(contents.id); });
    contents.on('render-process-gone', () => cancelFor(contents));
  });
  app.on('browser-window-created', (_event, win) => win.once('closed', () => {
    allowedWindows.delete(win.id);
    for (const [id, request] of pending) if (request.hostId === win.id) finish(id, { accepted: false });
  }));
}
