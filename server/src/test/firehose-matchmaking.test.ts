import assert from "node:assert/strict";
import test from "node:test";
import {
  humanPivotTarget,
  humanPivotWeight,
  pairEloBonusForMatchup,
} from "../firehose.js";

test("scarce humans are weighted into sys ladder matches early", () => {
  assert.equal(humanPivotTarget(1, 16), 0.55);
  assert.ok(humanPivotWeight(1, 16) > 16);
  assert.ok(pairEloBonusForMatchup(true, false, 1) > pairEloBonusForMatchup(true, true, 2));
});

test("filled human pools transition toward human-human preference", () => {
  assert.equal(humanPivotTarget(16, 16), 0.70);
  assert.ok(pairEloBonusForMatchup(true, true, 32) > pairEloBonusForMatchup(true, false, 32));
  assert.equal(pairEloBonusForMatchup(false, false, 32), 0);
});
