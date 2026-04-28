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
