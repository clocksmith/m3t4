// Refine a single config via CMA-ES anchored at its attribute vector.
// Preserves the strategy's character while tuning attributes toward a
// local optimum against the reference pool.
//
// Usage:
//   node dist/refine.js --config moonshot --gens 10 --pop 16 --out refined/moonshot.json
//   node dist/refine.js --config bot.json --gens 20 --refs @top4

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES, DEFAULT_PARAMS, PARAM_KEYS,
  type BrainConfig, type ParamKey,
} from "@m3t4/sim";
import { cmaInit, cmaSample, cmaTell, cmaIncumbent } from "./cmaes.js";
import { scoreBatch } from "./score.js";

const RANGES: Record<ParamKey, [number, number]> = {
  burnRate: [0, 1], moat: [0, 300], shipRate: [0, 1],
  foresight: [0, 0.25], pivotSpeed: [0, 1], leverage: [-1, 1],
  networking: [0, 1],
  spite: [-1, 1], greed: [0, 1], pacing: [0, 1], cunning: [0, 1],
  hallucination: [0, 100],
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const name = k.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[name] = next; i++; }
      else out[name] = "1";
    }
  }
  return out;
}

function loadConfig(spec: string): BrainConfig {
  if ((STRATEGY_NAMES as readonly string[]).includes(spec)) {
    return STRATEGIES[spec as keyof typeof STRATEGIES];
  }
  if (fs.existsSync(spec)) {
    const raw = JSON.parse(fs.readFileSync(spec, "utf8"));
    if (!raw.id) raw.id = path.basename(spec, path.extname(spec));
    return raw as BrainConfig;
  }
  throw new Error(`unknown config '${spec}'`);
}

function resolveRefs(spec: string): BrainConfig[] {
  if (spec === "@all") return STRATEGY_NAMES.map((n) => STRATEGIES[n]);
  if (spec === "@top4") return ["shipper", "founder", "moonshot", "operator"].map((n) => STRATEGIES[n as keyof typeof STRATEGIES]);
  // Comma-separated list of names or JSON paths
  return spec.split(",").map((s) => loadConfig(s.trim())).filter(Boolean);
}

function normalizeScalar(k: ParamKey, v: number): number {
  const [lo, hi] = RANGES[k];
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}

function configScalarVector(cfg: BrainConfig): number[] {
  // Extract the "scalar flavor" of each attribute for seeding CMA-ES.
  // If it's a trajectory, use its base. If DSL string, use default.
  const out: number[] = new Array(PARAM_KEYS.length);
  for (let i = 0; i < PARAM_KEYS.length; i++) {
    const k = PARAM_KEYS[i];
    const v = cfg.attributes[k];
    let raw: number;
    if (typeof v === "number") raw = v;
    else if (v && typeof v === "object" && "base" in v && typeof v.base === "number") raw = v.base;
    else raw = DEFAULT_PARAMS[k];
    out[i] = normalizeScalar(k, raw);
  }
  return out;
}

const args = parseArgs(process.argv);
const SEED = loadConfig(args.config ?? "moonshot");
const GENS = parseInt(args.gens ?? "10", 10);
const POP = parseInt(args.pop ?? "16", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const SIGMA = parseFloat(args.sigma ?? "0.15");
const OUT = args.out;

// Refs: by default everyone except the seed itself (avoid self-match)
const refsSpec = args.refs ?? "@all";
let refs = resolveRefs(refsSpec).filter((r) => r.id !== SEED.id);
const stages = Object.values(STAGES);

console.error(`Refining ${SEED.id} against ${refs.length} refs, σ=${SIGMA}, ${GENS} gens × ${POP} pop × ${SEEDS} seeds on ${WORKERS} workers`);

// Initial CMA-ES state anchored at the seed's attribute vector
const state = cmaInit({
  initialMean: configScalarVector(SEED),
  initialSigma: SIGMA,
  popSize: POP,
});

interface GenTrace {
  gen: number;
  bestWr: number;
  meanWr: number;
  sigma: number;
  bestId: string;
}
const trace: GenTrace[] = [];

const t0 = Date.now();
for (let g = 0; g < GENS; g++) {
  const population = cmaSample(state, SEED.id);
  const records = await scoreBatch({
    candidates: population, references: refs, stages,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  // Fitness = winRate + small score-diff term
  const fitness = records.map((r) => r.winRate + r.avgScoreDiff * 0.05);
  cmaTell(state, population, fitness);

  const rankedIdx = records.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a]);
  const best = records[rankedIdx[0]];
  const meanWr = records.reduce((s, r) => s + r.winRate, 0) / records.length;
  trace.push({ gen: g + 1, bestWr: best.winRate, meanWr, sigma: state.sigma, bestId: best.id });
  console.error(`  gen ${g + 1}/${GENS}  best=${(best.winRate * 100).toFixed(1)}%  mean=${(meanWr * 100).toFixed(1)}%  σ=${state.sigma.toFixed(3)}`);
}

const incumbent = cmaIncumbent(state, `${SEED.id}-refined`);
// Final scoring of the incumbent (fair number of matches) so we can report
// a trustworthy win-rate
const finalRecords = await scoreBatch({
  candidates: [incumbent], references: refs, stages,
  seedsPerMatchup: SEEDS, workers: WORKERS,
});
const finalWr = finalRecords[0].winRate;
const tookSec = ((Date.now() - t0) / 1000).toFixed(1);
console.error(`\nDone in ${tookSec}s. Refined win-rate: ${(finalWr * 100).toFixed(1)}%`);

console.log("\n## Before vs after\n");
const beforeRecords = await scoreBatch({
  candidates: [SEED], references: refs, stages,
  seedsPerMatchup: SEEDS, workers: WORKERS,
});
const beforeWr = beforeRecords[0].winRate;
console.log(`  ${SEED.id.padEnd(28)}  before ${(beforeWr * 100).toFixed(1)}%  after ${(finalWr * 100).toFixed(1)}%  Δ ${((finalWr - beforeWr) * 100).toFixed(1)}%`);

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(incumbent, null, 2));
  console.error(`Wrote ${OUT}`);
}

if (args.traceOut) {
  fs.writeFileSync(args.traceOut, JSON.stringify({
    seed: SEED.id, sigma: SIGMA, gens: GENS, pop: POP, seeds: SEEDS,
    beforeWr, afterWr: finalWr, trace,
  }, null, 2));
}
