// Simplex-aware candidate sampling.
//
// The legal config space is an 11D bounded integer simplex (sum ≤ 360,
// each knob 0-100). Random budget-respecting allocation is center-biased
// — it spreads mass evenly, producing moderate configs that evolution
// converges on.
//
// This module provides a mixture of sampling strategies that deliberately
// produce sparse/extreme, balanced, and axis-anchored configs. Each
// sample carries source metadata so Phase-4 adversarial analysis can
// correlate exploitability with generation strategy.

import type { BrainConfig, ParamKey } from "@m3t4/sim";
import {
  USER_BUDGET, USER_KNOBS, RANGES, uiToNative, computedHallucinationForSpend,
} from "@m3t4/sim";

export type SourceKind =
  | "dirichlet_sparse"      // α=0.25 equivalent — 2-3 extreme axes
  | "dirichlet_balanced"    // α=1.0 equivalent — broad simplex
  | "dirichlet_dense"       // α=3.0 equivalent — all axes similar
  | "axis_anchor"           // one knob near max + complementary support
  | "pair_anchor"           // two interacting knobs high
  | "budget_transfer_mutation"
  | "crossover"
  | "hof_elite"
  | "random_legacy";

export type MutationKind =
  | null
  | "transfer"
  | "multi_transfer"
  | "swap_axes"
  | "scale_project"
  | "crossover"
  | "anchor_seeded";

export interface CandidateMeta {
  configHash: string;
  uiSpendVector: number[];    // length 11, 0-100 each
  budgetShareVector: number[]; // normalized to sum=1
  spent: number;
  axisExtremes: string[];     // knobs where ui > 80 or ui < 20 (for [-1,1] knobs: extreme toward either pole)
  sourceKind: SourceKind;
  parentIds: string[] | null;
  mutationKind: MutationKind;
  generation: number;
}

export interface SampledCandidate {
  config: BrainConfig;
  meta: CandidateMeta;
}

// FNV-1a over canonical attribute JSON for stable dedup/lookup.
function hashAttributes(cfg: BrainConfig): string {
  const keys = Object.keys(cfg.attributes).sort();
  const json = keys.map((k) => `${k}:${cfg.attributes[k as ParamKey]}`).join("|");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function axisExtremesOf(ui: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const k = USER_KNOBS[i];
    const v = ui[i];
    const [lo, hi] = RANGES[k];
    // Bipolar knobs (leverage, spite) are extreme near either pole in UI
    const isBipolar = lo < 0 && hi > 0;
    if (isBipolar) {
      if (v > 80) out.push(`${k}_high`);
      else if (v < 20) out.push(`${k}_low`);
    } else {
      if (v > 80) out.push(`${k}_high`);
    }
  }
  return out;
}

function makeConfigFromUi(ui: number[], id: string): BrainConfig {
  const attrs: Partial<Record<ParamKey, number>> = {};
  let spent = 0;
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const k = USER_KNOBS[i];
    const uiVal = Math.max(0, Math.min(100, Math.round(ui[i])));
    attrs[k] = uiToNative(k, uiVal);
    spent += uiVal;
  }
  attrs.hallucination = computedHallucinationForSpend(spent);
  return { id, attributes: attrs };
}

function toMeta(
  ui: number[],
  cfg: BrainConfig,
  sourceKind: SourceKind,
  mutationKind: MutationKind,
  parentIds: string[] | null,
  generation: number,
): CandidateMeta {
  const spent = ui.reduce((s, v) => s + Math.round(v), 0);
  const shareSum = spent > 0 ? spent : 1;
  return {
    configHash: hashAttributes(cfg),
    uiSpendVector: ui.map((v) => Math.round(v)),
    budgetShareVector: ui.map((v) => Math.round(v) / shareSum),
    spent,
    axisExtremes: axisExtremesOf(ui),
    sourceKind,
    parentIds,
    mutationKind,
    generation,
  };
}

// ----- Allocation strategies -----

function allocateSparse(rng: () => number, budget = USER_BUDGET): number[] {
  // 2-3 active axes grab most budget. Each near their cap. Rest near 0.
  const nActive = 2 + Math.floor(rng() * 2); // 2 or 3
  const order = Array.from({ length: 11 }, (_, i) => i).sort(() => rng() - 0.5);
  const active = order.slice(0, nActive);
  const ui = new Array(11).fill(0);
  let remaining = budget;
  for (let i = 0; i < active.length; i++) {
    const isLast = i === active.length - 1;
    const cap = Math.min(100, remaining);
    const v = isLast ? cap : Math.max(40, Math.min(100, Math.floor(60 + rng() * 40)));
    ui[active[i]] = Math.min(cap, v);
    remaining -= ui[active[i]];
  }
  // Sprinkle minimal support on 2-3 other axes
  const supports = order.slice(nActive, nActive + 3);
  for (const idx of supports) {
    if (remaining <= 0) break;
    const v = Math.min(remaining, Math.floor(rng() * 15));
    ui[idx] = v;
    remaining -= v;
  }
  return ui;
}

function allocateBalanced(rng: () => number, budget = USER_BUDGET): number[] {
  // 5-7 active axes, moderate values. α=1 broad-simplex equivalent.
  const nActive = 5 + Math.floor(rng() * 3); // 5-7
  const order = Array.from({ length: 11 }, (_, i) => i).sort(() => rng() - 0.5);
  const active = order.slice(0, nActive);
  const ui = new Array(11).fill(0);
  const shares = new Array(nActive).fill(0).map(() => 0.3 + rng() * 0.7);
  const shareSum = shares.reduce((a, x) => a + x, 0);
  for (let i = 0; i < active.length; i++) {
    const v = Math.min(100, Math.round((shares[i] / shareSum) * budget));
    ui[active[i]] = v;
  }
  // Trim any overspend
  let spent = ui.reduce((s, v) => s + v, 0);
  while (spent > budget) {
    const maxIdx = ui.indexOf(Math.max(...ui));
    ui[maxIdx]--;
    spent--;
  }
  return ui;
}

function allocateDense(rng: () => number, budget = USER_BUDGET): number[] {
  // All 11 knobs get similar moderate value, small jitter.
  const mean = budget / 11;
  const ui = new Array(11).fill(0);
  let spent = 0;
  for (let i = 0; i < 11; i++) {
    const v = Math.max(0, Math.min(100, Math.round(mean + (rng() - 0.5) * mean * 0.5)));
    ui[i] = v;
    spent += v;
  }
  // Normalize to budget
  while (spent > budget) {
    const maxIdx = ui.indexOf(Math.max(...ui));
    ui[maxIdx]--;
    spent--;
  }
  while (spent < budget - 10) {
    const minIdx = ui.indexOf(Math.min(...ui));
    if (ui[minIdx] >= 100) break;
    ui[minIdx]++;
    spent++;
  }
  return ui;
}

// Deliberate axis anchor: one knob near its extreme pole, one complementary
// support knob, rest minimal. Tests whether a single-axis specialist
// survives the adversarial gate.
function allocateAxisAnchor(rng: () => number, axisIdx: number, pole: "high" | "low", budget = USER_BUDGET): number[] {
  const ui = new Array(11).fill(0);
  const knob = USER_KNOBS[axisIdx];
  const [lo, hi] = RANGES[knob];
  const isBipolar = lo < 0 && hi > 0;
  // For bipolar knobs, UI=0 is pole-low and UI=100 is pole-high
  const anchorUi = pole === "high" ? 90 + Math.floor(rng() * 10) : (isBipolar ? Math.floor(rng() * 10) : 5);
  ui[axisIdx] = anchorUi;
  // Support knob: chosen to complement the anchor
  const SUPPORT_MAP: Record<string, string> = {
    burnRate: "pacing", moat: "pivotSpeed", shipRate: "greed",
    foresight: "cunning", pivotSpeed: "moat", leverage: "networking",
    networking: "leverage", spite: "greed", greed: "shipRate",
    pacing: "burnRate", cunning: "foresight",
  };
  const supportIdx = USER_KNOBS.indexOf(SUPPORT_MAP[knob] as ParamKey);
  if (supportIdx >= 0 && supportIdx !== axisIdx) {
    ui[supportIdx] = 40 + Math.floor(rng() * 30);
  }
  // Distribute remaining budget minimally across other axes
  let remaining = budget - ui.reduce((s, v) => s + v, 0);
  const otherIdxs = Array.from({ length: 11 }, (_, i) => i).filter((i) => i !== axisIdx && i !== supportIdx);
  otherIdxs.sort(() => rng() - 0.5);
  for (const idx of otherIdxs) {
    if (remaining <= 0) break;
    const v = Math.min(remaining, Math.floor(rng() * 30));
    ui[idx] = v;
    remaining -= v;
  }
  return ui;
}

function allocatePairAnchor(rng: () => number, a: number, b: number, budget = USER_BUDGET): number[] {
  const ui = new Array(11).fill(0);
  ui[a] = 70 + Math.floor(rng() * 25);
  ui[b] = 50 + Math.floor(rng() * 30);
  let remaining = budget - ui[a] - ui[b];
  const others = Array.from({ length: 11 }, (_, i) => i).filter((i) => i !== a && i !== b);
  others.sort(() => rng() - 0.5);
  for (const idx of others) {
    if (remaining <= 0) break;
    const v = Math.min(remaining, Math.floor(rng() * 25));
    ui[idx] = v;
    remaining -= v;
  }
  return ui;
}

// ----- Public sampler -----

export interface SampleConfig {
  id: string;
  sourceKind: SourceKind;
  generation: number;
  rng?: () => number;
}

export function sampleCandidate(opts: SampleConfig): SampledCandidate {
  const rng = opts.rng ?? Math.random;
  let ui: number[];
  switch (opts.sourceKind) {
    case "dirichlet_sparse": ui = allocateSparse(rng); break;
    case "dirichlet_balanced": ui = allocateBalanced(rng); break;
    case "dirichlet_dense": ui = allocateDense(rng); break;
    case "axis_anchor": {
      const axisIdx = Math.floor(rng() * 11);
      // For bipolar axes (leverage, spite), flip pole randomly
      const knob = USER_KNOBS[axisIdx];
      const [lo, hi] = RANGES[knob];
      const pole = (lo < 0 && hi > 0 && rng() < 0.5) ? "low" : "high";
      ui = allocateAxisAnchor(rng, axisIdx, pole);
      break;
    }
    case "pair_anchor": {
      // Standard interaction pairs from the user's plan
      const pairs: Array<[ParamKey, ParamKey]> = [
        ["burnRate", "pacing"], ["shipRate", "greed"],
        ["moat", "pivotSpeed"], ["foresight", "cunning"],
        ["leverage", "networking"],
      ];
      const [pa, pb] = pairs[Math.floor(rng() * pairs.length)];
      ui = allocatePairAnchor(rng, USER_KNOBS.indexOf(pa), USER_KNOBS.indexOf(pb));
      break;
    }
    default: throw new Error(`sampleCandidate: unsupported sourceKind ${opts.sourceKind}`);
  }
  const config = makeConfigFromUi(ui, opts.id);
  const meta = toMeta(ui, config, opts.sourceKind, null, null, opts.generation);
  return { config, meta };
}

// Produce a mixture: guaranteed axis coverage + Dirichlet mix.
export function sampleInitialPopulation(size: number, generation = 0, rng: () => number = Math.random): SampledCandidate[] {
  const out: SampledCandidate[] = [];
  // 1. One axis-anchor per knob (high pole) — guaranteed coverage
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const ui = allocateAxisAnchor(rng, i, "high");
    const cfg = makeConfigFromUi(ui, `anchor-${USER_KNOBS[i]}-hi-${generation}`);
    out.push({ config: cfg, meta: toMeta(ui, cfg, "axis_anchor", null, null, generation) });
  }
  // 2. Low-pole anchors for bipolar axes
  const bipolars = USER_KNOBS.map((k, i) => ({ k, i })).filter(({ k }) => {
    const [lo, hi] = RANGES[k];
    return lo < 0 && hi > 0;
  });
  for (const { i, k } of bipolars) {
    const ui = allocateAxisAnchor(rng, i, "low");
    const cfg = makeConfigFromUi(ui, `anchor-${k}-lo-${generation}`);
    out.push({ config: cfg, meta: toMeta(ui, cfg, "axis_anchor", null, null, generation) });
  }
  // 3. Pair anchors — one per standard interaction
  const pairs: Array<[ParamKey, ParamKey]> = [
    ["burnRate", "pacing"], ["shipRate", "greed"],
    ["moat", "pivotSpeed"], ["foresight", "cunning"],
    ["leverage", "networking"],
  ];
  for (const [pa, pb] of pairs) {
    const ui = allocatePairAnchor(rng, USER_KNOBS.indexOf(pa), USER_KNOBS.indexOf(pb));
    const cfg = makeConfigFromUi(ui, `pair-${pa}-${pb}-${generation}`);
    out.push({ config: cfg, meta: toMeta(ui, cfg, "pair_anchor", null, null, generation) });
  }
  // 4. Dirichlet mix for remaining slots
  const kinds: SourceKind[] = ["dirichlet_sparse", "dirichlet_balanced", "dirichlet_dense"];
  while (out.length < size) {
    const kind = kinds[Math.floor(rng() * kinds.length)];
    out.push(sampleCandidate({ id: `${kind}-${out.length}-${generation}`, sourceKind: kind, generation, rng }));
  }
  return out;
}
