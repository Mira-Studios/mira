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
const root = fs.mkdtempSync(path.join(temporaryRoot, 'vertical-address-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-vertical-address-test',
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
const rect = (selector: string) =>
  evaluate<{ left: number; right: number; top: number; bottom: number; width: number }>(
    `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`,
  );
const blur = () => evaluate(`document.querySelector('input[role="combobox"]').blur();true`);
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => (await count()) > 0, 'Browser opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Renderer ready',
  );
  await settings({
    animationsEnabled: false,
    sidebarEnabled: true,
    sidebarMode: 'expanded',
    sidebarSections: ['bookmarks'],
    tabStripPosition: 'left',
    addressBarPosition: 'vertical-tabs',
  });
  await invoke('tab-open-url-in-new-tab', url);
  await until(async () => {
    try {
      return await evaluate<boolean>(
        `document.querySelector('webview')?.executeJavaScript("!!document.querySelector('#state')")`,
      );
    } catch {
      return false;
    }
  }, 'Fixture ready');
  const guestId = await evaluate<number>(`document.querySelector('webview').getWebContentsId()`);
  await evaluate(
    `document.querySelector('webview').executeJavaScript("document.querySelector('#state').value='preserved'");true`,
  );
  for (const tabsSide of ['left', 'right']) {
    for (const sidebarSide of ['left', 'right']) {
      await settings({
        tabStripPosition: tabsSide,
        sidebarSide,
        addressBarPosition: 'vertical-tabs',
      });
      await until(
        async () =>
          await evaluate<boolean>(
            `document.querySelector('.address-bar-in-vertical-tabs')?.dataset.side===${JSON.stringify(tabsSide)} && document.querySelector('.browser-sidebar')?.dataset.side===${JSON.stringify(sidebarSide)}`,
          ),
        'Requested placement applies',
      );
      await blur();
      const bar = await rect('.address-bar-in-vertical-tabs');
      const pane = await evaluate<{ left: number; right: number; width: number }>(
        `document.querySelector('.address-bar-in-vertical-tabs').parentElement.getBoundingClientRect().toJSON()`,
      );
      const sidebar = await rect('.browser-sidebar');
      const viewport = await evaluate<number>('window.innerWidth');
      assert.equal(pane.width, 280, 'Vertical tab panel is wider');
      if (sidebarSide === 'left')
        assert.equal(sidebar.left, 0, 'Sidebar is the outermost left surface');
      else
        assert.ok(Math.abs(sidebar.right - viewport) < 1, 'Sidebar is the outermost right surface');
      const inputBefore = await rect('input[role="combobox"]');
      const reload = await rect('.address-bar-in-vertical-tabs [aria-label="Reload"]');
      assert.ok(inputBefore.top >= reload.bottom, 'URL field sits below controls');
      const back = await rect('.address-bar-in-vertical-tabs [title="Back"]');
      const mainMenu = await rect('.address-bar-in-vertical-tabs [title="Menu"]');
      assert.ok(Math.abs(back.left - bar.left - 6) < 1, 'Navigation controls are on the left');
      assert.ok(Math.abs(mainMenu.right - bar.right + 6) < 1, 'Menu controls are on the right');
      assert.equal(
        await evaluate(`document.querySelector('.tab-new-tab-vertical').textContent.trim()`),
        'New tab',
      );
      assert.equal(
        await evaluate(
          `getComputedStyle(document.querySelector('.tab-new-tab-vertical')).borderTopWidth`,
        ),
        '0px',
        'New tab row has no border',
      );
      assert.equal(
        await evaluate(
          `getComputedStyle(document.querySelector('.tab-new-tab-vertical')).justifyContent`,
        ),
        'flex-start',
        'New tab row is left aligned',
      );
      assert.equal(
        await evaluate(`!!document.querySelector('.theme-tab-selected .tab-connection-vertical')`),
        false,
        'Selected vertical tab has no connection into the page',
      );
      const selected = await rect('[data-tab-id].theme-tab-selected');
      assert.ok(
        selected.left >= pane.left && selected.right <= pane.right,
        'Selected tab stays inside its panel',
      );
      await command('shortcut', { value: 'focus-address-bar' });
      await until(
        async () =>
          await evaluate<boolean>(
            `document.activeElement===document.querySelector('input[role="combobox"]') && document.querySelector('input[role="combobox"]').getBoundingClientRect().width>400`,
          ),
        'Focused address expands outward',
      );
      const expanded = await rect('input[role="combobox"]');
      assert.ok(
        expanded.left >= 0 && expanded.right <= viewport,
        'Expanded address stays within window',
      );
      if (tabsSide === 'left') {
        assert.ok(Math.abs(expanded.left - inputBefore.left) < 1);
        assert.ok(expanded.right > bar.right);
      } else {
        assert.ok(Math.abs(expanded.right - inputBefore.right) < 1);
        assert.ok(expanded.left < bar.left);
      }
      assert.equal(
        await evaluate(
          `document.querySelector('.address-bar-in-vertical-tabs').parentElement.getBoundingClientRect().width`,
        ),
        280,
        'Editing never changes panel width',
      );
      if (tabsSide === sidebarSide)
        await command('screenshot', { file: path.join(root, `${tabsSide}-active.png`) });
      await blur();
      await until(
        async () => (await rect('input[role="combobox"]')).width === inputBefore.width,
        'URL field shrinks on blur',
      );
      if (tabsSide === sidebarSide)
        await command('screenshot', { file: path.join(root, `${tabsSide}-idle.png`) });
      assert.equal(
        await evaluate(`document.querySelector('webview').getWebContentsId()`),
        guestId,
        'Layout changes keep the existing page guest',
      );
      assert.equal(
        await evaluate(
          `document.querySelector('webview').executeJavaScript("document.querySelector('#state').value")`,
        ),
        'preserved',
        'Page state remains intact',
      );
    }
  }
  await settings({
    tabStripPosition: 'left',
    sidebarSide: 'left',
    addressBarPosition: 'vertical-tabs',
  });
  await evaluate(`document.querySelector('[title="Menu"]').click();true`);
  const menu = await rect('.address-menu-panel');
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.address-menu-panel')).transformOrigin`,
    ),
    '0px 0px',
    'Left-panel menu animates from its trigger side',
  );
  assert.ok(
    menu.left >= 0 && menu.right <= (await evaluate<number>('window.innerWidth')),
    'Sidebar menu is not clipped',
  );
  await evaluate(`document.querySelector('[title="Menu"]').click();true`);
  // A pending permission follows the active source even if the address bar remounts.
  await command('permission-request', { value: 'geolocation', webContentsId: guestId });
  await until(
    async () =>
      await evaluate<boolean>(`!!document.querySelector('#site-permission-prompt-message')`),
    'Permission visible',
  );
  await settings({ addressBarPosition: 'toolbar' });
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('#site-permission-prompt-message') && !document.querySelector('.address-bar-in-vertical-tabs')`,
      ),
    'Pending permission survives placement change',
  );
  await evaluate(
    `document.querySelector('[aria-label="Dismiss permission request"]').click();true`,
  );
  await settings({ addressBarPosition: 'vertical-tabs' });
  await until(
    async () =>
      await evaluate<boolean>(`!!document.querySelector('.address-bar-in-vertical-tabs')`),
    'Return to panel',
  );
  await evaluate(`document.querySelector('.tab-new-tab-vertical').click();true`);
  await until(
    async () =>
      await evaluate<boolean>(
        `document.activeElement===document.querySelector('input[role="combobox"]') && document.querySelector('input[role="combobox"]').value===''`,
      ),
    'New tab focuses an empty URL field',
  );
  assert.ok(
    (await rect('input[role="combobox"]')).width < 300,
    'Empty URL field does not expand on focus',
  );
  const type = (value: string) =>
    evaluate(
      `(() => {const input=document.querySelector('input[role="combobox"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
  await type('example');
  await until(
    async () => (await rect('input[role="combobox"]')).width > 400,
    'Typing expands the empty URL field',
  );
  await type('');
  await until(
    async () => (await rect('input[role="combobox"]')).width < 300,
    'Clearing the field removes outward expansion',
  );
  await settings({ tabStripPosition: 'top' });
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.address-bar:not(.address-bar-in-topbar):not(.address-bar-in-vertical-tabs)')`,
      ),
    'Horizontal tabs fall back to toolbar',
  );
  await invoke('tab-open-url-in-new-tab', 'mira://Settings#section=layout');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('#address-bar-position')`),
    'Layout setting appears',
  );
  assert.deepEqual(
    await evaluate(
      `[...document.querySelector('#address-bar-position').options].map(option=>option.value)`,
    ),
    ['toolbar', 'topbar', 'vertical-tabs'],
    'Sidebar is not a URL-bar option',
  );
  console.log(
    `PASS: vertical URL bar under controls, outward focus expansion, outer sidebar on all four side combinations, wider separate tabs, page-state preservation, permission replay and layout settings.\nArtifacts: ${root}`,
  );
} catch (failure) {
  try {
    console.error('Layout UI:', await evaluate(`document.body.innerText`));
  } catch {
    /* Preserve failure. */
  }
  throw failure;
} finally {
  try {
    await command('quit');
  } catch {
    /* Fixture only. */
  }
  if (child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
