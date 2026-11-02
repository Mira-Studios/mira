import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isWebAppUrl,
  isWithinWebAppScope,
  parseWebAppManifest,
  webAppLauncherLabel,
} from './webAppPolicy.ts';

const manifestUrl = 'https://example.com/assets/app.webmanifest';
const page = 'https://example.com/app/home';
const manifest = {
  name: 'Example app',
  id: '/my-app',
  start_url: '../app/start',
  scope: '/app/',
  display: 'standalone',
  icons: [{ src: '/icon.png', sizes: '192x192' }],
};

test('launcher labels keep readable app names and remove unsafe filename characters', () => {
  assert.equal(webAppLauncherLabel('Atlas Notes'), 'Atlas Notes');
  assert.equal(webAppLauncherLabel('Café / Notes: Work?'), 'Café Notes Work');
  assert.equal(webAppLauncherLabel('  Notes... '), 'Notes');
  assert.equal(webAppLauncherLabel('///'), 'Web app');
});

test('resolves manifest URLs and keeps a stable identity across start URL changes', () => {
  const first = parseWebAppManifest(manifest, manifestUrl, page)!;
  const second = parseWebAppManifest({ ...manifest, start_url: '/app/new' }, manifestUrl, page)!;
  assert.equal(first.startUrl, 'https://example.com/app/start');
  assert.equal(first.id, 'https://example.com/my-app');
  assert.equal(second.id, first.id);
  assert.equal(first.iconUrl, 'https://example.com/icon.png');
});
test('rejects insecure sites, credentials, remote starts and remote identities', () => {
  assert.equal(parseWebAppManifest(manifest, manifestUrl, 'http://example.com/app/'), null);
  assert.equal(
    parseWebAppManifest({ ...manifest, start_url: 'https://evil.test/app/' }, manifestUrl, page),
    null,
  );
  assert.equal(
    parseWebAppManifest({ ...manifest, id: 'https://evil.test/app/' }, manifestUrl, page),
    null,
  );
  assert.equal(
    parseWebAppManifest({ ...manifest, start_url: 'javascript:alert(1)' }, manifestUrl, page),
    null,
  );
  assert.equal(isWebAppUrl('https://user:secret@example.com/'), false);
});
test('permits loopback development, with the port part of the origin', () => {
  assert.equal(isWebAppUrl('http://localhost:8080/'), true);
  assert.equal(isWebAppUrl('http://127.0.0.1:8080/'), true);
  assert.equal(isWebAppUrl('http://[::1]:8080/'), true);
  assert.equal(
    isWithinWebAppScope('http://localhost:8081/app/', 'http://localhost:8080/app/'),
    false,
  );
});
test('requires a name, app display mode and a suitable manifest icon', () => {
  assert.equal(parseWebAppManifest({ ...manifest, name: '' }, manifestUrl, page), null);
  assert.equal(parseWebAppManifest({ ...manifest, display: 'browser' }, manifestUrl, page), null);
  assert.equal(
    parseWebAppManifest(
      { ...manifest, icons: [{ src: '/small.png', sizes: '32x32' }] },
      manifestUrl,
      page,
    ),
    null,
  );
  assert.ok(
    parseWebAppManifest(
      {
        ...manifest,
        name: undefined,
        short_name: 'App',
        icons: [{ src: '/icon.svg', sizes: 'any' }],
      },
      manifestUrl,
      page,
    ),
  );
});
test('falls back from an invalid scope to the start URL directory', () => {
  assert.equal(
    parseWebAppManifest({ ...manifest, scope: 'https://evil.test/' }, manifestUrl, page)?.scope,
    'https://example.com/app/',
  );
  assert.equal(
    parseWebAppManifest({ ...manifest, scope: '/elsewhere/' }, manifestUrl, page)?.scope,
    'https://example.com/app/',
  );
  assert.equal(parseWebAppManifest(manifest, manifestUrl, 'https://example.com/elsewhere'), null);
});
test('enforces scope origin and path, ignoring search and hash', () => {
  assert.equal(
    isWithinWebAppScope('https://example.com/app/start?q=1#here', 'https://example.com/app/'),
    true,
  );
  assert.equal(
    isWithinWebAppScope('https://example.com/apple/', 'https://example.com/app/'),
    false,
  );
  assert.equal(isWithinWebAppScope('https://evil.test/app/', 'https://example.com/app/'), false);
});
test('skips malformed icons and strips control characters from app names', () => {
  assert.equal(parseWebAppManifest({ ...manifest, name: '\u0000' }, manifestUrl, page), null);
  assert.equal(
    parseWebAppManifest(
      { ...manifest, name: 'Example\nApp', icons: [{ src: 'http://[' }, ...manifest.icons] },
      manifestUrl,
      page,
    )?.name,
    'ExampleApp',
  );
});
test('identity fragments are discarded and relative IDs resolve against the origin', () => {
  assert.equal(
    parseWebAppManifest({ ...manifest, id: 'app-id#section' }, manifestUrl, page)?.id,
    'https://example.com/app-id',
  );
});
