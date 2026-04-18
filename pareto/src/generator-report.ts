// Diagnostic report for Phase 3A: does the new generator actually
// produce non-center-biased candidates? Answers these questions:
//
//   - Does the bank contain axis-extreme examples on weak knobs?
//   - How does pairwise distance compare to the old center-biased
//     random-budgeted generator?
//   - What's the budget-share distribution spread?
//   - Are there near-duplicate candidates (clone warnings)?
//
// Usage:
//   node pareto/dist/generator-report.js [--size 500] [--seed 42]
//     Generates N candidates with the new sampler, prints stats.

import {
  USER_KNOBS, RANGES, USER_BUDGET,
  type BrainConfig, type ParamKey,
} from "@m3t4/sim";
import { sampleInitialPopulation, sampleCandidate, type SampledCandidate, type SourceKind } from "./simplex-sample.js";
import { randomBudgeted } from "./budget-util.js";

interface CoverageRow {
  knob: string;
  min: number;
  max: number;
  std: number;
  extremeHigh: number;  // count with ui > 80
  extremeLow: number;   // count with ui < 20 (for bipolar, meaningful; for 0-bounded, is "near zero")
  coverage: number;     // (max - min) / fullRange
}

interface GenReport {
  n: number;
  perKnob: CoverageRow[];
  meanPairwise: number;
  minPairwise: number;
  maxPairwise: number;
  closestPair: string[];
  budgetShareStd: number; // mean over knobs of std of shares across bank
  sourceKindCounts: Map<SourceKind, number>;
  legalMaxPairwise: number;  // empirical observed max in this bank
}

function cfgToUi(cfg: BrainConfig): number[] {
  const out = new Array(USER_KNOBS.length).fill(0);
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const k = USER_KNOBS[i];
    const [lo, hi] = RANGES[k];
    const v = cfg.attributes[k];
    const raw = typeof v === "number" ? v : 0;
    out[i] = ((raw - lo) / (hi - lo)) * 100;
  }
  return out;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
}

function pairwise(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) / 100;
    s += d * d;
  }
  return Math.sqrt(s);
}

function budgetShare(ui: number[]): number[] {
  const sum = ui.reduce((a, x) => a + x, 0);
  return sum > 0 ? ui.map((x) => x / sum) : ui.map(() => 0);
}

function analyze(candidates: Array<{ config: BrainConfig; meta: { sourceKind: SourceKind }[] | { sourceKind: SourceKind } }>): GenReport {
  const uis = candidates.map((c) => cfgToUi(c.config));
  const perKnob: CoverageRow[] = [];
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const k = USER_KNOBS[i];
    const values = uis.map((u) => u[i]);
    const [lo, hi] = RANGES[k];
    const isBipolar = lo < 0 && hi > 0;
    perKnob.push({
      knob: k,
      min: Math.min(...values),
      max: Math.max(...values),
      std: std(values),
      extremeHigh: values.filter((v) => v > 80).length,
      extremeLow: isBipolar ? values.filter((v) => v < 20).length : 0,
      coverage: (Math.max(...values) - Math.min(...values)) / 100,
    });
  }
  let sumD = 0;
  let minD = Infinity;
  let maxD = 0;
  let count = 0;
  let closestPair = ["", ""];
  for (let i = 0; i < uis.length; i++) {
    for (let j = i + 1; j < uis.length; j++) {
      const d = pairwise(uis[i], uis[j]);
      sumD += d;
      if (d < minD) { minD = d; closestPair = [candidates[i].config.id, candidates[j].config.id]; }
      if (d > maxD) maxD = d;
      count++;
    }
  }
  // Budget-share std: for each knob, compute std of its share across bank
  const shares = uis.map(budgetShare);
  const knobShareStds = [];
  for (let i = 0; i < USER_KNOBS.length; i++) {
    knobShareStds.push(std(shares.map((s) => s[i])));
  }
  const budgetShareStdMean = knobShareStds.reduce((a, x) => a + x, 0) / knobShareStds.length;

  const sourceKindCounts = new Map<SourceKind, number>();
  for (const c of candidates) {
    const meta = (c as { meta: { sourceKind: SourceKind } }).meta;
    if (meta && meta.sourceKind) {
      sourceKindCounts.set(meta.sourceKind, (sourceKindCounts.get(meta.sourceKind) ?? 0) + 1);
    }
  }

  return {
    n: candidates.length,
    perKnob,
    meanPairwise: sumD / count,
    minPairwise: minD,
    maxPairwise: maxD,
    closestPair,
    budgetShareStd: budgetShareStdMean,
    sourceKindCounts,
    legalMaxPairwise: maxD, // empirically observed
  };
}

function printReport(label: string, r: GenReport): void {
  console.log(`\n## ${label}`);
  console.log(`n=${r.n}  pairwise: mean=${r.meanPairwise.toFixed(3)} min=${r.minPairwise.toFixed(3)} max=${r.maxPairwise.toFixed(3)}  budgetShareStd=${r.budgetShareStd.toFixed(4)}`);
  if (r.sourceKindCounts.size > 0) {
    const entries = Array.from(r.sourceKindCounts.entries()).sort((a, b) => b[1] - a[1]);
    console.log(`sourceKinds: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  console.log(`closest pair: ${r.closestPair[0]} ↔ ${r.closestPair[1]}`);
  console.log(`\n  Per-knob coverage (sorted ascending — low = axis under-explored)`);
  const sorted = r.perKnob.slice().sort((a, b) => a.coverage - b.coverage);
  for (const k of sorted) {
    const bar = "█".repeat(Math.round(k.coverage * 20));
    const flag = k.coverage < 0.3 ? " ⚠" : k.coverage < 0.5 ? " ~" : " ✓";
    console.log(`  ${k.knob.padEnd(11)} range=${k.min.toFixed(0).padStart(3)}→${k.max.toFixed(0).padStart(3)}  std=${k.std.toFixed(1).padStart(5)}  hi=${String(k.extremeHigh).padStart(3)}  lo=${String(k.extremeLow).padStart(3)}  cov=${(k.coverage * 100).toFixed(0).padStart(3)}% ${bar}${flag}`);
  }
}

function parseArgs(argv: string[]): { size: number; seed: number } {
  const out = { size: 500, seed: 42 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--size" && argv[i + 1]) out.size = parseInt(argv[++i], 10);
    else if (argv[i] === "--seed" && argv[i + 1]) out.seed = parseInt(argv[++i], 10);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = parseArgs(process.argv);

console.log(`# Phase 3A generator report (size=${args.size}, seed=${args.seed})\n`);

// --- Old generator (baseline) ---
const oldRng = mulberry32(args.seed);
const oldCandidates: Array<{ config: BrainConfig; meta: { sourceKind: SourceKind } }> = [];
for (let i = 0; i < args.size; i++) {
  Math.random = oldRng; // hack: randomBudgeted uses Math.random internally
  const cfg = randomBudgeted(`old-${i}`);
  oldCandidates.push({ config: cfg, meta: { sourceKind: "random_legacy" as SourceKind } });
}

// --- New generator ---
const newRng = mulberry32(args.seed + 1);
const newCandidates: SampledCandidate[] = sampleInitialPopulation(args.size, 0, newRng);
// Fill rest with Dirichlet mix
while (newCandidates.length < args.size) {
  const kinds: SourceKind[] = ["dirichlet_sparse", "dirichlet_balanced", "dirichlet_dense"];
  const kind = kinds[Math.floor(newRng() * kinds.length)];
  newCandidates.push(sampleCandidate({ id: `${kind}-${newCandidates.length}`, sourceKind: kind, generation: 0, rng: newRng }));
}

const oldReport = analyze(oldCandidates);
const newReport = analyze(newCandidates);

printReport("OLD generator (randomBudgeted baseline)", oldReport);
printReport("NEW generator (sampleInitialPopulation + Dirichlet mix)", newReport);

console.log(`\n## Delta summary`);
console.log(`  mean pairwise:  ${oldReport.meanPairwise.toFixed(3)} → ${newReport.meanPairwise.toFixed(3)}  (Δ ${((newReport.meanPairwise - oldReport.meanPairwise) / oldReport.meanPairwise * 100).toFixed(0)}%)`);
console.log(`  max pairwise:   ${oldReport.maxPairwise.toFixed(3)} → ${newReport.maxPairwise.toFixed(3)}  (Δ ${((newReport.maxPairwise - oldReport.maxPairwise) / oldReport.maxPairwise * 100).toFixed(0)}%)`);
console.log(`  budgetShareStd: ${oldReport.budgetShareStd.toFixed(4)} → ${newReport.budgetShareStd.toFixed(4)}  (Δ ${((newReport.budgetShareStd - oldReport.budgetShareStd) / oldReport.budgetShareStd * 100).toFixed(0)}%)`);
console.log(`\n  Weak-axis extremeHigh counts (old → new):`);
const weakAxes: ParamKey[] = ["burnRate", "moat", "shipRate", "foresight", "pivotSpeed", "spite"];
for (const k of weakAxes) {
  const oldRow = oldReport.perKnob.find((r) => r.knob === k)!;
  const newRow = newReport.perKnob.find((r) => r.knob === k)!;
  console.log(`  ${k.padEnd(11)} ${String(oldRow.extremeHigh).padStart(3)} → ${String(newRow.extremeHigh).padStart(3)}`);
}
