// Client-side submitStable wrapper. Calls the Firebase Functions
// callable; surfaces structured errors so the UI can show "rate limited"
// vs "handle taken" vs "bad config" cleanly.

import { firebase, httpsCallable } from "./firebase-client.js";

export class SubmitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SubmitError";
    this.code = code;
  }
}

export async function submitStable({ handle, slotIdx, config, name, cosmetics }) {
  const fb = firebase();
  if (!fb) throw new SubmitError("unconfigured", "Firebase not configured");
  if (!fb.auth.currentUser) throw new SubmitError("unauthenticated", "sign in required");

  const callable = httpsCallable(fb.functions, "submitStable");
  try {
    const result = await callable({ handle, slotIdx, config, name, cosmetics });
    return result.data;
  } catch (err) {
    // firebase-functions HttpsError surfaces the original code as
    // err.code = "functions/<code>". Strip the prefix for cleaner UI.
    const code = String(err?.code ?? "internal").replace(/^functions\//, "");
    const message = err?.message ?? "submission failed";
    throw new SubmitError(code, message);
  }
}

export async function claimHandle(handle) {
  const fb = firebase();
  if (!fb) throw new SubmitError("unconfigured", "Firebase not configured");
  if (!fb.auth.currentUser) throw new SubmitError("unauthenticated", "sign in required");
  const callable = httpsCallable(fb.functions, "claimHandle");
  try {
    const result = await callable({ handle });
    return result.data;
  } catch (err) {
    const code = String(err?.code ?? "internal").replace(/^functions\//, "");
    const message = err?.message ?? "handle claim failed";
    throw new SubmitError(code, message);
  }
}

export async function getMyStableOnce() {
  const fb = firebase();
  if (!fb) return null;
  const user = fb.auth.currentUser;
  if (!user) return null;
  const { doc, getDoc } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const snap = await getDoc(doc(fb.firestore, "stables", user.uid));
  return snap.exists() ? snap.data() : null;
}

export async function getPublicLeaderboard(limitCount = 50) {
  const fb = firebase();
  if (!fb) return [];
  const { collection, getDocs, limit, orderBy, query } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const q = query(
    collection(fb.firestore, "publicStables"),
    orderBy("eloAggregate", "desc"),
    limit(Math.max(1, Math.min(100, Number(limitCount) || 50))),
  );
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      userId: data.userId ?? docSnap.id,
      handle: data.handle ?? docSnap.id,
      eloAggregate: data.eloAggregate ?? 1000,
      wins: data.wins ?? 0,
      losses: data.losses ?? 0,
      draws: data.draws ?? 0,
      slots: data.slots ?? [],
    };
  });
}

export async function getPublicBotsPage({ limitCount = 24, cursor = null } = {}) {
  const fb = firebase();
  if (!fb) return fallbackPublicBotsPage(limitCount);
  const safeLimit = Math.max(1, Math.min(48, Number(limitCount) || 24));
  try {
    const { collection, getDocs, limit, orderBy, query, startAfter } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const clauses = [
      collection(fb.firestore, "publicBots"),
      orderBy("lastOnlineAt", "desc"),
    ];
    if (cursor) clauses.push(startAfter(cursor));
    clauses.push(limit(safeLimit));
    const snap = await getDocs(query(...clauses));
    const rows = snap.docs.map((docSnap) => normalizePublicBot(docSnap.data(), docSnap.id));
    if (rows.length === 0 && !cursor) return fallbackPublicBotsPage(safeLimit);
    return {
      rows,
      cursor: snap.docs.at(-1) ?? null,
      hasMore: snap.docs.length === safeLimit,
      source: "publicBots",
    };
  } catch {
    if (cursor) return { rows: [], cursor: null, hasMore: false, source: "publicStables" };
    return fallbackPublicBotsPage(safeLimit);
  }
}

export async function getPublicBotEvents(limitCount = 12) {
  const fb = firebase();
  if (!fb) return fallbackPublicBotEvents(limitCount);
  const safeLimit = Math.max(1, Math.min(32, Number(limitCount) || 12));
  try {
    const { collection, getDocs, limit, orderBy, query } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const snap = await getDocs(query(
      collection(fb.firestore, "publicBotEvents"),
      orderBy("eventAt", "desc"),
      limit(safeLimit),
    ));
    const rows = snap.docs.map((docSnap) => normalizePublicBotEvent(docSnap.data(), docSnap.id));
    if (rows.length === 0) return fallbackPublicBotEvents(safeLimit);
    return rows;
  } catch {
    return fallbackPublicBotEvents(safeLimit);
  }
}

async function fallbackPublicBotsPage(limitCount) {
  const stables = await getPublicLeaderboard(Math.max(50, limitCount));
  const rows = stables
    .flatMap((stable) => (stable.slots ?? []).map((slot) => normalizePublicBot({
      ...slot,
      userId: stable.userId,
      handle: stable.handle,
      source: stable.userId?.startsWith?.("system:") ? "system" : "player",
      lastOnlineAt: Math.max(Number(slot.lastPlayedAt ?? 0), Number(slot.submittedAt ?? 0), Number(stable.updatedAt ?? 0)),
      updatedAt: stable.updatedAt,
    }, `${stable.userId ?? stable.handle}:slot-${slot.slotIdx ?? slot.slotId ?? "unknown"}`)))
    .sort((a, b) => b.lastOnlineAt - a.lastOnlineAt)
    .slice(0, Math.max(1, Number(limitCount) || 24));
  return { rows, cursor: null, hasMore: false, source: "publicStables" };
}

async function fallbackPublicBotEvents(limitCount) {
  const page = await fallbackPublicBotsPage(Math.max(1, Number(limitCount) || 12));
  return page.rows.map((bot) => ({
    ...bot,
    eventId: `fallback-${bot.botId}`,
    eventType: bot.source === "system" ? "released" : "submitted",
    eventAt: bot.submittedAt || bot.lastOnlineAt || bot.updatedAt || 0,
  }));
}

function normalizePublicBot(data, fallbackId) {
  const submittedAt = numberOr(data.submittedAt, 0);
  const lastPlayedAt = numberOr(data.lastPlayedAt, 0);
  const updatedAt = numberOr(data.updatedAt, Math.max(submittedAt, lastPlayedAt));
  return {
    botId: data.botId ?? fallbackId,
    userId: data.userId ?? "",
    handle: data.handle ?? "unknown",
    slotIdx: Number.isInteger(data.slotIdx) ? data.slotIdx : null,
    slotId: data.slotId ?? fallbackId,
    name: data.name ?? data.slotName ?? "unnamed",
    cosmetics: data.cosmetics ?? null,
    elo: numberOr(data.elo, numberOr(data.eloAggregate, 1500)),
    peakElo: numberOr(data.peakElo, numberOr(data.elo, 1500)),
    wins: numberOr(data.wins, 0),
    losses: numberOr(data.losses, 0),
    draws: numberOr(data.draws, 0),
    submittedAt,
    lastPlayedAt,
    lastOnlineAt: numberOr(data.lastOnlineAt, Math.max(submittedAt, lastPlayedAt, updatedAt)),
    updatedAt,
    lastMatchId: data.lastMatchId ?? null,
    source: data.source === "system" ? "system" : "player",
  };
}

function normalizePublicBotEvent(data, fallbackId) {
  return {
    ...normalizePublicBot(data, data.botId ?? fallbackId),
    eventId: data.eventId ?? fallbackId,
    eventType: data.eventType ?? "submitted",
    eventAt: numberOr(data.eventAt, numberOr(data.submittedAt, 0)),
  };
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Subscribe to the signed-in user's stable doc for the profile UI.
// Returns an unsubscribe function. The returned doc has the same shape
// as the Firestore stable doc (slots, handle, elo, etc.).
export function subscribeMyStable(handler) {
  const fb = firebase();
  if (!fb) {
    handler(null);
    return () => {};
  }
  const auth = fb.auth;
  let unsubscribeDoc = null;
  let stoppedOuter = false;

  const stopAuth = auth.onAuthStateChanged(async (user) => {
    if (unsubscribeDoc) {
      unsubscribeDoc();
      unsubscribeDoc = null;
    }
    if (!user) {
      handler(null);
      return;
    }
    if (stoppedOuter) return;
    // Lazy-load Firestore listener helpers from the firebase-client
    // re-exports so we don't pull a third URL.
    const { doc, onSnapshot } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const ref = doc(fb.firestore, "stables", user.uid);
    unsubscribeDoc = onSnapshot(
      ref,
      (snap) => handler(snap.exists() ? snap.data() : null),
      (err) => {
        console.warn("[submit] subscribeMyStable error:", err?.message ?? err);
        handler(null);
      },
    );
  });

  return () => {
    stoppedOuter = true;
    stopAuth();
    if (unsubscribeDoc) unsubscribeDoc();
  };
}
