// Fixed-spend budget exploit test.
//
// For each spend level, run a bounded diagonal CMA-style search over the 11
// user knobs while forcing the UI-space sum to that exact spend. Hallucination
// is derived with the canonical budget formula. The acceptance question is:
// no optimized over-budget level should beat the best in-budget level beyond
// sampling noise.

import os from "node:os";
import {
  STAGES,
  STRATEGIES,
  STRATEGY_NAMES,
  USER_BUDGET,
  USER_KNOBS,
  budgetSpent,
  computedHallucinationForSpend,
  type BrainConfig,
  type ParamKey,
  uiToNative,
} from "@m3t4/sim";
import { scoreBatch, type ScoreRecord } from "./score.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const name = k.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[name] = next; i++; }
      else out[name] = "1";
    } else {
      positional.push(k);
    }
  }
  if (positional[0] && !out.pop) out.pop = positional[0];
  if (positional[1] && !out.seeds) out.seeds = positional[1];
  return out;
}

const args = parseArgs(process.argv);
const GENS = parseInt(args.gens ?? "6", 10);
const POP = parseInt(args.pop ?? "18", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const NOISE_TOLERANCE = parseFloat(args.tolerance ?? "0.02");
const MAX_SPEND = USER_KNOBS.length * 100;
const SPEND_LEVELS = (args.levels ?? `100,200,300,${USER_BUDGET},380,420,460,500,700,900,${MAX_SPEND}`)
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n))
  .map((n) => Math.max(0, Math.min(MAX_SPEND, n)));

type UiVector = number[];

function normalRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function projectToSpend(input: UiVector, targetSpend: number): UiVector {
  const target = Math.max(0, Math.min(MAX_SPEND, targetSpend));
  const out = input.map((v) => Math.max(0, Math.min(100, v)));

  for (let iter = 0; iter < USER_KNOBS.length * 4; iter++) {
    const sum = out.reduce((s, v) => s + v, 0);
    const diff = target - sum;
    if (Math.abs(diff) < 1e-6) break;

    if (diff > 0) {
      const capacity = out.reduce((s, v) => s + Math.max(0, 100 - v), 0);
      if (capacity <= 1e-9) break;
      for (let i = 0; i < out.length; i++) {
        const cap = Math.max(0, 100 - out[i]);
        out[i] += diff * (cap / capacity);
      }
    } else {
      const mass = out.reduce((s, v) => s + Math.max(0, v), 0);
      if (mass <= 1e-9) break;
      for (let i = 0; i < out.length; i++) {
        const removable = Math.max(0, out[i]);
        out[i] += diff * (removable / mass);
      }
    }
  }

  return out.map((v) => Math.max(0, Math.min(100, v)));
}

function randomVector(targetSpend: number): UiVector {
  return projectToSpend(USER_KNOBS.map(() => Math.random() * 100), targetSpend);
}

function vectorToConfig(v: UiVector, targetSpend: number, id: string): BrainConfig {
  const ui = projectToSpend(v, targetSpend);
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const k = USER_KNOBS[i];
    attrs[k] = uiToNative(k, ui[i]);
  }
  attrs.hallucination = computedHallucinationForSpend(budgetSpent({ attributes: attrs }));
  return { id, attributes: attrs };
}

function vectorFromConfig(cfg: BrainConfig): UiVector {
  return USER_KNOBS.map((k) => {
    const v = cfg.attributes[k];
    if (typeof v !== "number") return 0;
    const native = uiToNative(k, 0);
    const max = uiToNative(k, 100);
    return ((v - native) / (max - native)) * 100;
  });
}

function meanOfTop(pop: BrainConfig[], records: ScoreRecord[], targetSpend: number): UiVector {
  const byId = new Map(pop.map((c) => [c.id, c] as const));
  const ranked = records.slice().sort((a, b) => b.winRate - a.winRate);
  const mu = Math.max(1, Math.floor(ranked.length / 2));
  const weights = Array.from({ length: mu }, (_, i) => Math.log((mu + 1) / (i + 1)));
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const mean = new Array(USER_KNOBS.length).fill(0);

  for (let i = 0; i < mu; i++) {
    const cfg = byId.get(ranked[i].id)!;
    const v = vectorFromConfig(cfg);
    const w = weights[i] / weightSum;
    for (let j = 0; j < mean.length; j++) mean[j] += v[j] * w;
  }
  return projectToSpend(mean, targetSpend);
}

function sampleAround(mean: UiVector, sigma: number, targetSpend: number, id: string): BrainConfig {
  const v = mean.map((m) => m + normalRandom() * sigma * 100);
  return vectorToConfig(v, targetSpend, id);
}

async function optimizeSpendLevel(spend: number): Promise<{
  spend: number;
  hallucination: number;
  best: ScoreRecord;
  bestConfig: BrainConfig;
  meanWr: number;
}> {
  const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
  const stages = Object.values(STAGES);
  let mean = projectToSpend(new Array(USER_KNOBS.length).fill(spend / USER_KNOBS.length), spend);
  let sigma = 0.35;
  let best: ScoreRecord | null = null;
  let bestConfig: BrainConfig | null = null;
  let finalMeanWr = 0;

  for (let gen = 0; gen < GENS; gen++) {
    const pop: BrainConfig[] = [];
    if (gen === 0) pop.push(vectorToConfig(mean, spend, `s${spend}-g${gen}-mean`));
    while (pop.length < POP) {
      const cfg = gen === 0
        ? vectorToConfig(randomVector(spend), spend, `s${spend}-g${gen}-r${pop.length}`)
        : sampleAround(mean, sigma, spend, `s${spend}-g${gen}-c${pop.length}`);
      pop.push(cfg);
    }

    process.stderr.write(`\r[budget-test] spend=${spend} gen=${gen + 1}/${GENS} scoring...        `);
    const records = await scoreBatch({
      candidates: pop,
      references: refs,
      stages,
      seedsPerMatchup: SEEDS,
      workers: WORKERS,
    });
    const byId = new Map(pop.map((c) => [c.id, c] as const));
    const ranked = records.slice().sort((a, b) => b.winRate - a.winRate);
    const genBest = ranked[0];
    finalMeanWr = records.reduce((s, r) => s + r.winRate, 0) / records.length;
    if (!best || genBest.winRate > best.winRate) {
      best = genBest;
      bestConfig = byId.get(genBest.id)!;
    }
    mean = meanOfTop(pop, records, spend);
    sigma = Math.max(0.04, sigma * 0.82);
    process.stderr.write(
      `\r[budget-test] spend=${spend} gen=${gen + 1}/${GENS} best=${(genBest.winRate * 100).toFixed(1)}% mean=${(finalMeanWr * 100).toFixed(1)}%\n`,
    );
  }

  return {
    spend,
    hallucination: computedHallucinationForSpend(spend),
    best: best!,
    bestConfig: bestConfig!,
    meanWr: finalMeanWr,
  };
}

console.log(`\n# Fixed-spend budget exploit test\n`);
console.log(`- budget=${USER_BUDGET}; user knobs=${USER_KNOBS.length}; max spend=${MAX_SPEND}`);
console.log(`- spend levels: ${SPEND_LEVELS.join(", ")}`);
console.log(`- optimizer: gens=${GENS}, pop=${POP}, seeds=${SEEDS}, workers=${WORKERS}\n`);
console.log(`| spent | hallucination | best WR | final mean WR | best id |`);
console.log(`|------:|--------------:|--------:|--------------:|:--------|`);

type SpendResult = Awaited<ReturnType<typeof optimizeSpendLevel>>;
const results: SpendResult[] = [];
for (const spend of SPEND_LEVELS) {
  const result = await optimizeSpendLevel(spend);
  results.push(result);
  console.log(
    `| ${String(result.spend).padStart(5)} | ${String(result.hallucination).padStart(13)} | ${(result.best.winRate * 100).toFixed(1).padStart(7)}% | ${(result.meanWr * 100).toFixed(1).padStart(13)}% | ${result.best.id} |`,
  );
}
process.stderr.write("\n");

const inBudget = results.filter((r) => r.spend <= USER_BUDGET).sort((a, b) => b.best.winRate - a.best.winRate)[0];
const overBudget = results.filter((r) => r.spend > USER_BUDGET).sort((a, b) => b.best.winRate - a.best.winRate)[0];

console.log(`\n## Verdict\n`);
console.log(`- Best in-budget: spent=${inBudget.spend}, h=${inBudget.hallucination}, WR=${(inBudget.best.winRate * 100).toFixed(1)}%`);
if (overBudget) {
  const delta = overBudget.best.winRate - inBudget.best.winRate;
  console.log(`- Best over-budget: spent=${overBudget.spend}, h=${overBudget.hallucination}, WR=${(overBudget.best.winRate * 100).toFixed(1)}%`);
  console.log(`- Over-budget delta: ${(delta * 100).toFixed(1)} pp`);
  if (delta < 0) console.log(`- PASS: optimized over-budget candidates did not beat in-budget candidates.`);
  else if (delta <= NOISE_TOLERANCE) console.log(`- MARGINAL: over-budget edge is within tolerance (${(NOISE_TOLERANCE * 100).toFixed(1)} pp). Retest with more seeds/gens.`);
  else console.log(`- FAIL: over-budget exploit survived. Increase hallucination penalty or remove cap.`);
}

console.log(`\n## Raw\n`);
console.log(JSON.stringify(results.map((r) => ({
  spent: r.spend,
  hallucination: r.hallucination,
  bestWr: r.best.winRate,
  meanWr: r.meanWr,
  bestConfig: r.bestConfig,
})), null, 2));
