import type { Stable } from "./stable.js";

export interface MatchmakerPressure {
  rankedMode: "normal" | "busy" | "saturated";
  activeStableCount: number;
  activeHumanCount: number;
  activeSystemCount: number;
  configuredCycleMs: number;
  effectiveCycleMs: number;
  matchesPerHourEstimate: number;
}

const ESTIMATED_MATCH_STREAM_MS = 90000;

export function matchmakerPressure(active: Stable[], configuredCycleMs: number): MatchmakerPressure {
  const activeHumanCount = active.filter((st) => isHumanStable(st)).length;
  const activeSystemCount = active.length - activeHumanCount;
  const effectiveCycleMs = effectiveCycleMsForHumans(activeHumanCount, configuredCycleMs);
  return {
    rankedMode: rankedModeForHumans(activeHumanCount),
    activeStableCount: active.length,
    activeHumanCount,
    activeSystemCount,
    configuredCycleMs,
    effectiveCycleMs,
    matchesPerHourEstimate: matchesPerHourEstimate(effectiveCycleMs),
  };
}

export function effectiveCycleMsForHumans(activeHumanCount: number, configuredCycleMs: number): number {
  const base = Math.max(0, configuredCycleMs);
  if (activeHumanCount > 1000) return Math.min(base, 2000);
  if (activeHumanCount > 200) return Math.min(base, 5000);
  if (activeHumanCount > 50) return Math.min(base, 20000);
  return base;
}

export function rankedModeForHumans(activeHumanCount: number): MatchmakerPressure["rankedMode"] {
  if (activeHumanCount > 1000) return "saturated";
  if (activeHumanCount > 50) return "busy";
  return "normal";
}

export function matchesPerHourEstimate(effectiveCycleMs: number): number {
  return Math.round(3600000 / (ESTIMATED_MATCH_STREAM_MS + Math.max(0, effectiveCycleMs)));
}

export function isHumanStable(st: Stable): boolean {
  return !st.userId.startsWith("system:");
}
