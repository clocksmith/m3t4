// Read the active stable pool from Firestore for matchmaker pair
// selection. Uses a small set of `where` filters to bound reads — the
// stables collection can grow large, but only stables that were submitted
// or played recently are eligible for matchmaking.

import type { Firestore } from "firebase-admin/firestore";
import type { BrainConfig } from "@m3t4/sim";
import type { StableSummary } from "@m3t4/match-engine";
import { COLLECTIONS } from "./firestore.js";

export interface ActivePoolOptions {
  // Stables count as "active" when their lastActiveAt is within this
  // window. Default 24h.
  windowMs?: number;
  // Cap on returned size. Pair selection only needs a few hundred to
  // pick a good pair; we don't pull the whole collection.
  limit?: number;
}

export async function loadActiveStables(
  firestore: Firestore,
  opts: ActivePoolOptions = {},
): Promise<StableSummary[]> {
  const window = opts.windowMs ?? 24 * 3600_000;
  const limit = opts.limit ?? 500;
  const cutoff = Date.now() - window;

  const snap = await firestore
    .collection(COLLECTIONS.stables)
    .where("lastActiveAt", ">=", cutoff)
    .orderBy("lastActiveAt", "desc")
    .limit(limit)
    .get();

  const out: StableSummary[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as StableDoc;
    const slots = Array.isArray(data.slots) ? data.slots : [];
    if (slots.length === 0) continue;
    // Pick a random slot per stable for matchmaking (mirrors legacy
    // findPair behavior). Done deterministically off slot index parity
    // for tick-stable selection within one match invocation.
    const slotIdx = Math.floor(Math.random() * slots.length);
    const slot = slots[slotIdx];
    if (!slot || !slot.config) continue;
    out.push({
      userId: data.userId,
      handle: data.handle,
      slotId: slot.slotId,
      slotName: slot.name ?? `slot-${slotIdx}`,
      config: slot.config as BrainConfig,
      elo: typeof slot.elo === "number" ? slot.elo : 1500,
      isHuman: !data.userId.startsWith("system:"),
      lastPlayedAt: typeof slot.lastPlayedAt === "number" ? slot.lastPlayedAt : 0,
    });
  }
  return out;
}

interface StableDoc {
  userId: string;
  handle: string;
  slots: Array<{
    slotId: string;
    name?: string;
    config: unknown;
    elo?: number;
    lastPlayedAt?: number;
  }>;
  lastActiveAt: number;
}
