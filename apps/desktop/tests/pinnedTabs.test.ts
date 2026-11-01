import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderPinnedTabs, moveTabInGroup } from '../src/features/tabs/pinnedTabs.ts';

test('pins stay before regular tabs after insertion, drag reorder, and restore', () => {
  const pinned = { id: 'pin', isPinned: true, title: 'Saved title', favicon: 'https://example.com/icon.png' };
  const regular = { id: 'regular', isPinned: false };
  const otherPin = { id: 'other-pin', isPinned: true };
  assert.deepEqual(orderPinnedTabs([regular, pinned, otherPin]).map(tab => tab.id), ['pin', 'other-pin', 'regular']);
  const restored = orderPinnedTabs(JSON.parse(JSON.stringify([regular, pinned, otherPin])));
  assert.equal(restored[0].title, pinned.title);
  assert.equal(restored[0].favicon, pinned.favicon);
  assert.equal(restored[0].isPinned, true);
  assert.deepEqual(orderPinnedTabs([otherPin, regular, pinned]).map(tab => tab.id), ['other-pin', 'pin', 'regular']);
});

test('unpinning moves a tab back into the regular group and unchanged ordering keeps state identity', () => {
  const tabs = [{ id: 'first', isPinned: true }, { id: 'second', isPinned: true }, { id: 'regular' }];
  assert.equal(orderPinnedTabs(tabs), tabs);
  assert.deepEqual(orderPinnedTabs(tabs.map(tab => tab.id === 'first' ? { ...tab, isPinned: false } : tab)).map(tab => tab.id), ['second', 'first', 'regular']);
});


test('dragging reorders pins and regular tabs without accidentally crossing groups', () => {
  const tabs = [{ id: 'p1', isPinned: true }, { id: 'p2', isPinned: true }, { id: 'a' }, { id: 'b' }];
  assert.deepEqual(moveTabInGroup(tabs, 'p1', 1).map(tab => tab.id), ['p2', 'p1', 'a', 'b']);
  assert.deepEqual(moveTabInGroup(tabs, 'p1', 3).map(tab => tab.id), ['p2', 'p1', 'a', 'b']);
  assert.deepEqual(moveTabInGroup(tabs, 'b', 0).map(tab => tab.id), ['p1', 'p2', 'b', 'a']);
});

test('explicitly dragging across the boundary changes pinned state and keeps valid ordering', () => {
  const tabs = [{ id: 'p1', isPinned: true }, { id: 'p2', isPinned: true }, { id: 'a' }];
  const unpinned = moveTabInGroup(tabs, 'p2', 1, { isPinned: false });
  assert.deepEqual(unpinned.map(tab => [tab.id, !!tab.isPinned]), [['p1', true], ['p2', false], ['a', false]]);
  const pinned = moveTabInGroup(tabs, 'a', 2, { isPinned: true });
  assert.deepEqual(pinned.map(tab => [tab.id, !!tab.isPinned]), [['p1', true], ['p2', true], ['a', true]]);
  assert.equal(moveTabInGroup(tabs, 'p1', 0), tabs);
});
