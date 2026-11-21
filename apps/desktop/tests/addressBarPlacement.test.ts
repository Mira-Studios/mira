import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeAddressBarPosition,
  resolveAddressBarPosition,
} from '../src/features/settings/addressBarPlacement.ts';
import { workspaceSettings } from '../electron/workspacePolicy.ts';

test('old topbar settings migrate without changing the selected layout', () => {
  assert.equal(normalizeAddressBarPosition(undefined, false), 'toolbar');
  assert.equal(normalizeAddressBarPosition(undefined, true), 'topbar');
  assert.equal(normalizeAddressBarPosition('vertical-tabs', false), 'vertical-tabs');
  assert.equal(
    workspaceSettings({ verticalTabsAddressBarInTopBar: false }).addressBarPosition,
    'toolbar',
  );
});
test('a hidden destination falls back to a visible toolbar', () => {
  assert.equal(resolveAddressBarPosition('vertical-tabs', false), 'toolbar');
  assert.equal(resolveAddressBarPosition('vertical-tabs', true), 'vertical-tabs');
});
