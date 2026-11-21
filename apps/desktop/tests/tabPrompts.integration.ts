// Build the renderer before running this isolated Electron flow test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = path.resolve(desktop, '../../.tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryRoot, 'tab-prompts-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-tab-prompts-test',
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
const selected = () =>
  evaluate<string>(`document.querySelector('.theme-tab-selected')?.dataset.tabId`);
const select = async (id: string) => {
  await evaluate(`document.querySelector('[data-tab-id="${id}"]').click();true`);
  await until(async () => (await selected()) === id, 'Tab selected');
};
const guest = (id: number) =>
  `[...document.querySelectorAll('webview')].find(view=>view.getWebContentsId()===${id})`;
const request = (id: number, permission: string) =>
  command('permission-request', { value: permission, webContentsId: id });
const interaction = (text: string) =>
  until(
    async () =>
      await evaluate<boolean>(
        `[...document.querySelectorAll('.site-interaction strong')].some(node=>node.textContent.includes(${JSON.stringify(text)}))`,
      ),
    `Shows ${text}`,
  );
const noInteraction = () =>
  until(
    async () => await evaluate<boolean>(`!document.querySelector('.site-interaction')`),
    'Other tab has no interaction',
  );
const respond = async (label: string) => {
  await evaluate(
    `[...document.querySelectorAll('.site-interaction-actions button')].find(button=>button.textContent.trim()===${JSON.stringify(label)}).click();true`,
  );
  await noInteraction();
};
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => (await count()) > 0, 'Browser opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Renderer ready',
  );
  await settings({ animationsEnabled: true, tabStripPosition: 'top' });
  await invoke('tab-open-url-in-new-tab', url + '?a');
  await until(async () => {
    try {
      return await evaluate<boolean>(
        `document.querySelector('webview')?.executeJavaScript("!!document.querySelector('#state')")`,
      );
    } catch {
      return false;
    }
  }, 'Page A ready');
  const a = await selected();
  const aGuest = await evaluate<number>(`document.querySelector('webview').getWebContentsId()`);
  await invoke('tab-open-url-in-new-tab', url + '?b');
  await until(async () => (await selected()) !== a, 'Tab B active');
  const b = await selected();
  await until(async () => {
    try {
      return await evaluate<boolean>(
        `[...document.querySelectorAll('webview')].find(view=>view.getURL().endsWith('?b'))?.executeJavaScript("!!document.querySelector('#state')")`,
      );
    } catch {
      return false;
    }
  }, 'Page B ready');
  const bGuest = await evaluate<number>(
    `[...document.querySelectorAll('webview')].find(view=>view.getURL().endsWith('?b')).getWebContentsId()`,
  );
  await request(aGuest, 'notifications');
  await settings({ tabSleepValue: 1, tabSleepUnit: 'seconds', tabSleepMode: 'discard' });
  await delay(1500);
  assert.equal(
    await evaluate(`!!${guest(aGuest)}`),
    true,
    'A pending prompt protects its background tab from discard',
  );
  await settings({ tabSleepValue: 3, tabSleepUnit: 'minutes', tabSleepMode: 'freeze' });
  assert.equal(
    await evaluate(`!!document.querySelector('#site-permission-prompt-message')`),
    false,
    'Background permission does not appear on another tab',
  );
  await select(a);
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('#site-permission-prompt-message')?.textContent.includes('Show notifications')`,
      ),
    'Permission returns on its source tab',
  );
  const permissionId = await evaluate(
    `document.querySelector('.site-permission-anchor').getAttribute('key') || document.querySelector('#site-permission-prompt-message').textContent`,
  );
  await select(b);
  assert.equal(
    await evaluate(`!!document.querySelector('#site-permission-prompt-message')`),
    false,
    'Permission hides immediately even with animations enabled',
  );
  await request(bGuest, 'clipboard-read');
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('#site-permission-prompt-message')?.textContent.includes('Read your clipboard')`,
      ),
    'Each tab gets its own queued permission',
  );
  await select(a);
  assert.equal(
    await evaluate(
      `document.querySelector('.site-permission-anchor').getAttribute('key') || document.querySelector('#site-permission-prompt-message').textContent`,
    ),
    permissionId,
    'Original permission remains queued',
  );
  await evaluate(
    `[...document.querySelectorAll('.site-permission-prompt-actions button')].find(button=>button.textContent.trim()==='Block').click();true`,
  );
  await select(b);
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('#site-permission-prompt-message')?.textContent.includes('Read your clipboard')`,
      ),
    'Other tab request is retained',
  );
  await evaluate(
    `[...document.querySelectorAll('.site-permission-prompt-actions button')].find(button=>button.textContent.trim()==='Block').click();true`,
  );
  // A real WebAuthn request must stay pending without launching an OS authenticator.
  await evaluate(
    `void ${guest(aGuest)}.executeJavaScript("window.passkeyResult='pending';navigator.credentials.get({publicKey:{challenge:new Uint8Array([1,2,3]),timeout:60000}}).then(()=>window.passkeyResult='ok',error=>window.passkeyResult=error.name);true");true`,
  );
  await delay(250);
  await noInteraction();
  await select(a);
  await interaction('Use a passkey?');
  const passkeyTitle = await evaluate(
    `document.querySelector('.site-interaction').getAttribute('aria-labelledby')`,
  );
  await select(b);
  assert.equal(
    await evaluate(`!!document.querySelector('.site-interaction')`),
    false,
    'Passkey hides immediately',
  );
  await select(a);
  await interaction('Use a passkey?');
  assert.equal(
    await evaluate(`document.querySelector('.site-interaction').getAttribute('aria-labelledby')`),
    passkeyTitle,
    'Same passkey request returns',
  );
  await respond('Not now');
  // Text entered before switching tabs must remain intact.
  await evaluate(
    `void ${guest(aGuest)}.executeJavaScript("window.dialogResult=prompt('Draft test','starting');true");true`,
  );
  await interaction('127.0.0.1');
  await evaluate(
    `const input=document.querySelector('.site-interaction input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'keep this draft');input.dispatchEvent(new Event('input',{bubbles:true}));true`,
  );
  assert.equal(
    await evaluate(
      `(() => {const tab=document.querySelector('[data-tab-id="${b}"]');const r=tab.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('[data-tab-id]')===tab;})()`,
    ),
    true,
    'Page modal leaves the tab strip clickable',
  );
  await select(b);
  await noInteraction();
  await select(a);
  await interaction('127.0.0.1');
  assert.equal(
    await evaluate(`document.querySelector('.site-interaction input').value`),
    'keep this draft',
    'Prompt draft survives tab switch',
  );
  await respond('Cancel');
  // Real editor save-changes prompt, identified by editor tab rather than host renderer.
  const file = path.join(root, 'unsaved.txt');
  fs.writeFileSync(file, 'original');
  await invoke('tab-open-url-in-new-tab', pathToFileURL(file).href);
  await until(async () => (await selected()) !== a, 'Editor tab selected');
  const editor = await selected();
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('iframe[title^="Edit "]')`),
    'Editor opens',
  );
  await evaluate(
    `window.electron.ipcRenderer.send('editor-change',${JSON.stringify(editor)},'changed');true`,
  );
  await delay(100);
  await evaluate(
    `void window.electron.ipcRenderer.invoke('editor-check',${JSON.stringify(editor)},'close this tab').then(result=>window.editorAnswer=result);true`,
  );
  await interaction('Save changes');
  await command('screenshot', { file: path.join(root, 'save-tab-prompt.png') });
  await select(b);
  assert.equal(
    await evaluate(`!!document.querySelector('.site-interaction')`),
    false,
    'Save prompt hides with its editor tab',
  );
  await select(editor);
  await interaction('Save changes');
  await respond('Don\u2019t Save');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    'original',
    'Switching tabs never answers or saves a prompt',
  );
  // Navigating the source cancels stale permissions rather than showing them on a new page.
  await select(a);
  await request(aGuest, 'geolocation');
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('#site-permission-prompt-message')?.textContent.includes('location')`,
      ),
    'Location request opens',
  );
  await evaluate(`${guest(aGuest)}.src=${JSON.stringify(url + '?navigated')};true`);
  await until(
    async () =>
      await evaluate<boolean>(`!document.querySelector('#site-permission-prompt-message')`),
    'Navigation clears stale source prompt',
  );
  console.log(
    `PASS: permission, passkey, JavaScript and editor-save prompts stay with source tabs; background requests stay hidden, drafts survive, tabs remain clickable and navigation cancels stale requests.\nArtifacts: ${root}`,
  );
} catch (failure) {
  try {
    console.error('Prompt UI:', await evaluate(`document.body.innerText`));
  } catch {
    /* Preserve failure. */
  }
  throw failure;
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
