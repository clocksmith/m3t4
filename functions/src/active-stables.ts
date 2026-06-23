// Read the active stable pool from Firestore for matchmaker pair
// selection. Uses a small set of `where` filters to bound reads — the
// stables collection can grow large, but only stables that were submitted
// or played recently are eligible for matchmaking.

import type { Firestore } from "firebase-admin/firestore";
import { STRATEGIES, STRATEGY_NAMES, type BrainConfig } from "@m3t4/sim";
import type { StableSummary } from "@m3t4/match-engine";
import { COLLECTIONS } from "./firestore.js";

export interface ActivePoolOptions {
  // Stables count as active when their lastActiveAt is inside this window.
  windowMs?: number;
  // Cap on returned size. Pair selection only needs a few hundred to
  // pick a good pair; we don't pull the whole collection.
  limit?: number;
}

export const DEFAULT_ACTIVE_POOL_MS = 43_200_000;

export async function loadActiveStables(
  firestore: Firestore,
  opts: ActivePoolOptions = {},
): Promise<StableSummary[]> {
  const window = opts.windowMs ?? activePoolWindowMs();
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
      slotIdx,
      slotId: slot.slotId,
      slotName: slot.name ?? `slot-${slotIdx}`,
      cosmetics: slot.cosmetics ?? null,
      config: slot.config as BrainConfig,
      elo: typeof slot.elo === "number" ? slot.elo : 1500,
      isHuman: !data.userId.startsWith("system:"),
      lastPlayedAt: typeof slot.lastPlayedAt === "number" ? slot.lastPlayedAt : 0,
    });
  }
  if (out.length >= 2) return out;
  const existingUsers = new Set(out.map((stable) => stable.userId));
  const fallback = systemFallbackStables().filter((stable) => !existingUsers.has(stable.userId));
  return [...out, ...fallback].slice(0, Math.max(2, out.length));
}

export function activePoolWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.ACTIVE_POOL_MS, DEFAULT_ACTIVE_POOL_MS);
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function systemFallbackStables(): StableSummary[] {
  return STRATEGY_NAMES.map((name, idx) => ({
    userId: `system:${name}`,
    handle: name,
    slotIdx: 0,
    slotId: `system:${name}-0`,
    slotName: name,
    config: STRATEGIES[name as keyof typeof STRATEGIES],
    elo: 1500,
    isHuman: false,
    lastPlayedAt: 0,
    cosmetics: defaultSystemCosmetics(idx),
  }));
}

function defaultSystemCosmetics(idx: number): { body: string; weapon: string } {
  const kits = [
    { body: "sama", weapon: "worldcoin_orb_flail" },
    { body: "darrius", weapon: "rolled_constitution_bat" },
  ];
  return kits[idx % kits.length];
}

interface StableDoc {
  userId: string;
  handle: string;
  slots: Array<{
    slotId: string;
    slotIdx?: number;
    name?: string;
    config: unknown;
    cosmetics?: unknown;
    elo?: number;
    lastPlayedAt?: number;
  }>;
  lastActiveAt: number;
}
