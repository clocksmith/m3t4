// Metadata-only migration. BrainConfig is deliberately untouched: every active
// config is evaluated by the installed shared brain, while replay action logs
// retain the engine/version identity under which they were recorded.
import { migrateStableFighterNames } from './fighter-names.mjs';

export function migrateFighterRoster(stable, behaviorVersion) {
  if (!stable || !Array.isArray(stable.slots)) return stable;
  const named = migrateStableFighterNames(stable);
  if (!Number.isInteger(behaviorVersion) || behaviorVersion < 1) return named;
  let changed = false;
  const slots = named.slots.map(slot => {
    if (!slot?.slotId || (Number.isInteger(slot.aiBehaviorVersion) && slot.aiBehaviorVersion >= behaviorVersion)) return slot;
    changed = true;
    return { ...slot, aiBehaviorVersion: behaviorVersion };
  });
  return changed ? { ...named, slots } : named;
}
