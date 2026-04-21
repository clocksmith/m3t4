import { applicationDefault, getApps, initializeApp, type AppOptions } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { COMPUTE_COLLECTIONS, type ComputeLabSnapshot } from "./store.js";
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
      capabilityObservations,
      connectivityObservations,
    ] = await Promise.all([
      this.readCollection<ComputeLabSnapshot["workers"][number]>(COMPUTE_COLLECTIONS.workers),
      this.readCollection<ComputeLabSnapshot["sessions"][number]>(COMPUTE_COLLECTIONS.sessions),
      this.readCollection<ComputeLabSnapshot["tasks"][number]>(COMPUTE_COLLECTIONS.tasks),
      this.readCollection<ComputeLabSnapshot["assignments"][number]>(COMPUTE_COLLECTIONS.assignments),
      this.readCollection<ComputeLabSnapshot["receipts"][number]>(COMPUTE_COLLECTIONS.receipts),
      this.readCollection<ComputeLabSnapshot["validations"][number]>(COMPUTE_COLLECTIONS.validations),
      this.readCollection<ComputeLabSnapshot["reputation"][number]>(COMPUTE_COLLECTIONS.reputation),
      this.readCollection<ComputeLabSnapshot["webrtcSessions"][number]>(COMPUTE_COLLECTIONS.webrtcSessions),
      this.readCollection<ComputeLabSnapshot["capabilityObservations"][number]>(COMPUTE_COLLECTIONS.capabilityObservations),
      this.readCollection<ComputeLabSnapshot["connectivityObservations"][number]>(COMPUTE_COLLECTIONS.connectivityObservations),
    ]);
    return {
      workers,
      sessions,
      tasks,
      assignments,
      receipts,
      validations,
      reputation,
      webrtcSessions,
      capabilityObservations,
      connectivityObservations,
    };
  }

  async save(snapshot: ComputeLabSnapshot): Promise<void> {
    const chunks = snapshot.tasks.flatMap((task) => task.chunks);
    const capabilities = snapshot.workers.map((worker) => ({
      workerId: worker.workerId,
      capability: worker.capability,
      lastSeenAt: worker.lastSeenAt,
    }));
    await Promise.all([
      this.replaceCollection(COMPUTE_COLLECTIONS.workers, snapshot.workers, (worker) => worker.workerId),
      this.replaceCollection(COMPUTE_COLLECTIONS.capabilities, capabilities, (capability) => capability.workerId),
      this.replaceCollection(COMPUTE_COLLECTIONS.tasks, snapshot.tasks, (task) => task.taskId),
      this.replaceCollection(COMPUTE_COLLECTIONS.chunks, chunks, (chunk) => chunk.chunkId),
      this.replaceCollection(COMPUTE_COLLECTIONS.assignments, snapshot.assignments, (assignment) => assignment.assignmentId),
      this.replaceCollection(COMPUTE_COLLECTIONS.receipts, snapshot.receipts, (receipt) => receipt.receiptId),
      this.replaceCollection(COMPUTE_COLLECTIONS.validations, snapshot.validations, (validation) => validation.validationId),
      this.replaceCollection(COMPUTE_COLLECTIONS.reputation, snapshot.reputation, (rep) => rep.workerId),
      this.replaceCollection(COMPUTE_COLLECTIONS.webrtcSessions, snapshot.webrtcSessions, (session) => session.sessionId),
      this.replaceCollection(COMPUTE_COLLECTIONS.capabilityObservations, snapshot.capabilityObservations, (obs) => obs.observationId),
      this.replaceCollection(COMPUTE_COLLECTIONS.connectivityObservations, snapshot.connectivityObservations, (obs) => obs.observationId),
    ]);
  }

  private async readCollection<T>(collection: string): Promise<T[]> {
    const snap = await this.firestore.collection(collection).get();
    return snap.docs.map((doc) => doc.data() as T);
  }

  private async replaceCollection<T>(collection: string, records: T[], idFor: (record: T) => string): Promise<void> {
    const ref = this.firestore.collection(collection);
    const current = await ref.get();
    const nextIds = new Set(records.map(idFor));
    let batch = this.firestore.batch();
    let ops = 0;
    const commit = async () => {
      if (ops === 0) return;
      await batch.commit();
      batch = this.firestore.batch();
      ops = 0;
    };
    for (const doc of current.docs) {
      if (!nextIds.has(doc.id)) {
        batch.delete(doc.ref);
        ops++;
        if (ops >= 400) await commit();
      }
    }
    for (const record of records) {
      batch.set(ref.doc(idFor(record)), stripUndefined(record) as FirebaseFirestore.DocumentData);
      ops++;
      if (ops >= 400) await commit();
    }
    await commit();
  }
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
