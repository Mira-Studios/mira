import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  MinimizedWindowLifecycle,
  normalizeWindowSuspensionSettings,
} from '../electron/minimizedWindowLifecycle.ts';

function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const events: string[] = [];
  let minimized = true;
  let idle = true;
  let finishCapture: (() => void) | undefined;
  let finishUnload: (() => void) | undefined;
  const preview = { show: () => events.push('preview'), dispose: () => events.push('dispose') };
  const lifecycle = new MinimizedWindowLifecycle({
    isMinimized: () => minimized,
    capture: async () => {
      events.push('capture');
      if (finishCapture)
        await new Promise<void>((resolve) => {
          finishCapture = resolve;
        });
      return idle ? preview : null;
    },
    unload: async () => {
      events.push('unload');
      if (finishUnload)
        await new Promise<void>((resolve) => {
          finishUnload = resolve;
        });
      return idle;
    },
    restore: () => {
      events.push('restore');
    },
    onError: () => events.push('error'),
  });
  context.after(() => lifecycle.close());
  return {
    lifecycle,
    events,
    enable: () => lifecycle.configure({ enabled: true, delayMs: 1000 }),
    setIdle: (value: boolean) => {
      idle = value;
    },
    reopen: () => {
      minimized = false;
      lifecycle.activate();
    },
    holdCapture: () => {
      finishCapture = () => {};
    },
    finishCapture: () => finishCapture?.(),
    holdUnload: () => {
      finishUnload = () => {};
    },
    finishUnload: () => finishUnload?.(),
  };
}

test('suspension is opt-in and invalid delays are bounded', () => {
  assert.deepEqual(normalizeWindowSuspensionSettings(null), { enabled: false, delayMs: 300_000 });
  assert.equal(normalizeWindowSuspensionSettings({ enabled: 'true' }).enabled, false);
  assert.equal(normalizeWindowSuspensionSettings({ delayMs: NaN }).delayMs, 300_000);
  assert.equal(normalizeWindowSuspensionSettings({ delayMs: 0 }).delayMs, 1000);
  assert.equal(normalizeWindowSuspensionSettings({ delayMs: Infinity }).delayMs, 300_000);
  assert.equal(normalizeWindowSuspensionSettings({ delayMs: 1e12 }).delayMs, 86_400_000);
});

test('disabled windows never capture or unload', async (context) => {
  const f = fixture(context);
  f.lifecycle.minimize();
  context.mock.timers.tick(1_000_000);
  await setImmediate();
  assert.deepEqual(f.events, []);
});

test('waits for the delay, unloads, and holds the screenshot through restoration', async (context) => {
  const f = fixture(context);
  f.enable();
  context.mock.timers.tick(999);
  assert.deepEqual(f.events, []);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(f.events, ['capture', 'preview', 'unload']);
  assert.equal(f.lifecycle.isUnloaded, true);
  f.reopen();
  assert.deepEqual(f.events, ['capture', 'preview', 'unload', 'restore']);
  assert.equal(f.lifecycle.ready(), true);
  assert.equal(f.events.at(-1), 'dispose');
});

test('restoring before the delay expires cancels suspension', async (context) => {
  const f = fixture(context);
  f.enable();
  context.mock.timers.tick(999);
  f.reopen();
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.deepEqual(f.events, []);
});

test('restoring during capture disposes the image without unloading tabs', async (context) => {
  const f = fixture(context);
  f.holdCapture();
  f.enable();
  context.mock.timers.tick(1000);
  f.reopen();
  f.finishCapture();
  await setImmediate();
  assert.deepEqual(f.events, ['capture', 'dispose']);
});

test('restoring during teardown waits for teardown before rebuilding', async (context) => {
  const f = fixture(context);
  f.holdUnload();
  f.enable();
  context.mock.timers.tick(1000);
  await setImmediate();
  f.reopen();
  assert.equal(f.events.includes('restore'), false);
  f.finishUnload();
  await setImmediate();
  assert.equal(f.events.at(-1), 'restore');
});

test('disabling restores already suspended windows', async (context) => {
  const f = fixture(context);
  f.enable();
  context.mock.timers.tick(1000);
  await setImmediate();
  f.lifecycle.configure({ enabled: false });
  assert.equal(f.events.at(-1), 'restore');
});

test('a busy window retries after activity ends', async (context) => {
  const f = fixture(context);
  f.setIdle(false);
  f.enable();
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.deepEqual(f.events, ['capture']);
  f.setIdle(true);
  context.mock.timers.tick(30_000);
  await setImmediate();
  assert.deepEqual(f.events, ['capture', 'capture', 'preview', 'unload']);
});

test('activity starting after capture cancels teardown and removes the screenshot', async (context) => {
  const f = fixture(context);
  f.holdUnload();
  f.enable();
  context.mock.timers.tick(1000);
  await setImmediate();
  f.setIdle(false);
  f.finishUnload();
  await setImmediate();
  assert.equal(f.lifecycle.isUnloaded, false);
  assert.equal(f.events.at(-1), 'dispose');
  assert.equal(f.events.includes('restore'), false);
});

test('closing during capture never unloads or revives the window', async (context) => {
  const f = fixture(context);
  f.holdCapture();
  f.enable();
  context.mock.timers.tick(1000);
  f.lifecycle.close();
  f.finishCapture();
  await setImmediate();
  assert.deepEqual(f.events, ['capture', 'dispose']);
});

test('repeated settings notifications do not postpone suspension', async (context) => {
  const f = fixture(context);
  f.enable();
  context.mock.timers.tick(900);
  f.enable();
  context.mock.timers.tick(100);
  await setImmediate();
  assert.equal(f.lifecycle.isUnloaded, true);
});
