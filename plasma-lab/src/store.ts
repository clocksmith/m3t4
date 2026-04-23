import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import {
  DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_HASH,
  DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
  DEVICE_WITNESS_RENDER_KERNEL_HASH,
  DEVICE_WITNESS_RENDER_KERNEL_ID,
  DEVICE_WITNESS_WEBRTC_KERNEL_HASH,
  DEVICE_WITNESS_WEBRTC_KERNEL_ID,
  DEVICE_WITNESS_WEBGPU_KERNEL_HASH,
  DEVICE_WITNESS_WEBGPU_KERNEL_ID,
  runDeviceWitnessDerivedBufferReference,
  runDeviceWitnessRenderReference,
  runDeviceWitnessWebGpuReference,
} from "./kernels/device-witness.js";
import {
  PRIME_SEARCH_KERNEL_HASH,
  PRIME_SEARCH_KERNEL_ID,
  runPrimeSearch,
  type PrimeParams,
} from "./kernels/prime-search.js";
import {
  ASSET_TILE_AUDIT_KERNEL_HASH,
  ASSET_TILE_AUDIT_KERNEL_ID,
  normalizeAssetTileAuditParams,
  runAssetTileAuditReference,
} from "./kernels/asset-tile-audit.js";
import {
  EMBEDDING_TILE_KERNEL_HASH,
  EMBEDDING_TILE_KERNEL_ID,
  EMBEDDING_TILE_MODEL_ID,
  embeddingTilePlaceholderOutputHash,
  normalizeEmbeddingTileParams,
} from "./kernels/embedding-tile.js";
import {
  EXPLOIT_SEARCH_KERNEL_HASH,
  EXPLOIT_SEARCH_KERNEL_ID,
  normalizeExploitSearchParams,
  runExploitSearchReference,
} from "./kernels/exploit-search.js";
import {
  IMAGE_TILE_INFER_KERNEL_HASH,
  IMAGE_TILE_INFER_KERNEL_ID,
  normalizeImageTileInferParams,
  runImageTileInferReference,
} from "./kernels/image-tile-infer.js";
import {
  PREFILL_TOPK_PROBE_KERNEL_HASH,
  PREFILL_TOPK_PROBE_KERNEL_ID,
  PREFILL_TOPK_PROBE_MODEL_ID,
  normalizePrefillTopkProbeParams,
  prefillTopkProbePlaceholderOutputHash,
} from "./kernels/prefill-topk-probe.js";
import {
  LOGIT_DIVERGENCE_KERNEL_HASH,
  LOGIT_DIVERGENCE_KERNEL_ID,
  LOGIT_DIVERGENCE_MODEL_ID,
  logitDivergencePlaceholderOutputHash,
  logitDivergencePublicOutputHash,
  normalizeLogitDivergenceParams,
  normalizeLogitDivergencePublicOutput,
} from "./kernels/logit-divergence.js";
import {
  GENOME_KMER_KERNEL_HASH,
  GENOME_KMER_KERNEL_ID,
  normalizeGenomeKmerParams,
  runGenomeKmerReference,
} from "./kernels/genome-kmer.js";
import {
  MICROSCOPY_TILE_SCORE_KERNEL_HASH,
  MICROSCOPY_TILE_SCORE_KERNEL_ID,
  normalizeMicroscopyTileScoreParams,
  runMicroscopyTileScoreReference,
} from "./kernels/microscopy-tile-score.js";
import {
  CONTACT_MAP_TILE_KERNEL_HASH,
  CONTACT_MAP_TILE_KERNEL_ID,
  normalizeContactMapTileParams,
  runContactMapTileReference,
} from "./kernels/contact-map-tile.js";
import {
  PUBLIC_ARTIFACT_VERIFY_KERNEL_HASH,
  PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,
  runPublicArtifactVerify,
} from "./kernels/public-artifact-verify.js";
import {
  REPLAY_VERIFY_KERNEL_HASH,
  REPLAY_VERIFY_KERNEL_ID,
  runReplayVerify,
} from "./kernels/replay-verify.js";
import {
  SEED_SWEEP_KERNEL_BINDING,
  SEED_SWEEP_KERNEL_HASH,
  SEED_SWEEP_KERNEL_ID,
  runSeedSweep,
} from "./kernels/seed-sweep.js";
import {
  TENSOR_TILE_KERNEL_HASH,
  TENSOR_TILE_KERNEL_ID,
  normalizeTensorTileParams,
  runTensorTileReference,
} from "./kernels/tensor-tile.js";
import { canonicalJson, hashCanonical, randomId, randomToken, sha256 } from "./plasma/hash.js";
import type {
  ContentHash,
  DerivedExecutionEvidence,
  ExecutionMode,
  GovernorMode,
  ReceiptDecision,
  TaskKind,
  TransportKind,
  ValidationPolicy,
  WorkerCapability,
  WorkerRefusalReason,
} from "./plasma/types.js";

export const COMPUTE_COLLECTIONS = {
  workers: "compute_workers",
  capabilities: "compute_capabilities",
  tasks: "compute_tasks",
  chunks: "compute_chunks",
  assignments: "compute_assignments",
  receipts: "compute_receipts",
  validations: "compute_validations",
  reputation: "compute_reputation",
  artifactExports: "compute_artifact_exports",
  sessions: "compute_sessions",
  webrtcSessions: "compute_webrtc_sessions",
  webrtcPairs: "compute_webrtc_pairs",
  peerSubassignments: "compute_peer_subassignments",
  capabilityObservations: "compute_capability_observations",
  connectivityObservations: "compute_connectivity_observations",
  workerProfiles: "compute_worker_profiles",
  deviceClasses: "compute_device_classes",
  networkClasses: "compute_network_classes",
  publicStats: "compute_public_stats",
  replayBadges: "compute_replay_badges",
  control: "compute_control",
} as const;

const KNOWN_KERNELS = [
  PRIME_SEARCH_KERNEL_ID,
  DEVICE_WITNESS_WEBGPU_KERNEL_ID,
  DEVICE_WITNESS_RENDER_KERNEL_ID,
  DEVICE_WITNESS_WEBRTC_KERNEL_ID,
  DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
  ASSET_TILE_AUDIT_KERNEL_ID,
  EMBEDDING_TILE_KERNEL_ID,
  EXPLOIT_SEARCH_KERNEL_ID,
  IMAGE_TILE_INFER_KERNEL_ID,
  MICROSCOPY_TILE_SCORE_KERNEL_ID,
  PREFILL_TOPK_PROBE_KERNEL_ID,
  LOGIT_DIVERGENCE_KERNEL_ID,
  CONTACT_MAP_TILE_KERNEL_ID,
  GENOME_KMER_KERNEL_ID,
  PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,
  SEED_SWEEP_KERNEL_ID,
  REPLAY_VERIFY_KERNEL_ID,
  TENSOR_TILE_KERNEL_ID,
];

export interface WorkerRecord {
  workerId: string;
  label?: string;
  capability: WorkerCapability;
  registeredAt: number;
  lastSeenAt: number;
  clientId?: string;
  accountUid?: string;
}

export interface WorkerSession {
  workerSessionId: string;
  workerId: string;
  token: string;
  signingPublicKey?: JsonWebKey;
  signingPublicKeyHash?: ContentHash;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  governorMode?: GovernorMode;
}

export interface CapabilityObservation {
  observationId: string;
  workerId: string;
  workerSessionId: string;
  observedAt: number;
  reason: "register" | "update";
  deviceClass?: string;
  runtimeSurfaces: string[];
  kernels: string[];
  adapterInfo?: Record<string, unknown>;
  capabilityHash?: ContentHash;
  clientVersion?: string;
}

export interface ConnectivityObservation {
  observationId: string;
  workerId: string;
  workerSessionId: string;
  observedAt: number;
  transport: "http" | "webrtc-local" | "webrtc-signaling";
  status: "ok" | "timeout" | "failed" | "unsupported";
  mode?: GovernorMode;
  browserFamily?: string;
  deviceClass?: string;
  networkTypeBucket?: string;
  downlinkBucket?: string;
  rttBucket?: string;
  httpRttBucket?: string;
  webrtcOpenMsBucket?: string;
  iceGatherMsBucket?: string;
  iceHostBucket?: string;
  iceSrflxBucket?: string;
  iceRelayBucket?: string;
  stunSuccessBucket?: string;
  turnNeedBucket?: string;
  signalingRttBucket?: string;
  dataChannelBucket?: string;
  dataWorkBucket?: string;
  dataReceiptBucket?: string;
  visibilityBucket?: string;
  batteryBucket?: string;
  notes?: string;
}

export interface WebRtcCandidateRecord {
  candidateId: string;
  sessionId: string;
  peerId?: string;
  payload: unknown;
  createdAt: number;
}

export interface WebRtcSessionRecord {
  sessionId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  status: "open" | "closed";
  offer?: unknown;
  answer?: unknown;
  candidates: WebRtcCandidateRecord[];
}

export interface WebRtcPairRecord {
  pairId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  status: "waiting" | "matched" | "closed";
  offererWorkerId: string;
  offererSessionId: string;
  answererWorkerId?: string;
  answererSessionId?: string;
  offer?: unknown;
  answer?: unknown;
  candidates: WebRtcCandidateRecord[];
}

export interface WebRtcPairSummary {
  pairId: string;
  status: WebRtcPairRecord["status"];
  createdAt: number;
  expiresAt: number;
  offererWorkerId: string;
  answererWorkerId?: string;
  hasOffer: boolean;
  hasAnswer: boolean;
  candidateCount: number;
  peerCount: number;
  lastCandidateAt?: number;
}

export interface ComputeChunk {
  chunkId: string;
  taskId: string;
  ordinal: number;
  kind: TaskKind;
  params: Record<string, number | string | boolean>;
  kernelId: string;
  kernelHash: ContentHash;
  inputHash: ContentHash;
  artifactHash?: ContentHash;
  expectedOutputHash: ContentHash;
  status: ReceiptDecision;
}

export interface ComputeTask {
  taskId: string;
  kind: TaskKind;
  status: "running" | "complete" | "cancelled";
  createdAt: number;
  validationPolicy: ValidationPolicy;
  chunks: ComputeChunk[];
}

export interface Assignment {
  assignmentId: string;
  assignmentToken: string;
  taskId: string;
  chunkId: string;
  workerId: string;
  workerSessionId: string;
  status: "offered" | "accepted" | "receipted" | "cancelled" | "timeout";
  assignedAt: number;
  expiresAt: number;
  acceptedAt?: number;
  refusalReason?: WorkerRefusalReason;
}

export interface PeerSubassignment {
  peerAssignmentId: string;
  peerAssignmentToken: string;
  parentAssignmentId: string;
  pairId: string;
  requestId: string;
  requesterWorkerId: string;
  requesterSessionId: string;
  peerWorkerId: string;
  peerSessionId: string;
  taskId: string;
  chunkId: string;
  kernelId: string;
  kernelHash: ContentHash;
  inputHash: ContentHash;
  artifactHash?: ContentHash;
  createdAt: number;
  expiresAt: number;
  status: "issued" | "accepted" | "rejected" | "expired" | "cancelled";
  outputHash?: ContentHash;
  peerReceiptHash?: ContentHash;
  receivedAt?: number;
  computeMs?: number;
  clientVersion?: string;
  reason?: string;
}

export interface ExecutionReceipt {
  receiptId: string;
  workerId: string;
  workerSessionId: string;
  assignmentId: string;
  taskId: string;
  chunkId: string;
  kernelId: string;
  kernelHash: ContentHash;
  inputHash: ContentHash;
  artifactHash?: ContentHash;
  outputHash: ContentHash;
  determinismClass: ValidationPolicy["determinismClass"];
  validationMode: ValidationPolicy["validationMode"];
  executionMode: ExecutionMode;
  transport: TransportKind;
  governorMode?: GovernorMode;
  deviceClass?: string;
  adapterInfo?: Record<string, unknown>;
  derived?: DerivedExecutionEvidence;
  publicOutput?: Record<string, unknown>;
  computeMs: number;
  receivedAt: number;
  clientVersion?: string;
  receiptHash?: ContentHash;
  signature?: string;
  signaturePublicKeyHash?: ContentHash;
  signatureStatus?: "unsigned" | "verified" | "missing" | "invalid" | "key-unavailable";
  decision: ReceiptDecision;
  reason?: string;
  clientId?: string;
  accountUid?: string;
}

export interface ReceiptVerification {
  receiptId: string;
  ok: boolean;
  decision: ReceiptDecision;
  receiptHash: ContentHash;
  storedReceiptHash?: ContentHash;
  receiptHashMatches: boolean;
  signatureRequired: boolean;
  signatureStatus: ExecutionReceipt["signatureStatus"];
  signatureVerified: boolean;
  signaturePublicKeyHash?: ContentHash;
  receipt: Omit<ExecutionReceipt, "signature">;
}

export interface ValidationRecord {
  validationId: string;
  taskId: string;
  chunkId: string;
  status: ReceiptDecision;
  comparedReceiptIds: string[];
  acceptedReceiptIds: string[];
  reason?: string;
  recordedAt: number;
}

export interface ReputationRecord {
  workerId: string;
  accepted: number;
  rejected: number;
  timeouts: number;
  disagreements: number;
}

export interface WorkerProfile {
  workerId: string;
  lastSeenAt: number;
  browserFamily: string;
  deviceClass: string;
  adapterClass: string;
  webgpuAvailable: boolean;
  webgpuCorrectnessScore: number | null;
  renderFixtureScore: number | null;
  webrtcDirectSuccessRate: number | null;
  turnRequiredRate: number | null;
  avgKernelMs: number | null;
  p95KernelMs: number | null;
  avgFrameRegressionMs: number | null;
  webgpuWitnessReceipts: number;
  renderWitnessReceipts: number;
  allowedWorkloadTier: "observe-only" | "cpu-light" | "webgpu-light";
  trustScore: number;
  recentFailureRate: number | null;
  acceptedReceipts: number;
  rejectedReceipts: number;
  timeoutAssignments: number;
  failureBuckets: Record<string, number>;
}

export interface ClassProfile {
  classId: string;
  workers: number;
  activeWorkers: number;
  avgKernelMs: number | null;
  p95KernelMs: number | null;
  webgpuCorrectnessScore: number | null;
  renderFixtureScore: number | null;
  webrtcDirectSuccessRate: number | null;
  turnRequiredRate: number | null;
}

export interface PublicComputeStats {
  generatedAt: number;
  privacy: "full" | "suppressed";
  minWorkers: number;
  scoreVersion: "compute-score-v1";
  computeScore: number;
  scoreBreakdown: ComputeScoreBreakdown;
  totalWorkers: number;
  activeWorkers: number;
  totalReceipts: number;
  acceptedReceiptPct: number | null;
  webgpuSupportedPct: number | null;
  webgpuCorrectnessPct: number | null;
  renderFixturePct: number | null;
  webrtcDirectSuccessPct: number | null;
  turnRequiredPct: number | null;
  medianKernelMs: number | null;
  p95KernelMs: number | null;
  allowedTierBuckets: Record<string, number>;
  adapterBuckets: Record<string, number>;
  failureBuckets: Record<string, number>;
}

export interface ComputeScoreBreakdown {
  acceptedReceipts: number;
  rejectedReceipts: number;
  acceptedAssetTileAuditChunks: number;
  acceptedContactMapTileChunks: number;
  acceptedContactMapTileCells: number;
  acceptedEmbeddingTileChunks: number;
  acceptedExploitSearchChunks: number;
  acceptedExploitSearchSeeds: number;
  acceptedImageTileInferChunks: number;
  acceptedLogitDivergenceChunks: number;
  acceptedMicroscopyTileScoreChunks: number;
  acceptedPrefillTopkProbeChunks: number;
  acceptedPublicArtifactChunks: number;
  acceptedReplayVerifyChunks: number;
  acceptedSeedSweepChunks: number;
  acceptedSeedSweepSeeds: number;
  acceptedTensorTileChunks: number;
  acceptedTensorTileCells: number;
  acceptedWebGpuWitnessReceipts: number;
  acceptedWebRtcReceipts: number;
}

export interface ReplayVerificationBadge {
  matchId: string;
  workload: string;
  status: "verified" | "pending" | "failed";
  agreedReceipts: number;
  requiredReceipts: number;
  artifactHash?: string;
  artifactSha256?: string;
  rulesHash?: string;
  stageHash?: string;
  actionLogHash?: string;
  actionLogSha256?: string;
  outputHash?: string;
  transports?: string[];
  transfers?: string[];
  verifiedAt?: number;
  taskId: string;
  chunkId: string;
}

export interface ContactMapPublicAggregateReceipt {
  receiptId: string;
  outputHash: ContentHash;
  executionMode: ExecutionMode;
  transport: TransportKind;
  receivedAt: number;
  signatureStatus: "unsigned" | "verified" | "missing" | "invalid" | "key-unavailable";
}

export interface ContactMapPublicAggregateTile {
  taskId: string;
  status: ComputeTask["status"];
  rowStart: number;
  colStart: number;
  rowResidues: string;
  colResidues: string;
  minSeparation: number;
  expectedOutputHash: ContentHash | null;
  receiptCount: number;
  acceptedCount: number;
  receipts: ContactMapPublicAggregateReceipt[];
}

export interface ContactMapPublicAggregate {
  kernelId: typeof CONTACT_MAP_TILE_KERNEL_ID;
  totalTasks: number;
  totalAcceptedReceipts: number;
  tiles: ContactMapPublicAggregateTile[];
}

export interface PersonalReceiptsResult {
  scope: "session" | "browser" | "account";
  clientId: string | null;
  accountUid: string | null;
  receipts: PersonalReceipt[];
}

export interface PersonalReceipt {
  receiptId: string;
  taskId: string;
  chunkId: string;
  kernelId: string;
  kernelHash: ContentHash;
  taskKind: string;
  decision: ReceiptDecision;
  reason?: string;
  receivedAt: number;
  computeMs: number;
  executionMode: ExecutionMode;
  transport: TransportKind;
  outputHash: ContentHash;
  signatureStatus: "unsigned" | "verified" | "missing" | "invalid" | "key-unavailable";
}

export interface StoreOptions {
  now?: () => number;
  assignmentTimeoutMs?: number;
  workerSessionTtlMs?: number;
  webrtcSessionTtlMs?: number;
  acceptAssignments?: boolean;
  requireReceiptSignatures?: boolean;
}

export interface ComputeLabSnapshot {
  control: {
    acceptAssignments: boolean;
    assignmentIntakeClosesAt: number | null;
  };
  workers: WorkerRecord[];
  sessions: WorkerSession[];
  tasks: ComputeTask[];
  assignments: Assignment[];
  receipts: ExecutionReceipt[];
  validations: ValidationRecord[];
  reputation: ReputationRecord[];
  webrtcSessions: WebRtcSessionRecord[];
  webrtcPairs: WebRtcPairRecord[];
  peerSubassignments: PeerSubassignment[];
  capabilityObservations: CapabilityObservation[];
  connectivityObservations: ConnectivityObservation[];
}

export class ComputeLabStore {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly tasks = new Map<string, ComputeTask>();
  private readonly assignments = new Map<string, Assignment>();
  private readonly receipts = new Map<string, ExecutionReceipt>();
  private readonly validations = new Map<string, ValidationRecord>();
  private readonly reputation = new Map<string, ReputationRecord>();
  private readonly webrtcSessions = new Map<string, WebRtcSessionRecord>();
  private readonly webrtcPairs = new Map<string, WebRtcPairRecord>();
  private readonly peerSubassignments = new Map<string, PeerSubassignment>();
  private readonly capabilityObservations = new Map<string, CapabilityObservation>();
  private readonly connectivityObservations = new Map<string, ConnectivityObservation>();
  private readonly now: () => number;
  private readonly assignmentTimeoutMs: number;
  private readonly workerSessionTtlMs: number;
  private readonly webrtcSessionTtlMs: number;
  private readonly requireReceiptSignatures: boolean;
  private acceptAssignmentsFlag: boolean;
  private assignmentIntakeClosesAt: number | null = null;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.assignmentTimeoutMs = options.assignmentTimeoutMs ?? 60_000;
    this.workerSessionTtlMs = options.workerSessionTtlMs ?? 3_600_000;
    this.webrtcSessionTtlMs = options.webrtcSessionTtlMs ?? 600_000;
    this.requireReceiptSignatures = options.requireReceiptSignatures ?? false;
    this.acceptAssignmentsFlag = options.acceptAssignments ?? false;
  }

  setAcceptAssignments(value: boolean, durationMs?: number): void {
    this.acceptAssignmentsFlag = value;
    this.assignmentIntakeClosesAt = value && durationMs !== undefined ? this.now() + durationMs : null;
  }

  private expireAssignmentIntake(): void {
    if (
      this.acceptAssignmentsFlag &&
      this.assignmentIntakeClosesAt !== null &&
      this.now() >= this.assignmentIntakeClosesAt
    ) {
      this.acceptAssignmentsFlag = false;
      this.assignmentIntakeClosesAt = null;
    }
  }

  exportSnapshot(): ComputeLabSnapshot {
    this.expireAssignmentIntake();
    return {
      control: {
        acceptAssignments: this.acceptAssignmentsFlag,
        assignmentIntakeClosesAt: this.assignmentIntakeClosesAt,
      },
      workers: Array.from(this.workers.values()),
      sessions: Array.from(this.sessions.values()),
      tasks: Array.from(this.tasks.values()),
      assignments: Array.from(this.assignments.values()),
      receipts: Array.from(this.receipts.values()),
      validations: Array.from(this.validations.values()),
      reputation: Array.from(this.reputation.values()),
      webrtcSessions: Array.from(this.webrtcSessions.values()),
      webrtcPairs: Array.from(this.webrtcPairs.values()),
      peerSubassignments: Array.from(this.peerSubassignments.values()),
      capabilityObservations: Array.from(this.capabilityObservations.values()),
      connectivityObservations: Array.from(this.connectivityObservations.values()),
    };
  }

  loadSnapshot(snapshot: Partial<ComputeLabSnapshot>): void {
    this.workers.clear();
    this.sessions.clear();
    this.tasks.clear();
    this.assignments.clear();
    this.receipts.clear();
    this.validations.clear();
    this.reputation.clear();
    this.webrtcSessions.clear();
    this.webrtcPairs.clear();
    this.peerSubassignments.clear();
    this.capabilityObservations.clear();
    this.connectivityObservations.clear();
    if (snapshot.control) {
      this.acceptAssignmentsFlag = snapshot.control.acceptAssignments;
      this.assignmentIntakeClosesAt = snapshot.control.assignmentIntakeClosesAt;
      this.expireAssignmentIntake();
    }
    for (const worker of snapshot.workers ?? []) this.workers.set(worker.workerId, worker);
    for (const session of snapshot.sessions ?? []) this.sessions.set(session.workerSessionId, session);
    for (const task of snapshot.tasks ?? []) this.tasks.set(task.taskId, task);
    for (const assignment of snapshot.assignments ?? []) this.assignments.set(assignment.assignmentId, assignment);
    for (const receipt of snapshot.receipts ?? []) this.receipts.set(receipt.receiptId, receipt);
    for (const validation of snapshot.validations ?? []) this.validations.set(validation.validationId, validation);
    for (const rep of snapshot.reputation ?? []) this.reputation.set(rep.workerId, rep);
    for (const session of snapshot.webrtcSessions ?? []) this.webrtcSessions.set(session.sessionId, session);
    for (const pair of snapshot.webrtcPairs ?? []) this.webrtcPairs.set(pair.pairId, pair);
    for (const subassignment of snapshot.peerSubassignments ?? []) this.peerSubassignments.set(subassignment.peerAssignmentId, subassignment);
    for (const obs of snapshot.capabilityObservations ?? []) this.capabilityObservations.set(obs.observationId, obs);
    for (const obs of snapshot.connectivityObservations ?? []) this.connectivityObservations.set(obs.observationId, obs);
  }

  registerWorker(input: { label?: string; capability: WorkerCapability; signingPublicKey?: JsonWebKey; clientId?: string; accountUid?: string }): {
    worker: WorkerRecord;
    session: WorkerSession;
    acceptedKernels: string[];
  } {
    const now = this.now();
    const acceptedKernels = input.capability.kernels.filter((kernel) => KNOWN_KERNELS.includes(kernel));
    const workerId = randomId("cw");
    const clientId = normalizeIdentityToken(input.clientId);
    const accountUid = normalizeIdentityToken(input.accountUid);
    const worker: WorkerRecord = {
      workerId,
      label: input.label,
      capability: { ...input.capability, kernels: acceptedKernels },
      registeredAt: now,
      lastSeenAt: now,
      clientId,
      accountUid,
    };
    this.workers.set(workerId, worker);
    const session = this.createSession(workerId, input.signingPublicKey);
    this.recordCapabilityObservation(worker, session, "register");
    this.reputation.set(workerId, {
      workerId,
      accepted: 0,
      rejected: 0,
      timeouts: 0,
      disagreements: 0,
    });
    return { worker, session, acceptedKernels };
  }

  heartbeat(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    governorMode?: GovernorMode;
  }): WorkerSession {
    const session = this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    session.lastSeenAt = this.now();
    session.governorMode = input.governorMode ?? session.governorMode;
    const worker = this.workers.get(input.workerId);
    if (worker) worker.lastSeenAt = session.lastSeenAt;
    return session;
  }

  updateCapability(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    capability: WorkerCapability;
  }): WorkerRecord {
    this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const worker = this.requireWorker(input.workerId);
    const acceptedKernels = input.capability.kernels.filter((kernel) => KNOWN_KERNELS.includes(kernel));
    worker.capability = { ...input.capability, kernels: acceptedKernels };
    worker.lastSeenAt = this.now();
    this.recordCapabilityObservation(worker, this.sessions.get(input.workerSessionId), "update");
    return worker;
  }

  submitConnectivityObservation(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    observation: Omit<ConnectivityObservation, "observationId" | "workerId" | "workerSessionId" | "observedAt">;
  }): ConnectivityObservation {
    this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const worker = this.requireWorker(input.workerId);
    const observation: ConnectivityObservation = {
      ...sanitizeConnectivityObservation(input.observation),
      observationId: randomId("net"),
      workerId: input.workerId,
      workerSessionId: input.workerSessionId,
      observedAt: this.now(),
      deviceClass: input.observation.deviceClass ?? worker.capability.deviceClass,
      browserFamily: input.observation.browserFamily ?? stringBucket(worker.capability.adapterInfo?.userAgentBucket),
    };
    this.connectivityObservations.set(observation.observationId, observation);
    this.trimObservations();
    return observation;
  }

  workerStatus(workerId: string): {
    worker: WorkerRecord;
    sessions: number;
    assignments: Assignment[];
    reputation: ReputationRecord;
  } | null {
    const worker = this.workers.get(workerId);
    if (!worker) return null;
    return {
      worker,
      sessions: Array.from(this.sessions.values()).filter((session) => session.workerId === workerId).length,
      assignments: Array.from(this.assignments.values()).filter((assignment) => assignment.workerId === workerId),
      reputation: this.reputation.get(workerId) ?? {
        workerId,
        accepted: 0,
        rejected: 0,
        timeouts: 0,
        disagreements: 0,
      },
    };
  }

  seedPrimeTask(input: {
    start: number;
    endExclusive: number;
    chunkSize: number;
    minExecutions?: number;
    minAgreeing?: number;
  }): ComputeTask {
    const start = asInt(input.start, "start");
    const endExclusive = asInt(input.endExclusive, "endExclusive");
    const chunkSize = asInt(input.chunkSize, "chunkSize");
    if (chunkSize <= 0) throw new Error("chunkSize must be positive");
    if (endExclusive <= start) throw new Error("endExclusive must be greater than start");
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunks: ComputeChunk[] = [];
    let ordinal = 0;
    for (let cursor = start; cursor < endExclusive; cursor += chunkSize) {
      const params = {
        start: cursor,
        endExclusive: Math.min(endExclusive, cursor + chunkSize),
      };
      const inputHash = hashCanonical({ kind: PRIME_SEARCH_KERNEL_ID, params });
      const expectedOutputHash = runPrimeSearch(params).outputHash;
      chunks.push({
        chunkId: `${taskId}-chunk-${ordinal}`,
        taskId,
        ordinal,
        kind: PRIME_SEARCH_KERNEL_ID,
        params,
        kernelId: PRIME_SEARCH_KERNEL_ID,
        kernelHash: PRIME_SEARCH_KERNEL_HASH,
        inputHash,
        expectedOutputHash,
        status: "pending",
      });
      ordinal++;
    }
    const validationPolicy: ValidationPolicy = {
      determinismClass: "bit-exact",
      validationMode: "expected-hash",
      minExecutions,
      minAgreeing,
    };
    const task: ComputeTask = {
      taskId,
      kind: PRIME_SEARCH_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy,
      chunks,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedDeviceWitnessWebGpuTask(input: {
    seed?: number;
    count?: number;
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const seed = asInt(input.seed ?? 1, "seed");
    const count = asInt(input.count ?? 256, "count");
    if (count <= 0 || count > 4096) throw new Error("count must be 1..4096");
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 1);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 1));
    const params = { seed, count };
    const expectedOutputHash = runDeviceWitnessWebGpuReference(params).outputHash;
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: DEVICE_WITNESS_WEBGPU_KERNEL_ID,
      params,
      kernelId: DEVICE_WITNESS_WEBGPU_KERNEL_ID,
      kernelHash: DEVICE_WITNESS_WEBGPU_KERNEL_HASH,
      inputHash: hashCanonical({ kind: DEVICE_WITNESS_WEBGPU_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: DEVICE_WITNESS_WEBGPU_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedDeviceWitnessRenderTask(input: {
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 1);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 1));
    const params = { fixture: "canvas2d-alpha-samples-v1" };
    const expectedOutputHash = runDeviceWitnessRenderReference().outputHash;
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: DEVICE_WITNESS_RENDER_KERNEL_ID,
      params,
      kernelId: DEVICE_WITNESS_RENDER_KERNEL_ID,
      kernelHash: DEVICE_WITNESS_RENDER_KERNEL_HASH,
      inputHash: hashCanonical({ kind: DEVICE_WITNESS_RENDER_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: DEVICE_WITNESS_RENDER_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedDeviceWitnessDerivedBufferTask(input: {
    seed?: number;
    count?: number;
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const seed = asInt(input.seed ?? 11, "seed");
    const count = asInt(input.count ?? 128, "count");
    if (count <= 0 || count > 4096) throw new Error("count must be 1..4096");
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 1);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 1));
    const reference = runDeviceWitnessDerivedBufferReference({ seed, count });
    const params = {
      seed,
      count,
      sourceId: reference.sourceId,
      regionId: reference.regionId,
      outputId: reference.outputId,
      sourceHash: reference.sourceHash.value,
      regionHash: reference.regionHash.value,
      producerKernelHash: reference.producerKernelHash.value,
    };
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
      params,
      kernelId: DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
      kernelHash: DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_HASH,
      inputHash: hashCanonical({ kind: DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID, params }),
      artifactHash: reference.sourceHash,
      expectedOutputHash: reference.outputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash: reference.outputHash,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedDeviceWitnessWebRtcTask(input: {
    timeoutMs?: number;
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const timeoutMs = asInt(input.timeoutMs ?? 1800, "timeoutMs");
    if (timeoutMs < 250 || timeoutMs > 10_000) throw new Error("timeoutMs must be 250..10000");
    const taskId = randomId("task");
    const challengeId = randomId("rtc-chal");
    const minExecutions = Math.max(1, input.minExecutions ?? 1);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 1));
    const params = {
      challengeId,
      fixture: "local-datachannel-transcript-v1",
      timeoutMs,
    };
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: DEVICE_WITNESS_WEBRTC_KERNEL_ID,
      params,
      kernelId: DEVICE_WITNESS_WEBRTC_KERNEL_ID,
      kernelHash: DEVICE_WITNESS_WEBRTC_KERNEL_HASH,
      inputHash: hashCanonical({ kind: DEVICE_WITNESS_WEBRTC_KERNEL_ID, params }),
      expectedOutputHash: hashCanonical({ kind: DEVICE_WITNESS_WEBRTC_KERNEL_ID, params, validation: "measurement" }),
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: DEVICE_WITNESS_WEBRTC_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "replicated-quorum",
        validationMode: "measurement",
        minExecutions,
        minAgreeing,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  createPublicArtifactVerifyContract(input: {
    artifactHash: ContentHash;
    expectedOutputHash: ContentHash;
  }): {
    kind: "m3t4.public_artifact_verify.v0";
    validationPolicy: ValidationPolicy;
    artifactHash: ContentHash;
    expectedOutputHash: ContentHash;
  } {
    return {
      kind: "m3t4.public_artifact_verify.v0",
      artifactHash: input.artifactHash,
      expectedOutputHash: input.expectedOutputHash,
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions: 2,
        minAgreeing: 2,
        expectedOutputHash: input.expectedOutputHash,
      },
    };
  }

  seedPublicArtifactVerifyTask(input: {
    matchId: string;
    artifactHash: string;
    artifactSha256: string;
    artifactJson: string;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    if (!input.matchId) throw new Error("matchId required");
    if (!input.artifactHash) throw new Error("artifactHash required");
    if (!input.artifactSha256) throw new Error("artifactSha256 required");
    const expectedOutputHash = runPublicArtifactVerify({ artifactJson: input.artifactJson }).outputHash;
    if (expectedOutputHash.value !== input.artifactSha256) {
      throw new Error("artifactSha256 does not match artifactJson");
    }
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const params = {
      matchId: input.matchId,
      artifactHash: input.artifactHash,
      artifactJson: input.artifactJson,
    };
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,
      params,
      kernelId: PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,
      kernelHash: PUBLIC_ARTIFACT_VERIFY_KERNEL_HASH,
      inputHash: hashCanonical({ kind: PUBLIC_ARTIFACT_VERIFY_KERNEL_ID, params }),
      artifactHash: { algorithm: "sha256", value: input.artifactSha256 },
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedReplayVerifyTask(input: {
    replayArtifactJson: string;
    artifactSha256?: string;
    allowConstantsMismatch?: boolean;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    if (!input.replayArtifactJson) throw new Error("replayArtifactJson required");
    const expectedOutput = runReplayVerify({
      replayArtifactJson: input.replayArtifactJson,
      allowConstantsMismatch: input.allowConstantsMismatch,
    });
    const artifactHash = hashCanonical(JSON.parse(input.replayArtifactJson));
    if (input.artifactSha256 && artifactHash.value !== input.artifactSha256) {
      throw new Error("artifactSha256 does not match replayArtifactJson");
    }
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const params = {
      matchId: expectedOutput.summary.matchId,
      replayArtifactJson: input.replayArtifactJson,
      ...(input.allowConstantsMismatch === undefined ? {} : { allowConstantsMismatch: input.allowConstantsMismatch }),
    };
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: REPLAY_VERIFY_KERNEL_ID,
      params,
      kernelId: REPLAY_VERIFY_KERNEL_ID,
      kernelHash: REPLAY_VERIFY_KERNEL_HASH,
      inputHash: hashCanonical({ kind: REPLAY_VERIFY_KERNEL_ID, params }),
      artifactHash,
      expectedOutputHash: expectedOutput.outputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: REPLAY_VERIFY_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash: expectedOutput.outputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedSeedSweepTask(input: {
    stageId: string;
    brainA: string;
    brainB: string;
    seedStart: number;
    seedEndExclusive: number;
    seedChunkSize: number;
    maxTicks?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const seedStart = asInt(input.seedStart, "seedStart");
    const seedEndExclusive = asInt(input.seedEndExclusive, "seedEndExclusive");
    const seedChunkSize = asInt(input.seedChunkSize, "seedChunkSize");
    if (seedChunkSize <= 0 || seedChunkSize > 64) throw new Error("seedChunkSize must be 1..64");
    if (seedEndExclusive <= seedStart) throw new Error("seedEndExclusive must be greater than seedStart");
    if (seedEndExclusive - seedStart > 512) throw new Error("seed sweep task is capped at 512 seeds");
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunks: ComputeChunk[] = [];
    let ordinal = 0;
    for (let cursor = seedStart; cursor < seedEndExclusive; cursor += seedChunkSize) {
      const params = {
        stageId: input.stageId,
        brainA: input.brainA,
        brainB: input.brainB,
        seedStart: cursor,
        seedEndExclusive: Math.min(seedEndExclusive, cursor + seedChunkSize),
        simConstantsHash: SEED_SWEEP_KERNEL_BINDING.simConstantsHash,
        behaviorVersion: SEED_SWEEP_KERNEL_BINDING.behaviorVersion,
        ...(input.maxTicks === undefined ? {} : { maxTicks: input.maxTicks }),
      };
      const expectedOutputHash = runSeedSweep(params).outputHash;
      chunks.push({
        chunkId: `${taskId}-chunk-${ordinal}`,
        taskId,
        ordinal,
        kind: SEED_SWEEP_KERNEL_ID,
        params,
        kernelId: SEED_SWEEP_KERNEL_ID,
        kernelHash: SEED_SWEEP_KERNEL_HASH,
        inputHash: hashCanonical({ kind: SEED_SWEEP_KERNEL_ID, params }),
        expectedOutputHash,
        status: "pending",
      });
      ordinal++;
    }
    const task: ComputeTask = {
      taskId,
      kind: SEED_SWEEP_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedTensorTileTask(input: {
    seed?: number;
    rows?: number;
    cols?: number;
    depth?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  } = {}): ComputeTask {
    const normalized = normalizeTensorTileParams({
      seed: input.seed ?? 1,
      rows: input.rows ?? 16,
      cols: input.cols ?? 16,
      depth: input.depth ?? 32,
    });
    const params = {
      seed: normalized.seed,
      rows: normalized.rows,
      cols: normalized.cols,
      depth: normalized.depth,
    };
    const expectedOutputHash = runTensorTileReference(params).outputHash;
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: TENSOR_TILE_KERNEL_ID,
      params,
      kernelId: TENSOR_TILE_KERNEL_ID,
      kernelHash: TENSOR_TILE_KERNEL_HASH,
      inputHash: hashCanonical({ kind: TENSOR_TILE_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: TENSOR_TILE_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedEmbeddingTileTask(input: {
    modelId?: string;
    queryText: string;
    documents: string[];
    topK?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeEmbeddingTileParams({
      modelId: input.modelId ?? EMBEDDING_TILE_MODEL_ID,
      queryText: input.queryText,
      documentsJson: JSON.stringify(input.documents ?? []),
      topK: input.topK ?? 4,
    });
    const params = {
      modelId: normalized.modelId,
      queryText: normalized.queryText,
      documentsJson: normalized.documentsJson,
      topK: normalized.topK,
    };
    const taskId = randomId("task");
    const minExecutions = Math.max(2, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(2, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: EMBEDDING_TILE_KERNEL_ID,
      params,
      kernelId: EMBEDDING_TILE_KERNEL_ID,
      kernelHash: EMBEDDING_TILE_KERNEL_HASH,
      inputHash: hashCanonical({ kind: EMBEDDING_TILE_KERNEL_ID, params }),
      expectedOutputHash: embeddingTilePlaceholderOutputHash(normalized),
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: EMBEDDING_TILE_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "replicated-quorum",
        validationMode: "quorum",
        minExecutions,
        minAgreeing,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedImageTileInferTask(input: {
    sourceId?: string;
    width: number;
    height: number;
    rgbaBase64: string;
    topK?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeImageTileInferParams({
      sourceId: input.sourceId ?? "image-tile",
      width: input.width,
      height: input.height,
      rgbaBase64: input.rgbaBase64,
      topK: input.topK ?? 3,
    });
    const params = {
      sourceId: normalized.sourceId,
      width: normalized.width,
      height: normalized.height,
      rgbaBase64: normalized.rgbaBase64,
      topK: normalized.topK,
    };
    const expectedOutputHash = runImageTileInferReference(normalized).outputHash;
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: IMAGE_TILE_INFER_KERNEL_ID,
      params,
      kernelId: IMAGE_TILE_INFER_KERNEL_ID,
      kernelHash: IMAGE_TILE_INFER_KERNEL_HASH,
      inputHash: hashCanonical({ kind: IMAGE_TILE_INFER_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: IMAGE_TILE_INFER_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedPrefillTopkProbeTask(input: {
    modelId?: string;
    promptText: string;
    topK?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizePrefillTopkProbeParams({
      modelId: input.modelId ?? PREFILL_TOPK_PROBE_MODEL_ID,
      promptText: input.promptText,
      topK: input.topK ?? 4,
    });
    const params = {
      modelId: normalized.modelId,
      promptText: normalized.promptText,
      topK: normalized.topK,
    };
    const taskId = randomId("task");
    const minExecutions = Math.max(2, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(2, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: PREFILL_TOPK_PROBE_KERNEL_ID,
      params,
      kernelId: PREFILL_TOPK_PROBE_KERNEL_ID,
      kernelHash: PREFILL_TOPK_PROBE_KERNEL_HASH,
      inputHash: hashCanonical({ kind: PREFILL_TOPK_PROBE_KERNEL_ID, params }),
      expectedOutputHash: prefillTopkProbePlaceholderOutputHash(normalized),
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: PREFILL_TOPK_PROBE_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "replicated-quorum",
        validationMode: "quorum",
        minExecutions,
        minAgreeing,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedLogitDivergenceTask(input: {
    modelId?: string;
    promptText: string;
    topK?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeLogitDivergenceParams({
      modelId: input.modelId ?? LOGIT_DIVERGENCE_MODEL_ID,
      promptText: input.promptText,
      topK: input.topK ?? 4,
    });
    const params = {
      modelId: normalized.modelId,
      promptText: normalized.promptText,
      topK: normalized.topK,
    };
    const taskId = randomId("task");
    const minExecutions = Math.max(2, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(2, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: LOGIT_DIVERGENCE_KERNEL_ID,
      params,
      kernelId: LOGIT_DIVERGENCE_KERNEL_ID,
      kernelHash: LOGIT_DIVERGENCE_KERNEL_HASH,
      inputHash: hashCanonical({ kind: LOGIT_DIVERGENCE_KERNEL_ID, params }),
      expectedOutputHash: logitDivergencePlaceholderOutputHash(normalized),
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: LOGIT_DIVERGENCE_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "tolerance-bounded",
        validationMode: "measurement",
        minExecutions,
        minAgreeing,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedContactMapTileTask(input: {
    rowResidues: string;
    colResidues: string;
    rowStart?: number;
    colStart?: number;
    minSeparation?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeContactMapTileParams({
      rowResidues: input.rowResidues,
      colResidues: input.colResidues,
      rowStart: input.rowStart ?? 0,
      colStart: input.colStart ?? 0,
      minSeparation: input.minSeparation ?? 8,
    });
    const params = {
      rowResidues: normalized.rowResidues,
      colResidues: normalized.colResidues,
      rowStart: normalized.rowStart,
      colStart: normalized.colStart,
      minSeparation: normalized.minSeparation,
    };
    const expectedOutputHash = runContactMapTileReference(params).outputHash;
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: CONTACT_MAP_TILE_KERNEL_ID,
      params,
      kernelId: CONTACT_MAP_TILE_KERNEL_ID,
      kernelHash: CONTACT_MAP_TILE_KERNEL_HASH,
      inputHash: hashCanonical({ kind: CONTACT_MAP_TILE_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: CONTACT_MAP_TILE_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedGenomeKmerTask(input: {
    sequenceId?: string;
    sequence: string;
    k?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeGenomeKmerParams({
      sequenceId: input.sequenceId ?? "",
      sequence: input.sequence,
      k: input.k ?? 3,
    });
    const params = {
      sequenceId: normalized.sequenceId,
      sequence: normalized.sequence,
      k: normalized.k,
    };
    const expectedOutputHash = runGenomeKmerReference(normalized).outputHash;
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: GENOME_KMER_KERNEL_ID,
      params,
      kernelId: GENOME_KMER_KERNEL_ID,
      kernelHash: GENOME_KMER_KERNEL_HASH,
      inputHash: hashCanonical({ kind: GENOME_KMER_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: GENOME_KMER_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedMicroscopyTileScoreTask(input: {
    sourceId?: string;
    width: number;
    height: number;
    rgbaBase64: string;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeMicroscopyTileScoreParams({
      sourceId: input.sourceId ?? "microscopy-tile",
      width: input.width,
      height: input.height,
      rgbaBase64: input.rgbaBase64,
    });
    const params = {
      sourceId: normalized.sourceId,
      width: normalized.width,
      height: normalized.height,
      rgbaBase64: normalized.rgbaBase64,
    };
    const expectedOutputHash = runMicroscopyTileScoreReference(normalized).outputHash;
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: MICROSCOPY_TILE_SCORE_KERNEL_ID,
      params,
      kernelId: MICROSCOPY_TILE_SCORE_KERNEL_ID,
      kernelHash: MICROSCOPY_TILE_SCORE_KERNEL_HASH,
      inputHash: hashCanonical({ kind: MICROSCOPY_TILE_SCORE_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: MICROSCOPY_TILE_SCORE_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedExploitSearchTask(input: {
    stageId: string;
    brainA: string;
    brainB: string;
    seedStart: number;
    seedEndExclusive: number;
    maxTicks?: number;
    topFindings?: number;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeExploitSearchParams({
      stageId: input.stageId,
      brainA: input.brainA,
      brainB: input.brainB,
      seedStart: input.seedStart,
      seedEndExclusive: input.seedEndExclusive,
      maxTicks: input.maxTicks ?? 5400,
      topFindings: input.topFindings ?? 8,
    });
    const params = {
      stageId: normalized.stageId,
      brainA: normalized.brainA,
      brainB: normalized.brainB,
      seedStart: normalized.seedStart,
      seedEndExclusive: normalized.seedEndExclusive,
      maxTicks: normalized.maxTicks,
      topFindings: normalized.topFindings,
    };
    const expectedOutputHash = runExploitSearchReference(normalized).outputHash;
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 1);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 1));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: EXPLOIT_SEARCH_KERNEL_ID,
      params,
      kernelId: EXPLOIT_SEARCH_KERNEL_ID,
      kernelHash: EXPLOIT_SEARCH_KERNEL_HASH,
      inputHash: hashCanonical({ kind: EXPLOIT_SEARCH_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: EXPLOIT_SEARCH_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  seedAssetTileAuditTask(input: {
    sourceId?: string;
    width: number;
    height: number;
    rgbaBase64: string;
    minExecutions?: number;
    minAgreeing?: number;
    requiredTransport?: TransportKind;
    requiredPeerSubreceipt?: boolean;
  }): ComputeTask {
    const normalized = normalizeAssetTileAuditParams({
      sourceId: input.sourceId ?? "asset-tile",
      width: input.width,
      height: input.height,
      rgbaBase64: input.rgbaBase64,
    });
    const params = {
      sourceId: normalized.sourceId,
      width: normalized.width,
      height: normalized.height,
      rgbaBase64: normalized.rgbaBase64,
    };
    const expectedOutputHash = runAssetTileAuditReference(normalized).outputHash;
    const taskId = randomId("task");
    const minExecutions = Math.max(1, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(1, input.minAgreeing ?? 2));
    const chunk: ComputeChunk = {
      chunkId: `${taskId}-chunk-0`,
      taskId,
      ordinal: 0,
      kind: ASSET_TILE_AUDIT_KERNEL_ID,
      params,
      kernelId: ASSET_TILE_AUDIT_KERNEL_ID,
      kernelHash: ASSET_TILE_AUDIT_KERNEL_HASH,
      inputHash: hashCanonical({ kind: ASSET_TILE_AUDIT_KERNEL_ID, params }),
      expectedOutputHash,
      status: "pending",
    };
    const task: ComputeTask = {
      taskId,
      kind: ASSET_TILE_AUDIT_KERNEL_ID,
      status: "running",
      createdAt: this.now(),
      validationPolicy: {
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        minExecutions,
        minAgreeing,
        expectedOutputHash,
        requiredTransport: input.requiredTransport,
        requiredPeerSubreceipt: input.requiredPeerSubreceipt,
      },
      chunks: [chunk],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  assignNext(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
  }): { assignment: Assignment; chunk: ComputeChunk; task: ComputeTask } | null {
    this.expireAssignments();
    this.expireAssignmentIntake();
    if (!this.acceptAssignmentsFlag) return null;
    const session = this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const worker = this.requireWorker(input.workerId);
    worker.lastSeenAt = this.now();
    session.lastSeenAt = worker.lastSeenAt;
    if (this.requireReceiptSignatures && !session.signingPublicKey) return null;
    if (this.shouldQuarantineWorker(worker.workerId).quarantined) return null;
    if (this.activeAssignmentsForWorker(worker.workerId) >= Math.max(1, worker.capability.maxConcurrentChunks || 1)) {
      return null;
    }
    const profile = this.workerProfiles().find((candidate) => candidate.workerId === worker.workerId);
    if (!profile) return null;
    const candidates: Array<{
      task: ComputeTask;
      chunk: ComputeChunk;
      score: number;
    }> = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      if (!schedulerEligible(worker, profile, task)) continue;
      for (const chunk of task.chunks) {
        if (chunk.status !== "pending") continue;
        if (this.receiptsFor(chunk.chunkId).some((receipt) => receipt.workerId === worker.workerId)) continue;
        const liveAssignments = this.assignmentsFor(chunk.chunkId)
          .filter((assignment) => assignment.status === "offered" || assignment.status === "accepted");
        if (liveAssignments.length >= task.validationPolicy.minExecutions * 2) continue;
        candidates.push({
          task,
          chunk,
          score: schedulerCandidateScore(profile, task, liveAssignments.length),
        });
      }
    }
    const selected = candidates.sort((a, b) =>
      b.score - a.score ||
      a.task.createdAt - b.task.createdAt ||
      a.chunk.ordinal - b.chunk.ordinal
    )[0];
    if (!selected) return null;
    const assignment: Assignment = {
      assignmentId: randomId("as"),
      assignmentToken: randomToken("atok"),
      taskId: selected.task.taskId,
      chunkId: selected.chunk.chunkId,
      workerId: worker.workerId,
      workerSessionId: session.workerSessionId,
      status: "offered",
      assignedAt: this.now(),
      expiresAt: this.now() + this.assignmentTimeoutMs,
    };
    this.assignments.set(assignment.assignmentId, assignment);
    return { assignment, chunk: selected.chunk, task: selected.task };
  }

  acceptAssignment(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    assignmentId: string;
    assignmentToken: string;
    refusalReason?: WorkerRefusalReason;
  }): Assignment {
    this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const assignment = this.requireAssignment(input.assignmentId);
    if (assignment.assignmentToken !== input.assignmentToken) throw new Error("assignment token mismatch");
    if (assignment.workerId !== input.workerId || assignment.workerSessionId !== input.workerSessionId) {
      throw new Error("assignment mismatch");
    }
    if (input.refusalReason) {
      assignment.status = "cancelled";
      assignment.refusalReason = input.refusalReason;
      return assignment;
    }
    assignment.status = "accepted";
    assignment.acceptedAt = this.now();
    return assignment;
  }

  submitReceipt(input: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason"> & {
    workerSessionToken: string;
    assignmentToken: string;
  }): { receipt: ExecutionReceipt; validation?: ValidationRecord } {
    const session = this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const prepared = this.prepareReceipt(input, session);
    if (prepared.reason) {
      return this.rejectDetachedReceipt(prepared.receipt, "malformed", prepared.reason);
    }
    input = prepared.receipt;
    const assignment = this.assignments.get(input.assignmentId);
    if (!assignment || assignment.assignmentToken !== input.assignmentToken) {
      return this.rejectDetachedReceipt(input, "assignment-mismatch", "assignment token mismatch");
    }
    if (
      assignment.workerId !== input.workerId ||
      assignment.workerSessionId !== input.workerSessionId ||
      assignment.taskId !== input.taskId ||
      assignment.chunkId !== input.chunkId
    ) {
      return this.rejectDetachedReceipt(input, "assignment-mismatch", "assignment fields mismatch");
    }
    const existingReceipt = this.assignmentReceipt(input.assignmentId);
    if (existingReceipt) {
      if (prepared.receipt.receiptHash && hashesEqual(existingReceipt.receiptHash, prepared.receipt.receiptHash)) {
        return { receipt: existingReceipt };
      }
      const receipt = this.makeReceipt(
        input,
        "duplicate-receipt",
        `assignment already receipted by ${existingReceipt.receiptId}`,
      );
      this.receipts.set(receipt.receiptId, receipt);
      this.bumpReputation(input.workerId, "rejected");
      return { receipt };
    }
    const task = this.requireTask(input.taskId);
    const chunk = this.requireChunk(input.chunkId);
    const receivedAt = this.now();
    const policyMismatch = receiptPolicyMismatch(task, input);
    if (policyMismatch) {
      const receipt = this.makeReceipt(input, "malformed", policyMismatch);
      this.receipts.set(receipt.receiptId, receipt);
      assignment.status = "receipted";
      this.bumpReputation(input.workerId, "rejected");
      return { receipt };
    }
    const peerMismatch = this.peerReceiptMismatch(task, chunk, assignment, input, receivedAt);
    if (peerMismatch) {
      const receipt = this.makeReceipt(input, "malformed", peerMismatch);
      this.receipts.set(receipt.receiptId, receipt);
      assignment.status = "receipted";
      this.bumpReputation(input.workerId, "rejected");
      return { receipt };
    }
    const mismatch = receiptMismatch(chunk, input);
    if (mismatch) {
      const receipt = this.makeReceipt(input, mismatch.decision, mismatch.reason);
      this.receipts.set(receipt.receiptId, receipt);
      assignment.status = "receipted";
      this.bumpReputation(input.workerId, "rejected");
      return { receipt };
    }

    if (task.validationPolicy.validationMode === "measurement") {
      if (chunk.kind !== DEVICE_WITNESS_WEBRTC_KERNEL_ID) {
        const receipt = this.makeReceipt(input, "pending");
        this.receipts.set(receipt.receiptId, receipt);
        assignment.status = "receipted";
        const validation = this.evaluateMeasurementChunk(task, chunk);
        return { receipt: this.receipts.get(receipt.receiptId) ?? receipt, validation };
      }
      const transcript = measurementTranscript(input.adapterInfo);
      const measurementInput = { ...input, adapterInfo: transcript };
      const expected = measurementReceiptHash(chunk, transcript);
      const decision: ReceiptDecision = expected && hashesEqual(input.outputHash, expected)
        ? "pending"
        : "malformed";
      const receipt = this.makeReceipt(measurementInput, decision, decision === "malformed" ? "measurement transcript hash mismatch" : undefined);
      this.receipts.set(receipt.receiptId, receipt);
      assignment.status = "receipted";
      if (decision === "malformed") {
        this.bumpReputation(input.workerId, "rejected");
        return { receipt };
      }
      const validation = this.evaluateMeasurementChunk(task, chunk);
      return { receipt: this.receipts.get(receipt.receiptId) ?? receipt, validation };
    }

    if (task.validationPolicy.validationMode === "quorum") {
      const receipt = this.makeReceipt(input, "pending");
      this.receipts.set(receipt.receiptId, receipt);
      assignment.status = "receipted";
      const validation = this.evaluateQuorumChunk(task, chunk);
      return { receipt: this.receipts.get(receipt.receiptId) ?? receipt, validation };
    }

    const decision: ReceiptDecision = hashesEqual(input.outputHash, chunk.expectedOutputHash)
      ? "pending"
      : "output-mismatch";
    const receipt = this.makeReceipt(input, decision, decision === "output-mismatch" ? "output hash did not match expected public hash" : undefined);
    this.receipts.set(receipt.receiptId, receipt);
    assignment.status = "receipted";
    if (decision === "output-mismatch") this.bumpReputation(input.workerId, "rejected");
    const validation = this.evaluateChunk(task, chunk);
    return { receipt: this.receipts.get(receipt.receiptId) ?? receipt, validation };
  }

  getTask(taskId: string): ComputeTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  getReceipt(receiptId: string): ExecutionReceipt | null {
    return this.receipts.get(receiptId) ?? null;
  }

  verifyReceipt(receiptId: string): ReceiptVerification | null {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return null;
    const receiptHash = computeReceiptHash(receipt);
    const session = this.sessions.get(receipt.workerSessionId);
    const signatureVerified = !!(
      receipt.signature &&
      session?.signingPublicKey &&
      verifyReceiptSignature(receiptHash, receipt.signature, session.signingPublicKey)
    );
    const signatureStatus = session?.signingPublicKey
      ? (signatureVerified ? "verified" : receipt.signature ? "invalid" : "missing")
      : receipt.signature
        ? "key-unavailable"
        : "unsigned";
    const signatureRequired = this.requireReceiptSignatures || !!session?.signingPublicKey;
    const { signature: _signature, ...redactedReceipt } = receipt;
    return {
      receiptId: receipt.receiptId,
      ok: hashesEqual(receipt.receiptHash, receiptHash) && (
        signatureRequired
          ? signatureStatus === "verified"
          : signatureStatus === "verified" || signatureStatus === "unsigned"
      ),
      decision: receipt.decision,
      receiptHash,
      storedReceiptHash: receipt.receiptHash,
      receiptHashMatches: hashesEqual(receipt.receiptHash, receiptHash),
      signatureRequired,
      signatureStatus,
      signatureVerified,
      signaturePublicKeyHash: session?.signingPublicKeyHash ?? receipt.signaturePublicKeyHash,
      receipt: redactedReceipt,
    };
  }

  cancelTask(taskId: string): ComputeTask {
    const task = this.requireTask(taskId);
    task.status = "cancelled";
    for (const chunk of task.chunks) {
      if (chunk.status === "pending") chunk.status = "rejected";
    }
    return task;
  }

  createWebRtcSession(): WebRtcSessionRecord {
    const now = this.now();
    const session: WebRtcSessionRecord = {
      sessionId: randomId("rtc"),
      token: randomToken("rtok"),
      createdAt: now,
      expiresAt: now + this.webrtcSessionTtlMs,
      status: "open",
      candidates: [],
    };
    this.webrtcSessions.set(session.sessionId, session);
    return session;
  }

  setWebRtcOffer(input: { sessionId: string; token: string; offer: unknown }): WebRtcSessionRecord {
    const session = this.requireWebRtcSession(input.sessionId, input.token);
    session.offer = input.offer;
    return session;
  }

  setWebRtcAnswer(input: { sessionId: string; token: string; answer: unknown }): WebRtcSessionRecord {
    const session = this.requireWebRtcSession(input.sessionId, input.token);
    session.answer = input.answer;
    return session;
  }

  addWebRtcCandidates(input: {
    sessionId: string;
    token: string;
    peerId?: string;
    candidates: unknown[];
  }): WebRtcSessionRecord {
    const session = this.requireWebRtcSession(input.sessionId, input.token);
    const now = this.now();
    for (const payload of input.candidates) {
      session.candidates.push({
        candidateId: randomId("ice"),
        sessionId: session.sessionId,
        peerId: input.peerId,
        payload,
        createdAt: now,
      });
    }
    return session;
  }

  getWebRtcSession(input: { sessionId: string; token: string }): WebRtcSessionRecord {
    return this.requireWebRtcSession(input.sessionId, input.token);
  }

  closeWebRtcSession(input: { sessionId: string; token: string }): WebRtcSessionRecord {
    const session = this.requireWebRtcSession(input.sessionId, input.token);
    session.status = "closed";
    return session;
  }

  joinWebRtcPair(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
  }): { pair: WebRtcPairRecord; role: "offerer" | "answerer" } {
    this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    this.expireWebRtcPairs();
    const existing = this.activeWebRtcPairForWorker(input.workerId);
    if (existing) {
      return {
        pair: existing,
        role: existing.offererWorkerId === input.workerId ? "offerer" : "answerer",
      };
    }
    const waiting = Array.from(this.webrtcPairs.values())
      .filter((pair) =>
        pair.status === "waiting" &&
        pair.expiresAt > this.now() &&
        pair.offererWorkerId !== input.workerId
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (waiting) {
      waiting.status = "matched";
      waiting.answererWorkerId = input.workerId;
      waiting.answererSessionId = input.workerSessionId;
      return { pair: waiting, role: "answerer" };
    }
    const now = this.now();
    const pair: WebRtcPairRecord = {
      pairId: randomId("rtcpair"),
      token: randomToken("ptok"),
      createdAt: now,
      expiresAt: now + this.webrtcSessionTtlMs,
      status: "waiting",
      offererWorkerId: input.workerId,
      offererSessionId: input.workerSessionId,
      candidates: [],
    };
    this.webrtcPairs.set(pair.pairId, pair);
    return { pair, role: "offerer" };
  }

  setWebRtcPairOffer(input: { pairId: string; token: string; offer: unknown }): WebRtcPairRecord {
    const pair = this.requireWebRtcPair(input.pairId, input.token);
    pair.offer = input.offer;
    return pair;
  }

  setWebRtcPairAnswer(input: { pairId: string; token: string; answer: unknown }): WebRtcPairRecord {
    const pair = this.requireWebRtcPair(input.pairId, input.token);
    pair.answer = input.answer;
    return pair;
  }

  addWebRtcPairCandidates(input: {
    pairId: string;
    token: string;
    peerId?: string;
    candidates: unknown[];
  }): WebRtcPairRecord {
    const pair = this.requireWebRtcPair(input.pairId, input.token);
    const now = this.now();
    for (const payload of input.candidates.slice(0, 16)) {
      pair.candidates.push({
        candidateId: randomId("ice"),
        sessionId: pair.pairId,
        peerId: stringBucket(input.peerId),
        payload,
        createdAt: now,
      });
    }
    if (pair.candidates.length > 128) pair.candidates.splice(0, pair.candidates.length - 128);
    return pair;
  }

  getWebRtcPair(input: { pairId: string; token: string }): WebRtcPairRecord {
    return this.requireWebRtcPair(input.pairId, input.token);
  }

  closeWebRtcPair(input: { pairId: string; token: string }): WebRtcPairRecord {
    const pair = this.requireWebRtcPair(input.pairId, input.token);
    pair.status = "closed";
    return pair;
  }

  issuePeerSubassignment(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    assignmentId: string;
    assignmentToken: string;
    pairId: string;
    pairToken: string;
    requestId: string;
  }): PeerSubassignment {
    this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const assignment = this.requireAssignment(input.assignmentId);
    if (assignment.assignmentToken !== input.assignmentToken) throw new Error("assignment token mismatch");
    if (
      assignment.workerId !== input.workerId ||
      assignment.workerSessionId !== input.workerSessionId ||
      assignment.status !== "accepted"
    ) {
      throw new Error("accepted requester assignment required");
    }
    if (!isNonEmptyString(input.requestId)) throw new Error("requestId required");
    const pair = this.requireWebRtcPair(input.pairId, input.pairToken);
    if (pair.status !== "matched") throw new Error("matched WebRTC pair required");
    const requesterRole = pairParticipantRole(pair, input.workerId, input.workerSessionId);
    if (!requesterRole) throw new Error("requester not in WebRTC pair");
    const peer = peerParticipantFor(pair, requesterRole);
    if (!peer) throw new Error("peer not matched");
    if (peer.workerId === input.workerId || peer.workerSessionId === input.workerSessionId) {
      throw new Error("remote peer required");
    }
    const peerSession = this.sessions.get(peer.workerSessionId);
    if (!peerSession || peerSession.workerId !== peer.workerId || !peerSession.signingPublicKey) {
      throw new Error("peer signing key required");
    }
    const peerWorker = this.requireWorker(peer.workerId);
    const task = this.requireTask(assignment.taskId);
    const chunk = this.requireChunk(assignment.chunkId);
    if (!isWebRtcDataTask(chunk.kind)) throw new Error("peer subassignment requires WebRTC data task");
    if (!peerWorker.capability.kernels.includes(chunk.kind)) {
      throw new Error("peer unsupported kernel");
    }
    const peerProfile = this.workerProfiles().find((profile) => profile.workerId === peer.workerId);
    if (!peerProfile || !tierSatisfies(peerProfile.allowedWorkloadTier, taskRequiredWorkloadTier(task))) {
      throw new Error("peer workload tier insufficient");
    }

    const existing = Array.from(this.peerSubassignments.values()).find((subassignment) =>
      subassignment.parentAssignmentId === assignment.assignmentId &&
      subassignment.pairId === pair.pairId &&
      subassignment.requestId === input.requestId
    );
    if (existing) {
      if (
        existing.requesterWorkerId !== input.workerId ||
        existing.requesterSessionId !== input.workerSessionId ||
        existing.peerWorkerId !== peer.workerId ||
        existing.peerSessionId !== peer.workerSessionId ||
        existing.taskId !== task.taskId ||
        existing.chunkId !== chunk.chunkId
      ) {
        throw new Error("peer subassignment request mismatch");
      }
      return existing;
    }

    const now = this.now();
    const subassignment: PeerSubassignment = {
      peerAssignmentId: randomId("psub"),
      peerAssignmentToken: randomToken("pstok"),
      parentAssignmentId: assignment.assignmentId,
      pairId: pair.pairId,
      requestId: input.requestId,
      requesterWorkerId: input.workerId,
      requesterSessionId: input.workerSessionId,
      peerWorkerId: peer.workerId,
      peerSessionId: peer.workerSessionId,
      taskId: task.taskId,
      chunkId: chunk.chunkId,
      kernelId: chunk.kernelId,
      kernelHash: chunk.kernelHash,
      inputHash: chunk.inputHash,
      artifactHash: chunk.artifactHash,
      createdAt: now,
      expiresAt: Math.min(pair.expiresAt, assignment.expiresAt, now + this.assignmentTimeoutMs),
      status: "issued",
    };
    this.peerSubassignments.set(subassignment.peerAssignmentId, subassignment);
    return subassignment;
  }

  submitPeerSubassignmentReceipt(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    peerAssignmentId: string;
    peerAssignmentToken: string;
    peerSubreceipt: PeerSubreceipt;
  }): PeerSubassignment {
    const session = this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const subassignment = this.peerSubassignments.get(input.peerAssignmentId);
    if (!subassignment || subassignment.peerAssignmentToken !== input.peerAssignmentToken) {
      throw new Error("peer subassignment token mismatch");
    }
    if (subassignment.peerWorkerId !== input.workerId || subassignment.peerSessionId !== input.workerSessionId) {
      throw new Error("peer subassignment worker mismatch");
    }
    if (!session.signingPublicKey) throw new Error("peer signing key required");
    const now = this.now();
    if (subassignment.expiresAt <= now) {
      subassignment.status = "expired";
      subassignment.receivedAt = now;
      subassignment.reason = "peer subassignment expired";
      this.bumpReputation(input.workerId, "timeout");
      return subassignment;
    }
    const mismatch = this.peerSubassignmentReceiptMismatch(subassignment, input.peerSubreceipt, session);
    const expectedHash = peerSubreceiptHash(input.peerSubreceipt);
    if (subassignment.status !== "issued") {
      if (
        subassignment.status === "accepted" &&
        subassignment.peerReceiptHash &&
        hashesEqual(subassignment.peerReceiptHash, expectedHash)
      ) {
        return subassignment;
      }
      throw new Error("peer subassignment already receipted");
    }
    subassignment.receivedAt = now;
    subassignment.computeMs = input.peerSubreceipt.computeMs;
    subassignment.clientVersion = input.peerSubreceipt.clientVersion;
    subassignment.outputHash = input.peerSubreceipt.outputHash;
    subassignment.peerReceiptHash = input.peerSubreceipt.peerReceiptHash;
    if (mismatch) {
      subassignment.status = "rejected";
      subassignment.reason = mismatch;
      this.bumpReputation(input.workerId, "rejected");
      return subassignment;
    }
    subassignment.status = "accepted";
    this.bumpReputation(input.workerId, "accepted");
    return subassignment;
  }

  webRtcPairSummaries(): WebRtcPairSummary[] {
    this.expireWebRtcPairs();
    return Array.from(this.webrtcPairs.values())
      .map((pair) => ({
        pairId: pair.pairId,
        status: pair.status,
        createdAt: pair.createdAt,
        expiresAt: pair.expiresAt,
        offererWorkerId: pair.offererWorkerId,
        answererWorkerId: pair.answererWorkerId,
        hasOffer: pair.offer !== undefined,
        hasAnswer: pair.answer !== undefined,
        candidateCount: pair.candidates.length,
        peerCount: new Set(pair.candidates.map((candidate) => candidate.peerId).filter(Boolean)).size,
        lastCandidateAt: pair.candidates.length
          ? Math.max(...pair.candidates.map((candidate) => candidate.createdAt))
          : undefined,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  summary(): {
    acceptAssignments: boolean;
    assignmentIntakeClosesAt: number | null;
    collections: typeof COMPUTE_COLLECTIONS;
    workers: number;
    activeSessions: number;
    tasks: number;
    assignments: number;
    receipts: number;
    validations: number;
    capabilityObservations: number;
    connectivityObservations: number;
    chunks: { pending: number; accepted: number; rejected: number; timeout: number };
    webrtcSessions: number;
    webrtcPairs: number;
    peerSubassignments: number;
  } {
    this.expireAssignmentIntake();
    const chunks = { pending: 0, accepted: 0, rejected: 0, timeout: 0 };
    for (const task of this.tasks.values()) {
      for (const chunk of task.chunks) {
        if (chunk.status === "accepted") chunks.accepted++;
        else if (chunk.status === "timeout") chunks.timeout++;
        else if (chunk.status === "rejected" || chunk.status === "output-mismatch" || chunk.status === "disagreement") chunks.rejected++;
        else chunks.pending++;
      }
    }
    return {
      acceptAssignments: this.acceptAssignmentsFlag,
      assignmentIntakeClosesAt: this.assignmentIntakeClosesAt,
      collections: COMPUTE_COLLECTIONS,
      workers: this.workers.size,
      activeSessions: Array.from(this.sessions.values()).filter((session) => session.expiresAt > this.now()).length,
      tasks: this.tasks.size,
      assignments: this.assignments.size,
      receipts: this.receipts.size,
      validations: this.validations.size,
      capabilityObservations: this.capabilityObservations.size,
      connectivityObservations: this.connectivityObservations.size,
      chunks,
      webrtcSessions: this.webrtcSessions.size,
      webrtcPairs: this.webrtcPairs.size,
      peerSubassignments: this.peerSubassignments.size,
    };
  }

  publicCapabilityMap() {
    return {
      generatedAt: this.now(),
      workers: this.workers.size,
      observations: this.capabilityObservations.size,
      map: capabilityObservationMap(Array.from(this.capabilityObservations.values())),
    };
  }

  publicConnectivityMap() {
    return {
      generatedAt: this.now(),
      workers: this.workers.size,
      observations: this.connectivityObservations.size,
      map: connectivityObservationMap(Array.from(this.connectivityObservations.values())),
    };
  }

  workerProfiles(): WorkerProfile[] {
    return buildWorkerProfiles({
      now: this.now(),
      workers: Array.from(this.workers.values()),
      receipts: Array.from(this.receipts.values()),
      assignments: Array.from(this.assignments.values()),
      capabilityObservations: Array.from(this.capabilityObservations.values()),
      connectivityObservations: Array.from(this.connectivityObservations.values()),
    });
  }

  workerTrustState(workerId: string): { quarantined: boolean; reason?: string } {
    return this.shouldQuarantineWorker(workerId);
  }

  reconcilePendingValidations(): ValidationRecord[] {
    const out: ValidationRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      for (const chunk of task.chunks) {
        if (chunk.status !== "pending") continue;
        const validation = task.validationPolicy.validationMode === "measurement"
          ? this.evaluateMeasurementChunk(task, chunk)
          : this.evaluateChunk(task, chunk);
        if (validation) out.push(validation);
      }
    }
    return out;
  }

  deviceClassProfiles(): ClassProfile[] {
    return classProfiles(this.workerProfiles(), this.now(), (profile) => profile.deviceClass || "unknown");
  }

  networkClassProfiles(): ClassProfile[] {
    const latestByWorker = latestConnectivityByWorker(Array.from(this.connectivityObservations.values()));
    return classProfiles(this.workerProfiles(), this.now(), (profile) =>
      latestByWorker.get(profile.workerId)?.networkTypeBucket ?? "unknown",
    );
  }

  publicStats(options: { minWorkers?: number; suppressSmall?: boolean } = {}): PublicComputeStats {
    const minWorkers = options.minWorkers ?? 5;
    const profiles = this.workerProfiles();
    const suppressed = options.suppressSmall !== false && profiles.length < minWorkers;
    return summarizePublicStats({
      generatedAt: this.now(),
      minWorkers,
      suppressed,
      profiles,
      receipts: Array.from(this.receipts.values()),
      tasks: Array.from(this.tasks.values()),
    });
  }

  replayBadges(): ReplayVerificationBadge[] {
    const validationsByChunk = new Map<string, ValidationRecord[]>();
    for (const validation of this.validations.values()) {
      const list = validationsByChunk.get(validation.chunkId) ?? [];
      list.push(validation);
      validationsByChunk.set(validation.chunkId, list);
    }
    const out: ReplayVerificationBadge[] = [];
    for (const task of this.tasks.values()) {
      if (task.kind !== PUBLIC_ARTIFACT_VERIFY_KERNEL_ID && task.kind !== REPLAY_VERIFY_KERNEL_ID) continue;
      for (const chunk of task.chunks) {
        const parsed = task.kind === REPLAY_VERIFY_KERNEL_ID
          ? replayVerifyArtifactSummary(chunk.params.replayArtifactJson)
          : publicArtifactSummary(chunk.params.artifactJson);
        const matchId = String(chunk.params.matchId ?? parsed.matchId ?? "");
        if (!matchId) continue;
        const accepted = (validationsByChunk.get(chunk.chunkId) ?? [])
          .filter((validation) => validation.status === "accepted")
          .sort((a, b) => b.recordedAt - a.recordedAt)[0];
        const receipts = this.receiptsFor(chunk.chunkId);
        const acceptedReceiptIds = new Set(accepted?.acceptedReceiptIds ?? []);
        const acceptedReceipts = receipts.filter((receipt) =>
          receipt.decision === "accepted" || acceptedReceiptIds.has(receipt.receiptId)
        );
        out.push({
          matchId,
          workload: task.kind,
          status: accepted ? "verified" : chunk.status === "disagreement" || chunk.status === "rejected" ? "failed" : "pending",
          agreedReceipts: accepted?.acceptedReceiptIds.length ?? receipts.filter((receipt) => receipt.decision === "accepted").length,
          requiredReceipts: task.validationPolicy.minAgreeing,
          artifactHash: String(chunk.params.artifactHash ?? parsed.artifactHash ?? chunk.artifactHash?.value ?? ""),
          artifactSha256: chunk.artifactHash?.value,
          rulesHash: parsed.rulesHash,
          stageHash: parsed.stageHash,
          actionLogHash: parsed.actionLogHash,
          actionLogSha256: parsed.actionLogSha256,
          outputHash: chunk.expectedOutputHash?.value,
          transports: uniqueStrings(acceptedReceipts.map((receipt) => receipt.transport)),
          transfers: uniqueStrings(acceptedReceipts.map((receipt) => receipt.adapterInfo?.transfer)),
          verifiedAt: accepted?.recordedAt,
          taskId: task.taskId,
          chunkId: chunk.chunkId,
        });
      }
    }
    return out.sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0));
  }

  replayBadge(matchId: string): ReplayVerificationBadge | null {
    return this.replayBadges().find((badge) => badge.matchId === matchId) ?? null;
  }

  listReceiptsForIdentity(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    limit?: number;
  }): PersonalReceiptsResult {
    this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const worker = this.requireWorker(input.workerId);
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const clientId = worker.clientId;
    const accountUid = worker.accountUid;
    const scope: "session" | "browser" | "account" = accountUid
      ? "account"
      : clientId
        ? "browser"
        : "session";
    const matches = (receipt: ExecutionReceipt) => {
      if (accountUid && receipt.accountUid === accountUid) return true;
      if (clientId && receipt.clientId === clientId) return true;
      return receipt.workerId === input.workerId;
    };
    const receipts = Array.from(this.receipts.values())
      .filter(matches)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit)
      .map((receipt) => {
        const task = this.tasks.get(receipt.taskId);
        return {
          receiptId: receipt.receiptId,
          taskId: receipt.taskId,
          chunkId: receipt.chunkId,
          kernelId: receipt.kernelId,
          kernelHash: receipt.kernelHash,
          taskKind: task?.kind ?? receipt.kernelId,
          decision: receipt.decision,
          reason: receipt.reason,
          receivedAt: receipt.receivedAt,
          computeMs: receipt.computeMs,
          executionMode: receipt.executionMode,
          transport: receipt.transport,
          outputHash: receipt.outputHash,
          signatureStatus: receipt.signatureStatus ?? "unsigned",
        };
      });
    return {
      scope,
      clientId: clientId ?? null,
      accountUid: accountUid ?? null,
      receipts,
    };
  }

  publicContactMapAggregate(): ContactMapPublicAggregate {
    const tiles: ContactMapPublicAggregateTile[] = [];
    let totalTasks = 0;
    let totalAcceptedReceipts = 0;
    for (const task of this.tasks.values()) {
      if (task.kind !== CONTACT_MAP_TILE_KERNEL_ID) continue;
      totalTasks++;
      const chunk = task.chunks[0];
      if (!chunk) continue;
      const receipts = this.receiptsFor(chunk.chunkId);
      const accepted = receipts.filter((receipt) => receipt.decision === "accepted");
      totalAcceptedReceipts += accepted.length;
      tiles.push({
        taskId: task.taskId,
        status: task.status,
        rowStart: Number(chunk.params.rowStart ?? 0),
        colStart: Number(chunk.params.colStart ?? 0),
        rowResidues: String(chunk.params.rowResidues ?? ""),
        colResidues: String(chunk.params.colResidues ?? ""),
        minSeparation: Number(chunk.params.minSeparation ?? 0),
        expectedOutputHash: chunk.expectedOutputHash ?? null,
        receiptCount: receipts.length,
        acceptedCount: accepted.length,
        receipts: accepted.map((receipt) => ({
          receiptId: receipt.receiptId,
          outputHash: receipt.outputHash,
          executionMode: receipt.executionMode,
          transport: receipt.transport,
          receivedAt: receipt.receivedAt,
          signatureStatus: receipt.signatureStatus ?? "unsigned",
        })),
      });
    }
    tiles.sort((a, b) => a.rowStart - b.rowStart || a.colStart - b.colStart);
    return {
      kernelId: CONTACT_MAP_TILE_KERNEL_ID,
      totalTasks,
      totalAcceptedReceipts,
      tiles,
    };
  }

  dashboard() {
    const assignments = Array.from(this.assignments.values());
    const receipts = Array.from(this.receipts.values());
    const validations = Array.from(this.validations.values());
    const workers = Array.from(this.workers.values());
    const workerProfiles = this.workerProfiles();
    return {
      ...this.summary(),
      capabilityMap: capabilityMap(workers),
      capabilityObservationMap: this.publicCapabilityMap().map,
      connectivityMap: this.publicConnectivityMap().map,
      receiptTransportSummary: receiptTransportSummary(receipts, this.tasks),
      workerProfiles,
      deviceClassProfiles: this.deviceClassProfiles(),
      networkClassProfiles: this.networkClassProfiles(),
      publicStats: this.publicStats({ suppressSmall: false }),
      replayBadges: this.replayBadges().slice(0, 50),
      webRtcPairList: this.webRtcPairSummaries().slice(0, 50),
      workerList: workers.map((worker) => ({
        workerId: worker.workerId,
        label: worker.label,
        lastSeenAt: worker.lastSeenAt,
        kernels: worker.capability.kernels,
        runtimeSurfaces: worker.capability.runtimeSurfaces,
        deviceClass: worker.capability.deviceClass,
        adapterInfo: worker.capability.adapterInfo,
        capabilityHash: worker.capability.capabilityHash,
        trust: this.shouldQuarantineWorker(worker.workerId),
      })),
      taskList: Array.from(this.tasks.values()).map((task) => ({
        taskId: task.taskId,
        kind: task.kind,
        status: task.status,
        chunks: task.chunks.length,
        accepted: task.chunks.filter((chunk) => chunk.status === "accepted").length,
        rejected: task.chunks.filter((chunk) =>
          chunk.status === "rejected" ||
          chunk.status === "output-mismatch" ||
          chunk.status === "disagreement"
        ).length,
        validationPolicy: task.validationPolicy,
      })),
      assignmentList: assignments
        .slice()
        .sort((a, b) => b.assignedAt - a.assignedAt)
        .slice(0, 50),
      receiptList: receipts
        .slice()
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, 50),
      validationList: validations
        .slice()
        .sort((a, b) => b.recordedAt - a.recordedAt)
        .slice(0, 50),
      reputationList: Array.from(this.reputation.values()),
    };
  }

  private recordCapabilityObservation(
    worker: WorkerRecord,
    session: WorkerSession | undefined,
    reason: CapabilityObservation["reason"],
  ): void {
    const observation: CapabilityObservation = {
      observationId: randomId("cap"),
      workerId: worker.workerId,
      workerSessionId: session?.workerSessionId ?? "",
      observedAt: this.now(),
      reason,
      deviceClass: worker.capability.deviceClass,
      runtimeSurfaces: [...(worker.capability.runtimeSurfaces ?? [])],
      kernels: [...(worker.capability.kernels ?? [])],
      adapterInfo: sanitizeBucketRecord(worker.capability.adapterInfo),
      capabilityHash: worker.capability.capabilityHash,
      clientVersion: worker.capability.clientVersion,
    };
    this.capabilityObservations.set(observation.observationId, observation);
    this.trimObservations();
  }

  private trimObservations(): void {
    trimMapByTime(this.capabilityObservations, 5000, (obs) => obs.observedAt);
    trimMapByTime(this.connectivityObservations, 5000, (obs) => obs.observedAt);
  }

  private createSession(workerId: string, signingPublicKey?: JsonWebKey): WorkerSession {
    const now = this.now();
    const key = normalizeSigningPublicKey(signingPublicKey);
    const session: WorkerSession = {
      workerSessionId: randomId("cs"),
      workerId,
      token: randomToken("stok"),
      signingPublicKey: key,
      signingPublicKeyHash: key ? hashCanonical(key) : undefined,
      createdAt: now,
      expiresAt: now + this.workerSessionTtlMs,
      lastSeenAt: now,
    };
    this.sessions.set(session.workerSessionId, session);
    return session;
  }

  private requireWorker(workerId: string): WorkerRecord {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error("unknown worker");
    return worker;
  }

  private requireSession(workerId: string, workerSessionId: string, token: string): WorkerSession {
    const session = this.sessions.get(workerSessionId);
    if (!session || session.workerId !== workerId || session.token !== token) throw new Error("unknown worker session");
    if (session.expiresAt <= this.now()) throw new Error("worker session expired");
    return session;
  }

  private requireTask(taskId: string): ComputeTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("unknown task");
    return task;
  }

  private requireChunk(chunkId: string): ComputeChunk {
    for (const task of this.tasks.values()) {
      const chunk = task.chunks.find((candidate) => candidate.chunkId === chunkId);
      if (chunk) return chunk;
    }
    throw new Error("unknown chunk");
  }

  private requireAssignment(assignmentId: string): Assignment {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) throw new Error("unknown assignment");
    return assignment;
  }

  private activeAssignmentsForWorker(workerId: string): number {
    this.expireAssignments();
    return Array.from(this.assignments.values()).filter((assignment) =>
      assignment.workerId === workerId &&
      assignment.expiresAt > this.now() &&
      (assignment.status === "offered" || assignment.status === "accepted")
    ).length;
  }

  private shouldQuarantineWorker(workerId: string): { quarantined: boolean; reason?: string } {
    const rep = this.reputation.get(workerId);
    if (!rep) return { quarantined: false };
    const hardBad = rep.rejected + rep.disagreements;
    const totalDecided = rep.accepted + rep.rejected + rep.disagreements;
    if (hardBad >= 3 && rep.accepted === 0) {
      return { quarantined: true, reason: "repeated bad receipts with no accepted work" };
    }
    if (totalDecided >= 6 && hardBad / totalDecided >= 0.5) {
      return { quarantined: true, reason: "bad receipt rate exceeded scheduler threshold" };
    }
    return { quarantined: false };
  }

  private activeWebRtcPairForWorker(workerId: string): WebRtcPairRecord | null {
    return Array.from(this.webrtcPairs.values())
      .filter((pair) =>
        pair.status !== "closed" &&
        pair.expiresAt > this.now() &&
        (pair.offererWorkerId === workerId || pair.answererWorkerId === workerId)
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  private rejectDetachedReceipt(
    input: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason">,
    decision: ReceiptDecision,
    reason: string,
  ): { receipt: ExecutionReceipt } {
    const receipt = this.makeReceipt(input, decision, reason);
    this.receipts.set(receipt.receiptId, receipt);
    this.bumpReputation(input.workerId, "rejected");
    return { receipt };
  }

  private makeReceipt(
    input: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason">,
    decision: ReceiptDecision,
    reason?: string,
  ): ExecutionReceipt {
    const safeInput = stripReceiptAuthSecrets(input);
    const receiptHash = computeReceiptHash(safeInput);
    const worker = this.workers.get(input.workerId);
    return {
      ...safeInput,
      clientId: safeInput.clientId ?? worker?.clientId,
      accountUid: safeInput.accountUid ?? worker?.accountUid,
      receiptHash,
      receiptId: randomId("rcpt"),
      receivedAt: this.now(),
      decision,
      reason,
    };
  }

  private prepareReceipt(
    input: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason"> & {
      workerSessionToken: string;
      assignmentToken: string;
    },
    session: WorkerSession,
  ): {
    receipt: typeof input;
    reason?: string;
  } {
    const receiptHash = computeReceiptHash(input);
    const signaturePublicKeyHash = session.signingPublicKeyHash;
    const signatureStatus = receiptSignatureStatus(receiptHash, input.signature, session.signingPublicKey);
    const receipt = {
      ...input,
      receiptHash,
      signaturePublicKeyHash,
      signatureStatus,
    };
    if (input.receiptHash && !hashesEqual(input.receiptHash, receiptHash)) {
      return { receipt, reason: "receipt hash mismatch" };
    }
    if (this.requireReceiptSignatures && !session.signingPublicKey) {
      return { receipt, reason: "receipt signing public key required" };
    }
    if (session.signingPublicKey && signatureStatus === "missing") {
      return { receipt, reason: "receipt signature required" };
    }
    if (session.signingPublicKey && signatureStatus === "invalid") {
      return { receipt, reason: "receipt signature invalid" };
    }
    if (!session.signingPublicKey && input.signature) {
      return { receipt, reason: "receipt signing public key unavailable" };
    }
    return { receipt };
  }

  private evaluateChunk(task: ComputeTask, chunk: ComputeChunk): ValidationRecord | undefined {
    if (chunk.status !== "pending") return undefined;
    const receipts = this.validationReceiptsFor(chunk.chunkId);
    const matching = receipts.filter((receipt) =>
      receipt.decision === "pending" && hashesEqual(receipt.outputHash, chunk.expectedOutputHash),
    );
    const wrong = receipts.filter((receipt) => receipt.decision === "output-mismatch");
    if (matching.length >= task.validationPolicy.minAgreeing && receipts.length >= task.validationPolicy.minExecutions) {
      for (const receipt of matching) {
        receipt.decision = "accepted";
        this.bumpReputation(receipt.workerId, "accepted");
      }
      for (const receipt of wrong) {
        receipt.decision = "disagreement";
        this.bumpReputation(receipt.workerId, "disagreement");
      }
      chunk.status = "accepted";
      const validation = this.recordValidation(task, chunk, "accepted", receipts, matching, "expected hash quorum accepted");
      this.maybeCompleteTask(task);
      return validation;
    }
    if (receipts.length >= task.validationPolicy.minExecutions * 2 && matching.length < task.validationPolicy.minAgreeing) {
      chunk.status = "disagreement";
      const validation = this.recordValidation(task, chunk, "disagreement", receipts, matching, "quorum could not agree on expected hash");
      this.maybeCompleteTask(task);
      return validation;
    }
    return undefined;
  }

  private evaluateQuorumChunk(task: ComputeTask, chunk: ComputeChunk): ValidationRecord | undefined {
    if (chunk.status !== "pending") return undefined;
    const receipts = this.validationReceiptsFor(chunk.chunkId);
    const pending = receipts.filter((receipt) => receipt.decision === "pending");
    const groups = new Map<string, ExecutionReceipt[]>();
    for (const receipt of pending) {
      const key = `${receipt.outputHash.algorithm}:${receipt.outputHash.value}`;
      const group = groups.get(key) ?? [];
      group.push(receipt);
      groups.set(key, group);
    }
    const winning = Array.from(groups.values()).sort((a, b) =>
      b.length - a.length ||
      a[0].receivedAt - b[0].receivedAt
    )[0] ?? [];
    if (winning.length >= task.validationPolicy.minAgreeing && receipts.length >= task.validationPolicy.minExecutions) {
      const winningIds = new Set(winning.map((receipt) => receipt.receiptId));
      for (const receipt of receipts) {
        if (winningIds.has(receipt.receiptId)) {
          receipt.decision = "accepted";
          this.bumpReputation(receipt.workerId, "accepted");
        } else if (receipt.decision === "pending") {
          receipt.decision = "disagreement";
          this.bumpReputation(receipt.workerId, "disagreement");
        }
      }
      chunk.status = "accepted";
      const validation = this.recordValidation(task, chunk, "accepted", receipts, winning, "replicated quorum accepted");
      this.maybeCompleteTask(task);
      return validation;
    }
    if (receipts.length >= task.validationPolicy.minExecutions * 2 && winning.length < task.validationPolicy.minAgreeing) {
      for (const receipt of pending) {
        receipt.decision = "disagreement";
        this.bumpReputation(receipt.workerId, "disagreement");
      }
      chunk.status = "disagreement";
      const validation = this.recordValidation(task, chunk, "disagreement", receipts, winning, "quorum could not agree on output hash");
      this.maybeCompleteTask(task);
      return validation;
    }
    return undefined;
  }

  private evaluateMeasurementChunk(task: ComputeTask, chunk: ComputeChunk): ValidationRecord | undefined {
    if (chunk.status !== "pending") return undefined;
    const receipts = this.validationReceiptsFor(chunk.chunkId);
    const valid = receipts.filter((receipt) => receipt.decision === "pending");
    if (valid.length >= task.validationPolicy.minAgreeing && receipts.length >= task.validationPolicy.minExecutions) {
      for (const receipt of valid) {
        receipt.decision = "accepted";
        this.bumpReputation(receipt.workerId, "accepted");
      }
      chunk.status = "accepted";
      const reason = chunk.kind === DEVICE_WITNESS_WEBRTC_KERNEL_ID
        ? "measurement transcript accepted"
        : "measurement cohort accepted";
      const validation = this.recordValidation(task, chunk, "accepted", receipts, valid, reason);
      this.maybeCompleteTask(task);
      return validation;
    }
    return undefined;
  }

  private recordValidation(
    task: ComputeTask,
    chunk: ComputeChunk,
    status: ReceiptDecision,
    receipts: ExecutionReceipt[],
    accepted: ExecutionReceipt[],
    reason: string,
  ): ValidationRecord {
    const existing = Array.from(this.validations.values()).find((validation) =>
      validation.taskId === task.taskId &&
      validation.chunkId === chunk.chunkId &&
      validation.status === status
    );
    if (existing) return existing;
    const validation: ValidationRecord = {
      validationId: validationIdFor(task.taskId, chunk.chunkId, status),
      taskId: task.taskId,
      chunkId: chunk.chunkId,
      status,
      comparedReceiptIds: receipts.map((receipt) => receipt.receiptId),
      acceptedReceiptIds: accepted.map((receipt) => receipt.receiptId),
      reason,
      recordedAt: this.now(),
    };
    this.validations.set(validation.validationId, validation);
    return validation;
  }

  private maybeCompleteTask(task: ComputeTask): void {
    if (task.chunks.every((chunk) => chunk.status === "accepted" || chunk.status === "rejected" || chunk.status === "disagreement")) {
      task.status = "complete";
    }
  }

  private expireAssignments(): void {
    const now = this.now();
    for (const assignment of this.assignments.values()) {
      if ((assignment.status === "offered" || assignment.status === "accepted") && assignment.expiresAt <= now) {
        assignment.status = "timeout";
        this.bumpReputation(assignment.workerId, "timeout");
      }
    }
  }

  private requireWebRtcSession(sessionId: string, token: string): WebRtcSessionRecord {
    const session = this.webrtcSessions.get(sessionId);
    if (!session || session.token !== token) throw new Error("unknown WebRTC session");
    if (session.expiresAt <= this.now()) throw new Error("WebRTC session expired");
    if (session.status === "closed") throw new Error("WebRTC session closed");
    return session;
  }

  private requireWebRtcPair(pairId: string, token: string): WebRtcPairRecord {
    this.expireWebRtcPairs();
    const pair = this.webrtcPairs.get(pairId);
    if (!pair || pair.token !== token) throw new Error("unknown WebRTC pair");
    if (pair.expiresAt <= this.now()) throw new Error("WebRTC pair expired");
    if (pair.status === "closed") throw new Error("WebRTC pair closed");
    return pair;
  }

  private expireWebRtcPairs(): void {
    const now = this.now();
    for (const pair of this.webrtcPairs.values()) {
      if (pair.status !== "closed" && pair.expiresAt <= now) pair.status = "closed";
    }
  }

  private assignmentsFor(chunkId: string): Assignment[] {
    return Array.from(this.assignments.values()).filter((assignment) => assignment.chunkId === chunkId);
  }

  private receiptsFor(chunkId: string): ExecutionReceipt[] {
    return Array.from(this.receipts.values()).filter((receipt) => receipt.chunkId === chunkId);
  }

  private validationReceiptsFor(chunkId: string): ExecutionReceipt[] {
    const seenAssignments = new Set<string>();
    const receipts: ExecutionReceipt[] = [];
    for (const receipt of this.receiptsFor(chunkId)) {
      if (!this.isValidationReceipt(receipt)) continue;
      if (seenAssignments.has(receipt.assignmentId)) continue;
      seenAssignments.add(receipt.assignmentId);
      receipts.push(receipt);
    }
    return receipts;
  }

  private assignmentReceipt(assignmentId: string): ExecutionReceipt | null {
    return Array.from(this.receipts.values()).find((receipt) =>
      receipt.assignmentId === assignmentId &&
      this.isAssignmentBoundReceipt(receipt) &&
      receipt.decision !== "duplicate-receipt"
    ) ?? null;
  }

  private isValidationReceipt(receipt: ExecutionReceipt): boolean {
    if (!this.isAssignmentBoundReceipt(receipt)) return false;
    return (
      receipt.decision === "pending" ||
      receipt.decision === "accepted" ||
      receipt.decision === "output-mismatch" ||
      receipt.decision === "disagreement"
    );
  }

  private isAssignmentBoundReceipt(receipt: ExecutionReceipt): boolean {
    const assignment = this.assignments.get(receipt.assignmentId);
    return !!assignment &&
      assignment.workerId === receipt.workerId &&
      assignment.workerSessionId === receipt.workerSessionId &&
      assignment.taskId === receipt.taskId &&
      assignment.chunkId === receipt.chunkId &&
      receipt.decision !== "assignment-mismatch" &&
      receipt.decision !== "malformed";
  }

  private peerReceiptMismatch(
    task: ComputeTask,
    chunk: ComputeChunk,
    assignment: Assignment,
    receipt: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason">,
    receivedAt: number,
  ): string | null {
    const peerRequired = task.validationPolicy.requiredPeerSubreceipt === true ||
      (receipt.transport === "webrtc" && isWebRtcDataTask(chunk.kind));
    if (!peerRequired) return null;
    if (!isWebRtcDataTask(chunk.kind)) return "peer subreceipt unsupported for task";
    const subreceipt = peerSubreceiptFromAdapterInfo(receipt.adapterInfo);
    if (!subreceipt) return "peer subreceipt required";
    if (subreceipt.requesterWorkerId !== receipt.workerId || subreceipt.requesterSessionId !== receipt.workerSessionId) {
      return "peer subreceipt requester mismatch";
    }
    if (
      subreceipt.assignmentId !== receipt.assignmentId ||
      subreceipt.taskId !== receipt.taskId ||
      subreceipt.chunkId !== receipt.chunkId
    ) {
      return "peer subreceipt assignment mismatch";
    }
    if (
      subreceipt.kernelId !== receipt.kernelId ||
      !hashesEqual(subreceipt.kernelHash, receipt.kernelHash) ||
      !hashesEqual(subreceipt.inputHash, receipt.inputHash) ||
      !hashesEqual(subreceipt.outputHash, receipt.outputHash)
    ) {
      return "peer subreceipt compute binding mismatch";
    }
    if ((subreceipt.artifactHash || receipt.artifactHash) && !hashesEqual(subreceipt.artifactHash, receipt.artifactHash)) {
      return "peer subreceipt artifact mismatch";
    }
    if (subreceipt.workerId === receipt.workerId || subreceipt.workerSessionId === receipt.workerSessionId) {
      return "peer subreceipt must come from remote worker";
    }
    const pair = this.webrtcPairs.get(subreceipt.pairId);
    if (!pair) return "peer subreceipt pair missing";
    if (pair.status !== "matched" && pair.status !== "closed") return "peer subreceipt pair not matched";
    if (pair.createdAt > receivedAt) return "peer subreceipt pair created after receipt";
    if (pair.expiresAt < receivedAt) return "peer subreceipt pair expired";
    const pairHasRequester = (
      (pair.offererWorkerId === receipt.workerId && pair.offererSessionId === receipt.workerSessionId) ||
      (pair.answererWorkerId === receipt.workerId && pair.answererSessionId === receipt.workerSessionId)
    );
    const pairHasPeer = (
      (pair.offererWorkerId === subreceipt.workerId && pair.offererSessionId === subreceipt.workerSessionId) ||
      (pair.answererWorkerId === subreceipt.workerId && pair.answererSessionId === subreceipt.workerSessionId)
    );
    if (!pairHasRequester || !pairHasPeer) return "peer subreceipt pair participant mismatch";
    if (task.validationPolicy.requiredPeerSubreceipt === true || subreceipt.peerAssignmentId) {
      if (!subreceipt.peerAssignmentId) return "peer subassignment required";
      const subassignment = this.peerSubassignments.get(subreceipt.peerAssignmentId);
      if (!subassignment) return "peer subassignment missing";
      const subassignmentMismatch = this.linkedPeerSubassignmentMismatch(
        subassignment,
        task,
        chunk,
        assignment,
        receipt,
        subreceipt,
        receivedAt,
      );
      if (subassignmentMismatch) return subassignmentMismatch;
    }
    const peerSession = this.sessions.get(subreceipt.workerSessionId);
    if (!peerSession || peerSession.workerId !== subreceipt.workerId || !peerSession.signingPublicKey) {
      return "peer subreceipt signing key unavailable";
    }
    const expectedHash = peerSubreceiptHash(subreceipt);
    if (!hashesEqual(subreceipt.peerReceiptHash, expectedHash)) return "peer subreceipt hash mismatch";
    if (!verifyReceiptSignature(expectedHash, subreceipt.signature, peerSession.signingPublicKey)) {
      return "peer subreceipt signature invalid";
    }
    return null;
  }

  private linkedPeerSubassignmentMismatch(
    subassignment: PeerSubassignment,
    task: ComputeTask,
    chunk: ComputeChunk,
    assignment: Assignment,
    receipt: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason">,
    subreceipt: PeerSubreceipt,
    receivedAt: number,
  ): string | null {
    if (subassignment.status !== "accepted") return "peer subassignment not accepted";
    if (subassignment.expiresAt < receivedAt) return "peer subassignment expired";
    if (
      subassignment.parentAssignmentId !== assignment.assignmentId ||
      subassignment.pairId !== subreceipt.pairId ||
      subassignment.requestId !== subreceipt.requestId ||
      subassignment.requesterWorkerId !== receipt.workerId ||
      subassignment.requesterSessionId !== receipt.workerSessionId ||
      subassignment.peerWorkerId !== subreceipt.workerId ||
      subassignment.peerSessionId !== subreceipt.workerSessionId ||
      subassignment.taskId !== task.taskId ||
      subassignment.chunkId !== chunk.chunkId
    ) {
      return "peer subassignment binding mismatch";
    }
    if (
      subassignment.kernelId !== receipt.kernelId ||
      !hashesEqual(subassignment.kernelHash, receipt.kernelHash) ||
      !hashesEqual(subassignment.inputHash, receipt.inputHash) ||
      !hashesEqual(subassignment.outputHash, receipt.outputHash) ||
      !hashesEqual(subassignment.peerReceiptHash, subreceipt.peerReceiptHash)
    ) {
      return "peer subassignment receipt mismatch";
    }
    if ((subassignment.artifactHash || receipt.artifactHash) && !hashesEqual(subassignment.artifactHash, receipt.artifactHash)) {
      return "peer subassignment artifact mismatch";
    }
    return null;
  }

  private peerSubassignmentReceiptMismatch(
    subassignment: PeerSubassignment,
    subreceipt: PeerSubreceipt,
    session: WorkerSession,
  ): string | null {
    const task = this.requireTask(subassignment.taskId);
    const chunk = this.requireChunk(subassignment.chunkId);
    if (
      subreceipt.peerAssignmentId !== subassignment.peerAssignmentId ||
      subreceipt.pairId !== subassignment.pairId ||
      subreceipt.requestId !== subassignment.requestId ||
      subreceipt.requesterWorkerId !== subassignment.requesterWorkerId ||
      subreceipt.requesterSessionId !== subassignment.requesterSessionId ||
      subreceipt.workerId !== subassignment.peerWorkerId ||
      subreceipt.workerSessionId !== subassignment.peerSessionId ||
      subreceipt.assignmentId !== subassignment.parentAssignmentId ||
      subreceipt.taskId !== subassignment.taskId ||
      subreceipt.chunkId !== subassignment.chunkId
    ) {
      return "peer subassignment binding mismatch";
    }
    if (
      subreceipt.kernelId !== subassignment.kernelId ||
      !hashesEqual(subreceipt.kernelHash, subassignment.kernelHash) ||
      !hashesEqual(subreceipt.inputHash, subassignment.inputHash) ||
      !hashesEqual(subreceipt.outputHash, chunk.expectedOutputHash)
    ) {
      return "peer subassignment compute mismatch";
    }
    if ((subreceipt.artifactHash || subassignment.artifactHash) && !hashesEqual(subreceipt.artifactHash, subassignment.artifactHash)) {
      return "peer subassignment artifact mismatch";
    }
    if (!isWebRtcDataTask(task.kind)) return "peer subassignment task unsupported";
    const expectedHash = peerSubreceiptHash(subreceipt);
    if (!hashesEqual(subreceipt.peerReceiptHash, expectedHash)) return "peer subreceipt hash mismatch";
    if (!verifyReceiptSignature(expectedHash, subreceipt.signature, session.signingPublicKey!)) {
      return "peer subreceipt signature invalid";
    }
    return null;
  }

  private bumpReputation(workerId: string, kind: "accepted" | "rejected" | "timeout" | "disagreement"): void {
    const rep = this.reputation.get(workerId) ?? {
      workerId,
      accepted: 0,
      rejected: 0,
      timeouts: 0,
      disagreements: 0,
    };
    if (kind === "accepted") rep.accepted++;
    else if (kind === "rejected") rep.rejected++;
    else if (kind === "timeout") rep.timeouts++;
    else rep.disagreements++;
    this.reputation.set(workerId, rep);
  }
}

export interface PeerSubreceipt {
  protocol: "plasma-peer-result.v1";
  peerAssignmentId?: string;
  pairId: string;
  requestId: string;
  requesterWorkerId: string;
  requesterSessionId: string;
  workerId: string;
  workerSessionId: string;
  assignmentId: string;
  taskId: string;
  chunkId: string;
  kernelId: string;
  kernelHash: ContentHash;
  inputHash: ContentHash;
  artifactHash?: ContentHash;
  outputHash: ContentHash;
  executionMode: ExecutionMode;
  computeMs: number;
  clientVersion?: string;
  peerReceiptHash: ContentHash;
  signature: string;
  signaturePublicKeyHash?: ContentHash;
}

function peerSubreceiptFromAdapterInfo(adapterInfo: Record<string, unknown> | undefined): PeerSubreceipt | null {
  const raw = adapterInfo?.peerSubreceipt;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const subreceipt = {
    protocol: value.protocol,
    peerAssignmentId: value.peerAssignmentId,
    pairId: value.pairId,
    requestId: value.requestId,
    requesterWorkerId: value.requesterWorkerId,
    requesterSessionId: value.requesterSessionId,
    workerId: value.workerId,
    workerSessionId: value.workerSessionId,
    assignmentId: value.assignmentId,
    taskId: value.taskId,
    chunkId: value.chunkId,
    kernelId: value.kernelId,
    kernelHash: value.kernelHash,
    inputHash: value.inputHash,
    artifactHash: value.artifactHash,
    outputHash: value.outputHash,
    executionMode: value.executionMode,
    computeMs: value.computeMs,
    clientVersion: value.clientVersion,
    peerReceiptHash: value.peerReceiptHash,
    signature: value.signature,
    signaturePublicKeyHash: value.signaturePublicKeyHash,
  };
  if (
    subreceipt.protocol !== "plasma-peer-result.v1" ||
    (subreceipt.peerAssignmentId !== undefined && !isNonEmptyString(subreceipt.peerAssignmentId)) ||
    !isNonEmptyString(subreceipt.pairId) ||
    !isNonEmptyString(subreceipt.requestId) ||
    !isNonEmptyString(subreceipt.requesterWorkerId) ||
    !isNonEmptyString(subreceipt.requesterSessionId) ||
    !isNonEmptyString(subreceipt.workerId) ||
    !isNonEmptyString(subreceipt.workerSessionId) ||
    !isNonEmptyString(subreceipt.assignmentId) ||
    !isNonEmptyString(subreceipt.taskId) ||
    !isNonEmptyString(subreceipt.chunkId) ||
    !isNonEmptyString(subreceipt.kernelId) ||
    !isContentHash(subreceipt.kernelHash) ||
    !isContentHash(subreceipt.inputHash) ||
    (subreceipt.artifactHash !== undefined && !isContentHash(subreceipt.artifactHash)) ||
    !isContentHash(subreceipt.outputHash) ||
    (subreceipt.executionMode !== "cpu" && subreceipt.executionMode !== "webgpu") ||
    typeof subreceipt.computeMs !== "number" ||
    !Number.isFinite(subreceipt.computeMs) ||
    !isContentHash(subreceipt.peerReceiptHash) ||
    !isNonEmptyString(subreceipt.signature)
  ) {
    return null;
  }
  return subreceipt as PeerSubreceipt;
}

function peerSubreceiptHash(input: PeerSubreceipt): ContentHash {
  return hashCanonical(peerSubreceiptPayload(input));
}

function peerSubreceiptPayload(input: Omit<PeerSubreceipt, "peerReceiptHash" | "signature" | "signaturePublicKeyHash">): Record<string, unknown> {
  return {
    peerReceiptVersion: 1,
    protocol: input.protocol,
    peerAssignmentId: input.peerAssignmentId,
    pairId: input.pairId,
    requestId: input.requestId,
    requesterWorkerId: input.requesterWorkerId,
    requesterSessionId: input.requesterSessionId,
    workerId: input.workerId,
    workerSessionId: input.workerSessionId,
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    chunkId: input.chunkId,
    kernelId: input.kernelId,
    kernelHash: input.kernelHash,
    inputHash: input.inputHash,
    artifactHash: input.artifactHash,
    outputHash: input.outputHash,
    executionMode: input.executionMode,
    computeMs: input.computeMs,
    clientVersion: input.clientVersion,
  };
}

function isWebRtcDataTask(kind: TaskKind): boolean {
  return (
    kind === ASSET_TILE_AUDIT_KERNEL_ID ||
    kind === CONTACT_MAP_TILE_KERNEL_ID ||
    kind === EMBEDDING_TILE_KERNEL_ID ||
    kind === EXPLOIT_SEARCH_KERNEL_ID ||
    kind === IMAGE_TILE_INFER_KERNEL_ID ||
    kind === MICROSCOPY_TILE_SCORE_KERNEL_ID ||
    kind === PREFILL_TOPK_PROBE_KERNEL_ID ||
    kind === PUBLIC_ARTIFACT_VERIFY_KERNEL_ID ||
    kind === REPLAY_VERIFY_KERNEL_ID ||
    kind === SEED_SWEEP_KERNEL_ID ||
    kind === TENSOR_TILE_KERNEL_ID
  );
}

function pairParticipantRole(
  pair: WebRtcPairRecord,
  workerId: string,
  workerSessionId: string,
): "offerer" | "answerer" | null {
  if (pair.offererWorkerId === workerId && pair.offererSessionId === workerSessionId) return "offerer";
  if (pair.answererWorkerId === workerId && pair.answererSessionId === workerSessionId) return "answerer";
  return null;
}

function peerParticipantFor(
  pair: WebRtcPairRecord,
  role: "offerer" | "answerer",
): { workerId: string; workerSessionId: string } | null {
  if (role === "offerer") {
    return pair.answererWorkerId && pair.answererSessionId
      ? { workerId: pair.answererWorkerId, workerSessionId: pair.answererSessionId }
      : null;
  }
  return { workerId: pair.offererWorkerId, workerSessionId: pair.offererSessionId };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isContentHash(value: unknown): value is ContentHash {
  return !!value &&
    typeof value === "object" &&
    (value as ContentHash).algorithm === "sha256" &&
    typeof (value as ContentHash).value === "string" &&
    /^[a-f0-9]{64}$/.test((value as ContentHash).value);
}

function receiptPolicyMismatch(
  task: ComputeTask,
  receipt: Pick<ExecutionReceipt, "transport">,
): string | null {
  if (task.validationPolicy.requiredTransport && receipt.transport !== task.validationPolicy.requiredTransport) {
    return "required transport mismatch";
  }
  return null;
}

function receiptMismatch(
  chunk: ComputeChunk,
  input: Pick<ExecutionReceipt, "kernelId" | "kernelHash" | "inputHash" | "artifactHash" | "outputHash" | "derived" | "publicOutput">,
): { decision: ReceiptDecision; reason: string } | null {
  if (input.kernelId !== chunk.kernelId || !hashesEqual(input.kernelHash, chunk.kernelHash)) {
    return { decision: "kernel-mismatch", reason: "kernel did not match assignment" };
  }
  if (!hashesEqual(input.inputHash, chunk.inputHash)) {
    return { decision: "input-mismatch", reason: "input hash did not match assignment" };
  }
  if (chunk.artifactHash) {
    if (!input.artifactHash) {
      if (chunk.kind !== PUBLIC_ARTIFACT_VERIFY_KERNEL_ID) {
        return { decision: "input-mismatch", reason: "artifact hash did not match assignment" };
      }
    } else if (!hashesEqual(input.artifactHash, chunk.artifactHash)) {
      return { decision: "input-mismatch", reason: "artifact hash did not match assignment" };
    }
  }
  if (chunk.kind === DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID) {
    const derived = input.derived;
    const sourceId = stringParam(chunk.params.sourceId);
    const regionId = stringParam(chunk.params.regionId);
    const outputId = stringParam(chunk.params.outputId);
    if (!derived || derived.contractVersion !== "derived-compute-extension.v0") {
      return { decision: "malformed", reason: "derived evidence required" };
    }
    const sourceHash = derived.sourceHashes?.[sourceId];
    const bufferRegionHash = derived.bufferRegionHashes?.[regionId];
    const producerKernelHash = derived.producerKernelHashes?.[outputId];
    const outputHash = derived.outputHashes?.[outputId];
    if (!sourceHash) {
      return { decision: "malformed", reason: "derived source hash required" };
    }
    if (!bufferRegionHash) {
      return { decision: "malformed", reason: "derived buffer region hash required" };
    }
    if (!producerKernelHash) {
      return { decision: "malformed", reason: "derived producer kernel hash required" };
    }
    if (!outputHash) {
      return { decision: "malformed", reason: "derived output hash required" };
    }
    if (!derived.derivedOutputHash) {
      return { decision: "malformed", reason: "derived output hash required" };
    }
    if (!hashesEqual(sourceHash, hashParam(chunk.params.sourceHash))) {
      return { decision: "input-mismatch", reason: "derived source hash mismatch" };
    }
    if (!hashesEqual(bufferRegionHash, hashParam(chunk.params.regionHash))) {
      return { decision: "input-mismatch", reason: "derived buffer region hash mismatch" };
    }
    if (!hashesEqual(producerKernelHash, hashParam(chunk.params.producerKernelHash))) {
      return { decision: "kernel-mismatch", reason: "derived producer kernel hash mismatch" };
    }
    if (!hashesEqual(outputHash, input.outputHash)) {
      return { decision: "output-mismatch", reason: "derived output hash mismatch" };
    }
    if (!hashesEqual(derived.derivedOutputHash, input.outputHash)) {
      return { decision: "output-mismatch", reason: "derived output hash mismatch" };
    }
  }
  if (chunk.kind === LOGIT_DIVERGENCE_KERNEL_ID) {
    const publicOutputMismatch = logitDivergenceReceiptMismatch(chunk, input);
    if (publicOutputMismatch) return publicOutputMismatch;
  }
  return null;
}

function logitDivergenceReceiptMismatch(
  chunk: ComputeChunk,
  input: Pick<ExecutionReceipt, "outputHash" | "publicOutput">,
): { decision: ReceiptDecision; reason: string } | null {
  if (!input.publicOutput) {
    return { decision: "malformed", reason: "logit divergence publicOutput required" };
  }
  let outputSize = 0;
  try {
    outputSize = canonicalJson(input.publicOutput).length;
  } catch {
    return { decision: "malformed", reason: "logit divergence publicOutput invalid" };
  }
  if (outputSize <= 0 || outputSize > 8192) {
    return { decision: "malformed", reason: "logit divergence publicOutput too large" };
  }
  try {
    const normalized = normalizeLogitDivergencePublicOutput(input.publicOutput, {
      modelId: stringParam(chunk.params.modelId),
      promptText: stringParam(chunk.params.promptText),
      topK: asInt(chunk.params.topK, "topK"),
    });
    const expectedPromptHash = sha256(stringParam(chunk.params.promptText)).value;
    if (normalized.promptHash !== expectedPromptHash) {
      return { decision: "input-mismatch", reason: "logit divergence prompt hash mismatch" };
    }
    const outputHash = logitDivergencePublicOutputHash(normalized);
    if (!hashesEqual(outputHash, input.outputHash)) {
      return { decision: "output-mismatch", reason: "logit divergence output hash mismatch" };
    }
  } catch (error) {
    return { decision: "malformed", reason: error instanceof Error ? error.message : "logit divergence publicOutput invalid" };
  }
  return null;
}

function hashParam(value: unknown): ContentHash {
  return { algorithm: "sha256", value: stringParam(value) };
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function normalizeIdentityToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 128);
  if (!/^[A-Za-z0-9._:\-]{1,128}$/.test(trimmed)) return undefined;
  return trimmed;
}

function hashesEqual(a: ContentHash | undefined, b: ContentHash | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.value.toLowerCase() === b.value.toLowerCase();
}

function stripReceiptAuthSecrets<T>(input: T): Omit<T, "workerSessionToken" | "assignmentToken"> {
  const {
    workerSessionToken: _workerSessionToken,
    assignmentToken: _assignmentToken,
    ...safe
  } = input as T & { workerSessionToken?: string; assignmentToken?: string };
  return safe;
}

function validationIdFor(taskId: string, chunkId: string, status: ReceiptDecision): string {
  return `val-${hashCanonical({ kind: "compute-validation", taskId, chunkId, status }).value.slice(0, 16)}`;
}

export function receiptHashPayload(
  input: Pick<ExecutionReceipt,
    | "workerId"
    | "workerSessionId"
    | "assignmentId"
    | "taskId"
    | "chunkId"
    | "kernelId"
    | "kernelHash"
    | "inputHash"
    | "artifactHash"
    | "outputHash"
    | "determinismClass"
    | "validationMode"
    | "executionMode"
    | "transport"
    | "governorMode"
    | "deviceClass"
    | "adapterInfo"
    | "derived"
    | "publicOutput"
    | "computeMs"
    | "clientVersion"
  >,
): Record<string, unknown> {
  return {
    receiptVersion: 1,
    workerId: input.workerId,
    workerSessionId: input.workerSessionId,
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    chunkId: input.chunkId,
    kernelId: input.kernelId,
    kernelHash: input.kernelHash,
    inputHash: input.inputHash,
    artifactHash: input.artifactHash,
    outputHash: input.outputHash,
    determinismClass: input.determinismClass,
    validationMode: input.validationMode,
    executionMode: input.executionMode,
    transport: input.transport,
    governorMode: input.governorMode,
    deviceClass: input.deviceClass,
    adapterInfo: input.adapterInfo,
    derived: input.derived,
    publicOutput: input.publicOutput,
    computeMs: input.computeMs,
    clientVersion: input.clientVersion,
  };
}

export function computeReceiptHash(
  input: Parameters<typeof receiptHashPayload>[0],
): ContentHash {
  return hashCanonical(receiptHashPayload(input));
}

function normalizeSigningPublicKey(input: JsonWebKey | undefined): JsonWebKey | undefined {
  if (!input || input.kty !== "EC" || input.crv !== "P-256") return undefined;
  if (typeof input.x !== "string" || typeof input.y !== "string") return undefined;
  return {
    kty: "EC",
    crv: "P-256",
    x: input.x,
    y: input.y,
  };
}

function receiptSignatureStatus(
  receiptHash: ContentHash,
  signature: string | undefined,
  publicKey: JsonWebKey | undefined,
): ExecutionReceipt["signatureStatus"] {
  if (!publicKey) return signature ? "key-unavailable" : "unsigned";
  if (!signature) return "missing";
  return verifyReceiptSignature(receiptHash, signature, publicKey) ? "verified" : "invalid";
}

function verifyReceiptSignature(receiptHash: ContentHash, signature: string, publicKey: JsonWebKey): boolean {
  try {
    const key = createPublicKey({ key: publicKey, format: "jwk" });
    return verifySignature(
      "sha256",
      Buffer.from(receiptHash.value, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function measurementReceiptHash(chunk: ComputeChunk, adapterInfo: Record<string, unknown> | undefined): ContentHash | null {
  if (chunk.kind !== DEVICE_WITNESS_WEBRTC_KERNEL_ID) return null;
  const transcript = measurementTranscript(adapterInfo);
  if (!transcript.status) return null;
  return hashCanonical({ kind: chunk.kind, params: chunk.params, transcript });
}

function measurementTranscript(adapterInfo: Record<string, unknown> | undefined): Record<string, string> {
  const source = adapterInfo ?? {};
  const out: Record<string, string> = {};
  for (const key of [
    "status",
    "mode",
    "browserFamily",
    "deviceClass",
    "networkTypeBucket",
    "downlinkBucket",
    "rttBucket",
    "webrtcOpenMsBucket",
    "iceGatherMsBucket",
    "iceHostBucket",
    "iceSrflxBucket",
    "iceRelayBucket",
    "stunSuccessBucket",
    "turnNeedBucket",
    "dataChannelBucket",
    "dataWorkBucket",
    "dataReceiptBucket",
    "visibilityBucket",
    "batteryBucket",
  ]) {
    const bucket = measurementBucket(source[key]);
    if (bucket) out[key] = bucket;
  }
  return out;
}

function measurementBucket(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return undefined;
  return /^[a-z0-9<>=][a-z0-9_.:+/<>=-]{0,63}$/.test(raw) ? raw : "other";
}

function capabilityMap(workers: WorkerRecord[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const worker of workers) {
    inc(out, "deviceClass", worker.capability.deviceClass ?? "unknown");
    for (const surface of worker.capability.runtimeSurfaces ?? []) inc(out, "runtimeSurface", surface);
    const adapter = worker.capability.adapterInfo ?? {};
    for (const key of [
      "userAgentBucket",
      "coreBucket",
      "webgpu",
      "gpuVendorBucket",
      "webgpuBenchmark",
      "webgpuCorrectness",
      "webgpuMismatchBucket",
      "webgpuKernelMsBucket",
      "webgpuThroughputBucket",
      "workerFixture",
      "canvas2dFixture",
      "canvas2dFixtureMsBucket",
      "canvas2dAlphaBucket",
      "frameP95Bucket",
      "droppedFrameBurstBucket",
      "hiddenPauseBucket",
      "lowBatteryPauseBucket",
      "renderStrugglePauseBucket",
      "batteryBucket",
      "visibilityBucket",
    ]) {
      const value = adapter[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        inc(out, key, String(value));
      }
    }
  }
  return out;
}

function capabilityObservationMap(observations: CapabilityObservation[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const observation of observations) {
    inc(out, "reason", observation.reason);
    inc(out, "deviceClass", bucketOrUnknown(observation.deviceClass));
    for (const surface of observation.runtimeSurfaces) inc(out, "runtimeSurface", surface);
    for (const kernel of observation.kernels) inc(out, "kernel", kernel);
    for (const [key, value] of Object.entries(observation.adapterInfo ?? {})) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        inc(out, key, String(value));
      }
    }
  }
  return out;
}

function connectivityObservationMap(observations: ConnectivityObservation[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const observation of observations) {
    inc(out, "transport", observation.transport);
    inc(out, "status", observation.status);
    inc(out, "mode", bucketOrUnknown(observation.mode));
    inc(out, "browserFamily", bucketOrUnknown(observation.browserFamily));
    inc(out, "deviceClass", bucketOrUnknown(observation.deviceClass));
    inc(out, "networkTypeBucket", bucketOrUnknown(observation.networkTypeBucket));
    inc(out, "downlinkBucket", bucketOrUnknown(observation.downlinkBucket));
    inc(out, "rttBucket", bucketOrUnknown(observation.rttBucket));
    inc(out, "httpRttBucket", bucketOrUnknown(observation.httpRttBucket));
    inc(out, "webrtcOpenMsBucket", bucketOrUnknown(observation.webrtcOpenMsBucket));
    inc(out, "iceGatherMsBucket", bucketOrUnknown(observation.iceGatherMsBucket));
    inc(out, "iceHostBucket", bucketOrUnknown(observation.iceHostBucket));
    inc(out, "iceSrflxBucket", bucketOrUnknown(observation.iceSrflxBucket));
    inc(out, "iceRelayBucket", bucketOrUnknown(observation.iceRelayBucket));
    inc(out, "stunSuccessBucket", bucketOrUnknown(observation.stunSuccessBucket));
    inc(out, "turnNeedBucket", bucketOrUnknown(observation.turnNeedBucket));
    inc(out, "signalingRttBucket", bucketOrUnknown(observation.signalingRttBucket));
    inc(out, "dataChannelBucket", bucketOrUnknown(observation.dataChannelBucket));
    inc(out, "dataWorkBucket", bucketOrUnknown(observation.dataWorkBucket));
    inc(out, "dataReceiptBucket", bucketOrUnknown(observation.dataReceiptBucket));
    inc(out, "visibilityBucket", bucketOrUnknown(observation.visibilityBucket));
    inc(out, "batteryBucket", bucketOrUnknown(observation.batteryBucket));
  }
  return out;
}

function buildWorkerProfiles(input: {
  now: number;
  workers: WorkerRecord[];
  receipts: ExecutionReceipt[];
  assignments: Assignment[];
  capabilityObservations: CapabilityObservation[];
  connectivityObservations: ConnectivityObservation[];
}): WorkerProfile[] {
  const caps = latestCapabilityByWorker(input.capabilityObservations);
  const conn = latestConnectivityByWorker(input.connectivityObservations);
  return input.workers.map((worker) => {
    const adapter = worker.capability.adapterInfo ?? caps.get(worker.workerId)?.adapterInfo ?? {};
    const workerReceipts = input.receipts.filter((receipt) => receipt.workerId === worker.workerId);
    const workerAssignments = input.assignments.filter((assignment) => assignment.workerId === worker.workerId);
    const webgpuReceipts = workerReceipts.filter((receipt) => receipt.kernelId === DEVICE_WITNESS_WEBGPU_KERNEL_ID);
    const renderReceipts = workerReceipts.filter((receipt) => receipt.kernelId === DEVICE_WITNESS_RENDER_KERNEL_ID);
    const connectivity = input.connectivityObservations.filter((observation) => observation.workerId === worker.workerId);
    const webrtc = connectivity.filter((observation) =>
      observation.transport === "webrtc-local" || observation.transport === "webrtc-signaling"
    );
    const kernelTimes = workerReceipts
      .map((receipt) => receipt.computeMs)
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    const acceptedReceipts = workerReceipts.filter((receipt) => receipt.decision === "accepted").length;
    const rejectedReceipts = workerReceipts.filter((receipt) => isRejectedDecision(receipt.decision)).length;
    const webgpuWitnessReceipts = webgpuReceipts.filter((receipt) => receipt.decision === "accepted").length;
    const renderWitnessReceipts = renderReceipts.filter((receipt) => receipt.decision === "accepted").length;
    const timeoutAssignments = workerAssignments.filter((assignment) => assignment.status === "timeout").length;
    const recentWindowStart = input.now - 30 * 60_000;
    const recentReceipts = workerReceipts.filter((receipt) =>
      receipt.receivedAt >= recentWindowStart && receipt.decision !== "pending"
    );
    const recentTimeouts = workerAssignments.filter((assignment) =>
      assignment.assignedAt >= recentWindowStart && assignment.status === "timeout"
    ).length;
    const recentFailures = recentReceipts.filter((receipt) => isRejectedDecision(receipt.decision)).length + recentTimeouts;
    const recentFailureRate = ratio(recentFailures, recentReceipts.length + recentTimeouts, null);
    const failureBuckets: Record<string, number> = {};
    for (const receipt of workerReceipts) {
      if (isRejectedDecision(receipt.decision)) incFlat(failureBuckets, receipt.reason ?? receipt.decision);
    }
    for (const observation of connectivity) {
      if (observation.status !== "ok") incFlat(failureBuckets, `${observation.transport}:${observation.status}`);
    }
    const browserFamily = stringBucket(adapter.userAgentBucket) ?? caps.get(worker.workerId)?.clientVersion ?? "unknown";
    const deviceClass = worker.capability.deviceClass ?? caps.get(worker.workerId)?.deviceClass ?? "unknown";
    const gpuVendor = stringBucket(adapter.gpuVendorBucket) ?? "unknown";
    const webgpuAvailable = adapter.webgpu === "available" || worker.capability.runtimeSurfaces.includes("browser-webgpu");
    const webgpuCorrectnessScore = ratio(
      webgpuReceipts.filter((receipt) => receipt.decision === "accepted").length,
      webgpuReceipts.length,
      adapter.webgpuCorrectness === "ok" ? 1 : adapter.webgpuCorrectness === "mismatch" ? 0 : null,
    );
    const renderFixtureScore = ratio(
      renderReceipts.filter((receipt) => receipt.decision === "accepted").length,
      renderReceipts.length,
      adapter.canvas2dFixture === "ok" ? 1 : adapter.canvas2dFixture === "mismatch" || adapter.canvas2dFixture === "failed" ? 0 : null,
    );
    const directSuccess = webrtc.filter((observation) =>
      observation.status === "ok" && observation.iceRelayBucket !== "yes"
    ).length;
    const turnRequired = webrtc.filter((observation) =>
      observation.iceRelayBucket === "yes" ||
      observation.turnNeedBucket === "relay-available" ||
      observation.turnNeedBucket === "required"
    ).length;
    const p95KernelMs = percentile(kernelTimes, 0.95);
    const webrtcDirectSuccessRate = ratio(directSuccess, webrtc.length, null);
    const tier = allowedWorkloadTier({
      cpuReferenceAvailable: worker.capability.runtimeSurfaces.includes("cpu-reference"),
      webgpuAvailable,
      webgpuCorrectnessScore,
      renderFixtureScore,
      webgpuWitnessReceipts,
      renderWitnessReceipts,
      p95KernelMs,
    });
    const trustScore = workerTrustScore({
      acceptedReceipts,
      rejectedReceipts,
      timeoutAssignments,
      recentFailureRate,
      webgpuCorrectnessScore,
      renderFixtureScore,
      webrtcDirectSuccessRate,
    });
    return {
      workerId: worker.workerId,
      lastSeenAt: worker.lastSeenAt,
      browserFamily,
      deviceClass,
      adapterClass: `${deviceClass}:${gpuVendor}`,
      webgpuAvailable,
      webgpuCorrectnessScore,
      renderFixtureScore,
      webrtcDirectSuccessRate,
      turnRequiredRate: ratio(turnRequired, webrtc.length, null),
      avgKernelMs: average(kernelTimes),
      p95KernelMs,
      avgFrameRegressionMs: null,
      webgpuWitnessReceipts,
      renderWitnessReceipts,
      allowedWorkloadTier: tier,
      trustScore,
      recentFailureRate,
      acceptedReceipts,
      rejectedReceipts,
      timeoutAssignments,
      failureBuckets,
    };
  }).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function latestCapabilityByWorker(observations: CapabilityObservation[]): Map<string, CapabilityObservation> {
  const out = new Map<string, CapabilityObservation>();
  for (const observation of observations) {
    const prev = out.get(observation.workerId);
    if (!prev || observation.observedAt > prev.observedAt) out.set(observation.workerId, observation);
  }
  return out;
}

function latestConnectivityByWorker(observations: ConnectivityObservation[]): Map<string, ConnectivityObservation> {
  const out = new Map<string, ConnectivityObservation>();
  for (const observation of observations) {
    const prev = out.get(observation.workerId);
    if (!prev || observation.observedAt > prev.observedAt) out.set(observation.workerId, observation);
  }
  return out;
}

function classProfiles(profiles: WorkerProfile[], now: number, keyFor: (profile: WorkerProfile) => string): ClassProfile[] {
  const groups = new Map<string, WorkerProfile[]>();
  for (const profile of profiles) {
    const key = stringBucket(keyFor(profile)) ?? "unknown";
    const group = groups.get(key) ?? [];
    group.push(profile);
    groups.set(key, group);
  }
  return Array.from(groups.entries())
    .map(([classId, group]) => {
      const kernelTimes = group.map((profile) => profile.p95KernelMs).filter(isNumber);
      return {
        classId,
        workers: group.length,
        activeWorkers: group.filter((profile) => now - profile.lastSeenAt < 10 * 60 * 1000).length,
        avgKernelMs: average(kernelTimes),
        p95KernelMs: percentile(kernelTimes, 0.95),
        webgpuCorrectnessScore: average(group.map((profile) => profile.webgpuCorrectnessScore).filter(isNumber)),
        renderFixtureScore: average(group.map((profile) => profile.renderFixtureScore).filter(isNumber)),
        webrtcDirectSuccessRate: average(group.map((profile) => profile.webrtcDirectSuccessRate).filter(isNumber)),
        turnRequiredRate: average(group.map((profile) => profile.turnRequiredRate).filter(isNumber)),
      };
    })
    .sort((a, b) => b.workers - a.workers);
}

function summarizePublicStats(input: {
  generatedAt: number;
  minWorkers: number;
  suppressed: boolean;
  profiles: WorkerProfile[];
  receipts: ExecutionReceipt[];
  tasks: ComputeTask[];
}): PublicComputeStats {
  const profiles = input.suppressed ? [] : input.profiles;
  const kernelTimes = profiles.map((profile) => profile.p95KernelMs).filter(isNumber);
  const accepted = input.receipts.filter((receipt) => receipt.decision === "accepted").length;
  const scoreBreakdown = computeScoreBreakdown(input.tasks, input.receipts);
  const adapterBuckets: Record<string, number> = {};
  const allowedTierBuckets: Record<string, number> = {};
  const failureBuckets: Record<string, number> = {};
  for (const profile of profiles) {
    incFlat(adapterBuckets, profile.adapterClass);
    incFlat(allowedTierBuckets, profile.allowedWorkloadTier);
    for (const [key, count] of Object.entries(profile.failureBuckets)) {
      failureBuckets[key] = (failureBuckets[key] ?? 0) + count;
    }
  }
  return {
    generatedAt: input.generatedAt,
    privacy: input.suppressed ? "suppressed" : "full",
    minWorkers: input.minWorkers,
    scoreVersion: "compute-score-v1",
    computeScore: computeScore(scoreBreakdown),
    scoreBreakdown,
    totalWorkers: input.profiles.length,
    activeWorkers: profiles.filter((profile) => input.generatedAt - profile.lastSeenAt < 10 * 60 * 1000).length,
    totalReceipts: input.suppressed ? 0 : input.receipts.length,
    acceptedReceiptPct: input.suppressed ? null : percent(accepted, input.receipts.length),
    webgpuSupportedPct: input.suppressed ? null : percent(profiles.filter((profile) => profile.webgpuAvailable).length, profiles.length),
    webgpuCorrectnessPct: input.suppressed ? null : percent(
      profiles.filter((profile) => profile.webgpuCorrectnessScore !== null && profile.webgpuCorrectnessScore >= 1).length,
      profiles.filter((profile) => profile.webgpuCorrectnessScore !== null).length,
    ),
    renderFixturePct: input.suppressed ? null : percent(
      profiles.filter((profile) => profile.renderFixtureScore !== null && profile.renderFixtureScore >= 1).length,
      profiles.filter((profile) => profile.renderFixtureScore !== null).length,
    ),
    webrtcDirectSuccessPct: input.suppressed ? null : percent(
      profiles.filter((profile) => profile.webrtcDirectSuccessRate !== null && profile.webrtcDirectSuccessRate > 0).length,
      profiles.filter((profile) => profile.webrtcDirectSuccessRate !== null).length,
    ),
    turnRequiredPct: input.suppressed ? null : percent(
      profiles.filter((profile) => profile.turnRequiredRate !== null && profile.turnRequiredRate > 0).length,
      profiles.filter((profile) => profile.turnRequiredRate !== null).length,
    ),
    medianKernelMs: input.suppressed ? null : percentile(kernelTimes, 0.5),
    p95KernelMs: input.suppressed ? null : percentile(kernelTimes, 0.95),
    allowedTierBuckets,
    adapterBuckets,
    failureBuckets,
  };
}

function computeScoreBreakdown(tasks: ComputeTask[], receipts: ExecutionReceipt[]): ComputeScoreBreakdown {
  const acceptedChunkIds = new Set<string>();
  for (const task of tasks) {
    for (const chunk of task.chunks) {
      if (chunk.status === "accepted") acceptedChunkIds.add(chunk.chunkId);
    }
  }
  let acceptedAssetTileAuditChunks = 0;
  let acceptedContactMapTileChunks = 0;
  let acceptedContactMapTileCells = 0;
  let acceptedEmbeddingTileChunks = 0;
  let acceptedExploitSearchChunks = 0;
  let acceptedExploitSearchSeeds = 0;
  let acceptedImageTileInferChunks = 0;
  let acceptedLogitDivergenceChunks = 0;
  let acceptedMicroscopyTileScoreChunks = 0;
  let acceptedPrefillTopkProbeChunks = 0;
  let acceptedPublicArtifactChunks = 0;
  let acceptedReplayVerifyChunks = 0;
  let acceptedSeedSweepChunks = 0;
  let acceptedSeedSweepSeeds = 0;
  let acceptedTensorTileChunks = 0;
  let acceptedTensorTileCells = 0;
  for (const task of tasks) {
    for (const chunk of task.chunks) {
      if (!acceptedChunkIds.has(chunk.chunkId)) continue;
      if (task.kind === ASSET_TILE_AUDIT_KERNEL_ID) acceptedAssetTileAuditChunks++;
      else if (task.kind === CONTACT_MAP_TILE_KERNEL_ID) {
        acceptedContactMapTileChunks++;
        acceptedContactMapTileCells += Math.max(
          0,
          stringParam(chunk.params.rowResidues).length * stringParam(chunk.params.colResidues).length,
        );
      } else if (task.kind === EMBEDDING_TILE_KERNEL_ID) acceptedEmbeddingTileChunks++;
      else if (task.kind === EXPLOIT_SEARCH_KERNEL_ID) {
        acceptedExploitSearchChunks++;
        acceptedExploitSearchSeeds += Math.max(
          0,
          asInt(chunk.params.seedEndExclusive, "seedEndExclusive") - asInt(chunk.params.seedStart, "seedStart"),
        );
      } else if (task.kind === IMAGE_TILE_INFER_KERNEL_ID) acceptedImageTileInferChunks++;
      else if (task.kind === LOGIT_DIVERGENCE_KERNEL_ID) acceptedLogitDivergenceChunks++;
      else if (task.kind === MICROSCOPY_TILE_SCORE_KERNEL_ID) acceptedMicroscopyTileScoreChunks++;
      else if (task.kind === PREFILL_TOPK_PROBE_KERNEL_ID) acceptedPrefillTopkProbeChunks++;
      else if (task.kind === PUBLIC_ARTIFACT_VERIFY_KERNEL_ID) acceptedPublicArtifactChunks++;
      else if (task.kind === REPLAY_VERIFY_KERNEL_ID) acceptedReplayVerifyChunks++;
      else if (task.kind === SEED_SWEEP_KERNEL_ID) {
        acceptedSeedSweepChunks++;
        acceptedSeedSweepSeeds += Math.max(
          0,
          asInt(chunk.params.seedEndExclusive, "seedEndExclusive") - asInt(chunk.params.seedStart, "seedStart"),
        );
      } else if (task.kind === TENSOR_TILE_KERNEL_ID) {
        acceptedTensorTileChunks++;
        acceptedTensorTileCells += Math.max(
          0,
          asInt(chunk.params.rows, "rows") * asInt(chunk.params.cols, "cols"),
        );
      }
    }
  }
  return {
    acceptedReceipts: receipts.filter((receipt) => receipt.decision === "accepted").length,
    rejectedReceipts: receipts.filter((receipt) => isRejectedDecision(receipt.decision)).length,
    acceptedAssetTileAuditChunks,
    acceptedContactMapTileChunks,
    acceptedContactMapTileCells,
    acceptedEmbeddingTileChunks,
    acceptedExploitSearchChunks,
    acceptedExploitSearchSeeds,
    acceptedImageTileInferChunks,
    acceptedLogitDivergenceChunks,
    acceptedMicroscopyTileScoreChunks,
    acceptedPrefillTopkProbeChunks,
    acceptedPublicArtifactChunks,
    acceptedReplayVerifyChunks,
    acceptedSeedSweepChunks,
    acceptedSeedSweepSeeds,
    acceptedTensorTileChunks,
    acceptedTensorTileCells,
    acceptedWebGpuWitnessReceipts: receipts.filter((receipt) =>
      receipt.kernelId === DEVICE_WITNESS_WEBGPU_KERNEL_ID && receipt.decision === "accepted"
    ).length,
    acceptedWebRtcReceipts: receipts.filter((receipt) =>
      receipt.transport === "webrtc" && receipt.decision === "accepted"
    ).length,
  };
}

function computeScore(breakdown: ComputeScoreBreakdown): number {
  return Math.max(0, Math.round(
    breakdown.acceptedReceipts * 10 +
    breakdown.acceptedAssetTileAuditChunks * 70 +
    breakdown.acceptedContactMapTileChunks * 110 +
    breakdown.acceptedContactMapTileCells * 2 +
    breakdown.acceptedEmbeddingTileChunks * 140 +
    breakdown.acceptedExploitSearchChunks * 85 +
    breakdown.acceptedExploitSearchSeeds * 2 +
    breakdown.acceptedImageTileInferChunks * 90 +
    breakdown.acceptedLogitDivergenceChunks * 135 +
    breakdown.acceptedMicroscopyTileScoreChunks * 95 +
    breakdown.acceptedPrefillTopkProbeChunks * 125 +
    breakdown.acceptedPublicArtifactChunks * 80 +
    breakdown.acceptedReplayVerifyChunks * 120 +
    breakdown.acceptedSeedSweepChunks * 60 +
    breakdown.acceptedSeedSweepSeeds * 3 +
    breakdown.acceptedTensorTileChunks * 100 +
    breakdown.acceptedTensorTileCells * 2 +
    breakdown.acceptedWebGpuWitnessReceipts * 50 +
    breakdown.acceptedWebRtcReceipts * 25 -
    breakdown.rejectedReceipts * 40
  ));
}

function publicArtifactSummary(raw: unknown): {
  matchId?: string;
  artifactHash?: string;
  rulesHash?: string;
  stageHash?: string;
  actionLogHash?: string;
  actionLogSha256?: string;
} {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const artifact = JSON.parse(raw) as {
      matchId?: string;
      artifactHash?: string;
      payload?: {
        matchId?: string;
        artifactHash?: string;
        tuple?: { simConstantsHash?: string };
        integrity?: { stageHash?: string };
      };
      tuple?: { simConstantsHash?: string };
      integrity?: { stageHash?: string };
    };
    return {
      matchId: stringBucket(artifact.matchId ?? artifact.payload?.matchId),
      artifactHash: stringBucket(artifact.artifactHash ?? artifact.payload?.artifactHash),
      rulesHash: stringBucket(artifact.payload?.tuple?.simConstantsHash ?? artifact.tuple?.simConstantsHash),
      stageHash: stringBucket(artifact.payload?.integrity?.stageHash ?? artifact.integrity?.stageHash),
    };
  } catch {
    return {};
  }
}

function replayVerifyArtifactSummary(raw: unknown): {
  matchId?: string;
  artifactHash?: string;
  rulesHash?: string;
  stageHash?: string;
  actionLogHash?: string;
  actionLogSha256?: string;
} {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const artifact = JSON.parse(raw) as {
      match?: { matchId?: string };
      actions?: { hash?: string; sha256?: string };
      integrity?: { stageHash?: string };
      sim?: { constantsHash?: string };
      trust?: { simConstantsHash?: string };
    };
    return {
      matchId: stringBucket(artifact.match?.matchId),
      artifactHash: stringBucket(artifact.actions?.hash),
      rulesHash: stringBucket(artifact.trust?.simConstantsHash ?? artifact.sim?.constantsHash),
      stageHash: stringBucket(artifact.integrity?.stageHash),
      actionLogHash: stringBucket(artifact.actions?.hash),
      actionLogSha256: stringBucket(artifact.actions?.sha256),
    };
  } catch {
    return {};
  }
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map(stringBucket).filter((value): value is string => !!value))).sort();
}

type WorkloadTier = WorkerProfile["allowedWorkloadTier"];

const WORKLOAD_TIER_RANK: Record<WorkloadTier, number> = {
  "observe-only": 0,
  "cpu-light": 1,
  "webgpu-light": 2,
};

function schedulerEligible(worker: WorkerRecord, profile: WorkerProfile, task: ComputeTask): boolean {
  if (!worker.capability.kernels.includes(task.kind)) return false;
  if (!tierSatisfies(profile.allowedWorkloadTier, taskRequiredWorkloadTier(task))) return false;
  return true;
}

function schedulerCandidateScore(profile: WorkerProfile, task: ComputeTask, liveAssignmentCount: number): number {
  let score = profile.trustScore * 100 - liveAssignmentCount * 10;
  score += WORKLOAD_TIER_RANK[profile.allowedWorkloadTier] * 8;
  if (task.kind === PUBLIC_ARTIFACT_VERIFY_KERNEL_ID || task.kind === REPLAY_VERIFY_KERNEL_ID) {
    score += (profile.webrtcDirectSuccessRate ?? 0) * 10;
    score -= (profile.turnRequiredRate ?? 0) * 4;
  }
  if (task.kind === SEED_SWEEP_KERNEL_ID) {
    score += (profile.webgpuCorrectnessScore ?? 0) * 6;
    if (profile.p95KernelMs !== null) score -= Math.min(20, profile.p95KernelMs / 50);
  }
  if (task.kind === TENSOR_TILE_KERNEL_ID) {
    score += (profile.webgpuCorrectnessScore ?? 0) * 14;
    if (profile.p95KernelMs !== null) score -= Math.min(20, profile.p95KernelMs / 40);
  }
  if (isDeviceWitnessTask(task.kind) && profile.acceptedReceipts === 0) score += 15;
  if (profile.recentFailureRate !== null) score -= profile.recentFailureRate * 30;
  return score;
}

function taskRequiredWorkloadTier(task: ComputeTask): WorkloadTier {
  if (
    task.kind === ASSET_TILE_AUDIT_KERNEL_ID ||
    task.kind === EXPLOIT_SEARCH_KERNEL_ID ||
    task.kind === IMAGE_TILE_INFER_KERNEL_ID ||
    task.kind === MICROSCOPY_TILE_SCORE_KERNEL_ID ||
    task.kind === PUBLIC_ARTIFACT_VERIFY_KERNEL_ID ||
    task.kind === REPLAY_VERIFY_KERNEL_ID ||
    task.kind === SEED_SWEEP_KERNEL_ID
  ) {
    return "cpu-light";
  }
  if (
    task.kind === TENSOR_TILE_KERNEL_ID ||
    task.kind === EMBEDDING_TILE_KERNEL_ID ||
    task.kind === PREFILL_TOPK_PROBE_KERNEL_ID ||
    task.kind === CONTACT_MAP_TILE_KERNEL_ID
  ) return "webgpu-light";
  return "observe-only";
}

function isDeviceWitnessTask(kind: TaskKind): boolean {
  return (
    kind === DEVICE_WITNESS_WEBGPU_KERNEL_ID ||
    kind === DEVICE_WITNESS_RENDER_KERNEL_ID ||
    kind === DEVICE_WITNESS_WEBRTC_KERNEL_ID ||
    kind === DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID
  );
}

function tierSatisfies(actual: WorkloadTier, required: WorkloadTier): boolean {
  return WORKLOAD_TIER_RANK[actual] >= WORKLOAD_TIER_RANK[required];
}

function workerTrustScore(input: {
  acceptedReceipts: number;
  rejectedReceipts: number;
  timeoutAssignments: number;
  recentFailureRate: number | null;
  webgpuCorrectnessScore: number | null;
  renderFixtureScore: number | null;
  webrtcDirectSuccessRate: number | null;
}): number {
  let score = 0.45;
  score += Math.min(0.25, input.acceptedReceipts * 0.03);
  score -= Math.min(0.25, input.rejectedReceipts * 0.06);
  score -= Math.min(0.15, input.timeoutAssignments * 0.03);
  if (input.renderFixtureScore !== null) score += input.renderFixtureScore >= 1 ? 0.08 : -0.08;
  if (input.webgpuCorrectnessScore !== null) score += input.webgpuCorrectnessScore >= 1 ? 0.08 : -0.12;
  if (input.webrtcDirectSuccessRate !== null) score += input.webrtcDirectSuccessRate * 0.05;
  if (input.recentFailureRate !== null) score -= input.recentFailureRate * 0.2;
  return clamp01(score);
}

function allowedWorkloadTier(input: {
  cpuReferenceAvailable: boolean;
  webgpuAvailable: boolean;
  webgpuCorrectnessScore: number | null;
  renderFixtureScore: number | null;
  webgpuWitnessReceipts: number;
  renderWitnessReceipts: number;
  p95KernelMs: number | null;
}): WorkerProfile["allowedWorkloadTier"] {
  if (
    input.webgpuAvailable &&
    input.webgpuWitnessReceipts > 0 &&
    input.webgpuCorrectnessScore !== null &&
    input.webgpuCorrectnessScore >= 1 &&
    (input.p95KernelMs === null || input.p95KernelMs < 100)
  ) {
    return "webgpu-light";
  }
  if (
    input.cpuReferenceAvailable ||
    input.webgpuWitnessReceipts > 0 ||
    input.renderWitnessReceipts > 0
  ) {
    return "cpu-light";
  }
  return "observe-only";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isRejectedDecision(decision: ReceiptDecision): boolean {
  return decision !== "pending" && decision !== "accepted";
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return Math.round(sorted[idx] * 100) / 100;
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function ratio(numerator: number, denominator: number, fallback: number | null): number | null {
  if (denominator <= 0) return fallback;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function incFlat(out: Record<string, number>, bucket: string): void {
  const clean = stringBucket(bucket) ?? "other";
  out[clean] = (out[clean] ?? 0) + 1;
}

function receiptTransportSummary(receipts: ExecutionReceipt[], tasks: Map<string, ComputeTask>) {
  const rows = new Map<string, {
    taskKind: string;
    validationMode: string;
    transport: string;
    transfer: string;
    dataChannelBucket: string;
    dataReceiptBucket: string;
    decision: string;
    count: number;
  }>();
  for (const receipt of receipts) {
    const row = {
      taskKind: bucketOrUnknown(tasks.get(receipt.taskId)?.kind),
      validationMode: bucketOrUnknown(receipt.validationMode),
      transport: bucketOrUnknown(receipt.transport),
      transfer: bucketOrUnknown(receipt.adapterInfo?.transfer),
      dataChannelBucket: bucketOrUnknown(receipt.adapterInfo?.dataChannelBucket),
      dataReceiptBucket: bucketOrUnknown(receipt.adapterInfo?.dataReceiptBucket),
      decision: bucketOrUnknown(receipt.decision),
      count: 0,
    };
    const key = [
      row.taskKind,
      row.validationMode,
      row.transport,
      row.transfer,
      row.dataChannelBucket,
      row.dataReceiptBucket,
      row.decision,
    ].join("\t");
    const existing = rows.get(key) ?? row;
    existing.count++;
    rows.set(key, existing);
  }
  return Array.from(rows.values()).sort((a, b) =>
    b.count - a.count ||
    a.taskKind.localeCompare(b.taskKind) ||
    a.transport.localeCompare(b.transport) ||
    a.decision.localeCompare(b.decision)
  );
}

function sanitizeBucketRecord(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) continue;
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string") out[key] = stringBucket(value);
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeConnectivityObservation(
  input: Omit<ConnectivityObservation, "observationId" | "workerId" | "workerSessionId" | "observedAt">,
): Omit<ConnectivityObservation, "observationId" | "workerId" | "workerSessionId" | "observedAt"> {
  return {
    transport: oneOf(input.transport, ["http", "webrtc-local", "webrtc-signaling"], "http"),
    status: oneOf(input.status, ["ok", "timeout", "failed", "unsupported"], "failed"),
    mode: isGovernorMode(input.mode) ? input.mode : undefined,
    browserFamily: stringBucket(input.browserFamily),
    deviceClass: stringBucket(input.deviceClass),
    networkTypeBucket: stringBucket(input.networkTypeBucket),
    downlinkBucket: stringBucket(input.downlinkBucket),
    rttBucket: stringBucket(input.rttBucket),
    httpRttBucket: stringBucket(input.httpRttBucket),
    webrtcOpenMsBucket: stringBucket(input.webrtcOpenMsBucket),
    iceGatherMsBucket: stringBucket(input.iceGatherMsBucket),
    iceHostBucket: stringBucket(input.iceHostBucket),
    iceSrflxBucket: stringBucket(input.iceSrflxBucket),
    iceRelayBucket: stringBucket(input.iceRelayBucket),
    stunSuccessBucket: stringBucket(input.stunSuccessBucket),
    turnNeedBucket: stringBucket(input.turnNeedBucket),
    signalingRttBucket: stringBucket(input.signalingRttBucket),
    dataChannelBucket: stringBucket(input.dataChannelBucket),
    dataWorkBucket: stringBucket(input.dataWorkBucket),
    dataReceiptBucket: stringBucket(input.dataReceiptBucket),
    visibilityBucket: stringBucket(input.visibilityBucket),
    batteryBucket: stringBucket(input.batteryBucket),
    notes: stringBucket(input.notes),
  };
}

function isGovernorMode(value: unknown): value is GovernorMode {
  return value === "quiet" || value === "standard" || value === "after-match";
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function stringBucket(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return undefined;
  return /^[a-z0-9][a-z0-9_.:+/-]{0,63}$/.test(raw) ? raw : "other";
}

function bucketOrUnknown(value: unknown): string {
  return stringBucket(value) ?? "unknown";
}

function trimMapByTime<T>(map: Map<string, T>, max: number, at: (value: T) => number): void {
  if (map.size <= max) return;
  const remove = Array.from(map.entries())
    .sort((a, b) => at(a[1]) - at(b[1]))
    .slice(0, map.size - max);
  for (const [key] of remove) map.delete(key);
}

function inc(out: Record<string, Record<string, number>>, dimension: string, bucket: string): void {
  out[dimension] ??= {};
  out[dimension][bucket] = (out[dimension][bucket] ?? 0) + 1;
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) throw new Error(`invalid ${label}`);
  return n;
}

export function referenceReceiptFields(chunk: Omit<ComputeChunk, "expectedOutputHash"> & { expectedOutputHash?: ContentHash }): Pick<
  ExecutionReceipt,
  "kernelId" | "kernelHash" | "inputHash" | "artifactHash" | "outputHash" | "derived" | "determinismClass" | "validationMode"
> {
  const outputHash = chunk.expectedOutputHash ?? referenceOutputHash(chunk);
  const quorumTask = chunk.kind === EMBEDDING_TILE_KERNEL_ID || chunk.kind === PREFILL_TOPK_PROBE_KERNEL_ID;
  const derived = chunk.kind === DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID
    ? {
      contractVersion: "derived-compute-extension.v0" as const,
      sourceHashes: { [stringParam(chunk.params.sourceId)]: hashParam(chunk.params.sourceHash) },
      bufferRegionHashes: { [stringParam(chunk.params.regionId)]: hashParam(chunk.params.regionHash) },
      producerKernelHashes: { [stringParam(chunk.params.outputId)]: hashParam(chunk.params.producerKernelHash) },
      outputHashes: { [stringParam(chunk.params.outputId)]: outputHash },
      derivedOutputHash: outputHash,
    }
    : undefined;
  return {
    kernelId: chunk.kernelId,
    kernelHash: chunk.kernelHash,
    inputHash: chunk.inputHash,
    artifactHash: chunk.artifactHash,
    outputHash,
    derived,
    determinismClass: quorumTask ? "replicated-quorum" : "bit-exact",
    validationMode: quorumTask ? "quorum" : "expected-hash",
  };
}

export const referencePrimeReceiptFields = referenceReceiptFields;

function referenceOutputHash(chunk: Omit<ComputeChunk, "expectedOutputHash">): ContentHash {
  switch (chunk.kind) {
    case PRIME_SEARCH_KERNEL_ID:
      return runPrimeSearch(chunk.params as unknown as PrimeParams).outputHash;
    case ASSET_TILE_AUDIT_KERNEL_ID:
      return runAssetTileAuditReference({
        sourceId: stringParam(chunk.params.sourceId),
        width: asInt(chunk.params.width, "width"),
        height: asInt(chunk.params.height, "height"),
        rgbaBase64: stringParam(chunk.params.rgbaBase64),
      }).outputHash;
    case DEVICE_WITNESS_WEBGPU_KERNEL_ID:
      return runDeviceWitnessWebGpuReference(chunk.params as { seed: number; count: number }).outputHash;
    case DEVICE_WITNESS_RENDER_KERNEL_ID:
      return runDeviceWitnessRenderReference().outputHash;
    case DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID:
      return runDeviceWitnessDerivedBufferReference(chunk.params as { seed: number; count: number }).outputHash;
    case PUBLIC_ARTIFACT_VERIFY_KERNEL_ID:
      return runPublicArtifactVerify({ artifactJson: stringParam(chunk.params.artifactJson) }).outputHash;
    case REPLAY_VERIFY_KERNEL_ID:
      return runReplayVerify({
        replayArtifactJson: stringParam(chunk.params.replayArtifactJson),
        allowConstantsMismatch: chunk.params.allowConstantsMismatch === true,
      }).outputHash;
    case SEED_SWEEP_KERNEL_ID:
      return runSeedSweep(chunk.params as unknown as Parameters<typeof runSeedSweep>[0]).outputHash;
    case EMBEDDING_TILE_KERNEL_ID:
      return embeddingTilePlaceholderOutputHash(normalizeEmbeddingTileParams({
        modelId: stringParam(chunk.params.modelId),
        queryText: stringParam(chunk.params.queryText),
        documentsJson: stringParam(chunk.params.documentsJson),
        topK: asInt(chunk.params.topK, "topK"),
      }));
    case EXPLOIT_SEARCH_KERNEL_ID:
      return runExploitSearchReference({
        stageId: stringParam(chunk.params.stageId),
        brainA: stringParam(chunk.params.brainA),
        brainB: stringParam(chunk.params.brainB),
        seedStart: asInt(chunk.params.seedStart, "seedStart"),
        seedEndExclusive: asInt(chunk.params.seedEndExclusive, "seedEndExclusive"),
        maxTicks: asInt(chunk.params.maxTicks, "maxTicks"),
        topFindings: asInt(chunk.params.topFindings, "topFindings"),
      }).outputHash;
    case IMAGE_TILE_INFER_KERNEL_ID:
      return runImageTileInferReference({
        sourceId: stringParam(chunk.params.sourceId),
        width: asInt(chunk.params.width, "width"),
        height: asInt(chunk.params.height, "height"),
        rgbaBase64: stringParam(chunk.params.rgbaBase64),
        topK: asInt(chunk.params.topK, "topK"),
      }).outputHash;
    case MICROSCOPY_TILE_SCORE_KERNEL_ID:
      return runMicroscopyTileScoreReference({
        sourceId: stringParam(chunk.params.sourceId),
        width: asInt(chunk.params.width, "width"),
        height: asInt(chunk.params.height, "height"),
        rgbaBase64: stringParam(chunk.params.rgbaBase64),
      }).outputHash;
    case PREFILL_TOPK_PROBE_KERNEL_ID:
      return prefillTopkProbePlaceholderOutputHash(normalizePrefillTopkProbeParams({
        modelId: stringParam(chunk.params.modelId),
        promptText: stringParam(chunk.params.promptText),
        topK: asInt(chunk.params.topK, "topK"),
      }));
    case LOGIT_DIVERGENCE_KERNEL_ID:
      return logitDivergencePlaceholderOutputHash(normalizeLogitDivergenceParams({
        modelId: stringParam(chunk.params.modelId),
        promptText: stringParam(chunk.params.promptText),
        topK: asInt(chunk.params.topK, "topK"),
      }));
    case CONTACT_MAP_TILE_KERNEL_ID:
      return runContactMapTileReference({
        rowResidues: stringParam(chunk.params.rowResidues),
        colResidues: stringParam(chunk.params.colResidues),
        rowStart: asInt(chunk.params.rowStart, "rowStart"),
        colStart: asInt(chunk.params.colStart, "colStart"),
        minSeparation: asInt(chunk.params.minSeparation, "minSeparation"),
      }).outputHash;
    case GENOME_KMER_KERNEL_ID:
      return runGenomeKmerReference({
        sequenceId: stringParam(chunk.params.sequenceId),
        sequence: stringParam(chunk.params.sequence),
        k: asInt(chunk.params.k, "k"),
      }).outputHash;
    default:
      throw new Error(`unsupported reference chunk kind: ${chunk.kind}`);
  }
}
