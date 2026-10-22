import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS } from '../constants.js';
import { swordSeg, swordHits, fighterHurtbox } from '../combat-geometry.js';

test('shared weapon geometry preserves the historical arithmetic at every combat phase', () => {
  for (const facing of [-1, 1]) for (const diveT of [0, .28]) for (let i = 0; i <= 120; i++) {
    const f = { x: 417.25, y: 612, facing, swipeT: STATS.swipeTime * i / 120, diveT };
    let angle = 0;
    if (diveT > 0) angle = Math.PI * .46;
    else if (f.swipeT > 0) {
      const t = 1 - f.swipeT / STATS.swipeTime;
      angle = 0 + (-1 - 0) * (1 - (1 - t) * (1 - t) * (1 - t));
    }
    const bx = f.x + facing * STATS.bodyW * .35;
    const by = f.y - STATS.bodyH * .3;
    assert.deepEqual(swordSeg(f), { bx, by, tx: bx + Math.cos(angle) * facing * STATS.sword, ty: by + Math.sin(angle) * STATS.sword });
  }
});

test('damage uses the combat circle, including tangency, not the movement rectangle', () => {
  const target = { x: 0, y: 0 };
  const hurt = fighterHurtbox(target);
  assert.deepEqual(hurt, { x: 0, y: -15.680000000000001, radius: 18.2 });
  assert.equal(swordHits({ bx: -30, by: hurt.y + hurt.radius, tx: 30, ty: hurt.y + hurt.radius }, target), true);
  assert.equal(swordHits({ bx: -30, by: hurt.y + hurt.radius + .001, tx: 30, ty: hurt.y + hurt.radius + .001 }, target), false);
  assert.equal(swordHits({ bx: -30, by: 25, tx: 30, ty: 25 }, target), false);
});

test('passive weapon remains damaging and dive takes priority over swipe', () => {
  const f = { x: 0, y: 0, facing: 1, swipeT: 0, diveT: 0 };
  assert.equal(swordHits(swordSeg(f), { x: 45, y: 0 }), true);
  assert.deepEqual(swordSeg({ ...f, diveT: .2, swipeT: .1 }), swordSeg({ ...f, diveT: .2 }));
});

test('trace snapshots expose existing simulation pose timers without changing the fighter', async () => {
  const { createStepperWorld, worldToFrame } = await import('../simulate.js');
  const { STAGES } = await import('../stage.js');
  const world = createStepperWorld({ stage: STAGES.datacenter, seed: 17 });
  world.fighters[0].respawnT = 0.3;
  world.fighters[0].lastAttackStartTick = 31;
  const before = structuredClone(world.fighters[0]);
  const frame = worldToFrame(world);
  assert.equal(frame.p0.respawnT, 0.3);
  assert.equal(frame.p0.lastAttackStartTick, 31);
  assert.deepEqual(world.fighters[0], before);
});
