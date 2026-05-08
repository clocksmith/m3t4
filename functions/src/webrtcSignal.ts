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
import { randomUUID, createHmac } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

const REGION = "us-central1";
const SESSION_TTL_MS = 5 * 60_000;
const MAX_CANDIDATES_PER_POST = 8;
const SPECTATOR_FRAME_MAX_BYTES = 4096;
const TURN_CRED_TTL_SEC = 24 * 60 * 60; // 24h — covers the longest plausible session

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
        const offer = sanitizeDescription(payload.offer, "offer");
        if (!offer) throw new HttpsError("invalid-argument", "invalid offer");
        update.offer = {
          type: offer.type,
          sdp: offer.sdp,
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
        const answer = sanitizeDescription(payload.answer, "answer");
        if (!answer) throw new HttpsError("invalid-argument", "invalid answer");
        update.answer = {
          type: answer.type,
          sdp: answer.sdp,
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

    if (op === "spectatorPing") {
      // A duel spectator (Firestore-only viewer; the paired player uses
      // the data channel and doesn't need this) pings every ~10s while
      // they're watching. The host reads `spectatorLastSeenAt` from its
      // existing onSnapshot subscription and only mirrors frames at
      // 10fps when the timestamp is fresh — saves the unconditional
      // write loop when nobody is watching from a third browser.
      const sessionId = String(req.data?.sessionId ?? "");
      if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required");
      const ref = firestore.collection(COLLECTIONS.webrtc).doc(sessionId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "session not found");
      const expiresAt = Number(snap.data()?.expiresAt ?? 0);
      if (expiresAt && expiresAt <= now) {
        throw new HttpsError("deadline-exceeded", "session expired");
      }
      await ref.set({ spectatorLastSeenAt: now }, { merge: true });
      return { ok: true, ts: now };
    }

    if (op === "iceServers") {
      // Returns the ICE server config for clients to use in RTCPeerConnection.
      // STUN-only by default; if TURN_REALM + TURN_SECRET env vars are set
      // we also return a TURN entry with short-term credentials per the
      // time-windowed shared-secret pattern (username = expiry:uid,
      // credential = HMAC-SHA1(secret, username), base64). 24h expiry
      // covers the longest reasonable session and lets the same creds be
      // cached across the page.
      return { iceServers: buildIceServers(auth.uid) };
    }

    if (op === "reuse") {
      // Host-only path used when the host's tab is reloaded. Wipes the
      // pairing slots (offer/answer/ICE) on the existing session doc and
      // re-extends the TTL so a fresh handshake can run on the same
      // sessionId — the shareable invite link survives the refresh.
      const sessionId = String(req.data?.sessionId ?? "");
      if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required");
      const ref = firestore.collection(COLLECTIONS.webrtc).doc(sessionId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "session not found");
      if (snap.data()?.createdBy !== auth.uid) {
        throw new HttpsError("permission-denied", "host only");
      }
      const expiresAt = now + SESSION_TTL_MS;
      await ref.set({
        offer: null,
        answer: null,
        candidatesA: [],
        candidatesB: [],
        spectatorFrame: null,
        spectatorFrameAt: 0,
        spectatorInit: null,
        expiresAt,
        updatedAt: now,
      }, { merge: true });
      return { sessionId, expiresAt };
    }

    throw new HttpsError("invalid-argument", `unknown op: ${op}`);
  },
);

function sanitizeDescription(desc: unknown, expectedType: "offer" | "answer"): { type: string; sdp: string } | null {
  if (!desc || typeof desc !== "object") return null;
  const d = desc as Record<string, unknown>;
  const type = String(d.type ?? "");
  const sdp = String(d.sdp ?? "");
  if (type !== expectedType || !sdp || sdp.length > 128_000) return null;
  return { type, sdp };
}

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
  const aliasesRaw = Array.isArray(i.aliases) ? i.aliases.slice(0, 2) : null;
  const out: Record<string, unknown> = { seed, stageId, cosmetics };
  if (aliasesRaw) {
    out.aliases = aliasesRaw.map((a) => typeof a === "string" ? a.slice(0, 32) : "");
  }
  return out;
}

type IceServer = { urls: string | string[]; username?: string; credential?: string };

function buildIceServers(uid: string): IceServer[] {
  const stunUrls = (process.env.STUN_URLS ?? "stun:stun.l.google.com:19302")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const servers: IceServer[] = [{ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls }];
  const turnUrlsRaw = (process.env.TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const secret = process.env.TURN_SECRET;
  if (turnUrlsRaw.length && secret) {
    const expiry = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_SEC;
    const username = `${expiry}:${uid || "anon"}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    servers.push({
      urls: turnUrlsRaw.length === 1 ? turnUrlsRaw[0] : turnUrlsRaw,
      username,
      credential,
    });
  } else if (turnUrlsRaw.length) {
    // Static-credential mode (TURN_USER + TURN_PASS) for providers that
    // don't support REST. Less secure — anyone with the page can grab
    // them — but workable for low-traffic projects.
    const user = process.env.TURN_USER;
    const pass = process.env.TURN_PASS;
    if (user && pass) {
      servers.push({
        urls: turnUrlsRaw.length === 1 ? turnUrlsRaw[0] : turnUrlsRaw,
        username: user,
        credential: pass,
      });
    }
  }
  return servers;
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
