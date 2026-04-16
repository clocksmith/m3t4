// Large-scale NP-hardness evidence.
//
// 1. Large random sweep: 200 configs × 3 seeds. Report max WR vs meta.
//    If any single bot breaks 85%, the game is "solved" easily.
// 2. Full 15×15 H2H with 5 seeds for statistical power. Count cycles.
// 3. Mutation-jitter test on the best-of-sweep: small perturbations
//    confirm/deny landscape roughness.

import fs from "node:fs";
import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  type BrainConfig,
} from "@m3t4/sim";
import { runMatches, type MatchSpec } from "./parallel.js";
import { scoreBatch } from "./score.js";
import { randomConfig, mutateConfig, promoteToTrajectory } from "./generate.js";

const N_SWEEP = parseInt(process.argv[2] ?? "200", 10);
const SEEDS_SWEEP = parseInt(process.argv[3] ?? "3", 10);
const SEEDS_H2H = 5;
const WORKERS = os.cpus().length;
const stages = Object.values(STAGES);
const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);

console.log(`\n# Large-scale NP-hardness evidence\n`);
console.log(`- Sweep: ${N_SWEEP} random configs (30% trajectory-promoted) × ${SEEDS_SWEEP} seeds × ${stages.length} stages × ${refs.length} refs`);
console.log(`- H2H: full ${refs.length}×${refs.length} matrix × ${SEEDS_H2H} seeds × ${stages.length} stages`);
console.log(`- Workers: ${WORKERS}\n`);

// -------------------- 1. Sweep --------------------

console.log(`## 1. Large random sweep — is any bot >85% WR?\n`);
const candidates: BrainConfig[] = [];
for (let i = 0; i < N_SWEEP; i++) {
  const cfg = Math.random() < 0.3
    ? promoteToTrajectory(randomConfig(`sw-${i}`), `sw-${i}`, 0.4)
    : randomConfig(`sw-${i}`);
  candidates.push(cfg);
}
process.stderr.write(`[sweep] scoring...\n`);
const sweepT0 = Date.now();
let lastPrint = 0;
const sweepRecords = await scoreBatch({
  candidates, references: refs, stages,
  seedsPerMatchup: SEEDS_SWEEP, workers: WORKERS,
  onProgress: (done, total) => {
    const now = Date.now();
    if (now - lastPrint > 500 || done === total) {
      process.stderr.write(`\r  ${done}/${total}`);
      lastPrint = now;
    }
  },
});
process.stderr.write("\n");
const sweepSec = ((Date.now() - sweepT0) / 1000).toFixed(1);

const sorted = sweepRecords.slice().sort((a, b) => b.winRate - a.winRate);
const top5 = sorted.slice(0, 5);
const max = sorted[0];
console.log(`Sweep completed in ${sweepSec}s.\n`);
console.log(`Top 5 random bots:`);
for (const r of top5) console.log(`  - ${r.id}: wr=${(r.winRate * 100).toFixed(1)}%  Δ=${r.avgScoreDiff.toFixed(2)}`);
console.log();
console.log(`Max WR across ${N_SWEEP} random: **${(max.winRate * 100).toFixed(1)}%**`);
const dominatedByRandom = max.winRate > 0.85;
console.log(`Random config >85%? ${dominatedByRandom ? "⚠ YES — meta is easily beaten by randomness" : "✓ NO — meta resists random exploration"}`);
console.log();

// Histogram of WR
const buckets = new Array(11).fill(0);
for (const r of sweepRecords) {
  const b = Math.min(10, Math.floor(r.winRate * 10));
  buckets[b]++;
}
console.log(`WR distribution across all ${sweepRecords.length} random bots:`);
for (let i = 0; i < buckets.length; i++) {
  const pctRange = `${i * 10}-${(i + 1) * 10}%`.padStart(7);
  const bar = "█".repeat(Math.round(buckets[i] / sweepRecords.length * 40));
  console.log(`  ${pctRange}  ${String(buckets[i]).padStart(4)}  ${bar}`);
}
console.log();

// -------------------- 2. H2H matrix --------------------

console.log(`## 2. Full ${refs.length}×${refs.length} H2H matrix — cycles?\n`);
const n = refs.length;
const specs: MatchSpec[] = [];
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    for (const st of stages) {
      for (let s = 0; s < SEEDS_H2H; s++) {
        const seed = ((s * 131 + i * 17 + j * 23) | 0) >>> 0;
        specs.push({ a: refs[i], b: refs[j], stageId: st.id as MatchSpec["stageId"], seed, meta: { i, j } });
      }
    }
  }
}
process.stderr.write(`[h2h] ${specs.length} matches...\n`);
const h2hT0 = Date.now();
lastPrint = 0;
const outcomes = await runMatches(specs, {
  workers: WORKERS,
  onProgress: (done, total) => {
    const now = Date.now();
    if (now - lastPrint > 500 || done === total) {
      process.stderr.write(`\r  ${done}/${total}`);
      lastPrint = now;
    }
  },
});
process.stderr.write("\n");
const h2hSec = ((Date.now() - h2hT0) / 1000).toFixed(1);

const wins = Array.from({ length: n }, () => new Array(n).fill(0));
const played = Array.from({ length: n }, () => new Array(n).fill(0));
for (const o of outcomes) {
  const m = o.spec.meta as { i: number; j: number };
  played[m.i][m.j]++;
  if (o.winner === 0) wins[m.i][m.j]++;
  else if (o.winner === -1) wins[m.i][m.j] += 0.5;
}
const wr = (a: number, b: number) => (played[a][b] ? wins[a][b] / played[a][b] : 0.5);
const ids = refs.map((r) => r.id);

const cycles: Array<[string, string, string]> = [];
for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
  if (a === b || b === c || a === c) continue;
  if (wr(a, b) > 0.6 && wr(b, c) > 0.6 && wr(c, a) > 0.6) cycles.push([ids[a], ids[b], ids[c]]);
}
console.log(`H2H completed in ${h2hSec}s.`);
console.log(`Cycles found (A >60% B >60% C >60% A): **${cycles.length}**`);
for (const [a, b, c] of cycles.slice(0, 6)) console.log(`  - ${a} → ${b} → ${c} → ${a}`);
console.log();

const globalWr = ids.map((_, i) => {
  let w = 0, p = 0;
  for (let j = 0; j < n; j++) { w += wins[i][j]; p += played[i][j]; }
  return p ? w / p : 0;
});
const sortedIds = ids.map((id, i) => ({ id, wr: globalWr[i] })).sort((a, b) => b.wr - a.wr);
console.log(`Global WR in full H2H:`);
for (const r of sortedIds) console.log(`  ${r.id.padEnd(12)}  ${(r.wr * 100).toFixed(1).padStart(5)}%`);
console.log();

// -------------------- 3. Landscape roughness --------------------

console.log(`## 3. Landscape roughness — mutation sensitivity of top bot\n`);
const topSweepCfg = candidates.find((c) => c.id === max.id)!;
const mutants: BrainConfig[] = [];
for (let i = 0; i < 30; i++) {
  mutants.push(mutateConfig(topSweepCfg, `${topSweepCfg.id}-m${i}`, 0.3, 0.15));
}
process.stderr.write(`[mut] scoring 30 mutants of top bot...\n`);
const mutRecs = await scoreBatch({
  candidates: mutants, references: refs, stages,
  seedsPerMatchup: SEEDS_SWEEP, workers: WORKERS,
});
const mutWrs = mutRecs.map((r) => r.winRate);
const meanMut = mutWrs.reduce((s, x) => s + x, 0) / mutWrs.length;
const stdMut = Math.sqrt(mutWrs.reduce((s, x) => s + (x - meanMut) ** 2, 0) / mutWrs.length);
const maxMut = Math.max(...mutWrs);
const minMut = Math.min(...mutWrs);
console.log(`Parent (top of sweep): wr=${(max.winRate * 100).toFixed(1)}%`);
console.log(`30 small mutations:`);
console.log(`  mean: ${(meanMut * 100).toFixed(1)}%`);
console.log(`  min:  ${(minMut * 100).toFixed(1)}%`);
console.log(`  max:  ${(maxMut * 100).toFixed(1)}%`);
console.log(`  std:  ${(stdMut * 100).toFixed(1)}%`);
console.log();

// -------------------- Summary --------------------

console.log(`## Summary\n`);
console.log(`| signal | result | interpretation |`);
console.log(`|---|---|---|`);
console.log(`| dominant strategy | ${dominatedByRandom ? "⚠ random >85%" : "no ≤ 85%"} | ${dominatedByRandom ? "meta is weak" : "meta resists random"} |`);
console.log(`| cycles in H2H | ${cycles.length} | ${cycles.length > 5 ? "rich non-transitivity" : "mostly transitive"} |`);
console.log(`| landscape roughness | std ${(stdMut * 100).toFixed(1)}% | ${stdMut > 0.08 ? "rough — gradient stuck" : stdMut > 0.04 ? "moderate" : "smooth"} |`);
console.log();

fs.writeFileSync("/tmp/nphard-large.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  nSweep: N_SWEEP, seedsSweep: SEEDS_SWEEP, seedsH2H: SEEDS_H2H,
  sweepMax: max.winRate,
  sweepMaxId: max.id,
  sweepMaxCfg: topSweepCfg,
  cycleCount: cycles.length,
  cycles: cycles.slice(0, 30),
  globalWr: sortedIds,
  mutStd: stdMut, mutMean: meanMut, mutMax: maxMut, mutMin: minMut,
}, null, 2));
console.error(`Wrote /tmp/nphard-large.json`);
