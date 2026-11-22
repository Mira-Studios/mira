import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GettingStartedStore } from '../electron/gettingStartedStore.ts';
import { guideFinished } from '../electron/gettingStartedPolicy.ts';
import { browserImportRoots, profilesAt, readBrowserSource, readProfileAvatar } from '../electron/browserImportReader.ts';
import { HistoryStore } from '../electron/historyStore.ts';
import { mergeImportedBookmarks } from '../electron/bookmarkImportPolicy.ts';
import { createImportedProfile } from '../electron/browserImportProfile.ts';
import { ProfileStore } from '../electron/profileStore.ts';

const base = path.resolve('.tmp');
await fs.mkdir(base, { recursive: true });
test('guide persists skipped steps, dismissal and profile separation', async () => {
  const directory = await fs.mkdtemp(path.join(base, 'guide-state-'));
  const first = new GettingStartedStore(path.join(directory, 'first'));
  assert.equal(guideFinished(await first.read()), false);
  await first.update('import');
  assert.deepEqual((await new GettingStartedStore(path.join(directory, 'first')).read()).completed, ['import']);
  await Promise.all([first.update('default-browser'), first.update(undefined, true)]);
  assert.equal(guideFinished(await first.read()), true);
  assert.equal((await first.read()).dismissed, true);
  assert.equal(guideFinished(await new GettingStartedStore(path.join(directory, 'second')).read()), false);
});
test('layout is required between import and default-browser completion', async () => {
  const directory = await fs.mkdtemp(path.join(base, 'guide-layout-'));
  const store = new GettingStartedStore(directory);
  await store.update('import'); await store.update('default-browser');
  assert.equal(guideFinished(await store.read()), false, 'Earlier two-step progress still needs layout');
  await store.update('layout');
  assert.equal(guideFinished(await store.read()), true);
});
test('detects named Chromium profiles and reads bookmarks and original history dates', async () => {
  const directory = await fs.mkdtemp(path.join(base, 'import-source-'));
  const root = browserImportRoots('win32', directory, directory, directory).chrome[0];
  const profile = path.join(root, 'Default');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }));
  await fs.writeFile(path.join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [{ type: 'url', name: 'Example', url: 'https://example.com' }, { type: 'url', name: 'Unsafe', url: 'javascript:alert(1)' }] } } }));
  const when = Date.now() - 60000;
  const db = new DatabaseSync(path.join(profile, 'History'));
  db.exec('CREATE TABLE urls (url TEXT,title TEXT,last_visit_time INTEGER,hidden INTEGER)');
  db.prepare('INSERT INTO urls VALUES (?,?,?,0)').run('https://example.com', 'Example', (when + 11644473600000) * 1000);
  db.close();
  const sources = await profilesAt(root, false);
  assert.equal(sources[0].name, 'Personal');
  const result = await readBrowserSource(sources[0], { bookmarks: true, history: true });
  assert.equal(result.bookmarks[0].children?.length, 1);
  assert.equal(result.history[0].visitedAt, when);
  const target = new HistoryStore(path.join(directory, 'target'));
  await target.load(); await target.add({ url: 'https://existing.test' });
  assert.equal(await target.import(result.history), 1);
  assert.equal(await target.import(result.history), 0);
  assert.equal((await target.list()).length, 2);
});
test('reads Firefox places bookmarks and history', async () => {
  const directory = await fs.mkdtemp(path.join(base, 'firefox-source-'));
  const db = new DatabaseSync(path.join(directory, 'places.sqlite'));
  db.exec(`CREATE TABLE moz_places (id INTEGER,url TEXT,title TEXT,last_visit_date INTEGER,hidden INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER,parent INTEGER,type INTEGER,title TEXT,guid TEXT,fk INTEGER,position INTEGER);
    INSERT INTO moz_bookmarks VALUES (1,0,2,'','root________',NULL,0),(2,1,2,'Toolbar','toolbar_____',NULL,0),(3,2,1,'Example','example_____',1,0);`);
  db.prepare('INSERT INTO moz_places VALUES (1,?,?,?,0)').run('https://example.org', 'Example', Date.now() * 1000);
  db.close();
  const result = await readBrowserSource({ directory, firefox: true, browser: 'Firefox', name: 'Default', bookmarks: true, history: true }, { bookmarks: true, history: true });
  assert.equal(result.bookmarks[0].children?.[0].url, 'https://example.org/');
  assert.equal(result.history.length, 1);
});
test('merging sources deduplicates URLs across existing folders and imported profiles', () => {
  const existing = mergeImportedBookmarks([], [{ source: 'Existing', bookmarks: [{ type: 'bookmark', title: 'Kept', url: 'https://existing.test/' }] }]).bookmarks;
  const result = mergeImportedBookmarks(existing, [
    { source: 'Chrome', bookmarks: [{ type: 'bookmark', title: 'Duplicate', url: 'https://existing.test' }, { type: 'bookmark', title: 'New', url: 'https://new.test/' }] },
    { source: 'Edge', bookmarks: [{ type: 'bookmark', title: 'Duplicate', url: 'https://new.test/' }, { type: 'bookmark', title: 'Other', url: 'https://other.test/' }] },
  ]);
  assert.equal(result.count, 2);
  assert.equal(result.bookmarks.length, 3);
  assert.deepEqual(result.bookmarks[0], existing[0]);
  assert.equal(mergeImportedBookmarks(result.bookmarks, [{ source: 'Again', bookmarks: [{ type: 'bookmark', title: 'New', url: 'https://new.test/' }] }]).count, 0);
});
test('profile pictures use bounded local cache files', async () => {
  const directory = await fs.mkdtemp(path.join(base, 'import-avatar-'));
  const png = await fs.readFile(path.resolve('apps/desktop/src/assets/browsers/chrome.png'));
  await fs.writeFile(path.join(directory, 'Google Profile Picture.png'), png);
  const source = { directory, firefox: false, browser: 'Chrome', name: 'Personal', bookmarks: true, history: true };
  assert.deepEqual(await readProfileAvatar(source), png);
  await fs.unlink(path.join(directory, 'Google Profile Picture.png'));
  assert.equal(await readProfileAvatar({ ...source, avatarFile: '../outside.png' }), undefined);
});
test('imported profiles initialize isolated data before becoming available', async () => {
  const directory = await fs.mkdtemp(path.join(base, 'import-profiles-'));
  const store = new ProfileStore(directory);
  const first = createImportedProfile(store, 'Chrome · Personal', { bookmarks: [{ type: 'bookmark', title: 'Personal', url: 'https://personal.test/' }], history: [{ url: 'https://personal.test/', title: 'Personal', visitedAt: Date.now() }] });
  const second = createImportedProfile(store, 'Chrome · Personal', { bookmarks: [{ type: 'bookmark', title: 'Work', url: 'https://work.test/' }], history: [] });
  assert.notEqual(first.profile.id, second.profile.id);
  assert.equal(second.profile.name, 'Chrome · Personal (2)');
  const read = (id: string, file: string) => fs.readFile(path.join(store.dataPath(id), file), 'utf8');
  assert.ok((await read(first.profile.id, 'browser-import-bookmarks.v1.json')).includes('personal.test'));
  assert.ok(!(await read(second.profile.id, 'browser-import-bookmarks.v1.json')).includes('personal.test'));
  assert.equal(JSON.parse(await read(first.profile.id, 'history.json')).length, 1);
  assert.equal(JSON.parse(await read(second.profile.id, 'history.json')).length, 0);
  assert.deepEqual(JSON.parse(await read(second.profile.id, 'getting-started.v1.json')).completed, ['import']);
  assert.equal(store.read().profiles.length, 3);
  const before = store.read().profiles.length;
  assert.throws(() => store.create('Failed', () => { throw new Error('Initialization failed'); }));
  assert.equal(store.read().profiles.length, before, 'Incomplete profiles are never published');
});
