import assert from "node:assert/strict";
import test from "node:test";
import { ROUND_TIMER_MAX_TICKS } from "../constants.js";
import { createStepperWorld, settleWorldWinner, stepWorld } from "../simulate.js";
import { STAGES } from "../stage.js";

test("timeout tiebreak uses total kills after rounds and score", () => {
  const w = createStepperWorld({ stage: STAGES.datacenter, seed: 1 });
  w.killCounts = [3, 5];

  settleWorldWinner(w);

  assert.equal(w.matchWinner, 1);
});

test("timeout tiebreak prefers score over kills", () => {
  const w = createStepperWorld({ stage: STAGES.datacenter, seed: 1 });
  w.fighters[0].score = 1;
  w.killCounts = [0, 9];

  settleWorldWinner(w);

  assert.equal(w.matchWinner, 0);
});

test("round timer awards a round by round kills before match horizon", () => {
  const w = createStepperWorld({ stage: STAGES.datacenter, seed: 1 });
  w.tick = ROUND_TIMER_MAX_TICKS;
  w.roundKillCounts = [4, 1];

  stepWorld(w, {}, {});

  assert.equal(w.roundWinner, 0);
  assert.equal(w.fighters[0].rounds, 1);
  assert.equal(w.matchWinner, -1);
  assert.ok(w.roundPause > 0);
});
