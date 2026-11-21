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
const root = fs.mkdtempSync(path.join(temporaryRoot, 'workspace-ui-'));
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
const click = (selector: string, index = 0) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`, index);
const settings = (values: Record<string, unknown>) =>
  evaluate(
    `localStorage.setItem('mira.settings.browser.v1', JSON.stringify({...JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'), ...${JSON.stringify(values)}})); window.dispatchEvent(new Event('mira:settings-changed')); true`,
  );
const invoke = (channel: string, ...args: unknown[]) =>
  evaluate(
    `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
  );

const invokeAt = (index: number, channel: string, ...args: unknown[]) =>
  evaluate(
    channel === 'window-close'
      ? `setTimeout(() => window.electron.ipcRenderer.invoke('window-close'), 50); true`
      : `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
    index,
  );
const windowCount = async () => (await command<{ windows: number[] }>('snapshot')).windows.length;
const workspaceFile = () => {
  const profiles = path.join(data, 'Profiles', 'default', 'workspaces.v1.json');
  return JSON.parse(fs.readFileSync(profiles, 'utf8'));
};
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron is ready');
  await until(async () => (await windowCount()) > 0, 'Browser window opens');
  await until(async () => {
    try {
      return await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`);
    } catch {
      return false;
    }
  }, 'Initial browser ready');
  await settings({ animationsEnabled: false, tabStripPosition: 'top', sidebarEnabled: false });
  await click('[title="Menu"]');
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[role="menuitem"]')].some(button => button.textContent.trim() === 'Workspace settings')`,
    ),
    false,
    'Regular windows have no workspace settings menu item',
  );
  await click('[aria-label="Add workspace"]');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('.workspace-editor')`),
    'Workspace creation modal opens',
  );
  assert.equal(
    await evaluate(`!!document.querySelector('.workspace-editor-tabs')`),
    false,
    'Creation only asks for workspace identity',
  );
  await evaluate(
    `const input = document.querySelector('.workspace-editor input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Research'); input.dispatchEvent(new Event('input', {bubbles:true})); true`,
  );
  await evaluate(
    `[...document.querySelectorAll('.workspace-editor button')].find(button => button.textContent === 'Create').click(); true`,
  );
  await until(async () => (await windowCount()) === 2, 'Creating a workspace opens its own window');
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('[data-tab-id]') && !!window.electron.workspaceId`,
        1,
      ),
    'Workspace is ready',
  );
  const list = (await invoke('workspaces-list')) as Array<{
    id: string;
    name: string;
    settings: Record<string, unknown>;
  }>;
  assert.equal(list[0].name, 'Research');
  const id = list[0].id;
  await click('[title="Menu"]', 1);
  assert.equal(
    await evaluate(
      `(() => { const buttons = [...document.querySelectorAll('[role="menuitem"]')]; const index = buttons.findIndex(button => button.textContent.trim() === 'Settings'); return buttons[index + 1]?.textContent.trim(); })()`,
      1,
    ),
    'Workspace settings',
    'Workspace settings appears directly below Settings',
  );
  assert.equal(
    await evaluate(`!!document.querySelector('[aria-label="You are in workspace Research"]')`, 1),
    true,
    'Workspace window shows its identity',
  );
  await click('[title="Menu"]', 1);
  assert.equal(
    await evaluate(`window.electron.profileId`, 1),
    await evaluate(`window.electron.profileId`),
    'Workspace belongs to creating profile',
  );
  await invoke('workspaces-open', id);
  assert.equal(await windowCount(), 2, 'Opening a running workspace focuses its existing window');
  await invokeAt(1, 'tab-open-url-in-new-tab', url);
  await until(
    () =>
      workspaceFile().workspaces[0].session?.tabs.some((tab: { url: string }) => tab.url === url),
    'Workspace saves its tabs',
  );
  await invoke('workspaces-save', {
    ...list[0],
    icon: 'code',
    name: 'Research renamed',
    startup: 'restore',
    urls: [],
    settings: { ...list[0].settings, tabStripPosition: 'left', animationsEnabled: true },
  });
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('.tab-animations-enabled')?.style.flexDirection === 'column'`,
        1,
      ),
    'Workspace layout changes live',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.tab-animations-enabled')?.style.flexDirection === 'column'`,
    ),
    false,
    'Regular window keeps its layout',
  );
  await invokeAt(1, 'tab-open-url-in-new-tab', 'mira://Settings#section=layout');
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('#settings-tab-layout[aria-selected="true"]')`,
        1,
      ),
    'Workspace settings ready',
  );
  await click('#sidebar-enabled', 1);
  await until(
    () => workspaceFile().workspaces[0].settings.sidebarEnabled === true,
    'Workspace settings saved separately',
  );
  assert.equal(
    await evaluate(`JSON.parse(localStorage.getItem('mira.settings.browser.v1')).sidebarEnabled`),
    false,
    'Workspace settings do not change profile settings',
  );
  await evaluate(`setTimeout(() => location.reload(), 50); true`, 1);
  await delay(250);
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.browser-sidebar') && !!document.querySelector('#settings-tab-layout[aria-selected="true"]')`,
        1,
      ),
    'Renderer reload restores workspace tabs and overrides',
  );
  await command('screenshot', { index: 1, file: path.join(root, 'workspace-window.png') });
  await invokeAt(1, 'window-close');
  await until(async () => (await windowCount()) === 1, 'Workspace closes');
  await invoke('workspaces-open', id);
  await until(async () => (await windowCount()) === 2, 'Workspace reopens');
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.browser-sidebar') && document.querySelectorAll('[data-tab-id]').length === 2`,
        1,
      ),
    'Reopened workspace restores all tabs and settings',
  );
  await invokeAt(1, 'window-close');
  await until(async () => (await windowCount()) === 1, 'Workspace closed for fixed-start test');
  await invoke('workspaces-open', id);
  await until(
    async () =>
      await evaluate<boolean>(`document.querySelectorAll('[data-tab-id]').length === 2`, 1),
    'Workspace ready for blank-tab reopening check',
  );
  await click('.tab-new-tab-btn', 1);
  await click('.tab-new-tab-btn', 1);
  await until(
    () => workspaceFile().workspaces[0].session.tabs.length === 4,
    'Workspace saves new tabs alongside existing tabs',
  );
  await invokeAt(1, 'window-close');
  await until(async () => (await windowCount()) === 1, 'Workspace with blank tabs closes');
  await invoke('workspaces-open', id);
  await until(
    async () =>
      await evaluate<boolean>(`document.querySelectorAll('[data-tab-id]').length === 4`, 1),
    'Reopening workspace preserves every tab including New Tab',
  );
  await invokeAt(1, 'window-close');
  await until(async () => (await windowCount()) === 1, 'Workspace blank-tab check closes');
  const current = ((await invoke('workspaces-list')) as typeof list)[0];
  await invoke('workspaces-save', { ...current, startup: 'fixed', urls: [`${url}?fixed`] });
  await invoke('workspaces-open', id);
  await until(async () => (await windowCount()) === 2, 'Fixed workspace reopens');
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelectorAll('[data-tab-id]').length === 1 && !!document.querySelector('webview')`,
        1,
      ),
    'Fixed tab set replaces saved session',
  );
  await invokeAt(1, 'window-close');
  await until(async () => (await windowCount()) === 1, 'Fixed workspace closed');
  await invoke('workspaces-open-settings', id);
  await until(async () => (await windowCount()) === 2, 'Editing opens the owning workspace window');
  await until(
    async () =>
      await evaluate<boolean>(`!!document.querySelector('[aria-label="Workspace name"]')`, 1),
    'Editing opens workspace settings page',
  );
  assert.equal(
    await evaluate(`!!document.querySelector('.workspace-editor[role="dialog"]')`, 1),
    false,
    'Editing is not a modal',
  );
  await click('[aria-label="star icon"]', 1);
  await command('picture', { file: path.join(desktop, 'src/assets/mira_icon.png') });
  await click('[aria-label="Choose workspace picture"]', 1);
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.settings-profile-actions .workspace-avatar img')`,
        1,
      ),
    'Workspace picture preview appears',
  );
  await command('screenshot', { index: 1, file: path.join(root, 'workspace-settings.png') });
  await until(
    () => !!workspaceFile().workspaces[0].avatar && workspaceFile().workspaces[0].icon === 'star',
    'Picture and icon persist from workspace settings',
  );
  await click('#settings-tab-appearance', 1);
  assert.ok(
    await evaluate(`!!document.querySelector('.newtab-background-controls')`, 1),
    'Workspace appearance uses the full normal Settings controls',
  );
  await invokeAt(1, 'window-close');
  await until(async () => (await windowCount()) === 1, 'Edited workspace closes');
  await settings({
    sidebarEnabled: true,
    sidebarSections: ['workspaces'],
    sidebarMode: 'expanded',
  });
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.browser-sidebar [aria-label="Open workspace Research renamed"]')`,
      ),
    'Workspace list appears in sidebar',
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('.browser-sidebar [aria-label="Workspace settings"]')`,
    ),
    false,
    'Sidebar has no second settings button',
  );
  await click('[title="Menu"]');
  assert.equal(
    await evaluate(
      `!!document.querySelector('.address-menu-panel [aria-label="Open workspace Research renamed"]')`,
    ),
    false,
    'Sidebar workspaces are omitted from main menu',
  );
  await click('[title="Menu"]');
  await evaluate(
    `window.__deleted = null; window.electron.ipcRenderer.invoke('workspaces-remove', ${JSON.stringify(id)}).then(value => window.__deleted = value); true`,
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.site-interaction-backdrop:not([inert]) .site-interaction-primary')`,
      ),
    'Deleting requires confirmation',
  );
  await evaluate(
    `[...document.querySelectorAll('.site-interaction button')].find(button => button.textContent === 'Cancel').click(); true`,
  );
  await until(
    async () => await evaluate(`window.__deleted === false`),
    'Cancellation keeps workspace',
  );
  assert.equal(((await invoke('workspaces-list')) as unknown[]).length, 1);
  await delay(250);
  await evaluate(
    `window.__deleted = null; window.electron.ipcRenderer.invoke('workspaces-remove', ${JSON.stringify(id)}).then(value => window.__deleted = value); true`,
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.site-interaction-backdrop:not([inert]) .site-interaction-primary')`,
      ),
    'Confirmation returns',
  );
  await click('.site-interaction-backdrop:not([inert]) .site-interaction-primary');
  await until(
    async () => await evaluate(`window.__deleted === true`),
    'Confirmed deletion finishes',
  );
  assert.deepEqual(await invoke('workspaces-list'), []);
  await settings({ sidebarEnabled: false, showWorkspaceMenu: true, animationsEnabled: true });
  await until(
    async () =>
      await evaluate<boolean>(`!!document.querySelector('button[aria-label="Workspaces"]')`),
    'Workspace toolbar menu is available',
  );
  await click('button[aria-label="Workspaces"]');
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('[role="dialog"][aria-label="Workspaces"].address-menu-panel-open')`,
      ),
    'Workspace menu animates like Profiles',
  );
  await click('[title="Menu"]');
  assert.equal(
    await evaluate(
      `!!document.querySelector('.address-menu-panel[role="menu"] [role="group"][aria-label="Workspaces"]')`,
    ),
    false,
    'Toolbar workspaces are omitted from the main menu',
  );
  await click('[title="Menu"]');
  await invoke('window-new-private');
  await until(async () => (await windowCount()) === 2, 'Private window opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`, 1),
    'Private renderer ready',
  );
  assert.equal(await evaluate(`!!window.electron.workspaceId`, 1), false);
  await assert.rejects(() => invokeAt(1, 'workspaces-list'));
  console.log(
    `PASS: workspace creation, profile ownership, window reuse, restoration, fixed tabs, independent settings, reload, sidebar/menu placement, deletion confirmation and private-window exclusion.\nArtifacts: ${root}`,
  );
} finally {
  try {
    await command('quit');
  } catch {
    /* Stop only this fixture. */
  }
  if (child.exitCode === null) child.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
