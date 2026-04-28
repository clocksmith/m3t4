// Single source of truth for the Firebase Web SDK app instance and the
// Firestore + Auth + Functions handles. Other modules import from here so
// we don't initialize the app multiple times (which throws or wastes
// resources). Gracefully no-ops if Firebase config is absent so the
// static-only build keeps working.

import {
  getApps,
  initializeApp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInAnonymously,
  signInWithPopup,
  signOut as fbSignOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

let cached = null;

export function firebase() {
  if (cached) return cached;
  const config = globalThis.window?.__M3T4_FIREBASE_CONFIG__ ?? globalThis.window?.__M3T4_FIREBASE__;
  if (!config) return null;
  if (globalThis.window && !globalThis.window.__M3T4_FIREBASE__) {
    globalThis.window.__M3T4_FIREBASE__ = config;
  }
  const app = getApps()[0] ?? initializeApp(config);
  const region = globalThis.window?.__M3T4_FIREBASE_REGION__ ?? "us-central1";
  cached = {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
    functions: getFunctions(app, region),
    region,
  };
  return cached;
}

// Re-export the SDK pieces the rest of the client needs, so callers don't
// have to keep importing from gstatic URLs.
export {
  onAuthStateChanged,
  GoogleAuthProvider,
  signInAnonymously,
  signInWithPopup,
  fbSignOut as signOut,
  httpsCallable,
};
