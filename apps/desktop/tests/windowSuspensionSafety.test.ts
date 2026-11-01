import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebContents } from 'electron';
import { areWindowContentsIdle, hasWindowDownloads } from '../electron/windowSuspensionSafety.ts';

test('active and paused downloads protect their owner, and unknown owners protect all windows', () => {
  const owners = new Map([
    ['active', 1],
    ['paused', 2],
  ]);
  assert.equal(hasWindowDownloads(1, ['active', 'paused'], owners), true);
  assert.equal(hasWindowDownloads(2, ['active', 'paused'], owners), true);
  assert.equal(hasWindowDownloads(3, ['active', 'paused'], owners), false);
  assert.equal(hasWindowDownloads(3, ['unknown'], owners), true);
  assert.equal(hasWindowDownloads(1, [], owners), false);
});

function content(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoading: () => false,
    isCurrentlyAudible: () => false,
    isBeingCaptured: () => false,
    isDevToolsOpened: () => false,
    mainFrame: { framesInSubtree: [{ detached: false, executeJavaScript: async () => true }] },
    ...overrides,
  } as unknown as WebContents;
}

test('idle tabs pass and any active background tab blocks the entire window', async () => {
  assert.equal(await areWindowContentsIdle([content(), content()]), true);
  assert.equal(
    await areWindowContentsIdle([content(), content({ isCurrentlyAudible: () => true })]),
    false,
  );
});

test('built-in editor drafts and pending restore prompts protect the shell', async () => {
  const shell = content({ executeJavaScript: async () => false });
  assert.equal(await areWindowContentsIdle([content()], shell), false);
});

test('loading, captured, crashed, and inspected contents remain loaded', async () => {
  for (const state of [
    'isDestroyed',
    'isCrashed',
    'isLoading',
    'isCurrentlyAudible',
    'isBeingCaptured',
    'isDevToolsOpened',
  ]) {
    assert.equal(await areWindowContentsIdle([content({ [state]: () => true })]), false, state);
  }
});

test('all frames must positively confirm idle, including cross-origin frames', async () => {
  for (const result of [false, undefined, null, 'true']) {
    const frames = [true, result].map((value) => ({
      detached: false,
      executeJavaScript: async () => value,
    }));
    assert.equal(
      await areWindowContentsIdle([content({ mainFrame: { framesInSubtree: frames } })]),
      false,
    );
  }
});

test('unreadable or unresponsive frames prevent suspension', async (context) => {
  const failed = {
    detached: false,
    executeJavaScript: async () => {
      throw new Error('Frame unavailable');
    },
  };
  assert.equal(
    await areWindowContentsIdle([content({ mainFrame: { framesInSubtree: [failed] } })]),
    false,
  );
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = { detached: false, executeJavaScript: () => new Promise(() => {}) };
  const result = areWindowContentsIdle([content({ mainFrame: { framesInSubtree: [hung] } })]);
  context.mock.timers.tick(2000);
  assert.equal(await result, false);
});
