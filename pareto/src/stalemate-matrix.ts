// Full pair-stage stalemate matrix. Runs all 16x16 preset pairs across
// all 3 stages for N seeds and reports:
//   - pairs (a,b) where draw rate == 100% across seeds (stalemate attractors)
//   - (pair, stage) tuples where draw rate == 100% (pair-stage residuals)
//   - global draw rate
//
// Usage:
//   node pareto/dist/stalemate-matrix.js --seeds 300 --workers 10 \
//     --out /tmp/stalemate-matrix.json

import fs from "node:fs";
import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES, type StrategyName,
} from "@m3t4/sim";
import { runMatches, type MatchSpec } from "./parallel.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const name = k.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[name] = v;
  }
  return out;
}

const args = parseArgs(process.argv);
const SEEDS = parseInt(args.seeds ?? "300", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const OUT = args.out ?? "/tmp/stalemate-matrix.json";

const stages = Object.keys(STAGES) as Array<keyof typeof STAGES>;
const names = STRATEGY_NAMES as readonly StrategyName[];

const matches: MatchSpec[] = [];
for (const a of names) {
  for (const b of names) {
    for (const st of stages) {
      for (let s = 0; s < SEEDS; s++) {
        matches.push({
          a: STRATEGIES[a], b: STRATEGIES[b],
          stageId: st, seed: s + 1,
          meta: { a, b, st },
        });
      }
    }
  }
}

console.log(`[matrix] pairs=${names.length * names.length} stages=${stages.length} seeds=${SEEDS} matches=${matches.length} workers=${WORKERS}`);

const t0 = Date.now();
let lastPct = 0;
const outcomes = await runMatches(matches, {
  workers: WORKERS,
  onProgress: (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct >= lastPct + 5) {
      lastPct = pct;
      const elapsed = (Date.now() - t0) / 1000;
      const eta = elapsed / done * (total - done);
      console.log(`[matrix] ${done}/${total} (${pct}%) elapsed=${elapsed.toFixed(0)}s eta=${eta.toFixed(0)}s`);
    }
  },
});
const elapsed = (Date.now() - t0) / 1000;
console.log(`[matrix] done in ${elapsed.toFixed(0)}s`);

// Aggregate per (a,b) and per (a,b,stage)
type Bucket = { total: number; draws: number };
const pairBuckets = new Map<string, Bucket>();
const psBuckets = new Map<string, Bucket>();
let totalDraws = 0;

for (const o of outcomes) {
  const { a, b, st } = o.spec.meta as { a: string; b: string; st: string };
  const pk = `${a}|${b}`;
  const pk2 = `${a}|${b}|${st}`;
  const pb = pairBuckets.get(pk) ?? { total: 0, draws: 0 };
  const pb2 = psBuckets.get(pk2) ?? { total: 0, draws: 0 };
  pb.total++; pb2.total++;
  if (o.winner === -1) { pb.draws++; pb2.draws++; totalDraws++; }
  pairBuckets.set(pk, pb);
  psBuckets.set(pk2, pb2);
}

const totalDrawRate = totalDraws / outcomes.length;

const fullDrawPairs: Array<{ a: string; b: string; total: number }> = [];
for (const [k, v] of pairBuckets) {
  if (v.draws === v.total) {
    const [a, b] = k.split("|");
    fullDrawPairs.push({ a, b, total: v.total });
  }
}
const fullDrawPairStages: Array<{ a: string; b: string; stage: string; total: number }> = [];
for (const [k, v] of psBuckets) {
  if (v.draws === v.total) {
    const [a, b, stage] = k.split("|");
    fullDrawPairStages.push({ a, b, stage, total: v.total });
  }
}

// High-draw (>=50%) pair-stages, even if not 100% — useful diagnostic
const highDrawPairStages: Array<{ a: string; b: string; stage: string; drawRate: number; total: number }> = [];
for (const [k, v] of psBuckets) {
  const dr = v.draws / v.total;
  if (dr >= 0.5 && v.draws < v.total) {
    const [a, b, stage] = k.split("|");
    highDrawPairStages.push({ a, b, stage, drawRate: dr, total: v.total });
  }
}
highDrawPairStages.sort((x, y) => y.drawRate - x.drawRate);

const report = {
  seeds: SEEDS,
  totalMatches: outcomes.length,
  totalDraws,
  totalDrawRate,
  fullDrawPairs,
  fullDrawPairStages,
  highDrawPairStages: highDrawPairStages.slice(0, 20),
  elapsedSeconds: elapsed,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log(`\n=== Stalemate matrix (seeds=${SEEDS}) ===`);
console.log(`matches          : ${outcomes.length}`);
console.log(`draws            : ${totalDraws} (${(totalDrawRate * 100).toFixed(2)}%)`);
console.log(`100%-draw pairs       (${names.length * names.length}): ${fullDrawPairs.length}`);
console.log(`100%-draw pair-stages (${names.length * names.length * stages.length}): ${fullDrawPairStages.length}`);
if (fullDrawPairStages.length > 0) {
  console.log("\nResidual pair-stages:");
  for (const r of fullDrawPairStages) {
    console.log(`  ${r.a} vs ${r.b} @ ${r.stage}`);
  }
}
if (highDrawPairStages.length > 0) {
  console.log(`\nHigh-draw (>=50%, not 100%) pair-stages (top 20):`);
  for (const r of highDrawPairStages.slice(0, 20)) {
    console.log(`  ${r.a} vs ${r.b} @ ${r.stage}: ${(r.drawRate * 100).toFixed(1)}%`);
  }
}
console.log(`\nReport: ${OUT}`);
