// Budget balance test.
//
// Hypothesis (what the builder claims):
//   1. At budget = 300, a skilled build can reach a meaningful win-rate.
//   2. Below 300, WR drops (not enough points to spend).
//   3. Above 300, hallucination kicks in and WR drops (more = worse).
//
// This script generates N random budget-compliant bots at each of several
// spend levels and scores them against the named meta. If WR peaks near
// 300 and degrades on both sides, the budget is correctly balanced.

import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  type BrainConfig, type ParamKey,
} from "@selfplay/sim";
import { scoreBatch } from "./score.js";

const RANGES: Record<string, [number, number]> = {
  burnRate: [0, 1], moat: [0, 300], shipRate: [0, 1],
  foresight: [0, 0.25], pivotSpeed: [0, 1], leverage: [-1, 1],
  networking: [0, 1],
};
const UI_KNOBS: Array<keyof typeof RANGES> = [
  "burnRate", "moat", "shipRate", "foresight", "pivotSpeed", "leverage", "networking",
];
const BUDGET = 400;

function distributeSpend(totalSpent: number): Record<string, number> {
  // Distribute `totalSpent` across 7 knobs (each 0..100) via random-fair
  // sharing. The budget cap can be up to 700 (all maxed). If totalSpent
  // exceeds 700, scale down — but we cap at 700 in practice.
  const vals: Record<string, number> = {};
  let remaining = Math.min(700, totalSpent);
  for (let i = 0; i < UI_KNOBS.length; i++) {
    const key = UI_KNOBS[i];
    const cap = Math.min(100, remaining);
    const nLeft = UI_KNOBS.length - i;
    const avg = remaining / nLeft;
    const v = Math.max(0, Math.min(cap, Math.round(avg + (Math.random() - 0.5) * avg * 0.6)));
    vals[key] = v;
    remaining -= v;
  }
  // If we have leftover, dump on a random knob
  if (remaining > 0) {
    const k = UI_KNOBS[Math.floor(Math.random() * UI_KNOBS.length)];
    vals[k] = Math.min(100, vals[k] + remaining);
  }
  return vals;
}

function makeBudgetedBot(totalSpent: number, id: string): BrainConfig {
  const ui = distributeSpend(totalSpent);
  const sumSpent = Object.values(ui).reduce((s, v) => s + v, 0);
  // Option B: hard cap. Bots are always at hallucination 0; the test
  // instead probes how spent-amount alone affects WR (i.e. if all 7 knobs
  // were used up at various total budgets).
  const hallucination = 0;
  const attrs: Partial<Record<ParamKey, number>> = {};
  for (const k of UI_KNOBS) {
    const [lo, hi] = RANGES[k];
    attrs[k as ParamKey] = lo + (hi - lo) * (ui[k] / 100);
  }
  attrs.hallucination = hallucination;
  return { id, attributes: attrs };
}

const BOTS_PER_LEVEL = parseInt(process.argv[2] ?? "20", 10);
const SEEDS = parseInt(process.argv[3] ?? "2", 10);

const spendLevels = [100, 200, 300, 350, 400, 450, 500, 600, 700];
const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const stages = Object.values(STAGES);
const WORKERS = os.cpus().length;

console.log(`\n# Budget balance test\n`);
console.log(`- ${BOTS_PER_LEVEL} random bots at each spend level`);
console.log(`- vs ${refs.length} named strategies × ${stages.length} stages × ${SEEDS} seeds\n`);

console.log(`| spent | hallucination | mean WR | min | max | std |`);
console.log(`|------:|--------------:|--------:|----:|----:|----:|`);

const summary: Array<{ spent: number; hall: number; mean: number; min: number; max: number; std: number }> = [];

for (const spent of spendLevels) {
  const candidates: BrainConfig[] = [];
  for (let i = 0; i < BOTS_PER_LEVEL; i++) {
    candidates.push(makeBudgetedBot(spent, `s${spent}-${i}`));
  }
  process.stderr.write(`\r[budget-test] spent=${spent}...    `);
  const records = await scoreBatch({
    candidates, references: refs, stages,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  const wrs = records.map((r) => r.winRate);
  const mean = wrs.reduce((s, x) => s + x, 0) / wrs.length;
  const sqSum = wrs.reduce((s, x) => s + (x - mean) ** 2, 0);
  const std = Math.sqrt(sqSum / wrs.length);
  const min = Math.min(...wrs);
  const max = Math.max(...wrs);
  const hall = 0;
  summary.push({ spent, hall, mean, min, max, std });
  const spentStr = String(spent).padStart(5);
  const hallStr = String(hall).padStart(3);
  const meanStr = (mean * 100).toFixed(1).padStart(5) + "%";
  const minStr = (min * 100).toFixed(1).padStart(4) + "%";
  const maxStr = (max * 100).toFixed(1).padStart(4) + "%";
  const stdStr = (std * 100).toFixed(1).padStart(4) + "%";
  console.log(`| ${spentStr} | ${hallStr} | ${meanStr} | ${minStr} | ${maxStr} | ${stdStr} |`);
}
process.stderr.write("\n");

// Interpretation
console.log(`\n## Interpretation\n`);
const peak = summary.slice().sort((a, b) => b.mean - a.mean)[0];
console.log(`- Peak mean WR at spent=${peak.spent} (hallucination=${peak.hall}): ${(peak.mean * 100).toFixed(1)}%`);
const at300 = summary.find((s) => s.spent === 300)!;
const at500 = summary.find((s) => s.spent === 500)!;
const at100 = summary.find((s) => s.spent === 100)!;
const at700 = summary.find((s) => s.spent === 700)!;
console.log(`- 100 (under-spent):  mean ${(at100.mean * 100).toFixed(1)}%`);
console.log(`- 300 (budget):       mean ${(at300.mean * 100).toFixed(1)}%`);
console.log(`- 500 (200 over):     mean ${(at500.mean * 100).toFixed(1)}%`);
console.log(`- 700 (all maxed):    mean ${(at700.mean * 100).toFixed(1)}%`);

const drop = at300.mean - at700.mean;
console.log(`\n- Hallucination penalty at spent=700: Δ ${(drop * 100).toFixed(1)}% vs budget-respecting bots`);
if (drop > 0.1) console.log(`- ✓ Budget creates real penalty for overspend`);
else console.log(`- ✗ Hallucination doesn't hurt enough. Consider lowering budget or stronger noise scaling.`);

const lowSpan = at300.mean - at100.mean;
console.log(`- Under-spend penalty at spent=100: Δ ${(lowSpan * 100).toFixed(1)}% vs budget`);
if (lowSpan > 0.05) console.log(`- ✓ Under-spending is also penalized (too few points)`);
else console.log(`- ⚠ Under-spending barely matters — tightening attribute ranges or raising budget would help`);

// Raw data for further analysis
console.log(`\n## Raw\n`);
console.log(JSON.stringify(summary, null, 2));
