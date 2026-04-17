// Release gate for system phantoms.
//
// The server refreshes system phantom configs from STRATEGIES on startup, so
// strategy and budget changes need an explicit review artifact before deploy.
// This script measures the named-strategy graph, emits rollback metadata from
// the local stable store, and exits nonzero if the graph loses counterplay.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGES,
  STRATEGIES,
  STRATEGY_NAMES,
  type BrainConfig,
} from "@m3t4/sim";
import { runMatches, type MatchSpec } from "./parallel.js";

interface Args {
  seeds: number;
  workers: number;
  maxP95: number;
  maxWr: number;
  minCounters: number;
  minCycles: number;
  store: string;
  out: string;
  candidate?: string;
}

interface Stats {
  wins: number;
  losses: number;
  draws: number;
  played: number;
}

interface SnapshotSlot {
  name: string;
  slotId: string;
  configHash: string;
  currentHash: string;
  changedFromCurrent: boolean;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  lastPlayedAt: number;
  config: BrainConfig;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const args = parseArgs();
const stages = Object.values(STAGES);
const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const ids = refs.map((r) => r.id);

console.log(`\n# Phantom gate\n`);
console.log(`- refs=${refs.length}; stages=${stages.length}; seeds=${args.seeds}; workers=${args.workers}`);
console.log(`- thresholds: p95<=${pct(args.maxP95)}, max<=${pct(args.maxWr)}, counters>=${args.minCounters}, cycles>=${args.minCycles}\n`);

const specs: MatchSpec[] = [];
for (let i = 0; i < refs.length; i++) {
  for (let j = 0; j < refs.length; j++) {
    if (i === j) continue;
    for (const st of stages) {
      for (let s = 0; s < args.seeds; s++) {
        const seed = ((s * 131 + i * 17 + j * 23) | 0) >>> 0;
        specs.push({
          a: refs[i],
          b: refs[j],
          stageId: st.id as MatchSpec["stageId"],
          seed,
          meta: { i, j, stageId: st.id, candidateSide: 0 },
        });
        specs.push({
          a: refs[j],
          b: refs[i],
          stageId: st.id as MatchSpec["stageId"],
          seed,
          meta: { i, j, stageId: st.id, candidateSide: 1 },
        });
      }
    }
  }
}

process.stderr.write(`[phantom-gate] ${specs.length} matches...\n`);
let lastPrint = 0;
const outcomes = await runMatches(specs, {
  workers: args.workers,
  onProgress: (done, total) => {
    const now = Date.now();
    if (now - lastPrint > 500 || done === total) {
      process.stderr.write(`\r  ${done}/${total}`);
      lastPrint = now;
    }
  },
});
process.stderr.write("\n");

const totals = Array.from({ length: refs.length }, freshStats);
const pair = Array.from({ length: refs.length }, () => Array.from({ length: refs.length }, freshStats));
const directedPair = Array.from({ length: refs.length }, () => Array.from({ length: refs.length }, freshStats));
const byStage = new Map<string, Stats>();

for (const o of outcomes) {
  const meta = o.spec.meta as { i: number; j: number; stageId: string; candidateSide: 0 | 1 };
  const won = o.winner === meta.candidateSide;
  const lost = o.winner === 1 - meta.candidateSide;
  const score = won ? 1 : lost ? 0 : 0.5;
  add(totals[meta.i], score);
  add(pair[meta.i][meta.j], score);
  if (meta.candidateSide === 0) add(directedPair[meta.i][meta.j], score);
  const key = `${meta.i}:${meta.j}:${meta.stageId}`;
  const cell = byStage.get(key) ?? freshStats();
  add(cell, score);
  byStage.set(key, cell);
}

const overall = ids.map((id, i) => ({ id, wr: wr(totals[i]), ...totals[i] })).sort((a, b) => b.wr - a.wr);
const overallWrs = overall.map((r) => r.wr);
const p50 = percentile(overallWrs, 0.5);
const p95 = percentile(overallWrs, 0.95);
const max = overall[0];
const mean = overallWrs.reduce((s, x) => s + x, 0) / overallWrs.length;

const counters = ids.map((id, i) => {
  const rows = ids
    .map((opponent, j) => ({ opponent, wr: i === j ? 1 : wr(pair[i][j]) }))
    .filter((r, j) => i !== j && r.wr < 0.5)
    .sort((a, b) => a.wr - b.wr);
  return { id, count: rows.length, counters: rows };
});

const pairWr = ids.map((id, i) => ({
  id,
  opponents: Object.fromEntries(ids.map((opponent, j) => [opponent, i === j ? null : wr(pair[i][j])])),
}));

const cycles: Array<[string, string, string]> = [];
for (let a = 0; a < refs.length; a++) {
  for (let b = 0; b < refs.length; b++) {
    for (let c = 0; c < refs.length; c++) {
      if (a === b || b === c || a === c) continue;
      if (wr(directedPair[a][b]) > 0.6 && wr(directedPair[b][c]) > 0.6 && wr(directedPair[c][a]) > 0.6) {
        cycles.push([ids[a], ids[b], ids[c]]);
      }
    }
  }
}

const currentStrategyHash = hashStable(STRATEGIES);
const rollback = readRollbackSnapshot(args.store);
const candidateReport = args.candidate ? await checkCandidate(loadConfig(args.candidate)) : undefined;

console.log(`## WR tail\n`);
console.log(`mean=${pct(mean)}  p50=${pct(p50)}  p95=${pct(p95)}  max=${max.id}:${pct(max.wr)}\n`);

console.log(`## Counters\n`);
for (const row of counters) {
  const names = row.counters.map((c) => `${c.opponent}(${pct(c.wr)})`).join(", ") || "none";
  console.log(`${row.id.padEnd(12)} counters=${String(row.count).padStart(2)}  ${names}`);
}
console.log();

console.log(`## Cycles\n`);
console.log(`cycles=${cycles.length}`);
for (const [a, b, c] of cycles.slice(0, 10)) console.log(`  - ${a} -> ${b} -> ${c} -> ${a}`);
console.log();

const failures: string[] = [];
if (p95 > args.maxP95) failures.push(`p95 ${pct(p95)} > ${pct(args.maxP95)}`);
if (max.wr > args.maxWr) failures.push(`max ${max.id} ${pct(max.wr)} > ${pct(args.maxWr)}`);
for (const row of counters) {
  if (row.count < args.minCounters) failures.push(`${row.id} has only ${row.count} counters`);
}
if (cycles.length < args.minCycles) failures.push(`cycles ${cycles.length} < ${args.minCycles}`);
if (candidateReport) {
  if (candidateReport.winRate > args.maxWr) failures.push(`candidate ${candidateReport.id} WR ${pct(candidateReport.winRate)} > ${pct(args.maxWr)}`);
  if (candidateReport.counters.length < args.minCounters) failures.push(`candidate ${candidateReport.id} has only ${candidateReport.counters.length} counters`);
}

const report = {
  generatedAt: new Date().toISOString(),
  thresholds: {
    maxP95: args.maxP95,
    maxWr: args.maxWr,
    minCounters: args.minCounters,
    minCycles: args.minCycles,
  },
  refs: ids,
  stages: stages.map((s) => s.id),
  seeds: args.seeds,
  currentStrategyHash,
  rollback,
  metrics: {
    mean,
    p50,
    p95,
    max,
    overall,
    pairWr,
    counters,
    cycleMetric: "directed-p1-matrix",
    cycleCount: cycles.length,
    cycles: cycles.slice(0, 100),
  },
  candidate: candidateReport,
  failures,
};

fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
console.error(`Wrote ${args.out}`);

if (failures.length > 0) {
  console.log(`## FAIL\n`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}

console.log(`## PASS\n`);

function parseArgs(): Args {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const token = process.argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      i++;
    } else {
      values.set(key, "true");
    }
  }
  const num = (key: string, fallback: number) => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`invalid --${key}: ${raw}`);
    return n;
  };
  return {
    seeds: num("seeds", 5),
    workers: num("workers", os.cpus().length),
    maxP95: num("max-p95", 0.8),
    maxWr: num("max-wr", 0.85),
    minCounters: num("min-counters", 1),
    minCycles: num("min-cycles", 40),
    store: values.get("store") ?? path.resolve(repoRoot, "server/data/m3t4.json"),
    out: values.get("out") ?? "/tmp/phantom-gate.json",
    candidate: values.get("candidate"),
  };
}

function loadConfig(spec: string): BrainConfig {
  if ((STRATEGY_NAMES as readonly string[]).includes(spec)) {
    return STRATEGIES[spec as keyof typeof STRATEGIES];
  }
  if (!fs.existsSync(spec)) throw new Error(`candidate not found: ${spec}`);
  const raw = JSON.parse(fs.readFileSync(spec, "utf8")) as BrainConfig;
  if (!raw.id) raw.id = path.basename(spec, path.extname(spec));
  return raw;
}

async function checkCandidate(candidate: BrainConfig): Promise<{
  id: string;
  winRate: number;
  counters: Array<{ id: string; wr: number }>;
  pairWr: Array<{ id: string; wr: number }>;
}> {
  const specs: MatchSpec[] = [];
  const candidateIndex = refs.length;
  for (let j = 0; j < refs.length; j++) {
    for (const st of stages) {
      for (let s = 0; s < args.seeds; s++) {
        const seed = ((s * 131 + candidateIndex * 17 + j * 23) | 0) >>> 0;
        specs.push({ a: candidate, b: refs[j], stageId: st.id as MatchSpec["stageId"], seed, meta: { j, candidateSide: 0 } });
        specs.push({ a: refs[j], b: candidate, stageId: st.id as MatchSpec["stageId"], seed, meta: { j, candidateSide: 1 } });
      }
    }
  }
  const outcomes = await runMatches(specs, { workers: args.workers });
  const total = freshStats();
  const pairStats = refs.map(freshStats);
  for (const o of outcomes) {
    const meta = o.spec.meta as { j: number; candidateSide: 0 | 1 };
    const won = o.winner === meta.candidateSide;
    const lost = o.winner === 1 - meta.candidateSide;
    const score = won ? 1 : lost ? 0 : 0.5;
    add(total, score);
    add(pairStats[meta.j], score);
  }
  const pairWrRows = refs.map((r, i) => ({ id: r.id, wr: wr(pairStats[i]) })).sort((a, b) => b.wr - a.wr);
  const countersForCandidate = pairWrRows.filter((r) => r.wr < 0.5).sort((a, b) => a.wr - b.wr);
  return {
    id: candidate.id,
    winRate: wr(total),
    counters: countersForCandidate,
    pairWr: pairWrRows,
  };
}

function freshStats(): Stats {
  return { wins: 0, losses: 0, draws: 0, played: 0 };
}

function add(stats: Stats, score: number): void {
  if (score === 1) stats.wins++;
  else if (score === 0) stats.losses++;
  else stats.draws++;
  stats.played++;
}

function wr(stats: Stats): number {
  return stats.played === 0 ? 0.5 : (stats.wins + stats.draws * 0.5) / stats.played;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function hashStable(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function readRollbackSnapshot(storePath: string): { storePath: string; slots: SnapshotSlot[]; warning?: string } {
  if (!fs.existsSync(storePath)) {
    return { storePath, slots: [], warning: "store file not found; no rollback snapshot captured" };
  }
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
    stables?: Record<string, { slots?: Array<SnapshotSlot & { config: BrainConfig }> }>;
  };
  const slots: SnapshotSlot[] = [];
  for (const name of STRATEGY_NAMES) {
    const slot = raw.stables?.[`system:${name}`]?.slots?.[0];
    if (!slot) continue;
    const configHash = hashStable(slot.config);
    const currentHash = hashStable(STRATEGIES[name]);
    slots.push({
      name,
      slotId: slot.slotId,
      configHash,
      currentHash,
      changedFromCurrent: configHash !== currentHash,
      elo: slot.elo,
      wins: slot.wins,
      losses: slot.losses,
      draws: slot.draws,
      lastPlayedAt: slot.lastPlayedAt,
      config: slot.config,
    });
  }
  return { storePath, slots };
}
