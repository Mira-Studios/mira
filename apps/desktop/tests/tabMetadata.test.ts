import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getNavigationMetadata, getUpdatedFavicon } from '../src/features/tabs/tabMetadata.ts';

const tab = {
  url: 'https://example.com/search?q=one',
  title: 'Search results',
  favicon: 'https://example.com/icon.svg',
};

test('same-document query, hash, and route changes retain page metadata without new events', () => {
  for (const url of [
    'https://example.com/search?q=two',
    'https://example.com/search?q=one#results',
    'https://example.com/another-route',
  ]) {
    assert.deepEqual(getNavigationMetadata(tab, url, { sameDocument: true }), {
      title: tab.title, favicon: tab.favicon,
    });
  }
});

test('a live title read survives history synchronization and later title changes', () => {
  assert.equal(getNavigationMetadata(tab, 'https://example.com/search?q=two', {
    sameDocument: true, title: 'New search results',
  }).title, 'New search results');
  assert.equal(getNavigationMetadata(tab, 'https://elsewhere.test/', {
    title: 'New document title',
  }).title, 'New document title');
});

test('full navigation retains same-origin icons and clears another origin’s icon', () => {
  assert.deepEqual(getNavigationMetadata(tab, 'https://example.com/other'), {
    title: 'https://example.com/other', favicon: tab.favicon,
  });
  assert.deepEqual(getNavigationMetadata(tab, 'https://elsewhere.test/'), {
    title: 'https://elsewhere.test/', favicon: undefined,
  });
});

test('empty favicon notifications keep a known icon while a new icon replaces it', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(getUpdatedFavicon(tab.favicon, empty), tab.favicon);
  }
  assert.equal(getUpdatedFavicon(tab.favicon, ' https://example.com/new.svg '), 'https://example.com/new.svg');
  assert.equal(getUpdatedFavicon(undefined, null), undefined);
});
