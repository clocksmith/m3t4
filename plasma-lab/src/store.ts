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
  capabilityObservations: "compute_capability_observations",
  connectivityObservations: "compute_connectivity_observations",
} as const;

const KNOWN_KERNELS = [
  PRIME_SEARCH_KERNEL_ID,
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

  dashboard() {
    const assignments = Array.from(this.assignments.values());
    const receipts = Array.from(this.receipts.values());
    const validations = Array.from(this.validations.values());
    const workers = Array.from(this.workers.values());
    return {
      ...this.summary(),
      capabilityMap: capabilityMap(workers),
      capabilityObservationMap: this.publicCapabilityMap().map,
      connectivityMap: this.publicConnectivityMap().map,
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
  input: Pick<ExecutionReceipt, "kernelId" | "kernelHash" | "inputHash" | "artifactHash">,
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
  return null;
}

function hashesEqual(a: ContentHash | undefined, b: ContentHash | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.value.toLowerCase() === b.value.toLowerCase();
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
    inc(out, "visibilityBucket", bucketOrUnknown(observation.visibilityBucket));
    inc(out, "batteryBucket", bucketOrUnknown(observation.batteryBucket));
  }
  return out;
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
  "kernelId" | "kernelHash" | "inputHash" | "artifactHash" | "outputHash" | "determinismClass" | "validationMode"
> {
  return {
    kernelId: chunk.kernelId,
    kernelHash: chunk.kernelHash,
    inputHash: chunk.inputHash,
    artifactHash: chunk.artifactHash,
    outputHash: chunk.expectedOutputHash,
    determinismClass: "bit-exact",
    validationMode: "expected-hash",
  };
}

export const referencePrimeReceiptFields = referenceReceiptFields;
