// Hall of Fame. A persistent JSON archive of top bots across runs.
// Subsequent runs can use the HOF as an opponent pool to lift the meta
// instead of always training against the same 12 named strategies.

import fs from "node:fs";
import path from "node:path";
import type { BrainConfig } from "@selfplay/sim";

export interface HOFEntry {
  id: string;
  addedAt: string;
  source: string;    // e.g. "evolve-gen5", "refine-moonshot", "overnight-2025-..."
  score: number;     // last measured win-rate (0..1)
  config: BrainConfig;
}

export class HallOfFame {
  private readonly filePath: string;
  private entries: HOFEntry[] = [];
  private max: number;

  constructor(filePath: string, max = 200) {
    this.filePath = filePath;
    this.max = max;
    if (fs.existsSync(filePath)) {
      try { this.entries = JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch { this.entries = []; }
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
  }

  size(): number { return this.entries.length; }

  /** Top-N entries by score. */
  top(n: number): HOFEntry[] {
    return this.entries.slice().sort((a, b) => b.score - a.score).slice(0, n);
  }

  /** Random-N sample from the HOF (for diverse opponent pools). */
  sample(n: number): HOFEntry[] {
    const pool = this.entries.slice();
    const out: HOFEntry[] = [];
    while (out.length < n && pool.length > 0) {
      const i = Math.floor(Math.random() * pool.length);
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  /** Opponent pool = top-K by score + random-R for diversity. */
  opponents(topK: number, randomR: number): BrainConfig[] {
    const top = this.top(topK);
    const seen = new Set(top.map((t) => t.id));
    const random = this.entries
      .filter((e) => !seen.has(e.id))
      .sort(() => Math.random() - 0.5)
      .slice(0, randomR);
    return [...top, ...random].map((e) => e.config);
  }

  /** Add an entry. Returns true if added (and not dropped for being weak). */
  add(cfg: BrainConfig, score: number, source: string): boolean {
    // De-dupe by id: if already present with lower score, update; else skip.
    const existingIdx = this.entries.findIndex((e) => e.id === cfg.id);
    if (existingIdx >= 0) {
      if (this.entries[existingIdx].score >= score) return false;
      this.entries[existingIdx] = {
        id: cfg.id,
        addedAt: new Date().toISOString(),
        source, score, config: cfg,
      };
      this.flush();
      return true;
    }
    // If at cap, only add if score beats the weakest.
    if (this.entries.length >= this.max) {
      const weakestIdx = this.entries
        .map((e, i) => ({ s: e.score, i }))
        .sort((a, b) => a.s - b.s)[0].i;
      if (this.entries[weakestIdx].score >= score) return false;
      this.entries.splice(weakestIdx, 1);
    }
    this.entries.push({
      id: cfg.id,
      addedAt: new Date().toISOString(),
      source, score, config: cfg,
    });
    this.flush();
    return true;
  }

  /** Wipe. Useful when seasons change. */
  clear(): void { this.entries = []; this.flush(); }

  list(): HOFEntry[] { return this.entries.slice(); }

  private flush(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }
}
