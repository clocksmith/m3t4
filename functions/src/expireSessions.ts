// expireSessions: scheduled cleanup of expired webrtc/<sessionId> docs
// and stale meshSessions/<matchId>/peers/<peerId> entries. Cheap because
// it batches deletions and only fires every 10 minutes.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { db } from "./firestore.js";

const REGION = "us-central1";
const MAX_BATCH = 400;
// Mesh peer entries are considered stale if their lastSeenAt is older
// than this. Keep a generous buffer: spectators on flaky connections
// shouldn't be evicted on a single missed heartbeat.
const PEER_STALE_MS = Number(process.env.MESH_PEER_STALE_MS ?? 90_000);
const COMPUTE_PEER_STALE_MS = Number(process.env.COMPUTE_PEER_STALE_MS ?? 90_000);

export const expireSessions = onSchedule(
  { region: REGION, schedule: "every 10 minutes", memory: "256MiB", timeoutSeconds: 60 },
  async () => {
    const firestore = db();
    const now = Date.now();
    let deletedSignaling = 0;
    let deletedPeers = 0;

    // Drop expired webrtc/<sessionId> docs.
    try {
      const expired = await firestore
        .collection("webrtc")
        .where("expiresAt", "<=", now)
        .limit(MAX_BATCH)
        .get();
      if (!expired.empty) {
        const batch = firestore.batch();
        expired.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        deletedSignaling = expired.size;
      }
    } catch (e) {
      logger.warn("expireSessions: webrtc cleanup failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Drop stale mesh peer entries. Uses a collection-group query so we
    // catch peers across all matchIds in one pass.
    try {
      const cutoff = now - PEER_STALE_MS;
      const stale = await firestore
        .collectionGroup("peers")
        .where("lastSeenAt", "<=", cutoff)
        .limit(MAX_BATCH)
        .get();
      if (!stale.empty) {
        const batch = firestore.batch();
        stale.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        deletedPeers = stale.size;
      }
    } catch (e) {
      logger.warn("expireSessions: mesh-peer cleanup failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (deletedSignaling > 0 || deletedPeers > 0) {
      logger.info("expireSessions cleanup", { deletedSignaling, deletedPeers });
    }

    try {
      const cutoff = now - COMPUTE_PEER_STALE_MS;
      const stale = await firestore
        .collection("compute_peer_presence")
        .where("lastSeenAt", "<=", cutoff)
        .limit(MAX_BATCH)
        .get();
      if (!stale.empty) {
        const batch = firestore.batch();
        stale.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        logger.info("expireSessions compute-peer cleanup", { deletedComputePeers: stale.size });
      }
    } catch (e) {
      logger.warn("expireSessions: compute-peer cleanup failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
);
