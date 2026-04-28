// webrtcSignal: tiny signaling server for WebRTC peer pairing. Two peers
// each post their offer/answer/candidates to a shared session doc; both
// sides listen via Firestore onSnapshot to receive the other's payload.
//
// This is the Phase-2 P2P substrate placeholder. Sessions are short-lived
// (TTL 5m) and stored under webrtc/<sessionId>. Anyone can create a
// session; access is gated on knowing the sessionId, which is a
// cryptographically random token returned at creation.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, COLLECTIONS } from "./firestore.js";
import { randomUUID } from "node:crypto";

const REGION = "us-central1";
const SESSION_TTL_MS = 5 * 60_000;

export const webrtcSignal = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 15 },
  async (req) => {
    const op = String(req.data?.op ?? "");
    const firestore = db();
    const now = Date.now();

    if (op === "create") {
      const sessionId = randomUUID();
      await firestore.collection(COLLECTIONS.webrtc).doc(sessionId).set({
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        offer: null,
        answer: null,
        candidatesA: [],
        candidatesB: [],
      });
      return { sessionId, expiresAt: now + SESSION_TTL_MS };
    }

    if (op === "post") {
      const sessionId = String(req.data?.sessionId ?? "");
      const role = String(req.data?.role ?? ""); // "offerer" | "answerer"
      const payload = req.data?.payload;
      if (!sessionId || !payload) throw new HttpsError("invalid-argument", "sessionId+payload required");
      const ref = firestore.collection(COLLECTIONS.webrtc).doc(sessionId);
      const update: Record<string, unknown> = {};
      if (payload.offer) update.offer = payload.offer;
      if (payload.answer) update.answer = payload.answer;
      if (Array.isArray(payload.candidates)) {
        const field = role === "answerer" ? "candidatesB" : "candidatesA";
        update[field] = payload.candidates;
      }
      update.updatedAt = now;
      await ref.set(update, { merge: true });
      return { ok: true };
    }

    throw new HttpsError("invalid-argument", `unknown op: ${op}`);
  },
);
