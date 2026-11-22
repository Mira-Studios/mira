import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const tempRoot = path.resolve(desktop, '../../.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(tempRoot, 'profiles-ui-'));
const data = path.join(directory, 'data');
const fixtureApp = path.join(directory, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixtureApp);
const worker = fileURLToPath(new URL('profileWorker.electron.ts', import.meta.url));
fs.writeFileSync(
  path.join(fixtureApp, 'package.json'),
  JSON.stringify({ name: 'mira-profile-test', type: 'module', main: worker }),
);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(path.join(data, 'migration-probe.json'), 'legacy data');
const tab = (id: string) => ({
  id,
  url: 'mira://NewTab',
  title: id,
  history: ['mira://NewTab'],
  historyIndex: 0,
  reloadToken: 0,
  isPinned: true,
  isSleeping: false,
  lastActiveAt: Date.now(),
});
fs.writeFileSync(
  path.join(data, 'session.json'),
  JSON.stringify({
    windows: ['legacy-one', 'legacy-two'].map((id) => ({
      tabs: [tab(id)],
      activeId: id,
      savedAt: Date.now(),
    })),
    savedAt: Date.now(),
  }),
);
const electron = createRequire(import.meta.url)('electron') as string;
const environment = {
  ...process.env,
  MIRA_TEST_USER_DATA_DIR: data,
  MIRA_PROFILE_TEST_CONTROL: directory,
};
delete environment.ELECTRON_RUN_AS_NODE;
let diagnostics = '';
const children: ChildProcess[] = [];
const start = (args: string[] = []) => {
  const child = spawn(electron, [fixtureApp, ...args], {
    cwd: desktop,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => {
    diagnostics += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    diagnostics += String(chunk);
  });
  child.on('error', (error) => {
    diagnostics += String(error);
  });
  child.on('exit', (code, signal) => {
    diagnostics += `\nFixture exited ${code} ${signal}`;
  });
  children.push(child);
};
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${message}\n${diagnostics.slice(-4000)}`);
    await delay(80);
  }
}
async function command<T = unknown>(
  profile: string,
  action: string,
  values: Record<string, unknown> = {},
  timeout = 20_000,
): Promise<T> {
  const id = randomUUID();
  const file = path.join(directory, `${profile}-command.json`);
  fs.writeFileSync(file, JSON.stringify({ id, action, ...values }));
  const response = path.join(directory, `${profile}-${id}.json`);
  await until(() => fs.existsSync(response), `${profile} ${action} responds`, timeout);
  const result = JSON.parse(fs.readFileSync(response, 'utf8'));
  assert.ok(result.ok, result.error);
  return result.result;
}
const evaluate = <T = unknown>(profile: string, code: string, index = 0) =>
  command<T>(profile, 'eval', { code, index });
const click = (profile: string, selector: string) =>
  evaluate(profile, `document.querySelector(${JSON.stringify(selector)}).click(); true`);
const ready = async (id: string, picker = false) => {
  await until(
    () => fs.existsSync(path.join(directory, `${id}-ready.json`)),
    `${id} process starts`,
  );
  await until(async () => {
    try {
      return await evaluate<boolean>(
        id,
        `!!document.querySelector(${JSON.stringify(picker ? '.profile-picker' : '[data-tab-id]')})`,
      );
    } catch {
      return false;
    }
  }, `${id} renderer starts`);
};
const invoke = (profile: string, channel: string, ...args: unknown[]) =>
  evaluate(
    profile,
    `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
  );
const settings = (profile: string, value: Record<string, unknown>) =>
  evaluate(
    profile,
    `localStorage.setItem('mira.settings.browser.v1', JSON.stringify({...JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'), ...${JSON.stringify(value)}})); window.dispatchEvent(new Event('mira:settings-changed')); true`,
  );
const input = (profile: string, value: string) =>
  evaluate(
    profile,
    `(() => { const el = document.querySelector('#profile-editor-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`,
  );

try {
  start();
  await ready('default');
  assert.equal(
    fs.readFileSync(path.join(data, 'Profiles/default/migration-probe.json'), 'utf8'),
    'legacy data',
  );
  await until(
    async () =>
      await evaluate<boolean>(
        'default',
        `[...document.querySelectorAll('button')].some(b => b.textContent === 'Restore Windows')`,
      ),
    'Restore prompt appears',
  );
  await evaluate(
    'default',
    `[...document.querySelectorAll('button')].find(b => b.textContent === 'Restore Windows').click(); true`,
  );
  await until(
    async () => (await command<{ windows: number[] }>('default', 'snapshot')).windows.length === 2,
    'Both legacy windows restore',
  );
  assert.equal(await evaluate('default', `window.electron.profileId`), 'default');
  await settings('default', { animationsEnabled: true, startupRestoreBehavior: 'windows' });
  await evaluate('default', `localStorage.setItem('isolation-probe', 'default'); true`);
  await command('default', 'cookie-set', { value: 'default' });
  await click('default', '[title="Menu"]');
  await until(
    async () =>
      await evaluate<boolean>(
        'default',
        `!!document.querySelector('.address-menu-panel .profile-menu-inline[aria-label="Profiles"]')`,
      ),
    'Profiles are inside main menu',
  );
  assert.equal(
    await evaluate('default', `document.querySelector('.profile-name').textContent`),
    'Default',
  );
  assert.equal(
    await evaluate(
      'default',
      `document.querySelector('.profile-menu-inline [aria-label="Add profile"] svg').getAttribute('width')`,
    ),
    '16',
  );
  await click('default', '.profile-menu-inline [aria-label="Add profile"]');
  await until(
    async () =>
      await evaluate<boolean>(
        'default',
        `!!document.querySelector('.profile-editor[aria-modal="true"]')`,
      ),
    'Create opens a modal',
  );
  await input('default', 'Work');
  await evaluate('default', `document.querySelector('.profile-editor').requestSubmit(); true`);
  let work = '';
  await until(() => {
    const registry = JSON.parse(fs.readFileSync(path.join(data, 'profiles.json'), 'utf8'));
    work = registry.profiles.find((p: { name: string }) => p.name === 'Work')?.id ?? '';
    return !!work;
  }, 'Work profile is created');
  await ready(work);
  const first = await command<{ userData: string; windows: number[] }>('default', 'snapshot');
  const second = await command<{ userData: string; sessionData: string; windows: number[] }>(
    work,
    'snapshot',
  );
  assert.equal(
    first.windows.length,
    2,
    'Opening another profile leaves existing windows and tabs intact',
  );
  assert.equal(second.userData, path.join(data, 'Profiles', work));
  assert.equal(second.userData, second.sessionData);
  assert.equal(await evaluate(work, `localStorage.getItem('isolation-probe')`), null);
  assert.deepEqual(await command(work, 'cookie-get'), []);
  await command(work, 'cookie-set', { value: 'work' });
  await settings(work, {
    showProfileMenu: true,
    animationsEnabled: true,
    startupRestoreBehavior: 'windows',
  });
  await until(
    async () => await evaluate<boolean>(work, `!!document.querySelector('.profile-menu-trigger')`),
    'Toolbar setting is applied',
  );
  await click(work, '[title="Menu"]');
  assert.equal(
    await evaluate(work, `!!document.querySelector('.address-menu-panel .profile-menu-inline[aria-label="Profiles"]')`),
    false,
    'Toolbar profiles are absent from main menu',
  );
  await click(work, '[title="Menu"]');
  await click(work, '.profile-menu-trigger');
  await until(
    async () =>
      await evaluate<boolean>(
        work,
        `!!document.querySelector('.profile-menu-panel.address-menu-panel-open')`,
      ),
    'Profile menu uses existing menu animation',
  );
  assert.equal(
    await evaluate(work, `!!document.querySelector('[aria-label="Close profiles"]')`),
    false,
  );
  await click(work, '[aria-label="Edit Work"]');
  await until(
    async () => await evaluate<boolean>(work, `!!document.querySelector('.profile-editor')`),
    'Edit opens a modal',
  );
  await input(work, 'Renamed');
  await command(work, 'picture', { file: path.join(desktop, 'src/assets/mira_logo.png') });
  await click(work, '[aria-label="Choose profile picture"]');
  await until(
    async () =>
      await evaluate<boolean>(work, `!!document.querySelector('.profile-editor-picture img')`),
    'Picture is staged in modal',
  );
  await command(work, 'screenshot', { file: path.join(directory, 'profile-editor.png') });
  await evaluate(work, `document.querySelector('.profile-editor').requestSubmit(); true`);
  await until(
    () =>
      JSON.parse(fs.readFileSync(path.join(data, 'profiles.json'), 'utf8')).profiles.some(
        (p: { name: string }) => p.name === 'Renamed',
      ),
    'Rename persists',
  );
  assert.ok(fs.existsSync(path.join(data, 'Profiles', work, 'profile-avatar.png')));
  await invoke('default', 'history-add', { url: 'https://default.example', title: 'Default' });
  assert.equal(
    ((await invoke(work, 'history-list')) as Array<{ url: string }>).some(
      (p) => p.url === 'https://default.example',
    ),
    false,
  );
  await invoke('default', 'profiles-set-settings-sync', 'default', true);
  await invoke('default', 'profiles-set-settings-sync', work, true);
  await settings('default', { searchEngine: 'duckduckgo' });
  await until(
    async () =>
      await evaluate<boolean>(
        work,
        `JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}').searchEngine === 'duckduckgo'`,
      ),
    'Preferences sync to an opted-in profile',
  );
  await settings(work, { searchEngine: 'bing' });
  await until(
    async () =>
      await evaluate<boolean>(
        'default',
        `JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}').searchEngine === 'bing'`,
      ),
    'Preferences sync in both directions',
  );
  await invoke('default', 'profiles-set-settings-sync', work, false);
  await settings(work, { searchEngine: 'google', showProfileMenu: true });
  await delay(400);
  assert.equal(
    await evaluate(
      'default',
      `JSON.parse(localStorage.getItem('mira.settings.browser.v1')).searchEngine`,
    ),
    'bing',
  );
  await invoke('default', 'profiles-set-settings-sync', 'default', false);
  await invoke(work, 'window-new-private');
  await until(
    async () => (await command<{ windows: number[] }>(work, 'snapshot')).windows.length === 2,
    'Private window opens',
  );
  await until(
    async () =>
      await evaluate<boolean>(
        work,
        `window.electron.isPrivate && !!document.querySelector('[data-tab-id]')`,
        1,
      ),
    'Private shell is ready',
  );
  assert.equal(await evaluate(work, `!!document.querySelector('.profile-menu-trigger')`, 1), false);
  await evaluate(work, `document.querySelector('[title="Menu"]').click(); true`, 1);
  assert.equal(await evaluate(work, `!!document.querySelector('.profile-menu-inline[aria-label="Profiles"]')`, 1), false);
  assert.equal(
    await evaluate(
      work,
      `window.electron.ipcRenderer.invoke('profiles-list').then(() => false, () => true)`,
      1,
    ),
    true,
  );
  await evaluate(
    work,
    `setTimeout(() => window.electron.ipcRenderer.invoke('window-close'), 50); true`,
    1,
  );
  await until(
    async () => (await command<{ windows: number[] }>(work, 'snapshot')).windows.length === 1,
    'Private window closes',
  );
  await command('default', 'quit');
  await command(work, 'quit');
  await until(() => children.every((child) => child.exitCode !== null), 'Initial process exits');
  await until(() => {
    try {
      process.kill(
        second.windows.length
          ? JSON.parse(fs.readFileSync(path.join(directory, `${work}-ready.json`), 'utf8')).pid
          : 0,
        0,
      );
      return false;
    } catch {
      return true;
    }
  }, 'Work process exits');
  fs.rmSync(path.join(directory, 'default-ready.json'));
  fs.rmSync(path.join(directory, `${work}-ready.json`));
  start();
  await ready('default', true);
  assert.equal(
    fs.existsSync(path.join(directory, `${work}-ready.json`)),
    false,
    'Startup does not automatically open every profile',
  );
  assert.equal(
    await evaluate('default', `document.querySelectorAll('.profile-picker-card').length`),
    2,
  );
  await command('default', 'screenshot', { file: path.join(directory, 'startup-picker.png') });
  await evaluate(
    'default',
    `[...document.querySelectorAll('.profile-picker-card')].find(button => button.textContent.includes('Renamed')).click(); true`,
  );
  await ready(work);
  await until(() => {
    try {
      process.kill(
        JSON.parse(fs.readFileSync(path.join(directory, 'default-ready.json'), 'utf8')).pid,
        0,
      );
      return false;
    } catch {
      return true;
    }
  }, 'Picker closes after choosing another profile');
  fs.rmSync(path.join(directory, 'default-ready.json'));
  await invoke(work, 'profiles-open', 'default');
  await ready('default');
  await until(
    async () => (await command<{ windows: number[] }>('default', 'snapshot')).windows.length === 2,
    'Default restores both windows after restart',
  );
  assert.equal(
    (await command<Array<{ value: string }>>('default', 'cookie-get'))[0].value,
    'default',
  );
  assert.equal((await command<Array<{ value: string }>>(work, 'cookie-get'))[0].value, 'work');
  await invoke(work, 'tab-open-url-in-new-tab', 'mira://Settings#section=profiles');
  await until(
    async () =>
      await evaluate<boolean>(work, `!!document.querySelector('#settings-panel-profiles')`),
    'Dedicated Profiles settings section opens',
  );
  assert.equal(
    await evaluate(
      work,
      `document.querySelector('.settings-profiles-heading [aria-label="Add profile"] svg').getAttribute('width')`,
    ),
    '20',
  );
  const alignment = await evaluate<{
    heading: number;
    button: number;
    image: number;
    icon: number;
  }>(
    work,
    `(() => {
    const heading = document.querySelector('.settings-profiles-heading h3').getBoundingClientRect();
    const button = document.querySelector('.settings-profiles-heading button').getBoundingClientRect();
    return { heading: heading.y + heading.height / 2, button: button.y + button.height / 2,
      image: document.querySelector('.settings-profile-avatar-slot').getBoundingClientRect().width,
      icon: document.querySelectorAll('.settings-profile-avatar-slot')[1].getBoundingClientRect().width };
  })()`,
  );
  assert.ok(Math.abs(alignment.heading - alignment.button) < 1, 'Add icon is inline with header');
  assert.equal(alignment.image, alignment.icon, 'Avatars and fallback icons use equal slots');
  assert.equal(
    await evaluate(
      work,
      `document.querySelector('.settings-profiles-heading button').textContent.trim()`,
    ),
    '',
  );
  await command(work, 'screenshot', { file: path.join(directory, 'profiles-settings.png') });
  await click('default', '[title="Menu"]');
  await command('default', 'screenshot', { file: path.join(directory, 'profiles-menu.png') });
  const extra = (await invoke('default', 'profiles-create', 'Remove me')) as { id: string };
  await evaluate(
    'default',
    `window.__removalResult = 'pending'; window.electron.ipcRenderer.invoke('profiles-remove', ${JSON.stringify(extra.id)}).then(v => window.__removalResult = v, e => window.__removalResult = e.message); true`,
  );
  await until(
    async () =>
      await evaluate<boolean>(
        'default',
        `!!document.querySelector('.site-interaction-backdrop:not([inert]) .site-interaction-primary')`,
      ),
    'Removal requires confirmation',
  );
  await evaluate(
    'default',
    `[...document.querySelectorAll('.site-interaction button')].find(b => b.textContent === 'Keep profile').click(); true`,
  );
  assert.ok(fs.existsSync(path.join(data, 'Profiles', extra.id)), 'Cancelling keeps profile data');
  await until(
    async () =>
      await evaluate<boolean>('default', `!document.querySelector('.site-interaction-backdrop')`),
    'Cancelled confirmation finishes its exit animation',
  );
  await evaluate(
    'default',
    `window.__removalResult = 'pending'; window.electron.ipcRenderer.invoke('profiles-remove', ${JSON.stringify(extra.id)}).then(v => window.__removalResult = v, e => window.__removalResult = e.message); true`,
  );
  await until(
    async () =>
      await evaluate<boolean>(
        'default',
        `document.querySelector('.site-interaction-backdrop:not([inert]) .site-interaction-primary')?.textContent === 'Remove profile'`,
      ),
    'Removal confirmation returns',
  );
  await click('default', '.site-interaction-backdrop:not([inert]) .site-interaction-primary');
  await until(
    () => !fs.existsSync(path.join(data, 'Profiles', extra.id)),
    'Confirmed removal deletes only the target profile',
  );
  await evaluate(
    work,
    `window.electron.ipcRenderer.invoke('profiles-remove', ${JSON.stringify(work)}).catch(() => {}); true`,
  );
  await until(
    async () =>
      await evaluate<boolean>(
        work,
        `document.querySelector('.site-interaction-backdrop:not([inert]) .site-interaction-primary')?.textContent === 'Remove profile'`,
      ),
    'Current profile removal asks for confirmation',
  );
  await click(work, '.site-interaction-backdrop:not([inert]) .site-interaction-primary');
  await until(
    () => !fs.existsSync(path.join(data, 'Profiles', work)),
    'Active profile exits before its data is removed',
    30_000,
  );
  await command('default', 'quit');
  await until(() => {
    try {
      process.kill(
        JSON.parse(fs.readFileSync(path.join(directory, 'default-ready.json'), 'utf8')).pid,
        0,
      );
      return false;
    } catch {
      return true;
    }
  }, 'Default closes before single-profile startup');
  fs.rmSync(path.join(directory, 'default-ready.json'));
  start();
  await ready('default');
  assert.equal(
    await evaluate('default', `!!document.querySelector('.profile-picker')`),
    false,
    'One profile bypasses the startup picker',
  );
  console.log(
    `PASS: migration, modal creation/rename, profile launch, storage/cookie/history isolation, settings sync, private controls, toolbar/main placement, animations, startup picker, per-profile multi-window restore, aligned settings UI, and confirmed deletion.\nArtifacts: ${directory}`,
  );
} catch (error) {
  console.error(`Profile test artifacts: ${directory}`);
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('-ready.json'))) {
    const id = file.slice(0, -'-ready.json'.length);
    const { pid } = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }
    try {
      console.error(
        id,
        await command(
          id,
          'eval',
          {
            code: `({ dialog: document.querySelector('.site-interaction')?.innerText, removal: window.__removalResult, url: location.href })`,
          },
          2000,
        ),
      );
    } catch {
      /* Hung renderer. */
    }
  }
  throw error;
} finally {
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('-ready.json'))) {
    const id = file.slice(0, -'-ready.json'.length);
    const { pid } = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }
    try {
      await command(id, 'quit', {}, 2000);
    } catch {
      /* A removed or exited test worker has no command listener. */
    }
  }
  for (const child of children) if (child.exitCode === null) child.kill();
  // Kill only fixture-owned PIDs if a failed assertion prevented normal shutdown.
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('-ready.json'))) {
    const { pid } = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    try {
      process.kill(pid);
    } catch {
      /* Already exited. */
    }
  }
}
