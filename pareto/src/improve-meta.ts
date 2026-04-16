// Meta-improvement orchestrator.
//
// Phase 1 — Find the current intern: quick random sweep + pick the best.
// Phase 2 — Refine every named strategy individually via CMA-ES. Each one
//           keeps its character (rusher stays aggressive, turtle stays
//           defensive) but has its attributes tuned toward a local optimum.
// Phase 3 — Refine the intern the same way. Its ceiling moves up.
// Phase 4 — Run a fresh H2H on the refined meta. This is the "new meta."
// Phase 5 — Add all refined bots + intern to the Hall of Fame.
// Phase 6 — Emit meta-report.md summarizing before/after per strategy and
//           the new intern.
//
// All within a wall-clock deadline (`--deadline 2h` by default). Any phase
// that runs out of time still gets finalized with what it has.
//
// Usage:
//   node dist/improve-meta.js --deadline 2h --outdir ./meta-$(date +%Y%m%d-%H%M)
//   node dist/improve-meta.js --deadline 30m --refine-gens 8 --refine-pop 16
//   node dist/improve-meta.js --deadline 45m --seed-from intern.json
//
// ITERATE: run multiple cycles, each using previous HOF as opponents —
// the bar rises each cycle. The hall-of-fame file carries state between runs.
//
//   node dist/improve-meta.js --deadline 1h --outdir meta-1
//   node dist/improve-meta.js --deadline 1h --outdir meta-2 --refs-from-hof 15
//   node dist/improve-meta.js --deadline 1h --outdir meta-3 --refs-from-hof 15
//
// Each cycle's meta-report.md shows "vs HOF top-K" rather than "vs named 15".
//
// Outputs into --outdir:
//   meta-report.md           — summary before/after per strategy
//   refined/<name>.json      — refined version of each named strategy
//   intern-before.json     — the intern found in phase 1
//   intern-after.json      — the same intern, refined
//   hof.json                 — updated hall of fame
//   phaseN-*.json            — raw phase-level data

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  type BrainConfig,
} from "@selfplay/sim";
import { scoreBatch, type ScoreRecord } from "./score.js";
import { randomConfig, promoteToTrajectory } from "./generate.js";
import { HallOfFame } from "./hof.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const DEADLINE_MS = parseDeadline(args.deadline ?? "60m");
const OUTDIR = args.outdir ?? `./meta-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const REFINE_GENS = parseInt(args["refine-gens"] ?? "8", 10);
const REFINE_POP = parseInt(args["refine-pop"] ?? "14", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const SIGMA = parseFloat(args.sigma ?? "0.08");
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const INTERN_SWEEP_N = parseInt(args["intern-n"] ?? "30", 10);
const SEED_FROM = args["seed-from"]; // optional: a config to use as intern instead of discovering one
const HOF_PATH = args.hof ?? path.join(OUTDIR, "..", "hall-of-fame.json");

fs.mkdirSync(OUTDIR, { recursive: true });
fs.mkdirSync(path.join(OUTDIR, "refined"), { recursive: true });

const hof = new HallOfFame(HOF_PATH, 300);

const startedAt = Date.now();
const deadlineAt = startedAt + DEADLINE_MS;
const STAGES_LIST = Object.values(STAGES);
const NAMED: BrainConfig[] = STRATEGY_NAMES.map((n) => STRATEGIES[n]);

// Iterate mode: when --refs-from-hof K is set, use top-K HOF entries as
// the reference pool instead of the original named strategies. Each cycle
// raises the bar; the HOF file carries state across runs.
const REFS_FROM_HOF = parseInt(args["refs-from-hof"] ?? "0", 10);
const REFS: BrainConfig[] = (() => {
  if (REFS_FROM_HOF > 0 && hof.size() >= Math.min(8, REFS_FROM_HOF)) {
    const pool = hof.top(REFS_FROM_HOF).map((e) => e.config);
    console.error(`[meta] using top-${pool.length} HOF entries as reference pool`);
    return pool;
  }
  if (REFS_FROM_HOF > 0) console.error(`[meta] HOF only has ${hof.size()} entries — falling back to named`);
  return NAMED;
})();
const REFS_LABEL = REFS === NAMED ? "named meta" : `HOF top-${REFS.length}`;

function timeLeft(): number { return Math.max(0, deadlineAt - Date.now()); }
function timeLeftLabel(): string {
  const s = Math.floor(timeLeft() / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
function pastDeadline(): boolean { return Date.now() >= deadlineAt; }

interface StageLog {
  name: string;
  status: "pending" | "running" | "completed" | "skipped" | "interrupted";
  startedAt?: number;
  completedAt?: number;
  notes: string;
}
const stages: StageLog[] = [];
function addStage(name: string): StageLog { const s: StageLog = { name, status: "pending", notes: "" }; stages.push(s); return s; }

interface BeforeAfterRow { id: string; before: number; after: number; delta: number; beforeCfg: BrainConfig; afterCfg: BrainConfig; }
const beforeAfter: BeforeAfterRow[] = [];
let internBefore: BrainConfig | null = null;
let internBeforeWr = 0;
let internAfter: BrainConfig | null = null;
let internAfterWr = 0;

let interrupted = false;
process.on("SIGINT", () => { if (!interrupted) { interrupted = true; console.error("\n[meta] interrupted — finalizing..."); finalize(); process.exit(130); } });

function finalize(): void {
  for (const s of stages) { if (s.status === "running") s.status = interrupted ? "interrupted" : "completed"; if (s.status === "pending") s.status = "skipped"; }
  writeReport();
}

function writeReport(): void {
  const lines: string[] = [];
  lines.push(`# Meta improvement report`);
  lines.push("");
  lines.push(`- started: ${new Date(startedAt).toISOString()}`);
  lines.push(`- deadline: ${new Date(deadlineAt).toISOString()}  (${timeLeftLabel()} remaining)`);
  lines.push(`- outdir: \`${OUTDIR}\``);
  lines.push(`- hof entries: ${hof.size()}`);
  lines.push("");
  lines.push(`## Intern`);
  if (internBefore) {
    lines.push(`- discovered: **${internBefore.id}**  wr=${(internBeforeWr * 100).toFixed(1)}%`);
    if (internAfter) {
      const d = (internAfterWr - internBeforeWr) * 100;
      lines.push(`- refined:     **${internAfter.id}**  wr=${(internAfterWr * 100).toFixed(1)}%  (Δ ${d >= 0 ? "+" : ""}${d.toFixed(1)}%)`);
    }
  } else {
    lines.push(`_no intern selected yet_`);
  }
  lines.push("");
  lines.push(`## Named strategies — before vs after`);
  lines.push("");
  lines.push(`| strategy | before | after | Δ |`);
  lines.push(`|----------|-------:|------:|--:|`);
  const sorted = beforeAfter.slice().sort((a, b) => b.after - a.after);
  for (const r of sorted) {
    const d = (r.after - r.before) * 100;
    const dStr = (d >= 0 ? "+" : "") + d.toFixed(1) + "%";
    lines.push(`| ${r.id} | ${(r.before * 100).toFixed(1)}% | ${(r.after * 100).toFixed(1)}% | ${dStr} |`);
  }
  lines.push("");
  lines.push(`## Stages`);
  for (const s of stages) {
    const dur = s.startedAt && s.completedAt ? `  (${((s.completedAt - s.startedAt) / 1000).toFixed(1)}s)` : "";
    lines.push(`### ${s.name} — ${s.status}${dur}`);
    if (s.notes) lines.push(s.notes);
    lines.push("");
  }
  fs.writeFileSync(path.join(OUTDIR, "meta-report.md"), lines.join("\n"));
  fs.writeFileSync(path.join(OUTDIR, "meta-report.json"), JSON.stringify({
    startedAt: new Date(startedAt).toISOString(),
    deadlineAt: new Date(deadlineAt).toISOString(),
    internBefore, internBeforeWr, internAfter, internAfterWr,
    beforeAfter,
    stages,
  }, null, 2));
}

async function runChildRefine(seedPath: string, seedId: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("node", [
      path.join(__dirname, "refine.js"),
      "--config", seedPath,
      "--gens", String(REFINE_GENS),
      "--pop", String(REFINE_POP),
      "--seeds", String(SEEDS),
      "--sigma", String(SIGMA),
      "--workers", String(WORKERS),
      "--out", outPath,
      "--refs", "@all",
    ], { stdio: ["ignore", "inherit", "inherit"] });
    const killer = setInterval(() => {
      if (pastDeadline() || interrupted) { child.kill("SIGINT"); clearInterval(killer); }
    }, 1000);
    child.on("close", () => { clearInterval(killer); resolve(); });
  });
}

// ---------- Phase 1: intern ----------

async function phaseIntern(): Promise<void> {
  const s = addStage("Phase 1 — find intern");
  s.status = "running"; s.startedAt = Date.now();
  if (SEED_FROM) {
    const raw = JSON.parse(fs.readFileSync(SEED_FROM, "utf8"));
    if (!raw.id) raw.id = "intern-seed";
    const recs = await scoreBatch({ candidates: [raw], references: REFS, stages: STAGES_LIST, seedsPerMatchup: SEEDS, workers: WORKERS });
    internBefore = raw;
    internBeforeWr = recs[0].winRate;
    s.notes = `seeded from ${SEED_FROM}: ${(internBeforeWr * 100).toFixed(1)}% vs named`;
  } else {
    // Quick sweep — candidates = named refs + some random + trajectory-promoted randoms
    const candidates: BrainConfig[] = [...NAMED];
    for (let i = 0; i < INTERN_SWEEP_N; i++) {
      const cfg = Math.random() < 0.4
        ? promoteToTrajectory(randomConfig(`sw-${i}`), `sw-${i}`, 0.4)
        : randomConfig(`sw-${i}`);
      candidates.push(cfg);
    }
    console.error(`[phase1] sweeping ${candidates.length} candidates, ${timeLeftLabel()} left`);
    const records = await scoreBatch({ candidates, references: REFS, stages: STAGES_LIST, seedsPerMatchup: SEEDS, workers: WORKERS });
    const byId = new Map(candidates.map((c) => [c.id, c] as const));
    const best = records.slice().sort((a, b) => b.winRate - a.winRate)[0];
    internBefore = byId.get(best.id)!;
    internBeforeWr = best.winRate;
    s.notes = `intern=${internBefore.id} (wr=${(internBeforeWr * 100).toFixed(1)}%) from ${candidates.length} candidates`;
  }
  fs.writeFileSync(path.join(OUTDIR, "intern-before.json"), JSON.stringify(internBefore, null, 2));
  hof.add(internBefore!, internBeforeWr, "meta-phase1-intern");
  s.completedAt = Date.now(); s.status = "completed"; writeReport();
}

// ---------- Phase 2: refine each named strategy ----------

async function phaseRefineNamed(): Promise<void> {
  const s = addStage("Phase 2 — refine each named strategy");
  s.status = "running"; s.startedAt = Date.now();
  console.error(`[phase2] refining ${NAMED.length} strategies, ${timeLeftLabel()} left`);

  // First score all named up-front to capture "before" numbers cheaply
  const beforeRecords = await scoreBatch({
    candidates: NAMED, references: REFS, stages: STAGES_LIST,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  const beforeWr = new Map(beforeRecords.map((r) => [r.id, r.winRate] as const));

  for (const cfg of NAMED) {
    if (pastDeadline() || interrupted) { s.notes += `\n  stopped early at '${cfg.id}' due to deadline`; break; }
    const seedPath = path.join(OUTDIR, "refined", `__seed_${cfg.id}.json`);
    const outPath  = path.join(OUTDIR, "refined", `${cfg.id}.json`);
    fs.writeFileSync(seedPath, JSON.stringify(cfg, null, 2));
    console.error(`[phase2] refining ${cfg.id}  (${timeLeftLabel()} left)`);
    await runChildRefine(seedPath, cfg.id, outPath);
    fs.unlinkSync(seedPath);
    if (fs.existsSync(outPath)) {
      const refined = JSON.parse(fs.readFileSync(outPath, "utf8")) as BrainConfig;
      // Measure refined win-rate against the SAME opponents we used for `before`
      const recs = await scoreBatch({
        candidates: [refined], references: REFS, stages: STAGES_LIST,
        seedsPerMatchup: SEEDS, workers: WORKERS,
      });
      const afterWr = recs[0].winRate;
      beforeAfter.push({
        id: cfg.id,
        before: beforeWr.get(cfg.id) ?? 0,
        after: afterWr,
        delta: afterWr - (beforeWr.get(cfg.id) ?? 0),
        beforeCfg: cfg,
        afterCfg: refined,
      });
      hof.add(refined, afterWr, `meta-refine-${cfg.id}`);
      writeReport();
    }
  }
  s.completedAt = Date.now();
  s.status = interrupted ? "interrupted" : "completed";
  writeReport();
}

// ---------- Phase 3: refine the intern ----------

async function phaseRefineIntern(): Promise<void> {
  const s = addStage("Phase 3 — refine the intern");
  if (!internBefore) { s.status = "skipped"; s.notes = "no intern"; writeReport(); return; }
  s.status = "running"; s.startedAt = Date.now();
  const seedPath = path.join(OUTDIR, "__intern_seed.json");
  const outPath = path.join(OUTDIR, "intern-after.json");
  fs.writeFileSync(seedPath, JSON.stringify(internBefore, null, 2));
  console.error(`[phase3] refining intern ${internBefore.id}, ${timeLeftLabel()} left`);
  await runChildRefine(seedPath, internBefore.id, outPath);
  fs.unlinkSync(seedPath);
  if (fs.existsSync(outPath)) {
    internAfter = JSON.parse(fs.readFileSync(outPath, "utf8")) as BrainConfig;
    const recs = await scoreBatch({
      candidates: [internAfter!], references: REFS, stages: STAGES_LIST,
      seedsPerMatchup: SEEDS, workers: WORKERS,
    });
    internAfterWr = recs[0].winRate;
    hof.add(internAfter!, internAfterWr, "meta-phase3-intern-refined");
  }
  s.completedAt = Date.now();
  s.status = interrupted ? "interrupted" : "completed";
  writeReport();
}

// ---------- Phase 4: H2H on the refined meta ----------

async function phaseH2H(): Promise<void> {
  const s = addStage("Phase 4 — H2H on refined meta");
  s.status = "running"; s.startedAt = Date.now();
  const refined: BrainConfig[] = beforeAfter.map((r) => r.afterCfg);
  if (internAfter) refined.push(internAfter);
  if (refined.length < 2) { s.status = "skipped"; s.notes = "not enough refined bots"; writeReport(); return; }
  console.error(`[phase4] H2H among ${refined.length} refined bots`);
  const recs = await scoreBatch({
    candidates: refined, references: refined, stages: STAGES_LIST,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  fs.writeFileSync(path.join(OUTDIR, "phase4-h2h.json"), JSON.stringify(recs, null, 2));
  const top = recs.slice().sort((a, b) => b.winRate - a.winRate).slice(0, 5);
  s.notes = top.map((r) => `  - ${r.id}: ${(r.winRate * 100).toFixed(1)}%`).join("\n");
  s.completedAt = Date.now();
  s.status = "completed";
  writeReport();
}

// ---------- Orchestration ----------

console.error(`[meta] deadline=${timeLeftLabel()}, outdir=${OUTDIR}, HOF=${HOF_PATH}`);
writeReport();

try {
  if (!pastDeadline() && !interrupted) await phaseIntern();
  if (!pastDeadline() && !interrupted) await phaseRefineNamed();
  if (!pastDeadline() && !interrupted) await phaseRefineIntern();
  if (!pastDeadline() && !interrupted) await phaseH2H();
} catch (e) {
  console.error(`[meta] error:`, e);
} finally {
  finalize();
  console.error(`[meta] done. report at ${path.join(OUTDIR, "meta-report.md")}`);
}
