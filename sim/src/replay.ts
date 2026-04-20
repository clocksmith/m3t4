import {
  ARENA_L, ARENA_R, ARENA_T,
  CLASH_FREEZE, COYOTE_TIME, DOUBLE_KO_RESPAWN_S, FLOOR_Y, GOAL_DWELL_RADIUS, GOAL_DWELL_S, GOAL_TIMER_START,
  GRAVITY, HIT_FREEZE, JUMP_BUFFER_TIME, KILL_RESPAWN_S, POINTS_TO_WIN_ROUND,
  RESPAWN_INVULN_S, ROUNDS_TO_WIN_MATCH, ROUND_TIMER_MAX_TICKS, STATS, STEP, TIMEOUT_TIEBREAK, WALL_SLIDE,
} from "./constants.js";
import { BEHAVIOR_VERSION } from "./brain.js";
import type { BrainConfig, Character, MatchResult, Stage } from "./types.js";
import { createStepperWorld, settleWorldWinner, stepWorld, unpackAction } from "./simulate.js";

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
    POINTS_TO_WIN_ROUND, ROUNDS_TO_WIN_MATCH, TIMEOUT_TIEBREAK, GOAL_TIMER_START,
    ROUND_TIMER_MAX_TICKS, GOAL_DWELL_S, GOAL_DWELL_RADIUS, KILL_RESPAWN_S,
    DOUBLE_KO_RESPAWN_S, RESPAWN_INVULN_S,
    ARENA_L, ARENA_R, ARENA_T, FLOOR_Y,
    BEHAVIOR_VERSION,
  };
  return replayHashJson(table);
})();

export type ReplayMode = "ranked" | "practice" | "generated" | "test";
export type ReplayPlayerKind = "human" | "brain" | "scripted";
export type ReplayPlayerTier = "user" | "system" | "local" | "tool";

// Trust labels — first-class replay metadata. A viewer reads one label
// and knows the match's proof tier without tracing the provenance chain.
// See ARCHITECTURE.md for the full definition of each tier.
export type TrustTier =
  | "ranked-server"
  | "local-practice"
  | "tuple-verified"
  | "p2p-action-verified"
  | "community-verified"
  | "attested-agent"
  | "proof-carrying";

export interface TrustLabelQuorum {
  required: number;
  total: number;
  agreed: number;
}

export interface TrustLabelVerification {
  quorum?: TrustLabelQuorum;
  verifierIds?: string[];
  actionLogHash?: string;
  actionLogSha256?: string;
  stateHashCadenceTicks?: number;
}

export interface TrustLabel {
  tier: TrustTier;
  simConstantsHash: string;
  behaviorVersion: number;
  ruleset: "m3t4";
  proofIssuedAt: string;
  proofIssuer: "server" | "client" | "community-quorum";
  verification?: TrustLabelVerification;
}

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
  sha256?: string;
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
  actionLogSha256?: string;
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
  trust?: TrustLabel;
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
  trust?: TrustLabel | Partial<TrustLabel>;
  frames?: unknown[];
  frameStride?: number;
  notes?: string;
}

// Build a trust label with sane defaults. Caller provides the tier and
// proof issuer; everything else (hashes, versions, timestamp, ruleset)
// is pinned from sim constants. Partial overrides compose on top.
export function createTrustLabel(
  tier: TrustTier,
  proofIssuer: TrustLabel["proofIssuer"],
  overrides?: Partial<TrustLabel>,
): TrustLabel {
  return {
    tier,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
    ruleset: "m3t4",
    proofIssuedAt: overrides?.proofIssuedAt ?? new Date().toISOString(),
    proofIssuer,
    verification: overrides?.verification,
    ...(overrides ?? {}),
  };
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

export async function replaySha256Bytes(bytes: Uint8Array): Promise<string> {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.subtle) {
    const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const digest = await cryptoObj.subtle.digest("SHA-256", source);
    return bytesToHex(new Uint8Array(digest));
  }
  return replaySha256BytesSync(bytes);
}

export function replaySha256BytesSync(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(input: Uint8Array): string {
  const bitLenHi = Math.floor((input.length * 8) / 0x100000000);
  const bitLenLo = (input.length * 8) >>> 0;
  const paddedLen = (((input.length + 9 + 63) >> 6) << 6);
  const msg = new Uint8Array(paddedLen);
  msg.set(input);
  msg[input.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, bitLenHi, false);
  view.setUint32(paddedLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, "0")).join("");
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
  const actionSha256 = replaySha256BytesSync(opts.actionLog);
  const result = replayResultFrom(opts.result);

  const trust = normalizeTrustLabel(opts.trust, opts.mode);

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
      sha256: actionSha256,
    },
    result,
    integrity: {
      stageHash: replayHashJson(opts.stage),
      charsHash: replayHashJson(opts.chars),
      playerHashes: [replayHashJson(players[0]), replayHashJson(players[1])],
      actionLogHash: actionHash,
      actionLogSha256: actionSha256,
      frameLogHash: frames?.hash,
    },
    trust,
    frames,
    notes: opts.notes,
  };
}

function normalizeTrustLabel(
  input: TrustLabel | Partial<TrustLabel> | undefined,
  mode: ReplayMode,
): TrustLabel {
  // Default tier inference from the replay mode when the caller doesn't
  // supply a tier. ranked → ranked-server; practice → local-practice;
  // generated/test → local-practice. Callers that create a tuple/p2p/
  // community-verified artifact MUST pass tier explicitly.
  const defaultTier: TrustTier =
    mode === "ranked" ? "ranked-server" : "local-practice";
  const defaultIssuer: TrustLabel["proofIssuer"] =
    mode === "ranked" ? "server" : "client";
  const tier = input?.tier ?? defaultTier;
  const proofIssuer = input?.proofIssuer ?? defaultIssuer;
  return {
    tier,
    simConstantsHash: input?.simConstantsHash ?? REPLAY_CONSTANTS_HASH,
    behaviorVersion: input?.behaviorVersion ?? BEHAVIOR_VERSION,
    ruleset: "m3t4",
    proofIssuedAt: input?.proofIssuedAt ?? new Date().toISOString(),
    proofIssuer,
    verification: input?.verification,
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
  if (log.sha256 !== undefined) {
    const sha = replaySha256BytesSync(bytes);
    if (sha !== log.sha256) {
      throw new Error(`replay action sha256 mismatch: ${sha} !== ${log.sha256}`);
    }
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
  if (artifact.actions.sha256 !== undefined) {
    const sha = replaySha256BytesSync(actionBytes);
    if (sha !== artifact.actions.sha256) {
      throw new Error(`replay actions.sha256 mismatch vs bytes: ${sha} !== ${artifact.actions.sha256}`);
    }
    if (i.actionLogSha256 !== undefined && i.actionLogSha256 !== artifact.actions.sha256) {
      throw new Error(`replay integrity.actionLogSha256 !== actions.sha256`);
    }
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

  settleWorldWinner(world);
  const result = replayResultFromWorld(world, hashAcc.toString(16).padStart(8, "0"));
  if (opts.verifyExpected !== false) verifyReplayResult(artifact.result, result);
  return {
    result,
    consumedBytes: offset,
    consumedDecisionTicks: offset / 2,
  };
}

// Standalone verify helper: given a tuple + action log, re-simulate and
// return the result. Used by the server verify endpoint to confirm that a
// posted action log actually produces the claimed outcome under the
// pinned sim version. Does NOT require a full ReplayArtifactV1.
export interface VerifyActionLogInput {
  seed: number;
  stage: Stage;
  chars: [Character, Character];
  actionLog: Uint8Array;
  maxTicks?: number;
  expectedLogHash?: string;          // from the posted result, optional
  expectedResult?: ReplayResultV1;   // optional full result check
}

export interface VerifyActionLogOutput {
  ok: boolean;
  result: ReplayResultV1;
  reason?: string;                   // set when ok === false
  simConstantsHash: string;
  behaviorVersion: number;
}

export function verifyActionLog(input: VerifyActionLogInput): VerifyActionLogOutput {
  const bytes = input.actionLog;
  if (bytes.length % 2 !== 0) {
    return mismatchResult("actionLog must contain paired P1/P2 bytes", bytes);
  }
  const world = createStepperWorld({
    stage: input.stage,
    seed: input.seed,
    chars: input.chars,
  });
  const maxTicks = input.maxTicks ?? ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;
  let offset = 0;
  let hashAcc = 2166136261 >>> 0;
  const empty = {};
  // Run until the match concludes or reaches the agreed horizon. The log must
  // cover every decision tick in that interval; otherwise a peer could submit
  // only the prefix where they were ahead and get a false verified result.
  while (world.matchWinner === -1 && world.tick < maxTicks) {
    if (world.freeze > 0 || world.roundPause > 0) {
      stepWorld(world, empty, empty);
      continue;
    }
    if (offset + 1 >= bytes.length) {
      const result = replayResultFromWorld(world, hashAcc.toString(16).padStart(8, "0"));
      return {
        ok: false,
        result,
        reason: `action log ended early at tick ${world.tick}`,
        simConstantsHash: REPLAY_CONSTANTS_HASH,
        behaviorVersion: BEHAVIOR_VERSION,
      };
    }
    const pa = bytes[offset++];
    const pb = bytes[offset++];
    hashAcc = fnvByte(hashAcc, pa);
    hashAcc = fnvByte(hashAcc, pb);
    stepWorld(world, unpackAction(pa), unpackAction(pb));
  }
  settleWorldWinner(world);
  if (offset !== bytes.length) {
    const result = replayResultFromWorld(world, hashAcc.toString(16).padStart(8, "0"));
    return {
      ok: false,
      result,
      reason: `action log has ${bytes.length - offset} trailing bytes`,
      simConstantsHash: REPLAY_CONSTANTS_HASH,
      behaviorVersion: BEHAVIOR_VERSION,
    };
  }
  const result = replayResultFromWorld(world, hashAcc.toString(16).padStart(8, "0"));
  if (input.expectedLogHash !== undefined && input.expectedLogHash !== result.logHash) {
    return {
      ok: false,
      result,
      reason: `logHash mismatch: computed=${result.logHash} expected=${input.expectedLogHash}`,
      simConstantsHash: REPLAY_CONSTANTS_HASH,
      behaviorVersion: BEHAVIOR_VERSION,
    };
  }
  if (input.expectedResult) {
    try {
      verifyReplayResult(input.expectedResult, result);
    } catch (e) {
      return {
        ok: false,
        result,
        reason: e instanceof Error ? e.message : String(e),
        simConstantsHash: REPLAY_CONSTANTS_HASH,
        behaviorVersion: BEHAVIOR_VERSION,
      };
    }
  }
  return {
    ok: true,
    result,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
  };
}

function mismatchResult(reason: string, _bytes: Uint8Array): VerifyActionLogOutput {
  return {
    ok: false,
    result: { winner: -1, finalScore: [0, 0], finalRounds: [0, 0], ticks: 0, logHash: "00000000" },
    reason,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
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
