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
const root = fs.mkdtempSync(path.join(temporaryRoot, 'sidebar-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-sidebar-test',
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
const pointer = (type: string) =>
  evaluate(
    `document.querySelector('.browser-sidebar').dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, relatedTarget: document.body })); true`,
  );
const expanded = () =>
  evaluate<string>(`document.querySelector('.browser-sidebar').dataset.expanded`);
const sections = () =>
  evaluate<string[]>(
    `[...document.querySelectorAll('[data-sidebar-section]')].map(section => section.dataset.sidebarSection)`,
  );
async function assertOpeningAnimation(selector: string, label: string, expected = true) {
  const samples = await evaluate<
    Array<{ id: string; width: number; opacity: number }>
  >(`new Promise(resolve => {
    const existing = new Set([...document.querySelectorAll('[data-tab-id]')].map(tab => tab.dataset.tabId));
    const samples = [];
    const started = performance.now();
    const sample = () => {
      for (const tab of document.querySelectorAll('[data-tab-id]')) {
        if (!existing.has(tab.dataset.tabId)) samples.push({id: tab.dataset.tabId, width: tab.getBoundingClientRect().width, opacity: Number(getComputedStyle(tab).opacity)});
      }
      if (performance.now() - started >= 400) resolve(samples);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    document.querySelector(${JSON.stringify(selector)}).click();
  })`);
  assert.ok(samples.length, `${label}: a new tab appears`);
  const widths = samples.map((sample) => sample.width);
  const opacities = samples.map((sample) => sample.opacity);
  const animated =
    Math.max(...widths) - Math.min(...widths) > 10 ||
    Math.max(...opacities) - Math.min(...opacities) > 0.2;
  assert.equal(
    animated,
    expected,
    `${label}: opening ${expected ? 'animates' : 'is immediate'} (width ${Math.min(...widths)}–${Math.max(...widths)}, opacity ${Math.min(...opacities)}–${Math.max(...opacities)})`,
  );
}
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Desktop starts');
  await until(
    async () => (await command<{ windows: number[] }>('snapshot')).windows.length > 0,
    'Browser window opens',
  );
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Shell renders',
  );
  const bookmarks = [
    {
      id: 'one',
      title: 'Sidebar bookmark',
      type: 'bookmark',
      url,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'folder',
      title: 'Folder',
      type: 'folder',
      children: [
        {
          id: 'child',
          title: 'Child bookmark',
          type: 'bookmark',
          url: `${url}?child`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
  await evaluate(
    `localStorage.setItem('mira.bookmarks.v1', ${JSON.stringify(JSON.stringify(bookmarks))}); setTimeout(() => location.reload(), 50); true`,
  );
  await delay(200);
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Reload completes',
  );
  await settings({
    sidebarEnabled: true,
    sidebarMode: 'collapsed',
    sidebarSide: 'left',
    sidebarSections: ['bookmarks', 'profiles', 'recently-closed'],
    showBookmarksBar: true,
  });
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.browser-sidebar [aria-label="Sidebar bookmark"]')`,
      ),
    'Sidebar loads existing bookmarks',
  );
  assert.equal(await expanded(), 'false');
  assert.deepEqual(await sections(), ['bookmarks', 'profiles', 'recently-closed']);
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.browser-sidebar .browser-sidebar-label')).display`,
    ),
    'none',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.browser-sidebar [aria-label="Sidebar bookmark"]').title`,
    ),
    '',
  );
  await evaluate(
    `document.querySelector('.browser-sidebar [aria-label="Sidebar bookmark"]').dispatchEvent(new MouseEvent('mouseover', {bubbles:true, relatedTarget:document.body})); true`,
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('[role="tooltip"]')?.textContent === 'Sidebar bookmark'`,
      ),
    'Custom tooltip appears',
  );
  await settings({ animationsEnabled: true });
  await delay(150);
  await evaluate(`window.__sidebarTooltip = document.querySelector('[role="tooltip"]');
    const first = document.querySelector('.browser-sidebar [aria-label="Sidebar bookmark"]');
    const next = document.querySelector('.browser-sidebar [aria-label="Folder"]');
    first.dispatchEvent(new MouseEvent('mouseout', {bubbles:true, relatedTarget:next}));
    next.dispatchEvent(new MouseEvent('mouseover', {bubbles:true, relatedTarget:first})); true`);
  assert.equal(
    await evaluate(`document.querySelector('[role="tooltip"]') === window.__sidebarTooltip`),
    true,
    'Switching items keeps the same tooltip mounted',
  );
  assert.equal(
    await evaluate(`document.querySelector('[role="tooltip"]').textContent`),
    'Folder',
    'Tooltip changes without a new delay',
  );
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('[role="tooltip"]')).opacity`),
    '1',
    'Switching items does not fade',
  );
  await evaluate(
    `document.querySelector('.browser-sidebar [aria-label="Sidebar bookmark"]').dispatchEvent(new MouseEvent('mouseover', {bubbles:true, relatedTarget:document.body})); true`,
  );
  await command('screenshot', { file: path.join(root, 'sidebar-tooltip.png') });
  await settings({ sidebarShowTooltips: false });
  assert.equal(await evaluate(`!!document.querySelector('[role="tooltip"]')`), false);
  assert.equal(
    await evaluate(
      `document.querySelector('.browser-sidebar [aria-label="Sidebar bookmark"]').hasAttribute('data-sidebar-tooltip')`,
    ),
    false,
  );
  await settings({ sidebarShowTooltips: true });
  const bottomToggle = await evaluate<{ toggle: number; content: number }>(
    `({ toggle: document.querySelector('.browser-sidebar-toggle').getBoundingClientRect().top, content: document.querySelector('.browser-sidebar-sections').getBoundingClientRect().bottom })`,
  );
  assert.ok(bottomToggle.toggle >= bottomToggle.content, 'Expand/collapse lives in the footer');
  await click('.browser-sidebar [aria-label="Folder"]');
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.browser-sidebar [aria-label="Folder / Child bookmark"]')`,
      ),
    'Folders expand in collapsed mode',
  );
  await click('.browser-sidebar [aria-label="Expand sidebar"]');
  assert.equal(await expanded(), 'true');
  await evaluate(
    `document.querySelector('.browser-sidebar [aria-label="Sidebar bookmark"]').dispatchEvent(new MouseEvent('mouseover', {bubbles:true, relatedTarget:document.body})); true`,
  );
  await delay(300);
  assert.equal(
    await evaluate(`!!document.querySelector('[role="tooltip"]')`),
    false,
    'Expanded sidebar never shows tooltips',
  );
  await settings({ animationsEnabled: false });
  await pointer('mouseout');
  assert.equal(await expanded(), 'true', 'Always open survives pointer leaving');
  await command('screenshot', { file: path.join(root, 'sidebar-expanded.png') });
  await settings({ animationsEnabled: true });
  await assertOpeningAnimation(
    '.browser-sidebar [aria-label="Sidebar bookmark"]',
    'Sidebar bookmark',
  );
  await settings({ animationsEnabled: false });
  await until(
    async () =>
      await evaluate<boolean>(`!!document.querySelector('webview')?.getWebContentsId?.()`),
    'Bookmark opens a web page',
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('webview').executeJavaScript("!!document.querySelector('#state')")`,
      ),
    'Bookmark page loads',
  );
  const contentsId = await evaluate<number>(`document.querySelector('webview').getWebContentsId()`);
  await evaluate(
    `document.querySelector('webview').executeJavaScript("document.querySelector('#state').value='preserved'; true")`,
  );
  await settings({ sidebarSide: 'right', sidebarMode: 'hover' });
  await evaluate(`document.activeElement?.blur(); true`);
  await pointer('mouseout');
  assert.equal(await expanded(), 'false');
  await pointer('mouseover');
  assert.equal(await expanded(), 'true', 'Hover expands');
  await pointer('mouseout');
  assert.equal(await expanded(), 'false', 'Leaving collapses');
  await evaluate(`document.querySelector('.browser-sidebar button').focus(); true`);
  assert.equal(await expanded(), 'true', 'Keyboard focus expands');
  await evaluate(`document.activeElement.blur(); true`);
  assert.equal(await expanded(), 'false', 'Leaving keyboard focus collapses');
  await settings({ sidebarMode: 'collapsed' });
  await pointer('mouseover');
  assert.equal(await expanded(), 'false', 'Always collapsed ignores hover');
  const geometry = await evaluate<{ sidebar: number; page: number }>(
    `({sidebar: document.querySelector('.browser-sidebar').getBoundingClientRect().left, page: document.querySelector('webview').getBoundingClientRect().right})`,
  );
  assert.ok(geometry.sidebar >= geometry.page - 1, 'Right sidebar sits after page');
  assert.equal(await evaluate(`document.querySelector('webview').getWebContentsId()`), contentsId);
  assert.equal(
    await evaluate(
      `document.querySelector('webview').executeJavaScript("document.querySelector('#state').value")`,
    ),
    'preserved',
  );
  await settings({
    sidebarSections: ['recently-closed', 'bookmarks'],
    sidebarSectionOrder: ['recently-closed', 'bookmarks', 'profiles'],
  });
  assert.deepEqual(await sections(), ['recently-closed', 'bookmarks']);
  await invoke('recently-closed-add-tabs', {
    tabs: [
      {
        id: 'closed',
        url: `${url}?closed`,
        title: 'Closed page',
        history: [`${url}?closed`],
        historyIndex: 0,
        reloadToken: 0,
        isSleeping: false,
        lastActiveAt: Date.now(),
      },
    ],
  });
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.browser-sidebar [aria-label="Restore Closed page"]')`,
      ),
    'Recently closed updates live',
  );
  await settings({ animationsEnabled: true });
  await assertOpeningAnimation(
    '.browser-sidebar [aria-label="Restore Closed page"]',
    'Sidebar recently closed',
  );
  for (const position of ['left', 'right']) {
    await settings({ tabStripPosition: position });
    await until(
      async () =>
        await evaluate<boolean>(
          `document.querySelector('.tab-animations-enabled')?.style.flexDirection === 'column'`,
        ),
      `${position} tab strip is ready`,
    );
    await delay(250);
    await assertOpeningAnimation(
      '.browser-sidebar [aria-label="Sidebar bookmark"]',
      `${position} sidebar bookmark`,
    );
    await invoke('recently-closed-add-tabs', {
      tabs: [
        {
          id: `closed-${position}`,
          url: `${url}?closed=${position}`,
          title: `Closed ${position}`,
          history: [`${url}?closed=${position}`],
          historyIndex: 0,
          reloadToken: 0,
          isSleeping: false,
          lastActiveAt: Date.now(),
        },
      ],
    });
    await until(
      async () =>
        await evaluate<boolean>(
          `!!document.querySelector('.browser-sidebar [aria-label="Restore Closed ${position}"]')`,
        ),
      `${position} closed entry is ready`,
    );
    await assertOpeningAnimation(
      `.browser-sidebar [aria-label="Restore Closed ${position}"]`,
      `${position} sidebar restore`,
    );
  }
  await settings({ tabStripPosition: 'top', animationsEnabled: false });
  await delay(250);
  await assertOpeningAnimation(
    '.browser-sidebar [aria-label="Sidebar bookmark"]',
    'Sidebar bookmark with animations off',
    false,
  );
  await settings({ animationsEnabled: false });
  await until(
    async () =>
      await evaluate<boolean>(
        `!document.querySelector('.browser-sidebar [aria-label="Restore Closed page"]')`,
      ),
    'Closed tab restores',
  );
  await settings({
    sidebarSections: ['profiles', 'bookmarks', 'recently-closed'],
    sidebarSectionOrder: ['profiles', 'bookmarks', 'recently-closed'],
    sidebarMode: 'expanded',
  });
  assert.equal(await evaluate(`!!document.querySelector('.profile-menu-trigger')`), false);
  await invoke('window-new-private');
  await until(
    async () =>
      await evaluate<boolean>(
        `!!document.querySelector('.browser-sidebar') && window.electron.isPrivate`,
        1,
      ),
    'Private sidebar opens',
  );
  assert.equal(
    await evaluate(`!!document.querySelector('[data-sidebar-section="profiles"]')`, 1),
    false,
  );
  await evaluate(
    `setTimeout(() => window.electron.ipcRenderer.invoke('window-close'), 50); true`,
    1,
  );
  await delay(200);
  await invoke('tab-open-url-in-new-tab', 'mira://Settings#section=layout');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('#sidebar-mode')`),
    'Layout exposes sidebar settings',
  );
  await click('[aria-label="Move Profiles down"]');
  assert.deepEqual(await sections(), ['bookmarks', 'profiles', 'recently-closed']);
  await click('#sidebar-section-profiles');
  assert.deepEqual(await sections(), ['bookmarks', 'recently-closed']);
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('.sidebar-section-controls input')].map(input => input.id)`,
    ),
    ['sidebar-section-bookmarks', 'sidebar-section-profiles', 'sidebar-section-recently-closed'],
    'Disabling a section does not reorder settings rows',
  );
  await click('[aria-label="Move Profiles down"]');
  await click('#sidebar-section-profiles');
  assert.deepEqual(
    await sections(),
    ['bookmarks', 'recently-closed', 'profiles'],
    'Disabled sections can be positioned before re-enabling',
  );
  await command('screenshot', { file: path.join(root, 'sidebar-settings.png') });
  await settings({ sidebarMode: 'collapsed', sidebarSide: 'right' });
  await command('screenshot', { file: path.join(root, 'sidebar-collapsed.png') });
  await settings({ sidebarEnabled: false });
  assert.equal(await evaluate(`!!document.querySelector('.browser-sidebar')`), false);
  await click('[title="Menu"]');
  await evaluate(
    `[...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent.includes('Show Sidebar')).click(); true`,
  );
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('.browser-sidebar')`),
    'Main menu toggles sidebar',
  );
  assert.equal(await expanded(), 'false');
  assert.equal(await evaluate(`document.querySelector('.browser-sidebar').dataset.side`), 'right');
  await click('#settings-tab-general');
  await delay(250);
  const stickySettings = await evaluate<{
    before: number;
    after: number;
    scroll: number;
    gutter: string;
    branded: boolean;
  }>(`new Promise(resolve => {
    const page = [...document.querySelectorAll('.settings-redesign')].find(page => page.getBoundingClientRect().width > 0 && getComputedStyle(page.closest('.internal-page-scroll').parentElement).visibility === 'visible');
    const scroller = page.closest('.internal-page-scroll');
    const sidebar = page.querySelector('.settings-sidebar');
    scroller.scrollTop = 0;
    requestAnimationFrame(() => {
      const before = sidebar.getBoundingClientRect().top;
      scroller.scrollTop = 320;
      requestAnimationFrame(() => resolve({ before, after: sidebar.getBoundingClientRect().top, scroll: scroller.scrollTop, gutter: getComputedStyle(scroller).scrollbarGutter, branded: !!sidebar.querySelector('.settings-brand-icon') && !!sidebar.querySelector('.settings-brand-wordmark') && !!sidebar.querySelector('.settings-brand-version')?.textContent }));
    });
  })`);
  assert.ok(stickySettings.scroll >= 320, 'Settings content scrolls');
  assert.ok(
    Math.abs(stickySettings.before - stickySettings.after) < 1,
    'Settings sidebar stays sticky',
  );
  assert.equal(stickySettings.gutter, 'stable', 'Settings reserves scrollbar space');
  assert.ok(stickySettings.branded, 'Settings sidebar includes Mira branding and version');
  await click('#settings-tab-layout');
  await click('[aria-label="Reload"]');
  await delay(350);
  assert.equal(
    await evaluate(`document.querySelector('#settings-tab-layout').getAttribute('aria-selected')`),
    'true',
    'Reload preserves the Settings section parameter',
  );
  await settings({ animationsEnabled: true });
  await assertOpeningAnimation(
    '.browser-sidebar [aria-label="Sidebar settings"]',
    'Sidebar settings link',
  );
  console.log(
    `PASS: sections, bookmarks/folders, recently closed restore, profile privacy, left/right layout, collapsed/open/hover/focus behavior, page-state preservation, settings and main-menu toggle.\nArtifacts: ${root}`,
  );
} finally {
  try {
    await command('quit');
  } catch {
    /* Stop only the isolated fixture below. */
  }
  if (child.exitCode === null) child.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
