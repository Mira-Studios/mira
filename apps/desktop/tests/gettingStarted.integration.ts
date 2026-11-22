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
import { DatabaseSync } from 'node:sqlite';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = path.resolve(desktop, '../../.tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryRoot, 'getting-started-ui-'));
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
fs.writeFileSync(
  path.join(data, 'site-permissions.json'),
  JSON.stringify({ origins: { '127.0.0.1': { unknown: 'allow' } } }),
);
const environment = {
  ...process.env,
  MIRA_TEST_USER_DATA_DIR: data,
  MIRA_PROFILE_TEST_CONTROL: root,
  MIRA_PERMISSION_TEST: '1', MIRA_GETTING_STARTED_TEST: '1',
};
delete environment.ELECTRON_RUN_AS_NODE;
function launch(profile = 'default') {
const process = spawn(createRequire(import.meta.url)('electron') as string, [fixture, `--mira-profile=${profile}`], {
  cwd: desktop,
  env: environment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.stderr.on('data', (value) => {
  diagnostics += String(value);
});
process.stdout.on('data', (value) => {
  diagnostics += String(value);
});
return process;
}
let diagnostics = '';
let child = launch();
const extraChildren: { id: string; process: ReturnType<typeof launch> }[] = [];
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
  profile = 'default',
): Promise<T> {
  const id = randomUUID();
  fs.writeFileSync(
    path.join(root, `${profile}-command.json`),
    JSON.stringify({ id, action, ...values }),
  );
  const response = path.join(root, `${profile}-${id}.json`);
  await until(() => fs.existsSync(response), `${action} responds`);
  const result = JSON.parse(fs.readFileSync(response, 'utf8'));
  assert.ok(result.ok, result.error);
  return result.result;
}
const evaluate = <T = unknown>(code: string, index = 0) => command<T>('eval', { code, index });
const invoke = (channel: string, ...args: unknown[]) =>
  evaluate(
    `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
  );
const chooseLayout = (page: string, value: string) => evaluate(`document.querySelector('input[name="setup-${page}"][value="${value}"]').click();true`);
const atLayout = (page: string) => until(async () => await evaluate<boolean>(`document.querySelector('.getting-started-layout')?.dataset.layoutPage===${JSON.stringify(page)}`), `Layout page: ${page}`);
const footerButton = (text: string) => evaluate(`Array.from(document.querySelectorAll('.getting-started-footer button')).find(button=>button.textContent===${JSON.stringify(text)}).click();true`);
async function restart() {
  await command('quit');
  await until(() => child.exitCode !== null, 'Process exits');
  fs.rmSync(path.join(root, 'default-ready.json'), { force: true });
  child = launch();
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Restart ready');
  await until(async () => {
    try { return await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`); } catch { return false; }
  }, 'Restart renderer ready');
}

try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => {
    try { return await evaluate<boolean>(`!!document.querySelector('.getting-started')`); } catch { return false; }
  }, 'Startup guide opens for an existing user');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-browsers')`), 'Discovery finishes');
  const detected = await invoke('browser-import-detect') as { name: string; profiles: unknown[] }[];
  const names = await evaluate<string[]>(`Array.from(document.querySelectorAll('.getting-started-browser-heading strong')).map(item=>item.textContent)`);
  assert.deepEqual(names, detected.filter(browser => browser.profiles.length).map(browser => browser.name), 'Only detected browser profiles are shown');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.getting-started-profile').length`), detected.reduce((total, browser) => total + browser.profiles.length, 0), 'All detected profiles are visible without collapsing sections');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.getting-started-expand').length`), 0);
  const optionsTop = await evaluate<number>(`document.querySelector('.getting-started-import-options').getBoundingClientRect().top`);
  await evaluate(`document.querySelector('button[aria-label="Refresh browsers"]').click();true`);
  await until(async () => await evaluate<boolean>(`!document.querySelector('.getting-started-browsers')`), 'Discovery loading state appears');
  assert.equal(await evaluate<number>(`document.querySelector('.getting-started-import-options').getBoundingClientRect().top`), optionsTop, 'Destination stays anchored while loading');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-browsers')`), 'Discovery finishes');
  assert.equal(await evaluate<number>(`document.querySelector('.getting-started-import-options').getBoundingClientRect().top`), optionsTop, 'Loaded list cannot move destination controls');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('.getting-started .onboarding-header')`), false, 'No branded header');
  assert.ok(await evaluate<boolean>(`Array.from(document.querySelectorAll('.getting-started-browser-icon')).every(image=>image.complete && image.naturalWidth>0)`), 'Bundled browser logos load');
  await evaluate(`localStorage.setItem('mira.settings.browser.v1', JSON.stringify({...JSON.parse(localStorage.getItem('mira.settings.browser.v1')||'{}'),startupRestoreBehavior:'windows'}));window.dispatchEvent(new Event('mira:settings-changed'));true`);
  assert.equal(await invoke('getting-started-claim'), false, 'Only one guide claimed per launch');
  await command('screenshot', { file: path.join(root, 'import.png') });
  const bounds = await evaluate<{ left: number; right: number; contentLeft: number; contentRight: number }>(`(()=>{const footer=document.querySelector('.getting-started-footer').getBoundingClientRect();const content=document.querySelector('.onboarding-scroll').getBoundingClientRect();return {left:footer.left,right:footer.right,contentLeft:content.left,contentRight:content.right}})()`);
  assert.ok(bounds.left > 50 && Math.abs(bounds.left-bounds.contentLeft)<2 && Math.abs(bounds.right-bounds.contentRight)<2, 'Buttons align with centered content');
  await restart();
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started')`), 'Unfinished guide reopens after quitting');
  const source = path.join(root, 'import-profile'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Toolbar', children: [{ type: 'url', name: 'Fixture bookmark', url: 'https://fixture.example/' }] } } }));
  await evaluate(`localStorage.setItem('mira.bookmarks.v1',JSON.stringify([{id:'existing',title:'Existing bookmark',type:'bookmark',url:'https://existing.example/',createdAt:1,updatedAt:1}]));true`);
  const source2 = path.join(root, 'work-profile'); fs.mkdirSync(source2);
  for (const directory of [source, source2]) fs.copyFileSync(path.join(desktop, 'src/assets/browsers/chrome.png'), path.join(directory, 'Google Profile Picture.png'));
  fs.writeFileSync(path.join(source2, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Toolbar', children: [{ type: 'url', name: 'Duplicate', url: 'https://fixture.example/' }, { type: 'url', name: 'Work bookmark', url: 'https://work.example/' }, { type: 'url', name: 'Existing duplicate', url: 'https://existing.example/' }] } } }));
  const visitTime = Date.now() - 60000;
  for (const directory of [source, source2]) {
    const db = new DatabaseSync(path.join(directory, 'History'));
    db.exec('CREATE TABLE urls (url TEXT,title TEXT,last_visit_time INTEGER,hidden INTEGER)');
    db.prepare('INSERT INTO urls VALUES (?,?,?,0)').run('https://fixture.example/', 'Fixture visit', (visitTime + 11644473600000) * 1000);
    if (directory === source2) db.prepare('INSERT INTO urls VALUES (?,?,?,0)').run('https://work.example/', 'Work visit', (visitTime + 11644473600000) * 1000);
    db.close();
  }
  const choose = async (file: string) => {
    await command('picture', { file });
    await evaluate(`(document.querySelector('.browser-import-page .getting-started-folder') || document.querySelector('.getting-started-folder')).click();true`);
    await until(async () => await evaluate<boolean>(`Array.from((document.querySelector('.browser-import-page') || document).querySelectorAll('.getting-started-profile strong')).some(item=>item.textContent===${JSON.stringify(path.basename(file))})`), 'Custom profile selected');
  };
  await choose(source); await choose(source2);
  await until(async () => await evaluate<boolean>(`document.querySelectorAll('[data-browser="custom"] .getting-started-avatar img').length===2 && Array.from(document.querySelectorAll('[data-browser="custom"] .getting-started-avatar img')).every(image=>image.complete && image.naturalWidth>0)`), 'Cached profile pictures load');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.getting-started-profile[data-selected="true"]').length`), 2);
  await command('screenshot', { file: path.join(root, 'merge.png') });
  await evaluate(`document.querySelector('.getting-started-footer .onboarding-button-primary').click();true`);
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.import-feedback[role="status"]')`), 'Import success appears above destination choices');
  await footerButton('Continue');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-layout')`), 'Import advances to layout');
  assert.ok(await evaluate<boolean>(`localStorage.getItem('mira.bookmarks.v1').includes('Fixture bookmark') && localStorage.getItem('mira.bookmarks.v1').includes('Existing bookmark')`), 'Import preserves existing bookmarks');
  assert.equal(await evaluate<number>(`(()=>{const flatten=items=>items.flatMap(item=>item.children?flatten(item.children):[item]);return flatten(JSON.parse(localStorage.getItem('mira.bookmarks.v1'))).length})()`), 3, 'Both sources merge without duplicate URLs');
  assert.equal((await invoke('history-list') as { url: string }[]).filter(visit => ['https://fixture.example/', 'https://work.example/'].includes(visit.url)).length, 2, 'Merged history deduplicates visits');
  assert.deepEqual((await invoke('getting-started-state') as { completed: string[] }).completed, ['import']);
  await atLayout('tabs');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('.getting-started-description')`), false, 'No extra layout message');
  assert.ok(await evaluate<boolean>(`parseFloat(getComputedStyle(document.querySelector('.setup-preview')).borderTopWidth)>0`), 'Preview images have a border');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.setup-picture-choice .setup-preview').length`), 3, 'Every tab option has a full browser picture');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.getting-started-layout select').length`), 0, 'Layout options are visual choices');
  await command('screenshot', { file: path.join(root, 'layout-tabs.png') });
  await footerButton('Continue'); await atLayout('sidebar');
  await footerButton('Back'); await atLayout('tabs');
  await chooseLayout('tabs', 'left');
  await footerButton('Continue'); await atLayout('toolbar');
  await chooseLayout('toolbar', 'vertical-tabs');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.address-bar-in-vertical-tabs')`), 'URL bar moves into vertical tabs live');
  const proportions = await evaluate<{ rail: number; actualRail: number; top: number; actualTop: number }>(`(()=>{const preview=document.querySelector('.setup-picture-choice[data-selected="true"] .setup-preview');return {rail:Number(preview.querySelector('rect[width="280"]').getAttribute('width')),actualRail:document.querySelector('.address-bar-in-vertical-tabs').parentElement.getBoundingClientRect().width,top:Number(preview.children[1].getAttribute('height')),actualTop:document.querySelector('.browser-topbar').getBoundingClientRect().height}})()`);
  assert.equal(proportions.rail, proportions.actualRail, 'Preview vertical-tab width uses actual browser pixels');
  assert.equal(proportions.top, proportions.actualTop, 'Preview title-bar height matches the live layout');
  await command('screenshot', { file: path.join(root, 'layout-toolbar.png') });
  await footerButton('Continue'); await atLayout('sidebar');
  await chooseLayout('sidebar', 'right');
  assert.equal(await evaluate<number>(`Number(document.querySelector('.setup-picture-choice[data-selected="true"] .setup-preview rect[width="48"]').getAttribute('width'))`), await evaluate<number>(`document.querySelector('.browser-sidebar').getBoundingClientRect().width`), 'Preview collapsed sidebar matches actual width');
  await command('screenshot', { file: path.join(root, 'layout-sidebar.png') });
  await footerButton('Continue'); await atLayout('sidebar-mode');
  await chooseLayout('sidebar-mode', 'hover');
  await footerButton('Continue'); await atLayout('sidebar-tooltips');
  await chooseLayout('sidebar-tooltips', 'false');
  await footerButton('Continue'); await atLayout('bookmarks');
  await chooseLayout('bookmarks', 'bar');
  await chooseLayout('bookmarks', 'sidebar');
  await footerButton('Continue'); await atLayout('profiles');
  await chooseLayout('profiles', 'toolbar');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.profile-menu-trigger')`), 'Profile toolbar setting previews live');
  await chooseLayout('profiles', 'sidebar');
  await command('screenshot', { file: path.join(root, 'layout-profiles.png') });
  await footerButton('Continue'); await atLayout('workspaces');
  await chooseLayout('workspaces', 'sidebar');
  await footerButton('Continue'); await atLayout('recently-closed');
  await chooseLayout('recently-closed', 'sidebar');
  await until(async () => await evaluate<boolean>(`document.querySelector('.browser-sidebar')?.dataset.side==='right' && !document.querySelector('.profile-menu-trigger')`), 'Sidebar previews live and removes duplicate profile toolbar menu');
  const chosenSettings = await evaluate<string>(`localStorage.getItem('mira.settings.browser.v1')`);
  await command('screenshot', { file: path.join(root, 'layout-live.png') });
  for (let i = 0; i < 12 && await evaluate<boolean>(`!!document.querySelector('.getting-started-layout')`); i++) await footerButton('Back');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-folder')`), 'Back returns to import');
  await footerButton('Skip');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-layout')`), 'Continue returns to layout');
  assert.equal(await evaluate<string>(`localStorage.getItem('mira.settings.browser.v1')`), chosenSettings, 'Back preserves live layout choices');
  for (let i = 0; i < 10 && !await evaluate<boolean>(`document.querySelector('.getting-started-layout')?.dataset.layoutPage==='bookmarks'`); i++) await footerButton('Continue');
  await atLayout('bookmarks');
  await evaluate(`location.reload();true`);
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-layout')`), 'Reload resumes layout progress');
  await atLayout('bookmarks');
  assert.equal(await evaluate<string>(`document.querySelector('input[name="setup-bookmarks"]:checked').value`), 'sidebar', 'Saved layout survives reload');
  for (let i = 0; i < 10 && await evaluate<boolean>(`!!document.querySelector('.getting-started-layout')`); i++) await footerButton('Continue');
  await until(async () => await evaluate<boolean>(`document.querySelector('.getting-started h1')?.textContent==='Make Mira your default'`), 'Default browser follows layout');
  await footerButton('Back');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-layout')`), 'Default browser can go back to layout');
  await footerButton('Continue');
  await until(async () => await evaluate<boolean>(`document.querySelector('.getting-started h1')?.textContent==='Make Mira your default'`), 'Continue revisits default');
  await footerButton('Skip');
  await until(async () => (await invoke('getting-started-state') as { completed: string[] }).completed.length === 3, 'Skipped steps complete guide');
  await until(async () => await evaluate<boolean>(`!document.querySelector('.getting-started')`), 'Completing returns to new tab');
  await restart();
  assert.equal(await invoke('getting-started-claim'), false, 'Completed guide stays completed after restart');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('.getting-started')`), false);
  // A fresh import pass exercises the separate-profile option through the UI.
  fs.writeFileSync(path.join(data, 'Profiles/default/getting-started.v1.json'), JSON.stringify({ version: 1, completed: [], dismissed: false }));
  await invoke('tab-open-url-in-new-tab', 'mira://GettingStarted');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-folder') && !!document.querySelector('.getting-started-browsers')`), 'Import page reopens');
  await choose(source); await choose(source2);
  await evaluate(`document.querySelector('input[name="import-mode"][value="profiles"]').click();true`);
  await command('screenshot', { file: path.join(root, 'separate-profiles.png') });
  await evaluate(`document.querySelector('.getting-started-footer .onboarding-button-primary').click();true`);
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.import-feedback[role="status"]')`), 'Created-profile confirmation appears');
  await footerButton('Continue');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.getting-started-layout')`), 'Separate-profile import advances to layout');
  const created = (await invoke('profiles-list') as { profiles: { id: string; name: string; avatar?: string }[] }).profiles.filter(profile => profile.id !== 'default');
  assert.equal(created.length, 2, 'One Mira profile per selected source');
  assert.ok(created.every(profile => profile.avatar?.startsWith('data:image/png;base64,')), 'New Mira profiles retain source pictures');
  const currentBookmarks = await evaluate<string>(`localStorage.getItem('mira.bookmarks.v1')`);
  for (const profile of created) {
    const process = launch(profile.id); extraChildren.push({ id: profile.id, process });
    await until(() => fs.existsSync(path.join(root, `${profile.id}-ready.json`)), 'Imported profile process ready');
    const read = <T = unknown>(code: string) => command<T>('eval', { code }, profile.id);
    await until(async () => {
      try { return await read<boolean>(`!!document.querySelector('.getting-started')`); } catch { return false; }
    }, 'Imported profile renderer ready');
    const content = await read<string>(`localStorage.getItem('mira.bookmarks.v1')`);
    assert.ok(content.includes(profile.name.includes('work-profile') ? 'Work bookmark' : 'Fixture bookmark'));
    if (!profile.name.includes('work-profile')) assert.ok(!content.includes('Work bookmark'), 'Profiles remain isolated');
    const visits = await read<{ url: string }[]>(`window.electron.ipcRenderer.invoke('history-list')`);
    assert.equal(visits.length, profile.name.includes('work-profile') ? 2 : 1, 'Imported history belongs to its source profile');
    assert.equal(await read<string>(`document.querySelector('.getting-started-layout').dataset.layoutPage`), 'tabs', 'Imported profile skips import and starts layout');
    await read(`location.reload();true`);
    await until(async () => { try { return await read<boolean>(`!!document.querySelector('.getting-started')`); } catch { return false; } }, 'Imported profile reloads');
    assert.equal(await read<string>(`localStorage.getItem('mira.bookmarks.v1')`), content, 'Bookmark seed applies once');
    await command('quit', {}, profile.id);
    await until(() => process.exitCode !== null, 'Imported profile exits');
  }
  assert.equal(await evaluate<string>(`localStorage.getItem('mira.bookmarks.v1')`), currentBookmarks, 'Creating profiles leaves current data intact');
  const setupBeforeImport = await invoke('getting-started-state');
  await invoke('tab-open-url-in-new-tab', 'mira://Settings?section=general');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('button[aria-label="Import browser data"]')`), 'Settings exposes browser import');
  await evaluate(`document.querySelector('button[aria-label="Import browser data"]').click();true`);
  await until(async () => await evaluate<boolean>(`document.querySelector('.browser-import-page h1')?.textContent==='Import browser data' && !!document.querySelector('.browser-import-page .getting-started-browsers')`), 'Settings opens standalone importer');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('.browser-import-page .getting-started-progress-heading')`), false, 'Settings import has no onboarding progress');
  const importedFile = JSON.parse(fs.readFileSync(path.join(source, 'Bookmarks'), 'utf8'));
  importedFile.roots.bookmark_bar.children.push({ type: 'url', name: 'Settings import bookmark', url: 'https://settings-import.example/' });
  fs.writeFileSync(path.join(source, 'Bookmarks'), JSON.stringify(importedFile));
  await choose(source);
  await evaluate(`document.querySelector('.browser-import-page .getting-started-footer .onboarding-button-primary').click();true`);
  await until(async () => await evaluate<boolean>(`document.querySelector('.browser-import-page h1')?.textContent==='Import browser data' && document.querySelector('.browser-import-page [role="status"]')?.textContent.includes('Imported') && localStorage.getItem('mira.bookmarks.v1').includes('Settings import bookmark')`), 'Settings import saves bookmarks and stays in importer');
  assert.deepEqual(await invoke('getting-started-state'), setupBeforeImport, 'Settings import never changes setup progress');
  await command('screenshot', { file: path.join(root, 'settings-import.png') });
  const destinationTop = await evaluate<number>(`document.querySelector('.browser-import-page .getting-started-destinations').getBoundingClientRect().top`);
  assert.ok(await evaluate<boolean>(`(()=>{const notice=document.querySelector('.browser-import-page .import-feedback').getBoundingClientRect();const choices=document.querySelector('.browser-import-page .getting-started-destinations').getBoundingClientRect();return notice.bottom<=choices.top})()`), 'Notification sits above merge/new-profile selection');
  await until(async () => await evaluate<boolean>(`!document.querySelector('.browser-import-page .import-feedback')`), 'Import success automatically disappears', 8000);
  assert.equal(await evaluate<number>(`document.querySelector('.browser-import-page .getting-started-destinations').getBoundingClientRect().top`), destinationTop, 'Notification does not move destination controls');
  fs.writeFileSync(path.join(source, 'Bookmarks'), '{invalid json');
  await choose(source);
  await evaluate(`document.querySelector('.browser-import-page .getting-started-footer .onboarding-button-primary').click();true`);
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.browser-import-page .import-feedback[role="alert"]')`), 'Import errors use the same bottom notification');
  await command('screenshot', { file: path.join(root, 'settings-import-error.png') });
  await until(async () => await evaluate<boolean>(`!document.querySelector('.browser-import-page .import-feedback')`), 'Import error automatically disappears', 8000);
  fs.writeFileSync(path.join(source, 'Bookmarks'), JSON.stringify(importedFile));
  await footerButton('Settings');
  await until(async () => await evaluate<boolean>(`!!document.querySelector('button[aria-label="Import browser data"]')`), 'Importer returns to Settings');
  console.log(`PASS: detected-only import, multi-source merge, isolated profile creation, visual layout pages, conditional toolbar/sidebar steps, live settings, Back navigation, page resumption, and default-browser completion. Artifacts: ${root}`);
} catch (error) {
  try { console.error(await evaluate('document.body.innerText')); } catch { /* Preserve failure. */ }
  throw error;
} finally {
  for (const extra of extraChildren) { if (extra.process.exitCode === null) { try { await command('quit', {}, extra.id); } catch { /* Fixture only. */ } if (extra.process.exitCode === null) extra.process.kill(); } }
  try { await command('quit'); } catch { /* Fixture only. */ }
  if (child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}


