import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTabGroup, orderGroupedTabs, moveTabGroup, removeTabFromGroup } from '../electron/tabGroups.ts';
const group = { id: 'work', name: 'Work', color: 'blue' as const, collapsed: true };

test('saved names, colors and collapse state survive serialization and malformed group fields are normalized', () => {
  assert.deepEqual(normalizeTabGroup(JSON.parse(JSON.stringify(group))), group);
  assert.equal(normalizeTabGroup({ id: '' }), undefined);
  assert.deepEqual(normalizeTabGroup({ id: 'x', name: ' ', color: '__proto__', collapsed: 'true' }), { id: 'x', name: '', color: 'blue', collapsed: false });
  assert.equal(normalizeTabGroup({ ...group, name: 'x'.repeat(100) })?.name.length, 60);
});

test('group members stay together, preserve their order, and leave pinned tabs separate', () => {
  const tabs = [{ id: 'pin', isPinned: true, group }, { id: 'a', group }, { id: 'plain' }, { id: 'b', group }, { id: 'other', group: { ...group, id: 'other' } }];
  const ordered = orderGroupedTabs(tabs);
  assert.deepEqual(ordered.map(tab => tab.id), ['pin', 'a', 'b', 'plain', 'other']);
  assert.equal(ordered[0].group, undefined);
  assert.equal(ordered[1].group?.collapsed, true);
  assert.equal(orderGroupedTabs(ordered), ordered);
});


test('expanded and collapsed groups move as a block past tabs and other groups', () => {
  for (const collapsed of [false, true]) {
    const g = { ...group, collapsed };
    const other = { ...group, id: 'other' };
    const tabs = [{ id: 'pin', isPinned: true }, { id: 'a', group: g }, { id: 'b', group: g }, { id: 'plain' }, { id: 'c', group: other }, { id: 'd', group: other }];
    const moved = moveTabGroup(tabs, 'work', 'c', true);
    assert.deepEqual(moved.map(tab => tab.id), ['pin', 'plain', 'c', 'd', 'a', 'b']);
    assert.equal(moved[4].group?.collapsed, collapsed);
    assert.deepEqual(moveTabGroup(moved, 'work', 'plain', false).map(tab => tab.id), ['pin', 'a', 'b', 'plain', 'c', 'd']);
    assert.equal(moveTabGroup(tabs, 'work', 'pin', false), tabs);
  }
});

test('removing a tab through the trailing edge works even at the end of the strip', () => {
  const tabs = [{ id: 'plain' }, { id: 'a', group }, { id: 'b', group }];
  const moved = removeTabFromGroup(tabs, 'a');
  assert.deepEqual(moved.map(tab => [tab.id, tab.group?.id]), [['plain', undefined], ['b', 'work'], ['a', undefined]]);
  assert.equal(removeTabFromGroup([{ id: 'a', group }], 'a')[0].group, undefined);
});

test('empty group names survive session serialization and normalization', () => {
  const unnamed = { ...group, name: '' };
  assert.deepEqual(normalizeTabGroup(JSON.parse(JSON.stringify(unnamed))), unnamed);
  assert.equal(normalizeTabGroup({ ...group, name: '   ' })?.name, '');
});

test('leaving either edge puts the tab immediately beside its group without crossing a neighboring tab', () => {
  const tabs = [{ id: 'left' }, { id: 'a', group }, { id: 'b', group }, { id: 'right' }];
  const before = removeTabFromGroup(tabs, 'b', 'before');
  assert.deepEqual(before.map(tab => [tab.id, tab.group?.id]), [['left', undefined], ['b', undefined], ['a', 'work'], ['right', undefined]]);
  const after = removeTabFromGroup(tabs, 'a', 'after');
  assert.deepEqual(after.map(tab => [tab.id, tab.group?.id]), [['left', undefined], ['b', 'work'], ['a', undefined], ['right', undefined]]);
  for (const side of ['before', 'after'] as const) {
    assert.deepEqual(removeTabFromGroup([{ id: 'left' }, { id: 'a', group }, { id: 'right' }], 'a', side).map(tab => tab.id), ['left', 'a', 'right']);
  }
});
