import crypto from "node:crypto";
import {
  BEHAVIOR_VERSION,
  REPLAY_CONSTANTS_HASH,
  replayHashJson,
  stableReplayJson,
  type ReplayArtifactV1,
  type ReplayPlayerV1,
  type ReplayResultV1,
  type TrustLabel,
} from "@m3t4/sim";

export const PUBLIC_REPLAY_ARTIFACT_SCHEMA = "m3t4.public-replay-artifact";
export const PUBLIC_REPLAY_ARTIFACT_VERSION = 1;

export interface PublicReplayPlayerRefV1 {
  side: 0 | 1;
  kind: ReplayPlayerV1["kind"];
  label: string;
  tier?: ReplayPlayerV1["tier"];
  handle?: string;
  userId?: string;
  slotId?: string;
  slotName?: string;
  configHash?: string;
}

export interface PublicReplayTupleV1 {
  matchId: string;
  seed: number;
  stageId: string;
  players: [PublicReplayPlayerRefV1, PublicReplayPlayerRefV1];
  expectedLogHash: string;
  expectedResult: ReplayResultV1;
  trust?: TrustLabel;
  simConstantsHash: string;
  behaviorVersion: number;
}

export interface PublicReplayArtifactPayloadV1 {
  matchId: string;
  replayCreatedAt: string;
  publicTuplePath: string;
  tuple: PublicReplayTupleV1;
  integrity: {
    stageHash: string;
    charsHash: string;
    actionLogHash: string;
    actionLogSha256?: string;
    frameLogHash?: string;
  };
  actions: {
    encoding: ReplayArtifactV1["actions"]["encoding"];
    byteLength: number;
    decisionTicks: number;
    hash: string;
    sha256?: string;
  };
  frames?: {
    encoding: NonNullable<ReplayArtifactV1["frames"]>["encoding"];
    stride: number;
    frameCount: number;
    hash?: string;
  };
}

export interface PublicReplayArtifactV1 {
  schema: typeof PUBLIC_REPLAY_ARTIFACT_SCHEMA;
  version: typeof PUBLIC_REPLAY_ARTIFACT_VERSION;
  matchId: string;
  exportedAt: string;
  artifactHash: string;
  artifactSha256: string;
  payload: PublicReplayArtifactPayloadV1;
}

export function publicReplayTupleFromReplay(artifact: ReplayArtifactV1): PublicReplayTupleV1 {
  return {
    matchId: artifact.match.matchId,
    seed: artifact.match.seed,
    stageId: artifact.match.stageId,
    players: [
      publicPlayerRef(artifact.players[0]),
      publicPlayerRef(artifact.players[1]),
    ],
    expectedLogHash: artifact.result.logHash,
    expectedResult: artifact.result,
    trust: artifact.trust,
    simConstantsHash: artifact.sim.constantsHash ?? REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
  };
}

export function publicReplayArtifactFromReplay(
  artifact: ReplayArtifactV1,
  exportedAt = artifact.createdAt,
): PublicReplayArtifactV1 {
  const payload: PublicReplayArtifactPayloadV1 = {
    matchId: artifact.match.matchId,
    replayCreatedAt: artifact.createdAt,
    publicTuplePath: `/api/spectate/tuple/${encodeURIComponent(artifact.match.matchId)}`,
    tuple: publicReplayTupleFromReplay(artifact),
    integrity: {
      stageHash: artifact.integrity.stageHash,
      charsHash: artifact.integrity.charsHash,
      actionLogHash: artifact.integrity.actionLogHash,
      actionLogSha256: artifact.integrity.actionLogSha256,
      frameLogHash: artifact.integrity.frameLogHash,
    },
    actions: {
      encoding: artifact.actions.encoding,
      byteLength: artifact.actions.byteLength,
      decisionTicks: artifact.actions.decisionTicks,
      hash: artifact.actions.hash,
      sha256: artifact.actions.sha256,
    },
    frames: artifact.frames
      ? {
        encoding: artifact.frames.encoding,
        stride: artifact.frames.stride,
        frameCount: artifact.frames.frameCount,
        hash: artifact.frames.hash,
      }
      : undefined,
  };
  const payloadJson = publicReplayArtifactPayloadJson(payload);
  return {
    schema: PUBLIC_REPLAY_ARTIFACT_SCHEMA,
    version: PUBLIC_REPLAY_ARTIFACT_VERSION,
    matchId: artifact.match.matchId,
    exportedAt,
    artifactHash: replayHashJson(payload),
    artifactSha256: sha256Hex(payloadJson),
    payload,
  };
}

export function publicReplayArtifactPayloadJson(payload: PublicReplayArtifactPayloadV1): string {
  return stableReplayJson(payload);
}

function publicPlayerRef(player: ReplayPlayerV1): PublicReplayPlayerRefV1 {
  return {
    side: player.side,
    kind: player.kind,
    label: player.label,
    tier: player.tier,
    handle: player.handle,
    userId: player.userId,
    slotId: player.slotId,
    slotName: player.slotName,
    configHash: player.configHash,
  };
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
