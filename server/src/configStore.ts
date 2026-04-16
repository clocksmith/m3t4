// Config persistence. Uses a plain JSON file on disk for now; swap in
// Firestore by implementing this same interface against the Firebase SDK.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BrainConfig } from "@selfplay/sim";
import { compileBrain, STRATEGIES } from "@selfplay/sim";

export interface StoredConfig {
  hash: string;
  submittedAt: number;
  config: BrainConfig;
  author?: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
}

export class ConfigStore {
  private path: string;
  private data: Record<string, StoredConfig> = {};

  constructor(storePath: string) {
    this.path = storePath;
    if (fs.existsSync(storePath)) {
      this.data = JSON.parse(fs.readFileSync(storePath, "utf8"));
    } else {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      for (const name of Object.keys(STRATEGIES)) {
        const cfg = STRATEGIES[name as keyof typeof STRATEGIES];
        this.submit(cfg, { author: "system" });
      }
      this.flush();
    }
  }

  private flush(): void {
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  submit(config: BrainConfig, meta: { author?: string } = {}): StoredConfig {
    compileBrain(config); // throws on DSL error
    const json = JSON.stringify(config.attributes);
    const hash = crypto.createHash("sha1").update(json).digest("hex").slice(0, 12);
    const stored: StoredConfig = {
      hash,
      submittedAt: Date.now(),
      config: { ...config, id: config.id || hash },
      author: meta.author,
      elo: 1000,
      wins: 0,
      losses: 0,
      draws: 0,
    };
    this.data[stored.config.id] = stored;
    this.flush();
    return stored;
  }

  get(id: string): StoredConfig | undefined {
    return this.data[id];
  }

  list(): StoredConfig[] {
    return Object.values(this.data);
  }

  leaderboard(limit = 25): StoredConfig[] {
    return this.list()
      .sort((a, b) => b.elo - a.elo)
      .slice(0, limit);
  }

  recordMatch(aId: string, bId: string, winner: 0 | 1 | -1): void {
    const a = this.data[aId];
    const b = this.data[bId];
    if (!a || !b) return;
    const K = 16;
    const expA = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
    const expB = 1 - expA;
    const scoreA = winner === 0 ? 1 : winner === 1 ? 0 : 0.5;
    const scoreB = 1 - scoreA;
    a.elo = Math.round(a.elo + K * (scoreA - expA));
    b.elo = Math.round(b.elo + K * (scoreB - expB));
    if (winner === 0) { a.wins++; b.losses++; }
    else if (winner === 1) { b.wins++; a.losses++; }
    else { a.draws++; b.draws++; }
    this.flush();
  }
}
