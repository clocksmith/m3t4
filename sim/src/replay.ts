import {
  ARENA_L, ARENA_R, ARENA_T,
  CLASH_FREEZE, COYOTE_TIME, FLOOR_Y, GOAL_DWELL_S, GOAL_TIMER_START,
  GRAVITY, HIT_FREEZE, JUMP_BUFFER_TIME, POINTS_TO_WIN_ROUND,
  ROUNDS_TO_WIN_MATCH, ROUND_TIMER_MAX_TICKS, STATS, STEP, WALL_SLIDE,
} from "./constants.js";
import { BEHAVIOR_VERSION } from "./brain.js";
import type { BrainConfig, Character, MatchResult, Stage } from "./types.js";
import { createStepperWorld, stepWorld, unpackAction } from "./simulate.js";

export const REPLAY_SCHEMA_ID = "m3t4.replay";
export const REPLAY_SCHEMA_VERSION = 1;
export const REPLAY_ACTION_ENCODING = "decision-action-pairs-v1";
export const REPLAY_FRAME_ENCODING = "trace-frames-v1";
export const REPLAY_RULESET = "m3t4-sim-v1";

export const REPLAY_CONSTANTS_HASH = (() => {
  const table = {
    STEP, GRAVITY, WALL_SLIDE, COYOTE_TIME, JUMP_BUFFER_TIME,
    HIT_FREEZE, CLASH_FREEZE,
    STATS,
    POINTS_TO_WIN_ROUND, ROUNDS_TO_WIN_MATCH, GOAL_TIMER_START,
    ROUND_TIMER_MAX_TICKS, GOAL_DWELL_S,
    ARENA_L, ARENA_R, ARENA_T, FLOOR_Y,
    BEHAVIOR_VERSION,
  };
  return replayHashJson(table);
})();

export type ReplayMode = "ranked" | "practice" | "generated" | "test";
export type ReplayPlayerKind = "human" | "brain" | "scripted";
export type ReplayPlayerTier = "user" | "system" | "local" | "tool";

export interface ReplayControlBindingV1 {
  left?: string;
  right?: string;
  up?: string;
  down?: string;
  action?: string;
}

export interface ReplayControlsV1 {
  scheme: string;
  bindings: ReplayControlBindingV1;
}

export interface ReplaySimInfoV1 {
  packageName: "@m3t4/sim";
  ruleset: typeof REPLAY_RULESET;
  stepHz: number;
  packageVersion?: string;
  sourceHash?: string;
  constantsHash?: string;
}

export interface ReplayPlayerV1 {
  side: 0 | 1;
  kind: ReplayPlayerKind;
  label: string;
  tier?: ReplayPlayerTier;
  handle?: string;
  userId?: string;
  slotId?: string;
  slotName?: string;
  controls?: string | ReplayControlsV1;
  config?: BrainConfig;
  configHash?: string;
}

export interface ReplayMatchV1 {
  matchId: string;
  mode: ReplayMode;
  seed: number;
  stageId: string;
  startedAt?: string;
}

export interface ReplayInitialStateV1 {
  stage: Stage;
  chars: [Character, Character];
}

export interface ReplayActionLogV1 {
  encoding: typeof REPLAY_ACTION_ENCODING;
  bytesBase64: string;
  byteLength: number;
  decisionTicks: number;
  hash: string;
}

export interface ReplayFrameLogV1 {
  encoding: typeof REPLAY_FRAME_ENCODING;
  stride: number;
  frameCount: number;
  hash?: string;
  frames?: unknown[];
}

export interface ReplayResultV1 {
  winner: 0 | 1 | -1;
  finalScore: [number, number];
  finalRounds: [number, number];
  ticks: number;
  logHash: string;
}

export interface ReplayIntegrityV1 {
  stageHash: string;
  charsHash: string;
  playerHashes: [string, string];
  actionLogHash: string;
  frameLogHash?: string;
}

export interface ReplayArtifactV1 {
  schema: typeof REPLAY_SCHEMA_ID;
  version: typeof REPLAY_SCHEMA_VERSION;
  createdAt: string;
  sim: ReplaySimInfoV1;
  match: ReplayMatchV1;
  players: [ReplayPlayerV1, ReplayPlayerV1];
  initial: ReplayInitialStateV1;
  actions: ReplayActionLogV1;
  result: ReplayResultV1;
  integrity: ReplayIntegrityV1;
  frames?: ReplayFrameLogV1;
  notes?: string;
}

export interface CreateReplayArtifactV1Options {
  matchId: string;
  mode: ReplayMode;
  stage: Stage;
  seed: number;
  players: [Omit<ReplayPlayerV1, "side"> & { side?: 0 | 1 }, Omit<ReplayPlayerV1, "side"> & { side?: 0 | 1 }];
  chars: [Character, Character];
  actionLog: Uint8Array;
  result: MatchResult | ReplayResultV1;
  createdAt?: string;
  startedAt?: string;
  sim?: Partial<ReplaySimInfoV1>;
  frames?: unknown[];
  frameStride?: number;
  notes?: string;
}

export interface ReplayDecodeOptionsV1 {
  verifyExpected?: boolean;
  allowConstantsMismatch?: boolean;
}

export interface ReplayDecodeResultV1 {
  result: ReplayResultV1;
  consumedBytes: number;
  consumedDecisionTicks: number;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function replayBytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64[(n >>> 18) & 63] + BASE64[(n >>> 12) & 63] + BASE64[(n >>> 6) & 63] + BASE64[n & 63];
  }
  if (i < bytes.length) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const n = (a << 16) | (b << 8);
    out += BASE64[(n >>> 18) & 63] + BASE64[(n >>> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >>> 6) & 63] + "=" : "==";
  }
  return out;
}

export function replayBase64ToBytes(encoded: string): Uint8Array {
  const clean = encoded.replace(/\s+/g, "");
  if (clean.length === 0) return new Uint8Array();
  if (clean.length % 4 !== 0) throw new Error("invalid replay base64 length");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (base64Value(clean[i]) << 18) |
      (base64Value(clean[i + 1]) << 12) |
      (base64Value(clean[i + 2]) << 6) |
      base64Value(clean[i + 3]);
    if (o < out.length) out[o++] = (n >>> 16) & 255;
    if (o < out.length) out[o++] = (n >>> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function replayHashBytes(bytes: Uint8Array): string {
  let h = 2166136261 >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function stableReplayJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (ArrayBuffer.isView(value)) {
    throw new Error("stableReplayJson does not accept binary views; encode bytes explicitly");
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableReplayJson(v)).join(",")}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableReplayJson(obj[k])}`).join(",")}}`;
}

export function replayHashJson(value: unknown): string {
  const json = stableReplayJson(value);
  let h = 2166136261 >>> 0;
  for (const ch of json) {
    h = fnvUtf8CodePoint(h, ch.codePointAt(0) ?? 0);
  }
  return h.toString(16).padStart(8, "0");
}

export function createReplayArtifactV1(opts: CreateReplayArtifactV1Options): ReplayArtifactV1 {
  if (opts.actionLog.length % 2 !== 0) {
    throw new Error("replay action log must contain paired P1/P2 bytes");
  }
  const sim: ReplaySimInfoV1 = {
    ...opts.sim,
    packageName: "@m3t4/sim",
    ruleset: REPLAY_RULESET,
    stepHz: Math.round(1 / STEP),
  };
  assertReplaySimInfo(opts.mode, sim);
  const players: [ReplayPlayerV1, ReplayPlayerV1] = [
    normalizePlayer({ ...opts.players[0], side: 0 }),
    normalizePlayer({ ...opts.players[1], side: 1 }),
  ];
  const frames = opts.frames
    ? createReplayFrameLog(opts.frames, opts.frameStride ?? 1)
    : undefined;
  const actionHash = replayHashBytes(opts.actionLog);
  const result = replayResultFrom(opts.result);

  return {
    schema: REPLAY_SCHEMA_ID,
    version: REPLAY_SCHEMA_VERSION,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    sim,
    match: {
      matchId: opts.matchId,
      mode: opts.mode,
      seed: opts.seed >>> 0,
      stageId: opts.stage.id,
      startedAt: opts.startedAt,
    },
    players,
    initial: {
      stage: opts.stage,
      chars: opts.chars,
    },
    actions: {
      encoding: REPLAY_ACTION_ENCODING,
      bytesBase64: replayBytesToBase64(opts.actionLog),
      byteLength: opts.actionLog.length,
      decisionTicks: opts.actionLog.length / 2,
      hash: actionHash,
    },
    result,
    integrity: {
      stageHash: replayHashJson(opts.stage),
      charsHash: replayHashJson(opts.chars),
      playerHashes: [replayHashJson(players[0]), replayHashJson(players[1])],
      actionLogHash: actionHash,
      frameLogHash: frames?.hash,
    },
    frames,
    notes: opts.notes,
  };
}

export function decodeReplayActions(log: ReplayActionLogV1): Uint8Array {
  if (log.encoding !== REPLAY_ACTION_ENCODING) {
    throw new Error(`unsupported replay action encoding: ${log.encoding}`);
  }
  const bytes = replayBase64ToBytes(log.bytesBase64);
  if (bytes.length !== log.byteLength) {
    throw new Error(`replay action byteLength mismatch: ${bytes.length} !== ${log.byteLength}`);
  }
  if (!Number.isInteger(log.decisionTicks) || log.decisionTicks * 2 !== log.byteLength) {
    throw new Error("replay action decisionTicks must match paired byteLength");
  }
  const hash = replayHashBytes(bytes);
  if (hash !== log.hash) {
    throw new Error(`replay action hash mismatch: ${hash} !== ${log.hash}`);
  }
  return bytes;
}

export function verifyReplayIntegrityV1(artifact: ReplayArtifactV1): void {
  const i = artifact.integrity;
  const stageHash = replayHashJson(artifact.initial.stage);
  if (stageHash !== i.stageHash) {
    throw new Error(`replay stageHash mismatch: ${stageHash} !== ${i.stageHash}`);
  }
  const charsHash = replayHashJson(artifact.initial.chars);
  if (charsHash !== i.charsHash) {
    throw new Error(`replay charsHash mismatch: ${charsHash} !== ${i.charsHash}`);
  }
  const p0 = replayHashJson(artifact.players[0]);
  const p1 = replayHashJson(artifact.players[1]);
  if (p0 !== i.playerHashes[0] || p1 !== i.playerHashes[1]) {
    throw new Error(`replay playerHashes mismatch: [${p0},${p1}] !== [${i.playerHashes.join(",")}]`);
  }
  const actionBytes = replayBase64ToBytes(artifact.actions.bytesBase64);
  const recomputedActionHash = replayHashBytes(actionBytes);
  if (recomputedActionHash !== artifact.actions.hash) {
    throw new Error(`replay actions.hash mismatch vs bytes: ${recomputedActionHash} !== ${artifact.actions.hash}`);
  }
  if (i.actionLogHash !== artifact.actions.hash) {
    throw new Error(`replay integrity.actionLogHash !== actions.hash`);
  }
  if (artifact.frames) {
    const want = artifact.frames.hash;
    const got = replayHashJson(artifact.frames.frames ?? []);
    if (want !== undefined && want !== got) {
      throw new Error(`replay frameLogHash mismatch: ${got} !== ${want}`);
    }
    if (i.frameLogHash !== undefined && i.frameLogHash !== want) {
      throw new Error(`replay integrity.frameLogHash !== frames.hash`);
    }
  }
}

export function replayArtifactWarningsV1(artifact: ReplayArtifactV1): string[] {
  const warnings: string[] = [];
  if (!artifact.sim.sourceHash && !artifact.sim.constantsHash) {
    warnings.push("replay artifact has no sim sourceHash/constantsHash binding");
  }
  if (artifact.frames && artifact.frames.encoding !== REPLAY_FRAME_ENCODING) {
    warnings.push(`unsupported replay frame encoding: ${artifact.frames.encoding}`);
  }
  return warnings;
}

export function replayArtifactToResultV1(
  artifact: ReplayArtifactV1,
  opts: ReplayDecodeOptionsV1 = {},
): ReplayDecodeResultV1 {
  if (!isReplayArtifactV1(artifact)) throw new Error("not a replay artifact v1");
  assertReplaySimInfo(artifact.match.mode, artifact.sim);
  assertConstantsHashMatch(artifact.match.mode, artifact.sim, !!opts.allowConstantsMismatch);
  verifyReplayIntegrityV1(artifact);

  const bytes = decodeReplayActions(artifact.actions);
  const world = createStepperWorld({
    stage: artifact.initial.stage,
    seed: artifact.match.seed,
    chars: artifact.initial.chars,
  });

  let offset = 0;
  let hashAcc = 2166136261 >>> 0;
  const empty = {};
  while (world.tick < artifact.result.ticks && world.matchWinner === -1) {
    if (world.freeze > 0 || world.roundPause > 0) {
      stepWorld(world, empty, empty);
      continue;
    }
    if (offset + 1 >= bytes.length) {
      throw new Error(`replay action log ended early at tick ${world.tick}`);
    }
    const pa = bytes[offset++];
    const pb = bytes[offset++];
    hashAcc = fnvByte(hashAcc, pa);
    hashAcc = fnvByte(hashAcc, pb);
    stepWorld(world, unpackAction(pa), unpackAction(pb));
  }

  if (offset !== bytes.length) {
    throw new Error(`replay action log has ${bytes.length - offset} trailing bytes`);
  }

  const result = replayResultFromWorld(world, hashAcc.toString(16).padStart(8, "0"));
  if (opts.verifyExpected !== false) verifyReplayResult(artifact.result, result);
  return {
    result,
    consumedBytes: offset,
    consumedDecisionTicks: offset / 2,
  };
}

export function isReplayArtifactV1(value: unknown): value is ReplayArtifactV1 {
  const v = value as Partial<ReplayArtifactV1> | null;
  return !!v &&
    v.schema === REPLAY_SCHEMA_ID &&
    v.version === REPLAY_SCHEMA_VERSION &&
    v.actions?.encoding === REPLAY_ACTION_ENCODING &&
    typeof v.match?.stageId === "string" &&
    typeof v.match?.seed === "number" &&
    Array.isArray(v.players) &&
    v.players.length === 2;
}

function createReplayFrameLog(frames: unknown[], stride: number): ReplayFrameLogV1 {
  return {
    encoding: REPLAY_FRAME_ENCODING,
    stride,
    frameCount: frames.length,
    hash: replayHashJson(frames),
    frames,
  };
}

function normalizePlayer(player: ReplayPlayerV1): ReplayPlayerV1 {
  return {
    ...player,
    configHash: player.configHash ?? (player.config ? replayHashJson(player.config) : undefined),
  };
}

function replayResultFrom(result: MatchResult | ReplayResultV1): ReplayResultV1 {
  return {
    winner: result.winner,
    finalScore: result.finalScore,
    finalRounds: result.finalRounds,
    ticks: result.ticks,
    logHash: result.logHash,
  };
}

function replayResultFromWorld(
  world: ReturnType<typeof createStepperWorld>,
  logHash: string,
): ReplayResultV1 {
  let winner = world.matchWinner;
  if (winner === -1) {
    const [a, b] = world.fighters;
    if (a.rounds > b.rounds) winner = 0;
    else if (b.rounds > a.rounds) winner = 1;
    else if (a.score > b.score) winner = 0;
    else if (b.score > a.score) winner = 1;
  }
  return {
    winner,
    finalScore: [world.fighters[0].score, world.fighters[1].score],
    finalRounds: [world.fighters[0].rounds, world.fighters[1].rounds],
    ticks: world.tick,
    logHash,
  };
}

function verifyReplayResult(expected: ReplayResultV1, actual: ReplayResultV1): void {
  const fields: Array<keyof ReplayResultV1> = ["winner", "ticks", "logHash"];
  for (const k of fields) {
    if (expected[k] !== actual[k]) {
      throw new Error(`replay ${k} mismatch: ${actual[k]} !== ${expected[k]}`);
    }
  }
  if (expected.finalScore[0] !== actual.finalScore[0] || expected.finalScore[1] !== actual.finalScore[1]) {
    throw new Error(`replay finalScore mismatch: ${actual.finalScore.join(",")} !== ${expected.finalScore.join(",")}`);
  }
  if (expected.finalRounds[0] !== actual.finalRounds[0] || expected.finalRounds[1] !== actual.finalRounds[1]) {
    throw new Error(`replay finalRounds mismatch: ${actual.finalRounds.join(",")} !== ${expected.finalRounds.join(",")}`);
  }
}

function assertReplaySimInfo(mode: ReplayMode, sim: ReplaySimInfoV1): void {
  if (sim.packageName !== "@m3t4/sim") {
    throw new Error(`unsupported replay packageName: ${sim.packageName}`);
  }
  if (sim.ruleset !== REPLAY_RULESET) {
    throw new Error(`unsupported replay ruleset: ${sim.ruleset}`);
  }
  if (sim.stepHz !== Math.round(1 / STEP)) {
    throw new Error(`unsupported replay stepHz: ${sim.stepHz}`);
  }
  if (mode === "ranked" && !sim.sourceHash && !sim.constantsHash) {
    throw new Error("ranked replay artifacts require sim.sourceHash or sim.constantsHash");
  }
}

function assertConstantsHashMatch(mode: ReplayMode, sim: ReplaySimInfoV1, allowConstantsMismatch: boolean): void {
  if (mode !== "ranked") return;
  if (!sim.constantsHash) return;
  if (sim.constantsHash === REPLAY_CONSTANTS_HASH) return;
  if (allowConstantsMismatch) return;
  throw new Error(
    `ranked replay constantsHash mismatch: artifact=${sim.constantsHash} current=${REPLAY_CONSTANTS_HASH} (sim/rules diverged; pass allowConstantsMismatch for archival inspection)`
  );
}

function base64Value(ch: string): number {
  if (ch === "=") return 0;
  const n = BASE64.indexOf(ch);
  if (n === -1) throw new Error(`invalid replay base64 character: ${ch}`);
  return n;
}

function fnvByte(hash: number, byte: number): number {
  hash ^= byte & 255;
  return Math.imul(hash, 16777619) >>> 0;
}

function fnvUtf8CodePoint(hash: number, cp: number): number {
  if (cp <= 0x7f) return fnvByte(hash, cp);
  if (cp <= 0x7ff) {
    hash = fnvByte(hash, 0xc0 | (cp >>> 6));
    return fnvByte(hash, 0x80 | (cp & 0x3f));
  }
  if (cp <= 0xffff) {
    hash = fnvByte(hash, 0xe0 | (cp >>> 12));
    hash = fnvByte(hash, 0x80 | ((cp >>> 6) & 0x3f));
    return fnvByte(hash, 0x80 | (cp & 0x3f));
  }
  hash = fnvByte(hash, 0xf0 | (cp >>> 18));
  hash = fnvByte(hash, 0x80 | ((cp >>> 12) & 0x3f));
  hash = fnvByte(hash, 0x80 | ((cp >>> 6) & 0x3f));
  return fnvByte(hash, 0x80 | (cp & 0x3f));
}
