// Only loaded by profiles.integration.ts from an isolated temporary app.
import { app, BrowserWindow, dialog, session, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const directory = process.env.MIRA_PROFILE_TEST_CONTROL!;
const id =
  process.argv.find((arg) => arg.startsWith('--mira-profile='))?.slice('--mira-profile='.length) ??
  'default';
const renderer = fileURLToPath(new URL('../dist/index.html', import.meta.url));
let nativeMenu: Menu | null = null;
if (process.env.MIRA_NATIVE_MENU_TEST === '1') {
  const popup = Menu.prototype.popup;
  Menu.prototype.popup = function (options = {}) {
    // Record the actual OS menu so the isolated fixture can select its items.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    nativeMenu = this;
    return popup.call(this, { ...options, callback: () => { nativeMenu = null; options.callback?.(); } });
  };
}
process.on('uncaughtException', (error) => {
  fs.writeFileSync(path.join(directory, `${id}-failure.txt`), String(error.stack));
  app.exit(1);
});
app.on('before-quit', () =>
  fs.writeFileSync(
    path.join(directory, `${id}-quit.json`),
    JSON.stringify({ userData: app.getPath('userData'), argv: process.argv }),
  ),
);
const requestLock = app.requestSingleInstanceLock.bind(app);
let ownsLock = true;
app.requestSingleInstanceLock = (...args) => {
  const result = requestLock(...args);
  ownsLock = result;
  fs.writeFileSync(
    path.join(directory, `${id}-lock.json`),
    JSON.stringify({
      result,
      userData: app.getPath('userData'),
      ready: app.isReady(),
      argv: process.argv,
    }),
  );
  return result;
};
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadURL = function (url) {
  return loadFile.call(this, renderer, { query: Object.fromEntries(new URL(url).searchParams) });
};
// Test fixture stays independent of the user's OS integrations.
app.setAsDefaultProtocolClient = () => false;
app.setUserTasks = () => false;
app.disableHardwareAcceleration();
let lastCommand = '';
let executing = false;
try {
  lastCommand = JSON.parse(fs.readFileSync(path.join(directory, `${id}-command.json`), 'utf8')).id;
} catch {
  /* First launch. */
}
async function run() {
  await import('../electron/main.ts');
  if (!ownsLock) return;
  await app.whenReady();
  fs.writeFileSync(path.join(directory, `${id}-ready.json`), JSON.stringify({ pid: process.pid }));
  const poll = setInterval(async () => {
    if (executing) return;
    let command: {
      id: string;
      action: string;
      code?: string;
      index?: number;
      value?: string;
      file?: string;
      bounds?: { x: number; y: number; width: number; height: number };
    };
    try {
      command = JSON.parse(fs.readFileSync(path.join(directory, `${id}-command.json`), 'utf8'));
    } catch {
      return;
    }
    if (command.id === lastCommand) return;
    lastCommand = command.id;
    executing = true;
    try {
      const windows = BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed())
        .sort((a, b) => a.id - b.id);
      const win = windows[command.index ?? 0];
      let result: unknown;
      if (command.action === 'menu-snapshot') result = nativeMenu?.items.map(item => item.label) ?? [];
      if (command.action === 'menu-select') {
        const menu = nativeMenu;
        const item = menu?.items.find(item => item.label === command.value);
        if (!menu || !item || !item.enabled) throw new Error('Native menu item unavailable');
        item.click(item, win, {} as Electron.KeyboardEvent);
        menu.closePopup(win);
        result = true;
      }
      if (command.action === 'eval')
        result = await win.webContents.executeJavaScript(command.code!);
      if (command.action === 'window-info')
        result = {
          processId: win.webContents.getOSProcessId(),
          bounds: win.getBounds(),
          content: win.getContentBounds(),
          parent: win.getParentWindow()?.id ?? null,
          onTop: win.isAlwaysOnTop(),
          visible: win.isVisible(),
          minimized: win.isMinimized(),
          focused: win.isFocused(),
        };
      if (command.action === 'window-bounds') {
        win.setBounds(command.bounds!);
        result = win.getBounds();
      }
      if (command.action === 'window-hide') {
        win.hide();
        result = true;
      }
      if (command.action === 'window-show') {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        result = true;
      }
      if (command.action === 'snapshot')
        result = {
          pid: process.pid,
          userData: app.getPath('userData'),
          sessionData: app.getPath('sessionData'),
          windows: windows.map((win) => win.id),
        };
      if (command.action === 'cookie-set') {
        await session.defaultSession.cookies.set({
          url: 'https://profiles.example',
          name: 'profile',
          value: command.value!,
          expirationDate: Date.now() / 1000 + 86400,
        });
        result = true;
      }
      if (command.action === 'cookie-get')
        result = await session.defaultSession.cookies.get({ name: 'profile' });
      if (command.action === 'picture') {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [command.file!],
        })) as typeof dialog.showOpenDialog;
        result = true;
      }
      if (command.action === 'screenshot') {
        if (
          !new URL(win.webContents.getURL()).searchParams.has('profilePicker') &&
          !new URL(win.webContents.getURL()).searchParams.has('pip')
        ) {
          if (win.isMaximized()) win.unmaximize();
          win.setBounds({ x: 50, y: 50, width: 1200, height: 850 });
        }
        win.webContents.setBackgroundThrottling(false);
        win.show();
        win.focus();
        await delay(250);
        fs.writeFileSync(command.file!, (await win.webContents.capturePage()).toPNG());
        result = true;
      }
      fs.writeFileSync(
        path.join(directory, `${id}-${command.id}.json`),
        JSON.stringify({ ok: true, result: result ?? null }),
      );
      if (command.action === 'quit') app.quit();
    } catch (error) {
      fs.writeFileSync(
        path.join(directory, `${id}-${command.id}.json`),
        JSON.stringify({ ok: false, error: String(error) }),
      );
    } finally {
      executing = false;
    }
  }, 40);
  app.on('will-quit', () => clearInterval(poll));
}
void run().catch((error) => {
  fs.writeFileSync(path.join(directory, `${id}-failure.txt`), String(error.stack));
  app.exit(1);
});
