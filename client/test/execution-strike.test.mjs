import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPresentation, lethalSwingSides, EXECUTION_DURATION_MS } from '../lib/execution-strike.js';
import { arenaCamera, arenaScreenPoint } from '../render/camera.js';
import { W, H } from '../render/surface.js';

test('only the requested local human sides receive lethal swings', () => {
  assert.deepEqual(lethalSwingSides(true, 'vs-ai'), [true, false]);
  assert.deepEqual(lethalSwingSides(true, 'hot-seat'), [true, true]);
  assert.deepEqual(lethalSwingSides(true, 'p2p'), [false, false]);
  assert.deepEqual(lethalSwingSides(false, 'hot-seat'), [false, false]);
});

test('wall-clock slow motion eases fully back to normal and respects reduced motion', () => {
  const impact = { x: W / 2, y: H / 2, startedAt: 1000 };
  assert.ok(Math.abs(executionPresentation(impact, 1000).timeScale - 0.15) < 1e-10);
  const middle = executionPresentation(impact, 1420);
  assert.ok(middle.timeScale > 0.15 && middle.timeScale < 1);
  assert.deepEqual(executionPresentation(impact, 1000 + EXECUTION_DURATION_MS), { timeScale: 1, camera: null });
  assert.deepEqual(executionPresentation(impact, 1000, true), { timeScale: 1, camera: null });
  assert.deepEqual(executionPresentation(null, 1000), { timeScale: 1, camera: null });
});

test('execution zoom targets the impact, keeps the arena covering the viewport and restores ordinary framing', () => {
  const frame = { p0: { x: 300, y: 612 }, p1: { x: 980, y: 612 } };
  const normal = arenaCamera(frame);
  const camera = arenaCamera(frame, { x: W / 2, y: H / 2, strength: 1 });
  assert.equal(camera.scale, 1.9);
  assert.deepEqual(arenaScreenPoint(camera, { x: W / 2, y: H / 2 }), { x: W / 2, y: H / 2 });
  for (const point of [{x:0,y:0}, {x:W,y:H}]) {
    const camera = arenaCamera(frame, { ...point, strength: 1 });
    assert.ok(camera.x <= 0 && camera.y <= 0);
    assert.ok(W * camera.scale + camera.x >= W && H * camera.scale + camera.y >= H);
  }
  assert.deepEqual(arenaCamera(frame, { x: 20, y: 20, strength: 0 }), normal);
});
