import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_DWELL_RADIUS, GOAL_DWELL_TICKS, ROUND_TIMER_MAX_TICKS, STATS, STEP } from "../constants.js";
import { createStepperWorld, stepWorld, worldToFrame } from "../simulate.js";
import type { RulesVersion, Stage, World } from "../types.js";

const stage: Stage = {
  id: "hold-test", name: "Hold test",
  platforms: [{ x: 56, y: 640, w: 1168, h: 80, solid: true }],
  goals: [{ x: 640, y: 584, sx: 640, sy: 584, label: "TARGET" }],
  spawnL: { x: 640, y: 612 }, spawnR: { x: 1100, y: 612 },
};
function holdingWorld(rulesVersion: RulesVersion = 2): World {
  const w = createStepperWorld({ stage, seed: 1, rulesVersion });
  Object.assign(w.fighters[0], { x: 640, y: 612, onGround: true, facing: -1 });
  Object.assign(w.fighters[1], { x: 1100, y: 612, onGround: true, facing: 1 });
  w.gold = { carrier: 0, x: 640, y: 540, vx: 0, vy: 0, dwellT: 0, dwellTicks: 0 };
  w.goal = { ...stage.goals[0], timer: 10 };
  return w;
}
function ticks(w: World, n: number) { for (let i = 0; i < n; i++) stepWorld(w, {}, {}); }

test("one-second hold scores at exactly 120 active ticks, never at 119", () => {
  const w = holdingWorld();
  ticks(w, GOAL_DWELL_TICKS - 1);
  assert.equal(w.fighters[0].score, 0);
  assert.equal(w.gold?.dwellTicks, 119);
  assert.equal(worldToFrame(w).goal.holdTicks, 119);
  assert.equal(worldToFrame(w).goal.holdRequiredTicks, 120);
  stepWorld(w, {}, {});
  assert.equal(w.fighters[0].score, 1);
  assert.equal(w.gold?.dwellT, 1);
  assert.equal(worldToFrame(w).goal.holdTicks, 120);
  ticks(w, 30);
  assert.equal(w.fighters[0].score, 1, "score pause must not award duplicate points");
});

test("exiting the strict radius resets the attempt and reentry starts at one tick", () => {
  const w = holdingWorld();
  ticks(w, 119);
  w.fighters[0].x = 640 + GOAL_DWELL_RADIUS;
  stepWorld(w, {}, {});
  assert.equal(w.gold?.dwellTicks, 0);
  assert.equal(w.gold?.dwellT, 0);
  w.fighters[0].x = 640;
  stepWorld(w, {}, {});
  assert.equal(w.gold?.dwellTicks, 1);
  ticks(w, 118);
  assert.equal(w.fighters[0].score, 0);
  stepWorld(w, {}, {});
  assert.equal(w.fighters[0].score, 1);
});

test("a killing transfer cannot inherit the previous carrier's almost-full ring", () => {
  const w = holdingWorld();
  ticks(w, 119);
  Object.assign(w.fighters[1], { x: 675, facing: -1 });
  stepWorld(w, { left: true }, {});
  assert.equal(w.fighters[0].dead, true);
  assert.equal(w.gold?.carrier, 1);
  assert.equal(w.gold?.dwellTicks, 1);
  assert.equal(worldToFrame(w).goal.holdTicks, 1);
  assert.deepEqual(w.fighters.map(p => p.score), [0, 0]);
});

test("death and gold removal clear hold progress", () => {
  const w = holdingWorld();
  ticks(w, 60);
  w.fighters[0].dead = true;
  stepWorld(w, {}, {});
  assert.equal(w.gold?.dwellTicks, 0);
  assert.equal(worldToFrame(w).goal.holdTicks, 0);
  w.fighters[0].dead = false;
  ticks(w, 30);
  w.gold = null;
  stepWorld(w, {}, {});
  assert.equal(worldToFrame(w).goal.holdTicks, 0);
  assert.equal(w.fighters[0].score, 0);
});

test("committed double KO drops the gold and clears the target ring", () => {
  const w = holdingWorld();
  ticks(w, 119);
  Object.assign(w.fighters[0], { facing: 1, swipeT: STATS.swipeTime + STEP });
  Object.assign(w.fighters[1], { x: 680, facing: -1, swipeT: STATS.swipeTime + STEP });
  stepWorld(w, {}, {});
  assert.ok(w.fighters.every(p => p.dead));
  assert.equal(w.gold, null);
  assert.equal(w.goal, null);
  assert.equal(worldToFrame(w).goal.holdTicks, 0);
  assert.deepEqual(w.fighters.map(p => p.score), [0, 0]);
});

test("hit freeze and round pause never advance hold or expiry timers", () => {
  const w = holdingWorld();
  ticks(w, 60);
  const before = worldToFrame(w);
  w.freeze = STEP * 10;
  ticks(w, 10);
  assert.deepEqual(worldToFrame(w).goal, before.goal);
  w.freeze = 0;
  w.roundPause = 1;
  ticks(w, 30);
  assert.deepEqual(worldToFrame(w).goal, before.goal);
  w.roundPause = 0;
  ticks(w, 59);
  assert.equal(w.fighters[0].score, 0);
  stepWorld(w, {}, {});
  assert.equal(w.fighters[0].score, 1);
});

test("objective expiry still wins over a hold completing on the same tick", () => {
  const w = holdingWorld();
  ticks(w, 119);
  w.goal!.timer = STEP;
  stepWorld(w, {}, {});
  assert.equal(w.gold, null);
  assert.equal(w.goal, null);
  assert.equal(w.fighters[0].score, 0);
  assert.equal(w.roundPause, 0.8);
});

test("round timeout does not credit a partial hold or change score/kill precedence", () => {
  const w = holdingWorld();
  ticks(w, 118);
  w.tick = ROUND_TIMER_MAX_TICKS;
  w.roundKillCounts = [0, 3];
  stepWorld(w, {}, {});
  assert.equal(w.roundWinner, 1);
  assert.equal(w.fighters[0].score, 0);
  assert.equal(w.gold, null);
});

test("a complete hold still resolves before the round-timeout check", () => {
  const w = holdingWorld();
  ticks(w, 119);
  w.tick = ROUND_TIMER_MAX_TICKS;
  w.roundKillCounts = [0, 3];
  stepWorld(w, {}, {});
  assert.equal(w.fighters[0].score, 1);
  assert.equal(w.roundWinner, -1);
  assert.equal(w.roundPause, 1);
});

test("legacy short-hold replay retains its 15-tick floating accumulator", () => {
  const w = holdingWorld(1);
  ticks(w, 14);
  assert.equal(w.fighters[0].score, 0);
  stepWorld(w, {}, {});
  assert.equal(w.fighters[0].score, 1);
  assert.equal(w.gold?.dwellT, 0.12499999999999999);
  assert.equal(worldToFrame(w).goal.holdRequiredTicks, undefined);
});
