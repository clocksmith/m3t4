import assert from "node:assert/strict";
import test from "node:test";
import { createBrainState, resetBrainStateForRound, runParamBrain } from "../brain.js";
import { DEFAULT_PARAMS } from "../types.js";
import type { Observation } from "../types.js";
import { compileBrain } from "../dsl.js";
import { createStepperWorld, packAction, runBrainForWorld, stepWorld, unpackAction, worldObservation } from "../simulate.js";
import { STAGES } from "../stage.js";
import { STRATEGIES } from "../strategies.js";

function observe(tick: number): Observation {
  const world = createStepperWorld({ stage: STAGES.datacenter, seed: 7 });
  const obs = worldObservation(world, 0);
  obs.tick = tick;
  Object.assign(obs.self, { x: 600, y: 612, onGround: true, lastMoveTick: 0 });
  Object.assign(obs.opp, { x: 680, y: 612, onGround: true });
  obs.dx = obs.absDx = 80; obs.dy = 0;
  return obs;
}

const params = { ...DEFAULT_PARAMS, lift: 0.6, cunning: 0.5, parry: 0.4 };

test("failed actions cause committed, different answers across mode switches", () => {
  const state = createBrainState(0);
  const plans = new Set<string>();
  let switches = 0, last: string | undefined;
  for (let tick = 0; tick < 800; tick++) {
    const obs = observe(tick);
    // Observable failed swipes, with no movement, damage, kills or goal progress.
    obs.self.lastAttackStartTick = Math.floor(tick / 24) * 24;
    state.mode = tick % 2 ? "neutral" : "offense";
    state.modeEnterTick = tick;
    runParamBrain(obs, params, state);
    const current = state.tactics?.plan?.tactic;
    if (current) plans.add(current);
    if (current !== last) switches++;
    last = current;
  }
  assert.ok(plans.size >= 3, `must try different viable answers, got ${[...plans]}`);
  assert.ok(switches < 16, "plans must commit, not flip per frame");
  assert.ok(state.tactics!.failures.length <= 8);
  assert.ok(state.tactics!.failures.every(f => 799 - f.tick < 720));
});

test("real progress does not trigger gratuitous tactical randomness", () => {
  const state = createBrainState(0);
  for (let tick = 0; tick < 230; tick++) {
    const obs = observe(tick);
    obs.self.x = 100 + tick * 2;
    obs.opp.x = 1100;
    obs.dx = obs.absDx = obs.opp.x - obs.self.x;
    runParamBrain(obs, params, state);
    assert.equal(state.tactics?.plan, null);
  }
});

test("legitimate goal dwell is never mistaken for being stuck", () => {
  const state = createBrainState(0);
  for (let tick = 0; tick < 600; tick++) {
    const obs = observe(tick);
    obs.self.hasToken = true;
    obs.goal = { exists: true, x: obs.self.x, y: obs.self.y - 28, timer: 5, label: "CUSTOMERS" };
    obs.token = { exists: true, carrier: 0, x: obs.self.x, y: obs.self.y, dwellT: 0.05 };
    const action = runParamBrain(obs, params, state);
    assert.equal(state.tactics?.plan, null);
    assert.ok(!action.left && !action.right && !action.down);
  }
});

test("new objective, death and round reset invalidate old failure memory", () => {
  const state = createBrainState(0);
  for (let tick = 0; tick < 400; tick++) runParamBrain(observe(tick), params, state);
  assert.ok(state.tactics?.failures.length);
  const obs = observe(401);
  obs.self.hasToken = true;
  obs.goal = { exists: true, x: 1070, y: 494, timer: 10, label: "RUNWAY" };
  runParamBrain(obs, params, state);
  assert.deepEqual(state.tactics?.failures, []);
  assert.equal(state.tactics?.plan, null);
  obs.self.dead = true;
  assert.deepEqual(runParamBrain(obs, params, state), {});
  assert.equal(state.tactics, null);
  runParamBrain(observe(403), params, state);
  resetBrainStateForRound(state, 404);
  assert.equal(state.tactics, null);
});

test("vertical recovery does not select impossible ground combat or platform drop", () => {
  const state = createBrainState(0);
  const choices = new Set<string>();
  for (let tick = 0; tick < 1000; tick++) {
    const obs = observe(tick);
    obs.opp.y = 250; obs.dy = obs.opp.y - obs.self.y;
    runParamBrain(obs, params, state);
    if (state.tactics?.plan) choices.add(state.tactics.plan.tactic);
  }
  assert.deepEqual([...choices], ["route"]);
});

test("recovery actions depend only on observation, parameters and own memory", () => {
  const a = createBrainState(0), b = createBrainState(0);
  for (let tick = 0; tick < 600; tick++) {
    const obs = observe(tick);
    const left = runParamBrain(obs, params, a);
    const right = runParamBrain(structuredClone(obs), { ...params }, b);
    assert.deepEqual(left, right);
    assert.deepEqual(a, b);
  }
});

test("matched-seed tactical recovery produces deterministic input logs", () => {
  function run() {
    const w = createStepperWorld({ stage: STAGES.demoday, seed: 7273 });
    const replay = createStepperWorld({ stage: STAGES.demoday, seed: 7273 });
    const brains = [compileBrain(STRATEGIES.regulatory), compileBrain(STRATEGIES.troll)];
    const actions = [];
    for (let t = 0; t < 2400; t++) {
      const active = w.freeze <= 0 && w.roundPause <= 0;
      const a = active ? runBrainForWorld(w, brains[0], 0) : {};
      const b = active ? runBrainForWorld(w, brains[1], 1) : {};
      actions.push([a, b]);
      stepWorld(w, a, b);
      stepWorld(replay, unpackAction(packAction(a)), unpackAction(packAction(b)));
    }
    assert.deepEqual(replay.fighters, w.fighters);
    assert.deepEqual(replay.gold, w.gold);
    assert.equal(replay.tick, w.tick);
    return { actions, fighters: w.fighters, gold: w.gold, tick: w.tick };
  }
  assert.deepEqual(run(), run());
});

test("brief stuns preserve failed-route evidence instead of counting as progress", () => {
  const state = createBrainState(0);
  for (let tick = 0; tick < 150; tick++) runParamBrain(observe(tick), params, state);
  const plan = structuredClone(state.tactics!.plan);
  const progress = state.tactics!.progressTick;
  assert.ok(plan);
  for (let tick = 150; tick < 160; tick++) {
    const obs = observe(tick);
    obs.self.stun = 0.08;
    runParamBrain(obs, params, state);
    assert.deepEqual(state.tactics!.plan, plan);
    assert.equal(state.tactics!.progressTick, progress);
  }
  for (let tick = 160; tick < 240; tick++) runParamBrain(observe(tick), params, state);
  assert.ok(state.tactics!.failures.some(f => f.tactic === plan.tactic));
});

test("visible successful damage is not mislabeled as repeated ineffective attacks", () => {
  const state = createBrainState(0);
  for (let tick = 0; tick < 120; tick++) runParamBrain(observe(tick), params, state);
  const obs = observe(120);
  obs.opp.hp -= 10;
  runParamBrain(obs, params, state);
  assert.equal(state.tactics!.progressTick, 120);
  assert.equal(state.tactics!.attempts, 0);
  assert.equal(state.tactics!.plan, null);
});

test("repeated passive clash recoil separates an overlapping stunned pair", () => {
  const w = createStepperWorld({ stage: STAGES.boardroom, seed: 43 });
  for (const i of [0, 1] as const) {
    Object.assign(w.fighters[i], { x: i === 0 ? 641 : 639, y: 76, onGround: false,
      stun: 0.09, lastClashTick: 40, vx: i === 0 ? -260 : 260, vy: -150 });
    w.brainStates[i].recentSelfClashTicks = [5, 10, 15, 20, 25, 30, 35, 40];
    w.brainStates[i].lastKnownSelfClashTick = 40;
  }
  w.tick = 41;
  const brains = [compileBrain(STRATEGIES.standby), compileBrain(STRATEGIES.standby)];
  for (let tick = 0; tick < 240; tick++) {
    const active = w.freeze <= 0 && w.roundPause <= 0;
    stepWorld(w, active ? runBrainForWorld(w, brains[0], 0) : {},
      active ? runBrainForWorld(w, brains[1], 1) : {});
    if (w.fighters.some(f => f.dead) || Math.abs(w.fighters[0].x-w.fighters[1].x)>80) return;
  }
  assert.fail("clash bind must separate or resolve without a mechanics change");
});
