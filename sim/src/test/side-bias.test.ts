import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReciprocalSideBias } from "../side-bias.js";
import { STAGES } from "../stage.js";
import { STRATEGIES } from "../strategies.js";

test("reciprocal side-bias eval compares both fighter-id assignments", () => {
  const r = evaluateReciprocalSideBias({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz,
    brainB: STRATEGIES.incumbent,
    seeds: [1, 2, 3],
  });

  assert.equal(r.samples, 3);
  assert.equal(r.aWinsAsP0 + r.bWinsAsP1 + r.drawsAsP0, 3);
  assert.equal(r.aWinsAsP1 + r.bWinsAsP0 + r.drawsAsP1, 3);
  assert.ok(Number.isFinite(r.sideBias));
  assert.ok(r.reciprocalDisagreements >= 0 && r.reciprocalDisagreements <= 3);
});
