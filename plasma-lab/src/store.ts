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
  PUBLIC_ARTIFACT_VERIFY_KERNEL_HASH,
  PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,
  runPublicArtifactVerify,
} from "./kernels/public-artifact-verify.js";
import {
  SEED_SWEEP_KERNEL_HASH,
  SEED_SWEEP_KERNEL_ID,
  runSeedSweep,
} from "./kernels/seed-sweep.js";
import { hashCanonical, randomId, randomToken } from "./plasma/hash.js";
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
  capabilityObservations: "compute_capability_observations",
  connectivityObservations: "compute_connectivity_observations",
  workerProfiles: "compute_worker_profiles",
  deviceClasses: "compute_device_classes",
  networkClasses: "compute_network_classes",
  publicStats: "compute_public_stats",
  replayBadges: "compute_replay_badges",
} as const;

const KNOWN_KERNELS = [
  PRIME_SEARCH_KERNEL_ID,
  DEVICE_WITNESS_WEBGPU_KERNEL_ID,
  DEVICE_WITNESS_RENDER_KERNEL_ID,
  DEVICE_WITNESS_WEBRTC_KERNEL_ID,
  DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
  PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,
  SEED_SWEEP_KERNEL_ID,
];

export interface WorkerRecord {
  workerId: string;
  label?: string;
  capability: WorkerCapability;
  registeredAt: number;
  lastSeenAt: number;
}

export interface WorkerSession {
  workerSessionId: string;
  workerId: string;
  token: string;
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
  params: Record<string, number | string>;
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
  computeMs: number;
  receivedAt: number;
  clientVersion?: string;
  signature?: string;
  decision: ReceiptDecision;
  reason?: string;
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
  allowedWorkloadTier: "observe-only" | "cpu-light" | "webgpu-light";
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

export interface ReplayVerificationBadge {
  matchId: string;
  status: "verified" | "pending" | "failed";
  agreedReceipts: number;
  requiredReceipts: number;
  artifactHash?: string;
  artifactSha256?: string;
  rulesHash?: string;
  stageHash?: string;
  verifiedAt?: number;
  taskId: string;
  chunkId: string;
}

export interface StoreOptions {
  now?: () => number;
  assignmentTimeoutMs?: number;
  workerSessionTtlMs?: number;
  webrtcSessionTtlMs?: number;
  acceptAssignments?: boolean;
}

export interface ComputeLabSnapshot {
  workers: WorkerRecord[];
  sessions: WorkerSession[];
  tasks: ComputeTask[];
  assignments: Assignment[];
  receipts: ExecutionReceipt[];
  validations: ValidationRecord[];
  reputation: ReputationRecord[];
  webrtcSessions: WebRtcSessionRecord[];
  webrtcPairs: WebRtcPairRecord[];
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
  private readonly capabilityObservations = new Map<string, CapabilityObservation>();
  private readonly connectivityObservations = new Map<string, ConnectivityObservation>();
  private readonly now: () => number;
  private readonly assignmentTimeoutMs: number;
  private readonly workerSessionTtlMs: number;
  private readonly webrtcSessionTtlMs: number;
  private acceptAssignmentsFlag: boolean;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.assignmentTimeoutMs = options.assignmentTimeoutMs ?? 60_000;
    this.workerSessionTtlMs = options.workerSessionTtlMs ?? 3_600_000;
    this.webrtcSessionTtlMs = options.webrtcSessionTtlMs ?? 600_000;
    this.acceptAssignmentsFlag = options.acceptAssignments ?? false;
  }

  setAcceptAssignments(value: boolean): void {
    this.acceptAssignmentsFlag = value;
  }

  exportSnapshot(): ComputeLabSnapshot {
    return {
      workers: Array.from(this.workers.values()),
      sessions: Array.from(this.sessions.values()),
      tasks: Array.from(this.tasks.values()),
      assignments: Array.from(this.assignments.values()),
      receipts: Array.from(this.receipts.values()),
      validations: Array.from(this.validations.values()),
      reputation: Array.from(this.reputation.values()),
      webrtcSessions: Array.from(this.webrtcSessions.values()),
      webrtcPairs: Array.from(this.webrtcPairs.values()),
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
    this.capabilityObservations.clear();
    this.connectivityObservations.clear();
    for (const worker of snapshot.workers ?? []) this.workers.set(worker.workerId, worker);
    for (const session of snapshot.sessions ?? []) this.sessions.set(session.workerSessionId, session);
    for (const task of snapshot.tasks ?? []) this.tasks.set(task.taskId, task);
    for (const assignment of snapshot.assignments ?? []) this.assignments.set(assignment.assignmentId, assignment);
    for (const receipt of snapshot.receipts ?? []) this.receipts.set(receipt.receiptId, receipt);
    for (const validation of snapshot.validations ?? []) this.validations.set(validation.validationId, validation);
    for (const rep of snapshot.reputation ?? []) this.reputation.set(rep.workerId, rep);
    for (const session of snapshot.webrtcSessions ?? []) this.webrtcSessions.set(session.sessionId, session);
    for (const pair of snapshot.webrtcPairs ?? []) this.webrtcPairs.set(pair.pairId, pair);
    for (const obs of snapshot.capabilityObservations ?? []) this.capabilityObservations.set(obs.observationId, obs);
    for (const obs of snapshot.connectivityObservations ?? []) this.connectivityObservations.set(obs.observationId, obs);
  }

  registerWorker(input: { label?: string; capability: WorkerCapability }): {
    worker: WorkerRecord;
    session: WorkerSession;
    acceptedKernels: string[];
  } {
    const now = this.now();
    const acceptedKernels = input.capability.kernels.filter((kernel) => KNOWN_KERNELS.includes(kernel));
    const workerId = randomId("cw");
    const worker: WorkerRecord = {
      workerId,
      label: input.label,
      capability: { ...input.capability, kernels: acceptedKernels },
      registeredAt: now,
      lastSeenAt: now,
    };
    this.workers.set(workerId, worker);
    const session = this.createSession(workerId);
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
      },
      chunks,
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
    if (!this.acceptAssignmentsFlag) return null;
    const session = this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
    const worker = this.requireWorker(input.workerId);
    worker.lastSeenAt = this.now();
    session.lastSeenAt = worker.lastSeenAt;
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      if (!worker.capability.kernels.includes(task.kind)) continue;
      for (const chunk of task.chunks) {
        if (chunk.status === "accepted" || chunk.status === "rejected") continue;
        if (this.receiptsFor(chunk.chunkId).some((receipt) => receipt.workerId === worker.workerId)) continue;
        const liveAssignments = this.assignmentsFor(chunk.chunkId)
          .filter((assignment) => assignment.status === "offered" || assignment.status === "accepted");
        if (liveAssignments.length >= task.validationPolicy.minExecutions * 2) continue;
        const assignment: Assignment = {
          assignmentId: randomId("as"),
          assignmentToken: randomToken("atok"),
          taskId: task.taskId,
          chunkId: chunk.chunkId,
          workerId: worker.workerId,
          workerSessionId: session.workerSessionId,
          status: "offered",
          assignedAt: this.now(),
          expiresAt: this.now() + this.assignmentTimeoutMs,
        };
        this.assignments.set(assignment.assignmentId, assignment);
        if (chunk.status === "pending") chunk.status = "pending";
        return { assignment, chunk, task };
      }
    }
    return null;
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
    this.requireSession(input.workerId, input.workerSessionId, input.workerSessionToken);
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
    const task = this.requireTask(input.taskId);
    const chunk = this.requireChunk(input.chunkId);
    const mismatch = receiptMismatch(chunk, input);
    if (mismatch) {
      const receipt = this.makeReceipt(input, mismatch.decision, mismatch.reason);
      this.receipts.set(receipt.receiptId, receipt);
      assignment.status = "receipted";
      this.bumpReputation(input.workerId, "rejected");
      return { receipt };
    }

    if (task.validationPolicy.validationMode === "measurement") {
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
  } {
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
      if (task.kind !== PUBLIC_ARTIFACT_VERIFY_KERNEL_ID) continue;
      for (const chunk of task.chunks) {
        const matchId = String(chunk.params.matchId ?? "");
        if (!matchId) continue;
        const accepted = (validationsByChunk.get(chunk.chunkId) ?? [])
          .filter((validation) => validation.status === "accepted")
          .sort((a, b) => b.recordedAt - a.recordedAt)[0];
        const receipts = this.receiptsFor(chunk.chunkId);
        const parsed = publicArtifactSummary(chunk.params.artifactJson);
        out.push({
          matchId,
          status: accepted ? "verified" : chunk.status === "disagreement" || chunk.status === "rejected" ? "failed" : "pending",
          agreedReceipts: accepted?.acceptedReceiptIds.length ?? receipts.filter((receipt) => receipt.decision === "accepted").length,
          requiredReceipts: task.validationPolicy.minAgreeing,
          artifactHash: String(chunk.params.artifactHash ?? parsed.artifactHash ?? ""),
          artifactSha256: chunk.artifactHash?.value,
          rulesHash: parsed.rulesHash,
          stageHash: parsed.stageHash,
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

  private createSession(workerId: string): WorkerSession {
    const now = this.now();
    const session: WorkerSession = {
      workerSessionId: randomId("cs"),
      workerId,
      token: randomToken("stok"),
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
    return {
      ...input,
      receiptId: randomId("rcpt"),
      receivedAt: this.now(),
      decision,
      reason,
    };
  }

  private evaluateChunk(task: ComputeTask, chunk: ComputeChunk): ValidationRecord | undefined {
    const receipts = this.receiptsFor(chunk.chunkId);
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

  private evaluateMeasurementChunk(task: ComputeTask, chunk: ComputeChunk): ValidationRecord | undefined {
    const receipts = this.receiptsFor(chunk.chunkId);
    const valid = receipts.filter((receipt) => receipt.decision === "pending");
    if (valid.length >= task.validationPolicy.minAgreeing && receipts.length >= task.validationPolicy.minExecutions) {
      for (const receipt of valid) {
        receipt.decision = "accepted";
        this.bumpReputation(receipt.workerId, "accepted");
      }
      chunk.status = "accepted";
      const validation = this.recordValidation(task, chunk, "accepted", receipts, valid, "measurement transcript accepted");
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
    const validation: ValidationRecord = {
      validationId: randomId("val"),
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

function receiptMismatch(
  chunk: ComputeChunk,
  input: Pick<ExecutionReceipt, "kernelId" | "kernelHash" | "inputHash" | "artifactHash" | "outputHash" | "derived">,
): { decision: ReceiptDecision; reason: string } | null {
  if (input.kernelId !== chunk.kernelId || !hashesEqual(input.kernelHash, chunk.kernelHash)) {
    return { decision: "kernel-mismatch", reason: "kernel did not match assignment" };
  }
  if (!hashesEqual(input.inputHash, chunk.inputHash)) {
    return { decision: "input-mismatch", reason: "input hash did not match assignment" };
  }
  if (chunk.artifactHash && (!input.artifactHash || !hashesEqual(input.artifactHash, chunk.artifactHash))) {
    return { decision: "input-mismatch", reason: "artifact hash did not match assignment" };
  }
  if (chunk.kind === DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID) {
    const derived = input.derived;
    const sourceId = stringParam(chunk.params.sourceId);
    const regionId = stringParam(chunk.params.regionId);
    const outputId = stringParam(chunk.params.outputId);
    if (!derived || derived.contractVersion !== "derived-compute-extension.v0") {
      return { decision: "malformed", reason: "derived evidence required" };
    }
    if (!hashesEqual(derived.sourceHashes?.[sourceId], hashParam(chunk.params.sourceHash))) {
      return { decision: "input-mismatch", reason: "derived source hash mismatch" };
    }
    if (!hashesEqual(derived.bufferRegionHashes?.[regionId], hashParam(chunk.params.regionHash))) {
      return { decision: "input-mismatch", reason: "derived buffer region hash mismatch" };
    }
    if (!hashesEqual(derived.producerKernelHashes?.[outputId], hashParam(chunk.params.producerKernelHash))) {
      return { decision: "kernel-mismatch", reason: "derived producer kernel hash mismatch" };
    }
    if (!hashesEqual(derived.outputHashes?.[outputId], input.outputHash)) {
      return { decision: "output-mismatch", reason: "derived output hash mismatch" };
    }
    if (!hashesEqual(derived.derivedOutputHash, input.outputHash)) {
      return { decision: "output-mismatch", reason: "derived output hash mismatch" };
    }
  }
  return null;
}

function hashParam(value: unknown): ContentHash {
  return { algorithm: "sha256", value: stringParam(value) };
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function hashesEqual(a: ContentHash | undefined, b: ContentHash | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.value.toLowerCase() === b.value.toLowerCase();
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
    const tier = allowedWorkloadTier({
      webgpuAvailable,
      webgpuCorrectnessScore,
      renderFixtureScore,
      p95KernelMs,
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
      webrtcDirectSuccessRate: ratio(directSuccess, webrtc.length, null),
      turnRequiredRate: ratio(turnRequired, webrtc.length, null),
      avgKernelMs: average(kernelTimes),
      p95KernelMs,
      avgFrameRegressionMs: null,
      allowedWorkloadTier: tier,
      acceptedReceipts,
      rejectedReceipts,
      timeoutAssignments: workerAssignments.filter((assignment) => assignment.status === "timeout").length,
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
}): PublicComputeStats {
  const profiles = input.suppressed ? [] : input.profiles;
  const kernelTimes = profiles.map((profile) => profile.p95KernelMs).filter(isNumber);
  const accepted = input.receipts.filter((receipt) => receipt.decision === "accepted").length;
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

function publicArtifactSummary(raw: unknown): { artifactHash?: string; rulesHash?: string; stageHash?: string } {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const artifact = JSON.parse(raw) as {
      artifactHash?: string;
      payload?: {
        artifactHash?: string;
        tuple?: { simConstantsHash?: string };
        integrity?: { stageHash?: string };
      };
      tuple?: { simConstantsHash?: string };
      integrity?: { stageHash?: string };
    };
    return {
      artifactHash: stringBucket(artifact.artifactHash ?? artifact.payload?.artifactHash),
      rulesHash: stringBucket(artifact.payload?.tuple?.simConstantsHash ?? artifact.tuple?.simConstantsHash),
      stageHash: stringBucket(artifact.payload?.integrity?.stageHash ?? artifact.integrity?.stageHash),
    };
  } catch {
    return {};
  }
}

function allowedWorkloadTier(input: {
  webgpuAvailable: boolean;
  webgpuCorrectnessScore: number | null;
  renderFixtureScore: number | null;
  p95KernelMs: number | null;
}): WorkerProfile["allowedWorkloadTier"] {
  if (
    input.webgpuAvailable &&
    input.webgpuCorrectnessScore !== null &&
    input.webgpuCorrectnessScore >= 1 &&
    (input.p95KernelMs === null || input.p95KernelMs < 100)
  ) {
    return "webgpu-light";
  }
  if (input.renderFixtureScore !== null && input.renderFixtureScore >= 1) return "cpu-light";
  return "observe-only";
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

export function referenceReceiptFields(chunk: ComputeChunk): Pick<
  ExecutionReceipt,
  "kernelId" | "kernelHash" | "inputHash" | "artifactHash" | "outputHash" | "derived" | "determinismClass" | "validationMode"
> {
  const outputHash = chunk.expectedOutputHash;
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
    determinismClass: "bit-exact",
    validationMode: "expected-hash",
  };
}

export const referencePrimeReceiptFields = referenceReceiptFields;
