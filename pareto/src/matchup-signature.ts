// Matchup-signature diversity — "how does this config PLAY?" fingerprint.
//
// Attribute-distance (novelty.ts) catches "these configs have different
// numbers." Matchup-signature catches "these configs PLAY differently."
// You need both: two configs with different attributes can be clones in
// behavior, and two with similar attributes can be genuinely distinct.
//
// A candidate's signature is its per-reference WR row vector. Two
// signatures are close if the candidate beats the same opponents by
// similar margins — that is a playstyle fingerprint.
//
// Usage:
//   node pareto/dist/matchup-signature.js              # current roster
//   node pareto/dist/matchup-signature.js --seeds 5    # more samples

import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig, type Stage,
} from "@m3t4/sim";
import { runMatches, type MatchSpec } from "./parallel.js";

export interface Signature {
  id: string;
  row: Map<string, number>; // refId -> WR in [0,1]
}

export async function computeSignatures(opts: {
  candidates: BrainConfig[];
  references: BrainConfig[];
  stages: Stage[];
  seedsPerMatchup: number;
  workers: number;
}): Promise<Signature[]> {
  const { candidates, references, stages, seedsPerMatchup, workers } = opts;
  const specs: MatchSpec[] = [];
  let idx = 0;
  for (const cand of candidates) {
    for (const ref of references) {
      if (ref.id === cand.id) continue;
      for (const stage of stages) {
        for (let s = 0; s < seedsPerMatchup; s++) {
          const seed = ((s * 101 + stage.id.length * 37 + idx * 13) | 0) >>> 0;
          specs.push({ a: cand, b: ref, stageId: stage.id as MatchSpec["stageId"], seed, meta: { candId: cand.id, refId: ref.id, candSide: 0 } });
          specs.push({ a: ref, b: cand, stageId: stage.id as MatchSpec["stageId"], seed, meta: { candId: cand.id, refId: ref.id, candSide: 1 } });
          idx++;
        }
      }
    }
  }

  const outcomes = await runMatches(specs, { workers });
  const accum = new Map<string, Map<string, { w: number; n: number }>>();
  for (const o of outcomes) {
    const m = o.spec.meta as { candId: string; refId: string; candSide: 0 | 1 };
    if (!accum.has(m.candId)) accum.set(m.candId, new Map());
    const row = accum.get(m.candId)!;
    if (!row.has(m.refId)) row.set(m.refId, { w: 0, n: 0 });
    const cell = row.get(m.refId)!;
    cell.n++;
    if (o.winner === m.candSide) cell.w++;
    else if (o.winner === -1) cell.w += 0.5;
  }

  return candidates.map((c) => {
    const row = new Map<string, number>();
    const raw = accum.get(c.id);
    if (raw) {
      for (const [refId, cell] of raw) row.set(refId, cell.n > 0 ? cell.w / cell.n : 0.5);
    }
    return { id: c.id, row };
  });
}

// Euclidean distance between two signature rows, measured only over
// references that both candidates played. Rows that don't share any
// reference return Infinity (shouldn't happen for same-reference set).
export function signatureDistance(a: Signature, b: Signature): number {
  let sum = 0;
  let count = 0;
  for (const [refId, aWr] of a.row) {
    const bWr = b.row.get(refId);
    if (bWr === undefined) continue;
    const d = aWr - bWr;
    sum += d * d;
    count++;
  }
  if (count === 0) return Infinity;
  // Average per-dimension, then take sqrt — gives a scale-invariant
  // distance regardless of reference pool size.
  return Math.sqrt(sum / count);
}

// Rank candidates by how "clone-like" each pair is. Low signatureDistance
// with high attribute distance = mechanical-clone risk (different knobs
// but same playstyle). Low signatureDistance with low attribute distance
// = true duplicate.
export interface PairwiseSignature {
  a: string;
  b: string;
  distance: number;
}

export function pairwiseSignatures(signatures: Signature[]): PairwiseSignature[] {
  const out: PairwiseSignature[] = [];
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      out.push({ a: signatures[i].id, b: signatures[j].id, distance: signatureDistance(signatures[i], signatures[j]) });
    }
  }
  return out;
}

// ----- CLI -----

function parseArgs(argv: string[]): { seeds: number; workers: number } {
  const out = { seeds: 3, workers: os.cpus().length };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--seeds" && argv[i + 1]) { out.seeds = parseInt(argv[++i], 10); }
    else if (argv[i] === "--workers" && argv[i + 1]) { out.workers = parseInt(argv[++i], 10); }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  const roster = STRATEGY_NAMES.map((n) => STRATEGIES[n as keyof typeof STRATEGIES]);
  console.error(`Computing signatures for ${roster.length} configs vs each other, seeds=${args.seeds}...`);
  const signatures = await computeSignatures({
    candidates: roster,
    references: roster,
    stages: Object.values(STAGES),
    seedsPerMatchup: args.seeds,
    workers: args.workers,
  });

  const pairs = pairwiseSignatures(signatures).sort((a, b) => a.distance - b.distance);

  console.log(`# Matchup-signature report (${roster.length} configs, ${args.seeds} seeds/matchup)\n`);
  console.log(`## Closest pairs (behavioral clones — low distance means they PLAY the same)\n`);
  for (const p of pairs.slice(0, 8)) {
    console.log(`  ${p.a.padEnd(12)} ↔ ${p.b.padEnd(12)}  distance=${p.distance.toFixed(3)}`);
  }
  console.log(`\n## Farthest pairs (play most differently)\n`);
  for (const p of pairs.slice(-5).reverse()) {
    console.log(`  ${p.a.padEnd(12)} ↔ ${p.b.padEnd(12)}  distance=${p.distance.toFixed(3)}`);
  }
  const meanDist = pairs.reduce((a, p) => a + p.distance, 0) / pairs.length;
  const minDist = pairs[0].distance;
  const maxDist = pairs[pairs.length - 1].distance;
  console.log(`\n## Summary`);
  console.log(`  mean signature distance: ${meanDist.toFixed(3)}`);
  console.log(`  min  signature distance: ${minDist.toFixed(3)} (clone risk if < 0.10)`);
  console.log(`  max  signature distance: ${maxDist.toFixed(3)}`);
}
