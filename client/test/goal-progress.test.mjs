import test from "node:test";
import assert from "node:assert/strict";
import { drawGoalHoldRing, goalHoldProgress } from "../render/goal-progress.js";

function frame(ticks = 0) {
  return { tick: 500, goal: { exists: true, holdTicks: ticks, holdRequiredTicks: 120 },
    token: { exists: true, carrier: 0, dwellT: ticks / 120 }, p0: { dead: false }, p1: { dead: false } };
}
function draw(f) {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, key) => (...args) => calls.push([key, ...args]) });
  drawGoalHoldRing(ctx, f);
  return calls;
}

test("capture ring maps exact authoritative tick fractions including the final tick", () => {
  for (const ticks of [0, 1, 30, 60, 90, 119, 120]) {
    const f = frame(ticks);
    assert.equal(goalHoldProgress(f).fraction, ticks / 120);
    const arcs = draw(f).filter(c => c[0] === "arc");
    assert.equal(arcs.length, ticks > 0 ? 2 : 1);
    if (ticks > 0) assert.equal(arcs[1][5], -Math.PI / 2 + Math.PI * 2 * (ticks / 120));
  }
  assert.ok(draw(frame(119)).some(c => c[0] === "fillText" && c[1] === "HOLD 0.9 / 1.0s"));
  assert.ok(draw(frame(120)).some(c => c[0] === "fillText" && c[1] === "HOLD 1.0 / 1.0s"));
});

test("pause, rewind, skipped frames and duplicate render do not advance the ring", () => {
  const f = frame(67), before = structuredClone(f), expected = draw(f);
  draw(frame(119)); draw(frame(1)); draw(frame(120));
  assert.deepEqual(draw(f), expected);
  assert.deepEqual(f, before);
});

test("target exit, dead carrier, lost gold and missing target clear the ring", () => {
  assert.equal(goalHoldProgress(frame(0)).fraction, 0);
  const dead = frame(119); dead.p0.dead = true;
  assert.equal(goalHoldProgress(dead).fraction, 0);
  const lost = frame(119); lost.token.exists = false;
  assert.equal(goalHoldProgress(lost).fraction, 0);
  const none = frame(119); none.goal.exists = false;
  assert.equal(goalHoldProgress(none).fraction, 0);
  assert.deepEqual(draw(none), []);
});

test("old trace rings use legacy 15-tick hold, never silently assume one second", () => {
  const f = frame(); delete f.goal.holdTicks; delete f.goal.holdRequiredTicks;
  f.token.dwellT = 10 / 120;
  assert.equal(goalHoldProgress(f).fraction, 10 / 15);
});
