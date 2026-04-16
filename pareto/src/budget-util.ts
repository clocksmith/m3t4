// Budget utilities. Mirrors the builder.html mapping: each attribute has
// a [lo, hi] native range; slider 0-100 maps linearly; the "cost" of a
// config is the sum of its UI-normalized values. Budget-constrained
// generation rejects or re-normalizes configs that exceed the cap.

import type { BrainConfig, ParamKey } from "@selfplay/sim";
import { DEFAULT_PARAMS, PARAM_KEYS } from "@selfplay/sim";

// 9 points below `blitz` (the leanest named strategy at 369). Users can't
// quite rebuild any named strategy exactly — they must be more efficient.
export const USER_BUDGET = 360;
export const USER_KNOBS: ParamKey[] = [
  "burnRate", "moat", "shipRate", "foresight",
  "pivotSpeed", "leverage", "networking",
  "spite", "greed", "pacing", "cunning", // 4 new attributes
  // hallucination is NOT user-budgeted; always 0 for budget-compliant bots.
];

export const RANGES: Record<ParamKey, [number, number]> = {
  burnRate: [0, 1], moat: [0, 300], shipRate: [0, 1],
  foresight: [0, 0.25], pivotSpeed: [0, 1], leverage: [-1, 1],
  networking: [0, 1],
  spite: [-1, 1], greed: [0, 1], pacing: [0, 1], cunning: [0, 1],
  hallucination: [0, 100],
};

export function nativeToUI(k: ParamKey, nativeVal: number): number {
  const [lo, hi] = RANGES[k];
  if (hi === lo) return 0;
  return Math.max(0, Math.min(100, ((nativeVal - lo) / (hi - lo)) * 100));
}

export function uiToNative(k: ParamKey, ui: number): number {
  const [lo, hi] = RANGES[k];
  return lo + (hi - lo) * (Math.max(0, Math.min(100, ui)) / 100);
}

/** Sum of UI-space values for the user-budgeted knobs in a config. */
export function budgetSpent(cfg: BrainConfig): number {
  let s = 0;
  for (const k of USER_KNOBS) {
    const v = cfg.attributes[k];
    let native: number;
    if (typeof v === "number") native = v;
    else if (v && typeof v === "object" && "base" in v && typeof v.base === "number") native = v.base;
    else native = DEFAULT_PARAMS[k];
    s += nativeToUI(k, native);
  }
  return Math.round(s);
}

/** Is this config within budget (hallucination=0 AND user knobs sum ≤ USER_BUDGET)? */
export function isWithinBudget(cfg: BrainConfig): boolean {
  const h = cfg.attributes.hallucination;
  const hallNum = typeof h === "number" ? h : 0;
  if (hallNum > 0) return false;
  return budgetSpent(cfg) <= USER_BUDGET;
}

/** Rescale UI values proportionally so they fit the budget. Preserves ratios. */
export function projectIntoBudget(cfg: BrainConfig): BrainConfig {
  const ui: Record<ParamKey, number> = {} as Record<ParamKey, number>;
  for (const k of USER_KNOBS) {
    const v = cfg.attributes[k];
    let native: number;
    if (typeof v === "number") native = v;
    else if (v && typeof v === "object" && "base" in v && typeof v.base === "number") native = v.base;
    else native = DEFAULT_PARAMS[k];
    ui[k] = nativeToUI(k, native);
  }
  const sum = USER_KNOBS.reduce((s, k) => s + ui[k], 0);
  if (sum <= USER_BUDGET) return { ...cfg, attributes: { ...cfg.attributes, hallucination: 0 } };
  const scale = USER_BUDGET / sum;
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (const k of USER_KNOBS) attrs[k] = uiToNative(k, ui[k] * scale);
  attrs.hallucination = 0;
  return { id: cfg.id, author: cfg.author, attributes: attrs };
}

/** Generate a uniformly-random budget-compliant config. */
export function randomBudgeted(id: string): BrainConfig {
  let remaining = USER_BUDGET;
  const ui: Record<ParamKey, number> = {} as Record<ParamKey, number>;
  // Randomize the order of knobs so no single knob dominates systematically
  const order = USER_KNOBS.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    const nLeft = order.length - i;
    const avg = remaining / nLeft;
    const cap = Math.min(100, remaining);
    const v = Math.max(0, Math.min(cap, Math.round(avg + (Math.random() - 0.5) * avg * 1.2)));
    ui[k] = v;
    remaining -= v;
  }
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (const k of USER_KNOBS) attrs[k] = uiToNative(k, ui[k]);
  attrs.hallucination = 0;
  return { id, attributes: attrs };
}

/** Mutate: perturb each user knob by ±amount% of its range, then re-project. */
export function mutateBudgeted(src: BrainConfig, id: string, rate = 0.4, amount = 0.15): BrainConfig {
  const ui: Record<ParamKey, number> = {} as Record<ParamKey, number>;
  for (const k of USER_KNOBS) {
    const v = src.attributes[k];
    let native: number;
    if (typeof v === "number") native = v;
    else if (v && typeof v === "object" && "base" in v && typeof v.base === "number") native = v.base;
    else native = DEFAULT_PARAMS[k];
    let uiVal = nativeToUI(k, native);
    if (Math.random() < rate) {
      uiVal += (Math.random() * 2 - 1) * amount * 100;
      uiVal = Math.max(0, Math.min(100, uiVal));
    }
    ui[k] = uiVal;
  }
  // Project into budget
  const sum = USER_KNOBS.reduce((s, k) => s + ui[k], 0);
  const scale = sum > USER_BUDGET ? USER_BUDGET / sum : 1;
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (const k of USER_KNOBS) attrs[k] = uiToNative(k, ui[k] * scale);
  attrs.hallucination = 0;
  return { id, attributes: attrs };
}

/** Crossover: choose each knob from either parent (flat), then project. */
export function crossoverBudgeted(a: BrainConfig, b: BrainConfig, id: string): BrainConfig {
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (const k of USER_KNOBS) {
    const src = Math.random() < 0.5 ? a : b;
    const v = src.attributes[k];
    attrs[k] = typeof v === "number" ? v :
      (v && typeof v === "object" && "base" in v && typeof v.base === "number") ? v.base : DEFAULT_PARAMS[k];
  }
  attrs.hallucination = 0;
  const cfg: BrainConfig = { id, attributes: attrs };
  return projectIntoBudget(cfg);
}
