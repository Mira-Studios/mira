import { setTimeout as delay } from 'node:timers/promises';
import { windowsUpdateScript } from './windowsUpdateScript.ts';
import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { detectUpdateFormat, selectUpdateAsset, validateUpdateDownload, type InstallFormat } from './updatePolicy.ts';

const run = promisify(execFile);
export { selectUpdateAsset };

export function installedUpdateFormat(): InstallFormat | null {
  // Test package ownership rather than guessing from the distro or installed tools.
  return detectUpdateFormat(process.platform, process.execPath, process.env.APPIMAGE, (command, args) => {
    try {
      execFileSync(command, args, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch { return false; }
  });
}

export function createUpdateProgressWindow() {
  const win = new BrowserWindow({
    width: 460, height: 260, resizable: false, maximizable: false,
    minimizable: true, title: 'Updating Mira', autoHideMenuBar: true,
    backgroundColor: '#18181b', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  let busy = true;
  win.on('close', event => { if (busy) event.preventDefault(); });
  const ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Updating Mira</title><style>body{margin:36px;background:#18181b;color:#fafafa;font:14px system-ui}h1{font-size:23px}p{color:#b4b4bd;line-height:1.6}progress{width:100%;accent-color:#a78bfa}</style><h1>Updating Mira</h1><p id="status" role="status" aria-live="polite">Preparing your update…</p><progress aria-label="Update progress"></progress><p id="hint">Mira will reopen automatically when the update finishes.</p>`)}`);
  return {
    win,
    async status(message: string, percent?: number) {
      await ready;
      if (win.isDestroyed()) return;
      win.setProgressBar(percent === undefined ? 2 : percent / 100);
      await win.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(message)};${percent === undefined ? "document.querySelector('progress').removeAttribute('value')" : `document.querySelector('progress').max=100;document.querySelector('progress').value=${percent}`}`);
    },
    async done() {
      busy = false;
      if (!win.isDestroyed()) {
        win.setProgressBar(-1);
        await win.webContents.executeJavaScript("document.getElementById('hint').textContent='Close this window and try again.'");
      }
    },
    close() { busy = false; if (!win.isDestroyed()) win.destroy(); },
  };
}

export async function downloadUpdate(downloadUrl: string, assetName: string, directory: string,
  progress?: (received: number, total: number) => void): Promise<string> {
  validateUpdateDownload(downloadUrl, assetName);
  const response = await fetch(downloadUrl, { redirect: 'follow', headers: { 'User-Agent': 'mira-updater' } });
  if (!response.ok || !response.body) throw new Error(`Failed to download update (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const target = path.join(directory, assetName);
  const partial = `${target}.partial`;
  const file = await fs.open(partial, 'wx');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      await file.writeFile(chunk);
      received += chunk.length;
      progress?.(received, total);
    }
    if (!received || (total > 0 && received !== total)) throw new Error('The update download is incomplete. Try again.');
    await file.close();
    await fs.rename(partial, target);
    return target;
  } catch (error) {
    await file.close();
    await fs.rm(partial, { force: true });
    throw error;
  }
}


let updating = false;
export function updateInProgress() { return updating; }

export async function installUpdate(options: {
  downloadUrl: string; assetName: string; profileId: string;
  beforeInstall: () => Promise<void>; quit: () => Promise<void>;
}): Promise<void> {
  if (updating) throw new Error('An update is already in progress.');
  if (!app.isPackaged) throw new Error('Updates can only be installed in a packaged Mira build.');
  const format = installedUpdateFormat();
  if (!selectUpdateAsset([{ name: options.assetName }], process.platform, process.arch, format))
    throw new Error('This update does not match the installed Mira format and architecture.');
  updating = true;
  let directory: string;
  let ui: ReturnType<typeof createUpdateProgressWindow>;
  try {
    directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'mira-update-'));
    ui = createUpdateProgressWindow();
  } catch (error) { updating = false; throw error; }
  let keepFiles = false;
  try {
    let lastProgress = 0;
    const downloaded = await downloadUpdate(options.downloadUrl, options.assetName, directory, (received, total) => {
      if (Date.now() - lastProgress < 200) return;
      lastProgress = Date.now();
      void ui.status(total ? `Downloading update… ${Math.floor(received / total * 100)}%` : `Downloading update… ${Math.floor(received / 1048576)} MB`, total ? received / total * 100 : undefined).catch(() => {});
    });
    await options.beforeInstall();
    await ui.status('Installing update… You may be asked for administrator permission.');
    const profileArg = `--mira-profile=${options.profileId}`;
    if (format === 'nsis') {
      const script = path.join(directory, 'update.ps1');
      const readyFile = path.join(directory, 'ready');
      await fs.writeFile(script, '\uFEFF' + windowsUpdateScript(downloaded, process.execPath, profileArg, process.pid, readyFile));
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      try {
        const deadline = Date.now() + 15_000;
        while (!await fs.stat(readyFile).then(() => true, () => false)) {
          if (child.exitCode !== null || Date.now() > deadline)
            throw new Error('The Windows update window could not start. Please try again.');
          await delay(100);
        }
      } catch (error) { child.kill(); throw error; }
      child.unref();
      keepFiles = true;
    } else if (format === 'deb' || format === 'rpm') {
      await run('pkexec', format === 'deb' ? ['dpkg', '-i', downloaded] : ['rpm', '-U', downloaded]);
    } else if (format === 'appimage') {
      const target = process.env.APPIMAGE!;
      const staged = `${target}.update-${process.pid}`;
      try {
        await fs.copyFile(downloaded, staged);
        await fs.chmod(staged, 0o755);
        await fs.rename(staged, target);
      } finally { await fs.rm(staged, { force: true }); }
    } else if (format === 'mac-zip') {
      const bundle = process.execPath.slice(0, process.execPath.lastIndexOf('.app/Contents/') + 4);
      if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/'))
        throw new Error('Move Mira to Applications and launch it there before updating.');
      const unpacked = path.join(directory, 'unpacked');
      await run('/usr/bin/ditto', ['-x', '-k', downloaded, unpacked]);
      const bundles = (await fs.readdir(unpacked)).filter(name => name.endsWith('.app'));
      if (bundles.length !== 1) throw new Error('The update archive must contain exactly one application.');
      const source = path.join(unpacked, bundles[0]);
      const currentId = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(bundle, 'Contents/Info.plist')])).stdout.trim();
      const updateId = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(source, 'Contents/Info.plist')])).stdout.trim();
      if (!currentId || currentId !== updateId) throw new Error('The archive does not contain a Mira application.');
      await fs.access(path.join(source, 'Contents/MacOS', path.basename(process.execPath)));
      const staged = `${bundle}.update-${process.pid}`;
      const backup = `${bundle}.previous-${process.pid}`;
      try {
        await run('/usr/bin/ditto', [source, staged]);
        await fs.rename(bundle, backup);
        try { await fs.rename(staged, bundle); }
        catch (error) { await fs.rename(backup, bundle); throw error; }
        await fs.rm(backup, { recursive: true, force: true });
      } finally { await fs.rm(staged, { recursive: true, force: true }); }
    }
    await ui.status('Update installed. Reopening Mira…');
    if (format !== 'nsis') app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args: [profileArg] });
    ui.close();
    await options.quit();
  } catch (error) {
    await ui.status(error instanceof Error ? error.message : 'The update failed. Please try again.');
    await ui.done();
    throw error;
  } finally {
    updating = false;
    if (!keepFiles) await fs.rm(directory, { recursive: true, force: true });
  }
}
