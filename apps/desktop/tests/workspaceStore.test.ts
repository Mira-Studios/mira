import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../electron/workspaceStore.ts';

test('workspaces persist metadata, session and allowlisted overrides inside their profile', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mira-workspaces-'));
  const profileA = path.join(root, 'Profiles', 'a');
  const profileB = path.join(root, 'Profiles', 'b');
  const a = new WorkspaceStore(profileA);
  const workspace = a.save({
    name: 'Research',
    icon: 'book',
    startup: 'fixed',
    urls: ['https://example.com', 'javascript:alert(1)'],
    settings: {
      themeId: 'custom',
      tabStripPosition: 'left',
      cookiesEnabled: false,
      historyRetentionDays: 1,
      runOnStartup: true,
    },
  });
  assert.deepEqual(workspace.urls, ['https://example.com']);
  assert.deepEqual(workspace.settings, { themeId: 'custom', tabStripPosition: 'left' });
  const snapshot = {
    tabs: [{ id: 'one', url: 'https://saved.example' }],
    activeId: 'one',
    savedAt: 123,
  };
  a.setSession(workspace.id, snapshot);
  a.save({ ...workspace, name: 'Renamed', icon: 'code', startup: 'restore' });
  const reloaded = new WorkspaceStore(profileA);
  assert.equal(reloaded.list()[0].name, 'Renamed');
  assert.deepEqual(reloaded.get(workspace.id)?.session, snapshot);
  assert.equal('session' in reloaded.list()[0], false);
  assert.deepEqual(new WorkspaceStore(profileB).list(), []);
  reloaded.setSettings(workspace.id, { themeId: 'default_light', history: ['secret'] });
  assert.deepEqual(new WorkspaceStore(profileA).get(workspace.id)?.settings, {
    themeId: 'default_light',
  });
  reloaded.remove(workspace.id);
  assert.deepEqual(new WorkspaceStore(profileA).list(), []);
  assert.equal(
    JSON.parse(readFileSync(path.join(profileA, 'workspaces.v1.json'), 'utf8')).version,
    1,
  );
});
test('invalid edits and corrupt workspace files are never silently overwritten', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mira-workspaces-'));
  const store = new WorkspaceStore(root);
  assert.throws(() => store.save({ name: '   ' }));
  assert.throws(() => store.save({ id: '../other', name: 'Invalid' }));
  assert.throws(() => store.save({ name: 'Invalid', avatar: 'https://external.example/image' }));
  const file = path.join(root, 'workspaces.v1.json');
  writeFileSync(file, '{broken');
  assert.throws(() => new WorkspaceStore(root));
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
