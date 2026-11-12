import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../electron/historyStore.ts';
import { normalizeHistoryRetentionDays, pruneHistoryEntries } from '../electron/historyPolicy.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const entry = (days: number) => ({
  id: String(days), url: `https://example.com/${days}`, title: `Page ${days}`, visitedAt: now - days * DAY,
});

async function fixture(t: { after: (callback: () => Promise<void>) => void }, entries = [entry(0)]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mira-history-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'history.json'), JSON.stringify(entries));
  const store = new HistoryStore(directory);
  await store.load();
  return { directory, store };
}

test('retention defaults safely, covers exact cutoff, and supports off and forever', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '7', {}, 10]) {
    assert.equal(normalizeHistoryRetentionDays(value), 7);
  }
  for (const value of [0, 1, 7, 30, 90, 365, 'forever']) {
    assert.equal(normalizeHistoryRetentionDays(value), value);
  }
  assert.deepEqual(pruneHistoryEntries([entry(8), entry(7), entry(0)], 7, now).map(item => item.id), ['0', '7']);
  assert.deepEqual(pruneHistoryEntries([entry(0)], 0, now), []);
  assert.deepEqual(pruneHistoryEntries([entry(1000)], 'forever', now), [entry(1000)]);
});

test('migrates existing history with the unchanged seven-day default', async t => {
  const { directory, store } = await fixture(t, [entry(0), entry(6), entry(8)]);
  assert.deepEqual((await store.list()).map(item => item.id), ['0', '6']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'history.json'), 'utf8')).map(item => item.id), ['0', '6']);
});

test('turning off clears disk and rejects concurrent visits and title updates across restart', async t => {
  const { directory, store } = await fixture(t);
  await Promise.all([
    store.add({ url: 'https://before.com', title: 'Before' }),
    store.setRetention(0),
    store.add({ url: 'https://after.com', title: 'After' }),
    store.updateTitle({ url: 'https://title.com', title: 'Late page title' }),
  ]);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'history.json'), 'utf8')), []);
  // Even if a previous history write was interrupted, the saved policy wins.
  await fs.writeFile(path.join(directory, 'history.json'), JSON.stringify([entry(0)]));
  const restarted = new HistoryStore(directory);
  await restarted.load();
  assert.deepEqual(await restarted.list(), []);
  assert.equal(await restarted.add({ url: 'https://example.com' }), false);
  assert.equal(await restarted.updateTitle({ url: 'https://example.com', title: 'Title' }), false);
  await restarted.setRetention(30);
  assert.equal(await restarted.add({ url: 'https://new.com' }), true);
  assert.equal((await restarted.list()).length, 1);
});

test('loads saved longer retention before pruning and shortening cannot resurrect removed entries', async t => {
  const { directory, store } = await fixture(t);
  await store.setRetention(90);
  await fs.writeFile(path.join(directory, 'history.json'), JSON.stringify([entry(0), entry(20), entry(80), entry(100)]));
  const restarted = new HistoryStore(directory);
  await restarted.load();
  assert.deepEqual((await restarted.list()).map(item => item.id), ['0', '20', '80']);
  await restarted.setRetention(30);
  assert.deepEqual((await restarted.list()).map(item => item.id), ['0', '20']);
  await restarted.setRetention('forever');
  assert.deepEqual((await restarted.list()).map(item => item.id), ['0', '20']);
});

test('forever survives restart and internal pages are not added by the store', async t => {
  const { directory, store } = await fixture(t);
  await store.setRetention('forever');
  await fs.writeFile(path.join(directory, 'history.json'), JSON.stringify([entry(1000)]));
  const restarted = new HistoryStore(directory);
  await restarted.load();
  assert.equal((await restarted.list()).length, 1);
  assert.equal(await restarted.add({ url: 'mira://Settings' }), false);
  assert.equal(await restarted.updateTitle({ url: 'mira://Settings', title: 'Settings' }), false);
});
