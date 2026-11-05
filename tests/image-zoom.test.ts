import test from 'node:test';
import assert from 'node:assert/strict';
import { boundImage, fittedImage, moveImage, FIT_IMAGE } from '../src/imageZoom';

test('fitting preserves aspect ratio and does not enlarge small originals', () => {
  assert.deepEqual(fittedImage({ width: 1200, height: 2400 }, { width: 400, height: 600 }), { width: 300, height: 600 });
  assert.deepEqual(fittedImage({ width: 40, height: 30 }, { width: 400, height: 600 }), { width: 40, height: 30 });
});

test('a moving pinch keeps the same image point under its midpoint', () => {
  const size = { width: 400, height: 300 }, from = { x: -60, y: 20 }, to = { x: -40, y: 40 };
  const view = moveImage(FIT_IMAGE, from, to, 2, size, size);
  assert.deepEqual(view, { scale: 2, x: 80, y: 0 });
  assert.equal(from.x * view.scale + view.x, to.x);
  assert.equal(from.y * view.scale + view.y, to.y);
  // A new one-finger pan starts from that view rather than the pre-pinch view.
  assert.deepEqual(moveImage(view, to, { x: -30, y: 55 }, 2, size, size), { scale: 2, x: 90, y: 15 });
});

test('panning cannot expose empty edges, and narrow dimensions remain centered', () => {
  assert.deepEqual(boundImage({ scale: 3, x: 1000, y: -1000 }, { width: 400, height: 100 }, { width: 400, height: 600 }), { scale: 3, x: 400, y: 0 });
  assert.deepEqual(boundImage({ scale: 1, x: -500, y: 800 }, { width: 400, height: 300 }, { width: 400, height: 600 }), FIT_IMAGE);
});

test('zoom limits also constrain the anchor calculation', () => {
  const size = { width: 400, height: 300 }, anchor = { x: 10, y: 5 };
  assert.deepEqual(moveImage(FIT_IMAGE, anchor, anchor, 20, size, size), { scale: 8, x: -70, y: -35 });
  assert.deepEqual(moveImage({ scale: 3, x: 20, y: 40 }, anchor, anchor, 0.1, size, size), FIT_IMAGE);
});
