import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  USER_KNOBS, nativeToUI,
  REPLAY_CONSTANTS_HASH,
  type BrainConfig, type Stage,
} from "@m3t4/sim";
import { execSync } from "node:child_process";
import { featureVector } from "./novelty.js";
import { runMatches, type MatchSpec } from "./parallel.js";
import {
  sampleCandidate, sampleInitialPopulation,
  type SampledCandidate, type SourceKind,
} from "./simplex-sample.js";
import { budgetTransfer } from "./budget-transfer.js";


export interface TransferabilityEntry {
  rosterId: string;
  wr: number;
}

export interface BudgetPressure {
  top3UiSum: number;
  top5UiSum: number;
  spent: number;
}

export const ATTACKER_VERSION = "1";

export interface SeedCounterDistance {
  attributeDistance: number;
  budgetShareJS: number;
  signatureDistance: number;
}

export interface AttackResult {
  baselineCommit: string;
  measurementCommit: string;
  attackerVersion: string;
  simConstantsHash: string;

  targetId: string;
  targetHash: string;
  counter: BrainConfig;
  searchWr: number;
  validatedWr: number;
  validationMatches: number;
  searchBudget: number;
  validationBudget: number;
  searchMethod: "budget-transfer-hillclimb";

  transferabilityVector: TransferabilityEntry[];
  transferabilityMean: number;
  fragilityDelta: number;
  fragilitySamples: number;
  budgetPressure: BudgetPressure;

  seedCounterDistance?: SeedCounterDistance;

  discoveredAt: string;
}

export interface AttackConfig {
  evalBudget?: number;
  populationSize?: number;
  workers?: number;
  seedCheap?: number;
  seedValidate?: number;
  stages?: Stage[];
  baselineCommit?: string;
  measurementCommit?: string;
  seedCounter?: BrainConfig;
}


function hashAttributes(cfg: BrainConfig): string {
  const keys = Object.keys(cfg.attributes).sort();
  const json = keys.map((k) => `${k}:${cfg.attributes[k as never]}`).join("|");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function uiVector(cfg: BrainConfig): number[] {
  return USER_KNOBS.map((k) => {
    const v = cfg.attributes[k];
    if (typeof v !== "number") return 0;
    return Math.round(nativeToUI(k, v));
  });
}

function computeBudgetPressure(counter: BrainConfig): BudgetPressure {
  const ui = uiVector(counter);
  const sorted = ui.slice().sort((a, b) => b - a);
  return {
    top3UiSum: sorted[0] + sorted[1] + sorted[2],
    top5UiSum: sorted[0] + sorted[1] + sorted[2] + sorted[3] + sorted[4],
    spent: ui.reduce((s, v) => s + v, 0),
  };
}

function attributeDistance(a: BrainConfig, b: BrainConfig): number {
  const va = featureVector(a); const vb = featureVector(b);
  let s = 0;
  for (let i = 0; i < va.length; i++) { const d = va[i] - vb[i]; s += d * d; }
  return Math.sqrt(s);
}

function budgetShareJS(a: BrainConfig, b: BrainConfig): number {
  const uA = uiVector(a), uB = uiVector(b);
  const sA = uA.reduce((s, v) => s + v, 0) || 1;
  const sB = uB.reduce((s, v) => s + v, 0) || 1;
  const p = uA.map((v) => v / sA);
  const q = uB.map((v) => v / sB);
  const m = p.map((pi, i) => (pi + q[i]) / 2);
  let klPM = 0, klQM = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0 && m[i] > 0) klPM += p[i] * Math.log2(p[i] / m[i]);
    if (q[i] > 0 && m[i] > 0) klQM += q[i] * Math.log2(q[i] / m[i]);
  }
  return 0.5 * klPM + 0.5 * klQM;
}

function signatureDistance(
  a: TransferabilityEntry[], b: TransferabilityEntry[],
): number {
  const mapA = new Map(a.map((e) => [e.rosterId, e.wr]));
  const mapB = new Map(b.map((e) => [e.rosterId, e.wr]));
  let sum = 0; let n = 0;
  for (const [id, aWr] of mapA) {
    const bWr = mapB.get(id);
    if (bWr === undefined) continue;
    const d = aWr - bWr;
    sum += d * d;
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : Infinity;
}

function currentGitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitWorktreeDirty(): boolean {
  try {
    return execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
  } catch {
    return true;
  }
}


function diverseStarts(
  count: number,
  hofPool: BrainConfig[],
  generation = 0,
  seedCounter?: BrainConfig,
): SampledCandidate[] {
  const out: SampledCandidate[] = [];

  if (seedCounter) {
    const seedBase: SampledCandidate = {
      config: { id: `seed-${seedCounter.id}-0`, attributes: { ...seedCounter.attributes } },
      meta: {
        configHash: hashAttributes(seedCounter), uiSpendVector: uiVector(seedCounter),
        budgetShareVector: [], spent: uiVector(seedCounter).reduce((s, v) => s + v, 0),
        axisExtremes: [], sourceKind: "hof_elite",
        parentIds: null, mutationKind: null, generation,
      },
    };
    out.push(seedBase);
    for (let i = 0; i < 3 && out.length < count; i++) {
      const mutated = budgetTransfer(seedBase, { multiTransfers: 1 }, Math.random, `seed-${seedCounter.id}-v${i}`, generation);
      out.push(mutated);
    }
  }

  const fromHof = Math.floor(count * 0.4);
  for (let i = 0; i < fromHof && i < hofPool.length && out.length < count; i++) {
    const pick = hofPool[i % hofPool.length];
    out.push({
      config: { id: `attack-start-hof-${i}`, attributes: { ...pick.attributes } },
      meta: {
        configHash: hashAttributes(pick), uiSpendVector: uiVector(pick),
        budgetShareVector: [], spent: uiVector(pick).reduce((s, v) => s + v, 0),
        axisExtremes: [], sourceKind: "hof_elite",
        parentIds: null, mutationKind: null, generation,
      },
    });
  }

  const rest = count - out.length;
  const anchors = sampleInitialPopulation(Math.floor(rest * 0.6), generation);
  for (const a of anchors.slice(0, Math.floor(rest * 0.6))) out.push(a);

  const kinds: SourceKind[] = ["dirichlet_sparse", "dirichlet_balanced", "dirichlet_dense"];
  while (out.length < count) {
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    out.push(sampleCandidate({
      id: `attack-start-${kind}-${out.length}`,
      sourceKind: kind, generation, rng: Math.random,
    }));
  }

  return out.slice(0, count);
}


async function scoreCandidatesVsTarget(
  candidates: BrainConfig[],
  target: BrainConfig,
  seedsPerMatchup: number,
  stages: Stage[],
  workers: number,
): Promise<number[]> {
  const specs: MatchSpec[] = [];
  candidates.forEach((c, ci) => {
    if (c.id === target.id) return;
    for (const stage of stages) {
      for (let s = 0; s < seedsPerMatchup; s++) {
        const seed = ((s * 101 + stage.id.length * 37 + ci * 13) | 0) >>> 0;
        specs.push({ a: c, b: target, stageId: stage.id as MatchSpec["stageId"], seed, meta: { ci, side: 0 } });
        specs.push({ a: target, b: c, stageId: stage.id as MatchSpec["stageId"], seed, meta: { ci, side: 1 } });
      }
    }
  });
  const outcomes = await runMatches(specs, { workers });
  const wins = new Array(candidates.length).fill(0);
  const played = new Array(candidates.length).fill(0);
  for (const o of outcomes) {
    const m = o.spec.meta as { ci: number; side: 0 | 1 };
    played[m.ci]++;
    if (o.winner === m.side) wins[m.ci]++;
    else if (o.winner === -1) wins[m.ci] += 0.5;
  }
  return wins.map((w, i) => played[i] > 0 ? w / played[i] : 0.5);
}


export async function attack(
  target: BrainConfig,
  hofPool: BrainConfig[],
  config: AttackConfig = {},
): Promise<{ counter: BrainConfig; searchWr: number; evalsUsed: number }> {
  const evalBudget = config.evalBudget ?? 2000;
  const popSize = config.populationSize ?? 20;
  const workers = config.workers ?? os.cpus().length;
  const stages = config.stages ?? Object.values(STAGES);
  const seedCheap = config.seedCheap ?? 1;

  let population = diverseStarts(popSize, hofPool, 0, config.seedCounter);
  let scores = await scoreCandidatesVsTarget(
    population.map((p) => p.config), target, seedCheap, stages, workers,
  );
  let evalsUsed = popSize;
  let best = {
    config: population[argmax(scores)].config,
    meta: population[argmax(scores)].meta,
    wr: Math.max(...scores),
  };

  const gensMax = Math.floor((evalBudget - popSize) / popSize);
  for (let g = 0; g < gensMax; g++) {
    const children = population.map((p, i) => {
      const multi = Math.random() < 0.25 ? 3 : 1;
      return budgetTransfer(p, { multiTransfers: multi }, Math.random, `atk-g${g}-${i}`, g);
    });
    const childScores = await scoreCandidatesVsTarget(
      children.map((c) => c.config), target, seedCheap, stages, workers,
    );
    evalsUsed += popSize;

    const combined = [
      ...population.map((p, i) => ({ cand: p, wr: scores[i] })),
      ...children.map((c, i) => ({ cand: c, wr: childScores[i] })),
    ].sort((a, b) => b.wr - a.wr);
    population = combined.slice(0, popSize).map((x) => x.cand);
    scores = combined.slice(0, popSize).map((x) => x.wr);

    if (scores[0] > best.wr) {
      best = { config: population[0].config, meta: population[0].meta, wr: scores[0] };
    }
  }

  return { counter: best.config, searchWr: best.wr, evalsUsed };
}

function argmax(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}


async function validateCounter(
  counter: BrainConfig,
  target: BrainConfig,
  seeds: number,
  stages: Stage[],
  workers: number,
): Promise<{ wr: number; matches: number }> {
  const scores = await scoreCandidatesVsTarget([counter], target, seeds, stages, workers);
  const matches = seeds * stages.length * 2;
  return { wr: scores[0], matches };
}

async function computeTransferability(
  counter: BrainConfig,
  roster: BrainConfig[],
  targetId: string,
  seeds: number,
  stages: Stage[],
  workers: number,
): Promise<{ vector: TransferabilityEntry[]; mean: number }> {
  const vector: TransferabilityEntry[] = [];
  for (const r of roster) {
    if (r.id === targetId || r.id === counter.id) continue;
    const scores = await scoreCandidatesVsTarget([counter], r, seeds, stages, workers);
    vector.push({ rosterId: r.id, wr: scores[0] });
  }
  const mean = vector.length ? vector.reduce((s, x) => s + x.wr, 0) / vector.length : 0;
  return { vector, mean };
}

async function computeFragility(
  counter: BrainConfig,
  counterMeta: SampledCandidate["meta"],
  target: BrainConfig,
  samples: number,
  seeds: number,
  stages: Stage[],
  workers: number,
  counterValidatedWr: number,
): Promise<number> {
  const mutants: BrainConfig[] = [];
  for (let i = 0; i < samples; i++) {
    const m = budgetTransfer(
      { config: counter, meta: counterMeta },
      { deltas: [3, 5], multiTransfers: 1 },
      Math.random, `frag-${i}`, 0,
    );
    mutants.push(m.config);
  }
  const scores = await scoreCandidatesVsTarget(mutants, target, seeds, stages, workers);
  const meanMutantWr = scores.reduce((s, x) => s + x, 0) / scores.length;
  return counterValidatedWr - meanMutantWr;
}


export async function attackTarget(
  target: BrainConfig,
  roster: BrainConfig[],
  hofPool: BrainConfig[],
  config: AttackConfig = {},
  seedCounterSignature?: TransferabilityEntry[],
): Promise<AttackResult> {
  const stages = config.stages ?? Object.values(STAGES);
  const workers = config.workers ?? os.cpus().length;
  const seedValidate = config.seedValidate ?? 5;
  const measurementCommit = config.measurementCommit ?? currentGitCommit();
  const baselineCommit = config.baselineCommit ?? measurementCommit;

  const searchResult = await attack(target, hofPool, config);

  const counterMeta: SampledCandidate["meta"] = {
    configHash: hashAttributes(searchResult.counter),
    uiSpendVector: uiVector(searchResult.counter),
    budgetShareVector: [],
    spent: uiVector(searchResult.counter).reduce((s, v) => s + v, 0),
    axisExtremes: [],
    sourceKind: "budget_transfer_mutation",
    parentIds: null, mutationKind: "transfer", generation: 0,
  };

  const { wr: validatedWr, matches: validationMatches } = await validateCounter(
    searchResult.counter, target, seedValidate, stages, workers,
  );

  const { vector, mean } = await computeTransferability(
    searchResult.counter, roster, target.id, seedValidate, stages, workers,
  );

  const fragilityDelta = await computeFragility(
    searchResult.counter, counterMeta, target, 8, seedValidate, stages, workers, validatedWr,
  );

  const budgetPressure = computeBudgetPressure(searchResult.counter);

  let seedCounterDistance: SeedCounterDistance | undefined;
  if (config.seedCounter) {
    const attr = attributeDistance(searchResult.counter, config.seedCounter);
    const js = budgetShareJS(searchResult.counter, config.seedCounter);
    const sig = seedCounterSignature
      ? signatureDistance(vector, seedCounterSignature)
      : Infinity;
    seedCounterDistance = {
      attributeDistance: attr,
      budgetShareJS: js,
      signatureDistance: sig,
    };
  }

  const validationBudget = seedValidate * stages.length * 2;

  return {
    baselineCommit,
    measurementCommit,
    attackerVersion: ATTACKER_VERSION,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    targetId: target.id,
    targetHash: hashAttributes(target),
    counter: searchResult.counter,
    searchWr: searchResult.searchWr,
    validatedWr,
    validationMatches,
    searchBudget: searchResult.evalsUsed,
    validationBudget,
    searchMethod: "budget-transfer-hillclimb",
    transferabilityVector: vector,
    transferabilityMean: mean,
    fragilityDelta,
    fragilitySamples: 8,
    budgetPressure,
    seedCounterDistance,
    discoveredAt: new Date().toISOString(),
  };
}


export function archivePath(outDir: string, targetHash: string): string {
  return path.resolve(outDir, `by-target/${targetHash}.json`);
}

export function readArchive(outDir: string, targetHash: string): AttackResult[] {
  const p = archivePath(outDir, targetHash);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
}

export function appendArchive(outDir: string, targetHash: string, newResult: AttackResult): AttackResult[] {
  const existing = readArchive(outDir, targetHash);
  existing.push(newResult);
  const p = archivePath(outDir, targetHash);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(existing, null, 2));
  return existing;
}

export function pruneArchive(archive: AttackResult[], currentRosterIds: Set<string>): AttackResult[] {
  return archive.filter((r) => {
    if (!currentRosterIds.has(r.targetId)) return false;
    return r.transferabilityVector.some((t) => t.wr > 0.55) || r.validatedWr > 0.55;
  });
}


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

  const measurementCommit = currentGitCommit();
  const baselineCommit = args["baseline-commit"] ?? measurementCommit;
  const allowDirty = args["allow-dirty"] === "1";
  const dirty = gitWorktreeDirty();
  if (dirty && !allowDirty) {
    console.error(
      `Refusing to start attack from a dirty worktree at measurementCommit=${measurementCommit}.\n` +
      `Commit/stash unrelated changes, or pass --allow-dirty for exploratory runs.`
    );
    process.exit(2);
  }
  if (dirty) {
    console.error(`WARNING: attack is running from a dirty worktree at measurementCommit=${measurementCommit}`);
  }
  const targetsArg = args.targets ?? "current";
  const evalBudget = parseInt(args.budget ?? "10000", 10);
  const starts = parseInt(args.starts ?? "20", 10);
  const neighbors = parseInt(args.neighbors ?? String(starts), 10);
  const validationSeeds = parseInt(args["validation-seeds"] ?? "5", 10);
  const outDir = args.out ?? "pareto/exploits/v5a";
  const bankPath = args.bank;
  const seedCounterPath = args["seed-counter"];

  const roster = STRATEGY_NAMES.map((n) => STRATEGIES[n as keyof typeof STRATEGIES]);
  const hofPool: BrainConfig[] = bankPath && fs.existsSync(bankPath)
    ? (JSON.parse(fs.readFileSync(bankPath, "utf8")).hof ?? [])
        .map((h: { id: string; attributes: BrainConfig["attributes"] }) =>
          ({ id: h.id, attributes: h.attributes } as BrainConfig))
    : [];

  const targets = targetsArg === "current" || targetsArg === "all"
    ? roster
    : targetsArg.split(",").map((id) => id.trim()).map((id) => {
        const r = roster.find((x) => x.id === id);
        if (!r) throw new Error(`unknown target: ${id}`);
        return r;
      });

  let seedCounter: BrainConfig | undefined;
  let seedCounterSignature: TransferabilityEntry[] | undefined;
  if (seedCounterPath && fs.existsSync(seedCounterPath)) {
    const raw = JSON.parse(fs.readFileSync(seedCounterPath, "utf8"));
    const seedCfg: BrainConfig = raw.bestEver?.config ?? raw.config ?? raw;
    seedCounter = { id: seedCfg.id ?? "seed-counter", attributes: { ...seedCfg.attributes } };
    console.error(`Seed-counter loaded: ${seedCounter.id} (from ${seedCounterPath})`);
    console.error(`Computing seed-counter signature vs roster (one-time cost)...`);
    const sig = await computeTransferability(
      seedCounter, roster, "__seed_excl__", validationSeeds, Object.values(STAGES),
      parseInt(args.workers ?? `${os.cpus().length}`, 10),
    );
    seedCounterSignature = sig.vector;
  }

  console.error(`\nAttacking ${targets.length} target(s). budget=${evalBudget}/target ` +
    `starts=${starts} neighbors=${neighbors} validation=${validationSeeds}seeds ` +
    `out=${outDir} seedCounter=${seedCounter?.id ?? "none"} ` +
    `baselineCommit=${baselineCommit} measurementCommit=${measurementCommit}`);

  for (const target of targets) {
    console.error(`\n[attack] ${target.id}`);
    const result = await attackTarget(target, roster, hofPool, {
      evalBudget,
      populationSize: neighbors,
      seedValidate: validationSeeds,
      seedCounter,
      baselineCommit,
      measurementCommit,
    }, seedCounterSignature);
    const d = result.seedCounterDistance;
    console.log(`target=${result.targetId} validatedWr=${(result.validatedWr * 100).toFixed(1)}% ` +
      `transferMean=${(result.transferabilityMean * 100).toFixed(1)}% ` +
      `fragilityDelta=${(result.fragilityDelta * 100).toFixed(1)}% ` +
      `top3=${result.budgetPressure.top3UiSum} top5=${result.budgetPressure.top5UiSum} ` +
      `spent=${result.budgetPressure.spent}` +
      (d ? ` | seedDist attr=${d.attributeDistance.toFixed(2)} js=${d.budgetShareJS.toFixed(2)} sig=${d.signatureDistance.toFixed(2)}` : ""));
    appendArchive(outDir, result.targetHash, result);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
