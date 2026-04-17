import type { BrainConfig, Character, MatchResult, Stage } from "./types.js";
export declare const REPLAY_SCHEMA_ID = "m3t4.replay";
export declare const REPLAY_SCHEMA_VERSION = 1;
export declare const REPLAY_ACTION_ENCODING = "decision-action-pairs-v1";
export declare const REPLAY_FRAME_ENCODING = "trace-frames-v1";
export declare const REPLAY_RULESET = "m3t4-sim-v1";
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
    players: [Omit<ReplayPlayerV1, "side"> & {
        side?: 0 | 1;
    }, Omit<ReplayPlayerV1, "side"> & {
        side?: 0 | 1;
    }];
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
}
export interface ReplayDecodeResultV1 {
    result: ReplayResultV1;
    consumedBytes: number;
    consumedDecisionTicks: number;
}
export declare function replayBytesToBase64(bytes: Uint8Array): string;
export declare function replayBase64ToBytes(encoded: string): Uint8Array;
export declare function replayHashBytes(bytes: Uint8Array): string;
export declare function stableReplayJson(value: unknown): string;
export declare function replayHashJson(value: unknown): string;
export declare function createReplayArtifactV1(opts: CreateReplayArtifactV1Options): ReplayArtifactV1;
export declare function decodeReplayActions(log: ReplayActionLogV1): Uint8Array;
export declare function verifyReplayIntegrityV1(artifact: ReplayArtifactV1): void;
export declare function replayArtifactWarningsV1(artifact: ReplayArtifactV1): string[];
export declare function replayArtifactToResultV1(artifact: ReplayArtifactV1, opts?: ReplayDecodeOptionsV1): ReplayDecodeResultV1;
export declare function isReplayArtifactV1(value: unknown): value is ReplayArtifactV1;
