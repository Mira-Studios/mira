import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { ProfileStore } from '../electron/profileStore.ts';
import { SessionStore } from '../electron/sessionStore.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-profiles-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('migration preserves Chromium data, encryption keys, settings, sessions, and arbitrary feature files', (t) => {
  const root = fixture(t);
  const files = [
    'Local State',
    'Default/Network/Cookies',
    'Default/Local Storage/leveldb/data',
    'Partitions/site/IndexedDB/data',
    'session.json',
    'history.json',
    'site-permissions.json',
    'background-images/photo.png',
    'web-apps/apps.json',
    'future-new-tab-cards.json',
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `original:${file}`);
  }
  const store = new ProfileStore(root);
  for (const file of files) {
    assert.equal(
      fs.readFileSync(path.join(store.dataPath('default'), file), 'utf8'),
      `original:${file}`,
    );
    assert.equal(fs.existsSync(path.join(root, file)), false);
  }
  assert.equal(new ProfileStore(root).get('default').name, 'Default');
});

test('an interrupted migration resumes and a conflicting migration never overwrites either copy', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'Profiles/default'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Profiles/default/session.json'), 'already moved');
  fs.writeFileSync(path.join(root, 'history.json'), 'still legacy');
  const store = new ProfileStore(root);
  assert.equal(
    fs.readFileSync(path.join(store.dataPath('default'), 'session.json'), 'utf8'),
    'already moved',
  );
  assert.equal(
    fs.readFileSync(path.join(store.dataPath('default'), 'history.json'), 'utf8'),
    'still legacy',
  );
  const conflict = fixture(t);
  fs.mkdirSync(path.join(conflict, 'Profiles/default'), { recursive: true });
  fs.writeFileSync(path.join(conflict, 'Profiles/default/session.json'), 'destination');
  fs.writeFileSync(path.join(conflict, 'session.json'), 'source');
  assert.throws(() => new ProfileStore(conflict), /preserve both copies/);
  assert.equal(fs.readFileSync(path.join(conflict, 'session.json'), 'utf8'), 'source');
  assert.equal(
    fs.readFileSync(path.join(conflict, 'Profiles/default/session.json'), 'utf8'),
    'destination',
  );
});

test('profiles have independent paths and sessions; renaming preserves identity and pictures', async (t) => {
  const store = new ProfileStore(fixture(t));
  const work = store.create('Work');
  const personal = store.create('Personal');
  assert.notEqual(store.dataPath(work.id), store.dataPath(personal.id));
  store.setAvatar(work.id, Buffer.from('avatar'));
  store.rename(work.id, 'Renamed');
  assert.equal(store.get(work.id).name, 'Renamed');
  assert.equal(store.avatar(work.id), 'data:image/png;base64,YXZhdGFy');
  assert.equal(store.avatar(personal.id), undefined);
  const normalize = (value: unknown) => value as { windows: string[] };
  const first = new SessionStore(
    () => path.join(store.dataPath(work.id), 'session.json'),
    normalize,
  );
  const second = new SessionStore(
    () => path.join(store.dataPath(personal.id), 'session.json'),
    normalize,
  );
  await Promise.all([
    first.save({ windows: ['work one', 'work two'] }),
    second.save({ windows: ['personal'] }),
  ]);
  assert.deepEqual(await first.load(), { windows: ['work one', 'work two'] });
  assert.deepEqual(await second.load(), { windows: ['personal'] });
  store.setAvatar(work.id, null);
  assert.equal(store.avatar(work.id), undefined);
});

test('corrupt registries use a complete backup and never silently reset existing profiles', (t) => {
  const root = fixture(t);
  const store = new ProfileStore(root);
  const work = store.create('Work');
  fs.writeFileSync(store.registryPath, '{broken');
  assert.equal(new ProfileStore(root).get(work.id).name, 'Work');
  fs.writeFileSync(`${store.registryPath}.bak`, '{also broken');
  assert.throws(() => new ProfileStore(root), /preserved/);
  assert.ok(fs.existsSync(store.dataPath(work.id)));
});

test('invalid IDs and names cannot escape profile storage', (t) => {
  const store = new ProfileStore(fixture(t));
  for (const id of ['..', '../default', 'C:\\Users', '/tmp', ''])
    assert.throws(() => store.dataPath(id));
  for (const name of ['', ' ', null, 'x'.repeat(61)]) assert.throws(() => store.create(name));
  assert.equal(store.create('  Work  ').name, 'Work');
});

test('removal is confirmed by a token, preserves running profiles, supports cancellation, and keeps a final profile', (t) => {
  const store = new ProfileStore(fixture(t));
  assert.throws(() => store.beginRemoval('default'), /at least one/);
  const work = store.create('Work');
  store.markRunning(work.id);
  const token = store.beginRemoval(work.id);
  assert.throws(() => store.finishRemoval(work.id, 'wrong'), /expired/);
  assert.throws(() => store.finishRemoval(work.id, token), /Close/);
  store.cancelRemoval(work.id, token);
  assert.equal(store.get(work.id).removalToken, undefined);
  fs.rmSync(path.join(store.dataPath(work.id), 'mira-runtime.json'));
  const confirmed = store.beginRemoval(work.id);
  store.finishRemoval(work.id, confirmed);
  assert.equal(fs.existsSync(store.dataPath(work.id)), false);
  assert.equal(store.read().restoreProfiles.includes(work.id), false);
  assert.throws(() => store.get(work.id), /no longer exists/);
  assert.equal(store.get('default').name, 'Default');
});

test('concurrent profile processes do not lose registry changes', async (t) => {
  const root = fixture(t);
  const moduleUrl = new URL('../electron/profileStore.ts', import.meta.url).href;
  await Promise.all(
    Array.from(
      { length: 5 },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const script = `import { ProfileStore } from ${JSON.stringify(moduleUrl)}; new ProfileStore(process.argv[1]).create(process.argv[2]);`;
          const child = spawn(
            process.execPath,
            ['--input-type=module', '-e', script, root, `Concurrent ${index}`],
            { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
          );
          let errors = '';
          child.stderr.on('data', (data) => {
            errors += data;
          });
          child.on('error', reject);
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(errors))));
        }),
    ),
  );
  const store = new ProfileStore(root);
  assert.equal(store.read().profiles.length, 6);
  assert.equal(new Set(store.read().profiles.map((p) => p.name)).size, 6);
});

test('startup picker defaults on, appears only for multiple profiles, and can be disabled', (t) => {
  const store = new ProfileStore(fixture(t));
  assert.equal(store.shouldShowPicker(), false);
  store.create('Work');
  assert.equal(store.shouldShowPicker(), true);
  store.setShowPickerOnStartup(false);
  assert.equal(new ProfileStore(store.root).shouldShowPicker(), false);
  store.setShowPickerOnStartup(true);
  assert.equal(store.shouldShowPicker(), true);
});

test('settings sync is opt-in, excludes browsing data, and leaves independent copies when disabled', (t) => {
  const store = new ProfileStore(fixture(t));
  const work = store.create('Work');
  const privateProfile = store.create('Separate');
  const bundle = (searchEngine: string) => ({
    'mira.settings.browser.v1': JSON.stringify({ searchEngine }),
    'mira.themes.custom.v1': null,
    'mira.layouts.custom.v1': null,
    'mira.bookmarks.v1': 'must never be copied',
  });
  store.publishSettings('default', bundle('google'));
  store.publishSettings(work.id, bundle('bing'));
  assert.equal(store.syncedSettings(work.id), null);
  store.setSettingsSync('default', true);
  store.setSettingsSync(work.id, true);
  assert.equal(
    JSON.parse(store.syncedSettings(work.id)!['mira.settings.browser.v1']!).searchEngine,
    'google',
  );
  assert.equal('mira.bookmarks.v1' in store.syncedSettings(work.id)!, false);
  store.publishSettings(work.id, bundle('duckduckgo'));
  assert.equal(
    JSON.parse(store.syncedSettings('default')!['mira.settings.browser.v1']!).searchEngine,
    'duckduckgo',
  );
  assert.equal(store.syncedSettings(privateProfile.id), null);
  store.setSettingsSync(work.id, false);
  store.publishSettings(work.id, bundle('bing'));
  assert.equal(store.syncedSettings(work.id), null);
  assert.equal(
    JSON.parse(store.syncedSettings('default')!['mira.settings.browser.v1']!).searchEngine,
    'duckduckgo',
  );
});

test('settings sync carries only the referenced wallpaper and survives deleting its source', (t) => {
  const store = new ProfileStore(fixture(t));
  const work = store.create('Work');
  const key = 'a'.repeat(64);
  const imageDirectory = path.join(store.dataPath('default'), 'background-images');
  fs.mkdirSync(imageDirectory);
  fs.writeFileSync(path.join(imageDirectory, `${key}.png`), 'wallpaper');
  fs.writeFileSync(path.join(store.dataPath('default'), 'history.json'), 'private history');
  store.publishSettings('default', {
    'mira.settings.browser.v1': JSON.stringify({ backgroundImage: `local:${key}` }),
    'mira.themes.custom.v1': null,
    'mira.layouts.custom.v1': null,
  });
  store.setSettingsSync('default', true);
  store.setSettingsSync(work.id, true);
  assert.ok(store.syncedSettings(work.id));
  assert.equal(
    fs.readFileSync(path.join(store.dataPath(work.id), 'background-images', `${key}.png`), 'utf8'),
    'wallpaper',
  );
  assert.equal(fs.existsSync(path.join(store.dataPath(work.id), 'history.json')), false);
  const token = store.beginRemoval('default');
  store.finishRemoval('default', token);
  assert.ok(store.syncedSettings(work.id));
});

test('delayed saves and startup snapshots cannot overwrite newer synced settings', (t) => {
  const store = new ProfileStore(fixture(t));
  const work = store.create('Work');
  const bundle = (searchEngine: string) => ({
    'mira.settings.browser.v1': JSON.stringify({ searchEngine }),
    'mira.themes.custom.v1': null,
    'mira.layouts.custom.v1': null,
  });
  store.publishSettings('default', bundle('google'));
  store.setSettingsSync('default', true);
  store.setSettingsSync(work.id, true);
  const now = Date.now();
  store.publishSettings('default', bundle('duckduckgo'), now + 10);
  store.publishSettings(work.id, bundle('stale'), now + 5);
  store.publishSettings(work.id, bundle('startup'), 0, true);
  assert.equal(
    JSON.parse(store.syncedSettings('default')!['mira.settings.browser.v1']!).searchEngine,
    'duckduckgo',
  );
  store.publishSettings(work.id, bundle('bing'), now + 20);
  assert.equal(
    JSON.parse(store.syncedSettings('default')!['mira.settings.browser.v1']!).searchEngine,
    'bing',
  );
});

test('a locked profile directory is kept intact when removal cannot detach it', (t) => {
  const store = new ProfileStore(fixture(t));
  const profile = store.create('Work');
  fs.writeFileSync(path.join(store.dataPath(profile.id), 'sentinel'), 'keep all data');
  const token = store.beginRemoval(profile.id);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === store.dataPath(profile.id))
      throw Object.assign(new Error('Locked'), { code: 'EBUSY' });
    return rename(...args);
  });
  assert.throws(() => store.finishRemoval(profile.id, token), /Locked/);
  assert.equal(
    fs.readFileSync(path.join(store.dataPath(profile.id), 'sentinel'), 'utf8'),
    'keep all data',
  );
  assert.equal(store.get(profile.id).name, 'Work');
});

test('a failed registry commit restores the complete profile directory before reporting failure', (t) => {
  const store = new ProfileStore(fixture(t));
  const profile = store.create('Work');
  fs.writeFileSync(path.join(store.dataPath(profile.id), 'sentinel'), 'keep all data');
  const token = store.beginRemoval(profile.id);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    if (String(args[1]) === store.registryPath)
      throw Object.assign(new Error('Registry locked'), { code: 'EBUSY' });
    return rename(...args);
  });
  assert.throws(() => store.finishRemoval(profile.id, token), /Registry locked/);
  assert.equal(
    fs.readFileSync(path.join(store.dataPath(profile.id), 'sentinel'), 'utf8'),
    'keep all data',
  );
  assert.equal(store.get(profile.id).name, 'Work');
});
