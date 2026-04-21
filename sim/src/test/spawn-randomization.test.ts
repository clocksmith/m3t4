import assert from "node:assert/strict";
import test from "node:test";
import { STEP } from "../constants.js";
import { createStepperWorld, stepWorld } from "../simulate.js";
import { STAGES } from "../stage.js";

test("opening spawn side is seeded and round reset flips sides", () => {
  const stage = STAGES.datacenter;
  const w = createStepperWorld({ stage, seed: 1 });
  const p0StartX = w.fighters[0].x;
  const p0StartedLeft = p0StartX === stage.spawnL.x;

  assert.ok(p0StartedLeft || p0StartX === stage.spawnR.x);
  assert.equal(w.fighters[1].x, p0StartedLeft ? stage.spawnR.x : stage.spawnL.x);

  w.fighters[0].rounds = 1;
  w.roundWinner = 0;
  w.roundPause = STEP * 0.5;
  stepWorld(w, {}, {});

  assert.equal(w.fighters[0].x, p0StartedLeft ? stage.spawnR.x : stage.spawnL.x);
  assert.equal(w.fighters[1].x, p0StartedLeft ? stage.spawnL.x : stage.spawnR.x);
});
