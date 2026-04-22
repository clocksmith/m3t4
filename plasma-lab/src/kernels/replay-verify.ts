import {
  replayArtifactToResultV1,
  stableReplayJson,
  type ReplayArtifactV1,
} from "@m3t4/sim";
import { sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const REPLAY_VERIFY_KERNEL_ID = "m3t4.replay_verify.v1";
export const REPLAY_VERIFY_KERNEL_HASH = sha256(`${REPLAY_VERIFY_KERNEL_ID}:public-replay-artifact-v1`);

export interface ReplayVerifyParams {
  replayArtifactJson: string;
  allowConstantsMismatch?: boolean;
}

export interface ReplayVerifyOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
  summary: ReplayVerifySummary;
}

export interface ReplayVerifySummary {
  kind: typeof REPLAY_VERIFY_KERNEL_ID;
  matchId: string;
  mode: string;
  stageId: string;
  seed: number;
  actionLogHash: string;
  actionLogSha256?: string;
  simConstantsHash?: string;
  behaviorVersion?: number;
  consumedDecisionTicks: number;
  result: {
    winner: 0 | 1 | -1;
    finalScore: [number, number];
    finalRounds: [number, number];
    ticks: number;
    logHash: string;
  };
}

export function runReplayVerify(params: ReplayVerifyParams): ReplayVerifyOutput {
  if (typeof params.replayArtifactJson !== "string" || params.replayArtifactJson.length === 0) {
    throw new Error("replayArtifactJson required");
  }
  if (params.replayArtifactJson.length > 1024 * 1024) throw new Error("replayArtifactJson too large");
  const artifact = JSON.parse(params.replayArtifactJson) as ReplayArtifactV1;
  assertPublicReplayArtifact(artifact);
  const decoded = replayArtifactToResultV1(artifact, {
    allowConstantsMismatch: params.allowConstantsMismatch === true,
  });
  const summary: ReplayVerifySummary = {
    kind: REPLAY_VERIFY_KERNEL_ID,
    matchId: artifact.match.matchId,
    mode: artifact.match.mode,
    stageId: artifact.match.stageId,
    seed: artifact.match.seed,
    actionLogHash: artifact.actions.hash,
    actionLogSha256: artifact.actions.sha256,
    simConstantsHash: artifact.sim.constantsHash,
    behaviorVersion: artifact.trust?.behaviorVersion,
    consumedDecisionTicks: decoded.consumedDecisionTicks,
    result: decoded.result,
  };
  const outputBytes = new TextEncoder().encode(stableReplayJson(summary));
  return {
    outputBytes,
    outputHash: sha256(outputBytes),
    summary,
  };
}

function assertPublicReplayArtifact(artifact: ReplayArtifactV1): void {
  if (!artifact || artifact.schema !== "m3t4.replay" || artifact.version !== 1) {
    throw new Error("replay artifact v1 required");
  }
  if (artifact.players?.some((player) => player && "config" in player && player.config !== undefined)) {
    throw new Error("private player config is not allowed in replay verify tasks");
  }
}
