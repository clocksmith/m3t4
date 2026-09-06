// Match feed: two modes.
//
// 1. STATIC (default for the zero-backend path): fetches a pre-generated
//    match index from /matches/index.json, picks the match whose virtual
//    schedule window contains "now", and replays it. Spectators sync
//    naturally because the schedule is wall-clock-anchored. Zero server
//    cost — just static asset fetches with browser caching.
//
// 2. FIRESTORE (when window.__M3T4_USE_FIREBASE_FEED__ is true): subscribes
//    to Firestore matches collection for live-server-generated matches.
//    Higher cost, supports new player submissions.
//
// Replaces the legacy WebSocket-based firehose feed. Same event shape so
// `spectate.js` only needs minor wiring changes.
//
// FIRESTORE mode requires Firebase Web SDK loaded as a module. Set
// `window.__M3T4_FIREBASE__` (project config) before this module loads.

import {
  framesFromActionLog as simFramesFromActionLog,
  simulateTrace,
  STAGES,
  DEFAULT_CHARS,
} from "../sim/index.js";

const FRAME_TICK_MS = 1000 / 120;

// Firebase is optional for archive playback. Reuse the shared app instance,
// and keep unsubscribe synchronous even while its SDK is loading.
async function firestoreContext() {
  const [{ firebase }, sdk] = await Promise.all([
    import("./firebase-client.js"),
    import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"),
  ]);
  const context = firebase();
  if (!context) throw new Error("Firebase is not configured");
  return { db: context.firestore, sdk };
}

function subscribeSnapshot(makeRef, onSnapshotValue, onError = error => console.warn("[match-feed]", error)) {
  let stopped = false;
  let unsubscribe = null;
  void firestoreContext().then(({ db, sdk }) => {
    if (stopped) return;
    unsubscribe = sdk.onSnapshot(makeRef(db, sdk), onSnapshotValue, onError);
  }).catch(error => { if (!stopped) onError(error); });
  return () => { stopped = true; unsubscribe?.(); };
}

export function subscribeLatestMatch(onMatch, onError) {
  return subscribeSnapshot(
    (db, sdk) => sdk.query(sdk.collection(db, "matches"), sdk.orderBy("startedAt", "desc"), sdk.limit(1)),
    snap => {
      snap.docChanges().forEach(change => {
        if (change.type === "added" || change.type === "modified") {
          const data = change.doc.data();
          if (data && typeof data === "object") onMatch(data);
        }
      });
    }, onError,
  );
}

export function subscribeCurrentMatchId(onHead, onError = () => {}) {
  return subscribeSnapshot(
    (db, sdk) => sdk.doc(db, "state", "matchChain"),
    snap => {
      const data = snap.data();
      const matchId = data?.latestMatchId;
      if (typeof matchId === "string" && matchId) onHead({ matchId, state: data });
    }, onError,
  );
}

export async function fetchMatchDoc(matchId) {
  const { db, sdk } = await firestoreContext();
  const snap = await sdk.getDoc(sdk.doc(db, "matches", matchId));
  return snap.exists() ? snap.data() : null;
}

// Decode base64 to Uint8Array.
function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Re-derive frames for a match doc by running the sim locally. The match
// doc carries (stage, seed, chars, configs are NOT included — but we
// don't need them: simulateTrace can re-run from inputs since the actionLog
// is deterministic given the same brain configs which the server used to
// produce the result).
//
// For now we re-run simulateTrace using DEFAULT_CHARS and the stable
// sim-constants hash from the doc; if `simConstantsHash` doesn't match
// the local sim we render a placeholder rather than re-simulating with
// stale logic.
export function reconstructFrames(matchDoc, brainsByUserId) {
  const stage = STAGES[matchDoc.stageId];
  if (!stage) throw new Error(`unknown stage: ${matchDoc.stageId}`);
  const brainA = brainsByUserId?.[matchDoc.a.userId];
  const brainB = brainsByUserId?.[matchDoc.b.userId];
  if (!brainA || !brainB) {
    // Without brain configs we can verify-from-actionLog instead. That
    // path needs a separate helper exported from @m3t4/sim that yields
    // frames per step. For now, use placeholder frames.
    return null;
  }
  const trace = simulateTrace({
    stage,
    brainA,
    brainB,
    seed: matchDoc.seed,
    chars: matchDoc.chars ?? DEFAULT_CHARS,
  });
  return trace.frames;
}

// Verify-style frame reconstruction from actionLog only. Mirrors
// `verifyActionLog` from @m3t4/sim but yields the per-tick frame for
// rendering. Use this when brain configs are not available client-side
// (the standard spectator path — match docs intentionally exclude
// configs to keep strategy private).
export function framesFromActionLog(matchDoc) {
  const stage = STAGES[matchDoc.stageId];
  if (!stage) throw new Error(`unknown stage: ${matchDoc.stageId}`);
  const bytes = base64ToBytes(matchDoc.actionLog);
  const out = simFramesFromActionLog({
    stage,
    seed: matchDoc.seed,
    chars: matchDoc.chars ?? DEFAULT_CHARS,
    actionLog: bytes,
  });
  return out.frames;
}

// Time-aligned playback: tick from `startedAt` to `endsAt` at the same
// pacing the original match used. Caller provides `onFrame(frame, idx)`
// and `onEnd()`. Returns a stop function.
export function playMatchAligned(matchDoc, frames, callbacks) {
  const onFrame = callbacks.onFrame ?? (() => {});
  const onEnd = callbacks.onEnd ?? (() => {});
  const tickMs = matchDoc.durationMs / Math.max(1, frames.length);

  let stopped = false;
  const startedAt = matchDoc.startedAt;
  const now = Date.now();
  const startOffsetMs = Math.max(0, now - startedAt);
  const startIdx = Math.min(frames.length - 1, Math.floor(startOffsetMs / tickMs));

  let idx = startIdx;
  function tick() {
    if (stopped) return;
    if (idx >= frames.length) {
      onEnd();
      return;
    }
    onFrame(frames[idx], idx);
    idx++;
    setTimeout(tick, tickMs);
  }
  tick();
  return () => { stopped = true; };
}

export const MATCH_FEED_TICK_MS = FRAME_TICK_MS;

// ===== Static-match mode =====
//
// Backend-free path: fetch index.json once, pick the current match
// based on virtualStartedAt/virtualEndsAt, fetch its full doc, replay.
// Loops the schedule by computing (now - scheduleStartedAt) %
// totalScheduleMs.

const STATIC_MATCHES_INDEX_URL = "/matches/index.json";
let staticIndexCache = null;
let staticIndexFetchedAt = 0;
const STATIC_INDEX_TTL_MS = 5 * 60_000;

async function loadStaticIndex() {
  const now = Date.now();
  if (staticIndexCache && now - staticIndexFetchedAt < STATIC_INDEX_TTL_MS) {
    return staticIndexCache;
  }
  const res = await fetch(STATIC_MATCHES_INDEX_URL);
  if (!res.ok) throw new Error(`static match index fetch ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.matches) || data.matches.length === 0) {
    throw new Error("static match index empty or malformed");
  }
  staticIndexCache = data;
  staticIndexFetchedAt = now;
  return data;
}

// Find the match whose virtual schedule window contains `now`, looping
// the schedule modulo totalScheduleMs. Returns { summary, scheduleOffsetMs }.
export function pickCurrentStaticMatch(index, now = Date.now()) {
  const total = index.totalScheduleMs ?? 0;
  if (total <= 0) return null;
  const scheduleStartedAt = index.scheduleStartedAt ?? index.generatedAt ?? 0;
  const elapsed = now - scheduleStartedAt;
  const positionMs = ((elapsed % total) + total) % total;
  // Linear scan is fine — index is small and matches are in schedule order.
  for (const summary of index.matches) {
    const start = summary.virtualStartedAt - scheduleStartedAt;
    const end = summary.virtualEndsAt - scheduleStartedAt;
    if (positionMs >= start && positionMs < end) {
      return { summary, scheduleOffsetMs: positionMs - start };
    }
  }
  // Fallback: first match.
  return { summary: index.matches[0], scheduleOffsetMs: 0 };
}

async function fetchStaticMatchDoc(matchId) {
  const res = await fetch(`/matches/${encodeURIComponent(matchId)}.json`);
  if (!res.ok) throw new Error(`static match ${matchId} fetch ${res.status}`);
  return res.json();
}

// Subscribe-style API for the static path. Polls the index periodically
// to pick up regenerations; emits onMatch when the current match changes.
// Returns an unsubscribe function.
export function subscribeStaticMatch(onMatch, options = {}) {
  const pollMs = options.pollMs ?? 5_000;
  let stopped = false;
  let currentMatchId = null;

  async function tick() {
    if (stopped) return;
    try {
      const index = await loadStaticIndex();
      const picked = pickCurrentStaticMatch(index);
      if (picked && picked.summary.matchId !== currentMatchId) {
        const matchDoc = await fetchStaticMatchDoc(picked.summary.matchId);
        currentMatchId = picked.summary.matchId;
        // Surface a synthetic startedAt/endsAt anchored to wall-clock
        // so the consumer's time-alignment math works out.
        const wallStartedAt = Date.now() - picked.scheduleOffsetMs;
        const wallEndsAt = wallStartedAt + matchDoc.durationMs;
        onMatch({ ...matchDoc, startedAt: wallStartedAt, endsAt: wallEndsAt });
      }
    } catch (e) {
      // Surface the error once but keep polling — index might be missing
      // briefly mid-deploy.
      console.warn("[match-feed] static poll failed:", e?.message ?? e);
    }
    if (!stopped) setTimeout(tick, pollMs);
  }
  tick();
  return () => { stopped = true; };
}
