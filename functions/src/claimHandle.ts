// claimHandle: authenticated callable for reserving or changing a public
// handle without installing a bot slot. submitStable also enforces handle
// ownership, so this is primarily for the roster/profile UX.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { db, COLLECTIONS } from "./firestore.js";
import {
  HANDLE_PATTERN,
  emptyStable,
  normalizeStableTotals,
  publicStableDoc,
  sanitizeHandle,
  type StableDoc,
} from "./stable-public.js";

const REGION = "us-central1";

export const claimHandle = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 30 },
  async (req) => {
    const auth = req.auth;
    if (!auth?.uid) throw new HttpsError("unauthenticated", "sign in required");

    const handle = sanitizeHandle(String(req.data?.handle ?? ""));
    if (!HANDLE_PATTERN.test(handle)) {
      throw new HttpsError(
        "invalid-argument",
        "handle must be 3-20 chars, lowercase letters/digits/underscore",
      );
    }

    const firestore = db();
    const now = Date.now();
    const stableRef = firestore.collection(COLLECTIONS.stables).doc(auth.uid);
    const publicRef = firestore.collection(COLLECTIONS.publicStables).doc(auth.uid);
    const handleRef = firestore.collection(COLLECTIONS.handles).doc(handle);

    await firestore.runTransaction(async (tx) => {
      const stableSnap = await tx.get(stableRef);
      const handleSnap = await tx.get(handleRef);
      if (handleSnap.exists) {
        const owner = handleSnap.data() as { userId?: string };
        if (owner.userId && owner.userId !== auth.uid) {
          throw new HttpsError("already-exists", "handle taken");
        }
      }

      const existing = stableSnap.exists ? (stableSnap.data() as StableDoc) : null;
      const oldHandle = existing?.handle;
      if (oldHandle && oldHandle !== handle) {
        tx.delete(firestore.collection(COLLECTIONS.handles).doc(oldHandle));
      }

      const next = normalizeStableTotals({
        ...(existing ?? emptyStable(auth.uid, handle, now)),
        userId: auth.uid,
        handle,
        lastActiveAt: now,
        updatedAt: now,
        createdAt: existing?.createdAt ?? now,
      });

      tx.set(handleRef, { handle, userId: auth.uid, updatedAt: now });
      tx.set(stableRef, next, { merge: true });
      tx.set(publicRef, publicStableDoc(next), { merge: true });
    });

    logger.info("claimHandle", { uid: auth.uid, handle });
    return { ok: true, handle };
  },
);
