// Continuous firehose matchmaker. Pulls pairs from the active stable pool
// by ELO proximity; never idle. Plays matches sequentially on a single
// sim worker; broadcasts frames via WebSocket.

import {
  createReplayArtifactV1,
  replayArtifactToResultV1,
  REPLAY_CONSTANTS_HASH as SIM_CONSTANTS_HASH,
  simulateTrace,
  STAGES,
} from "@m3t4/sim";
import type { WebSocket } from "ws";
import { CONFIG } from "./config.js";
import { activeRosterSlots, charsForSlots, slotCosmetics, type StableStore, type Stable, type Slot, type SlotCosmetics } from "./stable.js";
import { updatePair } from "./elo.js";
import { shouldLogWatchlist, summarizeWatchlistMatch, watchlistTagsForSlot, type WatchlistTag } from "./watchlist.js";
import { isHumanStable, matchmakerPressure, type MatchmakerPressure } from "./matchmaker-pressure.js";
import { seedReplayComputeTasks } from "./compute/auto-seed.js";

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

type SideEntrant = {
  stable: Stable;
  slot: Slot;
};

type PublicMatchPreview = {
  a: { userId: string; handle: string; slotId: string; name: string; elo: number; cosmetics: SlotCosmetics };
  b: { userId: string; handle: string; slotId: string; name: string; elo: number; cosmetics: SlotCosmetics };
  stageId: string;
  eloDelta: number;
};

const HUMAN_PIVOT_TARGETS = [
  { maxHumans: 3, target: 0.55 },
  { maxHumans: 7, target: 0.60 },
  { maxHumans: 15, target: 0.65 },
];
const MAX_HUMAN_PIVOT_TARGET = 0.85;
const HUMAN_SYS_ELO_BONUS_MAX = 150;
const HUMAN_SYS_ELO_BONUS_DECAY_PER_HUMAN = 5;
const HUMAN_PAIR_ELO_BONUS_BASE = 40;
const HUMAN_PAIR_ELO_BONUS_PER_HUMAN = 5;
const HUMAN_PAIR_ELO_BONUS_MAX = 200;
const LEAST_RECENTLY_PLAYED_BONUS = 25;
const RECENTLY_PLAYED_WINDOW_MS = 10 * 60 * 1000;

function mix32(x: number): number {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export function rankedSideSwap(seed: number): boolean {
  return (mix32((seed >>> 0) ^ 0x51de5eed) & 1) === 1;
}

function publicSlot(entry: SideEntrant, side: 0 | 1): PublicMatchPreview["a"] {
  return {
    userId: entry.stable.userId,
    handle: entry.stable.handle,
    slotId: entry.slot.slotId,
    name: entry.slot.name,
    elo: entry.slot.elo,
    cosmetics: slotCosmetics(entry.slot, side),
  };
}

export class Firehose {
  private clients = new Set<Client>();
  private nextClientId = 1;
  // All three arenas are in the meta pool. Visually they share the
  // datacenter asset pack with subtle filters to differentiate
  // (client/lib/render.js STAGE_ASSETS). Platform layouts differ.
  // demoday is removed from ranked rotation for now — datacenter +
  // boardroom only. Stage still exists in STAGES for build-mode use.
  private stages = [STAGES.datacenter, STAGES.boardroom];
  private running = false;
  private currentMatch: {
    matchId: string;
    a: PublicMatchPreview["a"];
    b: PublicMatchPreview["b"];
    stageId: string;
    sideSwap?: boolean;
    watchlist?: { a: WatchlistTag[]; b: WatchlistTag[] };
  } | null = null;
  private currentWait: {
    reason: "cooldown" | "no-pair";
    nextAttemptAt: number;
    intervalMs: number;
    rankedMode: MatchmakerPressure["rankedMode"];
    nextMatch?: PublicMatchPreview;
  } | null = null;
  private effectiveCycleMs = CONFIG.cycleMs;
  private rankedMode: MatchmakerPressure["rankedMode"] = "normal";

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
  clientCount(): number { return this.clients.size; }
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
          await this.sleepWithHeartbeat(this.effectiveCycleMs);
          continue;
        }
        await this.runMatch(pair);
        pendingPair = await this.findPair();
      } catch (e) {
        console.error("[firehose] error:", e);
        await sleep(2000);
      }
      this.enterWait(pendingPair ? "cooldown" : "no-pair", pendingPair);
      await this.sleepWithHeartbeat(this.effectiveCycleMs);
    }
  }

  // Sleep in short slices and rebroadcast the current waiting state
  // every HEARTBEAT_MS so clients joining mid-cooldown — or that missed
  // the original `waiting` packet — always have an up-to-date
  // nextAttemptAt / serverNow pair to drive their local countdown.
  private async sleepWithHeartbeat(totalMs: number): Promise<void> {
    const HEARTBEAT_MS = 5000;
    const end = Date.now() + totalMs;
    while (Date.now() < end) {
      const remaining = end - Date.now();
      await sleep(Math.min(HEARTBEAT_MS, remaining));
      if (!this.running) return;
      if (this.currentWait && Date.now() < end) {
        this.broadcast({
          type: "waiting",
          reason: this.currentWait.reason,
          nextAttemptAt: this.currentWait.nextAttemptAt,
          intervalMs: this.currentWait.intervalMs,
          rankedMode: this.currentWait.rankedMode,
          nextMatch: this.currentWait.nextMatch,
          serverNow: Date.now(),
        });
      }
    }
  }

  private enterWait(reason: "cooldown" | "no-pair", nextPair: MatchPair | null = null): void {
    const intervalMs = this.effectiveCycleMs;
    const nextAttemptAt = Date.now() + intervalMs;
    const nextMatch = nextPair ? this.previewPair(nextPair) : undefined;
    this.currentWait = { reason, nextAttemptAt, intervalMs, rankedMode: this.rankedMode, nextMatch };
    this.broadcast({
      type: "waiting",
      reason,
      nextAttemptAt,
      intervalMs,
      rankedMode: this.rankedMode,
      nextMatch,
      serverNow: Date.now(),
    });
  }

  stop(): void { this.running = false; }

  // Close-ELO pairing. Walks active pool sorted by ELO, pairs each with
  // nearest unpaired neighbor within tolerance. Returns one pair at a time.
  private async findPair(): Promise<MatchPair | null> {
    const active = await this.store.listActive(CONFIG.activePoolMs);
    const pressure = matchmakerPressure(active, CONFIG.cycleMs);
    this.effectiveCycleMs = pressure.effectiveCycleMs;
    this.rankedMode = pressure.rankedMode;
    // Each stable contributes one randomly-chosen slot for matchmaking
    const entries: Array<{ st: Stable; slot: Slot }> = active.flatMap((st) => {
      const slots = activeRosterSlots(st.slots);
      if (slots.length === 0) return [];
      const slot = slots[Math.floor(Math.random() * slots.length)];
      return [{ st, slot }];
    });
    if (entries.length < 2) return null;

    const humanCount = entries.filter((e) => isHumanStable(e.st)).length;
    const sysCount = entries.length - humanCount;

    // Sort by ELO
    entries.sort((x, y) => x.slot.elo - y.slot.elo);
    // Pick a pivot, then find its ELO-closest partner within tolerance.
    // Scarce humans are upweighted as pivots so early public streams show
    // human-vs-sys ladder action instead of mostly sys-vs-sys filler.
    const pivotIdx = choosePivotIndex(entries, humanCount, sysCount);
    const pivot = entries[pivotIdx];
    let best: typeof entries[0] | null = null;
    let bestRawDelta = Infinity;
    let bestEffectiveDelta = Infinity;
    const pivotHuman = isHumanStable(pivot.st);
    for (let i = 0; i < entries.length; i++) {
      if (i === pivotIdx) continue;
      const rawDelta = Math.abs(entries[i].slot.elo - pivot.slot.elo);
      if (rawDelta > CONFIG.eloToleranceMax) continue;
      const candidateHuman = isHumanStable(entries[i].st);
      const effectiveDelta = rawDelta - pairEloBonusForMatchup(pivotHuman, candidateHuman, humanCount);
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
    const sideSwap = rankedSideSwap(seed);
    const sideA: SideEntrant = sideSwap
      ? { stable: p.b, slot: p.bSlot }
      : { stable: p.a, slot: p.aSlot };
    const sideB: SideEntrant = sideSwap
      ? { stable: p.a, slot: p.aSlot }
      : { stable: p.b, slot: p.bSlot };
    const watchlistTags = {
      a: watchlistTagsForSlot(sideA.slot),
      b: watchlistTagsForSlot(sideB.slot),
    };
    this.currentMatch = {
      matchId,
      a: publicSlot(sideA, 0),
      b: publicSlot(sideB, 1),
      stageId: p.stageId,
      sideSwap,
      watchlist: watchlistTags,
    };
    this.currentWait = null;

    this.broadcast({
      type: "matchStart",
      match: this.currentMatch,
      seed,
    });

    // Simulate (server-authoritative)
    const chars = charsForSlots(sideA.slot, sideB.slot);
    const trace = simulateTrace({ stage, brainA: sideA.slot.config, brainB: sideB.slot.config, seed, chars });
    const replay = createReplayArtifactV1({
      matchId,
      mode: "ranked",
      stage,
      seed,
      startedAt: startedAt.toISOString(),
      players: [
        {
          kind: "brain",
          tier: sideA.stable.userId.startsWith("system:") ? "system" : "user",
          label: sideA.slot.name,
          handle: sideA.stable.handle,
          userId: sideA.stable.userId,
          slotId: sideA.slot.slotId,
          slotName: sideA.slot.name,
          config: sideA.slot.config,
          cosmetics: slotCosmetics(sideA.slot, 0),
        },
        {
          kind: "brain",
          tier: sideB.stable.userId.startsWith("system:") ? "system" : "user",
          label: sideB.slot.name,
          handle: sideB.stable.handle,
          userId: sideB.stable.userId,
          slotId: sideB.slot.slotId,
          slotName: sideB.slot.name,
          config: sideB.slot.config,
          cosmetics: slotCosmetics(sideB.slot, 1),
        },
      ],
      chars,
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
    const { a: newA, b: newB } = updatePair(sideA.slot.elo, sideB.slot.elo, trace.result.winner);
    const now = Date.now();
    const watchlist = summarizeWatchlistMatch(trace.result, watchlistTags);
    if (shouldLogWatchlist(watchlist)) {
      console.log("[watchlist]", JSON.stringify({ matchId, ...watchlist }));
    }
    await this.store.archiveReplay(replay);
    void seedReplayComputeTasks({
      enabled: CONFIG.features.computeAutoSeedReplayTasks,
      computeLabOrigin: CONFIG.computeLabOrigin,
      adminToken: CONFIG.computeLabAdminToken,
    }, replay).then((results) => {
      if (results.some((result) => !result.ok)) {
        console.warn("[compute-auto-seed]", JSON.stringify({ matchId, results }));
      }
    }).catch((e) => {
      console.warn("[compute-auto-seed]", JSON.stringify({ matchId, error: e instanceof Error ? e.message : String(e) }));
    });
    await this.store.updateAfterMatch({
      aUserId: sideA.stable.userId, aSlotId: sideA.slot.slotId, aEloBefore: sideA.slot.elo, aEloAfter: newA,
      bUserId: sideB.stable.userId, bSlotId: sideB.slot.slotId, bEloBefore: sideB.slot.elo, bEloAfter: newB,
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
      eloBefore: [sideA.slot.elo, sideB.slot.elo],
      eloAfter: [newA, newB],
      sideSwap,
      watchlist,
    });
    this.currentMatch = null;
  }

  private previewPair(p: MatchPair): PublicMatchPreview {
    return {
      a: { userId: p.a.userId, handle: p.a.handle, slotId: p.aSlot.slotId, name: p.aSlot.name, elo: p.aSlot.elo, cosmetics: slotCosmetics(p.aSlot, 0) },
      b: { userId: p.b.userId, handle: p.b.handle, slotId: p.bSlot.slotId, name: p.bSlot.name, elo: p.bSlot.elo, cosmetics: slotCosmetics(p.bSlot, 1) },
      stageId: p.stageId,
      eloDelta: Math.abs(p.aSlot.elo - p.bSlot.elo),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function choosePivotIndex(entries: Array<{ st: Stable; slot: Slot }>, humanCount: number, sysCount: number): number {
  const now = Date.now();
  const humanWeight = humanPivotWeight(humanCount, sysCount);
  let total = 0;
  const weights = entries.map((e) => {
    let w = isHumanStable(e.st) ? humanWeight : 1;
    if (isHumanStable(e.st)) {
      const ageMs = e.slot.lastPlayedAt > 0 ? now - e.slot.lastPlayedAt : CONFIG.activePoolMs;
      const ageRatio = Math.max(0, Math.min(1, ageMs / CONFIG.activePoolMs));
      const recentPenalty = ageMs < RECENTLY_PLAYED_WINDOW_MS ? 0.25 : 1;
      w *= (1 + ageRatio * LEAST_RECENTLY_PLAYED_BONUS) * recentPenalty;
    }
    total += w;
    return w;
  });
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return entries.length - 1;
}

export function humanPivotTarget(humanCount: number, sysCount: number): number {
  if (humanCount <= 0) return 0;
  if (sysCount <= 0) return 1;
  const humanShare = humanCount / (humanCount + sysCount);
  const early = HUMAN_PIVOT_TARGETS.find((x) => humanCount <= x.maxHumans)?.target;
  const grown = Math.min(MAX_HUMAN_PIVOT_TARGET, 0.70 + Math.max(0, humanCount - 16) * 0.005);
  return Math.max(humanShare, early ?? grown);
}

export function humanPivotWeight(humanCount: number, sysCount: number): number {
  if (humanCount <= 0 || sysCount <= 0) return 1;
  const target = humanPivotTarget(humanCount, sysCount);
  if (target >= 1) return Number.POSITIVE_INFINITY;
  const targetOdds = target / (1 - target);
  return Math.max(1, targetOdds * (sysCount / humanCount));
}

export function pairEloBonusForMatchup(aHuman: boolean, bHuman: boolean, humanCount: number): number {
  if (!aHuman && !bHuman) return 0;
  if (aHuman && bHuman) {
    return Math.min(
      HUMAN_PAIR_ELO_BONUS_MAX,
      HUMAN_PAIR_ELO_BONUS_BASE + humanCount * HUMAN_PAIR_ELO_BONUS_PER_HUMAN,
    );
  }
  return Math.max(0, HUMAN_SYS_ELO_BONUS_MAX - humanCount * HUMAN_SYS_ELO_BONUS_DECAY_PER_HUMAN);
}
