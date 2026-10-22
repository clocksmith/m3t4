// Sparse playback must present a complete simulation sample. Interpolating x/y
// while borrowing facing, timers or death state from another tick invents a
// weapon/hurtbox pairing that never existed in the deterministic simulation.
export function completeTickFrame(previous, next, targetTick) {
  return next && targetTick >= next.tick ? next : previous;
}
