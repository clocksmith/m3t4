// Roster-level optimizer. Given a large candidate bank, finds the
// best 16-member subset by simulated annealing on a multi-objective
// fitness function:
//
//   + externalStrength  (mean WR vs reference pool)
//   + attributeCoverage (per-axis range, weak-axis weighted)
//   + matchupDiversity  (mean signature distance)
//   + counterCoverage   (every member has ≥2 internal counters)
//   + internalCycleDensity
//   - dominancePenalty  (internal WR > 0.7)
//   - clonePenalty      (signature distance < 0.10)
//   - zeroCounterPenalty
//
// This replaces the greedy max-min-distance selector in roster-evolve.ts,
// which produced the "moderate winners only" bias documented in the
// candidate-bank coverage report (9/81 niches = 11% covered).

import fs from "node:fs";
import os from "node:os";
import {
  RANGES, ROUND_TIMER_MAX_TICKS, ROUNDS_TO_WIN_MATCH, STAGES, STRATEGIES,
  STRATEGY_NAMES, USER_KNOBS,
  type BrainConfig, type ParamKey, type Stage,
} from "@m3t4/sim";
import { featureVector } from "./novelty.js";
import { computeSignatures, signatureDistance, type Signature } from "./matchup-signature.js";
import { computeDescriptors } from "./candidate-bank.js";
import { runMatches, type MatchSpec } from "./parallel.js";

const ROSTER_SIZE = 16;
const MAX_TICKS = ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;
const LONG_THRESHOLD_TICKS = Math.floor(MAX_TICKS * 0.9);

interface Candidate {
  id: string;
  config: BrainConfig;
  wr: number; // external WR vs reference pool
  externalSignature?: Signature; // row vs named meta (for strength cross-checks)
  internalSignature?: Signature; // row vs OTHER pool members (for counter/cycle metrics)
  internalStalls?: StallSignature; // row vs OTHER pool members (long/draw contribution)
}

interface RosterEval {
  externalStrength: number;
  attributeCoverage: number;
  signatureDiversity: number;
  counterCoverage: number;
  cycleDensity: number;
  longRate: number;
  drawRate: number;
  stallRate: number;
  stallPenalty: number;
  liftCount: number;
  liftFloorPenalty: number;
  dominancePenalty: number;
  clonePenalty: number;
  zeroCounterPenalty: number;
  fitness: number;
}

interface StallCell {
  played: number;
  long: number;
  draw: number;
}

interface StallSignature {
  row: Map<string, StallCell>;
}

interface SelectorOptions {
  stallWeight: number;
  drawWeight: number;
  minLift: number;
  minLiftCount: number;
}

interface AccumCell extends StallCell {
  score: number;
}

function attrValue(config: BrainConfig, key: ParamKey): number {
  const v = config.attributes[key];
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "base" in v && typeof v.base === "number") return v.base;
  return 0;
}

function attrDist(a: BrainConfig, b: BrainConfig): number {
  const va = featureVector(a);
  const vb = featureVector(b);
  let s = 0;
  for (let i = 0; i < va.length; i++) {
    const d = va[i] - vb[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// Per-attribute coverage, with extra weight on under-explored axes.
const WEAK_AXIS_BOOST: Partial<Record<ParamKey, number>> = {
  burnRate: 1.5, moat: 1.5, shipRate: 1.5, foresight: 1.5, pivotSpeed: 1.3,
  spite: 1.3, leverage: 1.0, networking: 1.0, greed: 1.0, pacing: 1.0, cunning: 1.0,
  lift: 1.2, parry: 1.2, chase: 1.2, discipline: 1.2,
};

function attributeCoverage(roster: Candidate[]): number {
  const attrs = USER_KNOBS;
  let sum = 0;
  let weightSum = 0;
  for (const k of attrs) {
    const [lo, hi] = RANGES[k];
    const vals = roster.map((r) => attrValue(r.config, k));
    const coverage = (Math.max(...vals) - Math.min(...vals)) / (hi - lo);
    const w = WEAK_AXIS_BOOST[k] ?? 1;
    sum += coverage * w;
    weightSum += w;
  }
  return sum / weightSum;
}

function signatureDiversity(roster: Candidate[]): { mean: number; min: number; clonePairs: number } {
  // Uses externalSignature (row vs named meta) — the playstyle fingerprint
  // against a fixed reference pool. Internal signatures would measure
  // "how do they play against each other" which is already captured in
  // counterCoverage/cycleDensity; we want a different diversity signal.
  let sum = 0;
  let min = Infinity;
  let clonePairs = 0;
  let n = 0;
  for (let i = 0; i < roster.length; i++) {
    if (!roster[i].externalSignature) continue;
    for (let j = i + 1; j < roster.length; j++) {
      if (!roster[j].externalSignature) continue;
      const d = signatureDistance(roster[i].externalSignature!, roster[j].externalSignature!);
      sum += d;
      if (d < min) min = d;
      if (d < 0.10) clonePairs++;
      n++;
    }
  }
  return n > 0 ? { mean: sum / n, min, clonePairs } : { mean: 0, min: 0, clonePairs: 0 };
}

// Uses the pool-vs-pool internal signatures. internalSignature.row[b.id]
// is a's WR vs b from actual simulation. Previously this used the
// (named-meta) external signatures which never contained candidate IDs,
// so internalWr always returned 0.5 — counterCoverage/cycleDensity/
// dominancePenalty were inert.
function internalWr(a: Candidate, b: Candidate): number {
  const fromA = a.internalSignature?.row.get(b.id);
  const fromB = b.internalSignature?.row.get(a.id);
  if (fromA !== undefined && fromB !== undefined) return (fromA + (1 - fromB)) / 2;
  if (fromA !== undefined) return fromA;
  if (fromB !== undefined) return 1 - fromB;
  return 0.5;
}

async function computeInternalSignaturesAndStalls(opts: {
  candidates: Candidate[];
  stages: Stage[];
  seedsPerMatchup: number;
  workers: number;
}): Promise<void> {
  const { candidates, stages, seedsPerMatchup, workers } = opts;
  const specs: MatchSpec[] = [];
  let idx = 0;
  for (const cand of candidates) {
    for (const ref of candidates) {
      if (ref.id === cand.id) continue;
      for (const stage of stages) {
        for (let s = 0; s < seedsPerMatchup; s++) {
          const seed = ((s * 101 + stage.id.length * 37 + idx * 13) | 0) >>> 0;
          specs.push({
            a: cand.config,
            b: ref.config,
            stageId: stage.id as MatchSpec["stageId"],
            seed,
            meta: { candId: cand.id, refId: ref.id, candSide: 0 },
          });
          specs.push({
            a: ref.config,
            b: cand.config,
            stageId: stage.id as MatchSpec["stageId"],
            seed,
            meta: { candId: cand.id, refId: ref.id, candSide: 1 },
          });
          idx++;
        }
      }
    }
  }

  const outcomes = await runMatches(specs, { workers });
  const accum = new Map<string, Map<string, AccumCell>>();
  for (const o of outcomes) {
    const m = o.spec.meta as { candId: string; refId: string; candSide: 0 | 1 };
    if (!accum.has(m.candId)) accum.set(m.candId, new Map());
    const row = accum.get(m.candId)!;
    if (!row.has(m.refId)) row.set(m.refId, { score: 0, played: 0, long: 0, draw: 0 });
    const cell = row.get(m.refId)!;
    cell.played++;
    if (o.winner === m.candSide) cell.score++;
    else if (o.winner === -1) cell.score += 0.5;
    if (o.ticks >= LONG_THRESHOLD_TICKS) cell.long++;
    if (o.winner === -1) cell.draw++;
  }

  for (const cand of candidates) {
    const raw = accum.get(cand.id);
    const wrRow = new Map<string, number>();
    const stallRow = new Map<string, StallCell>();
    if (raw) {
      for (const [refId, cell] of raw) {
        wrRow.set(refId, cell.played > 0 ? cell.score / cell.played : 0.5);
        stallRow.set(refId, { played: cell.played, long: cell.long, draw: cell.draw });
      }
    }
    cand.internalSignature = { id: cand.id, row: wrRow };
    cand.internalStalls = { row: stallRow };
  }
}

function counterCoverage(roster: Candidate[]): { minCounters: number; zeroCount: number } {
  let zeroCount = 0;
  let minCounters = Infinity;
  for (const r of roster) {
    let counters = 0;
    for (const other of roster) {
      if (other.id === r.id) continue;
      if (internalWr(other, r) > 0.55) counters++;
    }
    if (counters === 0) zeroCount++;
    if (counters < minCounters) minCounters = counters;
  }
  return { minCounters: minCounters === Infinity ? 0 : minCounters, zeroCount };
}

function cycleCount(roster: Candidate[]): number {
  let cycles = 0;
  for (let a = 0; a < roster.length; a++) for (let b = 0; b < roster.length; b++) for (let c = 0; c < roster.length; c++) {
    if (a === b || b === c || a === c) continue;
    if (internalWr(roster[a], roster[b]) > 0.55 &&
        internalWr(roster[b], roster[c]) > 0.55 &&
        internalWr(roster[c], roster[a]) > 0.55) {
      cycles++;
    }
  }
  return cycles;
}

function rosterStalls(roster: Candidate[]): { longRate: number; drawRate: number; stallRate: number } {
  let played = 0;
  let long = 0;
  let draw = 0;
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const cells = [
        roster[i].internalStalls?.row.get(roster[j].id),
        roster[j].internalStalls?.row.get(roster[i].id),
      ];
      for (const cell of cells) {
        if (!cell) continue;
        played += cell.played;
        long += cell.long;
        draw += cell.draw;
      }
    }
  }
  if (played === 0) return { longRate: 0, drawRate: 0, stallRate: 0 };
  return {
    longRate: long / played,
    drawRate: draw / played,
    // Draws are intentionally additive here: a timeout draw is worse than
    // a long decisive match and should pay both costs in selection.
    stallRate: (long + draw) / played,
  };
}

function evalRoster(roster: Candidate[], opts: SelectorOptions): RosterEval {
  const externalStrength = roster.reduce((s, r) => s + r.wr, 0) / roster.length;
  const coverage = attributeCoverage(roster);
  const sig = signatureDiversity(roster);
  const counters = counterCoverage(roster);
  const cycles = cycleCount(roster);
  const stalls = rosterStalls(roster);
  const liftCount = roster.filter((r) => attrValue(r.config, "lift") >= opts.minLift).length;
  // Dominance: any config with internal WR > 0.70
  let dominanceCount = 0;
  for (const r of roster) {
    let wins = 0;
    for (const other of roster) if (other.id !== r.id && internalWr(r, other) > 0.55) wins++;
    if (wins / (roster.length - 1) > 0.7) dominanceCount++;
  }
  const dominancePenalty = dominanceCount * 0.1;
  const clonePenalty = sig.clonePairs * 0.05;
  const zeroCounterPenalty = counters.zeroCount * 0.15;
  const stallPenalty = stalls.stallRate * opts.stallWeight + stalls.drawRate * opts.drawWeight;
  const liftFloorPenalty = Math.max(0, opts.minLiftCount - liftCount) * 0.15;
  // Composite fitness
  const fitness =
    externalStrength * 0.6 +
    coverage * 0.8 +
    sig.mean * 1.0 +
    Math.min(counters.minCounters / 3, 1) * 0.3 +
    Math.min(cycles / 80, 1) * 0.2 -
    dominancePenalty - clonePenalty - zeroCounterPenalty - stallPenalty - liftFloorPenalty;
  return {
    externalStrength, attributeCoverage: coverage,
    signatureDiversity: sig.mean,
    counterCoverage: counters.minCounters,
    cycleDensity: cycles,
    longRate: stalls.longRate,
    drawRate: stalls.drawRate,
    stallRate: stalls.stallRate,
    stallPenalty,
    liftCount,
    liftFloorPenalty,
    dominancePenalty, clonePenalty, zeroCounterPenalty,
    fitness,
  };
}

function selectAnnealing(
  pool: Candidate[],
  iterations: number,
  seed: Candidate[] | null,
  opts: SelectorOptions,
): { roster: Candidate[]; eval: RosterEval; history: number[] } {
  const rng = (() => {
    let s = 0x12345678;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  })();
  if (pool.length < ROSTER_SIZE) throw new Error(`pool too small: ${pool.length}`);

  let current: Candidate[] = seed ?? pool.slice(0, ROSTER_SIZE);
  if (current.length !== ROSTER_SIZE) {
    // Start: pick top-wr + random others
    const sorted = pool.slice().sort((a, b) => b.wr - a.wr);
    current = sorted.slice(0, Math.min(8, ROSTER_SIZE));
    while (current.length < ROSTER_SIZE) {
      const pick = pool[Math.floor(rng() * pool.length)];
      if (!current.includes(pick)) current.push(pick);
    }
  }
  let currentEval = evalRoster(current, opts);
  let best: Candidate[] = current.slice();
  let bestEval = currentEval;
  const history: number[] = [currentEval.fitness];

  for (let i = 0; i < iterations; i++) {
    const temp = 1 - i / iterations;
    const replaceIdx = Math.floor(rng() * ROSTER_SIZE);
    const outside = pool.filter((c) => !current.includes(c));
    if (outside.length === 0) break;
    const newMember = outside[Math.floor(rng() * outside.length)];
    const trial = current.slice();
    trial[replaceIdx] = newMember;
    const trialEval = evalRoster(trial, opts);
    const delta = trialEval.fitness - currentEval.fitness;
    if (delta > 0 || rng() < Math.exp(delta / (temp * 0.05 + 0.01))) {
      current = trial;
      currentEval = trialEval;
      if (currentEval.fitness > bestEval.fitness) {
        best = current.slice();
        bestEval = currentEval;
      }
    }
    history.push(currentEval.fitness);
  }
  return { roster: best, eval: bestEval, history };
}

// ----- CLI -----

async function main(): Promise<void> {
  const args = (() => {
    const out: Record<string, string> = {};
    for (let i = 2; i < process.argv.length; i++) {
      const k = process.argv[i];
      if (k.startsWith("--")) {
        const next = process.argv[i + 1];
        if (next && !next.startsWith("--")) { out[k.slice(2)] = next; i++; }
        else out[k.slice(2)] = "1";
      }
    }
    return out;
  })();

  const bankPath = args.bank ?? "/tmp/new-roster-v4.json";
  const iterations = parseInt(args.iterations ?? "2000", 10);
  const poolCap = parseInt(args.poolCap ?? "80", 10);
  const workers = parseInt(args.workers ?? `${os.cpus().length}`, 10);
  const internalSeeds = parseInt(args["internal-seeds"] ?? "2", 10);
  const minShipRate = parseFloat(args["min-ship-rate"] ?? "0");
  const selectorOpts: SelectorOptions = {
    stallWeight: parseFloat(args["stall-weight"] ?? "0.15"),
    drawWeight: parseFloat(args["draw-weight"] ?? "0.35"),
    minLift: parseFloat(args["min-lift"] ?? "0.1"),
    minLiftCount: parseInt(args["min-lift-count"] ?? "0", 10),
  };
  const outPath = args.out ?? "/tmp/roster-selected.json";
  const raw = JSON.parse(fs.readFileSync(bankPath, "utf8"));
  const source: Array<{ id?: string; config?: BrainConfig; attributes?: BrainConfig["attributes"]; internalWr?: number; wr?: number }> =
    raw.roster ?? raw.hof ?? raw;

  let pool: Candidate[] = source.map((r, i) => {
    const id = r.id ?? r.config?.id ?? `c${i}`;
    const config = r.config ? { ...r.config, id } : { id, attributes: r.attributes! };
    return {
      id,
      config,
      wr: r.internalWr ?? r.wr ?? 0.5,
    };
  });

  if (minShipRate > 0) {
    const before = pool.length;
    pool = pool.filter((p) => attrValue(p.config, "shipRate") >= minShipRate);
    console.error(`Pool filtered ${before} → ${pool.length} by --min-ship-rate ${minShipRate}`);
  }

  // Truncate to top-K by external WR if pool exceeds cap — otherwise the
  // N×N internal H2H becomes prohibitively expensive (N=200 → 240k matches).
  if (pool.length > poolCap) {
    const before = pool.length;
    pool = pool.slice().sort((a, b) => b.wr - a.wr).slice(0, poolCap);
    console.error(`Pool truncated ${before} → ${pool.length} by external WR (--poolCap ${poolCap})`);
  }

  const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n as keyof typeof STRATEGIES]);
  const stages = Object.values(STAGES);
  console.error(
    `Selector: stallWeight=${selectorOpts.stallWeight} drawWeight=${selectorOpts.drawWeight} ` +
    `minLift=${selectorOpts.minLift} minLiftCount=${selectorOpts.minLiftCount} internalSeeds=${internalSeeds}`,
  );

  console.error(`Pool: ${pool.length} candidates. Computing external signatures (vs named meta)...`);
  const extSigs = await computeSignatures({
    candidates: pool.map((p) => p.config),
    references: refs,
    stages,
    seedsPerMatchup: 2,
    workers,
  });
  const extMap = new Map(extSigs.map((s) => [s.id, s]));
  for (const p of pool) p.externalSignature = extMap.get(p.config.id);

  console.error(`Computing internal signatures + stalls (pool × pool, ~${pool.length * (pool.length - 1)} matchups)...`);
  await computeInternalSignaturesAndStalls({
    candidates: pool,
    stages,
    seedsPerMatchup: internalSeeds,
    workers,
  });

  console.error(`Starting annealing: ${iterations} iterations over ${pool.length}C16 subsets...`);
  const result = selectAnnealing(pool, iterations, null, selectorOpts);

  console.log(`\n# Roster selection — ${iterations} annealing iterations\n`);
  console.log(`## Selected roster\n`);
  for (const r of result.roster) {
    const d = computeDescriptors(r.config);
    console.log(`  ${r.id.padEnd(14)}  wr=${(r.wr * 100).toFixed(1)}%  ` +
      `agg=${d.aggression.toFixed(2)} def=${d.defense.toFixed(2)} ` +
      `del=${d.delivery.toFixed(2)} chaos=${d.chaos.toFixed(2)}`);
  }
  console.log(`\n## Fitness breakdown`);
  console.log(`  externalStrength:    ${result.eval.externalStrength.toFixed(3)}`);
  console.log(`  attributeCoverage:   ${result.eval.attributeCoverage.toFixed(3)}`);
  console.log(`  signatureDiversity:  ${result.eval.signatureDiversity.toFixed(3)}`);
  console.log(`  counterCoverage:     ${result.eval.counterCoverage}  (target ≥2)`);
  console.log(`  cycleDensity:        ${result.eval.cycleDensity}`);
  console.log(`  longRate:            ${(result.eval.longRate * 100).toFixed(1)}%`);
  console.log(`  drawRate:            ${(result.eval.drawRate * 100).toFixed(1)}%`);
  console.log(`  stallPenalty:        ${result.eval.stallPenalty.toFixed(3)}`);
  console.log(`  liftCount:           ${result.eval.liftCount}  (target ≥${selectorOpts.minLiftCount} @ lift≥${selectorOpts.minLift})`);
  console.log(`  liftFloorPenalty:    ${result.eval.liftFloorPenalty.toFixed(3)}`);
  console.log(`  dominancePenalty:    ${result.eval.dominancePenalty.toFixed(3)}`);
  console.log(`  clonePenalty:        ${result.eval.clonePenalty.toFixed(3)}`);
  console.log(`  zeroCounterPenalty:  ${result.eval.zeroCounterPenalty.toFixed(3)}`);
  console.log(`  TOTAL fitness:       ${result.eval.fitness.toFixed(3)}`);

  fs.writeFileSync(outPath, JSON.stringify({
    selectedAt: new Date().toISOString(),
    roster: result.roster.map((r) => ({
      id: r.id,
      config: r.config,
      wr: r.wr,
    })),
    eval: result.eval,
    selector: {
      ...selectorOpts,
      minShipRate,
      internalSeeds,
      longThresholdTicks: LONG_THRESHOLD_TICKS,
    },
    historyTail: result.history.slice(-50),
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
