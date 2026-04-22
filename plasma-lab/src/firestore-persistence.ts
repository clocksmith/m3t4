import { applicationDefault, getApps, initializeApp, type AppOptions } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  COMPUTE_COLLECTIONS,
  ComputeLabStore,
  type Assignment,
  type ComputeLabSnapshot,
  type ComputeTask,
  type ExecutionReceipt,
  type ReputationRecord,
  type ReplayVerificationBadge,
  type WebRtcPairRecord,
  type WebRtcSessionRecord,
  type WorkerRecord,
  type WorkerSession,
} from "./store.js";
import type { ComputeLabPersistence } from "./persistent-store.js";

let configuredDb: Firestore | null = null;

function db(): Firestore {
  if (configuredDb) return configuredDb;
  if (getApps().length === 0) {
    const options: AppOptions = { credential: applicationDefault() };
    if (process.env.PLASMA_LAB_FIRESTORE_PROJECT_ID) {
      options.projectId = process.env.PLASMA_LAB_FIRESTORE_PROJECT_ID;
    }
    initializeApp(options);
  }
  configuredDb = getFirestore();
  configuredDb.settings({ ignoreUndefinedProperties: true });
  return configuredDb;
}

export class FirestoreComputeLabPersistence implements ComputeLabPersistence {
  constructor(private readonly firestore: Firestore = db()) {}

  async load(): Promise<Partial<ComputeLabSnapshot>> {
    const [
      workers,
      sessions,
      tasks,
      assignments,
      receipts,
      validations,
      reputation,
      webrtcSessions,
      webrtcPairs,
      capabilityObservations,
      connectivityObservations,
      control,
    ] = await Promise.all([
      this.readCollection<ComputeLabSnapshot["workers"][number]>(COMPUTE_COLLECTIONS.workers),
      this.readCollection<ComputeLabSnapshot["sessions"][number]>(COMPUTE_COLLECTIONS.sessions),
      this.readCollection<ComputeLabSnapshot["tasks"][number]>(COMPUTE_COLLECTIONS.tasks),
      this.readCollection<ComputeLabSnapshot["assignments"][number]>(COMPUTE_COLLECTIONS.assignments),
      this.readCollection<ComputeLabSnapshot["receipts"][number]>(COMPUTE_COLLECTIONS.receipts),
      this.readCollection<ComputeLabSnapshot["validations"][number]>(COMPUTE_COLLECTIONS.validations),
      this.readCollection<ComputeLabSnapshot["reputation"][number]>(COMPUTE_COLLECTIONS.reputation),
      this.readCollection<ComputeLabSnapshot["webrtcSessions"][number]>(COMPUTE_COLLECTIONS.webrtcSessions),
      this.readCollection<ComputeLabSnapshot["webrtcPairs"][number]>(COMPUTE_COLLECTIONS.webrtcPairs),
      this.readCollection<ComputeLabSnapshot["capabilityObservations"][number]>(COMPUTE_COLLECTIONS.capabilityObservations),
      this.readCollection<ComputeLabSnapshot["connectivityObservations"][number]>(COMPUTE_COLLECTIONS.connectivityObservations),
      this.readCollection<ComputeLabSnapshot["control"]>(COMPUTE_COLLECTIONS.control),
    ]);
    const now = Date.now();
    return {
      control: control[0],
      workers,
      sessions: sessions.filter((session) => session.expiresAt > now),
      tasks,
      assignments,
      receipts,
      validations,
      reputation,
      webrtcSessions: webrtcSessions.filter((session) => session.status !== "closed" && session.expiresAt > now),
      webrtcPairs: webrtcPairs.filter((pair) => retainLoadWebRtcPair(pair, now)),
      capabilityObservations,
      connectivityObservations,
    };
  }

  async save(snapshot: ComputeLabSnapshot): Promise<void> {
    await this.savePatch(snapshot, snapshot);
  }

  async savePatch(patch: Partial<ComputeLabSnapshot>, snapshot: ComputeLabSnapshot): Promise<void> {
    const derived = new ComputeLabStore();
    derived.loadSnapshot(snapshot);
    const tasks = patch.tasks ?? [];
    const workers = patch.workers ?? [];
    const chunks = tasks.flatMap((task) => task.chunks);
    const capabilities = workers.map((worker) => ({
      workerId: worker.workerId,
      capability: worker.capability,
      lastSeenAt: worker.lastSeenAt,
    }));
    const publicStats = derived.publicStats({ suppressSmall: false });
    const writes: Array<Promise<void>> = [];
    if (patch.control) writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.control, [patch.control], () => "latest"));
    if (workers.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.workers, workers, (worker) => worker.workerId, mergeWorker));
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.capabilities, capabilities, (capability) => capability.workerId));
    }
    if (patch.sessions?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.sessions, patch.sessions, (session) => session.workerSessionId, mergeWorkerSession));
    }
    if (tasks.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.tasks, tasks, (task) => task.taskId, mergeTask));
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.chunks, chunks, (chunk) => chunk.chunkId, mergeChunk));
    }
    if (patch.assignments?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.assignments, patch.assignments, (assignment) => assignment.assignmentId, mergeAssignment));
    }
    if (patch.receipts?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.receipts, patch.receipts, (receipt) => receipt.receiptId, mergeReceipt));
    }
    if (patch.validations?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.validations, patch.validations, (validation) => validation.validationId));
    }
    if (patch.reputation?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.reputation, patch.reputation, (rep) => rep.workerId, mergeReputation));
    }
    if (patch.webrtcSessions?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.webrtcSessions, patch.webrtcSessions, (session) => session.sessionId, mergeWebRtcSession));
    }
    if (patch.webrtcPairs?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.webrtcPairs, patch.webrtcPairs, (pair) => pair.pairId, mergeWebRtcPair));
    }
    if (patch.capabilityObservations?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.capabilityObservations, patch.capabilityObservations, (obs) => obs.observationId));
    }
    if (patch.connectivityObservations?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.connectivityObservations, patch.connectivityObservations, (obs) => obs.observationId));
    }
    if (shouldRefreshDerived(patch)) {
      writes.push(
        this.upsertCollection(COMPUTE_COLLECTIONS.workerProfiles, derived.workerProfiles(), (profile) => profile.workerId),
        this.upsertCollection(COMPUTE_COLLECTIONS.deviceClasses, derived.deviceClassProfiles(), (profile) => profile.classId),
        this.upsertCollection(COMPUTE_COLLECTIONS.networkClasses, derived.networkClassProfiles(), (profile) => profile.classId),
        this.upsertCollection(COMPUTE_COLLECTIONS.publicStats, [publicStats], () => "latest"),
        this.upsertCollection(COMPUTE_COLLECTIONS.replayBadges, derived.replayBadges(), (badge) => badge.matchId, mergeReplayBadge),
      );
    }
    await Promise.all(writes);
  }

  private async readCollection<T>(collection: string): Promise<T[]> {
    const snap = await this.firestore.collection(collection).get();
    return snap.docs.map((doc) => doc.data() as T);
  }

  private async upsertCollection<T>(
    collection: string,
    records: T[],
    idFor: (record: T) => string,
    merge?: (current: T, next: T) => T,
  ): Promise<void> {
    const ref = this.firestore.collection(collection);
    let batch = this.firestore.batch();
    let ops = 0;
    const commit = async () => {
      if (ops === 0) return;
      await batch.commit();
      batch = this.firestore.batch();
      ops = 0;
    };
    for (const record of records) {
      const doc = ref.doc(idFor(record));
      const next = merge ? mergeExisting(await doc.get(), record, merge) : record;
      batch.set(doc, stripUndefined(next) as FirebaseFirestore.DocumentData);
      ops++;
      if (ops >= 400) await commit();
    }
    await commit();
  }
}

export function retainLoadWebRtcPair(pair: WebRtcPairRecord, now = Date.now()): boolean {
  return pair.expiresAt > now;
}

function mergeExisting<T>(
  current: FirebaseFirestore.DocumentSnapshot,
  next: T,
  merge: (current: T, next: T) => T,
): T {
  return current.exists ? merge(current.data() as T, next) : next;
}

function shouldRefreshDerived(patch: Partial<ComputeLabSnapshot>): boolean {
  return Boolean(
    patch.workers?.length ||
    patch.tasks?.length ||
    patch.receipts?.length ||
    patch.validations?.length ||
    patch.reputation?.length ||
    patch.capabilityObservations?.length ||
    patch.connectivityObservations?.length
  );
}

function mergeWorker(current: WorkerRecord, next: WorkerRecord): WorkerRecord {
  return next.lastSeenAt >= current.lastSeenAt ? next : current;
}

function mergeWorkerSession(current: WorkerSession, next: WorkerSession): WorkerSession {
  return next.lastSeenAt >= current.lastSeenAt ? { ...current, ...next } : { ...next, ...current };
}

function mergeTask(current: ComputeTask, next: ComputeTask): ComputeTask {
  const chunks = mergeById(current.chunks, next.chunks, (chunk) => chunk.chunkId, mergeChunk);
  const status = current.status === "cancelled" || next.status === "cancelled"
    ? "cancelled"
    : chunks.every((chunk) => chunk.status === "accepted" || chunk.status === "rejected" || chunk.status === "disagreement")
      ? "complete"
      : "running";
  return { ...current, ...next, status, chunks };
}

function mergeChunk(current: ComputeTask["chunks"][number], next: ComputeTask["chunks"][number]): ComputeTask["chunks"][number] {
  return receiptDecisionRank(next.status) >= receiptDecisionRank(current.status) ? next : current;
}

function mergeAssignment(current: Assignment, next: Assignment): Assignment {
  return assignmentStatusRank(next.status) >= assignmentStatusRank(current.status) ? { ...current, ...next } : { ...next, ...current };
}

function mergeReceipt(current: ExecutionReceipt, next: ExecutionReceipt): ExecutionReceipt {
  return receiptDecisionRank(next.decision) >= receiptDecisionRank(current.decision) ? next : current;
}

function mergeReputation(current: ReputationRecord, next: ReputationRecord): ReputationRecord {
  return {
    workerId: next.workerId,
    accepted: Math.max(current.accepted, next.accepted),
    rejected: Math.max(current.rejected, next.rejected),
    timeouts: Math.max(current.timeouts, next.timeouts),
    disagreements: Math.max(current.disagreements, next.disagreements),
  };
}

function mergeWebRtcSession(current: WebRtcSessionRecord, next: WebRtcSessionRecord): WebRtcSessionRecord {
  return {
    ...current,
    ...next,
    status: current.status === "closed" || next.status === "closed" ? "closed" : "open",
    offer: next.offer ?? current.offer,
    answer: next.answer ?? current.answer,
    candidates: mergeById(current.candidates, next.candidates, (candidate) => candidate.candidateId, (_current, candidate) => candidate),
    expiresAt: Math.max(current.expiresAt, next.expiresAt),
  };
}

function mergeWebRtcPair(current: WebRtcPairRecord, next: WebRtcPairRecord): WebRtcPairRecord {
  return {
    ...current,
    ...next,
    status: current.status === "closed" || next.status === "closed"
      ? "closed"
      : current.status === "matched" || next.status === "matched"
        ? "matched"
        : "waiting",
    offererWorkerId: current.offererWorkerId ?? next.offererWorkerId,
    offererSessionId: current.offererSessionId ?? next.offererSessionId,
    answererWorkerId: next.answererWorkerId ?? current.answererWorkerId,
    answererSessionId: next.answererSessionId ?? current.answererSessionId,
    offer: next.offer ?? current.offer,
    answer: next.answer ?? current.answer,
    candidates: mergeById(current.candidates, next.candidates, (candidate) => candidate.candidateId, (_current, candidate) => candidate),
    expiresAt: Math.max(current.expiresAt, next.expiresAt),
  };
}

function mergeReplayBadge(current: ReplayVerificationBadge, next: ReplayVerificationBadge): ReplayVerificationBadge {
  return replayBadgeRank(next.status) >= replayBadgeRank(current.status) ? next : current;
}

function mergeById<T>(current: T[], next: T[], idFor: (item: T) => string, merge: (current: T, next: T) => T): T[] {
  const byId = new Map(current.map((item) => [idFor(item), item]));
  for (const item of next) {
    const id = idFor(item);
    const existing = byId.get(id);
    byId.set(id, existing ? merge(existing, item) : item);
  }
  return Array.from(byId.values());
}

function assignmentStatusRank(status: Assignment["status"]): number {
  return { offered: 0, accepted: 1, receipted: 2, cancelled: 2, timeout: 2 }[status];
}

function receiptDecisionRank(status: string): number {
  if (status === "pending") return 0;
  if (status === "quorum-missing") return 1;
  if (status === "accepted") return 3;
  return 2;
}

function replayBadgeRank(status: ReplayVerificationBadge["status"]): number {
  return { pending: 0, failed: 1, verified: 2 }[status];
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner !== undefined) out[key] = stripUndefined(inner);
  }
  return out as T;
}
