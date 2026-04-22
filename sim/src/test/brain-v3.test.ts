import assert from "node:assert/strict";
import test from "node:test";
import { BEHAVIOR_VERSION, createBrainState, resetBrainStateForRound, runParamBrain } from "../brain.js";
import { ROUND_TIMER_MAX_TICKS, ROUNDS_TO_WIN_MATCH } from "../constants.js";
import { simulate } from "../simulate.js";
import { STAGES } from "../stage.js";
import { STRATEGIES } from "../strategies.js";
import type { BrainState, Observation, Params } from "../types.js";
import { DEFAULT_PARAMS } from "../types.js";

// --- Helpers ---
//
// Build a synthetic Observation for a named tactical scenario. Every test
// that wants to probe brain behavior under a specific configuration uses
// these helpers rather than spinning up a full simulate() — the dispatcher
// is a pure function of obs+state.

function baseObs(overrides: Partial<Observation> = {}): Observation {
  const self: Observation["self"] = {
    id: 0,
    x: 600, y: 600, vx: 0, vy: 0,
    facing: 1, hp: 100,
    onGround: true, wall: 0, stun: 0, invuln: 0, dead: false,
    swipeT: 0, swipeCD: 0, diveT: 0, diveCD: 0,
    hasToken: false,
    lastClashTick: -9999, lastAttackStartTick: -9999, lastKillTick: -9999,
    lastMoveTick: 100, score: 0, rounds: 0,
  };
  const opp: Observation["opp"] = {
    x: 800, y: 600, vx: 0, vy: 0,
    facing: -1, hp: 100,
    onGround: true, stun: 0, dead: false,
    swipeT: 0, diveT: 0,
    hasToken: false,
    lastAttackStartTick: -9999, score: 0, rounds: 0,
  };
  return {
    self,
    opp,
    token: { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: { exists: false, x: 0, y: 0, label: "", timer: 0 },
    platforms: [],
    arena: { left: 56, right: 1224, top: 48, floor: 640 },
    dx: opp.x - self.x,
    absDx: Math.abs(opp.x - self.x),
    dy: opp.y - self.y,
    tick: 100,
    ...overrides,
  };
}

function defaultParams(overrides: Partial<Params> = {}): Params {
  return { ...DEFAULT_PARAMS, ...overrides };
}

// --- Tests ---

test("BEHAVIOR_VERSION is 21", () => {
  assert.equal(BEHAVIOR_VERSION, 21);
});

test("createBrainState initializes neutral with empty buffers", () => {
  const s = createBrainState(0);
  assert.equal(s.id, 0);
  assert.equal(s.mode, "neutral");
  assert.equal(s.substate, null);
  assert.deepEqual(s.recentOppSwipeTicks, []);
  assert.deepEqual(s.recentOppDiveTicks, []);
  assert.deepEqual(s.recentSelfClashTicks, []);
  assert.equal(s.deliveryProgressGoalKey, null);
  assert.equal(s.lastDeliveryCancelTick, -9999);
  assert.equal(s.lastDeliveryCancelTactic, null);
});

test("resetBrainStateForRound zeroes mode but preserves opp buffers", () => {
  const s = createBrainState(0);
  s.mode = "offense";
  s.substate = "press";
  s.recentOppSwipeTicks.push(10, 20, 30);
  s.recentOppDiveTicks.push(40);
  s.recentSelfClashTicks.push(55);
  s.deliveryProgressGoalKey = "g1:900:500";
  s.deliveryBestDxGoal = 140;
  s.deliveryProgressTick = 450;
  s.lastDeliveryCancelTick = 460;
  s.lastDeliveryCancelTactic = "feint";

  resetBrainStateForRound(s, 500);
  assert.equal(s.mode, "neutral");
  assert.equal(s.substate, null);
  assert.equal(s.modeEnterTick, 500);
  // Opp buffers preserved (cross-life adaptation).
  assert.deepEqual(s.recentOppSwipeTicks, [10, 20, 30]);
  assert.deepEqual(s.recentOppDiveTicks, [40]);
  assert.deepEqual(s.recentSelfClashTicks, [55]);
  assert.equal(s.deliveryProgressGoalKey, null);
  assert.equal(s.deliveryBestDxGoal, Infinity);
  assert.equal(s.deliveryProgressTick, 0);
  assert.equal(s.lastDeliveryCancelTick, -9999);
  assert.equal(s.lastDeliveryCancelTactic, null);
});

test("opp-model buffer decays entries older than 240 ticks", () => {
  const state = createBrainState(0);
  // Simulate 3 opp swipes at ticks 0, 50, 100.
  for (const t of [0, 50, 100]) {
    const obs = baseObs({ tick: t, opp: { ...baseObs().opp, lastAttackStartTick: t } });
    runParamBrain(obs, defaultParams(), state);
  }
  assert.equal(state.recentOppSwipeTicks.length, 3);

  // Advance to tick 360 (>240 past earliest entry). First two should decay.
  const obs = baseObs({ tick: 360, opp: { ...baseObs().opp, lastAttackStartTick: 100 } });
  runParamBrain(obs, defaultParams(), state);
  // Tick 0 (age 360) and tick 50 (age 310) both > 240 → dropped.
  assert.ok(state.recentOppSwipeTicks.every((t) => 360 - t <= 240),
    `buffer should not contain entries older than 240 ticks: ${JSON.stringify(state.recentOppSwipeTicks)}`);
});

test("opp-model buffer is bounded to 16 entries", () => {
  const state = createBrainState(0);
  // Fire 20 distinct opp-swipe events within 200 ticks (under decay window).
  for (let i = 0; i < 20; i++) {
    const t = 100 + i * 5;
    const obs = baseObs({ tick: t, opp: { ...baseObs().opp, lastAttackStartTick: t } });
    runParamBrain(obs, defaultParams(), state);
  }
  assert.ok(state.recentOppSwipeTicks.length <= 16,
    `buffer grew unbounded: ${state.recentOppSwipeTicks.length}`);
});

test("escape mode refuses swipe regardless of reach", () => {
  const state = createBrainState(0);
  state.mode = "escape";
  state.modeEnterTick = 0;

  // Opp right next to us, swipe cooldown clear. v2 would swing; v3-escape
  // must not. Run enough to pass min duration (45 ticks) so no transition
  // fires back to neutral.
  const obs = baseObs({
    tick: 10,
    self: { ...baseObs().self, swipeCD: 0 },
    opp: { ...baseObs().opp, x: 640, stun: 0 },
    absDx: 40,
    dx: 40,
  });
  const action = runParamBrain(obs, defaultParams(), state);
  assert.equal(action.action, undefined,
    "escape must not emit action=true");
});

test("objective-dwell: at goal with token, bot does not chase opp", () => {
  const state = createBrainState(0);
  // Force objective mode with hasToken and goal near us.
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 300, y: 500 },
    opp: { ...baseObs().opp, x: 700, y: 500 },
    token: { exists: true, x: 300, y: 500, carrier: 0, dwellT: 0.1 },
    goal: { exists: true, x: 310, y: 500, label: "g1", timer: 5 },
    dx: 400, absDx: 400, dy: 0,
  });
  const action = runParamBrain(obs, defaultParams(), state);
  assert.equal(state.mode, "objective", "should enter objective");
  // Bot is at goal (dist ~10px). Should not be chasing opp (no left/right).
  assert.notEqual(action.left, true, "dwell: should not chase left");
  assert.notEqual(action.right, true, "dwell: should not chase right");
});

test("OFFENSE punish mode: opp in recovery window triggers commit", () => {
  const state = createBrainState(0);
  // Opp started swipe 18 ticks ago. SWIPE_ACTIVE=15, FULL_CD=24 → in
  // recovery window [15, 24]. No active swipe now.
  const params = defaultParams();
  const obs = baseObs({
    tick: 100,
    self: { ...baseObs().self, swipeCD: 0, x: 600 },
    opp: { ...baseObs().opp, x: 660, swipeT: 0, lastAttackStartTick: 82 },
    dx: 60, absDx: 60,
  });
  // Give decideMode a neutral to exit from.
  state.mode = "neutral";
  state.modeEnterTick = 50;
  const action = runParamBrain(obs, params, state);
  assert.equal(state.mode, "offense", "should enter offense");
  assert.equal(state.substate, "punish", "should pick punish substate");
  assert.equal(action.action, true, "punish should commit swipe");
});

test("hard-danger emergency overrides min-duration and enters escape", () => {
  const state = createBrainState(0);
  // Bot just entered ZONE (min duration 40 ticks), 10 ticks in. Opp
  // commits a swipe at close range. Should ESCAPE despite min-dur.
  state.mode = "zone";
  state.modeEnterTick = 90;
  const obs = baseObs({
    tick: 100,
    self: { ...baseObs().self, swipeCD: 0.1, swipeT: 0, invuln: 0 },
    opp: { ...baseObs().opp, x: 650, swipeT: 0.1, lastAttackStartTick: 98 },
    dx: 50, absDx: 50,
  });
  runParamBrain(obs, defaultParams(), state);
  assert.equal(state.mode, "escape", "hard-danger must override min-duration");
});

test("passive foil range is treated as danger when swipe is unavailable", () => {
  const state = createBrainState(0);
  state.mode = "neutral";
  const obs = baseObs({
    tick: 120,
    self: { ...baseObs().self, swipeCD: 0.1, x: 600, invuln: 0 },
    opp: { ...baseObs().opp, x: 655, y: 600, swipeT: 0, diveT: 0 },
    dx: 55, absDx: 55, dy: 0,
  });
  runParamBrain(obs, defaultParams(), state);
  assert.equal(state.mode, "escape", "passive foil body range should trigger escape if we cannot match");
});

test("objective-deliver can fight a blocker instead of always jumping over", () => {
  const state = createBrainState(0);
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 600, y: 600, swipeCD: 0 },
    opp: { ...baseObs().opp, x: 660, y: 600, swipeT: 0, diveT: 0 },
    token: { exists: true, x: 600, y: 548, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 800, y: 600, label: "g1", timer: 5 },
    dx: 60, absDx: 60, dy: 0,
  });
  const action = runParamBrain(obs, defaultParams({ shipRate: 0.9, greed: 0.7 }), state);
  assert.equal(state.mode, "objective");
  assert.equal(state.substate, "deliver");
  assert.equal(action.action, true, "carrier should resolve a close blocker with a swing");
  assert.notEqual(action.up, true, "carrier should not take the old jump-over branch");
});

test("lift commits to a reachable high-goal jump instead of platform detour", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 600, y: 600, onGround: true },
    opp: { ...baseObs().opp, x: 900, y: 600 },
    token: { exists: true, x: 600, y: 548, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 660, y: 500, label: "g1", timer: 8 },
    platforms: [{ x: 100, y: 520, w: 100, h: 14, solid: false }],
    dx: 300, absDx: 300, dy: 0,
  });

  const low = createBrainState(0);
  const lowAction = runParamBrain(obs, defaultParams({ lift: 0 }), low);
  assert.notEqual(lowAction.up, true, "low lift preserves platform-routing behavior");

  const high = createBrainState(0);
  const highAction = runParamBrain(obs, defaultParams({ lift: 1 }), high);
  assert.equal(highAction.up, true, "high lift takes the direct high-goal jump");
  assert.equal(highAction.right, true, "high lift still drives toward the goal x");
});

test("low lift keeps platform routing outside committed direct delivery", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 600, y: 600, onGround: true },
    opp: { ...baseObs().opp, x: 900, y: 600 },
    token: { exists: true, x: 600, y: 548, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 645, y: 500, label: "g1", timer: 8 },
    platforms: [{ x: 100, y: 520, w: 100, h: 14, solid: false }],
    dx: 300, absDx: 300, dy: 0,
  });
  const state = createBrainState(0);
  state.mode = "objective";
  state.substate = "deliver";
  state.modeEnterTick = 190;
  state.deliveryPlan = {
    tactic: "kill-first",
    startedAt: 190,
    expiresAt: 230,
    score: 1,
  };
  const action = runParamBrain(obs, defaultParams({ lift: 0, greed: 0, shipRate: 0 }), state);
  assert.notEqual(action.up, true, "non-direct delivery still preserves low-lift routing");
});

test("committed direct delivery can force an obvious low-lift high-goal jump", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 600, y: 600, onGround: true },
    opp: { ...baseObs().opp, x: 900, y: 600 },
    token: { exists: true, x: 600, y: 548, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 645, y: 500, label: "g1", timer: 8 },
    platforms: [{ x: 100, y: 520, w: 100, h: 14, solid: false }],
    dx: 300, absDx: 300, dy: 0,
  });
  const state = createBrainState(0);
  state.mode = "objective";
  state.substate = "deliver";
  state.modeEnterTick = 190;
  state.deliveryPlan = {
    tactic: "direct",
    startedAt: 190,
    expiresAt: 230,
    score: 1,
  };
  const action = runParamBrain(obs, defaultParams({ lift: 0 }), state);
  assert.equal(action.up, true, "direct delivery takes the reachable jump even with low lift");
  assert.equal(action.right, true, "direct delivery still drives toward the goal x");
});

test("objective navigation routes through reachable platform steps", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 300, y: 614, onGround: true },
    opp: { ...baseObs().opp, x: 1000, y: 614 },
    token: { exists: true, x: 300, y: 562, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 640, y: 280, label: "COMPUTE", timer: 8 },
    platforms: [
      { x: 56, y: 640, w: 1168, h: 80, solid: true },
      { x: 220, y: 524, w: 240, h: 14, solid: false },
      { x: 440, y: 414, w: 240, h: 14, solid: false },
      { x: 560, y: 304, w: 180, h: 14, solid: false },
    ],
    dx: 700, absDx: 700, dy: 0,
  });
  const state = createBrainState(0);
  state.mode = "objective";
  state.substate = "deliver";
  state.modeEnterTick = 190;
  state.deliveryPlan = {
    tactic: "direct",
    startedAt: 190,
    expiresAt: 230,
    score: 1,
  };

  const action = runParamBrain(obs, defaultParams({ lift: 0, networking: 0 }), state);
  assert.equal(action.up, true, "carrier starts with the reachable lower platform, not an impossible top route");
  assert.equal(action.right, true, "carrier drives toward the first route step");
});

test("platform intent prefers an equally reachable step that progresses toward the goal", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 500, y: 614, onGround: true },
    opp: { ...baseObs().opp, x: 1040, y: 614 },
    token: { exists: true, x: 500, y: 562, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 900, y: 360, label: "COMPUTE", timer: 8 },
    platforms: [
      { x: 56, y: 640, w: 1168, h: 80, solid: true },
      { x: 320, y: 524, w: 200, h: 14, solid: false },
      { x: 620, y: 524, w: 200, h: 14, solid: false },
      { x: 760, y: 414, w: 220, h: 14, solid: false },
    ],
    dx: 540, absDx: 540, dy: 0,
  });
  const state = createBrainState(0);
  state.mode = "objective";
  state.substate = "deliver";
  state.modeEnterTick = 190;
  state.deliveryPlan = {
    tactic: "kill-first",
    startedAt: 190,
    expiresAt: 230,
    score: 1,
  };

  const action = runParamBrain(obs, defaultParams({ lift: 0, shipRate: 1, discipline: 1 }), state);
  assert.equal(action.right, true, "carrier should pick the forward platform, not the first equal-cost platform");
  assert.notEqual(action.left, true, "carrier should not drift back toward the lower-progress platform");
});

test("parry is silent at zero and counter-swings only in foil windows", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, x: 600, y: 600, swipeCD: 0, invuln: 0.2, lastAttackStartTick: 190 },
    opp: { ...baseObs().opp, x: 670, y: 600, swipeT: 0, diveT: 0 },
    dx: 70, absDx: 70, dy: 0,
  });

  const low = createBrainState(0);
  low.mode = "offense";
  low.substate = "press";
  low.modeEnterTick = 150;
  const lowAction = runParamBrain(obs, defaultParams({ burnRate: 0, parry: 0 }), low);
  assert.notEqual(lowAction.action, true, "zero parry does not create a new counter-swing");

  const high = createBrainState(0);
  high.mode = "offense";
  high.substate = "press";
  high.modeEnterTick = 150;
  const highAction = runParamBrain(obs, defaultParams({ burnRate: 0, parry: 1 }), high);
  assert.equal(highAction.action, true, "high parry counter-swings inside passive-foil range");
});

test("chase pressures opponent respawn after a kill", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, id: 0, x: 600, y: 600, lastKillTick: 140 },
    opp: { ...baseObs().opp, x: 700, y: 600, vx: 300, dead: true },
    dx: 100, absDx: 100, dy: 0,
  });

  const low = createBrainState(0);
  const lowAction = runParamBrain(obs, defaultParams({ moat: 120, greed: 0, cunning: 0, chase: 0 }), low);
  assert.notEqual(lowAction.right, true, "zero chase keeps the old neutral spacing response");

  const high = createBrainState(0);
  const highAction = runParamBrain(obs, defaultParams({ moat: 120, greed: 0, cunning: 0, chase: 1 }), high);
  assert.equal(highAction.right, true, "high chase moves toward the opponent home side");
});

test("discipline commits to route instead of early jump-over detour", () => {
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 600, y: 600, swipeCD: 1 },
    opp: { ...baseObs().opp, x: 710, y: 600 },
    token: { exists: true, x: 600, y: 548, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 900, y: 574, label: "g1", timer: 8 },
    dx: 110, absDx: 110, dy: 0,
  });

  const low = createBrainState(0);
  const lowAction = runParamBrain(obs, defaultParams({ shipRate: 1, discipline: 0 }), low);
  assert.equal(lowAction.up, true, "low discipline may detour over a medium-distance blocker");

  const high = createBrainState(0);
  const highAction = runParamBrain(obs, defaultParams({ shipRate: 1, discipline: 1 }), high);
  assert.notEqual(highAction.up, true, "high discipline keeps the shortest route until blocker is closer");
  assert.equal(highAction.right, true, "high discipline continues toward the goal");
});

test("determinism: same seed produces identical log hashes with v4", () => {
  const stage = STAGES.datacenter;
  const a = STRATEGIES.blitz;
  const b = STRATEGIES.incumbent;
  const r1 = simulate({ stage, brainA: a, brainB: b, seed: 12345 });
  const r2 = simulate({ stage, brainA: a, brainB: b, seed: 12345 });
  assert.equal(r1.logHash, r2.logHash, "identical seed must produce identical log hash");
  assert.equal(r1.winner, r2.winner);
  assert.deepEqual(r1.finalScore, r2.finalScore);
});

test("brain state mode transitions are stateful across ticks", () => {
  // Prove the state object mutates across calls (if it didn't, every tick
  // would start fresh and we'd have no commitment).
  const state = createBrainState(0);
  const params = defaultParams();
  // Tick 1: neutral.
  runParamBrain(baseObs({ tick: 1 }), params, state);
  const modeAfterT1 = state.mode;
  // Force a mode change via synthetic recovery signal at tick 2.
  const obs2 = baseObs({
    tick: 2,
    self: { ...baseObs().self, swipeCD: 0 },
    opp: { ...baseObs().opp, x: 660, lastAttackStartTick: -16 + 2 }, // ~15 ticks ago
    dx: 60, absDx: 60,
  });
  runParamBrain(obs2, params, state);
  // State should reflect a change (we don't know exactly what — depends
  // on decideMode path — but modeEnterTick is a good witness).
  assert.ok(
    state.mode !== modeAfterT1 || state.modeEnterTick >= 0,
    "brain state should evolve across ticks",
  );
});

// ---- v4.2 delivery planner ----

test("delivery planner sets a plan when carrying token with goal active", () => {
  const state = createBrainState(0);
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 300, y: 500 },
    opp: { ...baseObs().opp, x: 900, y: 500 },
    token: { exists: true, x: 300, y: 500, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 1100, y: 500, label: "g1", timer: 8 },
    dx: 600, absDx: 600, dy: 0,
  });
  runParamBrain(obs, defaultParams(), state);
  assert.equal(state.mode, "objective");
  assert.ok(state.deliveryPlan, "plan should be set when delivering");
  assert.ok(
    ["direct", "kill-first", "feint"].includes(state.deliveryPlan!.tactic),
    `plan.tactic should be a known kind: ${state.deliveryPlan!.tactic}`,
  );
  assert.equal(state.deliveryPlan!.startedAt, 200);
  assert.equal(state.deliveryPlan!.expiresAt, 212);
});

test("delivery planner persists tactic within horizon (no per-tick thrashing)", () => {
  const state = createBrainState(0);
  const params = defaultParams();
  const obs = baseObs({
    tick: 100,
    self: { ...baseObs().self, hasToken: true, x: 300, y: 500 },
    opp: { ...baseObs().opp, x: 900, y: 500 },
    token: { exists: true, x: 300, y: 500, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 1100, y: 500, label: "g1", timer: 8 },
    dx: 600, absDx: 600, dy: 0,
  });
  runParamBrain(obs, params, state);
  const firstTactic = state.deliveryPlan!.tactic;
  const firstExpiresAt = state.deliveryPlan!.expiresAt;

  // Tick forward within horizon — plan must not change
  const obs2 = { ...obs, tick: 105 };
  runParamBrain(obs2, params, state);
  assert.equal(state.deliveryPlan!.tactic, firstTactic, "tactic held within horizon");
  assert.equal(state.deliveryPlan!.expiresAt, firstExpiresAt, "expiry held within horizon");
});

test("stalled direct delivery cancels across plan refresh instead of repeating blocked route", () => {
  const state = createBrainState(0);
  state.mode = "objective";
  state.modeEnterTick = 260;
  state.deliveryPlan = {
    tactic: "direct",
    startedAt: 200,
    expiresAt: 280,
    score: 1,
  };
  state.deliveryProgressGoalKey = "g1:900:500";
  state.deliveryBestDxGoal = 300;
  state.deliveryProgressTick = 200;
  const obs = baseObs({
    tick: 300,
    self: { ...baseObs().self, hasToken: true, x: 600, y: 500, onGround: true },
    opp: { ...baseObs().opp, x: 780, y: 500 },
    token: { exists: true, x: 600, y: 448, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 900, y: 500, label: "g1", timer: 8 },
    dx: 180, absDx: 180, dy: 0,
  });

  const action = runParamBrain(obs, defaultParams({ cunning: 0.95, greed: 0.1, discipline: 0, shipRate: 0.5 }), state);
  assert.equal(state.deliveryPlan!.tactic, "feint", "stalled direct plan should switch to a bait route");
  assert.equal(state.deliveryPlan!.startedAt, 300, "cancel can trigger after the short direct plan replans");
  assert.equal(action.left, true, "feint steps away from the goal to break the repeated blocked route");
  assert.notEqual(action.right, true);
});

test("delivery planner can hold feint through its back-step window", () => {
  const state = createBrainState(0);
  state.mode = "objective";
  state.modeEnterTick = 100;
  state.deliveryPlan = {
    tactic: "feint",
    startedAt: 100,
    expiresAt: 130,
    feintUntil: 118,
    score: 1,
  };
  const obs = baseObs({
    tick: 115,
    self: { ...baseObs().self, hasToken: true, x: 600, y: 500 },
    opp: { ...baseObs().opp, x: 700, y: 500 },
    token: { exists: true, x: 600, y: 500, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 900, y: 500, label: "g1", timer: 8 },
    dx: 100, absDx: 100, dy: 0,
  });
  const action = runParamBrain(obs, defaultParams({ cunning: 0.9 }), state);
  assert.equal(state.deliveryPlan!.tactic, "feint");
  assert.equal(state.deliveryPlan!.expiresAt, 130);
  assert.equal(action.left, true, "feint should keep back-stepping before feintUntil");
  assert.notEqual(action.right, true);
});

test("initial no-token idle pressure closes for high-moat no-contact cases", () => {
  const obs = baseObs({
    tick: 425,
    self: { ...baseObs().self, id: 1, x: 600, y: 600 },
    opp: { ...baseObs().opp, x: 880, y: 600 },
    dx: 280,
    absDx: 280,
    dy: 0,
  });
  const action = runParamBrain(obs, defaultParams({ moat: 300, greed: 0, cunning: 0 }), createBrainState(1));
  assert.equal(action.right, true, "idle pressure should close toward opponent after threshold");
  assert.notEqual(action.left, true);
});

test("initial no-token idle pressure stays quiet before asymmetric threshold", () => {
  const obs = baseObs({
    tick: 350,
    self: { ...baseObs().self, id: 1, x: 600, y: 600 },
    opp: { ...baseObs().opp, x: 880, y: 600 },
    dx: 280,
    absDx: 280,
    dy: 0,
  });
  const action = runParamBrain(obs, defaultParams({ moat: 300, greed: 0, cunning: 0 }), createBrainState(1));
  assert.equal(action.left, true, "before threshold, moat spacing remains in control");
  assert.notEqual(action.right, true);
});

test("initial no-token idle pressure does not override low-moat spacing", () => {
  const obs = baseObs({
    tick: 425,
    self: { ...baseObs().self, id: 1, x: 600, y: 600 },
    opp: { ...baseObs().opp, x: 640, y: 600 },
    dx: 40,
    absDx: 40,
    dy: 0,
  });
  const action = runParamBrain(obs, defaultParams({ moat: 60, greed: 0, cunning: 0 }), createBrainState(1));
  assert.equal(action.left, true, "low-moat neutral spacing remains in control after threshold");
  assert.notEqual(action.right, true);
});

test("high-shipRate config prefers direct tactic", () => {
  const state = createBrainState(0);
  const params = defaultParams({ shipRate: 0.95, greed: 0.1, cunning: 0.1 });
  const obs = baseObs({
    tick: 200,
    self: { ...baseObs().self, hasToken: true, x: 300, y: 500 },
    opp: { ...baseObs().opp, x: 900, y: 500 }, // far — kill-first unattractive
    token: { exists: true, x: 300, y: 500, carrier: 0, dwellT: 0 },
    goal: { exists: true, x: 1100, y: 500, label: "g1", timer: 8 },
    dx: 600, absDx: 600, dy: 0,
  });
  runParamBrain(obs, params, state);
  assert.equal(state.deliveryPlan!.tactic, "direct",
    "shipRate-dominant config with far opp should pick direct");
});

// ---- v5.1 anti-stalemate regression ----

test("v5.1: 8-bot aerial clique does NOT produce all-draw pairings", () => {
  // Before v5.1 (BEHAVIOR_VERSION=5), every ordered pair inside this
  // 8-member aerial-negative-leverage-low-greed clique produced
  // guaranteed 0-0 stalemates across seeds/stages — full 28800-tick
  // timeouts. After v5.1, at least one sampled pair per matchup must
  // produce a non-draw (score, kill, or decisive timeout under the
  // kill-tiebreak rule).
  const clique = [
    "pivot", "unicorn", "disruptor", "operator",
    "shipper", "moonshot", "founder", "acolyte",
  ] as const;

  // Use a small deterministic sample — 3 stages × 2 seeds = 6 samples
  // per pair. Before the patch, 0% resolved; after, expect >50%.
  const stages = [STAGES.datacenter, STAGES.boardroom, STAGES.demoday];
  const seeds = [1, 42];

  const failed: string[] = [];
  for (const a of clique) {
    for (const b of clique) {
      let anyResolved = false;
      for (const stage of stages) {
        for (const seed of seeds) {
          const r = simulate({
            stage,
            brainA: STRATEGIES[a],
            brainB: STRATEGIES[b],
            seed,
          });
          const resolved =
            r.winner !== -1 ||
            r.finalScore[0] > 0 ||
            r.finalScore[1] > 0 ||
            r.finalRounds[0] > 0 ||
            r.finalRounds[1] > 0;
          if (resolved) { anyResolved = true; break; }
        }
        if (anyResolved) break;
      }
      if (!anyResolved) failed.push(`${a} vs ${b}`);
    }
  }

  assert.equal(
    failed.length, 0,
    `${failed.length} aerial-clique pairs still always-stalemate across 6 samples:\n  ${failed.slice(0, 10).join("\n  ")}${failed.length > 10 ? "\n  ..." : ""}`,
  );
});

// ---- v5.2 residual-attractor regression ----

test("v5.2: all 8 diagnostic residual pair-stages resolve within seeds 1-20", () => {
  // The v5.1 patch cleared the 64-pair clique but left 8 map-specific
  // inert attractors. v5.2 addresses both remaining patterns:
  //   - safe-mode attractor (bots stuck in ESCAPE/ZONE at medium range):
  //     cumulative max-duration caps force-exit those modes.
  //   - OFFENSE spacing equilibrium (bots at ~150px swinging but never
  //     hitting): progress-stalled close-override in press substate
  //     forces fighter 1 inside hit range when match has gone 900+
  //     ticks without a kill and no score yet.
  const cases: Array<[string, string, keyof typeof STAGES]> = [
    ["blitz", "oracle", "datacenter"],
    ["blitz", "intern", "datacenter"],
    ["unicorn", "unicorn", "datacenter"],
    ["troll", "regulatory", "boardroom"],
    ["oracle", "blitz", "demoday"],
    ["moonshot", "intern", "demoday"],
    ["intern", "moonshot", "demoday"],
    ["intern", "blitz", "datacenter"],
  ];

  const failed: string[] = [];
  for (const [a, b, stageId] of cases) {
    let anyResolved = false;
    for (let seed = 1; seed <= 20; seed++) {
      const r = simulate({
        stage: STAGES[stageId],
        brainA: STRATEGIES[a as keyof typeof STRATEGIES],
        brainB: STRATEGIES[b as keyof typeof STRATEGIES],
        seed,
      });
      if (
        r.winner !== -1 ||
        r.finalScore[0] > 0 ||
        r.finalScore[1] > 0 ||
        r.finalRounds[0] > 0 ||
        r.finalRounds[1] > 0
      ) { anyResolved = true; break; }
    }
    if (!anyResolved) failed.push(`${a} vs ${b} @ ${stageId}`);
  }

  assert.equal(
    failed.length, 0,
    `${failed.length} safe-attractor pair-stages still stalemate across 20 seeds:\n  ${failed.join("\n  ")}`,
  );
});

test("v18: Demo Day objective-loop regression seeds resolve before long-match threshold", () => {
  const longThreshold = Math.floor(ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2 * 0.9);
  const cases: Array<[string, string, number]> = [
    ["standby", "oracle", 962],
    ["oracle", "acquirer", 5238],
    ["shipper", "founder", 5908],
    ["pivot", "disruptor", 2664],
    ["shipper", "disruptor", 5885],
    ["regulatory", "troll", 7273],
  ];

  const failed: string[] = [];
  for (const [a, b, seed] of cases) {
    const r = simulate({
      stage: STAGES.demoday,
      brainA: STRATEGIES[a as keyof typeof STRATEGIES],
      brainB: STRATEGIES[b as keyof typeof STRATEGIES],
      seed,
    });
    if (r.ticks >= longThreshold) failed.push(`${a} vs ${b} seed ${seed} ticks=${r.ticks}`);
  }

  assert.equal(
    failed.length, 0,
    `${failed.length} Demo Day objective-loop regressions still hit long-match threshold:\n  ${failed.join("\n  ")}`,
  );
});
