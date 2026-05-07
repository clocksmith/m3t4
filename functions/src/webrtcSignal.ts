// webrtcSignal: tiny signaling server for WebRTC peer pairing. Two peers
// each post their offer/answer/candidates to a shared session doc; both
// sides listen via Firestore onSnapshot to receive the other's payload.
//
// This is the Phase-2 P2P substrate placeholder. Sessions are short-lived
// (TTL 5m) and stored under webrtc/<sessionId>. Anyone can create a
// session; access is gated on knowing the sessionId, which is a
// cryptographically random token returned at creation.
//
// Spectator extension: once the offerer/answerer pair links their data
// channel, subsequent joiners visiting /duel?join=<id> detect the
// player slot is taken (data.answer.sdp present) and switch to
// spectator mode. The host then mirrors its authoritative frame feed
// to data.spectatorFrame via op="postFrame" (~10fps); spectators read
// the session doc directly via Firestore SDK and render the latest
// frame. Match init (seed/stageId/cosmetics) ships through the same
// op as data.spectatorInit so a late spectator gets the parameters
// it needs to render the same world as the players.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, COLLECTIONS } from "./firestore.js";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

const REGION = "us-central1";
const SESSION_TTL_MS = 5 * 60_000;
const MAX_CANDIDATES_PER_POST = 8;
const SPECTATOR_FRAME_MAX_BYTES = 4096;

export const webrtcSignal = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 15, invoker: "public" },
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
        if (snap.data()?.answer?.sdp && snap.data()?.answer?.postedBy !== auth.uid) {
          throw new HttpsError("failed-precondition", "player slot already taken");
        }
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

    if (op === "state") {
      const sessionId = String(req.data?.sessionId ?? "");
      if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required");
      const snap = await firestore.collection(COLLECTIONS.webrtc).doc(sessionId).get();
      if (!snap.exists) throw new HttpsError("not-found", "session not found");
      const data = snap.data() ?? {};
      const expiresAt = Number(data.expiresAt ?? 0);
      const expired = expiresAt > 0 && expiresAt <= now;
      const spectatorIds = data.spectators && typeof data.spectators === "object"
        ? Object.keys(data.spectators) : [];
      return {
        sessionId,
        hasOffer: !!data.offer,
        hasAnswer: !!data.answer,
        expired,
        expiresAt,
        spectatorCount: spectatorIds.length,
      };
    }

    if (op === "postFrame") {
      // Host mirrors its authoritative frame (and optionally the match
      // init) to the session doc. Spectators read these fields via
      // Firestore onSnapshot. Frame writes are bounded in size to
      // prevent runaway document growth.
      const sessionId = String(req.data?.sessionId ?? "");
      if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required");
      const ref = firestore.collection(COLLECTIONS.webrtc).doc(sessionId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "session not found");
      if (snap.data()?.createdBy !== auth.uid) {
        throw new HttpsError("permission-denied", "host only");
      }
      const expiresAt = Number(snap.data()?.expiresAt ?? 0);
      if (expiresAt && expiresAt <= now) {
        throw new HttpsError("deadline-exceeded", "session expired");
      }
      const update: Record<string, unknown> = { spectatorFrameAt: now };
      if (req.data?.frame) {
        const sane = sanitizeSpectatorFrame(req.data.frame);
        if (!sane) throw new HttpsError("invalid-argument", "invalid frame");
        update.spectatorFrame = sane;
      }
      if (req.data?.init) {
        const init = sanitizeSpectatorInit(req.data.init);
        if (!init) throw new HttpsError("invalid-argument", "invalid init");
        update.spectatorInit = init;
      }
      await ref.set(update, { merge: true });
      return { ok: true };
    }

    throw new HttpsError("invalid-argument", `unknown op: ${op}`);
  },
);

function sanitizeSpectatorFrame(frame: unknown): Record<string, unknown> | null {
  if (!frame || typeof frame !== "object") return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(frame);
  } catch {
    return null;
  }
  if (serialized.length > SPECTATOR_FRAME_MAX_BYTES) return null;
  return JSON.parse(serialized) as Record<string, unknown>;
}

function sanitizeSpectatorInit(init: unknown): Record<string, unknown> | null {
  if (!init || typeof init !== "object") return null;
  const i = init as Record<string, unknown>;
  const seed = Number(i.seed ?? 0) >>> 0;
  const stageId = typeof i.stageId === "string" ? i.stageId.slice(0, 64) : "";
  const cosmetics = Array.isArray(i.cosmetics) ? i.cosmetics.slice(0, 2).map((c) => {
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    return {
      body: typeof o.body === "string" ? o.body.slice(0, 32) : null,
      weapon: typeof o.weapon === "string" ? o.weapon.slice(0, 32) : null,
    };
  }).filter((x) => x !== null) : [];
  return { seed, stageId, cosmetics };
}

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
