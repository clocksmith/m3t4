// trace-stalls — classify timeout/draw-heavy matches by mode telemetry.
//
// Purpose (brain v4.0 diagnostic):
//   Meta-health showed v8 fails on stall/boringness: 61% timeout rate,
//   28% draw rate, avg ticks 84% of cap. But we don't yet know WHAT
//   behavior consumes the time — is it ZONE mirrors? ESCAPE spirals?
//   OBJECTIVE loops? Low-commit neutral dancing?
//
//   This tool runs a combined pool (presets + exploits + HOF + random)
//   through match-level telemetry, filters to long/draw matches, and
//   classifies each stall by dominant mode pattern. Output feeds the
//   v4.1 anti-stall patch decision.
//
// Usage:
//   node pareto/dist/trace-stalls.js \
//     --presets current \
//     --exploits pareto/exploits/v8-brain-v3 pareto/exploits/v7-brain-v3 \
//     --hof /tmp/new-roster-v8.hof.json --hof-top 20 \
//     --random 10 --seeds 3 --workers 8 \
//     --stage datacenter \
//     --top-long 20 --top-draw 20 \
//     --out /tmp/trace-stalls-v8.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ROUND_TIMER_MAX_TICKS, ROUNDS_TO_WIN_MATCH,
  STAGES, STRATEGIES, STRATEGY_NAMES,
  simulate, type BrainConfig, type FighterTelemetry,
} from "@m3t4/sim";
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
const TOP_LONG = parseInt((args["top-long"] as string) ?? "20", 10);
const TOP_DRAW = parseInt((args["top-draw"] as string) ?? "20", 10);
const OUT = (args.out as string) ?? "/tmp/trace-stalls.json";
const STAGE_FILTER = stringList(args.stage);

const MAX_TICKS = ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;
const LONG_THRESHOLD_TICKS = Math.floor(MAX_TICKS * 0.9);

function stringList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------- pool assembly (same as meta-health) ----------------------------

interface PooledConfig { cfg: BrainConfig; family: "preset" | "exploit" | "hof" | "random"; }

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
    : Array.isArray((data as any).hof) ? (data as any).hof : [];
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
    const s = sampleCandidate({ id: `rand-${i}`, sourceKind: kinds[i % kinds.length], generation: 0 });
    out.push({ cfg: s.config, family: "random" });
  }
  return out;
}

const presetsArg = (args.presets as string) ?? "current";
const presetConfigs: PooledConfig[] = presetsArg === "current"
  ? STRATEGY_NAMES.map((n) => ({ cfg: STRATEGIES[n] as BrainConfig, family: "preset" as const }))
  : [];
const exploitDirs: string[] = Array.isArray(args.exploits) ? args.exploits as string[]
  : typeof args.exploits === "string" ? [args.exploits as string] : [];
const exploitConfigs = exploitDirs.flatMap(loadExploitsFromDir);
const hofArg = (args.hof as string) ?? "";
const hofConfigs = hofArg ? loadHofSample(hofArg, HOF_TOP) : [];
const randomConfigs = generateRandomSamples(RANDOM_N);

const pool: PooledConfig[] = [];
const seen = new Set<string>();
for (const p of [...presetConfigs, ...exploitConfigs, ...hofConfigs, ...randomConfigs]) {
  if (!seen.has(p.cfg.id)) { pool.push(p); seen.add(p.cfg.id); }
}

console.error(`[trace-stalls] pool: ${pool.length} configs`);
const counts = pool.reduce<Record<string, number>>((acc, p) => { acc[p.family] = (acc[p.family] ?? 0) + 1; return acc; }, {});
for (const [f, n] of Object.entries(counts)) console.error(`  ${f}: ${n}`);

// ---------------------------- run matches with telemetry ----------------------------

const stages = Object.values(STAGES).filter((s) => STAGE_FILTER.length === 0 || STAGE_FILTER.includes(s.id));
if (stages.length === 0) {
  const valid = Object.values(STAGES).map((s) => s.id).join(", ");
  throw new Error(`no stages matched --stage ${STAGE_FILTER.join(", ")}; valid stages: ${valid}`);
}
if (STAGE_FILTER.length > 0) {
  console.error(`[trace-stalls] stages: ${stages.map((s) => s.id).join(", ")}`);
}
interface MatchRecord {
  i: number; j: number;
  stageId: string; seed: number;
  winner: 0 | 1 | -1;
  ticks: number;
  finalScore: [number, number];
  telemetry: [FighterTelemetry, FighterTelemetry];
}
const records: MatchRecord[] = [];

const allStageIds = Object.values(STAGES).map((s) => s.id);
const stageIndex = new Map(allStageIds.map((id, i) => [id, i]));

// Serial execution with telemetry — runMatches worker pool doesn't
// thread telemetry back. For a diagnostic run this is fine; if we need
// parallel later, the worker message schema just needs the telemetry
// field added.
let totalRun = 0;
const totalSpecs = Math.floor((pool.length * (pool.length - 1) / 2) * stages.length * SEEDS);
for (let i = 0; i < pool.length; i++) {
  for (let j = i + 1; j < pool.length; j++) {
    for (const stage of stages) {
      for (let s = 0; s < SEEDS; s++) {
        const pairOrdinal = i * pool.length + j;
        const stOrdinal = stageIndex.get(stage.id) ?? 0;
        const seed = ((s * 101 + stage.id.length * 37 + (pairOrdinal * allStageIds.length + stOrdinal) * 13) | 0) >>> 0;
        const r = simulate({
          stage, brainA: pool[i].cfg, brainB: pool[j].cfg, seed,
          telemetry: true,
        });
        records.push({
          i, j, stageId: stage.id, seed,
          winner: r.winner, ticks: r.ticks,
          finalScore: r.finalScore,
          telemetry: r.telemetry!,
        });
        totalRun++;
        if (totalRun % 500 === 0) {
          process.stderr.write(`  ${totalRun}/${totalSpecs} matches done\n`);
        }
      }
    }
  }
}
console.error(`[trace-stalls] ${totalRun} matches complete\n`);

// ---------------------------- stall classification ----------------------------

type StallKind = "zone-mirror" | "escape-spiral" | "objective-loop" | "low-commit" | "attack-starved" | "mixed-stall" | "resolved";

function classifyStall(rec: MatchRecord): StallKind {
  const isLong = rec.ticks >= LONG_THRESHOLD_TICKS;
  const isDraw = rec.winner === -1;
  if (!isLong && !isDraw) return "resolved";

  const t0 = rec.telemetry[0], t1 = rec.telemetry[1];
  const ticks0 = t0.ticks || 1, ticks1 = t1.ticks || 1;
  const zone0 = t0.modeTicks.zone / ticks0;
  const zone1 = t1.modeTicks.zone / ticks1;
  const esc0 = t0.modeTicks.escape / ticks0;
  const esc1 = t1.modeTicks.escape / ticks1;
  const obj0 = t0.modeTicks.objective / ticks0;
  const obj1 = t1.modeTicks.objective / ticks1;
  const attacks0 = t0.swipes + t0.dives;
  const attacks1 = t1.swipes + t1.dives;
  const totalAttacks = attacks0 + attacks1;
  const matchSeconds = rec.ticks / 120; // 120 Hz sim
  const attacksPerSec = matchSeconds > 0 ? totalAttacks / matchSeconds : 0;

  if (zone0 > 0.4 && zone1 > 0.4) return "zone-mirror";
  if (esc0 > 0.3 && esc1 > 0.3) return "escape-spiral";
  if (obj0 > 0.4 && obj1 > 0.4) return "objective-loop";
  if (attacksPerSec < 0.5) return "attack-starved";  // < 1 swipe per 2 seconds combined
  // Low commitment = high mode-switch rate without clear dominant mode
  const switches = (t0.modeSwitches + t1.modeSwitches);
  const switchRate = matchSeconds > 0 ? switches / matchSeconds : 0;
  if (switchRate > 15) return "low-commit";  // > 15 mode flips per sec combined
  return "mixed-stall";
}

const classified = records.map((r) => ({ ...r, stall: classifyStall(r) }));
const draws = classified.filter((r) => r.winner === -1);
const longs = classified.filter((r) => r.ticks >= LONG_THRESHOLD_TICKS);
const resolved = classified.filter((r) => r.stall === "resolved");

const stallCounts: Record<string, number> = {};
for (const r of classified) stallCounts[r.stall] = (stallCounts[r.stall] ?? 0) + 1;
const deliveryCancelTotals = records.reduce((sum, r) =>
  sum + r.telemetry[0].deliveryCancels + r.telemetry[1].deliveryCancels, 0);
const deliveryFeintCancelTotals = records.reduce((sum, r) =>
  sum + r.telemetry[0].deliveryFeintCancels + r.telemetry[1].deliveryFeintCancels, 0);
const deliveryKillFirstCancelTotals = records.reduce((sum, r) =>
  sum + r.telemetry[0].deliveryKillFirstCancels + r.telemetry[1].deliveryKillFirstCancels, 0);

// ---------------------------- per-family mode breakdown ----------------------------

const familyModeTicks: Record<string, Record<string, number>> = {};
const familyMatches: Record<string, number> = {};
for (const r of records) {
  for (const [side, t] of [[0, r.telemetry[0]], [1, r.telemetry[1]]] as const) {
    const idx = side === 0 ? r.i : r.j;
    const fam = pool[idx].family;
    if (!familyModeTicks[fam]) familyModeTicks[fam] = { neutral: 0, offense: 0, zone: 0, objective: 0, escape: 0 };
    for (const m of ["neutral", "offense", "zone", "objective", "escape"] as const) {
      familyModeTicks[fam][m] += t.modeTicks[m];
    }
    familyMatches[fam] = (familyMatches[fam] ?? 0) + 1;
  }
}

// ---------------------------- sample dumps ----------------------------

function matchSummary(r: typeof classified[0]) {
  const t0 = r.telemetry[0], t1 = r.telemetry[1];
  const tk0 = t0.ticks || 1, tk1 = t1.ticks || 1;
  return {
    a: pool[r.i].cfg.id, b: pool[r.j].cfg.id,
    stage: r.stageId, seed: r.seed,
    winner: r.winner, ticks: r.ticks,
    ticksPct: (r.ticks / MAX_TICKS * 100).toFixed(1) + "%",
    stall: r.stall,
    p0Mode: {
      n: +(t0.modeTicks.neutral / tk0 * 100).toFixed(1),
      o: +(t0.modeTicks.offense / tk0 * 100).toFixed(1),
      z: +(t0.modeTicks.zone / tk0 * 100).toFixed(1),
      obj: +(t0.modeTicks.objective / tk0 * 100).toFixed(1),
      e: +(t0.modeTicks.escape / tk0 * 100).toFixed(1),
    },
    p1Mode: {
      n: +(t1.modeTicks.neutral / tk1 * 100).toFixed(1),
      o: +(t1.modeTicks.offense / tk1 * 100).toFixed(1),
      z: +(t1.modeTicks.zone / tk1 * 100).toFixed(1),
      obj: +(t1.modeTicks.objective / tk1 * 100).toFixed(1),
      e: +(t1.modeTicks.escape / tk1 * 100).toFixed(1),
    },
    swipes: [t0.swipes, t1.swipes],
    dives: [t0.dives, t1.dives],
    kills: [t0.kills, t1.kills],
    deliveries: [t0.deliveries, t1.deliveries],
    deliveryCancels: [t0.deliveryCancels, t1.deliveryCancels],
    clashes: t0.clashes,   // clashes are symmetric — same value for both
    switches: [t0.modeSwitches, t1.modeSwitches],
  };
}

const topLongest = longs.slice().sort((a, b) => b.ticks - a.ticks).slice(0, TOP_LONG).map(matchSummary);
const topDraws = draws.slice().sort((a, b) => b.ticks - a.ticks).slice(0, TOP_DRAW).map(matchSummary);

// ---------------------------- output ----------------------------

const report = {
  generatedAt: new Date().toISOString(),
  pool: { composition: counts, total: pool.length },
  stages: stages.map((s) => s.id),
  totalMatches: records.length,
  thresholds: { longTicks: LONG_THRESHOLD_TICKS, maxTicks: MAX_TICKS },
  summary: {
    longMatches: longs.length,
    drawMatches: draws.length,
    resolvedMatches: resolved.length,
    stallCounts,
    deliveryCancels: deliveryCancelTotals,
    deliveryFeintCancels: deliveryFeintCancelTotals,
    deliveryKillFirstCancels: deliveryKillFirstCancelTotals,
  },
  familyModeBreakdown: Object.fromEntries(
    Object.entries(familyModeTicks).map(([fam, modes]) => {
      const total = Object.values(modes).reduce((s, v) => s + v, 0) || 1;
      return [fam, Object.fromEntries(Object.entries(modes).map(([m, t]) => [m, +(t / total * 100).toFixed(1)]))];
    })
  ),
  topLongest,
  topDraws,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.error(`[trace-stalls] wrote ${OUT}\n`);

// Pretty print
console.log(`# Trace stalls report\n`);
console.log(`Stages: ${stages.map((s) => s.id).join(", ")}`);
console.log(`Total matches: ${records.length}`);
console.log(`Long (≥90% cap): ${longs.length}`);
console.log(`Draws: ${draws.length}`);
console.log(`Resolved: ${resolved.length}\n`);
console.log(`Delivery cancels: ${deliveryCancelTotals} (feint ${deliveryFeintCancelTotals}, kill-first ${deliveryKillFirstCancelTotals})\n`);

console.log(`## Stall classification\n`);
console.log(`| kind | count | % |`);
console.log(`|---|---|---|`);
const sortedStalls = Object.entries(stallCounts).sort((a, b) => (b[1] as number) - (a[1] as number));
for (const [k, n] of sortedStalls) {
  const count = n as number;
  console.log(`| ${k} | ${count} | ${(count / records.length * 100).toFixed(1)}% |`);
}

console.log(`\n## Mode time by family\n`);
console.log(`| family | neutral | offense | zone | objective | escape |`);
console.log(`|---|---|---|---|---|---|`);
for (const [fam, modes] of Object.entries(report.familyModeBreakdown)) {
  const m = modes as Record<string, number>;
  console.log(`| ${fam} | ${m.neutral}% | ${m.offense}% | ${m.zone}% | ${m.objective}% | ${m.escape}% |`);
}

console.log(`\nSample dumps + full record in ${OUT}\n`);
