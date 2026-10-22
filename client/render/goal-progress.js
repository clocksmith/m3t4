import { GOAL_DWELL_RADIUS, LEGACY_GOAL_DWELL_S, STEP } from "../sim/constants.js";

// Read only the authoritative frame. No render delta, interpolation, wall clock,
// or previous-frame state may advance the capture ring while playback is paused.
export function goalHoldProgress(frame) {
  const goal = frame?.goal;
  const token = frame?.token;
  const requiredTicks = Number.isInteger(goal?.holdRequiredTicks) && goal.holdRequiredTicks > 0
    ? goal.holdRequiredTicks : Math.ceil(LEGACY_GOAL_DWELL_S / STEP);
  const carrier = token?.carrier === 0 ? frame.p0 : token?.carrier === 1 ? frame.p1 : null;
  const active = !!(goal?.exists && token?.exists && carrier && !carrier.dead);
  const ticks = active
    ? (Number.isInteger(goal.holdTicks) ? goal.holdTicks : Math.round((token.dwellT ?? 0) / STEP))
    : 0;
  const elapsedTicks = Math.max(0, Math.min(requiredTicks, Number.isFinite(ticks) ? ticks : 0));
  return { elapsedTicks, requiredTicks, fraction: elapsedTicks / requiredTicks };
}

// Kept separate from the purple expiry ring: this gold ring fills, while the
// existing ten-second objective-expiry ring empties. Both use simulation state.
export function drawGoalHoldRing(ctx, frame) {
  if (!frame.goal?.exists) return;
  const { elapsedTicks, requiredTicks, fraction } = goalHoldProgress(frame);
  ctx.strokeStyle = "rgba(250,204,21,0.22)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, GOAL_DWELL_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  if (fraction > 0) {
    ctx.strokeStyle = "rgba(253,224,71,1)";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, GOAL_DWELL_RADIUS, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
    ctx.stroke();
  }
  const duration = requiredTicks * STEP;
  // Floor the display so 119/120 never reads as a completed one-second hold.
  const elapsed = Math.floor(elapsedTicks * STEP * 10) / 10;
  ctx.fillStyle = "rgba(253,224,71,0.95)";
  ctx.font = "700 11px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`HOLD ${elapsed.toFixed(1)} / ${duration.toFixed(1)}s`, 0, 55);
}
