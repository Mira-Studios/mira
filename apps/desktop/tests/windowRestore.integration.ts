// Build the renderer before running this isolated Electron flow test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = path.resolve(desktop, '../../.tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryRoot, 'restore-windows-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-workspaces-test',
    type: 'module',
    main: fileURLToPath(new URL('profileWorker.electron.ts', import.meta.url)),
  }),
);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<title>Sidebar preservation</title><input id="state" value="original">');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
const environment = {
  ...process.env,
  MIRA_TEST_USER_DATA_DIR: data,
  MIRA_PROFILE_TEST_CONTROL: root,
};
delete environment.ELECTRON_RUN_AS_NODE;
let child = spawn(createRequire(import.meta.url)('electron') as string, [fixture], {
  cwd: desktop,
  env: environment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', (value) => {
  diagnostics += String(value);
});
child.stdout.on('data', (value) => {
  diagnostics += String(value);
});
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${message}\n${diagnostics.slice(-2000)}`);
    await delay(60);
  }
}
async function command<T = unknown>(
  action: string,
  values: Record<string, unknown> = {},
): Promise<T> {
  const id = randomUUID();
  fs.writeFileSync(
    path.join(root, 'default-command.json'),
    JSON.stringify({ id, action, ...values }),
  );
  const response = path.join(root, `default-${id}.json`);
  await until(() => fs.existsSync(response), `${action} responds`);
  const result = JSON.parse(fs.readFileSync(response, 'utf8'));
  assert.ok(result.ok, result.error);
  return result.result;
}
const evaluate = <T = unknown>(code: string, index = 0) => command<T>('eval', { code, index });
const settings = (values: Record<string, unknown>) =>
  evaluate(
    `localStorage.setItem('mira.settings.browser.v1', JSON.stringify({...JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'), ...${JSON.stringify(values)}})); window.dispatchEvent(new Event('mira:settings-changed')); true`,
  );
const invoke = (channel: string, ...args: unknown[]) =>
  evaluate(
    `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
  );

const count = async () => (await command<{ windows: number[] }>('snapshot')).windows.length;
const sessionFile = path.join(data, 'Profiles', 'default', 'session.json');
const saved = () => JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
async function restoreMutedTab(index: number, tabUrl: string) {
  await until(
    async () =>
      await evaluate<boolean>(
        `(() => { try { const view = document.querySelector('webview'); return view?.getURL() === ${JSON.stringify(tabUrl)} && !view.isLoading(); } catch { return false; } })()`,
        index,
      ),
    'Tab finishes loading before mute fixture is saved',
  );
  await delay(250);
  await evaluate(
    `(async () => {
    const id = document.querySelector('[data-tab-id]').dataset.tabId;
    const snapshot = { tabs: [{id, url: ${JSON.stringify(tabUrl)}, title:'Muted restored tab', history:[${JSON.stringify(tabUrl)}], historyIndex:0, reloadToken:0, isSleeping:false, isMuted:true, lastActiveAt:Date.now()}], activeId:id, savedAt:Date.now() };
    await window.electron.ipcRenderer.invoke('session-save-window',snapshot);
    await window.electron.ipcRenderer.invoke('window-suspension-update-state',snapshot);
    setTimeout(() => location.reload(),50); return true;
  })()`,
    index,
  );
  await delay(250);
  await until(
    async () =>
      await evaluate<boolean>(
        `(() => { try { return document.querySelector('webview')?.isAudioMuted() === true; } catch { return false; } })()`,
        index,
      ),
    'Restored webview applies its saved mute state',
  );
}
async function restart() {
  await command('quit');
  await until(() => child.exitCode !== null, 'App quits');
  fs.unlinkSync(path.join(root, 'default-ready.json'));
  child = spawn(createRequire(import.meta.url)('electron') as string, [fixture], {
    cwd: desktop,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (value) => {
    diagnostics += String(value);
  });
  child.stdout.on('data', (value) => {
    diagnostics += String(value);
  });
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Restart is ready');
}
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron is ready');
  await until(async () => (await count()) === 1, 'Initial window opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Shell renders',
  );
  await settings({ startupRestoreBehavior: 'windows', animationsEnabled: false });
  await invoke('tab-open-url-in-new-tab', url);
  await restoreMutedTab(0, url);
  await invoke('window-new');
  await invoke('window-new');
  await until(async () => (await count()) === 3, 'Three normal windows open');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`, 1),
    'Second normal renderer ready',
  );
  await evaluate(
    `window.electron.ipcRenderer.invoke('tab-open-url-in-new-tab', ${JSON.stringify(`${url}?second-window`)})`,
    1,
  );
  await delay(1500);
  assert.equal(saved().windows.length, 3, 'Normal windows with only New Tab are saved too');
  await evaluate(`setTimeout(() => location.reload(), 50); true`, 1);
  await delay(250);
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('webview')`, 1),
    'Dev renderer reload preserves the normal window tabs',
  );
  await restart();
  await until(async () => (await count()) === 3, 'All normal windows restore');
  for (let index = 0; index < 3; index++)
    await until(
      async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`, index),
      `Restored normal window ${index} renders`,
    );
  let mutedWindow = -1;
  await until(async () => {
    for (let index = 0; index < 3; index++) {
      if (
        await evaluate<boolean>(
          `(() => { try { return document.querySelector('webview')?.isAudioMuted() === true; } catch { return false; } })()`,
          index,
        )
      ) {
        mutedWindow = index;
        return true;
      }
    }
    return false;
  }, 'Muted tab remains muted after app restart');
  await evaluate(`document.querySelector('[aria-label="Unmute tab"]').click(); true`, mutedWindow);
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('webview').isAudioMuted() === false`,
        mutedWindow,
      ),
    'Restored tab can be unmuted',
  );
  await until(
    () =>
      saved().windows.every((window: { tabs: Array<{ isMuted?: boolean }> }) =>
        window.tabs.every((tab) => !tab.isMuted),
      ),
    'Unmuting updates saved session state',
  );
  const workspace = (await invoke('workspaces-save', {
    name: 'Restored workspace',
    icon: 'book',
    startup: 'restore',
    urls: [`${url}?workspace`],
    settings: { animationsEnabled: false },
  })) as { id: string };
  await invoke('workspaces-open', workspace.id);
  await until(async () => (await count()) === 4, 'Workspace joins the normal windows');
  await until(
    async () => (await evaluate(`window.electron.workspaceId`, 3)) === workspace.id,
    'Workspace renderer ready',
  );
  await restoreMutedTab(3, `${url}?workspace`);
  await delay(500);
  await restart();
  await until(
    async () => (await count()) === 4,
    'Workspace and all normal windows restore together',
  );
  const identities = [];
  for (let index = 0; index < 4; index++)
    identities.push(await evaluate(`window.electron.workspaceId ?? null`, index));
  assert.equal(
    identities.filter((value) => value === workspace.id).length,
    1,
    'Workspace restores once into its own window',
  );
  assert.equal(
    identities.filter((value) => value === null).length,
    3,
    'Normal windows stay normal',
  );
  const restoredWorkspaceIndex = identities.indexOf(workspace.id);
  await until(
    async () =>
      await evaluate<boolean>(
        `(() => { try { return document.querySelector('webview')?.isAudioMuted() === true; } catch { return false; } })()`,
        restoredWorkspaceIndex,
      ),
    'Workspace restored tab stays muted',
  );
  await settings({ startupRestoreBehavior: 'tabs' });
  await restart();
  await until(
    async () => (await count()) === 2,
    'Restore-tabs merges normal windows while keeping workspace separate',
  );
  const mergedIdentities = [
    await evaluate(`window.electron.workspaceId ?? null`, 0),
    await evaluate(`window.electron.workspaceId ?? null`, 1),
  ];
  assert.equal(mergedIdentities.filter((value) => value === workspace.id).length, 1);
  console.log(
    `PASS: all normal windows (including blank windows) and workspace windows restore across real app restarts.\nArtifacts: ${root}`,
  );
} finally {
  try {
    await command('quit');
  } catch {
    /* Isolated fixture only. */
  }
  if (child.exitCode === null) child.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
