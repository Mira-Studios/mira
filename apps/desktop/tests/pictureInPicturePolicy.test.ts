import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPip, normalizePipVideos, pipMode } from '../electron/pictureInPicturePolicy.ts';
test('tab and hidden-window picture in picture switches are independent', () => {
  const both = { onTabSwitch: true, onWindowHidden: true };
  assert.equal(pipMode(both, false, true), null);
  assert.equal(pipMode(both, false, false), 'window');
  assert.equal(pipMode(both, true, true), 'desktop');
  assert.equal(pipMode({ ...both, onTabSwitch: false }, false, false), null);
  assert.equal(pipMode({ ...both, onWindowHidden: false }, true, false), null);
  assert.equal(pipMode({ ...both, onTabSwitch: false }, true, true), 'desktop');
});
test('saved positions stay on screen or inside the owner window after resizing', () => {
  const area = { x: -1280, y: 60, width: 1280, height: 720 };
  const rect = clampPip({ x: 8000, y: -500, width: 5000, height: 4000 }, area);
  assert.deepEqual(rect, area);
  const small = clampPip(
    { x: -9999, y: 5000, width: 400, height: 250 },
    { x: 40, y: 80, width: 900, height: 600 },
  );
  assert.equal(small.x, 40);
  assert.equal(small.y, 430);
  assert.deepEqual(clampPip({ x: NaN, width: Infinity }, { x: 0, y: 0, width: 150, height: 100 }), {
    x: 0,
    y: 0,
    width: 150,
    height: 100,
  });
});
test('video reports accept only finite bounded media state', () => {
  assert.deepEqual(normalizePipVideos([{ id: 'bad', width: Infinity, height: 20 }]), []);
  const [video] = normalizePipVideos([
    {
      id: 'video',
      width: 1920,
      height: 1080,
      area: 1e20,
      volume: 5,
      currentTime: -1,
      duration: Infinity,
      playing: true,
    },
  ]);
  assert.equal(video.volume, 1);
  assert.equal(video.currentTime, 0);
  assert.equal(video.duration, 0);
  assert.equal(video.area, 100_000_000);
});
