// Roster-level optimizer. Given a large candidate bank, finds the
// best 16-member subset by simulated annealing on a multi-objective
// fitness function:
//
//   + externalStrength  (mean WR vs reference pool)
//   + attributeCoverage (per-axis range, weak-axis weighted)
//   + matchupDiversity  (mean signature distance)
//   + counterCoverage   (every member has ≥2 internal counters)
//   + internalCycleDensity
//   - dominancePenalty  (internal WR > 0.7)
//   - clonePenalty      (signature distance < 0.10)
//   - zeroCounterPenalty
//
// This replaces the greedy max-min-distance selector in roster-evolve.ts,
// which produced the "moderate winners only" bias documented in the
// candidate-bank coverage report (9/81 niches = 11% covered).

import fs from "node:fs";
import os from "node:os";
import {
  RANGES, STAGES, STRATEGIES, STRATEGY_NAMES, USER_KNOBS,
  type BrainConfig, type ParamKey,
} from "@m3t4/sim";
import { featureVector } from "./novelty.js";
import { computeSignatures, signatureDistance, type Signature } from "./matchup-signature.js";
import { computeDescriptors } from "./candidate-bank.js";
import { scoreBatch } from "./score.js";

const ROSTER_SIZE = 16;

interface Candidate {
  id: string;
  config: BrainConfig;
  wr: number; // external WR vs reference pool
  externalSignature?: Signature; // row vs named meta (for strength cross-checks)
  internalSignature?: Signature; // row vs OTHER pool members (for counter/cycle metrics)
}

interface RosterEval {
  externalStrength: number;
  attributeCoverage: number;
  signatureDiversity: number;
  counterCoverage: number;
  cycleDensity: number;
  dominancePenalty: number;
  clonePenalty: number;
  zeroCounterPenalty: number;
  fitness: number;
}

function attrDist(a: BrainConfig, b: BrainConfig): number {
  const va = featureVector(a);
  const vb = featureVector(b);
  let s = 0;
  for (let i = 0; i < va.length; i++) {
    const d = va[i] - vb[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// Per-attribute coverage, with extra weight on under-explored axes.
const WEAK_AXIS_BOOST: Partial<Record<ParamKey, number>> = {
  burnRate: 1.5, moat: 1.5, shipRate: 1.5, foresight: 1.5, pivotSpeed: 1.3,
  spite: 1.3, leverage: 1.0, networking: 1.0, greed: 1.0, pacing: 1.0, cunning: 1.0,
  lift: 1.2, parry: 1.2, chase: 1.2, discipline: 1.2,
};

function attributeCoverage(roster: Candidate[]): number {
  const attrs = USER_KNOBS;
  let sum = 0;
  let weightSum = 0;
  for (const k of attrs) {
    const [lo, hi] = RANGES[k];
    const vals = roster.map((r) => {
      const v = r.config.attributes[k];
      if (typeof v === "number") return v;
      if (v && typeof v === "object" && "base" in v && typeof v.base === "number") return v.base;
      return 0;
    });
    const coverage = (Math.max(...vals) - Math.min(...vals)) / (hi - lo);
    const w = WEAK_AXIS_BOOST[k] ?? 1;
    sum += coverage * w;
    weightSum += w;
  }
  return sum / weightSum;
}

function signatureDiversity(roster: Candidate[]): { mean: number; min: number; clonePairs: number } {
  // Uses externalSignature (row vs named meta) — the playstyle fingerprint
  // against a fixed reference pool. Internal signatures would measure
  // "how do they play against each other" which is already captured in
  // counterCoverage/cycleDensity; we want a different diversity signal.
  let sum = 0;
  let min = Infinity;
  let clonePairs = 0;
  let n = 0;
  for (let i = 0; i < roster.length; i++) {
    if (!roster[i].externalSignature) continue;
    for (let j = i + 1; j < roster.length; j++) {
      if (!roster[j].externalSignature) continue;
      const d = signatureDistance(roster[i].externalSignature!, roster[j].externalSignature!);
      sum += d;
      if (d < min) min = d;
      if (d < 0.10) clonePairs++;
      n++;
    }
  }
  return n > 0 ? { mean: sum / n, min, clonePairs } : { mean: 0, min: 0, clonePairs: 0 };
}

// Uses the pool-vs-pool internal signatures. internalSignature.row[b.id]
// is a's WR vs b from actual simulation. Previously this used the
// (named-meta) external signatures which never contained candidate IDs,
// so internalWr always returned 0.5 — counterCoverage/cycleDensity/
// dominancePenalty were inert.
function internalWr(a: Candidate, b: Candidate): number {
  const fromA = a.internalSignature?.row.get(b.id);
  const fromB = b.internalSignature?.row.get(a.id);
  if (fromA !== undefined && fromB !== undefined) return (fromA + (1 - fromB)) / 2;
  if (fromA !== undefined) return fromA;
  if (fromB !== undefined) return 1 - fromB;
  return 0.5;
}

function counterCoverage(roster: Candidate[]): { minCounters: number; zeroCount: number } {
  let zeroCount = 0;
  let minCounters = Infinity;
  for (const r of roster) {
    let counters = 0;
    for (const other of roster) {
      if (other.id === r.id) continue;
      if (internalWr(other, r) > 0.55) counters++;
    }
    if (counters === 0) zeroCount++;
    if (counters < minCounters) minCounters = counters;
  }
  return { minCounters: minCounters === Infinity ? 0 : minCounters, zeroCount };
}

function cycleCount(roster: Candidate[]): number {
  let cycles = 0;
  for (let a = 0; a < roster.length; a++) for (let b = 0; b < roster.length; b++) for (let c = 0; c < roster.length; c++) {
    if (a === b || b === c || a === c) continue;
    if (internalWr(roster[a], roster[b]) > 0.55 &&
        internalWr(roster[b], roster[c]) > 0.55 &&
        internalWr(roster[c], roster[a]) > 0.55) {
      cycles++;
    }
  }
  return cycles;
}

function evalRoster(roster: Candidate[]): RosterEval {
  const externalStrength = roster.reduce((s, r) => s + r.wr, 0) / roster.length;
  const coverage = attributeCoverage(roster);
  const sig = signatureDiversity(roster);
  const counters = counterCoverage(roster);
  const cycles = cycleCount(roster);
  // Dominance: any config with internal WR > 0.70
  let dominanceCount = 0;
  for (const r of roster) {
    let wins = 0;
    for (const other of roster) if (other.id !== r.id && internalWr(r, other) > 0.55) wins++;
    if (wins / (roster.length - 1) > 0.7) dominanceCount++;
  }
  const dominancePenalty = dominanceCount * 0.1;
  const clonePenalty = sig.clonePairs * 0.05;
  const zeroCounterPenalty = counters.zeroCount * 0.15;
  // Composite fitness
  const fitness =
    externalStrength * 0.6 +
    coverage * 0.8 +
    sig.mean * 1.0 +
    Math.min(counters.minCounters / 3, 1) * 0.3 +
    Math.min(cycles / 80, 1) * 0.2 -
    dominancePenalty - clonePenalty - zeroCounterPenalty;
  return {
    externalStrength, attributeCoverage: coverage,
    signatureDiversity: sig.mean,
    counterCoverage: counters.minCounters,
    cycleDensity: cycles,
    dominancePenalty, clonePenalty, zeroCounterPenalty,
    fitness,
  };
}

function selectAnnealing(
  pool: Candidate[],
  iterations: number,
  seed: Candidate[] | null,
): { roster: Candidate[]; eval: RosterEval; history: number[] } {
  const rng = (() => {
    let s = 0x12345678;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  })();
  if (pool.length < ROSTER_SIZE) throw new Error(`pool too small: ${pool.length}`);

  let current: Candidate[] = seed ?? pool.slice(0, ROSTER_SIZE);
  if (current.length !== ROSTER_SIZE) {
    // Start: pick top-wr + random others
    const sorted = pool.slice().sort((a, b) => b.wr - a.wr);
    current = sorted.slice(0, Math.min(8, ROSTER_SIZE));
    while (current.length < ROSTER_SIZE) {
      const pick = pool[Math.floor(rng() * pool.length)];
      if (!current.includes(pick)) current.push(pick);
    }
  }
  let currentEval = evalRoster(current);
  let best: Candidate[] = current.slice();
  let bestEval = currentEval;
  const history: number[] = [currentEval.fitness];

  for (let i = 0; i < iterations; i++) {
    const temp = 1 - i / iterations;
    const replaceIdx = Math.floor(rng() * ROSTER_SIZE);
    const outside = pool.filter((c) => !current.includes(c));
    if (outside.length === 0) break;
    const newMember = outside[Math.floor(rng() * outside.length)];
    const trial = current.slice();
    trial[replaceIdx] = newMember;
    const trialEval = evalRoster(trial);
    const delta = trialEval.fitness - currentEval.fitness;
    if (delta > 0 || rng() < Math.exp(delta / (temp * 0.05 + 0.01))) {
      current = trial;
      currentEval = trialEval;
      if (currentEval.fitness > bestEval.fitness) {
        best = current.slice();
        bestEval = currentEval;
      }
    }
    history.push(currentEval.fitness);
  }
  return { roster: best, eval: bestEval, history };
}

// ----- CLI -----

async function main(): Promise<void> {
  const args = (() => {
    const out: Record<string, string> = {};
    for (let i = 2; i < process.argv.length; i++) {
      const k = process.argv[i];
      if (k.startsWith("--")) {
        const next = process.argv[i + 1];
        if (next && !next.startsWith("--")) { out[k.slice(2)] = next; i++; }
        else out[k.slice(2)] = "1";
      }
    }
    return out;
  })();

  const bankPath = args.bank ?? "/tmp/new-roster-v4.json";
  const iterations = parseInt(args.iterations ?? "2000", 10);
  const poolCap = parseInt(args.poolCap ?? "80", 10);
  const outPath = args.out ?? "/tmp/roster-selected.json";
  const raw = JSON.parse(fs.readFileSync(bankPath, "utf8"));
  const source: Array<{ id?: string; config?: BrainConfig; attributes?: BrainConfig["attributes"]; internalWr?: number; wr?: number }> =
    raw.roster ?? raw.hof ?? raw;

  let pool: Candidate[] = source.map((r, i) => ({
    id: r.id ?? `c${i}`,
    config: r.config ?? { id: r.id ?? `c${i}`, attributes: r.attributes! },
    wr: r.internalWr ?? r.wr ?? 0.5,
  }));

  // Truncate to top-K by external WR if pool exceeds cap — otherwise the
  // N×N internal H2H becomes prohibitively expensive (N=200 → 240k matches).
  if (pool.length > poolCap) {
    const before = pool.length;
    pool = pool.slice().sort((a, b) => b.wr - a.wr).slice(0, poolCap);
    console.error(`Pool truncated ${before} → ${pool.length} by external WR (--poolCap ${poolCap})`);
  }

  const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n as keyof typeof STRATEGIES]);
  const stages = Object.values(STAGES);
  const workers = os.cpus().length;

  console.error(`Pool: ${pool.length} candidates. Computing external signatures (vs named meta)...`);
  const extSigs = await computeSignatures({
    candidates: pool.map((p) => p.config),
    references: refs,
    stages,
    seedsPerMatchup: 2,
    workers,
  });
  const extMap = new Map(extSigs.map((s) => [s.id, s]));
  for (const p of pool) p.externalSignature = extMap.get(p.config.id);

  console.error(`Computing internal signatures (pool × pool, ~${pool.length * (pool.length - 1)} matchups)...`);
  const intSigs = await computeSignatures({
    candidates: pool.map((p) => p.config),
    references: pool.map((p) => p.config),
    stages,
    seedsPerMatchup: 2,
    workers,
  });
  const intMap = new Map(intSigs.map((s) => [s.id, s]));
  for (const p of pool) p.internalSignature = intMap.get(p.config.id);

  console.error(`Starting annealing: ${iterations} iterations over ${pool.length}C16 subsets...`);
  const result = selectAnnealing(pool, iterations, null);

  console.log(`\n# Roster selection — ${iterations} annealing iterations\n`);
  console.log(`## Selected roster\n`);
  for (const r of result.roster) {
    const d = computeDescriptors(r.config);
    console.log(`  ${r.id.padEnd(14)}  wr=${(r.wr * 100).toFixed(1)}%  ` +
      `agg=${d.aggression.toFixed(2)} def=${d.defense.toFixed(2)} ` +
      `del=${d.delivery.toFixed(2)} chaos=${d.chaos.toFixed(2)}`);
  }
  console.log(`\n## Fitness breakdown`);
  console.log(`  externalStrength:    ${result.eval.externalStrength.toFixed(3)}`);
  console.log(`  attributeCoverage:   ${result.eval.attributeCoverage.toFixed(3)}`);
  console.log(`  signatureDiversity:  ${result.eval.signatureDiversity.toFixed(3)}`);
  console.log(`  counterCoverage:     ${result.eval.counterCoverage}  (target ≥2)`);
  console.log(`  cycleDensity:        ${result.eval.cycleDensity}`);
  console.log(`  dominancePenalty:    ${result.eval.dominancePenalty.toFixed(3)}`);
  console.log(`  clonePenalty:        ${result.eval.clonePenalty.toFixed(3)}`);
  console.log(`  zeroCounterPenalty:  ${result.eval.zeroCounterPenalty.toFixed(3)}`);
  console.log(`  TOTAL fitness:       ${result.eval.fitness.toFixed(3)}`);

  fs.writeFileSync(outPath, JSON.stringify({
    selectedAt: new Date().toISOString(),
    roster: result.roster.map((r) => ({
      id: r.id,
      config: r.config,
      wr: r.wr,
    })),
    eval: result.eval,
    historyTail: result.history.slice(-50),
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
