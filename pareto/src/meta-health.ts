// Meta-health report — does the combined meta (presets + known exploits +
// HOF samples + random legal configs) form an interesting playable pool,
// or does one config/family dominate?
//
// Purpose: gate the "custom-bot beta" product release. The old release
// bar was "no config beats the 16 presets." That bar doesn't apply if
// players are expected to build better-than-preset bots. The new bar is:
//
//   - No single config wins >X% of the combined pool.
//   - Matches produce interaction (kills, deliveries), not stalemates.
//   - Multiple archetype families share the top; no one family dominates.
//   - Counter-graph has enough cycles to reward build switching.
//
// Usage:
//   node pareto/dist/meta-health.js \
//     --presets current \
//     --exploits pareto/exploits/v8-brain-v3 pareto/exploits/v7-brain-v3 \
//     --hof /tmp/new-roster-v8.hof.json --hof-top 20 \
//     --random 10 --seeds 5 --workers 8 \
//     --out /tmp/meta-health-v8.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ROUND_TIMER_MAX_TICKS, ROUNDS_TO_WIN_MATCH,
  STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig,
} from "@m3t4/sim";
import { runMatches, type MatchOutcome, type MatchSpec } from "./parallel.js";
import { sampleCandidate, type SourceKind } from "./simplex-sample.js";

// ---------------------------- CLI ----------------------------

function parseArgs(argv: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const name = k.slice(2);
    const vals: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      vals.push(argv[i + 1]);
      i++;
    }
    out[name] = vals.length === 1 ? vals[0] : vals;
  }
  return out;
}

const args = parseArgs(process.argv);
const SEEDS = parseInt((args.seeds as string) ?? "3", 10);
const WORKERS = parseInt((args.workers as string) ?? `${os.cpus().length}`, 10);
const HOF_TOP = parseInt((args["hof-top"] as string) ?? "20", 10);
const RANDOM_N = parseInt((args.random as string) ?? "10", 10);
const OUT = (args.out as string) ?? "/tmp/meta-health.json";

// ---------------------------- helpers ----------------------------

interface PooledConfig {
  cfg: BrainConfig;
  family: "preset" | "exploit" | "hof" | "random";
}

function loadExploitsFromDir(dir: string): PooledConfig[] {
  const out: PooledConfig[] = [];
  const btDir = path.join(dir, "by-target");
  if (!fs.existsSync(btDir)) return out;
  for (const f of fs.readdirSync(btDir)) {
    if (!f.endsWith(".json")) continue;
    const recs = JSON.parse(fs.readFileSync(path.join(btDir, f), "utf8"));
    const arr = Array.isArray(recs) ? recs : [recs];
    for (const r of arr) {
      const c = r?.counter;
      if (!c?.attributes) continue;
      out.push({
        cfg: { id: `exploit-${r.targetId}-${path.basename(dir)}`, attributes: c.attributes },
        family: "exploit",
      });
    }
  }
  return out;
}

function loadHofSample(p: string, top: number): PooledConfig[] {
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const hof: Array<{ cfg: BrainConfig; wr?: number }> = Array.isArray(data)
    ? data
    : Array.isArray((data as any).hof)
      ? (data as any).hof
      : [];
  const sorted = hof.slice().sort((a, b) => (b.wr ?? 0) - (a.wr ?? 0));
  return sorted.slice(0, top).map((h, i) => ({
    cfg: { id: h.cfg?.id ?? `hof-${i}`, attributes: h.cfg?.attributes ?? {} } as BrainConfig,
    family: "hof" as const,
  }));
}

function generateRandomSamples(n: number): PooledConfig[] {
  const out: PooledConfig[] = [];
  const kinds: SourceKind[] = ["dirichlet_sparse", "dirichlet_balanced", "dirichlet_dense"];
  for (let i = 0; i < n; i++) {
    const s = sampleCandidate({
      id: `rand-${i}`,
      sourceKind: kinds[i % kinds.length],
      generation: 0,
    });
    out.push({ cfg: s.config, family: "random" });
  }
  return out;
}

// ---------------------------- assemble pool ----------------------------

const presetsArg = (args.presets as string) ?? "current";
const presetConfigs: PooledConfig[] = presetsArg === "current"
  ? STRATEGY_NAMES.map((n) => ({ cfg: STRATEGIES[n] as BrainConfig, family: "preset" as const }))
  : [];

const exploitDirs: string[] = Array.isArray(args.exploits)
  ? args.exploits as string[]
  : typeof args.exploits === "string"
    ? [args.exploits as string]
    : [];
const exploitConfigs = exploitDirs.flatMap(loadExploitsFromDir);

const hofArg = (args.hof as string) ?? "";
const hofConfigs = hofArg ? loadHofSample(hofArg, HOF_TOP) : [];

const randomConfigs = generateRandomSamples(RANDOM_N);

// Dedupe by id (first wins).
const pool: PooledConfig[] = [];
const seen = new Set<string>();
for (const p of [...presetConfigs, ...exploitConfigs, ...hofConfigs, ...randomConfigs]) {
  if (!seen.has(p.cfg.id)) {
    pool.push(p);
    seen.add(p.cfg.id);
  }
}

console.error(`[meta-health] pool composition:`);
const counts = pool.reduce<Record<string, number>>((acc, p) => {
  acc[p.family] = (acc[p.family] ?? 0) + 1; return acc;
}, {});
for (const [fam, n] of Object.entries(counts)) console.error(`  ${fam}: ${n}`);
console.error(`  total: ${pool.length}\n`);

// ---------------------------- build match specs ----------------------------

const stages = Object.values(STAGES);
const specs: MatchSpec[] = [];
let pairIdx = 0;
for (let i = 0; i < pool.length; i++) {
  for (let j = i + 1; j < pool.length; j++) {
    for (const stage of stages) {
      for (let s = 0; s < SEEDS; s++) {
        const seed = ((s * 101 + stage.id.length * 37 + pairIdx * 13) | 0) >>> 0;
        specs.push({
          a: pool[i].cfg, b: pool[j].cfg,
          stageId: stage.id as MatchSpec["stageId"],
          seed,
          meta: { i, j },
        });
        pairIdx++;
      }
    }
  }
}
console.error(`[meta-health] ${specs.length} matches × ${WORKERS} workers...\n`);

const outcomes = await runMatches(specs, { workers: WORKERS });

// ---------------------------- aggregate ----------------------------

const MAX_TICKS = ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;
const TIMEOUT_THRESHOLD = Math.floor(MAX_TICKS * 0.95);

interface PerConfigStats {
  id: string;
  family: string;
  wins: number; losses: number; draws: number;
  matches: number;
  winRate: number;
  avgTicks: number;
  avgScoreDiff: number;
  wonByKO: number; wonByTimeout: number;
}
const stats: PerConfigStats[] = pool.map((p) => ({
  id: p.cfg.id, family: p.family,
  wins: 0, losses: 0, draws: 0, matches: 0, winRate: 0,
  avgTicks: 0, avgScoreDiff: 0, wonByKO: 0, wonByTimeout: 0,
}));

let totalDraws = 0, totalTimeouts = 0, totalMatches = 0;
let totalTicks = 0, totalFinalScore = 0;

for (const o of outcomes) {
  const m = o.spec.meta as { i: number; j: number };
  const si = stats[m.i], sj = stats[m.j];
  si.matches++; sj.matches++;
  si.avgTicks += o.ticks; sj.avgTicks += o.ticks;
  si.avgScoreDiff += (o.finalScore[0] - o.finalScore[1]);
  sj.avgScoreDiff += (o.finalScore[1] - o.finalScore[0]);
  totalTicks += o.ticks;
  totalFinalScore += o.finalScore[0] + o.finalScore[1];
  totalMatches++;

  const timeout = o.ticks >= TIMEOUT_THRESHOLD;
  if (timeout) totalTimeouts++;

  if (o.winner === 0) {
    si.wins++; sj.losses++;
    if (timeout) si.wonByTimeout++; else si.wonByKO++;
  } else if (o.winner === 1) {
    sj.wins++; si.losses++;
    if (timeout) sj.wonByTimeout++; else sj.wonByKO++;
  } else {
    si.draws++; sj.draws++;
    totalDraws++;
  }
}

for (const s of stats) {
  s.winRate = s.matches > 0 ? s.wins / s.matches : 0;
  s.avgTicks = s.matches > 0 ? s.avgTicks / s.matches : 0;
  s.avgScoreDiff = s.matches > 0 ? s.avgScoreDiff / s.matches : 0;
}

// ---------------------------- counter graph / cycles ----------------------------

// Build pairwise WR matrix, then count 3-cycles A→B→C→A where each edge WR > 0.55.
const n = pool.length;
const pairWins = Array.from({ length: n }, () => new Array<number>(n).fill(0));
const pairPlayed = Array.from({ length: n }, () => new Array<number>(n).fill(0));
for (const o of outcomes) {
  const m = o.spec.meta as { i: number; j: number };
  pairPlayed[m.i][m.j]++; pairPlayed[m.j][m.i]++;
  if (o.winner === 0) pairWins[m.i][m.j]++;
  else if (o.winner === 1) pairWins[m.j][m.i]++;
  else { pairWins[m.i][m.j] += 0.5; pairWins[m.j][m.i] += 0.5; }
}
const pairWr = Array.from({ length: n }, (_, i) =>
  Array.from({ length: n }, (_, j) => pairPlayed[i][j] > 0 ? pairWins[i][j] / pairPlayed[i][j] : 0));

let cycles = 0;
for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
  if (a === b || b === c || a === c) continue;
  if (pairWr[a][b] > 0.55 && pairWr[b][c] > 0.55 && pairWr[c][a] > 0.55) cycles++;
}

// ---------------------------- aggregate signals ----------------------------

const drawRate = totalMatches > 0 ? totalDraws / totalMatches : 0;
const timeoutRate = totalMatches > 0 ? totalTimeouts / totalMatches : 0;
const avgTicks = totalMatches > 0 ? totalTicks / totalMatches : 0;
const avgScore = totalMatches > 0 ? totalFinalScore / totalMatches : 0;

const sortedByWr = stats.slice().sort((a, b) => b.winRate - a.winRate);
const top10 = sortedByWr.slice(0, Math.min(10, sortedByWr.length));
const familyShareTop10 = top10.reduce<Record<string, number>>((acc, s) => {
  acc[s.family] = (acc[s.family] ?? 0) + 1; return acc;
}, {});
const maxFamilyTop10 = Math.max(...Object.values(familyShareTop10));
const famDomPctTop10 = top10.length > 0 ? maxFamilyTop10 / top10.length : 0;
const maxWr = sortedByWr[0]?.winRate ?? 0;

// ---------------------------- thresholds ----------------------------

const thresholds = {
  maxWrHealthy: 0.70, maxWrCaution: 0.80,
  drawRateHealthy: 0.15, drawRateCaution: 0.25,
  ticksCapRatioHealthy: 0.60, ticksCapRatioCaution: 0.75,
  familyShareHealthy: 0.40, familyShareCaution: 0.70,
  cyclesHealthy: 16, cyclesCaution: 5,
};
const ticksCapRatio = avgTicks / MAX_TICKS;

function classify(value: number, healthy: number, caution: number, higherIsBetter: boolean): "healthy" | "caution" | "bad" {
  if (higherIsBetter) {
    if (value >= healthy) return "healthy";
    if (value > caution) return "caution";
    return "bad";
  }
  if (value < healthy) return "healthy";
  if (value <= caution) return "caution";
  return "bad";
}

const verdict = {
  maxWr: classify(maxWr, thresholds.maxWrHealthy, thresholds.maxWrCaution, false),
  drawRate: classify(drawRate, thresholds.drawRateHealthy, thresholds.drawRateCaution, false),
  ticksCapRatio: classify(ticksCapRatio, thresholds.ticksCapRatioHealthy, thresholds.ticksCapRatioCaution, false),
  familyDominance: classify(famDomPctTop10, thresholds.familyShareHealthy, thresholds.familyShareCaution, false),
  cycles: classify(cycles, thresholds.cyclesHealthy, thresholds.cyclesCaution, true),
};

// ---------------------------- output ----------------------------

const report = {
  generatedAt: new Date().toISOString(),
  poolComposition: counts,
  totalMatches,
  totalConfigs: pool.length,
  aggregates: {
    maxWr, drawRate, timeoutRate, avgTicks, ticksCapRatio,
    avgScore, cycles,
    familyShareTop10, famDomPctTop10,
  },
  thresholds, verdict,
  top10: top10.map((s) => ({ id: s.id, family: s.family, winRate: s.winRate, matches: s.matches })),
  perConfig: stats,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.error(`[meta-health] wrote ${OUT}\n`);

// Pretty print to stdout.
console.log(`# Meta-health report\n`);
console.log(`Pool: ${pool.length} configs, ${totalMatches} matches`);
console.log(`  ${Object.entries(counts).map(([f, n]) => `${f}:${n}`).join("  ")}\n`);
console.log(`## Aggregate signals\n`);
console.log(`| metric | value | verdict |`);
console.log(`|---|---|---|`);
console.log(`| max single-config WR | ${(maxWr * 100).toFixed(1)}% | ${verdict.maxWr} |`);
console.log(`| draw rate | ${(drawRate * 100).toFixed(1)}% | ${verdict.drawRate} |`);
console.log(`| avg ticks / cap | ${(ticksCapRatio * 100).toFixed(1)}% | ${verdict.ticksCapRatio} |`);
console.log(`| family dominance in top-10 | ${(famDomPctTop10 * 100).toFixed(0)}% | ${verdict.familyDominance} |`);
console.log(`| counter cycles | ${cycles} | ${verdict.cycles} |`);
console.log(`| avg score | ${avgScore.toFixed(2)} | (informational) |`);
console.log(`| timeout rate | ${(timeoutRate * 100).toFixed(1)}% | (informational) |`);

console.log(`\n## Top 10 by WR\n`);
console.log(`| rank | id | family | WR | matches |`);
console.log(`|---|---|---|---|---|`);
top10.forEach((s, r) => console.log(`| ${r + 1} | ${s.id} | ${s.family} | ${(s.winRate * 100).toFixed(1)}% | ${s.matches} |`));

const anyBad = Object.values(verdict).includes("bad");
const anyCaution = Object.values(verdict).includes("caution");
console.log(`\n## Overall: ${anyBad ? "BLOCK release (bad signal)" : anyCaution ? "CAUTION — ship beta with monitoring" : "HEALTHY — clear to ship"}\n`);
