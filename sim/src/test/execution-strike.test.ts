import test from 'node:test';
import assert from 'node:assert/strict';
import { createStepperWorld, stepWorld, worldToFrame } from '../simulate.js';
import { STAGES } from '../stage.js';

const idle = { left: false, right: false, up: false, down: false, action: false };
const swing = { ...idle, action: true };
const world = () => createStepperWorld({ stage: STAGES.datacenter, seed: 17 });

test('explicit local execution defeats distance and spawn protection and retains ordinary kill bookkeeping', () => {
  const w = world();
  w.fighters[0].x = 100;
  w.fighters[1].x = 1180;
  w.fighters[1].invuln = 10;
  const result = stepWorld(w, swing, idle, { lethalSwings: [true, false] });
  assert.equal(result.execution?.killer, 0);
  assert.equal(result.execution?.victim, 1);
  assert.equal(result.execution?.x, w.fighters[1].x);
  assert.equal(w.fighters[1].dead, true);
  assert.equal(w.fighters[1].hp, 0);
  assert.equal(w.killCounts[0], 1);
  assert.equal(w.gold?.carrier, 0);
  assert.ok(w.freeze > 0);
  assert.equal(stepWorld(w, swing, idle, { lethalSwings: [true, false] }).execution, undefined);
});

test('execution takes priority over a counter-swing while hot-seat simultaneous swings choose one deterministic winner', () => {
  const a = world(), b = world();
  for (const w of [a, b]) {
    w.fighters[0].x = 600;
    w.fighters[1].x = 640;
    w.fighters[0].invuln = w.fighters[1].invuln = 0;
  }
  const result = stepWorld(a, swing, swing, { lethalSwings: [true, false] });
  assert.equal(result.execution?.killer, 0);
  assert.equal(a.fighters[0].dead, false);
  const hotseat = stepWorld(b, swing, swing, { lethalSwings: [true, true] });
  assert.ok(hotseat.execution);
  assert.equal(b.fighters.filter(f => f.dead).length, 1);
  const repeat = world();
  repeat.fighters[0].x = 600; repeat.fighters[1].x = 640;
  repeat.fighters[0].invuln = repeat.fighters[1].invuln = 0;
  assert.deepEqual(stepWorld(repeat, swing, swing, { lethalSwings: [true, true] }), hotseat);
});

test('inactive, stunned and cooling-down fighters cannot cause executions; disabled and omitted options agree', () => {
  for (const condition of ['idle', 'stun', 'cooldown']) {
    const w = world();
    w.fighters[0].stun = condition === 'stun' ? 1 : 0;
    w.fighters[0].swipeCD = condition === 'cooldown' ? 1 : 0;
    assert.equal(stepWorld(w, condition === 'idle' ? idle : swing, idle, { lethalSwings: [true, false] }).execution, undefined);
  }
  const a = world(), b = world();
  for (let tick = 0; tick < 180; tick++) {
    const action = tick % 30 === 0 ? swing : idle;
    assert.deepEqual(stepWorld(a, action, idle), stepWorld(b, action, idle, { lethalSwings: [false, false] }));
    assert.deepEqual(worldToFrame(a), worldToFrame(b));
  }
});

test('enabling only human P1 never gives the AI a lethal swing; hot-seat P2 can execute', () => {
  const a = world(), b = world();
  assert.equal(stepWorld(a, idle, swing, { lethalSwings: [true, false] }).execution, undefined);
  assert.equal(a.fighters[0].dead, false);
  assert.equal(stepWorld(b, idle, swing, { lethalSwings: [true, true] }).execution?.killer, 1);
});
