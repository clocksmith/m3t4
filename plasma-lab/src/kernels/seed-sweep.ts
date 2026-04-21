import { simulate, STAGES, STRATEGIES, type StageId, type StrategyName } from "@m3t4/sim";
import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const SEED_SWEEP_KERNEL_ID = "m3t4.seed_sweep.v0";
export const SEED_SWEEP_KERNEL_HASH = sha256(`${SEED_SWEEP_KERNEL_ID}:public-presets-v1`);

export interface SeedSweepParams {
  stageId: string;
  brainA: string;
  brainB: string;
  seedStart: number;
  seedEndExclusive: number;
  maxTicks?: number;
}

export interface SeedSweepOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
  summary: SeedSweepSummary;
}

export interface SeedSweepSummary {
  kind: typeof SEED_SWEEP_KERNEL_ID;
  stageId: StageId;
  brainA: StrategyName;
  brainB: StrategyName;
  seedStart: number;
  seedEndExclusive: number;
  maxTicks?: number;
  aggregate: {
    seeds: number;
    winsA: number;
    winsB: number;
    draws: number;
    avgTicks: number;
  };
  results: Array<{
    seed: number;
    winner: 0 | 1 | -1;
    finalScore: [number, number];
    finalRounds: [number, number];
    ticks: number;
    logHash: string;
  }>;
}

export function runSeedSweep(params: SeedSweepParams): SeedSweepOutput {
  const stageId = requireStageId(params.stageId);
  const brainA = requireStrategyName(params.brainA, "brainA");
  const brainB = requireStrategyName(params.brainB, "brainB");
  const seedStart = asInt(params.seedStart, "seedStart");
  const seedEndExclusive = asInt(params.seedEndExclusive, "seedEndExclusive");
  const maxTicks = params.maxTicks === undefined ? undefined : asInt(params.maxTicks, "maxTicks");
  if (seedEndExclusive <= seedStart) throw new Error("seedEndExclusive must be greater than seedStart");
  if (seedEndExclusive - seedStart > 64) throw new Error("seed sweep chunks are capped at 64 seeds");

  const stage = STAGES[stageId];
  const results: SeedSweepSummary["results"] = [];
  for (let seed = seedStart; seed < seedEndExclusive; seed++) {
    const result = simulate({
      stage,
      brainA: STRATEGIES[brainA],
      brainB: STRATEGIES[brainB],
      seed,
      maxTicks,
    });
    results.push({
      seed,
      winner: result.winner,
      finalScore: result.finalScore,
      finalRounds: result.finalRounds,
      ticks: result.ticks,
      logHash: result.logHash,
    });
  }

  const aggregate = {
    seeds: results.length,
    winsA: results.filter((result) => result.winner === 0).length,
    winsB: results.filter((result) => result.winner === 1).length,
    draws: results.filter((result) => result.winner === -1).length,
    avgTicks: results.length
      ? Math.round(results.reduce((sum, result) => sum + result.ticks, 0) / results.length)
      : 0,
  };
  const summary: SeedSweepSummary = {
    kind: SEED_SWEEP_KERNEL_ID,
    stageId,
    brainA,
    brainB,
    seedStart,
    seedEndExclusive,
    maxTicks,
    aggregate,
    results,
  };
  const outputBytes = new TextEncoder().encode(canonicalJson(summary));
  return {
    outputBytes,
    outputHash: sha256(outputBytes),
    summary,
  };
}

function requireStageId(value: string): StageId {
  if (value in STAGES) return value as StageId;
  throw new Error(`unknown public stage: ${value}`);
}

function requireStrategyName(value: string, label: string): StrategyName {
  if (value in STRATEGIES) return value as StrategyName;
  throw new Error(`unknown public ${label} preset: ${value}`);
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) throw new Error(`invalid ${label}`);
  return n;
}
