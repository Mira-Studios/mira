import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExplicitPopupRequest } from '../electron/popupPolicy.ts';

test('permission.site legacy popup options request a popup window', () => {
  assert.equal(isExplicitPopupRequest({ features: 'resizable,scrollbars,status' }), true);
  assert.equal(isExplicitPopupRequest({ features: 'resizable=yes,scrollbars=yes,status=yes' }), true);
});

test('ordinary links and privacy features keep opening in tabs', () => {
  for (const features of ['', 'noopener', 'noreferrer', 'noopener,noreferrer', 'attributionsrc']) {
    assert.equal(isExplicitPopupRequest({ features }), false);
  }
});

test('explicit popup flags and user tab dispositions keep their precedence', () => {
  assert.equal(isExplicitPopupRequest({ features: 'popup' }), true);
  assert.equal(isExplicitPopupRequest({ features: 'popup=false,resizable,scrollbars,status,width=500' }), false);
  assert.equal(isExplicitPopupRequest({ features: 'popup=true', disposition: 'background-tab' }), false);
  assert.equal(isExplicitPopupRequest({ features: 'width=500', disposition: 'foreground-tab' }), false);
});

test('full browser chrome remains a normal tab; size and hidden chrome request popups', () => {
  assert.equal(isExplicitPopupRequest({ features: 'toolbar=yes,location=yes,menubar=yes,status=yes,resizable=yes,scrollbars=yes' }), false);
  for (const features of ['width=500,height=400', 'toolbar=no', 'menubar=no', 'scrollbars=no']) {
    assert.equal(isExplicitPopupRequest({ features }), true);
  }
});
