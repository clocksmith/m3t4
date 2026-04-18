// Budget-transfer mutation — the correct primitive for simplex-bounded
// candidates. Moves δ points from knob j to knob i, keeping total spend
// constant. Directly tests opportunity cost:
//   "Is 10 more shipRate worth 10 less moat?"
//
// Replaces the old per-knob jitter-then-project mutation, which
// preserved ratios (shrinking candidates along their ray from origin)
// rather than moving budget between knobs. That's why HOF clustered
// in the moderate region — cube-style mutation couldn't turn a moderate
// config into a specialist.

import type { BrainConfig, ParamKey } from "@m3t4/sim";
import { USER_KNOBS, USER_BUDGET, RANGES, uiToNative, computedHallucinationForSpend } from "@m3t4/sim";
import type { CandidateMeta, MutationKind } from "./simplex-sample.js";

export interface TransferParams {
  deltas?: number[]; // transfer amounts to try; default {3, 5, 10, 20}
  multiTransfers?: number; // 1 = single transfer; >1 = multiple transfers in series
}

function cfgToUi(cfg: BrainConfig): number[] {
  const out = new Array(USER_KNOBS.length).fill(0);
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const k = USER_KNOBS[i];
    const [lo, hi] = RANGES[k];
    const v = cfg.attributes[k];
    const raw = typeof v === "number" ? v : (v && typeof v === "object" && "base" in v && typeof v.base === "number" ? v.base : 0);
    out[i] = Math.max(0, Math.min(100, Math.round(((raw - lo) / (hi - lo)) * 100)));
  }
  return out;
}

function uiToConfig(ui: number[], id: string): BrainConfig {
  const attrs: Partial<Record<ParamKey, number>> = {};
  let spent = 0;
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const k = USER_KNOBS[i];
    attrs[k] = uiToNative(k, ui[i]);
    spent += ui[i];
  }
  attrs.hallucination = computedHallucinationForSpend(spent);
  return { id, attributes: attrs };
}

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

// Single budget-transfer: move δ from knob j to knob i.
// Respects per-knob caps (0-100) — if δ would overflow, clamp.
function applyTransfer(ui: number[], fromIdx: number, toIdx: number, delta: number): number[] {
  const out = ui.slice();
  // Can't take more than j has
  const take = Math.min(delta, out[fromIdx]);
  // Can't give more than i can hold
  const give = Math.min(take, 100 - out[toIdx]);
  out[fromIdx] -= give;
  out[toIdx] += give;
  return out;
}

// Perform one or more budget transfers. Picks (from, to, δ) combinations
// randomly from reasonable ranges.
export function budgetTransfer(
  parent: { config: BrainConfig; meta: CandidateMeta },
  params: TransferParams = {},
  rng: () => number = Math.random,
  id?: string,
  generation = 0,
): { config: BrainConfig; meta: CandidateMeta } {
  const deltas = params.deltas ?? [3, 5, 10, 20];
  const nTransfers = params.multiTransfers ?? 1;
  let ui = cfgToUi(parent.config);

  for (let t = 0; t < nTransfers; t++) {
    // Pick a knob with budget to give
    const haveBudget = ui
      .map((v, i) => ({ v, i }))
      .filter((x) => x.v > 0);
    if (haveBudget.length === 0) break;
    const from = haveBudget[Math.floor(rng() * haveBudget.length)].i;

    // Pick a knob with room to receive (not the same one)
    const haveRoom = ui
      .map((v, i) => ({ v, i }))
      .filter((x) => x.i !== from && x.v < 100);
    if (haveRoom.length === 0) break;
    const to = haveRoom[Math.floor(rng() * haveRoom.length)].i;

    const delta = deltas[Math.floor(rng() * deltas.length)];
    ui = applyTransfer(ui, from, to, delta);
  }

  const newId = id ?? `${parent.config.id}-t${generation}`;
  const config = uiToConfig(ui, newId);
  const spent = ui.reduce((s, v) => s + v, 0);
  const shareSum = spent > 0 ? spent : 1;
  const mutationKind: MutationKind = nTransfers > 1 ? "multi_transfer" : "transfer";
  const meta: CandidateMeta = {
    configHash: hashAttributes(config),
    uiSpendVector: ui.slice(),
    budgetShareVector: ui.map((v) => v / shareSum),
    spent,
    axisExtremes: ui.map((v, i) => {
      const k = USER_KNOBS[i];
      const [lo, hi] = RANGES[k];
      const bipolar = lo < 0 && hi > 0;
      if (bipolar) {
        if (v > 80) return `${k}_high`;
        if (v < 20) return `${k}_low`;
        return null;
      }
      return v > 80 ? `${k}_high` : null;
    }).filter((x): x is string => x !== null),
    sourceKind: "budget_transfer_mutation",
    parentIds: parent.meta.configHash ? [parent.meta.configHash] : null,
    mutationKind,
    generation,
  };
  return { config, meta };
}

// Variant mutator: swap two knobs' entire values. Radical, useful for
// exploring interaction-term space.
export function swapAxes(
  parent: { config: BrainConfig; meta: CandidateMeta },
  rng: () => number = Math.random,
  id?: string,
  generation = 0,
): { config: BrainConfig; meta: CandidateMeta } {
  const ui = cfgToUi(parent.config);
  const a = Math.floor(rng() * ui.length);
  let b = Math.floor(rng() * ui.length);
  while (b === a) b = Math.floor(rng() * ui.length);
  [ui[a], ui[b]] = [ui[b], ui[a]];
  const newId = id ?? `${parent.config.id}-swap${generation}`;
  const config = uiToConfig(ui, newId);
  const spent = ui.reduce((s, v) => s + v, 0);
  const shareSum = spent > 0 ? spent : 1;
  const meta: CandidateMeta = {
    configHash: hashAttributes(config),
    uiSpendVector: ui.slice(),
    budgetShareVector: ui.map((v) => v / shareSum),
    spent,
    axisExtremes: ui.map((v, i) => {
      const k = USER_KNOBS[i];
      const [lo, hi] = RANGES[k];
      const bipolar = lo < 0 && hi > 0;
      if (bipolar) {
        if (v > 80) return `${k}_high`;
        if (v < 20) return `${k}_low`;
        return null;
      }
      return v > 80 ? `${k}_high` : null;
    }).filter((x): x is string => x !== null),
    sourceKind: "budget_transfer_mutation",
    parentIds: [parent.meta.configHash],
    mutationKind: "swap_axes",
    generation,
  };
  return { config, meta };
}
