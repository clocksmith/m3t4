// Compute coordinator routes. Feature-flagged — registered from
// server/src/index.ts only when CONFIG.features.distributedCompute
// is on. The contract shape intentionally mirrors a subset of the
// plasma/ reference so an adapter can swap this for real Plasma
// network code later without changing the client.

import type http from "node:http";
import { json } from "../http-utils.js";
import type { RouteList } from "../routes/types.js";
import type { ComputeStore } from "./store.js";
import { knownKernels } from "./kernels.js";

interface WorkerRegistrationBody {
  label?: string;
  capability: {
    kernels: string[];
    cores: number;
    ua: string;
  };
}

interface ReceiptBody {
  workerId: string;
  chunkId: string;
  assignmentId: string;
  outputHash: string;
  computeMs: number;
}

interface TaskCreateBody {
  kind: string;
  chunks: Array<{ params: Record<string, number | string> }>;
  minExecutions?: number;
  minAgreeing?: number;
}

export interface ComputeRouteDeps {
  store: ComputeStore;
  taskAdminEnabled: boolean;
}

export function registerComputeRoutes(routes: RouteList, deps: ComputeRouteDeps): void {
  const { store, taskAdminEnabled } = deps;

  routes.push(async (req, res, url) => {
    // Capabilities / known kernels
    if (req.method === "GET" && url.pathname === "/api/compute/kernels") {
      json(res, 200, { kernels: knownKernels() });
      return true;
    }

    // Register a worker. Returns a workerId the client uses on every
    // subsequent call. No auth here on purpose — a token-based model
    // is a separate concern.
    if (req.method === "POST" && url.pathname === "/api/compute/workers/register") {
      const body = await readJson<WorkerRegistrationBody>(req);
      if (!body || !body.capability || !Array.isArray(body.capability.kernels)) {
        json(res, 400, { error: "capability.kernels required" });
        return true;
      }
      const worker = store.registerWorker({ label: body.label, capability: body.capability });
      json(res, 200, { workerId: worker.workerId, acceptedKernels: worker.capability.kernels });
      return true;
    }

    // Request the next chunk assignment. Workers poll this when idle.
    if (req.method === "GET" && url.pathname === "/api/compute/tasks/next") {
      const workerId = url.searchParams.get("workerId") ?? "";
      const next = store.assignNext(workerId);
      if (!next) {
        json(res, 200, { idle: true });
        return true;
      }
      json(res, 200, {
        assignment: next.assignment,
        chunk: {
          chunkId: next.chunk.chunkId,
          taskId: next.chunk.taskId,
          kind: next.chunk.kind,
          params: next.chunk.params,
        },
        deadlineAt: next.assignment.deadlineAt,
      });
      return true;
    }

    // Submit an execution receipt. The server computes its own
    // reference output on task-create, so this receipt is verified
    // immediately — no separate validator leg is needed for the v0
    // pipeline. A future Plasma wiring can move validation to a
    // dedicated validator-node instead.
    if (req.method === "POST" && url.pathname === "/api/compute/receipts") {
      const body = await readJson<ReceiptBody>(req);
      if (!body || !body.workerId || !body.chunkId || !body.assignmentId || !body.outputHash) {
        json(res, 400, { error: "workerId, chunkId, assignmentId, outputHash required" });
        return true;
      }
      const result = store.submitReceipt({
        workerId: body.workerId,
        chunkId: body.chunkId,
        assignmentId: body.assignmentId,
        outputHash: body.outputHash,
        computeMs: Number(body.computeMs) || 0,
      });
      json(res, 200, result);
      return true;
    }

    // Per-worker status: credits, active assignments, rep.
    if (req.method === "GET" && url.pathname === "/api/compute/workers/status") {
      const workerId = url.searchParams.get("workerId") ?? "";
      const s = store.workerStatus(workerId);
      if (!s) { json(res, 404, { error: "unknown worker" }); return true; }
      json(res, 200, s);
      return true;
    }

    // Coordinator summary — used by dashboards.
    if (req.method === "GET" && url.pathname === "/api/compute/status") {
      json(res, 200, store.summary());
      return true;
    }

    // Task creation — dev/demo surface. In production this goes
    // behind an auth check or is driven by a workload-specific
    // scheduler job, not exposed publicly. Gate it on an env var
    // rather than the main feature flag so the route can exist but
    // require explicit opt-in to create real work.
    if (req.method === "POST" && url.pathname === "/api/compute/tasks") {
      if (!taskAdminEnabled) {
        json(res, 403, { error: "task creation disabled" });
        return true;
      }
      const body = await readJson<TaskCreateBody>(req);
      if (!body || !body.kind || !Array.isArray(body.chunks)) {
        json(res, 400, { error: "kind and chunks required" });
        return true;
      }
      try {
        const task = store.createTask(body);
        json(res, 200, { taskId: task.taskId, chunks: task.chunks.length });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return true;
    }

    return false;
  });
}

async function readJson<T>(req: http.IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw) as T); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}
