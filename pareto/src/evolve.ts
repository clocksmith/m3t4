// Evolutionary search with per-generation checkpointing. Resumes from the
// latest saved generation if --resume is passed with a state file.

import fs from "node:fs";
import os from "node:os";
import { STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig } from "@m3t4/sim";
import { scoreBatch, type ScoreRecord } from "./score.js";
import { paretoFrontier } from "./frontier.js";
import { crossoverConfig, mutateConfig, randomConfig } from "./generate.js";

interface EvolveState {
  gen: number;
  pop: BrainConfig[];
  frontierHistory: Array<{ gen: number; frontier: ScoreRecord[] }>;
  started: string;
  lastUpdated: string;
  config: {
    gens: number;
    pop: number;
    seeds: number;
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const name = k.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[name] = next;
        i++;
      } else out[name] = "1";
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const GENS = parseInt(args.gens ?? "5", 10);
const POP = parseInt(args.pop ?? "24", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const STATE_FILE = args.state ?? "evolve.state.json";
const RESUME = !!args.resume;

const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const stages = [STAGES.datacenter, STAGES.boardroom, STAGES.demoday];

let state: EvolveState;
if (RESUME && fs.existsSync(STATE_FILE)) {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  console.error(`Resumed from ${STATE_FILE} at gen ${state.gen}`);
} else {
  const pop: BrainConfig[] = refs.slice();
  while (pop.length < POP) pop.push(randomConfig(`seed-${pop.length}`));
  state = {
    gen: 0,
    pop,
    frontierHistory: [],
    started: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    config: { gens: GENS, pop: POP, seeds: SEEDS },
  };
}

function saveState(): void {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

for (; state.gen < GENS; state.gen++) {
  console.error(`\n== Gen ${state.gen + 1}/${GENS}: scoring ${state.pop.length} configs on ${WORKERS} workers ==`);
  const t0 = Date.now();
  let lastPrint = 0;
  const records = await scoreBatch({
    candidates: state.pop, references: refs, stages,
    seedsPerMatchup: SEEDS, workers: WORKERS,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastPrint > 500 || done === total) {
        const pct = ((done / total) * 100).toFixed(1);
        process.stderr.write(`\r  ${done}/${total} (${pct}%)`);
        lastPrint = now;
      }
    },
  });
  process.stderr.write("\n");
  const frontier = paretoFrontier(records);
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`  done in ${took}s, frontier=${frontier.length}`);

  console.log(`\nGen ${state.gen + 1} Pareto frontier`);
  console.log("  id                       wr      Δ     tk      dl");
  console.log("  ───────────────────────  ────   ────  ──────  ────");
  for (const r of frontier) {
    console.log(`  ${r.id.padEnd(23)}  ${(r.winRate * 100).toFixed(1).padStart(4)}%  ${r.avgScoreDiff.toFixed(2).padStart(5)}  ${Math.round(r.avgTicks).toString().padStart(6)}  ${r.deliveryCount.toString().padStart(4)}`);
  }

  state.frontierHistory.push({ gen: state.gen + 1, frontier });
  saveState();

  if (state.gen + 1 < GENS) {
    // Build next generation: elitism + crossover + mutation + fresh random
    const frontIds = new Set(frontier.map((r) => r.id));
    const frontConfigs = state.pop.filter((p) => frontIds.has(p.id));
    const next: BrainConfig[] = frontConfigs.slice();
    while (next.length < POP) {
      const r = Math.random();
      if (r < 0.5 && frontConfigs.length >= 2) {
        const a = frontConfigs[Math.floor(Math.random() * frontConfigs.length)];
        const b = frontConfigs[Math.floor(Math.random() * frontConfigs.length)];
        next.push(crossoverConfig(a, b, `g${state.gen + 1}-x${next.length}`));
      } else if (r < 0.9) {
        const parent = frontConfigs[Math.floor(Math.random() * frontConfigs.length)];
        next.push(mutateConfig(parent, `g${state.gen + 1}-m${next.length}`));
      } else {
        next.push(randomConfig(`g${state.gen + 1}-r${next.length}`));
      }
    }
    state.pop = next;
    saveState();
  }
}

console.error(`\nEvolution complete. State saved to ${STATE_FILE}`);
