import type { AttributeSpec, BrainConfig, ParamKey } from "./types.js";
import { DEFAULT_PARAMS } from "./types.js";

// User submissions spend UI-space points across these knobs. Spending too far
// below the clean band underfits the bot; spending past USER_BUDGET overfits
// it. Both derive hallucination, and ranked submissions stop at MAX_USER_SPEND
// where the overfit penalty caps out.
export const USER_BUDGET = 360;
export const HALLUCINATION_PER_OVERAGE = 10;
export const MIN_CLEAN_SPEND = 180;
export const HALLUCINATION_PER_UNDERSPEND = 3;
export const MAX_DERIVED_HALLUCINATION = 300;
export const MAX_USER_SPEND = USER_BUDGET + Math.floor(MAX_DERIVED_HALLUCINATION / HALLUCINATION_PER_OVERAGE);
export const USER_SUBMISSION_EPSILON = 1e-6;

export const USER_KNOBS: ParamKey[] = [
  "burnRate",
  "moat",
  "shipRate",
  "foresight",
  "pivotSpeed",
  "leverage",
  "networking",
  "spite",
  "greed",
  "pacing",
  "cunning",
  "lift",
  "parry",
  "chase",
  "discipline",
];

export const RANGES: Record<ParamKey, [number, number]> = {
  burnRate: [0, 1],
  moat: [0, 300],
  shipRate: [0, 1],
  foresight: [0, 0.25],
  pivotSpeed: [0, 1],
  leverage: [-1, 1],
  networking: [0, 1],
  spite: [-1, 1],
  greed: [0, 1],
  pacing: [0, 1],
  cunning: [0, 1],
  lift: [0, 1],
  parry: [0, 1],
  chase: [0, 1],
  discipline: [0, 1],
  hallucination: [0, MAX_DERIVED_HALLUCINATION],
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function scalarBase(k: ParamKey, spec: AttributeSpec | undefined): number {
  if (typeof spec === "number") return spec;
  if (spec && typeof spec === "object" && "base" in spec && typeof spec.base === "number") return spec.base;
  return DEFAULT_PARAMS[k];
}

export function nativeToUI(k: ParamKey, nativeVal: number): number {
  const [lo, hi] = RANGES[k];
  if (hi === lo) return 0;
  return clamp(((nativeVal - lo) / (hi - lo)) * 100, 0, 100);
}

export function uiToNative(k: ParamKey, ui: number): number {
  const [lo, hi] = RANGES[k];
  return lo + (hi - lo) * (clamp(ui, 0, 100) / 100);
}

export function budgetSpent(cfg: Pick<BrainConfig, "attributes">): number {
  let spent = 0;
  for (const k of USER_KNOBS) spent += nativeToUI(k, scalarBase(k, cfg.attributes[k]));
  return Math.round(spent);
}

export function computedHallucinationForSpend(spent: number): number {
  const rounded = Math.round(spent);
  const overage = Math.max(0, rounded - USER_BUDGET);
  const underage = Math.max(0, MIN_CLEAN_SPEND - rounded);
  const penalty = overage * HALLUCINATION_PER_OVERAGE + underage * HALLUCINATION_PER_UNDERSPEND;
  return Math.min(MAX_DERIVED_HALLUCINATION, penalty);
}

export function computedHallucination(cfg: Pick<BrainConfig, "attributes">): number {
  return computedHallucinationForSpend(budgetSpent(cfg));
}

export interface UserSubmissionValidation {
  ok: boolean;
  errors: string[];
  spent: number;
  hallucination: number;
  config?: BrainConfig;
}

export function validateUserSubmission(cfg: BrainConfig): UserSubmissionValidation {
  const errors: string[] = [];
  const attrs: Partial<Record<ParamKey, number>> = {};

  for (const k of USER_KNOBS) {
    const raw = cfg.attributes?.[k];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(`${k} must be a finite numeric scalar`);
      continue;
    }
    const [lo, hi] = RANGES[k];
    if (raw < lo - USER_SUBMISSION_EPSILON || raw > hi + USER_SUBMISSION_EPSILON) {
      errors.push(`${k} must be within [${lo}, ${hi}]`);
      continue;
    }
    attrs[k] = clamp(raw, lo, hi);
  }

  const spent = errors.length === 0 ? budgetSpent({ attributes: attrs }) : 0;
  const hallucination = computedHallucinationForSpend(spent);
  if (errors.length === 0 && spent > MAX_USER_SPEND) {
    errors.push(`total budget spend ${spent} exceeds hallucination cap ${MAX_USER_SPEND}`);
  }
  const rawHallucination = cfg.attributes?.hallucination;
  if (typeof rawHallucination !== "number" || !Number.isFinite(rawHallucination)) {
    errors.push(`hallucination must be the computed numeric scalar ${hallucination}`);
  } else if (errors.length === 0 && Math.abs(rawHallucination - hallucination) > USER_SUBMISSION_EPSILON) {
    errors.push(`hallucination must equal ${hallucination} for spent=${spent}`);
  }
  attrs.hallucination = hallucination;

  return {
    ok: errors.length === 0,
    errors,
    spent,
    hallucination,
    config: errors.length === 0 ? { id: cfg.id, author: cfg.author, seed: cfg.seed, attributes: attrs } : undefined,
  };
}

export function isWithinBudget(cfg: BrainConfig): boolean {
  return computedHallucination(cfg) === 0;
}
