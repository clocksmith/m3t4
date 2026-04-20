// Regression: carrier at goal with close opponent should not drift out of
// the dwell radius. Previous dwell-defense sent left/right movement
// toward opp, which pushed the body past the scoring threshold even
// though the sim already auto-faces opp on no-horizontal-input.

import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_DWELL_RADIUS } from "../constants.js";
import { simulateTrace } from "../simulate.js";
import { STAGES } from "../stage.js";
import { STRATEGIES } from "../strategies.js";

test("carrier doesn't drift out of dwell radius during defensive stance", () => {
  // Run a bunch of matches and check that whenever a fighter is the
  // carrier and within the goal radius, they don't immediately walk
  // themselves out. We look for "at-goal → not-at-goal" transitions
  // while carrying (no kill in between) as the failure mode.
  const stage = STAGES.datacenter;
  let driftEvents = 0;
  let carrierAtGoalTicks = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const trace = simulateTrace({
      stage, brainA: STRATEGIES.shipper, brainB: STRATEGIES.incumbent, seed,
      maxTicks: 600,
    });
    for (let i = 1; i < trace.frames.length; i++) {
      const cur = trace.frames[i];
      const prev = trace.frames[i - 1];
      if (!cur.token.exists || cur.token.carrier === -1) continue;
      if (!cur.goal.exists) continue;
      const carrier = cur.token.carrier === 0 ? cur.p0 : cur.p1;
      const prevCarrier = cur.token.carrier === 0 ? prev.p0 : prev.p1;
      if (carrier.dead || prevCarrier.dead) continue;
      const prevDist = Math.hypot(
        prevCarrier.x - cur.goal.x,
        prevCarrier.y - cur.goal.y,
      );
      const curDist = Math.hypot(
        carrier.x - cur.goal.x,
        carrier.y - cur.goal.y,
      );
      if (prevDist < 30) carrierAtGoalTicks++;
      // Drift: was inside the scoring radius, drifted well outside
      // in one tick (clear walk-away), same carrier, no interruption.
      if (prevDist < GOAL_DWELL_RADIUS - 2 && curDist > GOAL_DWELL_RADIUS + 18) driftEvents++;
    }
  }
  // Allow some drifts from natural movement (e.g. just grabbed token far
  // from goal) but they should be rare relative to time spent at goal.
  const driftRate = carrierAtGoalTicks > 0 ? driftEvents / carrierAtGoalTicks : 0;
  assert.ok(
    driftRate < 0.05,
    `carrier drift-out rate too high: ${driftRate.toFixed(3)} (${driftEvents} drifts / ${carrierAtGoalTicks} at-goal ticks)`,
  );
});
