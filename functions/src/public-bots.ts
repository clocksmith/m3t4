import type {
  DocumentData,
  DocumentReference,
  Firestore,
  SetOptions,
} from "firebase-admin/firestore";
import { COLLECTIONS } from "./firestore.js";
import type { StableDoc, StableSlotDoc } from "./stable-public.js";

type ProjectionWriter = {
  set(ref: DocumentReference, data: DocumentData, options?: SetOptions): unknown;
};

export type BotEventType = "submitted" | "revised" | "released";

export interface PublicBotDoc {
  schema: "m3t4.public-bot.v1";
  botId: string;
  userId: string;
  handle: string;
  slotIdx: number | null;
  slotId: string;
  name: string;
  cosmetics: unknown;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  draws: number;
  submittedAt: number;
  lastPlayedAt: number;
  lastOnlineAt: number;
  updatedAt: number;
  lastMatchId: string | null;
  source: "player" | "system";
  active: true;
}

export interface PublicBotEventDoc extends Omit<PublicBotDoc, "schema"> {
  schema: "m3t4.public-bot-event.v1";
  eventId: string;
  eventType: BotEventType;
  eventAt: number;
}

export function publicBotId(userId: string, slot: Pick<StableSlotDoc, "slotIdx" | "slotId">): string {
  const seatKey = Number.isInteger(slot.slotIdx) ? `slot-${Number(slot.slotIdx)}` : slot.slotId;
  return `${docSafe(userId)}__${docSafe(seatKey)}`;
}

export function publicBotDoc(stable: StableDoc, slot: StableSlotDoc): PublicBotDoc | null {
  if (!slot?.slotId) return null;
  const submittedAt = numberOr(slot.submittedAt, stable.updatedAt ?? 0);
  const lastPlayedAt = numberOr(slot.lastPlayedAt, 0);
  const lastOnlineAt = Math.max(submittedAt, lastPlayedAt, numberOr(stable.lastActiveAt, 0));
  return {
    schema: "m3t4.public-bot.v1",
    botId: publicBotId(stable.userId, slot),
    userId: stable.userId,
    handle: stable.handle,
    slotIdx: Number.isInteger(slot.slotIdx) ? Number(slot.slotIdx) : null,
    slotId: slot.slotId,
    name: slot.name || "unnamed",
    cosmetics: slot.cosmetics ?? null,
    elo: numberOr(slot.elo, 1500),
    peakElo: numberOr(slot.peakElo, numberOr(slot.elo, 1500)),
    wins: numberOr(slot.wins, 0),
    losses: numberOr(slot.losses, 0),
    draws: numberOr(slot.draws, 0),
    submittedAt,
    lastPlayedAt,
    lastOnlineAt,
    updatedAt: numberOr(stable.updatedAt, lastOnlineAt),
    lastMatchId: stable.lastMatchId ?? null,
    source: stable.userId.startsWith("system:") ? "system" : "player",
    active: true,
  };
}

export function writePublicBotProjection(
  writer: ProjectionWriter,
  firestore: Firestore,
  stable: StableDoc,
): void {
  for (const slot of stable.slots ?? []) {
    const publicBot = publicBotDoc(stable, slot);
    if (!publicBot) continue;
    writer.set(
      firestore.collection(COLLECTIONS.publicBots).doc(publicBot.botId),
      publicBot,
      { merge: true },
    );
  }
}

export function writePublicBotEvent(
  writer: ProjectionWriter,
  firestore: Firestore,
  stable: StableDoc,
  slot: StableSlotDoc,
  eventType: BotEventType,
  eventAt: number,
): void {
  const publicBot = publicBotDoc(
    { ...stable, updatedAt: eventAt, lastActiveAt: Math.max(numberOr(stable.lastActiveAt, 0), eventAt) },
    { ...slot, submittedAt: numberOr(slot.submittedAt, eventAt) },
  );
  if (!publicBot) return;
  const eventId = `${eventAt.toString(36)}-${eventType}-${publicBot.botId.slice(-48)}`;
  writer.set(
    firestore.collection(COLLECTIONS.publicBotEvents).doc(eventId),
    {
      ...publicBot,
      schema: "m3t4.public-bot-event.v1",
      eventId,
      eventType,
      eventAt,
    } satisfies PublicBotEventDoc,
  );
}

function docSafe(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
