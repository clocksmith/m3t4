// Cloud Tasks helper: enqueue the next matchTick invocation at a precise
// future time. Uses the project's default Cloud Tasks queue.

import { CloudTasksClient } from "@google-cloud/tasks";

let client: CloudTasksClient | null = null;
function getClient(): CloudTasksClient {
  if (!client) client = new CloudTasksClient();
  return client;
}

export interface EnqueueOptions {
  projectId: string;
  location: string;
  queue: string;
  url: string;
  payload?: unknown;
  scheduleAtMs: number; // wall-clock ms for delivery
  serviceAccountEmail?: string; // for OIDC if HTTP target requires auth
}

export async function enqueueAt(opts: EnqueueOptions): Promise<string> {
  const c = getClient();
  const parent = c.queuePath(opts.projectId, opts.location, opts.queue);
  const now = Date.now();
  const scheduleAt = Math.max(opts.scheduleAtMs, now + 1000);
  const seconds = Math.floor(scheduleAt / 1000);
  const nanos = Math.floor((scheduleAt % 1000) * 1e6);

  const httpRequest: Record<string, unknown> = {
    httpMethod: "POST",
    url: opts.url,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(opts.payload ?? {})).toString("base64"),
  };
  if (opts.serviceAccountEmail) {
    httpRequest.oidcToken = {
      serviceAccountEmail: opts.serviceAccountEmail,
      audience: opts.url,
    };
  }

  const [task] = await c.createTask({
    parent,
    task: {
      httpRequest,
      scheduleTime: { seconds: String(seconds), nanos },
    },
  });
  return task.name ?? "";
}
