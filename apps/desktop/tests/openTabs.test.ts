import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenTabsRegistry } from '../electron/openTabs.ts';
import { getAddressSuggestions } from '../src/features/history/addressSuggestions.ts';

test('lists live tabs from other windows without exposing other session scopes', () => {
  const registry = new OpenTabsRegistry();
  const tab = { id: 'tab', title: 'Example', url: 'https://example.com/' };
  registry.update(1, 'regular', [tab]);
  registry.update(2, 'regular', [{ ...tab, id: 'second' }]);
  registry.update(3, 'private-one', [{ ...tab, id: 'private' }]);
  assert.deepEqual(registry.list(1, 'regular').map(item => item.id), ['second']);
  assert.deepEqual(registry.list(3, 'private-one'), []);
  assert.equal(registry.has(3, 'regular', 'private'), false);
  assert.equal(registry.has(2, 'regular', 'missing'), false);
  registry.remove(2);
  assert.deepEqual(registry.list(1, 'regular'), []);
});

test('updates changed titles and ignores malformed metadata and duplicate IDs', () => {
  const registry = new OpenTabsRegistry();
  const tabs = [{ id: 'tab', title: 'Old', url: 'https://example.com/' }];
  assert.equal(registry.update(1, 'regular', tabs), true);
  assert.equal(registry.update(1, 'regular', tabs), false);
  assert.equal(registry.update(1, 'regular', [null, {}, ...tabs, ...tabs]), false);
  registry.update(1, 'regular', [{ ...tabs[0], title: 'New' }]);
  assert.equal(registry.list(2, 'regular')[0].title, 'New');
});

test('remote suggestions retain the window and tab even when tab IDs match the active local tab', () => {
  const tabs = [{ id: 'same-id', windowId: 2, title: 'Remote example', url: 'https://example.com/' }];
  const suggestions = getAddressSuggestions('example', [], [], tabs, 'same-id');
  assert.deepEqual(suggestions[0], {
    title: 'Remote example', value: tabs[0].url, kind: 'tab', tabId: 'same-id', windowId: 2,
  });
});

test('local tabs take precedence over duplicate URLs in other windows within the five-item limit', () => {
  const pages = [
    { id: 'local', title: 'Local example', url: 'https://example.com/' },
    { id: 'remote', windowId: 2, title: 'Remote example', url: 'https://example.com/' },
    ...Array.from({ length: 8 }, (_, index) => ({ id: String(index), windowId: 2,
      title: `Example ${index}`, url: `https://example.com/${index}` })),
  ];
  const suggestions = getAddressSuggestions('example', [], [], pages);
  assert.equal(suggestions.length, 5);
  assert.equal(suggestions[0].tabId, 'local');
  assert.equal(suggestions.filter(item => item.value === 'https://example.com/').length, 1);
});
