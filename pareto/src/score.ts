// Given a candidate and a pool of references, build the full list of
// match specs (both sides × all stages × all seeds), dispatch via the
// worker pool, then compute a ScoreRecord from the outcomes.

import type { BrainConfig, Stage } from "@m3t4/sim";
import { runMatches, type MatchOutcome, type MatchSpec } from "./parallel.js";

export interface ScoreRecord {
  id: string;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  avgScoreDiff: number;
  avgTicks: number;
  deliveryCount: number;
  matches: number;
}

export interface ScoreOptions {
  candidate: BrainConfig;
  references: BrainConfig[];
  stages: Stage[];
  seedsPerMatchup?: number;
  workers?: number;
}

export function buildMatchSpecs(opts: ScoreOptions): MatchSpec[] {
  const seeds = opts.seedsPerMatchup ?? 3;
  const specs: MatchSpec[] = [];
  let idx = 0;
  for (const ref of opts.references) {
    if (ref.id === opts.candidate.id) continue;
    for (const stage of opts.stages) {
      for (let s = 0; s < seeds; s++) {
        const seed = ((s * 101 + stage.id.length * 37 + idx * 13) | 0) >>> 0;
        specs.push({
          a: opts.candidate,
          b: ref,
          stageId: stage.id as MatchSpec["stageId"],
          seed,
          meta: { candidateSide: 0 },
        });
        specs.push({
          a: ref,
          b: opts.candidate,
          stageId: stage.id as MatchSpec["stageId"],
          seed,
          meta: { candidateSide: 1 },
        });
        idx++;
      }
    }
  }
  return specs;
}

export function recordFromOutcomes(candidateId: string, outcomes: MatchOutcome[]): ScoreRecord {
  let wins = 0, losses = 0, draws = 0, sd = 0, ticks = 0, del = 0;
  for (const r of outcomes) {
    const side = (r.spec.meta as { candidateSide?: 0 | 1 } | undefined)?.candidateSide ?? 0;
    const candWon = r.winner === side;
    const candLost = r.winner === (1 - side);
    if (candWon) wins++;
    else if (candLost) losses++;
    else draws++;
    sd += r.finalScore[side] - r.finalScore[1 - side];
    ticks += r.ticks;
    del += r.finalScore[side];
  }
  const n = outcomes.length || 1;
  return {
    id: candidateId,
    wins, losses, draws,
    winRate: (wins + draws * 0.5) / n,
    avgScoreDiff: sd / n,
    avgTicks: ticks / n,
    deliveryCount: del,
    matches: n,
  };
}

export async function score(opts: ScoreOptions): Promise<ScoreRecord> {
  const specs = buildMatchSpecs(opts);
  const outcomes = await runMatches(specs, { workers: opts.workers });
  return recordFromOutcomes(opts.candidate.id, outcomes);
}

// Batch version: score an entire population with a single worker-pool
// round-trip. Much faster than calling score() once per candidate.
export interface BatchScoreOptions {
  candidates: BrainConfig[];
  references: BrainConfig[];
  stages: Stage[];
  seedsPerMatchup?: number;
  workers?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function scoreBatch(opts: BatchScoreOptions): Promise<ScoreRecord[]> {
  const seeds = opts.seedsPerMatchup ?? 3;
  const specs: MatchSpec[] = [];
  // Build one flat list of specs for all candidates × references
  const owner: number[] = []; // index into candidates for each spec
  let idx = 0;
  for (let ci = 0; ci < opts.candidates.length; ci++) {
    const cand = opts.candidates[ci];
    for (const ref of opts.references) {
      if (ref.id === cand.id) continue;
      for (const stage of opts.stages) {
        for (let s = 0; s < seeds; s++) {
          const seed = ((s * 101 + stage.id.length * 37 + idx * 13) | 0) >>> 0;
          specs.push({ a: cand, b: ref, stageId: stage.id as MatchSpec["stageId"], seed, meta: { candidateSide: 0, ci } });
          specs.push({ a: ref, b: cand, stageId: stage.id as MatchSpec["stageId"], seed, meta: { candidateSide: 1, ci } });
          owner.push(ci, ci);
          idx++;
        }
      }
    }
  }

  const outcomes = await runMatches(specs, { workers: opts.workers, onProgress: opts.onProgress });

  // Partition outcomes by candidate
  const buckets: MatchOutcome[][] = opts.candidates.map(() => []);
  for (let i = 0; i < outcomes.length; i++) {
    buckets[owner[i]].push(outcomes[i]);
  }
  return opts.candidates.map((c, i) => recordFromOutcomes(c.id, buckets[i]));
}
