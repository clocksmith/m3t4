export const EXECUTION_STORAGE_KEY = 'm3t4:duel:lethal-swing';
export const EXECUTION_DURATION_MS = 560;

export function lethalSwingStored() {
  try { return localStorage.getItem(EXECUTION_STORAGE_KEY) === 'on'; } catch { return false; }
}

export function lethalSwingSides(enabled, subMode) {
  return [!!enabled && subMode !== 'p2p', !!enabled && subMode === 'hot-seat'];
}

// Wall-clock presentation never changes the fixed simulation timestep.
export function executionPresentation(impact, nowMs, reducedMotion = false) {
  const age = nowMs - (impact?.startedAt ?? -Infinity);
  if (!impact || age < 0 || age >= EXECUTION_DURATION_MS || reducedMotion) {
    return { timeScale: 1, camera: null };
  }
  const recovery = Math.max(0, (age - 280) / (EXECUTION_DURATION_MS - 280));
  const strength = 1 - recovery * recovery * (3 - 2 * recovery);
  return { timeScale: 1 - 0.85 * strength, camera: { x: impact.x, y: impact.y, strength } };
}
