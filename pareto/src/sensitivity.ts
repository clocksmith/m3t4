// Attribute sensitivity analyzer. For a baseline config, sweep each
// attribute one at a time over N quantized values, score each variant
// against the named meta, and print "how much did win rate move."
//
// Tells you WHICH knobs matter for a given strategy and in WHICH direction.
// Larger Δwr = higher sensitivity.
//
// Usage:
//   node dist/sensitivity.js --config moonshot --seeds 2
//   node dist/sensitivity.js --config mybot.json --points 5

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PARAMS, PARAM_KEYS, STAGES, STRATEGIES, STRATEGY_NAMES,
  type BrainConfig, type ParamKey,
} from "@m3t4/sim";
import { scoreBatch } from "./score.js";

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

function loadConfig(spec: string): BrainConfig {
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

const RANGES: Record<ParamKey, [number, number]> = {
  burnRate: [0, 1], moat: [0, 300], shipRate: [0, 1],
  foresight: [0, 0.3], pivotSpeed: [0, 1], leverage: [-1, 1],
  networking: [0, 1],
  spite: [-1, 1], greed: [0, 1], pacing: [0, 1], cunning: [0, 1],
  hallucination: [0, 100],
};

const args = parseArgs(process.argv);
const SPEC = args.config ?? "moonshot";
const SEEDS = parseInt(args.seeds ?? "2", 10);
const POINTS = parseInt(args.points ?? "5", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const OUT = args.out;

const base = loadConfig(SPEC);
const refs = STRATEGY_NAMES.filter((n) => n !== base.id).map((n) => STRATEGIES[n]);
const stages = [STAGES.datacenter, STAGES.boardroom, STAGES.demoday];

// Build variants: for each param k, POINTS evenly spaced in its RANGE.
// Each variant overrides only k; everything else matches the baseline.
interface Variant { key: ParamKey; value: number; config: BrainConfig; }
const variants: Variant[] = [];
variants.push({ key: "burnRate", value: NaN, config: { ...base, id: `${base.id}__baseline` } });
for (const k of PARAM_KEYS) {
  const [lo, hi] = RANGES[k];
  for (let p = 0; p < POINTS; p++) {
    const v = lo + ((hi - lo) * p) / (POINTS - 1);
    const attrs: Partial<Record<ParamKey, number>> = {};
    for (const kk of PARAM_KEYS) {
      const val = (base.attributes[kk] as number | undefined) ?? DEFAULT_PARAMS[kk];
      attrs[kk] = val;
    }
    attrs[k] = Math.round(v * 1000) / 1000;
    variants.push({
      key: k, value: v,
      config: { id: `${base.id}__${k}=${v.toFixed(3)}`, attributes: attrs },
    });
  }
}

console.error(`Sensitivity: baseline=${base.id}, ${PARAM_KEYS.length} knobs × ${POINTS} points = ${variants.length} configs, ${SEEDS} seeds × ${stages.length} stages, ${WORKERS} workers`);
const t0 = Date.now();
let lastPrint = 0;
const records = await scoreBatch({
  candidates: variants.map((v) => v.config),
  references: refs,
  stages,
  seedsPerMatchup: SEEDS,
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

const byId = new Map(records.map((r) => [r.id, r] as const));
const baseline = byId.get(`${base.id}__baseline`)!;
console.log(`\nBaseline ${base.id}: wr=${(baseline.winRate * 100).toFixed(1)}%`);
console.log("\nknob             value        wr       Δwr");
console.log("───────────────  ──────────  ───────  ───────");

interface Row { key: ParamKey; value: number; wr: number; delta: number; }
const rows: Row[] = [];
for (const v of variants) {
  if (isNaN(v.value)) continue;
  const r = byId.get(v.config.id);
  if (!r) continue;
  const delta = r.winRate - baseline.winRate;
  rows.push({ key: v.key, value: v.value, wr: r.winRate, delta });
}
for (const r of rows) {
  const k = r.key.padEnd(15);
  const val = r.value.toFixed(3).padStart(10);
  const wr = `${(r.wr * 100).toFixed(1)}%`.padStart(7);
  const d = (r.delta * 100).toFixed(1);
  const dStr = (r.delta >= 0 ? "+" : "") + d + "%";
  console.log(`${k}  ${val}  ${wr}  ${dStr.padStart(7)}`);
}

// Summary: which knob has the largest span (max − min)?
console.log("\n## Most sensitive knobs (largest win-rate swing)\n");
const spans = new Map<ParamKey, { min: number; max: number; span: number }>();
for (const r of rows) {
  const cur = spans.get(r.key) ?? { min: Infinity, max: -Infinity, span: 0 };
  cur.min = Math.min(cur.min, r.wr);
  cur.max = Math.max(cur.max, r.wr);
  cur.span = cur.max - cur.min;
  spans.set(r.key, cur);
}
const ranked = [...spans.entries()].sort((a, b) => b[1].span - a[1].span);
for (const [k, s] of ranked) {
  console.log(`  ${k.padEnd(15)}  span ${(s.span * 100).toFixed(1)}%  (${(s.min * 100).toFixed(1)}% → ${(s.max * 100).toFixed(1)}%)`);
}

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseline: base.id,
    baselineWinRate: baseline.winRate,
    points: POINTS, seeds: SEEDS,
    rows,
    ranked: ranked.map(([k, s]) => ({ key: k, ...s })),
  }, null, 2));
  console.error(`\nWrote ${OUT}`);
}
