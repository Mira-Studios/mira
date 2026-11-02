import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  session,
  shell,
  webContents,
  type WebContents,
} from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canCloseWindow, requestWindowClose } from './siteInteractions.ts';
import {
  isWebAppUrl,
  isWithinWebAppScope,
  parseWebAppManifest,
  webAppLauncherLabel,
  WEB_APP_TITLEBAR_HEIGHT,
  type InstalledWebApp,
  type WebApp,
  type WebAppResult,
  type WebAppState,
} from './webAppPolicy.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
const installed = new Map<string, InstalledWebApp>();
const windows = new Map<number, string>();
const candidates = new Map<number, WebApp>();
const generations = new Map<number, number>();
const pendingInstalls = new Set<string>();
const appKey = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);
const root = () => path.join(app.getPath('userData'), 'web-apps');
let persistQueue = Promise.resolve();

export const isWebAppWindow = (id: number): boolean => windows.has(id);

// This runs in an isolated world: a site cannot replace fetch or supply privileged URLs.
const manifestScript = `(${async function () {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="manifest"]');
  if (!link?.href) return null;
  try {
    const response = await fetch(link.href, {
      credentials: link.crossOrigin === 'use-credentials' ? 'include' : 'same-origin',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    let part = await reader.read();
    while (!part.done) {
      size += part.value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(part.value, { stream: true });
      part = await reader.read();
    }
    text += decoder.decode();
    return { manifestUrl: response.url, data: JSON.parse(text) };
  } catch {
    return null;
  }
}.toString()})()`;

function persistChange(id: string, item: InstalledWebApp | null): Promise<void> {
  const operation = persistQueue.then(async () => {
    const next = new Map(installed);
    if (item) next.set(id, item);
    else next.delete(id);
    await fs.mkdir(root(), { recursive: true });
    const destination = path.join(root(), 'apps.json');
    await fs.writeFile(`${destination}.tmp`, JSON.stringify([...next.values()], null, 2));
    await fs.rename(`${destination}.tmp`, destination);
    installed.clear();
    for (const [key, value] of next) installed.set(key, value);
  });
  persistQueue = operation.catch(() => undefined);
  return operation;
}

function launchArgs(id: string): string[] {
  return [...(app.isPackaged ? [] : [app.getAppPath()]), `--web-app=${appKey(id)}`];
}

function shortcutPath(item: WebApp & { launcherName?: string }, legacy = false): string {
  const key = appKey(item.id);
  const oldLabel = item.name.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60) || 'Web app';
  const label = legacy
    ? `${oldLabel} - ${key}`
    : webAppLauncherLabel(item.launcherName || item.name);
  if (process.platform === 'win32')
    return path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      app.isPackaged ? 'Mira Apps' : 'Mira Dev Apps',
      `${label}.lnk`,
    );
  if (process.platform === 'darwin')
    return path.join(app.getPath('home'), 'Applications', `${label}.app`);
  return path.join(
    process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'),
    'applications',
    `mira-${app.isPackaged ? '' : 'dev-'}${key}.desktop`,
  );
}

async function ownsShortcut(destination: string, item: WebApp): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const shortcut = shell.readShortcutLink(destination);
      return (
        !!shortcut.args?.includes(`--web-app=${appKey(item.id)}`) &&
        (shortcut.target.toLowerCase() === process.execPath.toLowerCase() ||
          shortcut.appUserModelId === `com.mira.webapp.${appKey(item.id)}`)
      );
    }
    if (process.platform === 'darwin') {
      const plist = await fs.readFile(path.join(destination, 'Contents', 'Info.plist'), 'utf8');
      return plist.includes(`<string>com.mira.webapp.${appKey(item.id)}</string>`);
    }
    return (await fs.readFile(destination, 'utf8')).includes(`--web-app=${appKey(item.id)}`);
  } catch {
    return false;
  }
}

async function chooseLauncherName(item: InstalledWebApp): Promise<string> {
  const base = webAppLauncherLabel(item.name);
  const host = new URL(item.startUrl).hostname;
  for (let index = 0; index < 1000; index++) {
    const label =
      index === 0 && item.launcherName
        ? webAppLauncherLabel(item.launcherName)
        : index === 0
          ? base
          : webAppLauncherLabel(
              `${base.slice(0, 52)} (${host.slice(0, 18)}${index > 1 ? `, ${index}` : ''})`,
            );
    const candidate = { ...item, launcherName: label };
    const destination = shortcutPath(candidate);
    const reserved = [...installed.values()].some(
      (other) =>
        other.id !== item.id && shortcutPath(other).toLowerCase() === destination.toLowerCase(),
    );
    if (reserved) continue;
    try {
      await fs.access(destination);
    } catch {
      return label;
    }
    if (await ownsShortcut(destination, item)) return label;
  }
  throw new Error('Could not choose an app launcher name.');
}

async function removeOwnedShortcut(destination: string, item: WebApp): Promise<void> {
  if (!(await ownsShortcut(destination, item))) return;
  if (process.platform === 'darwin') {
    const parent = path.resolve(app.getPath('home'), 'Applications');
    if (path.dirname(path.resolve(destination)) !== parent || path.extname(destination) !== '.app')
      throw new Error('Invalid app shortcut path');
    await fs.rm(destination, { recursive: true, force: true });
  } else await fs.rm(destination, { force: true });
}

async function createShortcut(item: InstalledWebApp): Promise<void> {
  const destination = shortcutPath(item);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const args = launchArgs(item.id);
  if (process.platform === 'win32') {
    const icon = path.join(root(), appKey(item.id), 'icon.ico');
    const hasIcon = await fs.access(icon).then(
      () => true,
      () => false,
    );
    if (
      !shell.writeShortcutLink(destination, 'create', {
        target: process.execPath,
        args: args.map((arg) => `"${arg.replace(/"/g, '')}"`).join(' '),
        description: item.name,
        ...(hasIcon ? { icon, iconIndex: 0 } : {}),
        appUserModelId: `com.mira.webapp.${appKey(item.id)}`,
      })
    )
      throw new Error('Could not create the Start menu shortcut.');
  } else if (process.platform === 'darwin') {
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    const contents = path.join(destination, 'Contents');
    await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fs.mkdir(path.join(contents, 'Resources'), { recursive: true });
    const hasIcon = await fs
      .copyFile(
        path.join(root(), appKey(item.id), 'icon.icns'),
        path.join(contents, 'Resources', 'app.icns'),
      )
      .then(
        () => true,
        () => false,
      );
    const xml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await fs.writeFile(
      path.join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>${xml(item.name)}</string><key>CFBundleDisplayName</key><string>${xml(item.name)}</string><key>CFBundleIdentifier</key><string>com.mira.webapp.${appKey(item.id)}</string><key>CFBundleExecutable</key><string>launch</string><key>CFBundlePackageType</key><string>APPL</string>${hasIcon ? '<key>CFBundleIconFile</key><string>app.icns</string>' : ''}</dict></plist>`,
    );
    await fs.writeFile(
      path.join(contents, 'MacOS', 'launch'),
      `#!/bin/sh\nexec ${[process.execPath, ...args].map(quote).join(' ')}\n`,
      { mode: 0o755 },
    );
  } else {
    const quote = (value: string) => `"${value.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')}"`;
    await fs.writeFile(
      destination,
      `[Desktop Entry]\nType=Application\nName=${item.name.replace(/[\r\n]/g, '')}\nExec=${[process.execPath, ...args].map(quote).join(' ')}\nIcon=${path.join(root(), appKey(item.id), 'icon.png')}\nTerminal=false\nCategories=Network;\n`,
      { mode: 0o755 },
    );
  }
}

async function saveIcon(item: WebApp): Promise<void> {
  if (!item.iconUrl || !isWebAppUrl(item.iconUrl)) return;
  const response = await session.defaultSession.fetch(item.iconUrl, {
    credentials: 'omit',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || !response.body) return;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let part = await reader.read();
  while (!part.done) {
    size += part.value.length;
    if (size > 4 * 1024 * 1024) {
      await reader.cancel();
      return;
    }
    chunks.push(part.value);
    part = await reader.read();
  }
  const icon = nativeImage.createFromBuffer(Buffer.concat(chunks));
  if (icon.isEmpty()) return;
  const png = icon.resize({ width: 256, height: 256 }).toPNG();
  const folder = path.join(root(), appKey(item.id));
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'icon.png'), png);
  // Windows accepts a PNG image embedded in an ICO directory.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(folder, 'icon.ico'), Buffer.concat([header, png]));
  const entries = [256, 512].map((size) => {
    const data = icon.resize({ width: size, height: size }).toPNG();
    const entry = Buffer.alloc(8);
    entry.write(size === 256 ? 'ic08' : 'ic09');
    entry.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([entry, data]);
  });
  const icns = Buffer.alloc(8);
  icns.write('icns');
  icns.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  await fs.writeFile(path.join(folder, 'icon.icns'), Buffer.concat([icns, ...entries]));
}

export async function setupWebApps(options: {
  getHost: (contents: WebContents) => BrowserWindow | null;
  isPrivate: (contents: WebContents) => boolean;
  openInBrowser: (url: string) => void;
  cleanupWindow: (id: number) => void;
  loadShell: (win: BrowserWindow) => void;
}): Promise<void> {
  try {
    const saved: unknown = JSON.parse(await fs.readFile(path.join(root(), 'apps.json'), 'utf8'));
    if (Array.isArray(saved))
      for (const raw of saved) {
        if (!raw || typeof raw !== 'object' || typeof raw.installedAt !== 'number') continue;
        const item = raw as InstalledWebApp;
        const validated = parseWebAppManifest(
          {
            name: item.name,
            id: item.id,
            start_url: item.startUrl,
            scope: item.scope,
            display: 'standalone',
            icons: [{ src: item.iconUrl, sizes: '256x256' }],
            theme_color: item.themeColor,
          },
          item.manifestUrl,
          item.startUrl,
        );
        if (validated)
          installed.set(validated.id, {
            ...validated,
            installedAt: item.installedAt,
            launcherName:
              typeof item.launcherName === 'string'
                ? webAppLauncherLabel(item.launcherName)
                : undefined,
          });
      }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Could not load installed web apps:', error);
  }
  // Migrate the old visible hash suffix without changing the app's internal identity.
  for (const item of [...installed.values()]) {
    try {
      const launcherName = await chooseLauncherName(item);
      const updated = { ...item, launcherName };
      if (
        launcherName !== item.launcherName ||
        !(await ownsShortcut(shortcutPath(updated), updated))
      ) {
        if (process.platform === 'darwin') await saveIcon(updated).catch(() => undefined);
        await createShortcut(updated);
        await persistChange(item.id, updated);
      }
      const legacy = shortcutPath(item, true);
      if (legacy !== shortcutPath(updated)) await removeOwnedShortcut(legacy, item);
    } catch (error) {
      console.error(`Could not update the launcher for ${item.name}:`, error);
    }
  }
  const authorizedShell = (sender: WebContents) => {
    const host = options.getHost(sender);
    return (
      !!host && host.webContents === sender && !sender.hostWebContents && !options.isPrivate(sender)
    );
  };
  const authorizedGuest = (sender: WebContents, id: unknown) => {
    if (!authorizedShell(sender) || typeof id !== 'number') return null;
    const target = webContents.fromId(id);
    return target &&
      !target.isDestroyed() &&
      target.getType() === 'webview' &&
      target.hostWebContents === sender &&
      !options.isPrivate(target)
      ? target
      : null;
  };
  const state = (target: WebContents): WebAppState => {
    const candidate = candidates.get(target.id);
    const existing = target.isLoadingMainFrame()
      ? undefined
      : [...installed.values()].find((item) => isWithinWebAppScope(target.getURL(), item.scope));
    const item = candidate ?? existing ?? null;
    return { webContentsId: target.id, app: item, installed: !!item && installed.has(item.id) };
  };
  const publish = (target: WebContents) => {
    if (target.isDestroyed()) return;
    const host = target.hostWebContents;
    if (host && !host.isDestroyed()) host.send('web-app-state', state(target));
  };
  const broadcast = () => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getType() === 'webview' && !options.isPrivate(contents)) publish(contents);
      if (authorizedShell(contents)) contents.send('web-apps-changed');
    }
  };
  const inspect = async (target: WebContents) => {
    if (target.isDestroyed() || options.isPrivate(target) || !isWebAppUrl(target.getURL())) return;
    const generation = (generations.get(target.id) ?? 0) + 1;
    generations.set(target.id, generation);
    const pageUrl = target.getURL();
    try {
      const raw = (await target.executeJavaScriptInIsolatedWorld(1004, [
        { code: manifestScript },
      ])) as { data?: unknown; manifestUrl?: string } | null;
      if (
        target.isDestroyed() ||
        target.getURL() !== pageUrl ||
        generations.get(target.id) !== generation
      )
        return;
      const candidate = raw?.manifestUrl
        ? parseWebAppManifest(raw.data, raw.manifestUrl, pageUrl)
        : null;
      if (candidate) candidates.set(target.id, candidate);
      else candidates.delete(target.id);
      publish(target);
    } catch {
      /* Navigations may destroy the document during inspection. */
    }
  };
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') {
      contents.on('did-attach-webview', (_event, guest) => {
        const host = options.getHost(contents);
        const id = host && windows.get(host.id);
        const item = id && installed.get(id);
        if (!item) return;
        const guard = (event: Electron.Event, url: string) => {
          if (isWithinWebAppScope(url, item.scope)) return;
          event.preventDefault();
          if (/^(https?:|mailto:)/i.test(url)) options.openInBrowser(url);
        };
        guest.on('will-navigate', guard);
        guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
          if (mainFrame) guard(event, url);
        });
      });
      return;
    }
    if (contents.getType() !== 'webview') return;
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      generations.set(contents.id, (generations.get(contents.id) ?? 0) + 1);
      candidates.delete(contents.id);
      contents.hostWebContents?.send('web-app-state', {
        webContentsId: contents.id,
        app: null,
        installed: false,
      });
    });
    contents.on('dom-ready', () => {
      void inspect(contents);
    });
    contents.on('did-navigate-in-page', () => {
      void inspect(contents);
    });
    contents.once('destroyed', () => {
      candidates.delete(contents.id);
      generations.delete(contents.id);
    });
  });
  // Dynamic manifests (SPAs) are observed by the trusted guest preload.
  ipcMain.on('web-app-manifest-changed', (event) => {
    if (event.sender.getType() === 'webview' && event.senderFrame === event.sender.mainFrame)
      void inspect(event.sender);
  });
  ipcMain.handle('web-app-get-state', (event, id: unknown) => {
    const target = authorizedGuest(event.sender, id);
    return target ? state(target) : null;
  });
  ipcMain.handle('web-app-list', (event) =>
    authorizedShell(event.sender) ? [...installed.values()] : [],
  );
  ipcMain.handle('web-app-window-info', async (event) => {
    const host = options.getHost(event.sender);
    const id = host && windows.get(host.id);
    const item = authorizedShell(event.sender) && id ? installed.get(id) : null;
    if (!item) return null;
    const icon = await fs
      .readFile(path.join(root(), appKey(item.id), 'icon.png'))
      .catch(() => null);
    return {
      ...item,
      iconDataUrl: icon ? `data:image/png;base64,${icon.toString('base64')}` : undefined,
    };
  });
  ipcMain.handle('web-app-open', (event, id: unknown) => {
    if (!authorizedShell(event.sender) || typeof id !== 'string' || !installed.has(id))
      return false;
    openWebApp(id);
    return true;
  });
  ipcMain.handle('web-app-open-in-browser', (event, value: unknown) => {
    if (!authorizedShell(event.sender) || typeof value !== 'string') return;
    try {
      const url = new URL(value);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
        return;
    } catch {
      return;
    }
    options.openInBrowser(value);
  });
  ipcMain.handle(
    'web-app-install',
    async (event, id: unknown, expectedAppId: unknown): Promise<WebAppResult> => {
      const target = authorizedGuest(event.sender, id);
      const candidate = target && candidates.get(target.id);
      if (
        !target ||
        !candidate ||
        candidate.id !== expectedAppId ||
        !isWithinWebAppScope(target.getURL(), candidate.scope)
      )
        return { ok: false, error: 'This page is no longer available to install.' };
      if (pendingInstalls.has(candidate.id))
        return { ok: false, error: 'Installation is already in progress.' };
      if (installed.has(candidate.id)) {
        openWebApp(candidate.id);
        return { ok: true };
      }
      pendingInstalls.add(candidate.id);
      try {
        const item: InstalledWebApp = { ...candidate, installedAt: Date.now() };
        item.launcherName = await chooseLauncherName(item);
        await persistChange(item.id, item);
        let warning: string | undefined;
        await saveIcon(item).catch(() => undefined);
        try {
          await createShortcut(item);
        } catch {
          warning =
            'Installed in Mira. The system shortcut could not be created; open it from Installed apps.';
        }
        broadcast();
        openWebApp(item.id);
        return { ok: true, warning };
      } catch {
        return { ok: false, error: 'Could not save this app. Please try again.' };
      } finally {
        pendingInstalls.delete(candidate.id);
      }
    },
  );
  ipcMain.handle('web-app-uninstall', async (event, id: unknown): Promise<WebAppResult> => {
    if (!authorizedShell(event.sender) || typeof id !== 'string') return { ok: false };
    const item = installed.get(id);
    if (!item || pendingInstalls.has(id)) return { ok: false };
    pendingInstalls.add(id);
    try {
      // Preserve shared cookies and offline caches: they belong to the site, too.
      try {
        await persistChange(id, null);
      } catch {
        return { ok: false, error: 'Could not remove this app. Please try again.' };
      }
      let warning: string | undefined;
      try {
        await removeOwnedShortcut(shortcutPath(item), item);
        await removeOwnedShortcut(shortcutPath(item, true), item);
      } catch {
        warning = 'App removed from Mira. Its system shortcut could not be removed.';
      }
      broadcast();
      return { ok: true, warning };
    } finally {
      pendingInstalls.delete(id);
    }
  });

  // Assigned after the callbacks have all been registered.
  function openWebApp(id: string): void {
    const item = installed.get(id);
    if (!item) return;
    const existing = [...windows].find(([, value]) => value === id);
    const win = existing && BrowserWindow.fromId(existing[0]);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    const appWindow = new BrowserWindow({
      width: 1100,
      height: 780,
      minWidth: 480,
      minHeight: 300,
      title: item.name,
      frame: process.platform === 'darwin',
      titleBarStyle:
        process.platform === 'darwin'
          ? 'hiddenInset'
          : process.platform === 'win32'
            ? 'hidden'
            : undefined,
      trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 13 } : undefined,
      titleBarOverlay:
        process.platform === 'win32'
          ? { color: '#12161d', symbolColor: '#e8edf5', height: WEB_APP_TITLEBAR_HEIGHT }
          : undefined,
      icon: path.join(root(), appKey(id), 'icon.png'),
      autoHideMenuBar: true,
      backgroundColor: item.themeColor || '#12161d',
      show: false,
      webPreferences: {
        preload: path.join(directory, 'preload.js'),
        webviewTag: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    windows.set(appWindow.id, id);
    appWindow.setMenu(null);
    if (process.platform === 'win32')
      appWindow.setAppDetails({
        appId: `com.mira.webapp.${appKey(id)}`,
        appIconPath: path.join(root(), appKey(id), 'icon.ico'),
      });
    appWindow.once('ready-to-show', () => appWindow.show());
    appWindow.on('close', (event) => {
      if (!canCloseWindow(appWindow)) {
        event.preventDefault();
        void requestWindowClose(appWindow);
      }
    });
    appWindow.on('closed', () => {
      windows.delete(appWindow.id);
      options.cleanupWindow(appWindow.id);
    });
    appWindow.webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      appWindow.setTitle(item.name);
    });
    appWindow.webContents.on('did-finish-load', () => appWindow.setTitle(item.name));
    const publishState = () => {
      if (!appWindow.isDestroyed() && !appWindow.webContents.isDestroyed()) {
        appWindow.webContents.send('window-maximized-changed', appWindow.isMaximized());
        appWindow.webContents.send('window-fullscreen-changed', appWindow.isFullScreen());
      }
    };
    appWindow.on('maximize', publishState);
    appWindow.on('unmaximize', publishState);
    appWindow.on('enter-full-screen', publishState);
    appWindow.on('leave-full-screen', publishState);
    options.loadShell(appWindow);
  }
  openInstalledApp = (key) => {
    const item = [...installed.values()].find((item) => appKey(item.id) === key);
    if (!item) return false;
    openWebApp(item.id);
    return true;
  };
  webAppsInitialized = true;
  for (const key of pendingLaunches.splice(0)) openInstalledApp(key);
}

let openInstalledApp: (key: string) => boolean = () => false;
const pendingLaunches: string[] = [];
let webAppsInitialized = false;
export function queueWebAppLaunch(argv: string[]): void {
  const argument = argv.find((value) => /^--web-app=[a-f0-9]{32}$/.test(value));
  if (!argument) return;
  const key = argument.slice('--web-app='.length);
  if (webAppsInitialized) openInstalledApp(key);
  else if (pendingLaunches.length < 20) pendingLaunches.push(key);
}
export function openWebAppFromArgv(argv: string[]): boolean {
  const argument = argv.find((value) => /^--web-app=[a-f0-9]{32}$/.test(value));
  return !!argument && openInstalledApp(argument.slice('--web-app='.length));
}
