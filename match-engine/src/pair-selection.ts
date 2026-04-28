// Pair selection: pick two stables to fight, prefer ELO-close pairings,
// upweight scarce humans as pivots. Pure function — caller provides the
// active pool, this returns a chosen pair or null when the pool is too
// small.
//
// Mirrors the legacy firehose.findPair behavior so cutover preserves the
// same matchmaking feel.

import type { BrainConfig } from "@m3t4/sim";

export interface StableSummary {
  userId: string;
  handle: string;
  slotId: string;
  slotName: string;
  config: BrainConfig;
  elo: number;
  isHuman: boolean;
  lastPlayedAt: number;
}

export interface SelectPairOptions {
  active: StableSummary[];
  // ELO tolerance; pairs above this are still allowed but penalised.
  toleranceElo?: number;
}

export interface SelectedPair {
  a: StableSummary;
  b: StableSummary;
  rawDelta: number;
}

const DEFAULT_TOLERANCE = 200;
const HUMAN_PIVOT_BIAS = 4;

export function selectPair(opts: SelectPairOptions): SelectedPair | null {
  const entries = opts.active.slice();
  if (entries.length < 2) return null;

  const tolerance = opts.toleranceElo ?? DEFAULT_TOLERANCE;
  const humanCount = entries.filter((e) => e.isHuman).length;
  const sysCount = entries.length - humanCount;

  // Sort by ELO ascending so close-ELO pairs are adjacent in index space.
  entries.sort((x, y) => x.elo - y.elo);

  // Choose pivot: bias toward humans when humans are scarce so early
  // streams show human-vs-system instead of mostly sys-vs-sys filler.
  const pivotIdx = choosePivotIndex(entries, humanCount, sysCount);
  const pivot = entries[pivotIdx];

  let best: StableSummary | null = null;
  let bestRawDelta = Infinity;
  let bestEffectiveDelta = Infinity;
  const pivotHuman = pivot.isHuman;

  for (let i = 0; i < entries.length; i++) {
    if (i === pivotIdx) continue;
    const candidate = entries[i];
    if (candidate.userId === pivot.userId) continue;
    const rawDelta = Math.abs(candidate.elo - pivot.elo);
    if (rawDelta > tolerance && best !== null) continue;
    let effective = rawDelta;
    // Penalise human-vs-human stomping by giving system pairings a small
    // discount when humans are dense; otherwise prefer human-vs-system.
    if (pivotHuman && candidate.isHuman) effective += 50;
    if (!pivotHuman && !candidate.isHuman) effective += 20;
    if (effective < bestEffectiveDelta) {
      best = candidate;
      bestRawDelta = rawDelta;
      bestEffectiveDelta = effective;
    }
  }

  if (!best) return null;
  return { a: pivot, b: best, rawDelta: bestRawDelta };
}

function choosePivotIndex(entries: StableSummary[], humanCount: number, sysCount: number): number {
  if (humanCount === 0 || sysCount === 0) {
    return Math.floor(Math.random() * entries.length);
  }
  const wantHumanPivot = Math.random() < (HUMAN_PIVOT_BIAS / (HUMAN_PIVOT_BIAS + 1));
  const filtered = wantHumanPivot
    ? entries.filter((e) => e.isHuman)
    : entries.filter((e) => !e.isHuman);
  if (!filtered.length) return Math.floor(Math.random() * entries.length);
  const pick = filtered[Math.floor(Math.random() * filtered.length)];
  return entries.indexOf(pick);
}

// Ranked side-swap: given a deterministic seed, decide whether to flip A/B
// so neither slot has a side-of-stage advantage across matches.
export function rankedSideSwap(seed: number): boolean {
  // FNV-style mix to spread bits, then pick low bit.
  let x = seed >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return (x & 1) === 1;
}
