import type { ScoreRecord } from "./score.js";

// Pareto frontier: a record is on the frontier if no other record dominates
// it on ALL chosen objectives. Higher is better for each.

const OBJECTIVES: Array<(r: ScoreRecord) => number> = [
  (r) => r.winRate,
  (r) => r.avgScoreDiff,
  (r) => -r.avgTicks, // faster matches = better
  (r) => r.deliveryCount,
];

function dominates(a: ScoreRecord, b: ScoreRecord): boolean {
  let anyStrictlyBetter = false;
  for (const obj of OBJECTIVES) {
    const va = obj(a);
    const vb = obj(b);
    if (va < vb) return false;
    if (va > vb) anyStrictlyBetter = true;
  }
  return anyStrictlyBetter;
}

export function paretoFrontier(records: ScoreRecord[]): ScoreRecord[] {
  const frontier: ScoreRecord[] = [];
  for (const r of records) {
    let dominated = false;
    for (const other of records) {
      if (other === r) continue;
      if (dominates(other, r)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) frontier.push(r);
  }
  return frontier.sort((a, b) => b.winRate - a.winRate);
}
