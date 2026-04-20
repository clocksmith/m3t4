import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_DWELL_S,
  RESPAWN_INVULN_S,
  STEP,
} from "../constants.js";
import { createStepperWorld, stepWorld } from "../simulate.js";
import { STAGES } from "../stage.js";

test("respawn invulnerability is shorter than goal dwell", () => {
  assert.ok(
    RESPAWN_INVULN_S < GOAL_DWELL_S,
    `respawn invuln (${RESPAWN_INVULN_S}s) must not outlast dwell (${GOAL_DWELL_S}s)`,
  );
});

test("respawn applies the ruleset invulnerability constant", () => {
  const w = createStepperWorld({ stage: STAGES.datacenter, seed: 1 });
  const victim = w.fighters[1];
  victim.dead = true;
  victim.hp = 0;
  victim.respawnT = STEP;

  stepWorld(w, {}, {});

  assert.equal(victim.dead, false);
  assert.equal(victim.hp, 100);
  assert.equal(victim.invuln, RESPAWN_INVULN_S);
});
