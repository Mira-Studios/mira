import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

// Bundle the browser modules with only the unrelated theme/layout assets stubbed.
// This exercises the actual settings and history code without requiring a DOM.
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  stdin: { contents: `export * from './src/features/history/clientHistory';
    export { getBrowserSettings, saveBrowserSettings } from './src/features/settings/browserSettings';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'browser',
  define: { 'import.meta.env.VITE_DEV': '"false"', 'import.meta.hot': 'undefined' },
  plugins: [{ name: 'theme-defaults', setup(builder) {
    builder.onResolve({ filter: /\/(themeLoader|layoutLoader)$/ }, args => ({ path: args.path, namespace: 'defaults' }));
    builder.onLoad({ filter: /.*/, namespace: 'defaults' }, () => ({ contents: `export const DEFAULT_THEME_ID = 'default_dark'; export const DEFAULT_LAYOUT_ID = 'default_standard';` }));
  } }],
});

function fixture(isPrivate = false) {
  const storage = new Map<string, string>();
  const window = new EventTarget() as EventTarget & { electron?: unknown };
  const invocations: string[] = [];
  if (isPrivate) window.electron = { isPrivate, ipcRenderer: { invoke: async (channel: string) => { invocations.push(channel); } } };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, window, Event, CustomEvent, crypto: webcrypto,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  const api = module.exports as typeof import('../src/features/history/clientHistory.ts') &
    Pick<typeof import('../src/features/settings/browserSettings.ts'), 'getBrowserSettings' | 'saveBrowserSettings'>;
  return { api, storage, invocations };
}

test('local fallback stops recording visits and titles, clears saved history, and does not resurrect it', async () => {
  const { api, storage } = fixture();
  await api.addHistoryEntry('https://example.com', 'Example');
  assert.equal((await api.listHistoryEntries()).length, 1);
  api.saveBrowserSettings({ historyRetentionDays: 0 });
  assert.equal(storage.get('mira_history'), '[]');
  await api.addHistoryEntry('https://other.com', 'Other');
  assert.equal(await api.updateHistoryEntryTitle('https://example.com', 'New title'), false);
  assert.equal((await api.listHistoryEntries()).length, 0);
  api.saveBrowserSettings({ historyRetentionDays: 30 });
  assert.equal((await api.listHistoryEntries()).length, 0);
  await api.addHistoryEntry('https://new.com', 'New');
  assert.equal((await api.listHistoryEntries()).length, 1);
});

test('local retention prunes immediately and reading history does not cause a refresh loop', async () => {
  const { api, storage } = fixture();
  const now = Date.now();
  storage.set('mira_history', JSON.stringify([0, 20, 80].map(days => ({
    id: String(days), title: 'Example', url: `https://example.com/${days}`, visitedAt: now - days * 86400000,
  }))));
  api.saveBrowserSettings({ historyRetentionDays: 30 });
  assert.equal(JSON.parse(storage.get('mira_history')!).length, 2);
  let refreshes = 0;
  const unsubscribe = api.subscribeHistoryChanges(() => { refreshes++; });
  await api.listHistoryEntries();
  assert.equal(refreshes, 0);
  await api.addHistoryEntry('https://new.com', 'New');
  assert.equal(refreshes, 1);
  unsubscribe();
  api.saveBrowserSettings({ historyRetentionDays: 'forever' });
  assert.equal(api.getBrowserSettings().historyRetentionDays, 'forever');
});

test('private renderers never send history visit or title writes to the backend', async () => {
  const { api, invocations } = fixture(true);
  await api.addHistoryEntry('https://example.com', 'Example');
  assert.equal(await api.updateHistoryEntryTitle('https://example.com', 'Title'), false);
  assert.equal(invocations.length, 0);
});

test('corrupted local history cannot prevent disabling history', () => {
  const { api, storage } = fixture();
  storage.set('mira_history', 'invalid json');
  api.saveBrowserSettings({ historyRetentionDays: 0 });
  assert.equal(api.getBrowserSettings().historyRetentionDays, 0);
  assert.equal(storage.has('mira_history'), false);
});
