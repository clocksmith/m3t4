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
import { FieldValue } from "firebase-admin/firestore";

const REGION = "us-central1";
const SESSION_TTL_MS = 5 * 60_000;
const MAX_CANDIDATES_PER_POST = 8;

export const webrtcSignal = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 15 },
  async (req) => {
    const auth = req.auth;
    if (!auth?.uid) throw new HttpsError("unauthenticated", "sign in required");

    const op = String(req.data?.op ?? "");
    const firestore = db();
    const now = Date.now();

    if (op === "create") {
      const sessionId = randomUUID();
      await firestore.collection(COLLECTIONS.webrtc).doc(sessionId).set({
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        createdBy: auth.uid,
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
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "session not found");
      const expiresAt = Number(snap.data()?.expiresAt ?? 0);
      if (expiresAt && expiresAt <= now) {
        throw new HttpsError("deadline-exceeded", "session expired");
      }
      const update: Record<string, unknown> = {};
      if (payload.offer) {
        update.offer = {
          type: String(payload.offer.type ?? ""),
          sdp: String(payload.offer.sdp ?? ""),
          peerId: String(payload.peerId ?? auth.uid),
          target: String(payload.target ?? ""),
          purpose: String(payload.purpose ?? "spectate"),
          postedBy: auth.uid,
          postedAt: now,
        };
      }
      if (payload.answer) {
        update.answer = {
          type: String(payload.answer.type ?? ""),
          sdp: String(payload.answer.sdp ?? ""),
          peerId: String(payload.peerId ?? auth.uid),
          postedBy: auth.uid,
          postedAt: now,
        };
      }
      if (Array.isArray(payload.candidates)) {
        const field = role === "answerer" ? "candidatesB" : "candidatesA";
        const candidates = payload.candidates
          .slice(0, MAX_CANDIDATES_PER_POST)
          .map((candidate: unknown) => sanitizeCandidate(candidate))
          .filter((candidate: unknown) => candidate !== null);
        if (candidates.length > 0) {
          update[field] = FieldValue.arrayUnion(...candidates);
        }
      }
      update.updatedAt = now;
      await ref.set(update, { merge: true });
      return { ok: true };
    }

    throw new HttpsError("invalid-argument", `unknown op: ${op}`);
  },
);

function sanitizeCandidate(candidate: unknown): Record<string, unknown> | null {
  if (!candidate || typeof candidate !== "object") return null;
  const c = candidate as Record<string, unknown>;
  const candidateLine = String(c.candidate ?? "");
  if (!candidateLine || candidateLine.length > 4096) return null;
  return {
    candidate: candidateLine,
    sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null,
    sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null,
    usernameFragment: typeof c.usernameFragment === "string" ? c.usernameFragment : null,
  };
}
