import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptMatchesTab } from '../src/features/tabs/tabPromptScope.ts';

test('same-site pages cannot share prompts; match the guest rather than origin', () => {
  const scope = { tabId: 'a', webContentsId: 10 };
  assert.equal(promptMatchesTab({ webContentsId: 10 }, scope), true);
  assert.equal(promptMatchesTab({ webContentsId: 11 }, scope), false);
  assert.equal(promptMatchesTab({ webContentsId: 11 }, { tabId: 'b' }), false);
});
test('editor save prompts prefer tab identity while window dialogs remain global', () => {
  assert.equal(promptMatchesTab({ app: true, tabId: 'a', webContentsId: 1 }, { tabId: 'a' }), true);
  assert.equal(
    promptMatchesTab({ app: true, tabId: 'a', webContentsId: 1 }, { tabId: 'b' }),
    false,
  );
  assert.equal(promptMatchesTab({ app: true, webContentsId: 1 }, { tabId: 'b' }), true);
  assert.equal(promptMatchesTab({ webContentsId: 10 }), true);
});
