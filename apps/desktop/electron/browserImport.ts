import { app, BrowserWindow, dialog, ipcMain, nativeImage, type WebContents } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { IMPORT_BROWSERS, type DetectedBrowser, type ImportedVisit, type BatchImportResult } from './browserImportPolicy.ts';
import { browserImportRoots, profilesAt, readBrowserSource, readProfileAvatar, exists } from './browserImportReader.ts';
import { createImportedProfile } from './browserImportProfile.ts';
import type { ProfileStore } from './profileStore.ts';
type Source = Parameters<typeof readBrowserSource>[0];

export function setupBrowserImport(options: { eligible: (sender: WebContents) => boolean; importHistory: (entries: ImportedVisit[]) => Promise<number>; changed: () => void; profiles: ProfileStore }) {
  const sources = new Map<string, Source>();
  const avatarImages = new Map<string, Buffer>();
  const avatarFor = async (source: Source) => {
    const buffer = await readProfileAvatar(source);
    if (!buffer) return;
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return;
    const { width, height } = image.getSize(); const side = Math.min(width, height);
    const cropped = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }).resize({ width: 128, height: 128 });
    avatarImages.set(source.directory, cropped.toPNG());
    return cropped.toDataURL();
  };
  const sourceIds = new Map<string, string>();
  const register = (source: Source) => {
    const id = sourceIds.get(source.directory) || randomUUID();
    sourceIds.set(source.directory, id); sources.set(id, source); return id;
  };
  const created = new Map<string, BatchImportResult['profiles'][number]>();
  let importing = false;
  const trusted = (sender: WebContents) => {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.webContents !== sender || !options.eligible(sender)) throw new Error('Import browser data in a regular profile window.');
    return win;
  };
  ipcMain.handle('browser-import-detect', async event => {
    trusted(event.sender);
    const home = app.getPath('home');
    const roaming = app.getPath('appData');
    const roots = browserImportRoots(process.platform, home, roaming, process.env.LOCALAPPDATA || path.resolve(roaming, '../Local'));
    const browsers: DetectedBrowser[] = [];
    for (const browser of IMPORT_BROWSERS) {
      const profiles: DetectedBrowser['profiles'] = [];
      let installed = false;
      const seen = new Set<string>();
      for (const root of roots[browser.id]) {
        if (await exists(root)) installed = true;
        for (const source of await profilesAt(root, browser.id === 'firefox')) {
          if (seen.has(source.directory)) continue;
          seen.add(source.directory);
          const id = register({ ...source, browser: browser.name });
          profiles.push({ id, name: source.name, bookmarks: source.bookmarks, history: source.history, avatar: await avatarFor(source) });
        }
      }
      browsers.push({ ...browser, installed, profiles });
    }
    return browsers;
  });
  ipcMain.handle('browser-import-choose-profile', async event => {
    const win = trusted(event.sender);
    const selected = await dialog.showOpenDialog(win, { title: 'Choose browser profile folder', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const directory = selected.filePaths[0];
    const firefox = await exists(path.join(directory, 'places.sqlite'));
    const bookmarks = await exists(path.join(directory, firefox ? 'places.sqlite' : 'Bookmarks'));
    const history = await exists(path.join(directory, firefox ? 'places.sqlite' : 'History'));
    if (!bookmarks && !history) throw new Error('Choose a profile folder containing Bookmarks, History, or places.sqlite.');
    const name = path.basename(directory);
    const id = register({ directory, firefox, bookmarks, history, name, browser: 'Selected browser' });
    return { id, name, bookmarks, history, avatar: await avatarFor(sources.get(id)!) };
  });
  const seedFile = path.join(app.getPath('userData'), 'browser-import-bookmarks.v1.json');
  ipcMain.on('browser-import-bookmarks-bootstrap', event => {
    if (!options.eligible(event.sender)) { event.returnValue = null; return; }
    try { event.returnValue = JSON.parse(fs.readFileSync(seedFile, 'utf8')); }
    catch (error) { event.returnValue = null; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not read imported bookmarks:', error); }
  });
  ipcMain.on('browser-import-bookmarks-applied', (event, id: unknown) => {
    if (!options.eligible(event.sender)) return;
    try {
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      if (typeof id === 'string' && seed.id === id) fs.unlinkSync(seedFile);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not finish imported bookmarks:', error); }
  });
  ipcMain.handle('browser-import-batch', async (event, input: { ids?: unknown; mode?: unknown; bookmarks?: unknown; history?: unknown } = {}): Promise<BatchImportResult> => {
    trusted(event.sender);
    if (importing) throw new Error('An import is already running.');
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 50 || input.ids.some(id => typeof id !== 'string' || !sources.has(id))) throw new Error('Select browser profiles to import.');
    if (input.mode !== 'merge' && input.mode !== 'profiles') throw new Error('Choose where to import.');
    const bookmarks = input.bookmarks === true; const history = input.history === true;
    if (!bookmarks && !history) throw new Error('Select bookmarks or browsing history.');
    importing = true;
    try {
      // Read every selected source first; locked or unreadable browsers never create empty profiles.
      const prepared = [];
      for (const id of new Set(input.ids as string[])) {
        const source = sources.get(id)!;
        if (!(bookmarks && source.bookmarks) && !(history && source.history)) throw new Error(`${source.name} has no data of the selected types.`);
        try {
          const data = await readBrowserSource(source, { bookmarks, history });
          prepared.push({ id, source, data, label: `${source.browser} · ${source.name}` });
        } catch { throw new Error(`Could not read ${source.browser} (${source.name}). Close that browser and try again.`); }
      }
      const result: BatchImportResult = { groups: [], historyCount: 0, profiles: [], failures: [] };
      if (input.mode === 'merge') {
        result.groups = prepared.map(item => ({ source: item.label, bookmarks: item.data.bookmarks }));
        result.historyCount = await options.importHistory(prepared.flatMap(item => item.data.history));
        if (result.historyCount) options.changed();
      } else {
        for (const item of prepared) {
          const key = JSON.stringify([item.source.directory, bookmarks, history]);
          try {
            let profile = created.get(key);
            if (!profile) {
              const imported = createImportedProfile(options.profiles, item.label, item.data, avatarImages.get(item.source.directory));
              profile = { ...imported.profile, sourceId: item.id, bookmarkCount: imported.bookmarkCount, historyCount: imported.historyCount };
              created.set(key, profile);
            }
            result.profiles.push(profile);
          } catch (error) { result.failures.push({ sourceId: item.id, message: `${item.label}: ${error instanceof Error ? error.message : 'Could not create the Mira profile.'}` }); }
        }
      }
      return result;
    } finally { importing = false; }
  });
  ipcMain.handle('browser-import-read', async (event, raw: unknown) => {
    trusted(event.sender);
    const input = raw as { id?: string; bookmarks?: boolean; history?: boolean };
    const source = input && sources.get(input.id || '');
    if (!source) throw new Error('Select a browser profile to import.');
    if (!input.bookmarks && !input.history) throw new Error('Select bookmarks or browsing history.');
    let data: Awaited<ReturnType<typeof readBrowserSource>>;
    try { data = await readBrowserSource(source, { bookmarks: input.bookmarks === true, history: input.history === true }); }
    catch { throw new Error('Could not read this browser profile. Close that browser and try again.'); }
    const historyCount = input.history ? await options.importHistory(data.history) : 0;
    if (historyCount) options.changed();
    return { bookmarks: data.bookmarks, historyCount, source: source.browser };
  });
}

