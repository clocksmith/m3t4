// Continuous firehose matchmaker. Pulls pairs from the active stable pool
// by ELO proximity; never idle. Plays matches sequentially on a single
// sim worker; broadcasts frames via WebSocket.

import {
  DEFAULT_CHARS,
  createReplayArtifactV1,
  replayArtifactToResultV1,
  REPLAY_CONSTANTS_HASH as SIM_CONSTANTS_HASH,
  simulateTrace,
  STAGES,
} from "@m3t4/sim";
import type { WebSocket } from "ws";
import { CONFIG } from "./config.js";
import type { StableStore, Stable, Slot } from "./stable.js";
import { updatePair } from "./elo.js";
import { shouldLogWatchlist, summarizeWatchlistMatch, watchlistTagsForSlot, type WatchlistTag } from "./watchlist.js";

export interface Client {
  ws: WebSocket;
  id: number;
}

export interface ServerEvent {
  type: string;
  [k: string]: unknown;
}

type MatchPair = {
  a: Stable; aSlot: Slot; b: Stable; bSlot: Slot; stageId: string;
};

type PublicMatchPreview = {
  a: { userId: string; handle: string; slotId: string; name: string; elo: number };
  b: { userId: string; handle: string; slotId: string; name: string; elo: number };
  stageId: string;
  eloDelta: number;
};

const HUMAN_PAIR_ELO_BONUS = 75;

export class Firehose {
  private clients = new Set<Client>();
  private nextClientId = 1;
  // Only datacenter is enabled for ranked play. Other stages exist in
  // STAGES for build-mode experimentation but aren't in the meta pool.
  private stages = [STAGES.datacenter];
  private running = false;
  private currentMatch: {
    matchId: string;
    a: { userId: string; handle: string; slotId: string; name: string; elo: number };
    b: { userId: string; handle: string; slotId: string; name: string; elo: number };
    stageId: string;
    watchlist?: { a: WatchlistTag[]; b: WatchlistTag[] };
  } | null = null;
  private currentWait: {
    reason: "cooldown" | "no-pair";
    nextAttemptAt: number;
    intervalMs: number;
    nextMatch?: PublicMatchPreview;
  } | null = null;

  constructor(private store: StableStore) {}

  addClient(ws: WebSocket): Client {
    const c: Client = { ws, id: this.nextClientId++ };
    this.clients.add(c);
    if (this.currentMatch) {
      this.sendTo(c, { type: "matchInProgress", match: this.currentMatch });
    } else if (this.currentWait) {
      this.sendTo(c, { type: "waiting", ...this.currentWait, serverNow: Date.now() });
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
    let pendingPair: MatchPair | null = null;
    while (this.running) {
      try {
        const pair = pendingPair ?? await this.findPair();
        pendingPair = null;
        if (!pair) {
          this.enterWait("no-pair");
          await sleep(CONFIG.cycleMs);
          continue;
        }
        await this.runMatch(pair);
        pendingPair = await this.findPair();
      } catch (e) {
        console.error("[firehose] error:", e);
        await sleep(2000);
      }
      this.enterWait(pendingPair ? "cooldown" : "no-pair", pendingPair);
      await sleep(CONFIG.cycleMs);
    }
  }

  private enterWait(reason: "cooldown" | "no-pair", nextPair: MatchPair | null = null): void {
    const nextAttemptAt = Date.now() + CONFIG.cycleMs;
    const nextMatch = nextPair ? this.previewPair(nextPair) : undefined;
    this.currentWait = { reason, nextAttemptAt, intervalMs: CONFIG.cycleMs, nextMatch };
    this.broadcast({ type: "waiting", reason, nextAttemptAt, intervalMs: CONFIG.cycleMs, nextMatch, serverNow: Date.now() });
  }

  stop(): void { this.running = false; }

  // Close-ELO pairing. Walks active pool sorted by ELO, pairs each with
  // nearest unpaired neighbor within tolerance. Returns one pair at a time.
  private async findPair(): Promise<MatchPair | null> {
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
    let bestRawDelta = Infinity;
    let bestEffectiveDelta = Infinity;
    const pivotHuman = isHumanStable(pivot.st);
    for (let i = 0; i < entries.length; i++) {
      if (i === pivotIdx) continue;
      const rawDelta = Math.abs(entries[i].slot.elo - pivot.slot.elo);
      if (rawDelta > CONFIG.eloToleranceMax) continue;
      const bothHuman = pivotHuman && isHumanStable(entries[i].st);
      const effectiveDelta = rawDelta - (bothHuman ? HUMAN_PAIR_ELO_BONUS : 0);
      if (
        effectiveDelta < bestEffectiveDelta ||
        (effectiveDelta === bestEffectiveDelta && rawDelta < bestRawDelta)
      ) {
        bestEffectiveDelta = effectiveDelta;
        bestRawDelta = rawDelta;
        best = entries[i];
      }
    }
    if (!best || bestEffectiveDelta > CONFIG.eloTolerance && entries.length > 8) {
      // Loose tolerance only for small pools
      return null;
    }
    const stage = this.stages[Math.floor(Math.random() * this.stages.length)];
    return { a: pivot.st, aSlot: pivot.slot, b: best.st, bSlot: best.slot, stageId: stage.id };
  }

  private async runMatch(p: {
    a: Stable; aSlot: Slot; b: Stable; bSlot: Slot; stageId: string;
  }): Promise<void> {
    const startedAt = new Date();
    const matchId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const stage = STAGES[p.stageId as keyof typeof STAGES];
    const seed = (Date.now() ^ (p.aSlot.elo << 3) ^ p.bSlot.elo) >>> 0;
    const watchlistTags = {
      a: watchlistTagsForSlot(p.aSlot),
      b: watchlistTagsForSlot(p.bSlot),
    };
    this.currentMatch = {
      matchId,
      a: { userId: p.a.userId, handle: p.a.handle, slotId: p.aSlot.slotId, name: p.aSlot.name, elo: p.aSlot.elo },
      b: { userId: p.b.userId, handle: p.b.handle, slotId: p.bSlot.slotId, name: p.bSlot.name, elo: p.bSlot.elo },
      stageId: p.stageId,
      watchlist: watchlistTags,
    };
    this.currentWait = null;

    this.broadcast({
      type: "matchStart",
      match: this.currentMatch,
      seed,
    });

    // Simulate (server-authoritative)
    const trace = simulateTrace({ stage, brainA: p.aSlot.config, brainB: p.bSlot.config, seed });
    const replay = createReplayArtifactV1({
      matchId,
      mode: "ranked",
      stage,
      seed,
      startedAt: startedAt.toISOString(),
      players: [
        {
          kind: "brain",
          tier: p.a.userId.startsWith("system:") ? "system" : "user",
          label: p.aSlot.name,
          handle: p.a.handle,
          userId: p.a.userId,
          slotId: p.aSlot.slotId,
          slotName: p.aSlot.name,
          config: p.aSlot.config,
        },
        {
          kind: "brain",
          tier: p.b.userId.startsWith("system:") ? "system" : "user",
          label: p.bSlot.name,
          handle: p.b.handle,
          userId: p.b.userId,
          slotId: p.bSlot.slotId,
          slotName: p.bSlot.name,
          config: p.bSlot.config,
        },
      ],
      chars: DEFAULT_CHARS,
      actionLog: trace.result.frameLog,
      result: trace.result,
      sim: {
        sourceHash: CONFIG.simSourceHash,
        constantsHash: SIM_CONSTANTS_HASH,
      },
    });
    // Decode-verify doubles per-match sim cost. On by default for dev/CI
    // because it catches encoder/decoder drift; disable in throughput-
    // sensitive production runs via REPLAY_VERIFY=0.
    if (process.env.REPLAY_VERIFY !== "0") replayArtifactToResultV1(replay);

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
    const watchlist = summarizeWatchlistMatch(trace.result, watchlistTags);
    if (shouldLogWatchlist(watchlist)) {
      console.log("[watchlist]", JSON.stringify({ matchId, ...watchlist }));
    }
    await this.store.archiveReplay(replay);
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
      replayArchived: true,
      eloBefore: [p.aSlot.elo, p.bSlot.elo],
      eloAfter: [newA, newB],
      watchlist,
    });
    this.currentMatch = null;
  }

  private previewPair(p: MatchPair): PublicMatchPreview {
    return {
      a: { userId: p.a.userId, handle: p.a.handle, slotId: p.aSlot.slotId, name: p.aSlot.name, elo: p.aSlot.elo },
      b: { userId: p.b.userId, handle: p.b.handle, slotId: p.bSlot.slotId, name: p.bSlot.name, elo: p.bSlot.elo },
      stageId: p.stageId,
      eloDelta: Math.abs(p.aSlot.elo - p.bSlot.elo),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isHumanStable(st: Stable): boolean {
  return !st.userId.startsWith("system:");
}
