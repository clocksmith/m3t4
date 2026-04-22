import type { JsonWebKey } from "node:crypto";
import {
  ComputeLabStore,
  type Assignment,
  type ConnectivityObservation,
  type ComputeLabSnapshot,
  type ComputeTask,
  type ExecutionReceipt,
  type StoreOptions,
  type ValidationRecord,
  type WebRtcPairRecord,
  type WebRtcSessionRecord,
  type WorkerRecord,
  type WorkerSession,
} from "./store.js";
import type { GovernorMode, WorkerCapability, WorkerRefusalReason } from "./plasma/types.js";

export interface ComputeLabPersistence {
  load(): Promise<Partial<ComputeLabSnapshot>>;
  save(snapshot: ComputeLabSnapshot): Promise<void>;
  savePatch?(patch: Partial<ComputeLabSnapshot>, snapshot: ComputeLabSnapshot): Promise<void>;
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

  async refresh(): Promise<void> {
    await this.flush();
    this.loadSnapshot(await this.persistence.load());
    const validations = this.reconcilePendingValidations();
    if (validations.length) {
      await this.persistReconciledValidations(validations);
    }
  }

  setAcceptAssignments(value: boolean, durationMs?: number): void {
    super.setAcceptAssignments(value, durationMs);
    this.persist((snapshot) => ({ control: snapshot.control }));
  }

  registerWorker(input: { label?: string; capability: WorkerCapability; signingPublicKey?: JsonWebKey }): {
    worker: WorkerRecord;
    session: WorkerSession;
    acceptedKernels: string[];
  } {
    const out = super.registerWorker(input);
    this.persist((snapshot) => ({
      workers: [out.worker],
      sessions: [out.session],
      capabilityObservations: snapshot.capabilityObservations,
      reputation: snapshot.reputation.filter((rep) => rep.workerId === out.worker.workerId),
    }));
    return out;
  }

  heartbeat(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    governorMode?: GovernorMode;
  }): WorkerSession {
    const out = super.heartbeat(input);
    this.persist((snapshot) => ({
      workers: snapshot.workers.filter((worker) => worker.workerId === input.workerId),
      sessions: [out],
    }));
    return out;
  }

  updateCapability(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    capability: WorkerCapability;
  }): WorkerRecord {
    const out = super.updateCapability(input);
    this.persist((snapshot) => ({
      workers: [out],
      capabilityObservations: snapshot.capabilityObservations,
    }));
    return out;
  }

  submitConnectivityObservation(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
    observation: Omit<ConnectivityObservation, "observationId" | "workerId" | "workerSessionId" | "observedAt">;
  }): ConnectivityObservation {
    const out = super.submitConnectivityObservation(input);
    this.persist(() => ({ connectivityObservations: [out] }));
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
    this.persist(() => ({ tasks: [out] }));
    return out;
  }

  seedDeviceWitnessWebGpuTask(input: {
    seed?: number;
    count?: number;
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const out = super.seedDeviceWitnessWebGpuTask(input);
    this.persist(() => ({ tasks: [out] }));
    return out;
  }

  seedDeviceWitnessRenderTask(input: {
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const out = super.seedDeviceWitnessRenderTask(input);
    this.persist(() => ({ tasks: [out] }));
    return out;
  }

  seedDeviceWitnessDerivedBufferTask(input: {
    seed?: number;
    count?: number;
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const out = super.seedDeviceWitnessDerivedBufferTask(input);
    this.persist(() => ({ tasks: [out] }));
    return out;
  }

  seedDeviceWitnessWebRtcTask(input: {
    timeoutMs?: number;
    minExecutions?: number;
    minAgreeing?: number;
  } = {}): ComputeTask {
    const out = super.seedDeviceWitnessWebRtcTask(input);
    this.persist(() => ({ tasks: [out] }));
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
    this.persist(() => ({ tasks: [out] }));
    return out;
  }

  seedReplayVerifyTask(input: {
    replayArtifactJson: string;
    artifactSha256?: string;
    allowConstantsMismatch?: boolean;
    minExecutions?: number;
    minAgreeing?: number;
  }): ComputeTask {
    const out = super.seedReplayVerifyTask(input);
    this.persist(() => ({ tasks: [out] }));
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
    this.persist(() => ({ tasks: [out] }));
    return out;
  }

  assignNext(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
  }): { assignment: Assignment; chunk: ComputeTask["chunks"][number]; task: ComputeTask } | null {
    const out = super.assignNext(input);
    this.persist((snapshot) => ({
      workers: snapshot.workers.filter((worker) => worker.workerId === input.workerId),
      sessions: snapshot.sessions.filter((session) => session.workerSessionId === input.workerSessionId),
      assignments: out ? [out.assignment] : [],
      tasks: out ? [out.task] : [],
    }));
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
    this.persist(() => ({ assignments: [out] }));
    return out;
  }

  submitReceipt(input: Omit<ExecutionReceipt, "receiptId" | "receivedAt" | "decision" | "reason"> & {
    workerSessionToken: string;
    assignmentToken: string;
  }): { receipt: ExecutionReceipt; validation?: ValidationRecord } {
    const out = super.submitReceipt(input);
    this.persist((snapshot) => {
      const receiptIds = new Set([out.receipt.receiptId, ...(out.validation?.comparedReceiptIds ?? [])]);
      const receipts = snapshot.receipts.filter((receipt) => receiptIds.has(receipt.receiptId));
      const workerIds = new Set(receipts.map((receipt) => receipt.workerId));
      return {
        assignments: snapshot.assignments.filter((assignment) => assignment.assignmentId === input.assignmentId),
        receipts,
        validations: out.validation ? [out.validation] : [],
        reputation: snapshot.reputation.filter((rep) => workerIds.has(rep.workerId)),
        tasks: snapshot.tasks.filter((task) => task.taskId === input.taskId),
      };
    });
    return out;
  }

  cancelTask(taskId: string): ComputeTask {
    const out = super.cancelTask(taskId);
    this.persist(() => ({ tasks: [out] }));
    return out;
  }

  createWebRtcSession(): WebRtcSessionRecord {
    const out = super.createWebRtcSession();
    this.persist(() => ({ webrtcSessions: [out] }));
    return out;
  }

  setWebRtcOffer(input: { sessionId: string; token: string; offer: unknown }): WebRtcSessionRecord {
    const out = super.setWebRtcOffer(input);
    this.persist(() => ({ webrtcSessions: [out] }));
    return out;
  }

  setWebRtcAnswer(input: { sessionId: string; token: string; answer: unknown }): WebRtcSessionRecord {
    const out = super.setWebRtcAnswer(input);
    this.persist(() => ({ webrtcSessions: [out] }));
    return out;
  }

  addWebRtcCandidates(input: {
    sessionId: string;
    token: string;
    peerId?: string;
    candidates: unknown[];
  }): WebRtcSessionRecord {
    const out = super.addWebRtcCandidates(input);
    this.persist(() => ({ webrtcSessions: [out] }));
    return out;
  }

  closeWebRtcSession(input: { sessionId: string; token: string }): WebRtcSessionRecord {
    const out = super.closeWebRtcSession(input);
    this.persist(() => ({ webrtcSessions: [out] }));
    return out;
  }

  joinWebRtcPair(input: {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
  }): { pair: WebRtcPairRecord; role: "offerer" | "answerer" } {
    const out = super.joinWebRtcPair(input);
    this.persist(() => ({ webrtcPairs: [out.pair] }));
    return out;
  }

  setWebRtcPairOffer(input: { pairId: string; token: string; offer: unknown }): WebRtcPairRecord {
    const out = super.setWebRtcPairOffer(input);
    this.persist(() => ({ webrtcPairs: [out] }));
    return out;
  }

  setWebRtcPairAnswer(input: { pairId: string; token: string; answer: unknown }): WebRtcPairRecord {
    const out = super.setWebRtcPairAnswer(input);
    this.persist(() => ({ webrtcPairs: [out] }));
    return out;
  }

  addWebRtcPairCandidates(input: {
    pairId: string;
    token: string;
    peerId?: string;
    candidates: unknown[];
  }): WebRtcPairRecord {
    const out = super.addWebRtcPairCandidates(input);
    this.persist(() => ({ webrtcPairs: [out] }));
    return out;
  }

  closeWebRtcPair(input: { pairId: string; token: string }): WebRtcPairRecord {
    const out = super.closeWebRtcPair(input);
    this.persist(() => ({ webrtcPairs: [out] }));
    return out;
  }

  private persist(patchFor?: (snapshot: ComputeLabSnapshot) => Partial<ComputeLabSnapshot>): void {
    const snapshot = this.exportSnapshot();
    const patch = patchFor?.(snapshot);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => patch && this.persistence.savePatch
        ? this.persistence.savePatch(patch, snapshot)
        : this.persistence.save(snapshot))
      .catch((e) => {
        console.error("[plasma-lab] persistence save failed:", e instanceof Error ? e.message : String(e));
      });
  }

  private async persistReconciledValidations(validations: ValidationRecord[]): Promise<void> {
    const snapshot = this.exportSnapshot();
    const taskIds = new Set(validations.map((validation) => validation.taskId));
    const receiptIds = new Set(validations.flatMap((validation) => validation.comparedReceiptIds));
    const workerIds = new Set(snapshot.receipts
      .filter((receipt) => receiptIds.has(receipt.receiptId))
      .map((receipt) => receipt.workerId));
    const patch: Partial<ComputeLabSnapshot> = {
      tasks: snapshot.tasks.filter((task) => taskIds.has(task.taskId)),
      receipts: snapshot.receipts.filter((receipt) => receiptIds.has(receipt.receiptId)),
      validations,
      reputation: snapshot.reputation.filter((rep) => workerIds.has(rep.workerId)),
    };
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => this.persistence.savePatch
        ? this.persistence.savePatch(patch, snapshot)
        : this.persistence.save(snapshot))
      .catch((e) => {
        console.error("[plasma-lab] persistence save failed:", e instanceof Error ? e.message : String(e));
      });
    await this.flush();
  }
}
