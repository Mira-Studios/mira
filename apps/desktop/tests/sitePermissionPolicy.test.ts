import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  automaticSitePermissionDecision,
  mapPermissionIdsFromDetails,
  sitePermissionLabel,
  describeSitePermissionRequest,
  isSitePermissionId,
} from '../electron/sitePermissionPolicy.ts';

test('persistent storage is distinct from cross-site cookies and silent for first-party pages', () => {
  assert.deepEqual(mapPermissionIdsFromDetails('persistent-storage', {}), ['persistent-storage']);
  assert.deepEqual(mapPermissionIdsFromDetails('storage-access', {}), ['storage-access']);
  assert.equal(sitePermissionLabel('persistent-storage'), 'Persistent storage');
  assert.equal(
    automaticSitePermissionDecision(
      'persistent-storage',
      'https://game.test/play',
      'https://game.test/',
    ),
    true,
  );
  assert.equal(
    automaticSitePermissionDecision(
      'persistent-storage',
      'https://frame.test/',
      'https://game.test/',
    ),
    false,
  );
  assert.equal(
    automaticSitePermissionDecision(
      'persistent-storage',
      'https://game.test/',
      'https://game.test/',
      true,
    ),
    false,
  );
});

test('copying is silent and cannot grant clipboard reading', () => {
  assert.deepEqual(mapPermissionIdsFromDetails('clipboard-sanitized-write', {}), [
    'clipboard-write',
  ]);
  assert.deepEqual(mapPermissionIdsFromDetails('clipboard-read', {}), ['clipboard']);
  assert.equal(
    automaticSitePermissionDecision(
      'clipboard-sanitized-write',
      'https://game.test/',
      'https://game.test/',
    ),
    true,
  );
  assert.equal(
    automaticSitePermissionDecision('clipboard-read', 'https://game.test/', 'https://game.test/'),
    undefined,
  );
  assert.equal(describeSitePermissionRequest(['clipboard']), 'Read your clipboard');
});

test('unmapped permissions keep their identity and can appear in saved settings', () => {
  const [first] = mapPermissionIdsFromDetails('local-fonts', {});
  const [second] = mapPermissionIdsFromDetails('background-sync', {});
  assert.notEqual(first, second);
  assert.equal(isSitePermissionId(first), true);
  assert.equal(isSitePermissionId('unknown'), true); // Legacy decisions remain manageable.
  assert.match(describeSitePermissionRequest([first]), /local-fonts/);
  assert.equal(sitePermissionLabel(first), 'Browser permission: local-fonts');
  assert.deepEqual(mapPermissionIdsFromDetails('mediaKeySystem', {}), ['protected-media']);
});
