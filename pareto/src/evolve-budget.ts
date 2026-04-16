// Budget-constrained evolution. Every candidate respects USER_BUDGET=400.
// Uses the named 15 as the meta. Answers the question:
//   "What's the best win rate achievable within the budget constraint?"

import fs from "node:fs";
import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig,
} from "@selfplay/sim";
import { scoreBatch, type ScoreRecord } from "./score.js";
import { paretoFrontier } from "./frontier.js";
import {
  USER_BUDGET, budgetSpent, randomBudgeted, mutateBudgeted,
  crossoverBudgeted, projectIntoBudget,
} from "./budget-util.js";

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

const args = parseArgs(process.argv);
const GENS = parseInt(args.gens ?? "12", 10);
const POP = parseInt(args.pop ?? "24", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const OUT = args.out ?? "./budget-evolve-best.json";

// Refs: all 15 named. Note: many named configs EXCEED budget=400 (shipper=351,
// thesis=326, etc), so the meta's members are above our constraint. That's
// intentional — users face opponents with more attribute juice than they have.
const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const stages = Object.values(STAGES);

console.error(`[budget-evolve] budget=${USER_BUDGET}, gens=${GENS}, pop=${POP}, seeds=${SEEDS}`);
console.error(`[budget-evolve] refs: ${refs.length} named (meta uses 219-351 pts; we're at ≤${USER_BUDGET})`);

// Named footprint summary
const footprints = refs.map((r) => ({ id: r.id, spent: budgetSpent(r) })).sort((a, b) => a.spent - b.spent);
console.error(`[budget-evolve] named footprint: min=${footprints[0].spent}(${footprints[0].id}) max=${footprints[footprints.length-1].spent}(${footprints[footprints.length-1].id})`);

// Seed population: mix of projected-named + pure random
let pop: BrainConfig[] = [];
for (const r of refs) pop.push(projectIntoBudget({ ...r, id: `proj-${r.id}` }));
while (pop.length < POP) pop.push(randomBudgeted(`rand-${pop.length}`));

interface GenStats {
  gen: number;
  bestId: string;
  bestWr: number;
  meanWr: number;
  bestSpent: number;
}
const stats: GenStats[] = [];

const t0 = Date.now();
let bestEver: { cfg: BrainConfig; wr: number; spent: number } = { cfg: pop[0], wr: 0, spent: 0 };

for (let g = 0; g < GENS; g++) {
  // Sanity: all candidates respect budget
  for (const c of pop) {
    const s = budgetSpent(c);
    if (s > USER_BUDGET + 1) console.error(`  ⚠ candidate ${c.id} spent ${s} (over budget ${USER_BUDGET})`);
  }

  process.stderr.write(`\rgen ${g + 1}/${GENS}  scoring...                `);
  const records = await scoreBatch({
    candidates: pop, references: refs, stages,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  const byId = new Map(pop.map((c) => [c.id, c] as const));
  const sorted = records.slice().sort((a, b) => b.winRate - a.winRate);
  const bestRec = sorted[0];
  const bestCfg = byId.get(bestRec.id)!;
  const meanWr = records.reduce((s, r) => s + r.winRate, 0) / records.length;
  const s: GenStats = {
    gen: g + 1,
    bestId: bestRec.id,
    bestWr: bestRec.winRate,
    meanWr,
    bestSpent: budgetSpent(bestCfg),
  };
  stats.push(s);
  process.stderr.write(`\rgen ${g + 1}/${GENS}  best=${(bestRec.winRate * 100).toFixed(1)}% (${bestRec.id}, ${s.bestSpent}pts)  mean=${(meanWr * 100).toFixed(1)}%\n`);

  if (bestRec.winRate > bestEver.wr) {
    bestEver = { cfg: bestCfg, wr: bestRec.winRate, spent: s.bestSpent };
  }

  if (g + 1 < GENS) {
    // NSGA-like: top half elitism, rest by crossover/mutation/fresh
    const frontier = paretoFrontier(records);
    const elite = frontier.map((r) => byId.get(r.id)!).filter(Boolean);
    const next: BrainConfig[] = elite.slice();
    while (next.length < POP) {
      const r = Math.random();
      if (r < 0.45 && elite.length >= 2) {
        const a = elite[Math.floor(Math.random() * elite.length)];
        const b = elite[Math.floor(Math.random() * elite.length)];
        next.push(crossoverBudgeted(a, b, `g${g+1}-x${next.length}`));
      } else if (r < 0.85) {
        const parent = elite[Math.floor(Math.random() * elite.length)];
        next.push(mutateBudgeted(parent, `g${g+1}-m${next.length}`));
      } else {
        next.push(randomBudgeted(`g${g+1}-r${next.length}`));
      }
    }
    pop = next;
  }
}

const took = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n# Budget-constrained evolution — ${took}s\n`);
console.log(`best-ever:`);
console.log(`  id=${bestEver.cfg.id}`);
console.log(`  wr=${(bestEver.wr * 100).toFixed(1)}%`);
console.log(`  spent=${bestEver.spent}/${USER_BUDGET}`);
console.log(`\ngen progression:`);
console.log(`  gen   best   mean   spent  id`);
for (const s of stats) {
  console.log(`  ${String(s.gen).padStart(3)}  ${(s.bestWr*100).toFixed(1).padStart(5)}% ${(s.meanWr*100).toFixed(1).padStart(5)}%  ${String(s.bestSpent).padStart(3)}  ${s.bestId}`);
}

console.log(`\n## Verdict\n`);
if (bestEver.wr >= 0.5) {
  console.log(`✓ budget=${USER_BUDGET} enables meta-competitive play (best ≥50%)`);
} else if (bestEver.wr >= 0.4) {
  console.log(`~ budget=${USER_BUDGET} is tight. Best-within-budget reaches ${(bestEver.wr*100).toFixed(1)}%.`);
} else {
  console.log(`⚠ budget=${USER_BUDGET} seems too tight. Best-within-budget only reaches ${(bestEver.wr*100).toFixed(1)}%.`);
}

fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  budget: USER_BUDGET,
  bestEver: {
    wr: bestEver.wr,
    spent: bestEver.spent,
    config: bestEver.cfg,
  },
  stats,
}, null, 2));
console.error(`Wrote ${OUT}`);
