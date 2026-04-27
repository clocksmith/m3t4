#!/usr/bin/env node
// One-shot bulk-cancel of running compute-lab tasks. Reads tasks where
// status == "running" AND status changed before the cutoff, sets each to
// status == "cancelled". Runs via Application Default Credentials.
//
// Usage:
//   PLASMA_LAB_FIRESTORE_PROJECT_ID=m3ta-ai \
//   STALE_BEFORE_HOURS=2 \
//   node plasma-lab/scripts/cancel-stale-tasks.cjs
//
// Defaults: cancels everything currently in `status=running`, batch size 400.

const admin = require("firebase-admin");

const projectId = process.env.PLASMA_LAB_FIRESTORE_PROJECT_ID
  || process.env.GOOGLE_CLOUD_PROJECT
  || "m3ta-ai";
const staleBeforeMs = process.env.STALE_BEFORE_HOURS
  ? Date.now() - Number(process.env.STALE_BEFORE_HOURS) * 3_600_000
  : null;
const dryRun = process.env.DRY_RUN === "1";
const batchSize = 400;

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}
const db = admin.firestore();

(async () => {
  const tasksRef = db.collection("compute_tasks");
  const snap = await tasksRef.where("status", "==", "running").get();
  console.log(`found ${snap.size} running tasks (project=${projectId})`);
  if (snap.empty) return;

  let candidates = snap.docs;
  if (staleBeforeMs !== null) {
    candidates = candidates.filter((doc) => {
      const data = doc.data();
      const stamp = Number(data.updatedAt ?? data.createdAt ?? data.statusUpdatedAt ?? 0);
      return stamp > 0 && stamp < staleBeforeMs;
    });
    console.log(`filtered to ${candidates.length} stale tasks (older than ${new Date(staleBeforeMs).toISOString()})`);
  }
  if (candidates.length === 0) {
    console.log("nothing to cancel");
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] would cancel ${candidates.length} tasks`);
    return;
  }

  const now = Date.now();
  const cancelledMeta = {
    status: "cancelled",
    cancelledAt: now,
    cancelReason: "bulk-cancel-stale-running",
    updatedAt: now,
    statusUpdatedAt: now,
  };

  let i = 0;
  while (i < candidates.length) {
    const slice = candidates.slice(i, i + batchSize);
    const batch = db.batch();
    for (const doc of slice) batch.update(doc.ref, cancelledMeta);
    await batch.commit();
    i += slice.length;
    console.log(`cancelled ${i}/${candidates.length}`);
  }
  console.log("done");
})().catch((e) => {
  console.error("cancel-stale-tasks failed:", e);
  process.exit(1);
});
