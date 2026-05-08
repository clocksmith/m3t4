// Shared ICE server config for every WebRTC path in the client (duel
// pairing, spectator mesh, compute mesh). Fetches from the
// `webrtcSignal` callable's `iceServers` op and caches in memory + the
// `__M3T4_COMPUTE_ICE_SERVERS__` window global so existing code that
// reads the global still gets the upgraded list.
//
// The server returns STUN by default and adds a TURN entry with
// short-term REST credentials (24h TTL) when the function has TURN_URLS
// + TURN_SECRET env vars configured. The cache TTL here (15m) is much
// shorter than the credential TTL so a stale browser tab still picks up
// rotated credentials within a reasonable window.
//
// All three callsites should:
//   1. await ensureIceServers() at session start
//   2. read iceServers() (sync) when constructing the RTCPeerConnection
// The sync getter falls back to a sensible STUN default if fetch is in
// flight or fails, so paths never block on signaling availability.

import { firebase, httpsCallable, signInAnonymously } from "./firebase-client.js";

const CACHE_TTL_MS = 15 * 60_000;
const FALLBACK = [{ urls: "stun:stun.l.google.com:19302" }];

let cached = null;     // last successful response
let cachedAt = 0;
let inflight = null;   // de-dupes concurrent fetches

function readWindowOverride() {
  if (typeof window === "undefined") return null;
  const overrides = window.__M3T4_COMPUTE_ICE_SERVERS__;
  if (Array.isArray(overrides) && overrides.length > 0) return overrides;
  const stun = window.__M3T4_COMPUTE_STUN_URLS__;
  if (Array.isArray(stun) && stun.length > 0) return [{ urls: stun }];
  return null;
}

async function ensureAuth(fb) {
  if (!fb?.auth) return;
  if (fb.auth.currentUser) return;
  try { await signInAnonymously(fb.auth); } catch {}
}

async function fetchFromSignaling() {
  const fb = firebase();
  if (!fb) return null;
  await ensureAuth(fb);
  try {
    const fn = httpsCallable(fb.functions, "webrtcSignal");
    const res = await fn({ op: "iceServers" });
    const list = Array.isArray(res?.data?.iceServers) ? res.data.iceServers : null;
    if (!list || !list.length) return null;
    return list;
  } catch {
    return null;
  }
}

// Fetch + cache. Safe to call frequently; does at most one in-flight
// request at a time and reuses the cache while it's fresh.
export async function ensureIceServers() {
  const override = readWindowOverride();
  if (override) {
    cached = override;
    cachedAt = Date.now();
    return cached;
  }
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const list = await fetchFromSignaling();
    if (list) {
      cached = list;
      cachedAt = Date.now();
      // Mirror to the long-standing window global so any code that still
      // reads it (e.g. compute.js capability probe) gets the same list.
      if (typeof window !== "undefined") {
        window.__M3T4_COMPUTE_ICE_SERVERS__ = list;
      }
    }
    inflight = null;
    return cached || FALLBACK;
  })();
  return inflight;
}

// Sync getter — returns the last good list, or the STUN fallback if the
// fetch is still in flight or has never run. Callers that want the
// freshest creds should await ensureIceServers() first.
export function iceServers() {
  return cached || readWindowOverride() || FALLBACK;
}
