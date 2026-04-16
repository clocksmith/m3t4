// NSGA-II selection. Given a pool of records (with multiple objectives),
// partition into non-dominated fronts, compute crowding distance within
// each front, and expose a tournament selector.
//
// Objectives (higher = better):
//   - winRate
//   - avgScoreDiff
//   - -avgTicks        (faster conclusions preferred)
//   - deliveryCount
//   - novelty          (optional — from novelty.ts archive)
//
// Selection protocol: binary tournament — pick two random candidates,
// return the one in the earlier Pareto tier; if tied, return the one with
// higher crowding distance.

import type { ScoreRecord } from "./score.js";

export interface NSGAOptions {
  novelty?: Map<string, number>;
}

export interface NSGARecord {
  id: string;
  fronts: number;   // which Pareto tier (0 = best)
  crowding: number; // crowding distance within tier
  raw: ScoreRecord;
}

function objectives(r: ScoreRecord, novelty?: number): number[] {
  return [
    r.winRate,
    r.avgScoreDiff,
    -r.avgTicks,
    r.deliveryCount,
    ...(novelty !== undefined ? [novelty] : []),
  ];
}

function dominates(a: number[], b: number[]): boolean {
  let strictlyBetter = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return false;
    if (a[i] > b[i]) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function nonDominatedSort(records: ScoreRecord[], opts: NSGAOptions = {}): NSGARecord[] {
  const n = records.length;
  const objs = records.map((r) => objectives(r, opts.novelty?.get(r.id)));

  const dominatedBy: number[][] = Array.from({ length: n }, () => []);
  const domCount: number[] = new Array(n).fill(0);
  const fronts: number[][] = [[]];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (dominates(objs[i], objs[j])) dominatedBy[i].push(j);
      else if (dominates(objs[j], objs[i])) domCount[i]++;
    }
    if (domCount[i] === 0) fronts[0].push(i);
  }

  let fi = 0;
  while (fronts[fi].length > 0) {
    const next: number[] = [];
    for (const p of fronts[fi]) {
      for (const q of dominatedBy[p]) {
        domCount[q]--;
        if (domCount[q] === 0) next.push(q);
      }
    }
    fi++;
    fronts.push(next);
  }
  fronts.pop(); // last empty

  // Crowding distance per front: sum of normalized gap between neighbors
  // in each objective dimension. Extremes get Infinity (always preferred).
  const numObjs = objs[0].length;
  const crowding: number[] = new Array(n).fill(0);
  for (const front of fronts) {
    if (front.length === 0) continue;
    for (let o = 0; o < numObjs; o++) {
      const sorted = front.slice().sort((a, b) => objs[a][o] - objs[b][o]);
      const minV = objs[sorted[0]][o];
      const maxV = objs[sorted[sorted.length - 1]][o];
      const range = maxV - minV || 1;
      crowding[sorted[0]] = Infinity;
      crowding[sorted[sorted.length - 1]] = Infinity;
      for (let k = 1; k < sorted.length - 1; k++) {
        crowding[sorted[k]] += (objs[sorted[k + 1]][o] - objs[sorted[k - 1]][o]) / range;
      }
    }
  }

  const tierByIndex: number[] = new Array(n).fill(-1);
  for (let fi2 = 0; fi2 < fronts.length; fi2++) {
    for (const idx of fronts[fi2]) tierByIndex[idx] = fi2;
  }

  return records.map((r, i) => ({
    id: r.id,
    fronts: tierByIndex[i],
    crowding: crowding[i],
    raw: r,
  }));
}

// Binary tournament. Returns the id of the selected record's original config.
export function tournamentSelect(ranked: NSGARecord[]): NSGARecord {
  const a = ranked[Math.floor(Math.random() * ranked.length)];
  const b = ranked[Math.floor(Math.random() * ranked.length)];
  if (a.fronts < b.fronts) return a;
  if (b.fronts < a.fronts) return b;
  return a.crowding > b.crowding ? a : b;
}
