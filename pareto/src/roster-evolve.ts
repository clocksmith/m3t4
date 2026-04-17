// Roster evolution — replaces the archetype-first preset design.
//
// Output: N configs (default 16) that are each strong AND mutually
// counterable. Uses:
//   - Budget-legal generators (every config is user-submittable)
//   - Co-evolution: opponent pool starts as named meta, grows with HOF
//   - Novelty pressure: NSGA-II over [winRate, novelty]
//   - Greedy diverse selection from HOF for final roster
//
// Produces /tmp/new-roster.json and an H2H validation summary.

import fs from "node:fs";
import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig, type ParamKey,
} from "@m3t4/sim";
import { scoreBatch } from "./score.js";
import { runMatches, type MatchSpec } from "./parallel.js";
import { nonDominatedSort, tournamentSelect } from "./nsga2.js";
import { NoveltyArchive, featureVector } from "./novelty.js";
import {
  USER_BUDGET, budgetSpent,
  randomBudgeted, mutateBudgeted, crossoverBudgeted,
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
const GENS = parseInt(args.gens ?? "30", 10);
const POP = parseInt(args.pop ?? "40", 10);
const SEEDS = parseInt(args.seeds ?? "2", 10);
const WORKERS = parseInt(args.workers ?? `${os.cpus().length}`, 10);
const ROSTER = parseInt(args.roster ?? "16", 10);
const HOF_MIN_WR = parseFloat(args.minwr ?? "0.55");
const COEVOLVE_EVERY = parseInt(args.coevolveEvery ?? "5", 10);
const OUT = args.out ?? "/tmp/new-roster.json";

const namedPool = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const stages = Object.values(STAGES);

console.error(`[roster] gens=${GENS} pop=${POP} seeds=${SEEDS} workers=${WORKERS}`);
console.error(`[roster] roster=${ROSTER} HOF min WR=${HOF_MIN_WR} co-evolve every ${COEVOLVE_EVERY} gens\n`);

// Hall of Fame: every config that ever scored above HOF_MIN_WR.
interface HOFItem { cfg: BrainConfig; wr: number; gen: number; spent: number }
const hof: HOFItem[] = [];
const hofIds = new Set<string>();

// Co-evolution pool: starts as named meta, grows with strong HOF members.
const opponentPool: BrainConfig[] = namedPool.slice();
const opponentIds = new Set(opponentPool.map((c) => c.id));

// Novelty archive in attribute space.
const novelty = new NoveltyArchive({ k: 5, archiveMax: 400, minNovelty: 0.05 });

// Seed population: named projections + random.
let pop: BrainConfig[] = [];
for (let i = 0; i < POP; i++) pop.push(randomBudgeted(`seed-${i}`));

for (let g = 0; g < GENS; g++) {
  // Sanity
  for (const c of pop) {
    const s = budgetSpent(c);
    if (s > USER_BUDGET + 1) console.error(`  ⚠ ${c.id} spent ${s}`);
  }

  process.stderr.write(`gen ${g + 1}/${GENS}  scoring vs ${opponentPool.length} opponents...\n`);
  const records = await scoreBatch({
    candidates: pop, references: opponentPool, stages,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  const byId = new Map(pop.map((c) => [c.id, c] as const));

  // Compute novelty for each candidate relative to current archive.
  const noveltyMap = new Map<string, number>();
  for (const c of pop) noveltyMap.set(c.id, novelty.noveltyOf(c));

  // Non-dominated sort with novelty as a fifth objective.
  const ranked = nonDominatedSort(records, { novelty: noveltyMap });

  // HOF: strong AND distinct-enough.
  for (const r of records) {
    if (r.winRate >= HOF_MIN_WR) {
      const cfg = byId.get(r.id)!;
      if (!hofIds.has(cfg.id) && novelty.maybeAdd(cfg)) {
        hof.push({ cfg, wr: r.winRate, gen: g, spent: budgetSpent(cfg) });
        hofIds.add(cfg.id);
      }
    }
  }

  const sorted = records.slice().sort((a, b) => b.winRate - a.winRate);
  const best = sorted[0];
  const meanWr = records.reduce((s, r) => s + r.winRate, 0) / records.length;
  process.stderr.write(
    `  best=${(best.winRate * 100).toFixed(1)}% (${best.id})  mean=${(meanWr * 100).toFixed(1)}%  hof=${hof.length}  pool=${opponentPool.length}\n`,
  );

  // Co-evolution: periodically inject top recent HOF into opponent pool.
  if ((g + 1) % COEVOLVE_EVERY === 0 && hof.length > 0) {
    const topRecent = hof.slice().sort((a, b) => b.wr - a.wr).slice(0, 3);
    for (const h of topRecent) {
      if (!opponentIds.has(h.cfg.id)) {
        opponentPool.push(h.cfg);
        opponentIds.add(h.cfg.id);
      }
    }
    process.stderr.write(`  [co-evolve] pool now ${opponentPool.length}\n`);
  }

  if (g + 1 < GENS) {
    // Build next population via tournament + mutation/crossover/random.
    const next: BrainConfig[] = [];
    // Elitism: front 0 carried forward.
    const elites = ranked
      .filter((r) => r.fronts === 0)
      .map((r) => byId.get(r.id)!)
      .filter(Boolean)
      .slice(0, Math.floor(POP * 0.25));
    next.push(...elites);
    while (next.length < POP) {
      const r = Math.random();
      if (r < 0.4 && elites.length >= 2) {
        const a = tournamentSelect(ranked); const b = tournamentSelect(ranked);
        const ac = byId.get(a.id)!; const bc = byId.get(b.id)!;
        next.push(crossoverBudgeted(ac, bc, `g${g+1}-x${next.length}`));
      } else if (r < 0.85) {
        const p = tournamentSelect(ranked);
        next.push(mutateBudgeted(byId.get(p.id)!, `g${g+1}-m${next.length}`, 0.4, 0.15));
      } else {
        next.push(randomBudgeted(`g${g+1}-r${next.length}`));
      }
    }
    pop = next;
  }
}

console.error(`\n[roster] evolution complete. HOF size: ${hof.length}`);

// =========================================================================
// Select ROSTER configs from HOF: high WR + max-min attribute distance.
// =========================================================================

function attrDist(a: BrainConfig, b: BrainConfig): number {
  const va = featureVector(a); const vb = featureVector(b);
  let s = 0;
  for (let i = 0; i < va.length; i++) {
    const d = va[i] - vb[i]; s += d * d;
  }
  return Math.sqrt(s);
}

// Only consider the top half of HOF by WR — we need strong configs.
const hofSorted = hof.slice().sort((a, b) => b.wr - a.wr);
const candidatePool = hofSorted.slice(0, Math.max(ROSTER * 3, Math.floor(hofSorted.length / 2)));

console.error(`[roster] selecting ${ROSTER} from ${candidatePool.length} strong HOF candidates`);

// Greedy: start with highest-WR member, then iteratively pick the member
// whose minimum distance to already-selected members is maximized.
const selected: HOFItem[] = [];
selected.push(candidatePool[0]);
while (selected.length < ROSTER && selected.length < candidatePool.length) {
  let best: HOFItem | null = null;
  let bestScore = -Infinity;
  for (const cand of candidatePool) {
    if (selected.includes(cand)) continue;
    let minDist = Infinity;
    for (const s of selected) {
      const d = attrDist(cand.cfg, s.cfg);
      if (d < minDist) minDist = d;
    }
    // Score combines diversity and strength (winrate in [0,1], dist ~ [0, sqrt(11)])
    const score = minDist + cand.wr * 0.5;
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  if (!best) break;
  selected.push(best);
}

console.error(`[roster] selected ${selected.length} configs\n`);

// =========================================================================
// Validate: full H2H on the selected roster.
// =========================================================================

const roster: BrainConfig[] = selected.map((s, i) => ({ ...s.cfg, id: `r${i}` }));

process.stderr.write(`[validate] full ${roster.length}×${roster.length} H2H with 5 seeds...\n`);
const n = roster.length;
const VAL_SEEDS = 5;
const specs: MatchSpec[] = [];
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    for (const st of stages) {
      for (let s = 0; s < VAL_SEEDS; s++) {
        const seed = ((s * 131 + i * 17 + j * 23) | 0) >>> 0;
        specs.push({ a: roster[i], b: roster[j], stageId: st.id as MatchSpec["stageId"], seed, meta: { i, j } });
      }
    }
  }
}
const outcomes = await runMatches(specs, { workers: WORKERS });
const wins = Array.from({ length: n }, () => new Array(n).fill(0));
const played = Array.from({ length: n }, () => new Array(n).fill(0));
for (const o of outcomes) {
  const m = o.spec.meta as { i: number; j: number };
  played[m.i][m.j]++;
  if (o.winner === 0) wins[m.i][m.j]++;
  else if (o.winner === -1) wins[m.i][m.j] += 0.5;
}
const symWr = (i: number, j: number): number => {
  if (i === j) return 0.5;
  const ij = played[i][j] ? wins[i][j] / played[i][j] : 0.5;
  const ji = played[j][i] ? wins[j][i] / played[j][i] : 0.5;
  return (ij + (1 - ji)) / 2;
};
const globalWr = roster.map((_, i) => {
  let w = 0, p = 0;
  for (let j = 0; j < n; j++) if (i !== j) { w += symWr(i, j); p++; }
  return p ? w / p : 0;
});

const counterThresh = 0.55;
const countersOf: number[] = new Array(n).fill(0);
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    if (symWr(j, i) > counterThresh) countersOf[i]++;
  }
}

const cycles: Array<[number, number, number]> = [];
for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
  if (a === b || b === c || a === c) continue;
  if (symWr(a, b) > 0.55 && symWr(b, c) > 0.55 && symWr(c, a) > 0.55) cycles.push([a, b, c]);
}

// Also validate: does the new best preset beat the OLD named meta as hard?
// Score each new-roster member against the NAMED pool to see its external WR.
process.stderr.write(`[validate] new roster vs OLD named meta...\n`);
const extRecs = await scoreBatch({
  candidates: roster, references: namedPool, stages,
  seedsPerMatchup: 3, workers: WORKERS,
});
const extWr = new Map(extRecs.map((r) => [r.id, r.winRate]));

// =========================================================================
// Report.
// =========================================================================

console.log(`\n# New roster — diversity-evolved\n`);
console.log(`Phase 1: ${GENS} gens, pop ${POP}, seeds ${SEEDS}, co-evolve every ${COEVOLVE_EVERY}`);
console.log(`HOF: ${hof.length} configs  →  selected ${roster.length} by max-min-distance\n`);

console.log(`## Internal roster H2H (${n}×${n}, ${VAL_SEEDS} seeds, symmetric)\n`);
console.log(`| id | WR vs roster | counters (other members >55%) | WR vs OLD named | spent |`);
console.log(`|---|---|---|---|---|`);
for (let i = 0; i < n; i++) {
  const ext = extWr.get(roster[i].id) ?? 0;
  console.log(
    `| ${roster[i].id} | ${(globalWr[i] * 100).toFixed(1)}% | ${countersOf[i]} | ${(ext * 100).toFixed(1)}% | ${budgetSpent(roster[i])} |`,
  );
}

const internalMax = Math.max(...globalWr);
const internalP95 = globalWr.slice().sort((a, b) => a - b)[Math.floor(globalWr.length * 0.95)];
const noCounters = countersOf.filter((c) => c === 0).length;
const minCounters = Math.min(...countersOf);

console.log(`\n## Summary\n`);
console.log(`- Internal max WR: **${(internalMax * 100).toFixed(1)}%**  (target <75% for healthy spread)`);
console.log(`- Internal p95 WR: **${(internalP95 * 100).toFixed(1)}%**`);
console.log(`- Min counters: **${minCounters}**  (target ≥3)`);
console.log(`- Members with zero counters: **${noCounters}**  (target 0)`);
console.log(`- Cycles (A>B>C>A at 55%): **${cycles.length}**  (target ≥40)`);
const maxExt = Math.max(...extRecs.map((r) => r.winRate));
console.log(`- Max WR vs OLD named meta: **${(maxExt * 100).toFixed(1)}%**  (higher = new roster dominates old)`);

fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  params: { GENS, POP, SEEDS, ROSTER, HOF_MIN_WR, COEVOLVE_EVERY },
  roster: roster.map((r, i) => ({
    id: r.id,
    attributes: r.attributes,
    hofOriginalId: selected[i].cfg.id,
    spent: budgetSpent(r),
    internalWr: globalWr[i],
    counters: countersOf[i],
    vsOldMeta: extWr.get(r.id) ?? 0,
  })),
  internalMax, internalP95, minCounters, noCounters,
  cycleCount: cycles.length,
  hofSize: hof.length,
  poolFinalSize: opponentPool.length,
}, null, 2));

console.error(`\nWrote ${OUT}`);
