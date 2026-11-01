import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addClosedTab, addClosedWindow, pruneRecentlyClosed, RECENTLY_CLOSED_RETENTION_MS, restoreClosedEntry } from '../src/features/tabs/recentlyClosed.ts';
import type { Tab } from '../src/features/tabs/types.ts';

function tab(id: string): Tab {
  return { id, title: `Title ${id}`, url: `https://example.com/${id}`, history: [`https://example.com/${id}`, `https://example.com/${id}?page=2`], historyIndex: 0, reloadToken: 4, isSleeping: false, lastActiveAt: 1, favicon: 'https://example.com/icon.png' };
}

test('closed tabs restore independently, preserving navigation, pinning and metadata without reusing native contents', () => {
  const source = { ...tab('a'), isPinned: true, transferredGuestInstance: 'stale', transferredWebContentsId: 99, detachedTransferId: 'transfer' };
  const entries = addClosedTab([], source);
  source.history.push('https://example.com/later');
  assert.equal(entries[0].tabs[0].history.length, 2);
  const restored = restoreClosedEntry(entries[0]);
  const actual = restored.tabs[0];
  assert.notEqual(actual.id, source.id);
  assert.equal(restored.activeId, actual.id);
  assert.equal(actual.title, source.title);
  assert.equal(actual.favicon, source.favicon);
  assert.equal(actual.isPinned, true);
  assert.equal(actual.historyIndex, 0);
  assert.equal(actual.transferredGuestInstance, undefined);
  assert.equal(actual.transferredWebContentsId, undefined);
  assert.equal(actual.detachedTransferId, undefined);
});

test('group callbacks arriving out of order form one restore item in original tab order', () => {
  const group = { id: 'g', name: 'Research', color: 'purple' as const, collapsed: true };
  const members = [tab('a'), tab('b'), tab('c')].map(item => ({ ...item, group }));
  const batch = { id: 'batch', tabs: members, activeId: 'b', closedAt: Date.now() };
  let entries = addClosedTab([], members[2], batch);
  entries = addClosedTab(entries, members[0], batch);
  entries = addClosedTab(entries, members[1], batch);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].isGroup, true);
  assert.deepEqual(entries[0].tabs.map(item => item.id), ['a', 'b', 'c']);
  const restored = restoreClosedEntry(entries[0]);
  assert.equal(restored.activeId, restored.tabs[1].id);
  assert.deepEqual(restored.tabs.map(item => item.group), [group, group, group]);
  assert.deepEqual(restored.tabs.map(item => item.restoreDeferred), [true, false, true]);
  assert.equal(new Set(restored.tabs.map(item => item.id)).size, 3);
});

test('cancelled group closing records only tabs actually closed and chooses a surviving restore tab', () => {
  const members = [tab('a'), tab('b')];
  const entries = addClosedTab([], members[0], { id: 'batch', tabs: members, activeId: 'b', closedAt: Date.now() });
  const restored = restoreClosedEntry(entries[0]);
  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.activeId, restored.tabs[0].id);
});

test('recently closed is bounded with newest items last for the restore shortcut', () => {
  let entries = addClosedTab([], tab('a'), undefined, 2);
  entries = addClosedTab(entries, tab('b'), undefined, 2);
  entries = addClosedTab(entries, tab('c'), undefined, 2);
  assert.deepEqual(entries.map(entry => entry.tabs[0].id), ['b', 'c']);
});

test('blank new tabs are excluded from standalone and group restore entries', () => {
  const entries = addClosedTab([], tab('saved'));
  for (const url of ['mira://NewTab', 'mira://newtab/', 'mira://NewTab?test=1', 'about:blank', '']) {
    assert.equal(addClosedTab(entries, { ...tab('blank'), url }), entries);
  }
  const members = [tab('a'), { ...tab('blank'), url: 'mira://NewTab' }];
  const batch = { id: 'batch', tabs: members, activeId: 'blank', closedAt: Date.now() };
  const withGroup = addClosedTab(entries, members[0], batch);
  assert.equal(addClosedTab(withGroup, members[1], batch), withGroup);
  assert.deepEqual(withGroup.at(-1)?.tabs.map(item => item.id), ['a']);
});

test('closed windows restore all tabs, groups, pins and selection as an independent snapshot', () => {
  const group = { id: 'g', name: 'Research', color: 'purple' as const, collapsed: true };
  const members = [
    { ...tab('pinned'), isPinned: true },
    { ...tab('grouped'), group },
    { ...tab('blank'), url: 'mira://NewTab' },
  ];
  const bounds = { x: 10, y: 20, width: 1000, height: 800 };
  const entries = addClosedWindow([], { tabs: members, activeId: 'grouped', bounds, isMaximized: true });
  members[1].history.push('https://example.com/later');
  group.name = 'Changed';
  const entry = entries[0];
  assert.equal(entry.isWindow, true);
  assert.equal(entry.isGroup, false);
  assert.deepEqual(entry.bounds, bounds);
  assert.equal(entry.isMaximized, true);
  const restored = restoreClosedEntry(entry);
  assert.deepEqual(restored.tabs.map(item => item.url), members.map(item => item.url));
  assert.equal(restored.tabs[0].isPinned, true);
  assert.equal(restored.tabs[1].group?.name, 'Research');
  assert.equal(restored.tabs[1].history.length, 2);
  assert.equal(restored.activeId, restored.tabs[1].id);
  assert.deepEqual(restored.tabs.map(item => item.restoreDeferred), [true, false, true]);
  assert.ok(restored.tabs.every(item => !members.some(source => source.id === item.id)));
});

test('tabs and windows share a bounded chronological shortcut order after disk serialization', () => {
  const localTab = { ...addClosedTab([], tab('local'))[0], closedAt: 20 };
  const window = { ...addClosedWindow([], { tabs: [tab('window')], activeId: 'window' })[0], closedAt: 30 };
  const olderWindow = { ...addClosedWindow([], { tabs: [tab('older')], activeId: 'older' })[0], closedAt: 10 };
  const merged = pruneRecentlyClosed(JSON.parse(JSON.stringify([window, localTab, olderWindow])), 40);
  assert.deepEqual(merged.map(entry => entry.tabs[0].id), ['older', 'local', 'window']);
  assert.equal(merged.at(-1)?.isWindow, true);
  assert.deepEqual(pruneRecentlyClosed([localTab, window, olderWindow], 40, 2).map(entry => entry.id), [localTab.id, window.id]);
});

test('history expires after two days, including on restart, and excludes invalid timestamps and empty entries', () => {
  const now = Date.now();
  const entry = addClosedTab([], tab('saved'))[0];
  const fresh = { ...entry, closedAt: now - RECENTLY_CLOSED_RETENTION_MS + 1 };
  const expired = { ...entry, id: 'expired', closedAt: now - RECENTLY_CLOSED_RETENTION_MS };
  const invalid = { ...entry, id: 'invalid', closedAt: Number.NaN };
  const future = { ...entry, id: 'future', closedAt: now + 1 };
  const empty = { ...entry, id: 'empty', tabs: [] };
  const fromDisk = JSON.parse(JSON.stringify([fresh, expired, invalid, future, empty]));
  assert.deepEqual(pruneRecentlyClosed(fromDisk, now).map(item => item.id), [fresh.id]);
  assert.deepEqual(pruneRecentlyClosed([fresh], now + 1), []);
});

test('windows containing only a new tab remain restorable; empty snapshots are ignored and history is bounded', () => {
  const blank = { ...tab('blank'), url: 'mira://NewTab' };
  const entries = addClosedWindow([], { tabs: [blank], activeId: blank.id });
  assert.equal(entries[0].tabs.length, 1);
  assert.equal(addClosedWindow(entries, { tabs: [], activeId: '' }), entries);
  const bounded = addClosedWindow(entries, { tabs: [tab('newer')], activeId: 'newer' }, 1);
  assert.equal(bounded.length, 1);
  assert.equal(bounded[0].tabs[0].id, 'newer');
});
