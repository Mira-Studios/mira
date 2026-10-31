import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextPageZoom, PAGE_ZOOM_FACTORS } from '../electron/pageZoomPolicy.ts';

test('zoom follows browser percentage steps in either direction', () => {
  assert.equal(nextPageZoom(1, 'in'), 1.1);
  assert.equal(nextPageZoom(1.1, 'in'), 1.25);
  assert.equal(nextPageZoom(1.25, 'out'), 1.1);
  assert.equal(nextPageZoom(1, 'out'), 0.9);
  for (let i = 1; i < PAGE_ZOOM_FACTORS.length; i++) {
    assert.equal(nextPageZoom(PAGE_ZOOM_FACTORS[i - 1], 'in'), PAGE_ZOOM_FACTORS[i]);
    assert.equal(nextPageZoom(PAGE_ZOOM_FACTORS[i], 'out'), PAGE_ZOOM_FACTORS[i - 1]);
  }
});

test('zoom clamps at 25–500% and Reset always returns 100%', () => {
  assert.equal(nextPageZoom(5, 'in'), 5);
  assert.equal(nextPageZoom(0.25, 'out'), 0.25);
  assert.equal(nextPageZoom(2.5, 'reset'), 1);
  assert.equal(nextPageZoom(0.67, 'reset'), 1);
});

test('arbitrary native levels select the nearest next step and handle rounding', () => {
  assert.equal(nextPageZoom(1.3, 'in'), 1.5);
  assert.equal(nextPageZoom(1.3, 'out'), 1.25);
  assert.equal(nextPageZoom(1.1000000001, 'out'), 1);
  assert.equal(nextPageZoom(Number.NaN, 'in'), 1.1);
});
