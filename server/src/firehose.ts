// Continuous firehose matchmaker. Pulls pairs from the active stable pool
// by ELO proximity; never idle. Plays matches sequentially on a single
// sim worker; broadcasts frames via WebSocket.

import { simulateTrace, STAGES, STEP } from "@m3t4/sim";
import type { WebSocket } from "ws";
import { CONFIG } from "./config.js";
import type { StableStore, Stable, Slot } from "./stable.js";
import { updatePair } from "./elo.js";

export interface Client {
  ws: WebSocket;
  id: number;
}

export interface ServerEvent {
  type: string;
  [k: string]: unknown;
}

export class Firehose {
  private clients = new Set<Client>();
  private nextClientId = 1;
  private stages = Object.values(STAGES);
  private running = false;
  private currentMatch: {
    matchId: string;
    a: { userId: string; handle: string; slotId: string; name: string; elo: number };
    b: { userId: string; handle: string; slotId: string; name: string; elo: number };
    stageId: string;
  } | null = null;

  constructor(private store: StableStore) {}

  addClient(ws: WebSocket): Client {
    const c: Client = { ws, id: this.nextClientId++ };
    this.clients.add(c);
    if (this.currentMatch) {
      this.sendTo(c, { type: "matchInProgress", match: this.currentMatch });
    }
    return c;
  }
  removeClient(c: Client): void { this.clients.delete(c); }

  private sendTo(c: Client, ev: ServerEvent): void {
    try { c.ws.send(JSON.stringify(ev)); } catch { /* ignore */ }
  }
  private broadcast(ev: ServerEvent): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) { try { c.ws.send(data); } catch { /* ignore */ } }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      try {
        const pair = await this.findPair();
        if (!pair) { await sleep(CONFIG.cycleMs); continue; }
        await this.runMatch(pair);
      } catch (e) {
        console.error("[firehose] error:", e);
        await sleep(2000);
      }
      await sleep(CONFIG.cycleMs);
    }
  }

  stop(): void { this.running = false; }

  // Close-ELO pairing. Walks active pool sorted by ELO, pairs each with
  // nearest unpaired neighbor within tolerance. Returns one pair at a time.
  private async findPair(): Promise<{
    a: Stable; aSlot: Slot; b: Stable; bSlot: Slot; stageId: string;
  } | null> {
    const active = await this.store.listActive(CONFIG.activePoolMs);
    // Each stable contributes one randomly-chosen slot for matchmaking
    const entries: Array<{ st: Stable; slot: Slot }> = active.flatMap((st) => {
      if (st.slots.length === 0) return [];
      const slot = st.slots[Math.floor(Math.random() * st.slots.length)];
      return [{ st, slot }];
    });
    if (entries.length < 2) return null;

    // Sort by ELO
    entries.sort((x, y) => x.slot.elo - y.slot.elo);
    // Pick a random pivot, find its ELO-closest partner within tolerance
    const pivotIdx = Math.floor(Math.random() * entries.length);
    const pivot = entries[pivotIdx];
    let best: typeof entries[0] | null = null;
    let bestDelta = Infinity;
    for (let i = 0; i < entries.length; i++) {
      if (i === pivotIdx) continue;
      const delta = Math.abs(entries[i].slot.elo - pivot.slot.elo);
      if (delta > CONFIG.eloToleranceMax) continue;
      if (delta < bestDelta) { bestDelta = delta; best = entries[i]; }
    }
    if (!best || bestDelta > CONFIG.eloTolerance && entries.length > 8) {
      // Loose tolerance only for small pools
      return null;
    }
    const stage = this.stages[Math.floor(Math.random() * this.stages.length)];
    return { a: pivot.st, aSlot: pivot.slot, b: best.st, bSlot: best.slot, stageId: stage.id };
  }

  private async runMatch(p: {
    a: Stable; aSlot: Slot; b: Stable; bSlot: Slot; stageId: string;
  }): Promise<void> {
    const matchId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const stage = STAGES[p.stageId as keyof typeof STAGES];
    const seed = (Date.now() ^ (p.aSlot.elo << 3) ^ p.bSlot.elo) >>> 0;
    this.currentMatch = {
      matchId,
      a: { userId: p.a.userId, handle: p.a.handle, slotId: p.aSlot.slotId, name: p.aSlot.name, elo: p.aSlot.elo },
      b: { userId: p.b.userId, handle: p.b.handle, slotId: p.bSlot.slotId, name: p.bSlot.name, elo: p.bSlot.elo },
      stageId: p.stageId,
    };

    this.broadcast({
      type: "matchStart",
      match: this.currentMatch,
      seed,
    });

    // Simulate (server-authoritative)
    const trace = simulateTrace({ stage, brainA: p.aSlot.config, brainB: p.bSlot.config, seed });

    // Stream trace frames at ~real-time pacing. FAST_PLAYBACK=1 strips
    // the delays — useful for dev iteration, never enable in production.
    const fast = process.env.FAST_PLAYBACK === "1";
    const STRIDE = 3; // broadcast every 3 ticks (~40 fps)
    for (let i = 0; i < trace.frames.length; i += STRIDE) {
      const chunk = trace.frames.slice(i, i + STRIDE);
      this.broadcast({ type: "frames", matchId, frames: chunk });
      if (!fast) await sleep((STRIDE * 1000) / 120);
    }

    // ELO + score update
    const { a: newA, b: newB } = updatePair(p.aSlot.elo, p.bSlot.elo, trace.result.winner);
    const now = Date.now();
    await this.store.updateAfterMatch({
      aUserId: p.a.userId, aSlotId: p.aSlot.slotId, aEloBefore: p.aSlot.elo, aEloAfter: newA,
      bUserId: p.b.userId, bSlotId: p.bSlot.slotId, bEloBefore: p.bSlot.elo, bEloAfter: newB,
      winner: trace.result.winner,
      playedAt: now,
    });

    this.broadcast({
      type: "matchEnd",
      matchId,
      winner: trace.result.winner,
      finalScore: trace.result.finalScore,
      finalRounds: trace.result.finalRounds,
      logHash: trace.result.logHash,
      eloBefore: [p.aSlot.elo, p.bSlot.elo],
      eloAfter: [newA, newB],
    });
    this.currentMatch = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
