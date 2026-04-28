// submitStable: authenticated callable that lets a player submit their
// brain config for a slot. Validates by compiling the brain and writes
// to stables/<userId>.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { compileBrain, type BrainConfig } from "@m3t4/sim";
import { db, COLLECTIONS } from "./firestore.js";

const REGION = "us-central1";
const MAX_SLOTS = 4;

interface SubmitStableInput {
  handle?: string;
  slotIdx: number;
  config: BrainConfig;
  name?: string;
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
      throw new HttpsError("invalid-argument", `brain config invalid: ${e instanceof Error ? e.message : String(e)}`);
    }

    const handle = sanitizeHandle(data.handle ?? auth.token.name ?? auth.uid.slice(0, 12));
    const slotId = `${auth.uid}-${slotIdx}`;
    const slotName = (data.name ?? `slot-${slotIdx}`).slice(0, 32);
    const now = Date.now();

    const firestore = db();
    const ref = firestore.collection(COLLECTIONS.stables).doc(auth.uid);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as StableDoc) : null;
      const slots = existing?.slots ? [...existing.slots] : [];
      const prev = slots[slotIdx];
      const slot: SlotDoc = {
        slotId: prev?.slotId ?? slotId,
        name: slotName,
        config: data.config,
        elo: prev?.elo ?? 1500,
        lastPlayedAt: prev?.lastPlayedAt ?? 0,
        submittedAt: now,
      };
      slots[slotIdx] = slot;
      const next: StableDoc = {
        userId: auth.uid,
        handle,
        slots,
        lastActiveAt: now,
        updatedAt: now,
      };
      tx.set(ref, next, { merge: true });
    });
    logger.info("submitStable", { uid: auth.uid, slotIdx });
    return { ok: true, slotId };
  },
);

function sanitizeHandle(input: string): string {
  return String(input).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20) || "anon";
}

interface SlotDoc {
  slotId: string;
  name: string;
  config: unknown;
  elo: number;
  lastPlayedAt: number;
  submittedAt: number;
}

interface StableDoc {
  userId: string;
  handle: string;
  slots: SlotDoc[];
  lastActiveAt: number;
  updatedAt: number;
}
