import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBackgroundImageCache } from '../src/features/themes/backgroundImageCache.ts';

test('visible window shares a single load across tabs and keeps it after the last tab closes', async () => {
  let loads = 0;
  let releases = 0;
  const cache = createBackgroundImageCache(async () => {
    loads++;
    return {
      image: 'cached-image',
      dispose: () => {
        releases++;
      },
    };
  }, String);
  cache.retain('wallpaper', true);
  const closeFirst = cache.subscribe('wallpaper', () => {});
  const closeSecond = cache.subscribe('wallpaper', () => {});
  await cache.prepare('wallpaper');
  closeFirst();
  closeSecond();
  const openThird = cache.subscribe('wallpaper', () => {});
  assert.equal(cache.snapshot('wallpaper').image, 'cached-image');
  assert.equal(loads, 1);
  assert.equal(releases, 0);
  cache.retain('wallpaper', false);
  assert.equal(cache.snapshot('wallpaper').image, '');
  assert.equal(releases, 1);
  cache.retain('wallpaper', true);
  await cache.prepare('wallpaper');
  assert.equal(loads, 2);
  openThird();
});

test('releasing during a load prevents stale images from returning', async () => {
  let finish!: (value: { image: string; dispose: () => void }) => void;
  let disposed = 0;
  const cache = createBackgroundImageCache(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    String,
  );
  const waiting = cache.prepare('wallpaper');
  cache.retain('wallpaper', false);
  finish({
    image: 'stale',
    dispose: () => {
      disposed++;
    },
  });
  await waiting;
  assert.equal(cache.snapshot('wallpaper').image, '');
  assert.equal(disposed, 1);
});

test('errors can be retried and replaced sources release the old image', async () => {
  let failed = true;
  let disposed = 0;
  const cache = createBackgroundImageCache(
    async (source) => {
      if (failed) throw new Error('offline');
      return {
        image: source,
        dispose: () => {
          disposed++;
        },
      };
    },
    (error) => (error as Error).message,
  );
  await assert.rejects(cache.prepare('first'), /offline/);
  failed = false;
  cache.retain('first', true);
  await cache.prepare('first');
  cache.retain('second', true);
  await cache.prepare('second');
  assert.equal(cache.snapshot('second').image, 'second');
  assert.equal(disposed, 1);
});
