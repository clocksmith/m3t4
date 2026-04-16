// A minimal (μ,λ)-CMA-ES over the 8-dim normalized attribute space.
// Not as sophisticated as the full reference implementation, but enough
// to outperform the random-mutation baseline on smooth fitness landscapes.
//
// Reference: Hansen & Ostermeier 2001. Adapted from the pseudocode in the
// CMA-ES tutorial. Only mean, step-size, and diagonal covariance adapted
// — full rank-μ update omitted to keep this short. For our purposes the
// diagonal version converges fine.

import type { BrainConfig, ParamKey } from "@selfplay/sim";
import { PARAM_KEYS } from "@selfplay/sim";
import { featureVector } from "./novelty.js";

const RANGES: Record<ParamKey, [number, number]> = {
  burnRate: [0, 1], moat: [0, 300], shipRate: [0, 1],
  foresight: [0, 0.25], pivotSpeed: [0, 1], leverage: [-1, 1],
  networking: [0, 1],
  spite: [-1, 1], greed: [0, 1], pacing: [0, 1], cunning: [0, 1],
  hallucination: [0, 100],
};

function denormalize(v: number[]): Partial<Record<ParamKey, number>> {
  const out: Partial<Record<ParamKey, number>> = {};
  for (let i = 0; i < PARAM_KEYS.length; i++) {
    const k = PARAM_KEYS[i];
    const [lo, hi] = RANGES[k];
    out[k] = Math.max(lo, Math.min(hi, lo + v[i] * (hi - lo)));
  }
  return out;
}

function normalRandom(): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface CMAESState {
  mean: number[];
  sigma: number;
  diag: number[];      // per-coordinate standard deviations
  gen: number;
  dim: number;
  popSize: number;
  muEff: number;
  bestSoFar: { mean: number[]; fitness: number } | null;
}

export interface CMAESConfig {
  initialMean?: number[]; // in normalized [0,1]^d
  initialSigma?: number;
  popSize?: number;
}

// Log-weighted recombination weights. Top individual gets the largest weight,
// median gets roughly zero contribution. μ_eff = (Σw)² / Σw².
function logWeights(mu: number): { weights: number[]; muEff: number } {
  const raw = new Array<number>(mu);
  let sum = 0;
  for (let i = 0; i < mu; i++) {
    raw[i] = Math.log((mu + 1) / (i + 1));
    sum += raw[i];
  }
  const weights = raw.map((w) => w / sum);
  let sw = 0, sw2 = 0;
  for (const w of weights) { sw += w; sw2 += w * w; }
  const muEff = (sw * sw) / sw2;
  return { weights, muEff };
}

export function cmaInit(cfg: CMAESConfig = {}): CMAESState {
  const d = PARAM_KEYS.length;
  const mean = cfg.initialMean ?? new Array(d).fill(0.5);
  const sigma = cfg.initialSigma ?? 0.3;
  const lambda = cfg.popSize ?? 4 + Math.floor(3 * Math.log(d));
  const mu = Math.floor(lambda / 2);
  const { muEff } = logWeights(mu);
  return {
    mean: mean.slice(),
    sigma,
    diag: new Array(d).fill(1),
    gen: 0,
    dim: d,
    popSize: lambda,
    muEff,
    bestSoFar: null,
  };
}

// Sample λ configs from the current distribution. Each is a BrainConfig
// with an id derived from `{idPrefix}-{gen}-{i}`.
export function cmaSample(state: CMAESState, idPrefix: string): BrainConfig[] {
  const out: BrainConfig[] = [];
  for (let i = 0; i < state.popSize; i++) {
    const v = new Array(state.dim);
    for (let j = 0; j < state.dim; j++) {
      const z = normalRandom();
      v[j] = state.mean[j] + state.sigma * state.diag[j] * z;
      v[j] = Math.max(0, Math.min(1, v[j]));
    }
    out.push({
      id: `${idPrefix}-${state.gen}-${i.toString().padStart(2, "0")}`,
      attributes: denormalize(v),
    });
  }
  return out;
}

// Given the sampled population and their fitnesses (higher=better),
// update the CMA-ES state using log-weighted recombination — top
// individuals count more than the median of top-μ.
export function cmaTell(state: CMAESState, population: BrainConfig[], fitnesses: number[]): void {
  const d = state.dim;
  // Rank and pick top mu
  const idx = fitnesses.map((_, i) => i).sort((a, b) => fitnesses[b] - fitnesses[a]);
  const mu = Math.floor(state.popSize / 2);
  const top = idx.slice(0, mu);
  const topVecs = top.map((i) => featureVector(population[i]));
  const { weights } = logWeights(mu);

  // Weighted recombination: newMean = Σ w_i · topVecs[i]
  const newMean = new Array(d).fill(0);
  for (let i = 0; i < mu; i++) {
    for (let j = 0; j < d; j++) newMean[j] += weights[i] * topVecs[i][j];
  }

  // Weighted per-coord variance around the OLD mean (selection direction)
  const newDiag = new Array(d).fill(0);
  for (let i = 0; i < mu; i++) {
    for (let j = 0; j < d; j++) {
      const dv = topVecs[i][j] - state.mean[j];
      newDiag[j] += weights[i] * dv * dv;
    }
  }
  for (let j = 0; j < d; j++) newDiag[j] = Math.sqrt(newDiag[j]) || 1e-6;

  // Weighted mean movement for step-size update
  let weightedMovement = 0;
  for (let i = 0; i < mu; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) {
      const dv = topVecs[i][j] - state.mean[j];
      s += dv * dv;
    }
    weightedMovement += weights[i] * Math.sqrt(s);
  }
  const cumulation = 0.3;
  state.sigma = state.sigma * (1 - cumulation) + weightedMovement * cumulation;
  state.sigma = Math.max(0.02, Math.min(0.5, state.sigma));

  state.mean = newMean;
  state.diag = newDiag;
  state.gen += 1;

  // Track the actual best-sampled INDIVIDUAL (not the mean — for noisy
  // fitness landscapes the top-μ mean can be much worse than any member).
  const bestIdx = idx[0];
  const bestCfg = population[bestIdx];
  const bestFit = fitnesses[bestIdx];
  if (!state.bestSoFar || bestFit > state.bestSoFar.fitness) {
    state.bestSoFar = { mean: featureVector(bestCfg), fitness: bestFit };
  }
}

// Export the current mean as a BrainConfig (the "best known incumbent").
export function cmaIncumbent(state: CMAESState, id: string): BrainConfig {
  const v = state.bestSoFar?.mean ?? state.mean;
  return { id, attributes: denormalize(v) };
}
