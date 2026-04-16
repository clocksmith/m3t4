// Random sweep + Pareto frontier report. Generates N random configs, scores
// all of them in parallel via the worker pool.

import fs from "node:fs";
import os from "node:os";
import { STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig } from "@m3t4/sim";
import { scoreBatch } from "./score.js";
import { paretoFrontier } from "./frontier.js";
import { randomConfig } from "./generate.js";

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
const N = parseInt(args.n ?? "40", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const INCLUDE_NAMED = !!args["include-named"] || !!args["include_named"];
const OUT = args.out;
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);

const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const stages = [STAGES.datacenter, STAGES.boardroom, STAGES.demoday];

const candidates: BrainConfig[] = [];
for (let i = 0; i < N; i++) candidates.push(randomConfig(`rand-${i.toString().padStart(3, "0")}`));
if (INCLUDE_NAMED) candidates.push(...refs);

const totalMatches = candidates.length * refs.length * stages.length * SEEDS * 2;
console.error(
  `Scoring ${candidates.length} candidates × ${refs.length} refs × ${stages.length} stages × ${SEEDS} seeds × 2 sides ` +
  `= ${totalMatches} matches on ${WORKERS} workers...`
);
const started = Date.now();

let lastPrint = 0;
const records = await scoreBatch({
  candidates, references: refs, stages,
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
const byId = new Map(candidates.map((c) => [c.id, c] as const));

const took = ((Date.now() - started) / 1000).toFixed(1);
console.error(`Done in ${took}s. Frontier size: ${frontier.length}/${records.length}`);

console.log("");
console.log("id                           wr     ΔΔ    tk      dl   matches");
console.log("───────────────────────────  ────  ────  ──────  ───  ───────");
for (const r of frontier) {
  const id = r.id.padEnd(27);
  const wr = (r.winRate * 100).toFixed(1).padStart(5);
  const sd = r.avgScoreDiff.toFixed(2).padStart(5);
  const tk = Math.round(r.avgTicks).toString().padStart(6);
  const dl = r.deliveryCount.toString().padStart(4);
  const m = r.matches.toString().padStart(6);
  console.log(`${id} ${wr}% ${sd}  ${tk}  ${dl}  ${m}`);
}

if (OUT) {
  const payload = {
    generatedAt: new Date().toISOString(),
    n: N,
    seedsPerMatchup: SEEDS,
    workers: WORKERS,
    totalMatches,
    elapsedSec: parseFloat(took),
    frontier: frontier.map((r) => ({ score: r, config: byId.get(r.id) })),
    all: records,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.error(`Wrote ${OUT}`);
}
