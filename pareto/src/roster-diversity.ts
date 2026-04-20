// Measures the attribute-space diversity of the current named roster (or
// any roster-shaped JSON). Tracks it over time in a persistent log so
// roster upgrades can be evaluated for diversity preservation.
//
// Usage:
//   node pareto/dist/roster-diversity.js              # current STRATEGIES
//   node pareto/dist/roster-diversity.js --input /tmp/roster.json
//   node pareto/dist/roster-diversity.js --log       # append to history

import fs from "node:fs";
import path from "node:path";
import { RANGES, STRATEGIES, STRATEGY_NAMES, USER_KNOBS, type BrainConfig, type ParamKey } from "@m3t4/sim";
import { featureVector } from "./novelty.js";

const LOG_PATH = path.resolve(process.cwd(), "pareto/roster-history.jsonl");

const KNOBS: ParamKey[] = [...USER_KNOBS];

interface DiversityReport {
  n: number;
  meanPairwise: number;
  minPairwise: number;
  maxPairwise: number;
  closestPair: [string, string];
  farthestPair: [string, string];
  perAttribute: Array<{ knob: string; std: number; range: number; coverage: number }>;
}

function pairwiseDistance(a: BrainConfig, b: BrainConfig): number {
  const va = featureVector(a);
  const vb = featureVector(b);
  let s = 0;
  for (let i = 0; i < va.length; i++) {
    const d = va[i] - vb[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function scalarValue(cfg: BrainConfig, k: ParamKey): number {
  const v = cfg.attributes[k];
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "base" in v && typeof v.base === "number") return v.base;
  return 0;
}

function std(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / n;
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / n;
  return Math.sqrt(v);
}

function computeDiversity(roster: Array<{ id: string; config: BrainConfig }>): DiversityReport {
  const n = roster.length;
  const pairs: Array<{ i: number; j: number; d: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push({ i, j, d: pairwiseDistance(roster[i].config, roster[j].config) });
    }
  }
  const dists = pairs.map((p) => p.d);
  const meanPairwise = dists.reduce((a, x) => a + x, 0) / dists.length;
  const minPairwise = Math.min(...dists);
  const maxPairwise = Math.max(...dists);
  const closest = pairs.reduce((a, p) => (p.d < a.d ? p : a));
  const farthest = pairs.reduce((a, p) => (p.d > a.d ? p : a));

  const perAttribute = KNOBS.map((k) => {
    const [lo, hi] = RANGES[k];
    const values = roster.map((r) => scalarValue(r.config, k));
    const knobStd = std(values);
    const knobRange = Math.max(...values) - Math.min(...values);
    const coverage = knobRange / (hi - lo);
    return {
      knob: k,
      std: knobStd,
      range: knobRange,
      coverage,
    };
  });

  return {
    n,
    meanPairwise,
    minPairwise,
    maxPairwise,
    closestPair: [roster[closest.i].id, roster[closest.j].id],
    farthestPair: [roster[farthest.i].id, roster[farthest.j].id],
    perAttribute,
  };
}

function parseArgs(argv: string[]): { input?: string; log: boolean; label: string } {
  let input: string | undefined;
  let log = false;
  let label = "roster";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) { input = argv[++i]; }
    else if (argv[i] === "--log") { log = true; }
    else if (argv[i] === "--label" && argv[i + 1]) { label = argv[++i]; }
  }
  return { input, log, label };
}

const args = parseArgs(process.argv);

let roster: Array<{ id: string; config: BrainConfig }>;
if (args.input) {
  const raw = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const src = raw.roster ?? raw;
  roster = (src as Array<{ id: string; attributes: Record<string, number>; config?: BrainConfig }>)
    .map((r) => ({
      id: r.id,
      config: { id: r.id, attributes: (r.config?.attributes ?? r.attributes) as BrainConfig["attributes"] },
    }));
} else {
  roster = STRATEGY_NAMES.map((n) => ({ id: n, config: STRATEGIES[n as keyof typeof STRATEGIES] }));
}

const report = computeDiversity(roster);

// Pretty-print
console.log(`# Roster diversity report (${report.n} configs)\n`);
console.log(`## Pairwise distance (normalized attribute space, max possible ~3.46)`);
console.log(`  mean:    ${report.meanPairwise.toFixed(3)}`);
console.log(`  min:     ${report.minPairwise.toFixed(3)}  — closest pair: ${report.closestPair[0]} ↔ ${report.closestPair[1]}`);
console.log(`  max:     ${report.maxPairwise.toFixed(3)}  — farthest pair: ${report.farthestPair[0]} ↔ ${report.farthestPair[1]}`);
console.log();
console.log(`## Per-attribute coverage (sorted ascending — low = axis is wasted)`);
const sortedAttrs = report.perAttribute.slice().sort((a, b) => a.coverage - b.coverage);
for (const a of sortedAttrs) {
  const bar = "█".repeat(Math.round(a.coverage * 20));
  const flag = a.coverage < 0.2 ? " ⚠ wasted" : a.coverage < 0.4 ? " ~" : "";
  console.log(`  ${a.knob.padEnd(11)} std=${a.std.toFixed(3).padStart(6)}  coverage=${(a.coverage * 100).toFixed(0).padStart(3)}% ${bar}${flag}`);
}

if (args.log) {
  const entry = {
    timestamp: new Date().toISOString(),
    label: args.label,
    n: report.n,
    meanPairwise: report.meanPairwise,
    minPairwise: report.minPairwise,
    maxPairwise: report.maxPairwise,
    attributeCoverage: Object.fromEntries(report.perAttribute.map((a) => [a.knob, a.coverage])),
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  console.log(`\nLogged to ${LOG_PATH}`);
}
