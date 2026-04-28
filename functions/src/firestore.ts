// Firestore admin SDK init. Uses Application Default Credentials when
// running on Firebase Functions; uses GOOGLE_APPLICATION_CREDENTIALS
// locally if set.

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let cached: Firestore | null = null;

export function db(): Firestore {
  if (cached) return cached;
  if (getApps().length === 0) initializeApp();
  cached = getFirestore();
  cached.settings({ ignoreUndefinedProperties: true });
  return cached;
}

export const COLLECTIONS = {
  matches: "matches",
  stables: "stables",
  state: "state",
  // Optional: used by Phase 2 P2P signaling.
  webrtc: "webrtc",
} as const;
