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
  type ReceiptLogEntry,
  type ReceiptLogSegment,
  type ReplayVerificationBadge,
  type WebRtcPairRecord,
  type WebRtcSessionRecord,
  type WorkerRecord,
  type WorkerSession,
} from "./store.js";
import { PUBLIC_ARTIFACT_VERIFY_KERNEL_ID } from "./kernels/public-artifact-verify.js";
import { REPLAY_VERIFY_KERNEL_ID } from "./kernels/replay-verify.js";
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
      peerSubassignments,
      capabilityObservations,
      connectivityObservations,
      receiptLogEntries,
      receiptLogSegments,
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
      this.readCollection<ComputeLabSnapshot["peerSubassignments"][number]>(COMPUTE_COLLECTIONS.peerSubassignments),
      this.readCollection<ComputeLabSnapshot["capabilityObservations"][number]>(COMPUTE_COLLECTIONS.capabilityObservations),
      this.readCollection<ComputeLabSnapshot["connectivityObservations"][number]>(COMPUTE_COLLECTIONS.connectivityObservations),
      this.readCollection<ComputeLabSnapshot["receiptLogEntries"][number]>(COMPUTE_COLLECTIONS.receiptLogEntries),
      this.readCollection<ComputeLabSnapshot["receiptLogSegments"][number]>(COMPUTE_COLLECTIONS.receiptLogSegments),
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
      peerSubassignments: peerSubassignments.filter((subassignment) => subassignment.expiresAt > now || subassignment.status === "accepted"),
      capabilityObservations,
      connectivityObservations,
      receiptLogEntries,
      receiptLogSegments,
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
    if (patch.peerSubassignments?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.peerSubassignments, patch.peerSubassignments, (subassignment) => subassignment.peerAssignmentId));
    }
    if (patch.capabilityObservations?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.capabilityObservations, patch.capabilityObservations, (obs) => obs.observationId));
    }
    if (patch.connectivityObservations?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.connectivityObservations, patch.connectivityObservations, (obs) => obs.observationId));
    }
    if (patch.receiptLogEntries?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.receiptLogEntries, patch.receiptLogEntries, (entry) => entry.entryId, mergeReceiptLogEntry));
    }
    if (patch.receiptLogSegments?.length) {
      writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.receiptLogSegments, patch.receiptLogSegments, (segment) => segment.segmentId, mergeReceiptLogSegment));
    }
    if (shouldRefreshDerived(patch)) {
      // Narrow the per-entity derived collections to only the workers/matches
      // the patch actually touches. publicStats is a single doc; device/network
      // class profiles are small-cardinality buckets. Full workerProfiles
      // rewrite only happens when validations/tasks arrive, where correctness
      // is worth the cost.
      const affectedWorkers = affectedWorkerIds(patch, snapshot);
      const affectedMatches = affectedMatchIds(patch, snapshot);
      const narrowWorkerProfiles = canNarrowWorkerProfiles(patch);
      const workerProfiles = narrowWorkerProfiles
        ? derived.workerProfiles().filter((profile) => affectedWorkers.has(profile.workerId))
        : derived.workerProfiles();
      const replayBadges = derived.replayBadges().filter((badge) => affectedMatches.has(badge.matchId));
      if (workerProfiles.length) {
        writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.workerProfiles, workerProfiles, (profile) => profile.workerId));
      }
      writes.push(
        this.upsertCollection(COMPUTE_COLLECTIONS.deviceClasses, derived.deviceClassProfiles(), (profile) => profile.classId),
        this.upsertCollection(COMPUTE_COLLECTIONS.networkClasses, derived.networkClassProfiles(), (profile) => profile.classId),
        this.upsertCollection(COMPUTE_COLLECTIONS.publicStats, [publicStats], () => "latest"),
      );
      if (replayBadges.length) {
        writes.push(this.upsertCollection(COMPUTE_COLLECTIONS.replayBadges, replayBadges, (badge) => badge.matchId, mergeReplayBadge));
      }
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
    patch.tasks?.length ||
    patch.receipts?.length ||
    patch.validations?.length ||
    patch.reputation?.length ||
    patch.capabilityObservations?.length ||
    patch.connectivityObservations?.length
  );
}

function canNarrowWorkerProfiles(patch: Partial<ComputeLabSnapshot>): boolean {
  // Validations flip receipt decisions and can change profiles for workers
  // not named in the patch. Task patches can introduce new chunks whose
  // validation state affects many workers. In both cases, fall back to a
  // full workerProfiles rewrite for correctness. Everything else (heartbeats,
  // receipts, reputation, observations) carries its own workerId and can
  // narrow safely.
  return !patch.validations?.length && !patch.tasks?.length;
}

function affectedWorkerIds(
  patch: Partial<ComputeLabSnapshot>,
  snapshot: ComputeLabSnapshot,
): Set<string> {
  const ids = new Set<string>();
  for (const worker of patch.workers ?? []) ids.add(worker.workerId);
  for (const session of patch.sessions ?? []) ids.add(session.workerId);
  for (const assignment of patch.assignments ?? []) ids.add(assignment.workerId);
  for (const receipt of patch.receipts ?? []) ids.add(receipt.workerId);
  for (const rep of patch.reputation ?? []) ids.add(rep.workerId);
  for (const obs of patch.capabilityObservations ?? []) ids.add(obs.workerId);
  for (const obs of patch.connectivityObservations ?? []) ids.add(obs.workerId);
  // Validations don't carry workerId directly, but reference receipts.
  if (patch.validations?.length) {
    const receiptIds = new Set<string>();
    for (const validation of patch.validations) {
      for (const id of validation.comparedReceiptIds ?? []) receiptIds.add(id);
      for (const id of validation.acceptedReceiptIds ?? []) receiptIds.add(id);
    }
    if (receiptIds.size) {
      for (const receipt of snapshot.receipts) {
        if (receiptIds.has(receipt.receiptId)) ids.add(receipt.workerId);
      }
    }
  }
  return ids;
}

function affectedMatchIds(
  patch: Partial<ComputeLabSnapshot>,
  snapshot: ComputeLabSnapshot,
): Set<string> {
  const ids = new Set<string>();
  const addFromTask = (task: ComputeTask) => {
    if (task.kind !== PUBLIC_ARTIFACT_VERIFY_KERNEL_ID && task.kind !== REPLAY_VERIFY_KERNEL_ID) return;
    for (const chunk of task.chunks) {
      const matchId = String(chunk.params?.matchId ?? "");
      if (matchId) ids.add(matchId);
    }
  };
  for (const task of patch.tasks ?? []) addFromTask(task);
  const touchedChunks = new Set<string>();
  for (const receipt of patch.receipts ?? []) touchedChunks.add(receipt.chunkId);
  for (const validation of patch.validations ?? []) touchedChunks.add(validation.chunkId);
  if (touchedChunks.size) {
    for (const task of snapshot.tasks) {
      if (task.kind !== PUBLIC_ARTIFACT_VERIFY_KERNEL_ID && task.kind !== REPLAY_VERIFY_KERNEL_ID) continue;
      for (const chunk of task.chunks) {
        if (!touchedChunks.has(chunk.chunkId)) continue;
        const matchId = String(chunk.params?.matchId ?? "");
        if (matchId) ids.add(matchId);
      }
    }
  }
  return ids;
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

function mergeReceiptLogEntry(current: ReceiptLogEntry, next: ReceiptLogEntry): ReceiptLogEntry {
  return {
    ...current,
    ...next,
    entryHash: current.entryHash,
    segmentId: next.segmentId ?? current.segmentId,
  };
}

function mergeReceiptLogSegment(current: ReceiptLogSegment, next: ReceiptLogSegment): ReceiptLogSegment {
  return current.segmentHash.value === next.segmentHash.value ? current : next;
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
