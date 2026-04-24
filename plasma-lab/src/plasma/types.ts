// Minimal Plasma contract slice, vendored from ../plasma as of 2026-04-21.
// Keep this transport-neutral. Browser WebRTC code belongs in a browser-only
// package before it is imported by production surfaces.

export type HashAlgorithm = "sha256";

export interface ContentHash {
  algorithm: HashAlgorithm;
  value: string;
}

export type DeterminismClass =
  | "bit-exact"
  | "tolerance-bounded"
  | "replicated-quorum";

export type RuntimeSurface =
  | "browser-js"
  | "browser-wasm"
  | "browser-webgpu"
  | "cpu-reference";

export type ValidationMode =
  | "expected-hash"
  | "quorum"
  | "tolerance"
  | "human-review"
  | "measurement";

export type TransportKind = "http" | "webrtc" | "local";

export type GovernorMode = "quiet" | "standard" | "after-match";

export type ExecutionMode = "cpu" | "webgpu";

export type TaskKind =
  | "prime-search.v0"
  | "device_witness.webgpu.v0"
  | "device_witness.render_fixture.v0"
  | "device_witness.webrtc.v0"
  | "device_witness.derived_buffer.v0"
  | "asset.tile_audit.v0"
  | "ml.image_tile_infer.v0"
  | "science.contact_map_tile.v0"
  | "science.genome_kmer.v0"
  | "science.mandelbrot_tile.v0"
  | "science.microscopy_tile_score.v0"
  | "m3t4.exploit_search.v0"
  | "m3t4.public_artifact_verify.v0"
  | "m3t4.seed_sweep.v0"
  | "m3t4.replay_verify.v1"
  | "plasma.tensor_tile.v0";

export interface ValidationPolicy {
  determinismClass: DeterminismClass;
  validationMode: ValidationMode;
  minExecutions: number;
  minAgreeing: number;
  expectedOutputHash?: ContentHash;
  requiredTransport?: TransportKind;
  requiredPeerSubreceipt?: boolean;
}

export interface DerivedExecutionEvidence {
  contractVersion: "derived-compute-extension.v0";
  sourceHashes: Record<string, ContentHash>;
  bufferRegionHashes: Record<string, ContentHash>;
  outputHashes: Record<string, ContentHash>;
  producerKernelHashes: Record<string, ContentHash>;
  gameVisibleOutputHash?: ContentHash;
  derivedOutputHash?: ContentHash;
}

export interface WorkerCapability {
  kernels: string[];
  runtimeSurfaces: RuntimeSurface[];
  maxChunkBytes: number;
  maxConcurrentChunks: number;
  deviceClass?: string;
  adapterInfo?: Record<string, unknown>;
  capabilityHash?: ContentHash;
  clientVersion?: string;
}

export type WorkerRefusalReason =
  | "not-now"
  | "render-struggling"
  | "tab-hidden"
  | "low-battery"
  | "chunk-too-large"
  | "unsupported-kernel"
  | "user-disabled";

export type ReceiptDecision =
  | "pending"
  | "accepted"
  | "rejected"
  | "timeout"
  | "quorum-missing"
  | "disagreement"
  | "malformed"
  | "assignment-mismatch"
  | "duplicate-receipt"
  | "input-mismatch"
  | "output-mismatch"
  | "kernel-mismatch"
  | "validator-error"
  | "internal-error";
