// Novelty search: reward configs that are DIFFERENT from past frontier
// members in attribute space. The archive accumulates across generations.
//
// A config's novelty = mean distance to its k nearest neighbors in archive.
// This is the classic Lehman-Stanley novelty search metric.

import type { BrainConfig, ParamKey } from "@m3t4/sim";
import { DEFAULT_PARAMS, PARAM_KEYS, RANGES } from "@m3t4/sim";

export interface NoveltyConfig {
  k?: number;              // neighbors used in distance average
  archiveMax?: number;     // hard cap on archive size
  minNovelty?: number;     // threshold below which configs are NOT archived
}

// Produce a fixed-length attribute vector for a config, normalized to [0,1]
// per-knob so distance comparisons are scale-free.
export function featureVector(cfg: BrainConfig): number[] {
  const out: number[] = new Array(PARAM_KEYS.length);
  for (let i = 0; i < PARAM_KEYS.length; i++) {
    const k = PARAM_KEYS[i];
    const v = cfg.attributes[k];
    let n: number;
    if (typeof v === "number") n = v;
    else if (v && typeof v === "object" && "base" in v && typeof v.base === "number") n = v.base;
    else if (typeof v === "string") n = DEFAULT_PARAMS[k]; // DSL — defer to default
    else n = DEFAULT_PARAMS[k];
    const [lo, hi] = RANGES[k];
    out[i] = (n - lo) / (hi - lo);
  }
  return out;
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

export class NoveltyArchive {
  private items: Array<{ id: string; vec: number[] }> = [];
  private k: number;
  private max: number;
  private threshold: number;

  constructor(cfg: NoveltyConfig = {}) {
    this.k = cfg.k ?? 8;
    this.max = cfg.archiveMax ?? 300;
    this.threshold = cfg.minNovelty ?? 0.1;
  }

  // Novelty score in [0, sqrt(d)] where d is vector length. Higher = more novel.
  noveltyOf(cfg: BrainConfig): number {
    const vec = featureVector(cfg);
    if (this.items.length === 0) return 1; // first in archive → maximally novel
    const dists = this.items.map((a) => dist(vec, a.vec)).sort((x, y) => x - y);
    const k = Math.min(this.k, dists.length);
    let sum = 0;
    for (let i = 0; i < k; i++) sum += dists[i];
    return sum / k;
  }

  // Add to archive if novelty exceeds threshold. Evicts oldest if at cap.
  maybeAdd(cfg: BrainConfig): boolean {
    const n = this.noveltyOf(cfg);
    if (this.items.length > 0 && n < this.threshold) return false;
    const vec = featureVector(cfg);
    this.items.push({ id: cfg.id, vec });
    if (this.items.length > this.max) this.items.shift();
    return true;
  }

  size(): number { return this.items.length; }

  // Export for save/load between runs
  toJSON(): Array<{ id: string; vec: number[] }> {
    return this.items.slice();
  }

  static fromJSON(data: Array<{ id: string; vec: number[] }>, cfg: NoveltyConfig = {}): NoveltyArchive {
    const arc = new NoveltyArchive(cfg);
    arc.items = data.slice();
    return arc;
  }
}

// Combined scalar score for (win rate) + λ × (novelty). Useful when you
// want a single objective for tournament selection while still rewarding
// diversity.
export function fitnessWithNovelty(winRate: number, novelty: number, lambda = 0.3): number {
  return winRate + lambda * novelty;
}
