// Run a single match deterministically, package the result for Firestore.
//
// The Firestore document shape is the canonical artifact spectators read.
// Clients reconstruct frames locally by re-running the sim from the same
// inputs, so the doc stays small (no frame stream, no trace).

import {
  BEHAVIOR_VERSION,
  DEFAULT_CHARS,
  REPLAY_CONSTANTS_HASH,
  STAGES,
  type BrainConfig,
  type ReplayResultV1,
  simulateTrace,
} from "@m3t4/sim";
import { rankedSideSwap, type StableSummary } from "./pair-selection.js";
import { updatePair } from "./elo.js";

export interface RunMatchInput {
  matchId: string;
  pair: { a: StableSummary; b: StableSummary };
  stageId?: string;
  startedAt: number; // ms wall-clock
  // Tick duration in ms. Default 8.33 (~120 fps), matches existing pacing.
  tickMs?: number;
  kFactor?: number;
}

export interface RunMatchOutput {
  match: MatchDocV1;
  // Updated ELO values for caller to write to stables/<userId>.
  eloAfter: { a: number; b: number };
  eloBefore: { a: number; b: number };
}

// Firestore doc shape under matches/<matchId>. Designed to be small —
// actionLog is base64 (typical < 4 KB) and the rest is trivial metadata.
// Clients re-derive frames from (stage, seed, chars, actionLog).
export interface MatchDocV1 {
  schema: "m3t4.match.v1";
  matchId: string;
  stageId: string;
  seed: number;
  chars: typeof DEFAULT_CHARS;
  startedAt: number;
  endsAt: number;
  durationMs: number;
  // Side A and B as displayed (post side-swap). Configs intentionally not
  // included — clients reconstruct frames from the actionLog without
  // needing brain configs.
  a: SideRef;
  b: SideRef;
  result: ReplayResultV1;
  actionLog: string; // base64 of Uint8Array
  actionLogHash: string;
  sim: {
    constantsHash: string;
    behaviorVersion: number;
  };
  // Set once the match is complete and ELO is committed. Writers should
  // set both atomically with the result doc.
  eloAfter?: { a: number; b: number };
  eloDelta?: { a: number; b: number };
}

export interface SideRef {
  userId: string;
  handle: string;
  slotIdx?: number;
  slotId: string;
  slotName: string;
  name: string;
  eloBefore: number;
  elo: number;
  isHuman: boolean;
  cosmetics?: unknown;
}

const DEFAULT_TICK_MS = 1000 / 120;

export function runMatch(input: RunMatchInput): RunMatchOutput {
  const stageId = input.stageId ?? "datacenter";
  const stage = STAGES[stageId as keyof typeof STAGES];
  if (!stage) throw new Error(`unknown stage: ${stageId}`);

  const tickMs = input.tickMs ?? DEFAULT_TICK_MS;
  const seed = (input.startedAt ^ (input.pair.a.elo << 3) ^ input.pair.b.elo) >>> 0;
  const swap = rankedSideSwap(seed);

  const sideAStable = swap ? input.pair.b : input.pair.a;
  const sideBStable = swap ? input.pair.a : input.pair.b;

  const brainA: BrainConfig = sideAStable.config;
  const brainB: BrainConfig = sideBStable.config;
  // Use default character stats. Cosmetic-derived per-character stats
  // (legacy roster bodies/weapons) are a follow-up enhancement; the match
  // engine doesn't need them to produce a deterministic, replayable match.
  const chars = DEFAULT_CHARS;

  const trace = simulateTrace({ stage, brainA, brainB, seed, chars });

  const durationMs = Math.max(1, trace.frames.length) * tickMs;
  const endsAt = input.startedAt + Math.round(durationMs);

  const elo = updatePair(
    sideAStable.elo,
    sideBStable.elo,
    trace.result.winner,
    input.kFactor ?? 16,
  );

  const actionLog = encodeBase64(trace.result.frameLog);

  // Strip the raw `frameLog` from the persisted result — JSON-serialising
  // a Uint8Array balloons it to {"0":1,"1":0,...} form (5-10x bloat). The
  // base64 `actionLog` field carries the same bytes compactly.
  const slimResult = { ...trace.result };
  delete (slimResult as Partial<typeof trace.result>).frameLog;

  const match: MatchDocV1 = {
    schema: "m3t4.match.v1",
    matchId: input.matchId,
    stageId,
    seed,
    chars,
    startedAt: input.startedAt,
    endsAt,
    durationMs: Math.round(durationMs),
    a: sideRef(sideAStable),
    b: sideRef(sideBStable),
    result: slimResult,
    actionLog,
    actionLogHash: trace.result.logHash,
    sim: {
      constantsHash: REPLAY_CONSTANTS_HASH,
      behaviorVersion: BEHAVIOR_VERSION,
    },
    eloAfter: elo,
    eloDelta: {
      a: elo.a - sideAStable.elo,
      b: elo.b - sideBStable.elo,
    },
  };

  return {
    match,
    eloAfter: elo,
    eloBefore: { a: sideAStable.elo, b: sideBStable.elo },
  };
}

function sideRef(s: StableSummary): SideRef {
  return {
    userId: s.userId,
    handle: s.handle,
    slotIdx: s.slotIdx,
    slotId: s.slotId,
    slotName: s.slotName,
    name: s.slotName,
    eloBefore: s.elo,
    elo: s.elo,
    isHuman: s.isHuman,
    cosmetics: s.cosmetics,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  // Browser fallback (clients import sim/encode separately; this path is
  // server-only in practice).
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return typeof btoa !== "undefined" ? btoa(s) : s;
}
