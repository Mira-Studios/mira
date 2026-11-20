import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detachedTabBounds, tabDropIndex, type TabDropLayout } from '../electron/tabDrag.ts';

const horizontal: TabDropLayout = {
  left: 40, top: 8, right: 800, bottom: 40, vertical: false,
  tabs: [{ index: 0, midpoint: 140 }, { index: 1, midpoint: 340 }],
};

test('drop positions insert before, between, and after existing tabs', () => {
  assert.equal(tabDropIndex(horizontal, 50, 20), 0);
  assert.equal(tabDropIndex(horizontal, 200, 20), 1);
  assert.equal(tabDropIndex(horizontal, 700, 20), 2);
  assert.equal(tabDropIndex(horizontal, 200, 80), null);
  assert.equal(tabDropIndex(horizontal, 20, 20), null);
});

test('returning a tab excludes its old slot when calculating the preview and final insertion', () => {
  const layout = { ...horizontal, tabs: [
    { id: 'dragged', index: 0, midpoint: 140 },
    { id: 'second', index: 1, midpoint: 340 },
    { id: 'third', index: 2, midpoint: 540 },
  ] };
  assert.equal(tabDropIndex(layout, 50, 20, 'dragged'), 0);
  assert.equal(tabDropIndex(layout, 400, 20, 'dragged'), 1);
  assert.equal(tabDropIndex(layout, 700, 20, 'dragged'), 2);
});

test('vertical strips use the pointer height and retain real indices for collapsed groups', () => {
  const vertical = { ...horizontal, left: 600, top: 40, right: 800, bottom: 700, vertical: true,
    tabs: [{ index: 0, midpoint: 80 }, { index: 4, midpoint: 220 }] };
  assert.equal(tabDropIndex(vertical, 700, 50), 0);
  assert.equal(tabDropIndex(vertical, 700, 120), 4);
  assert.equal(tabDropIndex(vertical, 700, 500), 5);
  assert.equal(tabDropIndex(vertical, 500, 120), null);
  assert.equal(tabDropIndex({ ...horizontal, tabs: [] }, 200, 20), 0);
});

test('detaching creates a compact window with the grab point under the pointer', () => {
  assert.deepEqual(detachedTabBounds({ width: 1920, height: 1080 }, -500, 200, 80, 12), {
    x: -580, y: 188, width: 900, height: 650,
  });
  const small = detachedTabBounds({ width: 800, height: 600 }, 100, 100);
  assert.equal(small.width, 600);
  assert.equal(small.height, 450);
});
