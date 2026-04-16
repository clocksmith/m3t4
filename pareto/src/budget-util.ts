// Pareto-facing helpers for user-budgeted configs. The canonical budget math
// lives in @m3t4/sim so builder, server, and analysis cannot drift.

import type { BrainConfig, ParamKey } from "@m3t4/sim";
import {
  DEFAULT_PARAMS,
  RANGES,
  USER_BUDGET,
  USER_KNOBS,
  budgetSpent,
  computedHallucination,
  computedHallucinationForSpend,
  isWithinBudget,
  nativeToUI,
  uiToNative,
} from "@m3t4/sim";

export {
  RANGES,
  USER_BUDGET,
  USER_KNOBS,
  budgetSpent,
  computedHallucination,
  computedHallucinationForSpend,
  isWithinBudget,
  nativeToUI,
  uiToNative,
};

function scalarValue(cfg: BrainConfig, k: ParamKey): number {
  const v = cfg.attributes[k];
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "base" in v && typeof v.base === "number") return v.base;
  return DEFAULT_PARAMS[k];
}

function uiVector(cfg: BrainConfig): Record<ParamKey, number> {
  const ui: Record<ParamKey, number> = {} as Record<ParamKey, number>;
  for (const k of USER_KNOBS) ui[k] = nativeToUI(k, scalarValue(cfg, k));
  return ui;
}

function attrsFromUI(ui: Record<ParamKey, number>, id: string): BrainConfig {
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (const k of USER_KNOBS) attrs[k] = uiToNative(k, ui[k]);
  attrs.hallucination = computedHallucinationForSpend(budgetSpent({ attributes: attrs }));
  return { id, attributes: attrs };
}

/** Rescale UI values proportionally so they fit the user budget. Preserves ratios. */
export function projectIntoBudget(cfg: BrainConfig): BrainConfig {
  const ui = uiVector(cfg);
  const sum = USER_KNOBS.reduce((s, k) => s + ui[k], 0);
  if (sum <= USER_BUDGET) {
    const attrs: Partial<Record<ParamKey, number>> = {};
    for (const k of USER_KNOBS) attrs[k] = uiToNative(k, ui[k]);
    attrs.hallucination = 0;
    return { id: cfg.id, author: cfg.author, seed: cfg.seed, attributes: attrs };
  }
  const scale = USER_BUDGET / sum;
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (const k of USER_KNOBS) attrs[k] = uiToNative(k, ui[k] * scale);
  attrs.hallucination = 0;
  return { id: cfg.id, author: cfg.author, seed: cfg.seed, attributes: attrs };
}

/** Generate a uniformly-random budget-compliant config. */
export function randomBudgeted(id: string): BrainConfig {
  let remaining = USER_BUDGET;
  const ui: Record<ParamKey, number> = {} as Record<ParamKey, number>;
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
  for (const k of USER_KNOBS) ui[k] ??= 0;
  return attrsFromUI(ui, id);
}

/** Mutate each user knob by ±amount% of its range, then re-project. */
export function mutateBudgeted(src: BrainConfig, id: string, rate = 0.4, amount = 0.15): BrainConfig {
  const ui = uiVector(src);
  for (const k of USER_KNOBS) {
    if (Math.random() < rate) {
      ui[k] += (Math.random() * 2 - 1) * amount * 100;
      ui[k] = Math.max(0, Math.min(100, ui[k]));
    }
  }
  return projectIntoBudget(attrsFromUI(ui, id));
}

/** Crossover: choose each knob from either parent, then project. */
export function crossoverBudgeted(a: BrainConfig, b: BrainConfig, id: string): BrainConfig {
  const uiA = uiVector(a);
  const uiB = uiVector(b);
  const ui: Record<ParamKey, number> = {} as Record<ParamKey, number>;
  for (const k of USER_KNOBS) ui[k] = Math.random() < 0.5 ? uiA[k] : uiB[k];
  return projectIntoBudget(attrsFromUI(ui, id));
}
