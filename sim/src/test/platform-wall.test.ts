import assert from "node:assert/strict";
import test from "node:test";
import { STATS, WALL_SLIDE } from "../constants.js";
import { createStepperWorld, stepWorld } from "../simulate.js";
import { STAGES } from "../stage.js";

const wallStage = {
  ...STAGES.datacenter,
  platforms: [
    { x: 56, y: 640, w: 1168, h: 80, solid: true },
    { x: 456, y: 452, w: 34, h: 188, solid: true },
  ],
  spawnL: { x: 320, y: 590 },
  spawnR: { x: 980, y: 590 },
};

test("solid vertical platforms block horizontal movement", () => {
  const w = createStepperWorld({ stage: wallStage, seed: 1 });
  const f = w.fighters[0];
  f.x = 320;
  f.y = 640 - STATS.bodyH * 0.5;
  f.vx = 0;
  f.vy = 0;
  f.onGround = true;

  for (let i = 0; i < 90; i++) {
    stepWorld(w, { right: true }, {});
  }

  assert.ok(f.x <= 456 - STATS.bodyW * 0.5 + 0.001, `fighter crossed wall face at x=${f.x}`);
});

test("solid vertical platforms create wall-slide contact while airborne", () => {
  const w = createStepperWorld({ stage: wallStage, seed: 1 });
  const f = w.fighters[0];
  f.x = 440;
  f.y = 560;
  f.vx = 320;
  f.vy = 500;
  f.onGround = false;

  stepWorld(w, { right: true }, {});

  assert.equal(f.wall, 1);
  assert.equal(f.x, 456 - STATS.bodyW * 0.5);
  assert.ok(f.vy <= WALL_SLIDE, `wall slide should cap downward speed; vy=${f.vy}`);
});
