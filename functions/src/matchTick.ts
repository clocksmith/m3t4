// matchTick: the worker. Picks a pair, simulates, persists the result,
// updates ELO, and enqueues the next matchTick at the predicted match
// end time. Idempotent via the chain-lock transaction so concurrent
// invocations (cron + Cloud Tasks delivery) don't double-run.

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { runMatch, selectPair } from "@m3t4/match-engine";
import { db, COLLECTIONS } from "./firestore.js";
import {
  releaseChainLock,
  tryAcquireChainLock,
} from "./match-chain.js";
import { loadActiveStables } from "./active-stables.js";
import { enqueueAt } from "./cloud-tasks.js";

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

      // Single batch: write match doc + ELO updates atomically.
      const batch = firestore.batch();
      const matchRef = firestore.collection(COLLECTIONS.matches).doc(matchId);
      batch.set(matchRef, match);

      const stableA = firestore.collection(COLLECTIONS.stables).doc(pair.a.userId);
      const stableB = firestore.collection(COLLECTIONS.stables).doc(pair.b.userId);
      batch.set(
        stableA,
        { lastActiveAt: startedAt, lastMatchId: matchId, lastEloA: eloAfter.a },
        { merge: true },
      );
      batch.set(
        stableB,
        { lastActiveAt: startedAt, lastMatchId: matchId, lastEloB: eloAfter.b },
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
