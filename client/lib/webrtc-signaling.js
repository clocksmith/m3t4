// Shared signaling helpers used by every WebRTC path in the client
// (duel pairing, spectator mesh, compute mesh). Each path used to carry
// a near-duplicate copy of these — sign-in, callable wrapper, ICE
// gather wait, SDP packer, dynamic Firestore SDK import — and the
// copies were drifting (different error codes, different timeouts,
// different sign-in error messages). One set of helpers keeps them
// honest and makes the next WebRTC path cheap to add.

import { firebase, httpsCallable, signInAnonymously } from "./firebase-client.js";

const ICE_GATHER_TIMEOUT_MS = 5_000;

// Cached Firestore SDK module — the dynamic import was being repeated
// at every signaling callsite (6+ places). Loading it once cuts the
// repeated network fetches and keeps tree-shaking simple.
let firestoreSdk = null;
export async function loadFirestore() {
  if (firestoreSdk) return firestoreSdk;
  firestoreSdk = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  return firestoreSdk;
}

// Returns the Firebase context with a guaranteed currentUser. If no
// session exists, signs the visitor in anonymously (transparent — the
// visitor sees no sign-in flow). Surfaces a clear hint when Anonymous
// Auth is disabled so callers don't bubble up the raw Firebase code.
export async function ensureAnonAuth() {
  const fb = firebase();
  if (!fb) throw new Error("Firebase not configured");
  if (fb.auth.currentUser) return fb;
  try {
    await signInAnonymously(fb.auth);
  } catch (err) {
    const code = String(err?.code ?? "");
    if (code === "auth/operation-not-allowed" || code === "auth/admin-restricted-operation") {
      throw new Error("WebRTC unavailable: enable Anonymous Auth in Firebase, or sign in first");
    }
    throw new Error(`Sign-in failed: ${err?.message ?? code}`);
  }
  return fb;
}

// Calls the webrtcSignal callable with consistent error shape. Throws
// errors with `.code` set so callers can distinguish "not-found",
// "deadline-exceeded", custom "host-gone", etc., without parsing the
// message string.
export async function callSignal(fb, op, payload = {}) {
  const fn = httpsCallable(fb.functions, "webrtcSignal");
  try {
    const res = await fn({ op, ...payload });
    return res.data;
  } catch (err) {
    const code = String(err?.code ?? "internal").replace(/^functions\//, "");
    const message = String(err?.message ?? "signaling failed");
    const e = (code === "internal" && /^internal$/i.test(message))
      ? new Error("signaling service unavailable")
      : new Error(message);
    e.code = code;
    throw e;
  }
}

// Resolves when the peer connection finishes ICE candidate gathering or
// the timeout fires (whichever comes first). The timeout cap matters
// because some networks never report "complete" — without it the host
// would block here forever.
export function waitIceGathering(pc, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    });
  });
}

// SDP descriptions arrive from RTCPeerConnection as RTCSessionDescription
// instances; the signaling callable wants plain { type, sdp }. Strip to
// that shape before posting.
export function packDescription(desc) {
  if (!desc) return null;
  return {
    type: String(desc.type ?? ""),
    sdp: String(desc.sdp ?? ""),
  };
}
