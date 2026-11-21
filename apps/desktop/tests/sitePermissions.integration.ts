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
const root = fs.mkdtempSync(path.join(temporaryRoot, 'site-permissions-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-site-permissions-test',
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
fs.writeFileSync(
  path.join(data, 'site-permissions.json'),
  JSON.stringify({ origins: { '127.0.0.1': { unknown: 'allow' } } }),
);
const environment = {
  ...process.env,
  MIRA_TEST_USER_DATA_DIR: data,
  MIRA_PROFILE_TEST_CONTROL: root,
  MIRA_PERMISSION_TEST: '1',
};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron') as string, [fixture], {
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
let guestId: number;
const request = async (permission: string) => {
  await command('permission-request', { value: permission, webContentsId: guestId });
  return command<boolean | null>('permission-answer');
};
const update = (permissionId: string, decision: string) =>
  invoke('site-permissions-update', { origin: '127.0.0.1', permissionId, decision });
const snapshot = () =>
  invoke('site-permissions-get', 'http://127.0.0.1') as Promise<{
    permissions: Array<{ id: string; label: string; decision: string }>;
  }>;
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => (await count()) > 0, 'Browser opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Renderer ready',
  );
  await settings({ animationsEnabled: false });
  await invoke('tab-open-url-in-new-tab', url);
  await until(async () => {
    try {
      return await evaluate<boolean>(
        `document.querySelector('webview')?.executeJavaScript("document.body?.textContent.includes('original') || !!document.querySelector('#state')")`,
      );
    } catch {
      return false;
    }
  }, 'Fixture loaded');
  guestId = await evaluate<number>(`document.querySelector('webview').getWebContentsId()`);
  assert.equal(
    await request('persistent-storage'),
    true,
    'First-party persistent storage needs no prompt',
  );
  assert.equal(await evaluate(`!!document.querySelector('.site-permission-prompt')`), false);
  await update('persistent-storage', 'block');
  assert.equal(
    await request('persistent-storage'),
    false,
    'Explicit persistent-storage block is honored',
  );
  await update('persistent-storage', 'ask');
  assert.equal(
    await request('persistent-storage'),
    true,
    'Default persistent storage remains silent',
  );
  assert.equal(await request('clipboard-sanitized-write'), true, 'Copying needs no prompt');
  await update('clipboard-write', 'block');
  assert.equal(
    await request('clipboard-sanitized-write'),
    false,
    'Explicit clipboard-write block is honored',
  );
  await update('clipboard-write', 'ask');
  assert.equal(
    await request('clipboard-read'),
    null,
    'Copying and legacy unknown allow do not grant clipboard reading',
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('#site-permission-prompt-message')?.textContent.includes('Read your clipboard')`,
      ),
    'Read prompt identifies requested access',
  );
  await evaluate(
    `[...document.querySelectorAll('.site-permission-prompt-actions button')].find(button=>button.textContent.trim()==='Block').click();true`,
  );
  await until(async () => (await command('permission-answer')) === false, 'Clipboard read denied');
  assert.equal(
    (await snapshot()).permissions.find((item) => item.id === 'clipboard')?.decision,
    'block',
  );
  assert.equal(await request('local-fonts'), null);
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('#site-permission-prompt-message')?.textContent.includes('local-fonts')`,
      ),
    'Unmapped prompt names raw permission',
  );
  await evaluate(
    `[...document.querySelectorAll('.site-permission-prompt-actions button')].find(button=>button.textContent.trim()==='Allow').click();true`,
  );
  await until(
    async () => (await command('permission-answer')) === true,
    'Specific unmapped permission saved',
  );
  assert.equal(
    await request('background-sync'),
    null,
    'One unmapped grant cannot allow another permission',
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('#site-permission-prompt-message')?.textContent.includes('background-sync')`,
      ),
    'Second permission identified separately',
  );
  await evaluate(
    `[...document.querySelectorAll('.site-permission-prompt-actions button')].find(button=>button.textContent.trim()==='Block').click();true`,
  );
  await until(
    async () => (await command('permission-answer')) === false,
    'Separate decision saved',
  );
  const before = await snapshot();
  assert.equal(
    before.permissions.find((item) => item.id === 'unknown')?.decision,
    'allow',
    'Legacy choice preserved',
  );
  assert.equal(
    before.permissions.find((item) => item.id === 'other:local-fonts')?.decision,
    'allow',
  );
  assert.equal(
    before.permissions.find((item) => item.id === 'other:background-sync')?.decision,
    'block',
  );
  await invoke(
    'tab-open-url-in-new-tab',
    'mira://Settings#section=privacy-security&subsection=site-permissions&site=127.0.0.1',
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('[aria-label="Persistent storage permission"]')`,
      ),
    'Persistent storage appears in Settings',
  );
  for (const label of [
    'Copy to clipboard',
    'Read clipboard',
    'Other permission (legacy)',
    'Browser permission: local-fonts',
    'Browser permission: background-sync',
  ]) {
    assert.equal(
      await evaluate(
        `!!document.querySelector(${JSON.stringify('[aria-label="' + label + ' permission"]')})`,
      ),
      true,
      `${label} appears in Settings`,
    );
  }
  await evaluate(
    `[...document.querySelectorAll('[aria-label="Persistent storage permission"] button')].find(button=>button.textContent==='Block').click();true`,
  );
  await until(
    async () =>
      (await snapshot()).permissions.find((item) => item.id === 'persistent-storage')?.decision ===
      'block',
    'Settings updates actual permission',
  );
  assert.equal(await request('persistent-storage'), false);
  const stored = JSON.parse(
    fs.readFileSync(path.join(data, 'Profiles', 'default', 'site-permissions.json'), 'utf8'),
  );
  assert.equal(stored.origins['127.0.0.1']['persistent-storage'], 'block');
  console.log(
    `PASS: silent persistent storage and copying, clipboard-read prompt, explicit blocks, named fallback permissions, legacy choice visibility, Settings controls and persistence.\nArtifacts: ${root}`,
  );
} finally {
  try {
    await command('quit');
  } catch {
    /* Isolated fixture only. */
  }
  if (child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
