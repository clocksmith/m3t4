export const MAX_SLOTS = 4;
export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

export interface StableSlotDoc {
  slotIdx?: number;
  slotId: string;
  name: string;
  config?: unknown;
  cosmetics?: unknown;
  elo: number;
  peakElo?: number;
  wins?: number;
  losses?: number;
  draws?: number;
  lastPlayedAt: number;
  submittedAt: number;
  rateLockedUntil?: number;
}

export interface StableDoc {
  userId: string;
  handle: string;
  slots: StableSlotDoc[];
  wins?: number;
  losses?: number;
  draws?: number;
  eloAggregate?: number;
  lastActiveAt: number;
  updatedAt: number;
  createdAt: number;
  lastMatchId?: string;
}

export function sanitizeHandle(input: string): string {
  return String(input).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20) || "anon";
}

export function stableSummary(stable: StableDoc): {
  wins: number;
  losses: number;
  draws: number;
  eloAggregate: number;
} {
  const slots = Array.isArray(stable.slots) ? stable.slots.filter((slot) => slot?.slotId) : [];
  const wins = slots.reduce((sum, slot) => sum + numberOr(slot.wins, 0), 0);
  const losses = slots.reduce((sum, slot) => sum + numberOr(slot.losses, 0), 0);
  const draws = slots.reduce((sum, slot) => sum + numberOr(slot.draws, 0), 0);
  const eloAggregate = slots.length
    ? Math.round(slots.reduce((sum, slot) => sum + numberOr(slot.elo, 1500), 0) / slots.length)
    : 1500;
  return { wins, losses, draws, eloAggregate };
}

export function publicStableDoc(stable: StableDoc): Record<string, unknown> {
  const summary = stableSummary(stable);
  return {
    schema: "m3t4.public-stable.v1",
    userId: stable.userId,
    handle: stable.handle,
    wins: summary.wins,
    losses: summary.losses,
    draws: summary.draws,
    eloAggregate: summary.eloAggregate,
    lastActiveAt: stable.lastActiveAt ?? 0,
    updatedAt: stable.updatedAt ?? Date.now(),
    slots: (stable.slots ?? [])
      .filter((slot) => slot?.slotId)
      .map((slot) => ({
        slotIdx: slot.slotIdx ?? null,
        slotId: slot.slotId,
        name: slot.name,
        cosmetics: slot.cosmetics ?? null,
        elo: numberOr(slot.elo, 1500),
        peakElo: numberOr(slot.peakElo, numberOr(slot.elo, 1500)),
        wins: numberOr(slot.wins, 0),
        losses: numberOr(slot.losses, 0),
        draws: numberOr(slot.draws, 0),
        lastPlayedAt: numberOr(slot.lastPlayedAt, 0),
        submittedAt: numberOr(slot.submittedAt, 0),
      })),
  };
}

export function normalizeStableTotals(stable: StableDoc): StableDoc {
  const summary = stableSummary(stable);
  return {
    ...stable,
    wins: summary.wins,
    losses: summary.losses,
    draws: summary.draws,
    eloAggregate: summary.eloAggregate,
  };
}

export function emptyStable(userId: string, handle: string, now: number): StableDoc {
  return normalizeStableTotals({
    userId,
    handle,
    slots: [],
    lastActiveAt: now,
    updatedAt: now,
    createdAt: now,
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
