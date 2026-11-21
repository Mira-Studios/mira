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
const root = fs.mkdtempSync(path.join(temporaryRoot, 'quick-navigate-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-quick-navigate-test',
    type: 'module',
    main: fileURLToPath(new URL('profileWorker.electron.ts', import.meta.url)),
  }),
);
let iconRequests = 0;
const server = createServer((request, response) => {
  if (request.url === '/assets/site.svg') {
    iconRequests++;
    response.setHeader('content-type', 'image/svg+xml');
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>',
    );
  } else if (request.url === '/favicon.ico') {
    response.writeHead(404).end();
  } else {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<title>Quick test website</title><link href="/assets/site.svg" rel="icon" type="image/svg+xml"><p>Local fixture</p>',
    );
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
const environment = {
  ...process.env,
  MIRA_TEST_USER_DATA_DIR: data,
  MIRA_PROFILE_TEST_CONTROL: root,
  MIRA_NATIVE_MENU_TEST: '1',
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

const windowCount = async () => (await command<{ windows: number[] }>('snapshot')).windows.length;
const fill = (selector: string, value: string, index = 0) =>
  evaluate(
    `(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    index,
  );
const menuItem = async (label: string, index = 0) => {
  const native = await command<string[]>('menu-snapshot');
  if (native.includes(label)) return command('menu-select', { value: label, index });
  return evaluate(
    `[...document.querySelectorAll('[role="menuitem"]')].find(button=>button.textContent.trim()===${JSON.stringify(label)}).click();true`,
    index,
  );
};
const newTab = async (index = 0) => {
  const before = await evaluate<string>(
    `document.querySelector('.theme-tab-selected')?.dataset.tabId`,
    index,
  );
  await click('.tab-new-tab-btn', index);
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('.theme-tab-selected')?.dataset.tabId !== ${JSON.stringify(before)}`,
        index,
      ),
    'New tab becomes active',
  );
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('.quick-navigate')`, index),
    'Quick Navigate rendered',
  );
};
const openBackgroundMenu = (index = 0) =>
  evaluate(
    `document.querySelector('.quick-navigate').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:500}));true`,
    index,
  );
const addLink = async (name: string, index = 0) => {
  await click('[aria-label="Add Quick Navigate link"]', index);
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('#quick-navigate-url')`, index),
    'Add dialog opens',
  );
  await fill('#quick-navigate-name', name, index);
  await fill('#quick-navigate-url', url, index);
  await click('.quick-navigate-editor button[type="submit"]', index);
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('.quick-navigate-card')`, index),
    'Link saved',
  );
};

try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => (await windowCount()) > 0, 'Browser opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Browser ready',
  );
  await settings({
    animationsEnabled: false,
    disableNewTabIntro: true,
    showQuickNavigate: true,
    nativeTextFieldContextMenu: false,
  });
  await newTab();
  await openBackgroundMenu();
  assert.ok((await command<string[]>('menu-snapshot')).includes('Add Quick Navigate link'), 'Background uses a native menu');
  assert.equal(await evaluate(`!!document.querySelector('.mira-context-menu')`), false, 'No bordered HTML menu is shown');
  await menuItem('Add Quick Navigate link');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('#quick-navigate-url')`),
    'Background menu opens add dialog',
  );
  await fill('#quick-navigate-name', 'Profile link');
  await fill('#quick-navigate-url', url);
  await click('.quick-navigate-editor button[type="submit"]');
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('.quick-navigate-icon img')?.src.startsWith('data:image/png')`,
      ),
    'Favicon downloaded and cached',
  );
  const requestsAfterCache = iconRequests;
  await command('screenshot', { file: path.join(root, 'quick-navigate.png') });
  await click('[aria-label="Options for Profile link"]');
  await menuItem('Edit');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('#quick-navigate-name')`),
    'Edit opens',
  );
  await fill('#quick-navigate-name', 'Renamed profile link');
  await click('.quick-navigate-editor button[type="submit"]');
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('.quick-navigate-name')?.textContent==='Renamed profile link'`,
      ),
    'Rename applied',
  );
  await newTab();
  assert.equal(iconRequests, requestsAfterCache, 'New Tab uses persisted icon without downloading');
  await evaluate(`(() => {const links=JSON.parse(localStorage.getItem('mira.quick-navigate.v1'));delete links[0].favicon;localStorage.setItem('mira.quick-navigate.v1',JSON.stringify(links));location.reload();return true;})()`);
  await until(async () => await evaluate<boolean>(`document.querySelector('.quick-navigate-icon img')?.src.startsWith('data:image/png')`), 'Existing missing icons are discovered, decoded and cached');
  assert.equal(iconRequests, requestsAfterCache + 1, 'A missing cached icon is fetched from its SVG declaration');
  await click('.quick-navigate-link');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('webview')`),
    'Card navigates',
  );
  await newTab();
  await openBackgroundMenu();
  await menuItem('Hide Quick Navigate');
  await until(
    async () => await evaluate<boolean>(`!document.querySelector('.quick-navigate')`),
    'Can hide cards',
  );
  await evaluate(
    `document.querySelector('input[placeholder="Search anything..."]').closest('form').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:500}));true`,
  );
  await menuItem('Show Quick Navigate');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('.quick-navigate-card')`),
    'Can show cards',
  );
  await evaluate(
    `document.querySelector('[data-tab-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:80}));true`,
  );
  const labels = await evaluate<string[]>(
    `[...document.querySelectorAll('[role="menuitem"]')].map(button=>button.textContent.trim())`,
  );
  assert.equal(
    labels[labels.indexOf('Pin Tab') + 1],
    'Add to Quick Navigate',
    'Tab action sits directly under Pin',
  );
  await menuItem('Add to Quick Navigate');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('#quick-navigate-url')`),
    'Tab action opens dialog',
  );
  await click('.quick-navigate-editor button[type="button"]');
  await evaluate(
    `localStorage.setItem('mira.bookmarks.v1',JSON.stringify([{id:'profile-bookmark',title:'Profile bookmark only',type:'bookmark',url:${JSON.stringify(url)},createdAt:1,updatedAt:1}]));true`,
  );
  const workspace = (await invoke('workspaces-save', {
    name: 'Separate',
    icon: 'panels',
    startup: 'restore',
    urls: [],
    settings: { animationsEnabled: false },
  })) as { id: string };
  await invoke('workspaces-open', workspace.id);
  await until(async () => (await windowCount()) === 2, 'Workspace opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`, 1),
    'Workspace renderer ready',
  );
  await newTab(1);
  assert.equal(
    await evaluate(`document.querySelectorAll('.quick-navigate-card').length`, 1),
    0,
    'Workspace Quick Navigate starts blank',
  );
  await evaluate(
    `window.electron.ipcRenderer.invoke('tab-open-url-in-new-tab','mira://Bookmarks')`,
    1,
  );
  await until(
    async () =>
      await evaluate<boolean>(`document.body.textContent.includes('No bookmarks yet')`, 1),
    'Workspace bookmarks start blank',
  );
  await evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Add Bookmark').click();true`,
    1,
  );
  await fill('input[placeholder="Title"]', 'Workspace bookmark', 1);
  await fill('input[placeholder="URL (e.g., https://example.com)"]', url, 1);
  await evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Add').click();true`,
    1,
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `!!localStorage.getItem('mira.bookmarks.v1.workspace.'+window.electron.workspaceId)`,
        1,
      ),
    'Bookmark saved to workspace collection',
  );
  assert.equal(
    await evaluate(`JSON.parse(localStorage.getItem('mira.bookmarks.v1'))[0].title`, 1),
    'Profile bookmark only',
    'Workspace does not change profile bookmarks',
  );
  await newTab(1);
  await addLink('Workspace link', 1);
  assert.equal(
    await evaluate(`document.querySelector('.quick-navigate-name').textContent`),
    'Renamed profile link',
    'Workspace does not change profile Quick Navigate',
  );
  await evaluate(`location.reload();true`, 1);
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('.quick-navigate-name')?.textContent==='Workspace link'`,
        1,
      ),
    'Workspace link survives reload',
  );
  await evaluate(
    `document.querySelector('.quick-navigate-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:500}));true`,
    1,
  );
  await menuItem('Remove', 1);
  await until(
    async () =>
      await evaluate<boolean>(`document.querySelectorAll('.quick-navigate-card').length===0`, 1),
    'Right click removes card',
  );
  assert.equal(
    await evaluate(`JSON.parse(localStorage.getItem('mira.quick-navigate.v1')).length`),
    1,
    'Profile collection remains intact',
  );
  console.log(
    `PASS: Quick Navigate add, cached favicon, navigate, rename, remove, hide/show, tab context action, reload persistence and workspace bookmark/link isolation.\nArtifacts: ${root}`,
  );
} catch (failure) {
  try {
    console.error('UI:', await evaluate(`document.body.innerText`));
  } catch {
    /* Preserve failure. */
  }
  throw failure;
} finally {
  try {
    await command('quit');
  } catch {
    /* Only stop this fixture. */
  }
  if (child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
