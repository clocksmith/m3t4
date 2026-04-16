// Every 60 seconds, run a single-elim bracket over 8 randomly chosen configs
// from the store. Broadcast tick-by-tick state to all connected spectators.

import type { WebSocket } from "ws";
import { simulate, STAGES, STEP, type BrainConfig, type Stage } from "@selfplay/sim";
import type { ConfigStore } from "./configStore.js";

// One spectator connection.
export interface Client {
  ws: WebSocket;
  id: number;
}

export interface ServerEvent {
  type: "bracketAnnounce" | "matchStart" | "frame" | "matchEnd" | "bracketEnd";
  [k: string]: unknown;
}

interface RunningBracket {
  cycleId: string;
  stage: Stage;
  entrants: BrainConfig[];
  roundIndex: number;
  pairs: Array<[BrainConfig, BrainConfig]>;
  winners: BrainConfig[];
  matchIndex: number;
}

export class Matchmaker {
  private clients = new Set<Client>();
  private nextClientId = 1;
  private current: RunningBracket | null = null;
  private stages = Object.values(STAGES);

  constructor(private store: ConfigStore) {}

  addClient(ws: WebSocket): Client {
    const c: Client = { ws, id: this.nextClientId++ };
    this.clients.add(c);
    if (this.current) this.sendTo(c, { type: "bracketAnnounce", cycleId: this.current.cycleId, entrants: this.current.entrants.map((e) => e.id), stage: this.current.stage.id });
    return c;
  }

  removeClient(c: Client): void {
    this.clients.delete(c);
  }

  private sendTo(c: Client, ev: ServerEvent): void {
    try { c.ws.send(JSON.stringify(ev)); } catch { /* ignore */ }
  }

  private broadcast(ev: ServerEvent): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) {
      try { c.ws.send(data); } catch { /* ignore */ }
    }
  }

  async startCycle(): Promise<void> {
    const now = Date.now();
    const cycleId = `cyc-${now.toString(36)}`;
    const all = this.store.list();
    // Pick top 6 by ELO + 2 random wild-cards for diversity
    const sorted = all.slice().sort((a, b) => b.elo - a.elo);
    const top = sorted.slice(0, Math.min(6, sorted.length));
    const rest = all.filter((x) => !top.includes(x));
    const wildcards: typeof all = [];
    while (wildcards.length < 2 && rest.length) {
      const i = Math.floor(Math.random() * rest.length);
      wildcards.push(rest.splice(i, 1)[0]);
    }
    const entrants = [...top, ...wildcards].slice(0, 8).map((s) => s.config);
    if (entrants.length < 2) return;

    const stage = this.stages[Math.floor(Math.random() * this.stages.length)];
    const pairs: Array<[BrainConfig, BrainConfig]> = [];
    for (let i = 0; i + 1 < entrants.length; i += 2) {
      pairs.push([entrants[i], entrants[i + 1]]);
    }
    this.current = {
      cycleId, stage, entrants, pairs, winners: [], roundIndex: 0, matchIndex: 0,
    };
    this.broadcast({
      type: "bracketAnnounce",
      cycleId, stage: stage.id,
      entrants: entrants.map((e) => e.id),
      rounds: Math.ceil(Math.log2(entrants.length)),
    });

    await this.runBracket();
    this.broadcast({
      type: "bracketEnd",
      cycleId,
      champion: this.current?.winners[0]?.id ?? null,
    });
    this.current = null;
  }

  private async runBracket(): Promise<void> {
    while (this.current && this.current.pairs.length > 0) {
      const b = this.current;
      for (let i = 0; i < b.pairs.length; i++) {
        const [a, bp] = b.pairs[i];
        await this.runMatch(a, bp, b);
      }
      // Build next round from winners
      const ws = b.winners.slice();
      if (ws.length < 2) break;
      b.roundIndex++;
      b.pairs = [];
      b.winners = [];
      for (let i = 0; i + 1 < ws.length; i += 2) b.pairs.push([ws[i], ws[i + 1]]);
    }
  }

  private async runMatch(a: BrainConfig, b: BrainConfig, bracket: RunningBracket): Promise<void> {
    const seed = (Date.now() ^ bracket.matchIndex * 131) >>> 0;
    this.broadcast({ type: "matchStart", cycleId: bracket.cycleId, roundIndex: bracket.roundIndex, matchIndex: bracket.matchIndex, a: a.id, b: b.id, stage: bracket.stage.id, seed });
    // Run the sim silently first to get the full frame log; then replay at
    // real-time pacing so spectators see it unfold. This guarantees every
    // spectator sees the exact same match.
    const result = simulate({ stage: bracket.stage, brainA: a, brainB: b, seed });
    const totalTicks = result.ticks;
    const log = result.frameLog; // 2 bytes per tick, Action bitmasks
    const startMs = Date.now();
    const CHUNK = 6; // broadcast 6 ticks per 50 ms (≈ 120 Hz playback)
    let t = 0;
    while (t < totalTicks) {
      const stop = Math.min(totalTicks, t + CHUNK);
      const slice = Array.from(log.subarray(t * 2, stop * 2));
      this.broadcast({ type: "frame", cycleId: bracket.cycleId, matchIndex: bracket.matchIndex, tickStart: t, inputs: slice });
      t = stop;
      await new Promise((r) => setTimeout(r, (CHUNK * 1000) / 120));
    }
    const elapsed = Date.now() - startMs;
    this.broadcast({
      type: "matchEnd",
      cycleId: bracket.cycleId,
      matchIndex: bracket.matchIndex,
      winner: result.winner,
      finalScore: result.finalScore,
      finalRounds: result.finalRounds,
      logHash: result.logHash,
      elapsedMs: elapsed,
    });
    bracket.matchIndex++;
    const winner = result.winner === 0 ? a : result.winner === 1 ? b : Math.random() < 0.5 ? a : b;
    bracket.winners.push(winner);
    this.store.recordMatch(a.id, b.id, result.winner);
  }
}
