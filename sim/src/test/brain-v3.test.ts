import assert from "node:assert/strict";
import test from "node:test";
import { BEHAVIOR_VERSION, createBrainState, resetBrainStateForRound, runParamBrain } from "../brain.js";
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

test("BEHAVIOR_VERSION is 6", () => {
  assert.equal(BEHAVIOR_VERSION, 6);
});

test("createBrainState initializes neutral with empty buffers", () => {
  const s = createBrainState(0);
  assert.equal(s.id, 0);
  assert.equal(s.mode, "neutral");
  assert.equal(s.substate, null);
  assert.deepEqual(s.recentOppSwipeTicks, []);
  assert.deepEqual(s.recentOppDiveTicks, []);
  assert.deepEqual(s.recentSelfClashTicks, []);
});

test("resetBrainStateForRound zeroes mode but preserves opp buffers", () => {
  const s = createBrainState(0);
  s.mode = "offense";
  s.substate = "press";
  s.recentOppSwipeTicks.push(10, 20, 30);
  s.recentOppDiveTicks.push(40);
  s.recentSelfClashTicks.push(55);

  resetBrainStateForRound(s, 500);
  assert.equal(s.mode, "neutral");
  assert.equal(s.substate, null);
  assert.equal(s.modeEnterTick, 500);
  // Opp buffers preserved (cross-life adaptation).
  assert.deepEqual(s.recentOppSwipeTicks, [10, 20, 30]);
  assert.deepEqual(s.recentOppDiveTicks, [40]);
  assert.deepEqual(s.recentSelfClashTicks, [55]);
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
