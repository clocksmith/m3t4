// matchTick: the worker. Picks a pair, simulates, persists the result,
// updates ELO, and enqueues the next matchTick at the predicted match
// end time. Idempotent via the chain-lock transaction so concurrent
// invocations (cron + Cloud Tasks delivery) don't double-run.

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { runMatch, selectPair, type StableSummary } from "@m3t4/match-engine";
import { db, COLLECTIONS } from "./firestore.js";
import {
  releaseChainLock,
  tryAcquireChainLock,
} from "./match-chain.js";
import { loadActiveStables } from "./active-stables.js";
import { enqueueAt } from "./cloud-tasks.js";
import {
  normalizeStableTotals,
  publicStableDoc,
  type StableDoc,
  type StableSlotDoc,
} from "./stable-public.js";

const REGION = "us-central1";

// Cloud Tasks queue config — caller passes via env so deploy can configure
// without code edits. Default queue name is "matchchain".
const TASKS_QUEUE = process.env.MATCH_TASKS_QUEUE ?? "matchchain";
const TASKS_LOCATION = process.env.MATCH_TASKS_LOCATION ?? REGION;

// matchTick handler URL: the Function exposes itself as an HTTP endpoint
// that Cloud Tasks calls back into. Set MATCH_TICK_URL to the deployed
// Function URL during firebase deploy.
const MATCH_TICK_URL = process.env.MATCH_TICK_URL ?? "";
const TASK_INVOKER_SA = process.env.MATCH_TICK_INVOKER_SA;

export const matchTick = onRequest(
  { region: REGION, memory: "512MiB", timeoutSeconds: 60, maxInstances: 5 },
  async (req, res) => {
    const startedAt = Date.now();
    const lockerId = `matchTick-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const firestore = db();

    const lockState = await tryAcquireChainLock(firestore, lockerId, startedAt);
    if (!lockState) {
      logger.info("matchTick skipped — chain locked or paused", { lockerId });
      res.status(202).json({ skipped: "locked-or-paused" });
      return;
    }

    try {
      const active = await loadActiveStables(firestore);
      if (active.length < 2) {
        logger.warn("matchTick aborted — active pool too small", { size: active.length });
        await releaseChainLock(firestore, lockerId, Date.now(), {});
        res.status(200).json({ status: "no-pair" });
        return;
      }

      const pair = selectPair({ active });
      if (!pair) {
        logger.warn("matchTick aborted — selectPair returned null");
        await releaseChainLock(firestore, lockerId, Date.now(), {});
        res.status(200).json({ status: "no-pair" });
        return;
      }

      const matchId = `m-${startedAt.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const { match, eloAfter } = runMatch({
        matchId,
        pair: { a: pair.a, b: pair.b },
        startedAt,
      });

      // Single batch: write match doc + roster slot stats/ELO + public
      // leaderboard projections. This keeps spectate, profile, and
      // leaderboard reading the same authoritative match schedule.
      const batch = firestore.batch();
      const matchRef = firestore.collection(COLLECTIONS.matches).doc(matchId);
      batch.set(matchRef, match);

      const sideSummaries = new Map<string, StableSummary>([
        [stableKey(pair.a.userId, pair.a.slotId), pair.a],
        [stableKey(pair.b.userId, pair.b.slotId), pair.b],
      ]);
      const summaryA = sideSummaries.get(stableKey(match.a.userId, match.a.slotId)) ?? pair.a;
      const summaryB = sideSummaries.get(stableKey(match.b.userId, match.b.slotId)) ?? pair.b;
      const stableA = firestore.collection(COLLECTIONS.stables).doc(match.a.userId);
      const stableB = firestore.collection(COLLECTIONS.stables).doc(match.b.userId);
      const [stableASnap, stableBSnap] = await Promise.all([stableA.get(), stableB.get()]);
      const nextStableA = applyMatchToStable({
        existing: stableASnap.exists ? (stableASnap.data() as StableDoc) : null,
        summary: summaryA,
        slotId: match.a.slotId,
        side: 0,
        winner: match.result.winner as 0 | 1 | -1,
        elo: eloAfter.a,
        matchId,
        now: startedAt,
      });
      const nextStableB = applyMatchToStable({
        existing: stableBSnap.exists ? (stableBSnap.data() as StableDoc) : null,
        summary: summaryB,
        slotId: match.b.slotId,
        side: 1,
        winner: match.result.winner as 0 | 1 | -1,
        elo: eloAfter.b,
        matchId,
        now: startedAt,
      });
      batch.set(stableA, nextStableA);
      batch.set(stableB, nextStableB);
      batch.set(
        firestore.collection(COLLECTIONS.publicStables).doc(match.a.userId),
        publicStableDoc(nextStableA),
        { merge: true },
      );
      batch.set(
        firestore.collection(COLLECTIONS.publicStables).doc(match.b.userId),
        publicStableDoc(nextStableB),
        { merge: true },
      );
      await batch.commit();

      // Schedule the next matchTick at the precise match end time. Cloud
      // Tasks delivers within ~few seconds of scheduleAt.
      const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "";
      if (MATCH_TICK_URL && projectId) {
        try {
          await enqueueAt({
            projectId,
            location: TASKS_LOCATION,
            queue: TASKS_QUEUE,
            url: MATCH_TICK_URL,
            scheduleAtMs: match.endsAt,
            serviceAccountEmail: TASK_INVOKER_SA,
            payload: { triggeredBy: lockerId, prevMatchId: matchId },
          });
        } catch (e) {
          // Watchdog will resurrect the chain if the enqueue fails.
          logger.error("enqueueAt failed; relying on watchdog", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const consecutive = (lockState.consecutiveMatches ?? 0) + 1;
      await releaseChainLock(firestore, lockerId, Date.now(), {
        latestMatchId: matchId,
        latestStartedAt: match.startedAt,
        latestEndsAt: match.endsAt,
        consecutiveMatches: consecutive,
      });

      logger.info("matchTick complete", {
        matchId,
        durationMs: match.durationMs,
        winner: match.result.winner,
      });
      res.status(200).json({
        status: "ok",
        matchId,
        startedAt: match.startedAt,
        endsAt: match.endsAt,
        durationMs: match.durationMs,
      });
    } catch (e) {
      logger.error("matchTick failed", { error: e instanceof Error ? e.message : String(e) });
      // Best-effort lock release so the watchdog can recover sooner than
      // the lock TTL.
      try {
        await releaseChainLock(firestore, lockerId, Date.now(), {});
      } catch {
        // swallow
      }
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

function stableKey(userId: string, slotId: string): string {
  return `${userId}\n${slotId}`;
}

function applyMatchToStable(input: {
  existing: StableDoc | null;
  summary: StableSummary;
  slotId: string;
  side: 0 | 1;
  winner: 0 | 1 | -1;
  elo: number;
  matchId: string;
  now: number;
}): StableDoc {
  const { existing, summary, slotId, side, winner, elo, matchId, now } = input;
  const base: StableDoc = existing ?? {
    userId: summary.userId,
    handle: summary.handle,
    slots: [],
    lastActiveAt: now,
    updatedAt: now,
    createdAt: now,
  };
  const slots = Array.isArray(base.slots) ? [...base.slots] : [];
  let slotIdx = slots.findIndex((slot) => slot?.slotId === slotId);
  if (slotIdx < 0) {
    slotIdx = Number.isInteger(summary.slotIdx) ? Number(summary.slotIdx) : slots.length;
  }
  const prev = slots[slotIdx];
  const nextSlot: StableSlotDoc = {
    ...(prev ?? {}),
    slotIdx,
    slotId,
    name: prev?.name ?? summary.slotName,
    config: prev?.config ?? summary.config,
    cosmetics: prev?.cosmetics ?? summary.cosmetics ?? null,
    elo,
    peakElo: Math.max(numberOr(prev?.peakElo, numberOr(prev?.elo, elo)), elo),
    wins: numberOr(prev?.wins, 0) + (winner === side ? 1 : 0),
    losses: numberOr(prev?.losses, 0) + (winner !== -1 && winner !== side ? 1 : 0),
    draws: numberOr(prev?.draws, 0) + (winner === -1 ? 1 : 0),
    lastPlayedAt: now,
    submittedAt: numberOr(prev?.submittedAt, now),
    rateLockedUntil: numberOr(prev?.rateLockedUntil, 0),
  };
  slots[slotIdx] = nextSlot;
  return normalizeStableTotals({
    ...base,
    userId: summary.userId,
    handle: summary.handle,
    slots,
    lastActiveAt: now,
    updatedAt: now,
    createdAt: base.createdAt ?? now,
    lastMatchId: matchId,
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
