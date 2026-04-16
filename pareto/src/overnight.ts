// Overnight run harness. Takes a wall-clock deadline (in minutes or hours)
// and executes a sequence of experiments in order. At any point — including
// at the deadline or on SIGINT — it flushes the best findings to a final
// markdown report.
//
// Usage:
//   node dist/overnight.js --deadline 2h --outdir ./run-$(date +%Y%m%d-%H%M)
//   node dist/overnight.js --deadline 30m --gens 20 --pop 24
//
// Stages (run in order until deadline hits):
//   1. baseline h2h on named strategies
//   2. random sweep (N=200)
//   3. evolve with NSGA-II (GENS gens × POP)
//   4. sensitivity on the final best bot
//   5. export a GIF of the best bot vs a strong reference
//
// After each stage: checkpoint. On interrupt: finalize whatever's done.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  type BrainConfig,
} from "@selfplay/sim";
import { scoreBatch, type ScoreRecord } from "./score.js";
import { paretoFrontier } from "./frontier.js";
import {
  crossoverConfig, mutateConfig, randomConfig,
  promoteToTrajectory, mutateTrajectory,
} from "./generate.js";
import { nonDominatedSort, tournamentSelect } from "./nsga2.js";
import { NoveltyArchive } from "./novelty.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Arg parsing ----------

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

function parseDeadline(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`bad --deadline '${s}'`);
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "m") as "s" | "m" | "h";
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : 3600;
  return n * mult * 1000;
}

const args = parseArgs(process.argv);
const DEADLINE_MS = parseDeadline(args.deadline ?? "30m");
const OUTDIR = args.outdir ?? `./overnight-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const GENS = parseInt(args.gens ?? "8", 10);
const POP = parseInt(args.pop ?? "24", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const SWEEP_N = parseInt(args["sweep-n"] ?? "60", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);

fs.mkdirSync(OUTDIR, { recursive: true });

const startedAt = Date.now();
const deadlineAt = startedAt + DEADLINE_MS;
const STAGES_LIST = Object.values(STAGES);
const REFS: BrainConfig[] = STRATEGY_NAMES.map((n) => STRATEGIES[n]);

// ---------- Shared state for reporting ----------

interface StageReport {
  name: string;
  status: "pending" | "running" | "completed" | "interrupted" | "skipped";
  startedAt?: number;
  completedAt?: number;
  notes: string;
  artifacts: string[];
}

const report = {
  startedAt: new Date(startedAt).toISOString(),
  deadline: new Date(deadlineAt).toISOString(),
  outdir: OUTDIR,
  stages: [] as StageReport[],
  summary: {
    best: null as null | { id: string; source: string; winRate: number; config: BrainConfig },
  },
};

function addStage(name: string): StageReport {
  const s: StageReport = { name, status: "pending", notes: "", artifacts: [] };
  report.stages.push(s);
  return s;
}

function timeLeft(): number {
  return Math.max(0, deadlineAt - Date.now());
}
function timeLeftLabel(): string {
  const ms = timeLeft();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
function pastDeadline(): boolean {
  return Date.now() >= deadlineAt;
}

function checkpoint(): void {
  fs.writeFileSync(
    path.join(OUTDIR, "report.json"),
    JSON.stringify(report, null, 2),
  );
  renderMarkdown();
}

function renderMarkdown(): void {
  const lines: string[] = [];
  lines.push(`# SELF overnight run`);
  lines.push("");
  lines.push(`- started: ${report.startedAt}`);
  lines.push(`- deadline: ${report.deadline}  (${timeLeftLabel()} remaining)`);
  lines.push(`- outdir: \`${OUTDIR}\``);
  lines.push("");
  lines.push(`## Best-known config`);
  if (report.summary.best) {
    const b = report.summary.best;
    lines.push(`- id: **${b.id}**  (from: ${b.source})`);
    lines.push(`- win rate vs named refs: **${(b.winRate * 100).toFixed(1)}%**`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(b.config, null, 2));
    lines.push("```");
  } else {
    lines.push(`_no candidate evaluated yet_`);
  }
  lines.push("");
  lines.push(`## Stages`);
  for (const s of report.stages) {
    const dur =
      s.startedAt && s.completedAt ? `  (${((s.completedAt - s.startedAt) / 1000).toFixed(1)}s)` : "";
    lines.push(`### ${s.name} — ${s.status}${dur}`);
    if (s.notes) lines.push(s.notes);
    if (s.artifacts.length) {
      lines.push("");
      for (const a of s.artifacts) lines.push(`- artifact: \`${a}\``);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(OUTDIR, "report.md"), lines.join("\n"));
}

// Flush on interrupt
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) return;
  interrupted = true;
  const running = report.stages.find((s) => s.status === "running");
  if (running) running.status = "interrupted";
  console.error("\n[overnight] interrupted — writing final report...");
  checkpoint();
  process.exit(130);
});

function updateBest(source: string, record: ScoreRecord, cfg: BrainConfig): void {
  if (!report.summary.best || record.winRate > report.summary.best.winRate) {
    report.summary.best = {
      id: cfg.id,
      source,
      winRate: record.winRate,
      config: cfg,
    };
    fs.writeFileSync(
      path.join(OUTDIR, "best.json"),
      JSON.stringify(cfg, null, 2),
    );
  }
}

// ---------- Stage 1: baseline h2h ----------

async function stageH2H(): Promise<void> {
  const s = addStage("h2h baseline (named strategies)");
  s.status = "running";
  s.startedAt = Date.now();
  console.error(`[h2h] ${timeLeftLabel()} left`);
  const candidates = REFS.slice();
  const records = await scoreBatch({
    candidates, references: REFS, stages: STAGES_LIST,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  const best = records.slice().sort((a, b) => b.winRate - a.winRate)[0];
  const bestCfg = REFS.find((r) => r.id === best.id)!;
  updateBest("h2h-named", best, bestCfg);
  fs.writeFileSync(path.join(OUTDIR, "stage1-h2h.json"), JSON.stringify(records, null, 2));
  s.artifacts.push("stage1-h2h.json");
  s.notes = records
    .slice()
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 5)
    .map((r) => `  - ${r.id}: ${(r.winRate * 100).toFixed(1)}%`)
    .join("\n");
  s.completedAt = Date.now();
  s.status = "completed";
  checkpoint();
}

// ---------- Stage 2: random sweep ----------

async function stageSweep(): Promise<void> {
  const s = addStage(`random sweep (N=${SWEEP_N})`);
  s.status = "running";
  s.startedAt = Date.now();
  console.error(`[sweep] ${timeLeftLabel()} left, generating ${SWEEP_N} candidates`);
  const candidates: BrainConfig[] = [];
  for (let i = 0; i < SWEEP_N; i++) {
    const cfg = Math.random() < 0.3
      ? promoteToTrajectory(randomConfig(`sw-${i}`), `sw-${i}`, 0.3)
      : randomConfig(`sw-${i}`);
    candidates.push(cfg);
  }
  const records = await scoreBatch({
    candidates, references: REFS, stages: STAGES_LIST,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  const front = paretoFrontier(records);
  const best = records.slice().sort((a, b) => b.winRate - a.winRate)[0];
  const bestCfg = candidates.find((c) => c.id === best.id)!;
  updateBest("sweep", best, bestCfg);
  fs.writeFileSync(
    path.join(OUTDIR, "stage2-sweep.json"),
    JSON.stringify({
      all: records,
      frontier: front.map((r) => ({ score: r, config: candidates.find((c) => c.id === r.id) })),
    }, null, 2),
  );
  s.artifacts.push("stage2-sweep.json");
  s.notes = front
    .slice(0, 5)
    .map((r) => `  - ${r.id}: wr=${(r.winRate * 100).toFixed(1)}% Δ=${r.avgScoreDiff.toFixed(2)}`)
    .join("\n");
  s.completedAt = Date.now();
  s.status = "completed";
  checkpoint();
}

// ---------- Stage 3: NSGA-II evolve with novelty ----------

async function stageEvolve(): Promise<void> {
  const s = addStage(`NSGA-II evolve (gens≤${GENS}, pop=${POP})`);
  s.status = "running";
  s.startedAt = Date.now();
  const archive = new NoveltyArchive({ k: 6, archiveMax: 500 });
  for (const r of REFS) archive.maybeAdd(r);

  // Seed: named strategies + random fills
  let pop: BrainConfig[] = REFS.slice();
  while (pop.length < POP) pop.push(randomConfig(`ev-seed-${pop.length}`));

  const frontierHistory: Array<{ gen: number; front: ScoreRecord[] }> = [];

  for (let g = 0; g < GENS; g++) {
    if (pastDeadline()) { s.status = "interrupted"; s.notes += `\n_stopped at gen ${g} — deadline_`; break; }
    if (interrupted) { s.status = "interrupted"; break; }
    console.error(`[evolve] gen ${g + 1}/${GENS}, ${timeLeftLabel()} left`);
    const records = await scoreBatch({
      candidates: pop, references: REFS, stages: STAGES_LIST,
      seedsPerMatchup: SEEDS, workers: WORKERS,
    });
    // Novelty per-config
    const noveltyMap = new Map<string, number>();
    for (const c of pop) noveltyMap.set(c.id, archive.noveltyOf(c));

    const ranked = nonDominatedSort(records, { novelty: noveltyMap });
    const front0 = ranked.filter((r) => r.fronts === 0);
    frontierHistory.push({ gen: g + 1, front: front0.map((r) => r.raw) });
    s.notes = `gen ${g + 1}: frontier=${front0.length}, best wr=${Math.max(...front0.map(r => r.raw.winRate))*100 | 0}%`;
    checkpoint();

    // Update best-so-far
    const topWin = records.slice().sort((a, b) => b.winRate - a.winRate)[0];
    const topCfg = pop.find((c) => c.id === topWin.id)!;
    updateBest(`evolve-gen${g + 1}`, topWin, topCfg);
    // Archive novel frontier members
    for (const r of front0) {
      const cfg = pop.find((c) => c.id === r.id);
      if (cfg) archive.maybeAdd(cfg);
    }
    // Build next gen via NSGA-II tournament selection + mutation mix
    if (g + 1 < GENS) {
      const next: BrainConfig[] = [];
      // Elitism: first Pareto tier preserved
      for (const r of front0) next.push(pop.find((c) => c.id === r.id)!);
      while (next.length < POP) {
        const a = tournamentSelect(ranked);
        const aCfg = pop.find((c) => c.id === a.id)!;
        const op = Math.random();
        if (op < 0.35) {
          const b = tournamentSelect(ranked);
          const bCfg = pop.find((c) => c.id === b.id)!;
          next.push(crossoverConfig(aCfg, bCfg, `g${g + 1}-x${next.length}`));
        } else if (op < 0.65) {
          next.push(mutateConfig(aCfg, `g${g + 1}-m${next.length}`));
        } else if (op < 0.85) {
          next.push(mutateTrajectory(aCfg, `g${g + 1}-t${next.length}`, 0.4));
        } else {
          next.push(randomConfig(`g${g + 1}-r${next.length}`));
        }
      }
      pop = next;
    }
  }
  fs.writeFileSync(
    path.join(OUTDIR, "stage3-evolve.json"),
    JSON.stringify({
      finalPop: pop,
      frontierHistory,
      archiveSize: archive.size(),
    }, null, 2),
  );
  s.artifacts.push("stage3-evolve.json");
  if (s.status !== "interrupted") s.status = "completed";
  s.completedAt = Date.now();
  checkpoint();
}

// ---------- Stage 4: sensitivity on the best ----------

async function stageSensitivity(): Promise<void> {
  const s = addStage("sensitivity (best bot)");
  if (!report.summary.best) { s.status = "skipped"; s.notes = "no best bot yet"; checkpoint(); return; }
  s.status = "running";
  s.startedAt = Date.now();
  // Spawn sensitivity.js as a child so we reuse that CLI's logic
  const child = spawn("node", [
    path.join(__dirname, "sensitivity.js"),
    "--config", path.join(OUTDIR, "best.json"),
    "--seeds", String(SEEDS),
    "--points", "5",
    "--out", path.join(OUTDIR, "stage4-sensitivity.json"),
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const logFile = path.join(OUTDIR, "stage4-sensitivity.log");
  const logStream = fs.createWriteStream(logFile);
  child.stdout?.pipe(logStream);
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    const killer = setInterval(() => {
      if (pastDeadline() || interrupted) {
        child.kill("SIGINT");
        clearInterval(killer);
      }
    }, 1000);
    child.on("close", () => clearInterval(killer));
  });
  s.artifacts.push("stage4-sensitivity.json", "stage4-sensitivity.log");
  s.completedAt = Date.now();
  s.status = interrupted ? "interrupted" : "completed";
  checkpoint();
}

// ---------- Stage 5: GIF export ----------

async function stageGif(): Promise<void> {
  const s = addStage("GIF replay of best bot");
  if (!report.summary.best) { s.status = "skipped"; s.notes = "no best bot"; checkpoint(); return; }
  s.status = "running";
  s.startedAt = Date.now();
  const opp = "oracle";
  const outGif = path.join(OUTDIR, "best-vs-oracle.gif");
  const child = spawn("node", [
    path.join(__dirname, "gif.js"),
    "--a", path.join(OUTDIR, "best.json"),
    "--b", opp, "--seed", "1", "--out", outGif,
    "--scale", "0.4", "--fps", "15", "--maxSec", "20",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  await new Promise<void>((resolve) => child.on("close", resolve));
  s.artifacts.push(path.relative(OUTDIR, outGif));
  s.completedAt = Date.now();
  s.status = "completed";
  checkpoint();
}

// ---------- Top-level orchestration ----------

console.error(`[overnight] start=${new Date(startedAt).toISOString()}  deadline=${DEADLINE_MS / 1000}s  outdir=${OUTDIR}`);
checkpoint();

try {
  if (!pastDeadline()) await stageH2H();
  if (!pastDeadline()) await stageSweep();
  if (!pastDeadline()) await stageEvolve();
  if (!pastDeadline()) await stageSensitivity();
  if (!pastDeadline()) await stageGif();
} catch (e) {
  console.error(`[overnight] error:`, e);
} finally {
  // Mark any still-pending stages as skipped if past deadline
  for (const s of report.stages) {
    if (s.status === "pending") s.status = "skipped";
    if (s.status === "running") s.status = interrupted ? "interrupted" : "completed";
  }
  checkpoint();
  console.error(`[overnight] done. outdir=${OUTDIR}`);
  console.error(`[overnight] best: ${report.summary.best?.id ?? "none"}`);
}
