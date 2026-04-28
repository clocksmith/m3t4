// bootstrapMatch: HTTP-callable that kicks the chain. Use after deploy or
// after `pause` to start a fresh match without waiting for the watchdog.
//
// Auth: requires Firebase ID token (admin claim) so anonymous users
// cannot trigger arbitrary tick storms.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { enqueueAt } from "./cloud-tasks.js";

const REGION = "us-central1";

const TASKS_QUEUE = process.env.MATCH_TASKS_QUEUE ?? "matchchain";
const TASKS_LOCATION = process.env.MATCH_TASKS_LOCATION ?? REGION;
const MATCH_TICK_URL = process.env.MATCH_TICK_URL ?? "";
const TASK_INVOKER_SA = process.env.MATCH_TICK_INVOKER_SA;

export const bootstrapMatch = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 30 },
  async (req) => {
    const claims = req.auth?.token;
    if (!claims?.admin) {
      throw new HttpsError("permission-denied", "admin claim required");
    }
    if (!MATCH_TICK_URL) {
      throw new HttpsError("failed-precondition", "MATCH_TICK_URL env not set");
    }
    const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "";
    if (!projectId) {
      throw new HttpsError("failed-precondition", "project id not available");
    }
    const now = Date.now();
    try {
      const taskName = await enqueueAt({
        projectId,
        location: TASKS_LOCATION,
        queue: TASKS_QUEUE,
        url: MATCH_TICK_URL,
        scheduleAtMs: now + 1_000,
        serviceAccountEmail: TASK_INVOKER_SA,
        payload: { triggeredBy: "bootstrapMatch", admin: claims.email ?? "?" },
      });
      logger.info("bootstrapMatch enqueued", { taskName });
      return { ok: true, taskName, scheduledAt: now + 1_000 };
    } catch (e) {
      logger.error("bootstrapMatch failed", { error: e instanceof Error ? e.message : String(e) });
      throw new HttpsError("internal", e instanceof Error ? e.message : String(e));
    }
  },
);
