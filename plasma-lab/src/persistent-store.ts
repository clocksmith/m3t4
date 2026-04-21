import {
  ComputeLabStore,
  type Assignment,
  type ConnectivityObservation,
  type ComputeLabSnapshot,
  type ComputeTask,
  type ExecutionReceipt,
  type StoreOptions,
  type ValidationRecord,
  type WebRtcSessionRecord,
  type WorkerRecord,
  type WorkerSession,
} from "./store.js";
import type { GovernorMode, WorkerCapability, WorkerRefusalReason } from "./plasma/types.js";

export interface ComputeLabPersistence {
  load(): Promise<Partial<ComputeLabSnapshot>>;
  save(snapshot: ComputeLabSnapshot): Promise<void>;
}

export class PersistentComputeLabStore extends ComputeLabStore {
  private readonly persistence: ComputeLabPersistence;
  private saveChain = Promise.resolve();

  private constructor(options: StoreOptions, persistence: ComputeLabPersistence) {
    super(options);
    this.persistence = persistence;
  }

  static async create(options: StoreOptions, persistence: ComputeLabPersistence): Promise<PersistentComputeLabStore> {
    const store = new PersistentComputeLabStore(options, persistence);
    store.loadSnapshot(await persistence.load());
    return store;
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  setAcceptAssignments(value: boolean): void {
    super.setAcceptAssignments(value);
    this.persist();
  }

  registerWorker(input: { label?: string; capability: WorkerCapability }): {
    worker: WorkerRecord;
    session: WorkerSession;
    acceptedKernels: string[];
  } {
    const out = super.registerWorker(input);
    this.persist();
    return out;
  }

  heartbeat(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    governorMode?: GovernorMode;
  }): WorkerSession {
    const out = super.heartbeat(input);
    this.persist();
    return out;
  }

  updateCapability(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    capability: WorkerCapability;
  }): WorkerRecord {
    const out = super.updateCapability(input);
    this.persist();
    return out;
  }

  submitConnectivityObservation(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    observation: Omit<ConnectivityObservation, "observationId" | "workerId" | "workerSessionId" | "observedAt">;
  }): ConnectivityObservation {
    const out = super.submitConnectivityObservation(input);
    this.persist();
    return out;
  }

  seedPrimeTask(input: {
    start: number;
    endExclusive: number;
    chunkSize: number;
    minExecutions?: number;
    minAgreeing?: number;
  }): ComputeTask {
    const out = super.seedPrimeTask(input);
    this.persist();
    return out;
  }

  seedPublicArtifactVerifyTask(input: {
    matchId: string;
    artifactHash: string;
    artifactSha256: string;
    artifactJson: string;
    minExecutions?: number;
    minAgreeing?: number;
  }): ComputeTask {
    const out = super.seedPublicArtifactVerifyTask(input);
    this.persist();
    return out;
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
    const out = super.seedSeedSweepTask(input);
    this.persist();
    return out;
  }

  assignNext(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
  }): { assignment: Assignment; chunk: ComputeTask["chunks"][number]; task: ComputeTask } | null {
    const out = super.assignNext(input);
    this.persist();
    return out;
  }

  acceptAssignment(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    assignmentId: string;
    assignmentToken: string;
    refusalReason?: WorkerRefusalReason;
  }): Assignment {
    const out = super.acceptAssignment(input);
    this.persist();
    return out;
  }

  submitReceipt(input: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason"> & {
    workerSessionToken: string;
    assignmentToken: string;
  }): { receipt: ExecutionReceipt; validation?: ValidationRecord } {
    const out = super.submitReceipt(input);
    this.persist();
    return out;
  }

  cancelTask(taskId: string): ComputeTask {
    const out = super.cancelTask(taskId);
    this.persist();
    return out;
  }

  createWebRtcSession(): WebRtcSessionRecord {
    const out = super.createWebRtcSession();
    this.persist();
    return out;
  }

  setWebRtcOffer(input: { sessionId: string; token: string; offer: unknown }): WebRtcSessionRecord {
    const out = super.setWebRtcOffer(input);
    this.persist();
    return out;
  }

  setWebRtcAnswer(input: { sessionId: string; token: string; answer: unknown }): WebRtcSessionRecord {
    const out = super.setWebRtcAnswer(input);
    this.persist();
    return out;
  }

  addWebRtcCandidates(input: {
    sessionId: string;
    token: string;
    peerId?: string;
    candidates: unknown[];
  }): WebRtcSessionRecord {
    const out = super.addWebRtcCandidates(input);
    this.persist();
    return out;
  }

  closeWebRtcSession(input: { sessionId: string; token: string }): WebRtcSessionRecord {
    const out = super.closeWebRtcSession(input);
    this.persist();
    return out;
  }

  private persist(): void {
    const snapshot = this.exportSnapshot();
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => this.persistence.save(snapshot))
      .catch((e) => {
        console.error("[plasma-lab] persistence save failed:", e instanceof Error ? e.message : String(e));
      });
  }
}
