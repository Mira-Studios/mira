import { app, BrowserWindow, dialog, ipcMain, nativeImage, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProfileStore } from './profileStore.ts';
import { requestAppDialog } from './siteInteractions.ts';

export function configureProfiles(root: string) {
  const store = new ProfileStore(root);
  const argument = process.argv.find((arg) => arg.startsWith('--mira-profile='));
  const id = argument
    ? argument.slice('--mira-profile='.length)
    : store.read().profiles.find((p) => !p.removalToken)?.id;
  if (!id) throw new Error('No available Mira profile.');
  const profile = store.get(id);
  if (profile.removalToken) throw new Error('This profile is being removed.');
  const dataPath = store.dataPath(id);
  fs.mkdirSync(dataPath, { recursive: true });
  // This must happen before sessions, stores, windows, or the instance lock.
  // One process owns one profile, including every future defaultSession/store.
  app.setPath('userData', dataPath);
  app.setPath('sessionData', dataPath);
  fs.mkdirSync(path.join(dataPath, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataPath, 'Crashpad'), { recursive: true });
  app.setPath('logs', path.join(dataPath, 'logs'));
  app.setPath('crashDumps', path.join(dataPath, 'Crashpad'));
  return { store, id, explicit: !!argument };
}

export type ProfileContext = ReturnType<typeof configureProfiles>;

export function launchProfile(
  context: ProfileContext,
  id: string,
  extra: string[] = [],
): Promise<void> {
  const profile = context.store.get(id);
  if (profile.removalToken) return Promise.reject(new Error('This profile is being removed.'));
  const environment = { ...process.env };
  // Electron treats the presence of this variable (even an empty value) as
  // Node mode. It must be absent when starting another browser process.
  delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(app.isPackaged ? [] : [app.getAppPath()]), `--mira-profile=${id}`, ...extra],
      { detached: true, stdio: 'ignore', windowsHide: true, env: environment },
    );
    let finished = false;
    const timer = setTimeout(
      () => finish(new Error('This profile did not finish starting. Try opening it again.')),
      15_000,
    );
    const poll = setInterval(() => {
      if (context.store.isRunning(id)) finish();
    }, 100);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (error) reject(error);
      else resolve();
    };
    child.once('error', (error) => finish(error));
    child.once('spawn', () => {
      child.unref();
    });
    child.once('exit', (code) => {
      if (!context.store.isRunning(id))
        finish(new Error(`Could not open this profile (exit ${code}). Try opening it again.`));
    });
  });
}

export function setupProfiles(
  context: ProfileContext,
  createWindow: () => void,
  isPrivate: (sender: WebContents) => boolean = () => false,
) {
  const { store, id } = context;
  store.cleanupRemovedProfiles();
  const state = () => ({
    currentId: id,
    showPickerOnStartup: store.read().showPickerOnStartup !== false,
    profiles: store
      .read()
      .profiles.filter((p) => !p.removalToken)
      .map((p) => ({
        id: p.id,
        name: p.name,
        avatar: store.avatar(p.id),
        syncSettings: p.syncSettings === true,
      })),
  });
  const trusted = (sender: WebContents) => {
    if (isPrivate(sender)) throw new Error('Profiles are unavailable in private windows.');
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.webContents !== sender || sender.hostWebContents)
      throw new Error('Profiles are only available in Mira windows.');
    const url = new URL(sender.getURL());
    const shellFile = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../dist/index.html',
    );
    if (
      !(app.isPackaged
        ? url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === shellFile
        : url.origin === 'http://localhost:5173' ||
          (url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === shellFile))
    )
      throw new Error('Profiles are only available in Mira windows.');
    return win;
  };
  const broadcast = () => {
    const value = state();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed() && !isPrivate(win.webContents)) {
        win.webContents.send('profiles-changed', value);
        win.webContents.send('profile-settings-sync', store.settingsUpdate(id));
      }
    }
  };
  let removalQuitRequested = false;
  fs.watchFile(store.registryPath, { interval: 300, persistent: false }, () => {
    try {
      if (store.get(id).removalToken && !removalQuitRequested) {
        removalQuitRequested = true;
        app.quit(); // Uses the normal unsaved-page confirmation and session flush.
      } else if (!store.get(id).removalToken) removalQuitRequested = false;
      broadcast();
    } catch (error) {
      console.error('Could not refresh profiles', error);
    }
  });
  app.once('will-quit', () => fs.unwatchFile(store.registryPath));

  const finishing = new Set<string>();
  const finishRemoval = async (target: string, token: string) => {
    if (finishing.has(target) || store.get(target).removalToken !== token) return;
    finishing.add(target);
    try {
      const deadline = Date.now() + 60_000;
      while (store.isRunning(target) && Date.now() < deadline) {
        if (store.get(target).removalToken !== token) return;
        await delay(200);
      }
      for (;;) {
        try {
          store.finishRemoval(target, token);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || Date.now() >= deadline)
            throw error;
          await delay(300);
        }
      }
      broadcast();
    } catch (error) {
      console.error('Could not remove profile', target, error);
      store.cancelRemoval(target, token);
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win)
        await requestAppDialog(win, {
          kind: 'alert',
          title: 'Profile kept',
          message: error instanceof Error ? error.message : 'Could not remove this profile.',
        });
    } finally {
      finishing.delete(target);
    }
  };
  const consumeRemovalCommand = (argv: string[]) => {
    const target = argv
      .find((arg) => arg.startsWith('--mira-finish-profile-removal='))
      ?.slice('--mira-finish-profile-removal='.length);
    const token = argv
      .find((arg) => arg.startsWith('--mira-removal-token='))
      ?.slice('--mira-removal-token='.length);
    if (!target || !token) return false;
    void finishRemoval(target, token).catch((error) =>
      console.error('Could not finish profile removal', error),
    );
    return true;
  };

  // Resume a confirmed removal after a crash, without reopening its windows.
  for (const profile of store.read().profiles) {
    if (profile.id !== id && profile.removalToken && !store.isRunning(profile.id))
      void finishRemoval(profile.id, profile.removalToken);
  }

  ipcMain.handle('profiles-list', (event) => {
    trusted(event.sender);
    return state();
  });
  ipcMain.handle('profiles-set-startup-picker', (event, enabled: boolean) => {
    trusted(event.sender);
    store.setShowPickerOnStartup(enabled !== false);
    broadcast();
    return true;
  });
  ipcMain.on('profile-settings-bootstrap', (event) => {
    try {
      trusted(event.sender);
      event.returnValue = store.settingsUpdate(id);
    } catch {
      event.returnValue = null;
    }
  });
  ipcMain.handle(
    'profile-settings-publish',
    (event, value: { settings: unknown; changedAt: number; initial?: boolean }) => {
      trusted(event.sender);
      if (
        !value ||
        typeof value !== 'object' ||
        !Number.isFinite(value.changedAt) ||
        value.changedAt > Date.now() + 1000
      )
        throw new Error('Invalid settings update.');
      store.publishSettings(id, value.settings, value.changedAt, value.initial === true);
      return store.settingsUpdate(id);
    },
  );
  ipcMain.handle('profiles-set-settings-sync', (event, target: string, enabled: boolean) => {
    trusted(event.sender);
    store.setSettingsSync(target, enabled === true);
    broadcast();
    return true;
  });
  ipcMain.handle('profiles-open', async (event, target: string) => {
    const source = trusted(event.sender);
    if (target === id) createWindow();
    else await launchProfile(context, target, ['--new-window']);
    if (new URL(source.webContents.getURL()).searchParams.get('profilePicker') === '1')
      source.close();
    return true;
  });
  ipcMain.handle('profiles-create', (event, name: unknown) => {
    trusted(event.sender);
    const profile = store.create(name);
    broadcast();
    return profile;
  });
  ipcMain.handle('profiles-rename', (event, target: string, name: unknown) => {
    trusted(event.sender);
    store.rename(target, name);
    broadcast();
    return true;
  });
  const pickAvatar = async (win: BrowserWindow) => {
    const answer = await dialog.showOpenDialog(win, {
      title: 'Choose a profile picture',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (answer.canceled || !answer.filePaths[0]) return null;
    const file = answer.filePaths[0];
    if ((await fs.promises.stat(file)).size > 10 * 1024 * 1024)
      throw new Error('Choose an image smaller than 10 MB.');
    const image = nativeImage.createFromBuffer(await fs.promises.readFile(file));
    if (image.isEmpty()) throw new Error('This image could not be opened.');
    const { width, height } = image.getSize();
    const side = Math.min(width, height);
    return image
      .crop({
        x: Math.floor((width - side) / 2),
        y: Math.floor((height - side) / 2),
        width: side,
        height: side,
      })
      .resize({ width: 128, height: 128 })
      .toPNG();
  };
  ipcMain.handle('profiles-pick-avatar', async (event) => {
    const image = await pickAvatar(trusted(event.sender));
    return image ? `data:image/png;base64,${image.toString('base64')}` : null;
  });
  ipcMain.handle(
    'profiles-save',
    (event, value: { id?: string; name?: unknown; avatar?: string | null }) => {
      trusted(event.sender);
      if (!value || typeof value !== 'object') throw new Error('Invalid profile.');
      let png: Buffer | null = null;
      if (value.avatar) {
        if (
          typeof value.avatar !== 'string' ||
          value.avatar.length > 500_000 ||
          !value.avatar.startsWith('data:image/png;base64,')
        )
          throw new Error('Invalid profile picture.');
        const image = nativeImage.createFromDataURL(value.avatar);
        if (image.isEmpty()) throw new Error('Invalid profile picture.');
        png = image.resize({ width: 128, height: 128 }).toPNG();
      }
      const profile = value.id ? store.get(value.id) : store.create(value.name);
      if (value.id) store.rename(value.id, value.name);
      store.setAvatar(profile.id, png);
      broadcast();
      return { ...store.get(profile.id), avatar: store.avatar(profile.id) };
    },
  );
  ipcMain.handle('profiles-set-avatar', async (event, target: string, remove: boolean) => {
    const win = trusted(event.sender);
    store.get(target);
    if (remove === true) store.setAvatar(target, null);
    else {
      const image = await pickAvatar(win);
      if (!image) return false;
      store.setAvatar(target, image);
    }
    broadcast();
    return true;
  });
  ipcMain.handle('profiles-remove', async (event, target: string) => {
    const win = trusted(event.sender);
    const profile = store.get(target);
    if (store.read().profiles.filter((p) => !p.removalToken).length < 2)
      throw new Error('Keep at least one profile.');
    const answer = await requestAppDialog(win, {
      kind: 'confirm',
      title: `Remove ${profile.name}?`,
      message:
        'This permanently deletes this profile’s settings, browsing data, bookmarks, and saved tabs. Its windows will close. Downloaded files are kept.',
      confirmLabel: 'Remove profile',
      cancelLabel: 'Keep profile',
    });
    if (!answer.accepted) return false;
    const token = store.beginRemoval(target);
    if (target === id) {
      const fallback = store.read().profiles.find((p) => !p.removalToken)!;
      try {
        await launchProfile(context, fallback.id, [
          `--mira-finish-profile-removal=${target}`,
          `--mira-removal-token=${token}`,
        ]);
      } catch (error) {
        store.cancelRemoval(target, token);
        throw error;
      }
      app.quit();
    } else void finishRemoval(target, token);
    return true;
  });

  return { consumeRemovalCommand };
}
