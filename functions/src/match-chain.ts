// Match chain state and locking. The chain is a single doc at
// state/matchChain that records the current head (latest match) and
// holds a transactional lock so matchTick invocations don't race.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "./firestore.js";

export const MATCH_CHAIN_DOC = "matchChain";
export const LOCK_TTL_MS = 60_000;

export interface MatchChainState {
  schema: "m3t4.match-chain.v1";
  paused: boolean;
  // Lock-related: set during matchTick execution.
  lockedUntil: number; // ms epoch; 0 if unlocked
  lockerId: string | null;
  // Latest published match metadata.
  latestMatchId: string | null;
  latestStartedAt: number; // ms
  latestEndsAt: number; // ms
  // Bookkeeping.
  consecutiveMatches: number;
  updatedAt: number;
}

export const DEFAULT_CHAIN_STATE: MatchChainState = {
  schema: "m3t4.match-chain.v1",
  paused: false,
  lockedUntil: 0,
  lockerId: null,
  latestMatchId: null,
  latestStartedAt: 0,
  latestEndsAt: 0,
  consecutiveMatches: 0,
  updatedAt: 0,
};

// Try to acquire the lock. Returns the chain state if acquired, null if
// another invocation holds it. Idempotent and transactional.
export async function tryAcquireChainLock(
  firestore: Firestore,
  lockerId: string,
  now: number,
): Promise<MatchChainState | null> {
  const ref = firestore.collection(COLLECTIONS.state).doc(MATCH_CHAIN_DOC);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current: MatchChainState = snap.exists
      ? (snap.data() as MatchChainState)
      : DEFAULT_CHAIN_STATE;

    if (current.paused) return null;
    if (current.lockedUntil > now) return null;

    const next: MatchChainState = {
      ...current,
      lockedUntil: now + LOCK_TTL_MS,
      lockerId,
      updatedAt: now,
    };
    tx.set(ref, next);
    return next;
  });
}

export async function releaseChainLock(
  firestore: Firestore,
  lockerId: string,
  now: number,
  patch: Partial<Pick<MatchChainState, "latestMatchId" | "latestStartedAt" | "latestEndsAt" | "consecutiveMatches">>,
): Promise<void> {
  const ref = firestore.collection(COLLECTIONS.state).doc(MATCH_CHAIN_DOC);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current: MatchChainState = snap.exists
      ? (snap.data() as MatchChainState)
      : DEFAULT_CHAIN_STATE;
    // Only release if this locker still holds the lock; otherwise leave
    // the existing lock alone (some other invocation took over after our
    // lock expired).
    if (current.lockerId !== lockerId) return;
    const next: MatchChainState = {
      ...current,
      ...patch,
      lockedUntil: 0,
      lockerId: null,
      updatedAt: now,
    };
    tx.set(ref, next);
  });
}

export async function getChainState(firestore: Firestore): Promise<MatchChainState> {
  const ref = firestore.collection(COLLECTIONS.state).doc(MATCH_CHAIN_DOC);
  const snap = await ref.get();
  return snap.exists ? (snap.data() as MatchChainState) : DEFAULT_CHAIN_STATE;
}

export async function setChainPaused(
  firestore: Firestore,
  paused: boolean,
  now: number,
): Promise<void> {
  const ref = firestore.collection(COLLECTIONS.state).doc(MATCH_CHAIN_DOC);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current: MatchChainState = snap.exists
      ? (snap.data() as MatchChainState)
      : DEFAULT_CHAIN_STATE;
    tx.set(ref, { ...current, paused, updatedAt: now });
  });
}
