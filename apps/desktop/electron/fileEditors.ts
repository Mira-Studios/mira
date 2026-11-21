import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { requestAppDialog } from './siteInteractions.ts';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isEditorUrl, MAX_EDITOR_BYTES } from './editorPolicy.ts'; 
import { atomicSaveText } from './atomicFileSave.ts'; 
import { readEditorImports } from './editorImports.ts';

type Document = { url: string; text: string; saved: string; bom: boolean };
const documents = new Map<number, Map<string, Document>>();
const loadVersions = new Map<number, Map<string, number>>();
const operations = new Map<string, Promise<boolean>>();
const saves = new Map<string, Promise<boolean>>();
function owner(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('Editor access requires the browser window.');
  return win;
}
function notify(win: BrowserWindow, id: string, doc: Document) {
  if (!win.isDestroyed()) win.webContents.send('editor-state', { id, dirty: doc.text !== doc.saved });
}
async function writeDocument(win: BrowserWindow, id: string, doc: Document): Promise<boolean> {
  try {
    const path = fileURLToPath(doc.url);
    const disk = await fs.readFile(path, 'utf8');
    const original = (doc.bom ? '\uFEFF' : '') + doc.saved;
    if (disk !== original) {
      const answer = await requestAppDialog(win, { tabId: id, title: 'This file changed on disk', message: 'Overwrite it with your changes?', confirmLabel: 'Overwrite' });
      if (!answer.accepted) return false;
    }
    const text = doc.text;
    await atomicSaveText(path, (doc.bom ? '\uFEFF' : '') + text, disk);
    doc.saved = text;
    notify(win, id, doc);
    return doc.text === doc.saved;
  } catch (error) {
    await requestAppDialog(win, { tabId: id, kind: 'alert', title: 'Could not save file', message: String(error) });
    return false;
  }
}
function save(win: BrowserWindow, id: string, doc: Document): Promise<boolean> {
  const key = `${win.id}:${id}`;
  const current = saves.get(key);
  if (current) return current;
  const pending = writeDocument(win, id, doc).finally(() => saves.delete(key));
  saves.set(key, pending);
  return pending;
}
async function check(win: BrowserWindow, id: string, action: string): Promise<boolean> {
  const doc = documents.get(win.webContents.id)?.get(id);
  if (!doc || doc.text === doc.saved) return true;
  const key = `${win.id}:${id}`;
  if (operations.has(key)) return operations.get(key)!;
  const operation = (async () => {
    const result = await requestAppDialog(win, { tabId: id, title: 'Save changes before you ' + action + '?', message: decodeURIComponent(new URL(doc.url).pathname), confirmLabel: 'Save', secondaryLabel: 'Don’t Save' });
    if (result.accepted) return save(win, id, doc);
    if (result.value !== 'secondary') return false;
    doc.text = doc.saved;
    win.webContents.send('editor-discard', { id, text: doc.saved });
    notify(win, id, doc);
    return true;
  })().finally(() => operations.delete(key));
  operations.set(key, operation);
  return operation;
}
export async function confirmEditorWindowClose(win: BrowserWindow): Promise<boolean> {
  for (const id of documents.get(win.webContents.id)?.keys() ?? []) if (!await check(win, id, 'close this window')) return false;
  return true;
}
export function setupFileEditors(): void {
  ipcMain.handle('editor-open', async (event, id: string, url: string) => {
    const win = owner(event);
    if (typeof id !== 'string' || !id || typeof url !== 'string' || !isEditorUrl(url)) throw new Error('Unsupported text file.');
    let versions = loadVersions.get(event.sender.id);
    if (!versions) {
      versions = new Map(); loadVersions.set(event.sender.id, versions);
      const ownerId = event.sender.id;
      event.sender.once('destroyed', () => { documents.delete(ownerId); loadVersions.delete(ownerId); });
    }
    const version = (versions.get(id) ?? 0) + 1;
    versions.set(id, version);
    const path = fileURLToPath(url);
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_EDITOR_BYTES) throw new Error('Only text files up to 16 MB can be edited.');
    const bytes = await fs.readFile(path);
    if (bytes.length > MAX_EDITOR_BYTES || bytes.includes(0)) throw new Error('This file is too large or contains binary data.');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const bom = text.startsWith('\uFEFF');
    const clean = bom ? text.slice(1) : text;
    if (win.isDestroyed() || loadVersions.get(event.sender.id)?.get(id) !== version) throw new Error('File opening was cancelled.');
    let entries = documents.get(event.sender.id);
    if (!entries) {
      entries = new Map(); documents.set(event.sender.id, entries);
    }
    const previous = entries.get(id);
    if (previous && previous.text !== previous.saved) throw new Error('Resolve unsaved changes before reloading.');
    const doc = { url, text: clean, saved: clean, bom };
    entries.set(id, doc); notify(win, id, doc);
    return { text: clean };
  });
  ipcMain.on('editor-change', (event, id: string, text: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof text !== 'string') return;
    const doc = documents.get(event.sender.id)?.get(id);
    if (doc) { doc.text = text; const win = BrowserWindow.fromWebContents(event.sender); if (win) notify(win, id, doc); }
  });
  ipcMain.handle('editor-save', async (event, id: string) => {
    const win = owner(event); const doc = documents.get(event.sender.id)?.get(id);
    return doc ? save(win, id, doc) : false;
  });
  ipcMain.handle('editor-imports', async (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return [];
    owner(event);
    const entries = documents.get(event.sender.id);
    const doc = entries?.get(id);
    return doc ? readEditorImports(doc.url, doc.text, [...entries!.values()]) : [];
  });
  ipcMain.handle('editor-check', (event, id: string, action: string) => check(owner(event), id, action));
  ipcMain.handle('editor-release', (event, id: string) => {
    owner(event);
    const versions = loadVersions.get(event.sender.id);
    if (versions) versions.set(id, (versions.get(id) ?? 0) + 1);
    const entries = documents.get(event.sender.id); const doc = entries?.get(id);
    if (doc && doc.text === doc.saved) entries!.delete(id);
  });
}
