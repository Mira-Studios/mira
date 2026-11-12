import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddressSuggestions } from '../src/features/history/addressSuggestions.ts';
import { getAddressUrl } from '../src/features/history/addressInput.ts';

test('caps suggestions at five including the typed search option', () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    title: `Example ${index}`, url: `https://example.com/${index}`,
  }));
  const suggestions = getAddressSuggestions('example', [], history);
  assert.equal(suggestions.length, 5);
  assert.deepEqual(suggestions[4], {
    title: 'Search example', value: 'example', kind: 'search',
  });
});

test('normalizes IP addresses for navigation and rejects control characters', () => {
  assert.equal(getAddressUrl('::1'), 'https://[::1]/');
  assert.equal(getAddressUrl('192.168.1.1:8080/path'), 'https://192.168.1.1:8080/path');
  assert.equal(getAddressUrl('https://exam\u0000ple.com'), null);
  assert.equal(getAddressUrl('https://example.com:65536'), null);
});

test('matches nested bookmarks and titles, deduplicates history, and ranks address prefixes first', () => {
  const suggestions = getAddressSuggestions('example', [
    { title: 'Folder', children: [{ title: 'Example docs', url: 'https://docs.test/' }] },
  ], [
    { title: 'Example docs', url: 'https://docs.test/' },
    { title: 'Home', url: 'https://www.example.com/' },
    { title: 'Unrelated', url: 'https://other.test/' },
  ]);
  assert.deepEqual(suggestions.map(({ value }) => value), [
    'https://www.example.com/', 'https://docs.test/', 'example',
  ]);
  assert.equal(suggestions[1].kind, 'bookmark');
});

test('ignores blank input and retains a typed search without local matches', () => {
  assert.deepEqual(getAddressSuggestions('  ', [], []), []);
  assert.equal(getAddressSuggestions('  new search  ', [], [])[0].value, 'new search');
});

test('labels supported addresses as Go to and search text as Search', () => {
  for (const value of ['example.com', 'https://example.com/path', 'localhost:3000', '127.0.0.1', '192.168.1.1:8080/path', '[::1]:8080', '::1', '2001:db8::1', 'mira://Settings', 'file:///C:/test.html']) {
    assert.deepEqual(getAddressSuggestions(value, [], [])[0], {
      title: `Go to ${value}`, value, kind: 'navigation',
    });
  }
  for (const value of [
    'example', 'example search', 'invalid://example', 'example..com',
    'https://', 'https://example..com', 'https://-example.com', 'https:///example.com',
    'https:example.com', 'https://example.com:99999', 'https://example.com:abc',
    '999.168.1.1', 'https://256.1.1.1', '127.1', '0x7f000001', '192.168.001.1',
    '[::gggg]', 'https://[:::1]', 'example.c', 'https://example',
  ]) {
    assert.deepEqual(getAddressSuggestions(value, [], [])[0], {
      title: `Search ${value}`, value, kind: 'search',
    });
  }
});

test('requires an IANA TLD for domains, including internationalized names', () => {
  for (const value of ['example.com', 'EXAMPLE.CO.UK', 'example.dev', 'example.com.', 'example.xn--p1ai', 'example.рф']) {
    assert.equal(getAddressSuggestions(value, [], [])[0].kind, 'navigation', value);
  }
  for (const value of ['example.notarealtld', 'example.zz', 'example.invalid', 'example.test', 'example.local', 'example.xn--notarealtld']) {
    for (const input of [value, `https://${value}/path`]) {
      assert.equal(getAddressUrl(input), null, input);
      assert.equal(getAddressSuggestions(input, [], [])[0].kind, 'search', input);
    }
  }
});

test('uses a real title from an older visit when the latest title is a URL placeholder', () => {
  const url = 'https://example.com/';
  const history = [{ title: url, url }, { title: 'Example Home', url }];
  assert.equal(getAddressSuggestions('example', [], history)[0].title, 'Example Home');
  assert.equal(getAddressSuggestions('home', [], history)[0].title, 'Example Home');
});

test('uses open page titles for untitled bookmarks and preserves custom bookmark titles', () => {
  const url = 'https://example.com/';
  const pages = [{ title: 'Example Home', url }];
  assert.equal(getAddressSuggestions('example', [{ title: url, url }], [], pages)[0].title, 'Example Home');
  assert.equal(getAddressSuggestions('example', [{ title: 'My Example', url }], [], pages)[0].title, 'My Example');
});

test('retains one URL label when no page title is available', () => {
  const url = 'https://example.com/';
  assert.equal(getAddressSuggestions('example', [], [{ title: url, url }])[0].title, url);
});
