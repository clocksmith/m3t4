// matchTickWatchdog: periodic safety net. Reads the match chain head and
// kicks matchTick if the chain looks dead. Fires every 30s via Cloud
// Scheduler (configured in firebase.json or via gcloud).

import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { db } from "./firestore.js";
import { getChainState } from "./match-chain.js";
import { enqueueAt } from "./cloud-tasks.js";

const REGION = "us-central1";

const TASKS_QUEUE = process.env.MATCH_TASKS_QUEUE ?? "matchchain";
const TASKS_LOCATION = process.env.MATCH_TASKS_LOCATION ?? REGION;
const MATCH_TICK_URL = process.env.MATCH_TICK_URL ?? "";
const TASK_INVOKER_SA = process.env.MATCH_TICK_INVOKER_SA;

// Grace period after the predicted endsAt before we consider the chain
// stalled. Default 60s — gives Cloud Tasks delivery a chance.
const STALL_GRACE_MS = Number(process.env.MATCH_CHAIN_STALL_GRACE_MS ?? 60_000);

export const matchTickWatchdog = onSchedule(
  { region: REGION, schedule: "every 30 seconds", memory: "256MiB", timeoutSeconds: 30 },
  async () => {
    const firestore = db();
    const now = Date.now();
    const state = await getChainState(firestore);

    if (state.paused) {
      logger.info("watchdog: chain paused, skipping");
      return;
    }

    // Chain is healthy if a match is live or just barely ended.
    const stalled = state.latestEndsAt + STALL_GRACE_MS < now;
    const locked = state.lockedUntil > now;

    if (!stalled) {
      return;
    }
    if (locked) {
      // Some matchTick instance still holds the lock. Don't kick.
      return;
    }

    if (!MATCH_TICK_URL) {
      logger.warn("watchdog: MATCH_TICK_URL not configured; cannot kick chain");
      return;
    }

    const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "";
    if (!projectId) {
      logger.warn("watchdog: project id not available");
      return;
    }

    try {
      await enqueueAt({
        projectId,
        location: TASKS_LOCATION,
        queue: TASKS_QUEUE,
        url: MATCH_TICK_URL,
        scheduleAtMs: now + 1_000,
        serviceAccountEmail: TASK_INVOKER_SA,
        payload: { triggeredBy: "watchdog", reason: "stalled-chain" },
      });
      logger.info("watchdog: kicked matchTick", {
        latestEndsAt: state.latestEndsAt,
        nowMinusEndsAt: now - state.latestEndsAt,
      });
    } catch (e) {
      logger.error("watchdog: enqueue failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
);
