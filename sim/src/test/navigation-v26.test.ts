import assert from "node:assert/strict";
import test from "node:test";
import { createBrainState, runParamBrain } from "../brain.js";
import { DEFAULT_PARAMS } from "../types.js";
import { compileBrain } from "../dsl.js";
import { createStepperWorld, runBrainForWorld, stepWorld, worldObservation } from "../simulate.js";
import { STAGES } from "../stage.js";
import { STRATEGIES } from "../strategies.js";

// Controlled route regression, not a win-rate or combat-strength assertion.
// A dead opponent leaves only navigation, landing and continuous goal hold.
test("every stage goal is reachable and holdable from either side and center", () => {
  for (const stage of Object.values(STAGES)) for (const name of ["standby", "intern", "blitz", "regulatory", "shipper"] as const) {
    for (const goal of stage.goals) for (const startX of [280, 640, 1000]) {
      const w = createStepperWorld({ stage, seed: 7 });
      Object.assign(w.fighters[0], { x: startX, y: 612, onGround: true });
      Object.assign(w.fighters[1], { dead: true, respawnT: 999 });
      w.gold = { x: startX, y: 612, carrier: 0, dwellT: 0, vx: 0, vy: 0 };
      w.goal = { ...goal, timer: 1000 };
      const brain = compileBrain(STRATEGIES[name]);
      while (w.tick < 1600 && w.fighters[0].score === 0) {
        stepWorld(w, runBrainForWorld(w, brain, 0), {});
      }
      assert.ok(w.fighters[0].score > 0, `${stage.id}/${name}/${goal.label}/x${startX}`);
    }
  }
});

test("entering the goal radius from below does not cut a landing jump", () => {
  const w = createStepperWorld({ stage: STAGES.datacenter, seed: 7 });
  const obs = worldObservation(w, 0);
  Object.assign(obs.self, { x: 210, y: 550, vy: -900, onGround: false, hasToken: true });
  Object.assign(obs.opp, { dead: true });
  obs.goal = { exists: true, ...STAGES.datacenter.goals[0], timer: 10 };
  obs.token = { exists: true, x: 210, y: 550, carrier: 0, dwellT: 0.01 };
  const action = runParamBrain(obs, DEFAULT_PARAMS, createBrainState(0));
  assert.equal(action.up, true, "feet must clear the supporting platform before holding");
  assert.ok(!action.down);
});

test("wall-route ascent is retained after vertical clearance but before crossing", () => {
  const w = createStepperWorld({ stage: STAGES.datacenter, seed: 7 });
  const obs = worldObservation(w, 0);
  Object.assign(obs.self, { x: 537, y: 413, vx: 307, vy: -900, onGround: false, hasToken: true });
  Object.assign(obs.opp, { dead: true });
  obs.goal = { exists: true, ...STAGES.datacenter.goals[0], timer: 10 };
  obs.token = { exists: true, x: 537, y: 413, carrier: 0, dwellT: 0 };
  const action = runParamBrain(obs, DEFAULT_PARAMS, createBrainState(0));
  assert.equal(action.up, true);
  assert.equal(action.left, true);
  assert.ok(!action.down, "down would cut the jump before reversing wall-jump recoil");
});

test("an airborne route keeps its landing step rather than chasing a higher platform", () => {
  const w = createStepperWorld({ stage: STAGES.demoday, seed: 7 });
  const obs = worldObservation(w, 0);
  obs.tick = 120;
  Object.assign(obs.self, { x: 520, y: 325, vx: 0, vy: -700, onGround: false, hasToken: true });
  Object.assign(obs.opp, { dead: true });
  obs.goal = { exists: true, ...STAGES.demoday.goals[2], timer: 10 };
  obs.token = { exists: true, x: 520, y: 325, carrier: 0, dwellT: 0 };
  const state = createBrainState(0);
  state.navigation = { targetX: 640, targetY: 132, startedAt: 100,
    x1: 394, x2: 546, y: 272, move: "jump" };
  const previous = structuredClone(state.navigation);
  const action = runParamBrain(obs, DEFAULT_PARAMS, state);
  assert.deepEqual(state.navigation, previous);
  assert.equal(action.up, true);
  assert.ok(!action.left && !action.right, "finish this landing instead of switching toward the upper platform");
});
