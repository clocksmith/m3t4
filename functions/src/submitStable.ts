// submitStable: authenticated callable that lets a player submit their
// brain config for a slot. Validates by compiling the brain, rate-limits
// per uid, optionally enforces handle uniqueness, and writes to
// stables/<userId>.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { compileBrain, type BrainConfig } from "@m3t4/sim";
import { db, COLLECTIONS } from "./firestore.js";
import {
  HANDLE_PATTERN,
  MAX_SLOTS,
  emptyStable,
  isReservedSystemHandle,
  normalizeStableTotals,
  publicStableDoc,
  sanitizeHandle,
  type StableDoc,
  type StableSlotDoc,
} from "./stable-public.js";
import {
  writePublicBotEvent,
  writePublicBotProjection,
} from "./public-bots.js";

const REGION = "us-central1";
// Reject submissions arriving faster than this per uid. Mirrors the
// legacy SUBMIT_RATE_MS env on arena-server (default 30s).
const SUBMIT_RATE_MS = Number(process.env.SUBMIT_RATE_MS ?? 30_000);

interface SubmitStableInput {
  handle?: string;
  slotIdx: number;
  config: BrainConfig;
  name?: string;
  cosmetics?: unknown;
}

export const submitStable = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 30 },
  async (req) => {
    const auth = req.auth;
    if (!auth?.uid) throw new HttpsError("unauthenticated", "sign in required");
    const data = req.data as SubmitStableInput;
    if (!data || typeof data !== "object") throw new HttpsError("invalid-argument", "body required");

    const slotIdx = Number(data.slotIdx);
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= MAX_SLOTS) {
      throw new HttpsError("invalid-argument", `slotIdx must be 0..${MAX_SLOTS - 1}`);
    }
    if (!data.config) throw new HttpsError("invalid-argument", "config required");
    try {
      compileBrain(data.config);
    } catch (e) {
      throw new HttpsError(
        "invalid-argument",
        `brain config invalid: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const requestedHandle = sanitizeHandle(
      data.handle ?? auth.token.name ?? auth.uid.slice(0, 12),
    );
    if (!HANDLE_PATTERN.test(requestedHandle)) {
      throw new HttpsError(
        "invalid-argument",
        "handle must be 3-20 chars, lowercase letters/digits/underscore",
      );
    }
    if (isReservedSystemHandle(requestedHandle)) {
      throw new HttpsError("invalid-argument", "handle reserved for system candidates");
    }

    const slotName = (data.name ?? `slot-${slotIdx}`).slice(0, 32);
    const now = Date.now();

    const firestore = db();
    const stableRef = firestore.collection(COLLECTIONS.stables).doc(auth.uid);
    const publicRef = firestore.collection(COLLECTIONS.publicStables).doc(auth.uid);
    const handleRef = firestore.collection(COLLECTIONS.handles).doc(requestedHandle);

    const result = await firestore.runTransaction(async (tx) => {
      const stableSnap = await tx.get(stableRef);
      const existing = stableSnap.exists ? (stableSnap.data() as StableDoc) : null;

      // Rate limit: reject submissions faster than SUBMIT_RATE_MS for the
      // same slot index.
      if (existing) {
        const prev = existing.slots?.[slotIdx];
        const lastSubmittedAt = prev?.submittedAt ?? 0;
        if (lastSubmittedAt && now - lastSubmittedAt < SUBMIT_RATE_MS) {
          throw new HttpsError(
            "resource-exhausted",
            `please wait ${Math.ceil((SUBMIT_RATE_MS - (now - lastSubmittedAt)) / 1000)}s before re-submitting`,
          );
        }
      }

      // Handle uniqueness. If this uid already owns the handle, fine.
      // Otherwise, the handle must be free.
      const handleSnap = await tx.get(handleRef);
      if (handleSnap.exists) {
        const owner = handleSnap.data() as { userId?: string };
        if (owner.userId && owner.userId !== auth.uid) {
          throw new HttpsError("already-exists", "handle taken");
        }
      }

      // If the user is changing handles, free up the old one.
      const oldHandle = existing?.handle;
      if (oldHandle && oldHandle !== requestedHandle) {
        tx.delete(firestore.collection(COLLECTIONS.handles).doc(oldHandle));
      }

      // Write the new handle index entry.
      tx.set(handleRef, { handle: requestedHandle, userId: auth.uid, updatedAt: now });

      const slots = existing?.slots ? [...existing.slots] : [];
      const prev = slots[slotIdx];
      const eventType = prev?.slotId ? "revised" : "submitted";
      const slot: StableSlotDoc = {
        slotIdx,
        slotId: prev?.slotId ?? `${auth.uid}-${slotIdx}`,
        name: slotName,
        config: data.config,
        elo: prev?.elo ?? 1500,
        peakElo: Math.max(prev?.peakElo ?? prev?.elo ?? 1500, prev?.elo ?? 1500),
        wins: prev?.wins ?? 0,
        losses: prev?.losses ?? 0,
        draws: prev?.draws ?? 0,
        cosmetics: data.cosmetics ?? prev?.cosmetics ?? null,
        lastPlayedAt: prev?.lastPlayedAt ?? 0,
        submittedAt: now,
        rateLockedUntil: now + SUBMIT_RATE_MS,
      };
      slots[slotIdx] = slot;

      const base = existing ?? emptyStable(auth.uid, requestedHandle, now);
      const next: StableDoc = normalizeStableTotals({
        ...base,
        slots,
        lastActiveAt: now,
        updatedAt: now,
        createdAt: existing?.createdAt ?? now,
        userId: auth.uid,
        handle: requestedHandle,
      });
      tx.set(stableRef, next, { merge: true });
      tx.set(publicRef, publicStableDoc(next), { merge: true });
      writePublicBotProjection(tx, firestore, next);
      writePublicBotEvent(tx, firestore, next, slot, eventType, now);
      return { slotId: slot.slotId, handle: requestedHandle };
    });

    logger.info("submitStable", { uid: auth.uid, slotIdx, handle: result.handle });
    return { ok: true, slotId: result.slotId, handle: result.handle };
  },
);
