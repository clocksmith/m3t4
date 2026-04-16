// Empirical evidence check for "NP-hard" claim.
//
// I was sloppy with the term. What's true is:
//   Finding a Nash equilibrium in a two-player zero-sum game with
//   continuous strategies + imperfect information is PPAD-hard in
//   general. For this game specifically, I should show EMPIRICAL
//   evidence of combinatorial structure rather than hand-wave.
//
// This script checks three things:
//
//   1. No dominant strategy exists — no config beats all others >90%.
//   2. Rock-paper-scissors cycles exist — at least one triplet where
//      A > B > C > A, evidence the strategy space is non-transitive.
//   3. Fitness landscape is rough — small mutations produce large WR
//      changes. If smooth, a gradient solver would find the optimum.
//
// If all three check out, the claim "no single best bot exists and
// searching is hard" is empirically supported. Not a formal proof —
// formal NP-hardness would need a reduction from a known hard problem.

import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  type BrainConfig, type ParamKey,
} from "@selfplay/sim";
import { runMatches, type MatchSpec } from "./parallel.js";
import { scoreBatch } from "./score.js";
import { randomConfig, mutateConfig } from "./generate.js";

const SEEDS_H2H = 3;
const SEEDS_SWEEP = 2;
const WORKERS = os.cpus().length;
const stages = Object.values(STAGES);
const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);

console.log(`\n# NP-hardness evidence check\n`);

// -------------------- 1. Check for dominant strategy --------------------

console.log(`## 1. Is there a dominant strategy? (no config >90% WR against all others)\n`);

// Score all 15 named AGAINST each other
const records1 = await scoreBatch({
  candidates: refs, references: refs, stages,
  seedsPerMatchup: SEEDS_H2H, workers: WORKERS,
});
const sorted1 = records1.slice().sort((a, b) => b.winRate - a.winRate);
const top = sorted1[0];
console.log(`Best config among 15 named: **${top.id}** with ${(top.winRate * 100).toFixed(1)}% WR`);
const dominant = top.winRate > 0.9;
console.log(`Dominant (>90%)? ${dominant ? "YES — game is ~solved" : "NO — no strategy dominates"}`);
console.log();

// -------------------- 2. Rock-paper-scissors cycles --------------------

console.log(`## 2. Do rock-paper-scissors cycles exist?\n`);

// Full H2H pairwise matrix
const n = refs.length;
const pairSpecs: MatchSpec[] = [];
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    for (const st of stages) {
      for (let s = 0; s < SEEDS_H2H; s++) {
        const seed = ((s * 131 + i * 17 + j * 23) | 0) >>> 0;
        pairSpecs.push({ a: refs[i], b: refs[j], stageId: st.id as MatchSpec["stageId"], seed, meta: { i, j } });
      }
    }
  }
}
const outcomes = await runMatches(pairSpecs, { workers: WORKERS });
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
for (let a = 0; a < n; a++) {
  for (let b = 0; b < n; b++) {
    if (a === b) continue;
    for (let c = 0; c < n; c++) {
      if (c === a || c === b) continue;
      if (wr(a, b) > 0.6 && wr(b, c) > 0.6 && wr(c, a) > 0.6) {
        cycles.push([ids[a], ids[b], ids[c]]);
      }
    }
  }
}

console.log(`Cycles found (A beats B >60% beats C >60% beats A >60%): ${cycles.length}`);
for (const [a, b, c] of cycles.slice(0, 10)) console.log(`  - ${a} → ${b} → ${c} → ${a}`);
if (cycles.length === 0) console.log(`_none — meta is transitive_`);
else if (cycles.length > 0) console.log(`\n✓ Non-transitive meta — no linear ranking possible`);
console.log();

// -------------------- 3. Fitness landscape roughness --------------------

console.log(`## 3. Is the fitness landscape rough? (small mutation = large WR change?)\n`);

// Take a high-performing config, mutate it slightly (10% parameter changes),
// measure the distribution of WR changes. Rough landscapes = varied changes.
const parent = refs.find((r) => r.id === top.id)!;
const mutants: BrainConfig[] = [];
for (let i = 0; i < 20; i++) {
  mutants.push(mutateConfig(parent, `${parent.id}-m${i}`, 0.3, 0.15)); // 30% of knobs, ±15% of range
}
const mutantRecs = await scoreBatch({
  candidates: mutants, references: refs, stages,
  seedsPerMatchup: SEEDS_SWEEP, workers: WORKERS,
});
const parentRec = records1.find((r) => r.id === parent.id)!;
const mutantWrs = mutantRecs.map((r) => r.winRate);
const meanMut = mutantWrs.reduce((s, x) => s + x, 0) / mutantWrs.length;
const maxMut = Math.max(...mutantWrs);
const minMut = Math.min(...mutantWrs);
const stdMut = Math.sqrt(mutantWrs.reduce((s, x) => s + (x - meanMut) ** 2, 0) / mutantWrs.length);

console.log(`Parent: ${parent.id} WR = ${(parentRec.winRate * 100).toFixed(1)}%`);
console.log(`20 small mutations of parent:`);
console.log(`  mean WR: ${(meanMut * 100).toFixed(1)}%`);
console.log(`  min WR:  ${(minMut * 100).toFixed(1)}%`);
console.log(`  max WR:  ${(maxMut * 100).toFixed(1)}%`);
console.log(`  std dev: ${(stdMut * 100).toFixed(1)}%  (of WR)`);
console.log();
const roughness = stdMut;
if (roughness > 0.08) console.log(`✓ Landscape is rough (std > 8%). Gradient methods will not find global optimum.`);
else if (roughness > 0.04) console.log(`~ Landscape is moderately rough. Gradient methods may converge locally.`);
else console.log(`✗ Landscape is smooth — gradient methods would find the optimum easily.`);
console.log();

// -------------------- Summary --------------------

console.log(`## Summary\n`);
console.log(`- dominant strategy: ${dominant ? "YES ⚠" : "NO ✓"}`);
console.log(`- RPS cycles:        ${cycles.length > 0 ? `YES ✓ (${cycles.length} found)` : "NO ⚠"}`);
console.log(`- rough landscape:   ${roughness > 0.08 ? "YES ✓" : roughness > 0.04 ? "~" : "NO ⚠"}`);
console.log();

const allEvidence = !dominant && cycles.length > 0 && roughness > 0.08;
if (allEvidence) {
  console.log(`**Empirical evidence supports "no single best bot, search is hard."**`);
  console.log(`Not a formal proof of NP-hardness, but consistent with it.`);
} else {
  console.log(`Mixed evidence. Some structural complexity but not all three signals present.`);
}
