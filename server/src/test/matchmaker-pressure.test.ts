import assert from "node:assert/strict";
import test from "node:test";
import { effectiveCycleMsForHumans, matchmakerPressure } from "../matchmaker-pressure.js";
import type { Stable } from "../stable.js";

function stable(userId: string): Stable {
  return {
    userId,
    handle: userId.replace(":", "_"),
    slots: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

test("matchmaker pressure keeps configured cooldown for small human pools", () => {
  assert.equal(effectiveCycleMsForHumans(50, 60000), 60000);
  const pressure = matchmakerPressure([stable("alice"), stable("system:blitz")], 60000);
  assert.equal(pressure.rankedMode, "normal");
  assert.equal(pressure.activeHumanCount, 1);
  assert.equal(pressure.activeSystemCount, 1);
  assert.equal(pressure.effectiveCycleMs, 60000);
});

test("matchmaker pressure shortens cooldown as human pools grow", () => {
  assert.equal(effectiveCycleMsForHumans(51, 60000), 20000);
  assert.equal(effectiveCycleMsForHumans(201, 60000), 5000);
  assert.equal(effectiveCycleMsForHumans(1001, 60000), 2000);
  assert.equal(effectiveCycleMsForHumans(1001, 1000), 1000);
});

test("matchmaker pressure reports busy and saturated modes", () => {
  const busy = matchmakerPressure(Array.from({ length: 60 }, (_, i) => stable(`u${i}`)), 60000);
  assert.equal(busy.rankedMode, "busy");
  assert.equal(busy.effectiveCycleMs, 20000);

  const saturated = matchmakerPressure(Array.from({ length: 1002 }, (_, i) => stable(`u${i}`)), 60000);
  assert.equal(saturated.rankedMode, "saturated");
  assert.equal(saturated.effectiveCycleMs, 2000);
  assert.ok(saturated.matchesPerHourEstimate > busy.matchesPerHourEstimate);
});

