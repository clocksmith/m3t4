// MAP-Elites candidate bank. Bins candidates by behavioral descriptors
// and keeps the top-K in each bin. Forces coverage of the strategy
// space — so a 51%-WR hard-counter in a rare niche is kept rather
// than discarded by a flat WR filter.
//
// Descriptors (inspired by the plan Phase-1 spec):
//   aggression = burnRate + greed + max(0, spite)
//   defense    = moat/300 + pivotSpeed + cunning
//   delivery   = shipRate + pacing
//   chaos      = hallucination/100 + max(0, 0.5 - foresight/0.25)
//
// Each descriptor binned into 3 levels (low/med/high) → 81 bins total.
// Many bins may be empty; that's diagnostic (rare niches not covered).

import fs from "node:fs";
import type { BrainConfig, ParamKey } from "@m3t4/sim";

export interface BankCandidate {
  config: BrainConfig;
  wr: number;
  // Optional: per-reference row (for counter-value computation)
  matchupRow?: Record<string, number>;
  source?: string;
}

export interface BankCell {
  descriptor: [number, number, number, number]; // [aggression, defense, delivery, chaos]
  key: string;
  candidates: BankCandidate[];
}

export interface CandidateBank {
  cells: Map<string, BankCell>;
  capacityPerCell: number;
  binCount: number;
}

function getScalar(cfg: BrainConfig, k: ParamKey): number {
  const v = cfg.attributes[k];
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "base" in v && typeof v.base === "number") return v.base;
  return 0;
}

export interface Descriptors {
  aggression: number;
  defense: number;
  delivery: number;
  chaos: number;
}

export function computeDescriptors(cfg: BrainConfig): Descriptors {
  const burn = getScalar(cfg, "burnRate");
  const greed = getScalar(cfg, "greed");
  const spite = getScalar(cfg, "spite");
  const moat = getScalar(cfg, "moat") / 300;
  const pivot = getScalar(cfg, "pivotSpeed");
  const cunning = getScalar(cfg, "cunning");
  const shipRate = getScalar(cfg, "shipRate");
  const pacing = getScalar(cfg, "pacing");
  const hall = getScalar(cfg, "hallucination") / 100;
  const foresight = getScalar(cfg, "foresight") / 0.25;
  return {
    aggression: burn + greed + Math.max(0, spite),
    defense: moat + pivot + cunning,
    delivery: shipRate + pacing,
    chaos: hall + Math.max(0, 0.5 - foresight),
  };
}

// Bin thresholds chosen to roughly split the expected range into
// equal thirds given typical budget-legal configs.
const BIN_THRESHOLDS = {
  aggression: [0.8, 1.6],
  defense: [1.0, 2.0],
  delivery: [0.6, 1.3],
  chaos: [0.3, 0.9],
};

export function binDescriptor(value: number, thresholds: [number, number]): 0 | 1 | 2 {
  if (value < thresholds[0]) return 0;
  if (value < thresholds[1]) return 1;
  return 2;
}

export function descriptorBins(d: Descriptors): [number, number, number, number] {
  return [
    binDescriptor(d.aggression, BIN_THRESHOLDS.aggression as [number, number]),
    binDescriptor(d.defense, BIN_THRESHOLDS.defense as [number, number]),
    binDescriptor(d.delivery, BIN_THRESHOLDS.delivery as [number, number]),
    binDescriptor(d.chaos, BIN_THRESHOLDS.chaos as [number, number]),
  ];
}

function cellKey(bins: [number, number, number, number]): string {
  return bins.join(",");
}

export function createBank(capacityPerCell = 3): CandidateBank {
  return { cells: new Map(), capacityPerCell, binCount: 81 };
}

export function addToBank(bank: CandidateBank, cand: BankCandidate): boolean {
  const d = computeDescriptors(cand.config);
  const bins = descriptorBins(d);
  const key = cellKey(bins);
  if (!bank.cells.has(key)) {
    bank.cells.set(key, { descriptor: bins, key, candidates: [] });
  }
  const cell = bank.cells.get(key)!;
  cell.candidates.push(cand);
  cell.candidates.sort((a, b) => b.wr - a.wr);
  if (cell.candidates.length > bank.capacityPerCell) {
    cell.candidates.length = bank.capacityPerCell;
    return cand === cell.candidates[bank.capacityPerCell - 1];
  }
  return true;
}

export function bankToList(bank: CandidateBank): BankCandidate[] {
  const out: BankCandidate[] = [];
  for (const cell of bank.cells.values()) out.push(...cell.candidates);
  return out;
}

export function bankReport(bank: CandidateBank): {
  cellsPopulated: number;
  totalCandidates: number;
  populatedPct: number;
  topPerAxis: Record<string, BankCandidate | null>;
} {
  let totalCandidates = 0;
  for (const cell of bank.cells.values()) totalCandidates += cell.candidates.length;
  const all = bankToList(bank);
  // Extremes: highest single-axis descriptor
  const byAxis = (key: keyof Descriptors): BankCandidate | null => {
    let best: BankCandidate | null = null;
    let bestVal = -Infinity;
    for (const c of all) {
      const d = computeDescriptors(c.config);
      if (d[key] > bestVal) { best = c; bestVal = d[key]; }
    }
    return best;
  };
  return {
    cellsPopulated: bank.cells.size,
    totalCandidates,
    populatedPct: bank.cells.size / bank.binCount,
    topPerAxis: {
      aggression: byAxis("aggression"),
      defense: byAxis("defense"),
      delivery: byAxis("delivery"),
      chaos: byAxis("chaos"),
    },
  };
}

// ----- CLI: analyze an existing HOF/roster JSON -----

function parseArgs(argv: string[]): { input?: string; out?: string } {
  const out: { input?: string; out?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) out.input = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error("Usage: candidate-bank --input <roster-or-hof.json> [--out bank.json]");
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const items = Array.isArray(raw) ? raw : (raw.roster ?? raw.hof ?? []);

  const bank = createBank(3);
  for (const r of items) {
    const cfg = r.config ?? (r.attributes ? { id: r.id, attributes: r.attributes } : null);
    if (!cfg) continue;
    const wr = r.wr ?? r.internalWr ?? r.winRate ?? 0;
    addToBank(bank, { config: cfg, wr, source: r.origIdx !== undefined ? `r${r.origIdx}` : r.id });
  }

  const report = bankReport(bank);
  console.log(`# Candidate bank — MAP-Elites coverage\n`);
  console.log(`## Summary`);
  console.log(`  input: ${args.input}  (${items.length} candidates)`);
  console.log(`  cells populated: ${report.cellsPopulated} / ${bank.binCount} (${(report.populatedPct * 100).toFixed(0)}%)`);
  console.log(`  total stored: ${report.totalCandidates}`);
  console.log();
  console.log(`## Axis extremes (highest descriptor value per axis)`);
  for (const [axis, cand] of Object.entries(report.topPerAxis)) {
    if (!cand) { console.log(`  ${axis.padEnd(11)} —`); continue; }
    const d = computeDescriptors(cand.config);
    const axisValue = (d as unknown as Record<string, number>)[axis];
    console.log(`  ${axis.padEnd(11)}  ${cand.source ?? cand.config.id}  wr=${(cand.wr * 100).toFixed(1)}%  ${axis}=${axisValue.toFixed(2)}`);
  }
  console.log();
  console.log(`## Empty bins (niches no candidate occupies — potential hard-counter slots)`);
  const emptyBins: string[] = [];
  for (let a = 0; a < 3; a++) for (let d = 0; d < 3; d++) for (let dv = 0; dv < 3; dv++) for (let c = 0; c < 3; c++) {
    const key = `${a},${d},${dv},${c}`;
    if (!bank.cells.has(key)) emptyBins.push(key);
  }
  const label = (v: number) => ["low", "med", "high"][v];
  if (emptyBins.length > 20) {
    console.log(`  ${emptyBins.length} empty bins (too many to list); roster covers only ${bank.cells.size} of 81 niches`);
  } else {
    for (const k of emptyBins) {
      const [a, d, dv, c] = k.split(",").map(Number);
      console.log(`  aggression=${label(a)} defense=${label(d)} delivery=${label(dv)} chaos=${label(c)}`);
    }
  }

  if (args.out) {
    const bankData = {
      capacityPerCell: bank.capacityPerCell,
      cells: Array.from(bank.cells.values()),
    };
    fs.writeFileSync(args.out, JSON.stringify(bankData, null, 2));
    console.log(`\nWrote bank to ${args.out}`);
  }
}
