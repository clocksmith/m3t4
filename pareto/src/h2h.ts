// Head-to-head matrix. Given a list of config specs (names or JSON paths),
// run every pairing N seeds × M stages via the worker pool, emit a win-rate
// matrix as CSV + Markdown + JSON.
//
// Usage:
//   node dist/h2h.js --configs blitz,shipper,oracle,founder,moonshot --seeds 3
//   node dist/h2h.js --configs @all --seeds 2 --out h2h.json
//
// Special spec values:
//   @all    — all 12 named strategies
//   @top4   — the 4 strategies most commonly on the Pareto frontier
//
// Reveals rock-paper-scissors cycles: if row A beats col B and col B beats
// row C but row C beats col A, you can't linearly rank them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig,
} from "@m3t4/sim";
import { runMatches, type MatchSpec } from "./parallel.js";

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

function resolveConfig(spec: string): BrainConfig {
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

const args = parseArgs(process.argv);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const OUT = args.out;
const CSV = args.csv;
const MD = args.md;

const stages = [STAGES.datacenter, STAGES.boardroom, STAGES.demoday];

let configSpecs: string[];
const arg = args.configs ?? "@all";
if (arg === "@all") configSpecs = [...STRATEGY_NAMES];
else if (arg === "@top4") configSpecs = ["shipper", "founder", "moonshot", "operator"];
else configSpecs = arg.split(",").map((s) => s.trim()).filter(Boolean);

const configs = configSpecs.map(resolveConfig);
const n = configs.length;

// Build every ordered pair × stages × seeds. Each pairing is a symmetric
// contest so we include both A-first and B-first to cancel side bias.
const specs: MatchSpec[] = [];
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    for (const stage of stages) {
      for (let s = 0; s < SEEDS; s++) {
        const seed = ((s * 131 + i * 17 + j * 23 + stage.id.length) | 0) >>> 0;
        specs.push({
          a: configs[i], b: configs[j],
          stageId: stage.id as MatchSpec["stageId"],
          seed, meta: { i, j },
        });
      }
    }
  }
}

console.error(`H2H: ${n} configs × ${stages.length} stages × ${SEEDS} seeds = ${specs.length} matches on ${WORKERS} workers`);
const t0 = Date.now();
let lastPrint = 0;
const outcomes = await runMatches(specs, {
  workers: WORKERS,
  onProgress: (done, total) => {
    const now = Date.now();
    if (now - lastPrint > 500 || done === total) {
      process.stderr.write(`\r  ${done}/${total}`);
      lastPrint = now;
    }
  },
});
process.stderr.write("\n");
console.error(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Tally: wins[i][j] = how often config i beat config j (when i was A)
const wins = Array.from({ length: n }, () => new Array(n).fill(0));
const played = Array.from({ length: n }, () => new Array(n).fill(0));
for (const o of outcomes) {
  const m = o.spec.meta as { i: number; j: number };
  played[m.i][m.j]++;
  if (o.winner === 0) wins[m.i][m.j]++;
  else if (o.winner === -1) wins[m.i][m.j] += 0.5;
}

// Total win rate per config (across all opponents)
const totalWR: number[] = configs.map((_, i) => {
  let w = 0, p = 0;
  for (let j = 0; j < n; j++) { w += wins[i][j]; p += played[i][j]; }
  return p ? w / p : 0;
});

// Print Markdown table — rows = A (first player), cols = B
const ids = configs.map((c) => c.id);
console.log("\n## Head-to-head win rate (row plays col, cell = row's WR as P1)\n");
let header = "|             |";
let sep = "|-------------|";
for (const id of ids) {
  header += ` ${id.slice(0, 10).padEnd(10)} |`;
  sep += ":---------:|";
}
header += ` total |`;
sep += ":-----:|";
console.log(header);
console.log(sep);
for (let i = 0; i < n; i++) {
  let row = `| ${ids[i].slice(0, 11).padEnd(11)} |`;
  for (let j = 0; j < n; j++) {
    if (i === j) row += " —          |";
    else {
      const wr = played[i][j] ? wins[i][j] / played[i][j] : 0;
      const pct = (wr * 100).toFixed(0) + "%";
      row += ` ${pct.padStart(10)} |`;
    }
  }
  row += ` ${(totalWR[i] * 100).toFixed(0).padStart(4)}% |`;
  console.log(row);
}

// Detect cycles (A > B > C > A)
console.log("\n## Cycles (A beats B beats C beats A — rock-paper-scissors)\n");
const cycles: Array<[string, string, string]> = [];
for (let a = 0; a < n; a++) {
  for (let b = 0; b < n; b++) {
    if (a === b) continue;
    for (let c = 0; c < n; c++) {
      if (c === a || c === b) continue;
      const ab = played[a][b] ? wins[a][b] / played[a][b] : 0.5;
      const bc = played[b][c] ? wins[b][c] / played[b][c] : 0.5;
      const ca = played[c][a] ? wins[c][a] / played[c][a] : 0.5;
      if (ab > 0.55 && bc > 0.55 && ca > 0.55) {
        cycles.push([ids[a], ids[b], ids[c]]);
      }
    }
  }
}
if (cycles.length === 0) console.log("_none detected (all relationships transitive)_");
else for (const [a, b, c] of cycles.slice(0, 20)) console.log(`- ${a} → ${b} → ${c} → ${a}`);

// Optional CSV
if (CSV) {
  const lines = ["," + ids.join(",")];
  for (let i = 0; i < n; i++) {
    const row = [ids[i]];
    for (let j = 0; j < n; j++) {
      if (i === j) row.push("");
      else row.push((wins[i][j] / (played[i][j] || 1)).toFixed(3));
    }
    lines.push(row.join(","));
  }
  fs.writeFileSync(CSV, lines.join("\n"));
  console.error(`Wrote CSV to ${CSV}`);
}
if (MD) {
  // re-emit the markdown we just logged
  console.error(`Markdown already on stdout; pipe with '> file.md'`);
}
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    configs: ids,
    wins, played, totalWR,
    cycles,
  }, null, 2));
  console.error(`Wrote JSON to ${OUT}`);
}
