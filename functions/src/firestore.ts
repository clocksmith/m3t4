// Firestore admin SDK init. Uses Application Default Credentials when
// running on Firebase Functions; uses GOOGLE_APPLICATION_CREDENTIALS
// locally if set.

import { initializeApp, getApps, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let cached: Firestore | null = null;
let cachedApp: App | null = null;

function app(): App {
  if (cachedApp) return cachedApp;
  cachedApp = getApps().find((candidate) => candidate.name === "[DEFAULT]") ?? initializeApp();
  return cachedApp;
}

export function db(): Firestore {
  if (cached) return cached;
  cached = getFirestore(app());
  cached.settings({ ignoreUndefinedProperties: true });
  return cached;
}

export const COLLECTIONS = {
  matches: "matches",
  stables: "stables",
  publicStables: "publicStables",
  publicBots: "publicBots",
  publicBotEvents: "publicBotEvents",
  handles: "handles",
  state: "state",
  // Optional: used by Phase 2 P2P signaling.
  webrtc: "webrtc",
  computeWorkers: "compute_workers",
  computeAssignments: "compute_assignments",
  computeReceipts: "compute_receipts",
  computePublicStats: "compute_public_stats",
  computePeerPresence: "compute_peer_presence",
} as const;
