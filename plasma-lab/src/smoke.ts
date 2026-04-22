import http from "node:http";
import { handleComputeLabRequest } from "./routes.js";
import { type PlasmaLabConfig } from "./config.js";
import { json } from "./http.js";
import { runPublicArtifactVerify } from "./kernels/public-artifact-verify.js";
import { canonicalJson, sha256 } from "./plasma/hash.js";
import type { ContentHash, WorkerCapability } from "./plasma/types.js";
import { ComputeLabStore } from "./store.js";

const ADMIN_TOKEN = process.env.PLASMA_LAB_SMOKE_ADMIN_TOKEN ?? process.env.PLASMA_LAB_ADMIN_TOKEN ?? "smoke";
const REMOTE_ORIGIN = process.env.PLASMA_LAB_SMOKE_ORIGIN;

interface SmokeServer {
  origin: string;
  close: () => Promise<void>;
}

interface RegisteredWorker {
  workerId: string;
  workerSessionId: string;
  workerSessionToken: string;
}

interface NextAssignment {
  assignment: {
    assignmentId: string;
    assignmentToken: string;
  };
  chunk: {
    chunkId: string;
    kernelId: string;
    kernelHash: ContentHash;
    inputHash: ContentHash;
    artifactHash?: ContentHash;
    params?: Record<string, unknown>;
  };
  task: {
    taskId: string;
    kind: string;
  };
  idle?: boolean;
}

const capability: WorkerCapability = {
  kernels: ["m3t4.public_artifact_verify.v0"],
  runtimeSurfaces: ["cpu-reference"],
  maxChunkBytes: 1024 * 1024,
  maxConcurrentChunks: 1,
  deviceClass: "smoke",
  clientVersion: "smoke",
};

async function main(): Promise<void> {
  const server = REMOTE_ORIGIN
    ? { origin: REMOTE_ORIGIN.replace(/\/$/, ""), close: async () => undefined }
    : await startLocalServer();

  try {
    const matchId = `smoke-${Date.now()}`;
    const payload = {
      matchId,
      tuple: {
        matchId,
        expectedLogHash: "smoke",
      },
    };
    const artifactJson = canonicalJson(payload);
    const artifactSha256 = sha256(artifactJson).value;

    const seeded = await post<{ taskId: string; chunks: number }>(server.origin, "/compute/admin/tasks/public-artifact", {
      artifact: {
        matchId,
        artifactHash: `smoke-artifact-${matchId}`,
        artifactSha256,
        payload,
      },
    }, { "x-plasma-admin-token": ADMIN_TOKEN });
    if (seeded.chunks !== 1) throw new Error(`expected 1 smoke chunk, got ${seeded.chunks}`);

    const w1 = await register(server.origin);
    const w2 = await register(server.origin);
    const n1 = await next(server.origin, w1);
    const n2 = await next(server.origin, w2);
    await accept(server.origin, w1, n1);
    await accept(server.origin, w2, n2);

    const r1 = await receipt(server.origin, w1, n1);
    if (r1.receipt?.decision !== "pending") throw new Error(`first receipt was ${r1.receipt?.decision ?? "missing"}`);
    const r2 = await receipt(server.origin, w2, n2);
    if (r2.receipt?.decision !== "accepted" || r2.validation?.status !== "accepted") {
      throw new Error(`second receipt failed validation: ${JSON.stringify(r2)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      origin: server.origin,
      taskId: seeded.taskId,
      firstReceipt: r1.receipt.receiptId,
      secondReceipt: r2.receipt.receiptId,
      validationId: r2.validation.validationId,
    }, null, 2));
  } finally {
    await server.close();
  }
}

async function startLocalServer(): Promise<SmokeServer> {
  const config: PlasmaLabConfig = {
    port: 0,
    storeBackend: "memory",
    routesEnabled: true,
    taskAdminEnabled: true,
    acceptAssignments: true,
    webrtcSignalingEnabled: false,
    webrtcDataEnabled: false,
    webrtcTurnEnabled: false,
    stunUrls: [],
    turnUrls: [],
    adminToken: ADMIN_TOKEN,
    assignmentTimeoutMs: 60_000,
    workerSessionTtlMs: 60_000,
    webrtcSessionTtlMs: 60_000,
    requireReceiptSignatures: false,
  };
  const store = new ComputeLabStore({
    acceptAssignments: config.acceptAssignments,
    assignmentTimeoutMs: config.assignmentTimeoutMs,
    workerSessionTtlMs: config.workerSessionTtlMs,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (await handleComputeLabRequest(req, res, url, { store, config })) return;
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") throw new Error("smoke server did not bind");
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function register(origin: string): Promise<RegisteredWorker> {
  return post<RegisteredWorker>(origin, "/compute/workers/register", {
    label: "plasma-lab-reference:smoke",
    capability,
  }, { "x-plasma-admin-token": ADMIN_TOKEN });
}

async function next(origin: string, worker: RegisteredWorker): Promise<NextAssignment> {
  const result = await get<NextAssignment>(
    origin,
    `/compute/tasks/next?workerId=${encodeURIComponent(worker.workerId)}&workerSessionId=${encodeURIComponent(worker.workerSessionId)}`,
    { "x-worker-session-token": worker.workerSessionToken },
  );
  if (result.idle) throw new Error("smoke worker received no assignment");
  if (result.task.kind !== "m3t4.public_artifact_verify.v0") throw new Error(`unexpected task kind ${result.task.kind}`);
  return result;
}

async function accept(origin: string, worker: RegisteredWorker, nextBody: NextAssignment): Promise<void> {
  const result = await post<{ ok: boolean }>(origin, "/compute/assignments/accept", {
    ...worker,
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  if (!result.ok) throw new Error("smoke assignment was not accepted");
}

async function receipt(origin: string, worker: RegisteredWorker, nextBody: NextAssignment): Promise<any> {
  const artifactJson = nextBody.chunk.params?.artifactJson;
  if (typeof artifactJson !== "string") throw new Error("assignment chunk missing artifactJson");
  const out = runPublicArtifactVerify({ artifactJson });
  return post(origin, "/compute/receipts", {
    ...worker,
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    kernelId: nextBody.chunk.kernelId,
    kernelHash: nextBody.chunk.kernelHash,
    inputHash: nextBody.chunk.inputHash,
    artifactHash: nextBody.chunk.artifactHash,
    outputHash: out.outputHash,
    determinismClass: "bit-exact",
    validationMode: "expected-hash",
    executionMode: "cpu",
    transport: "http",
    governorMode: "quiet",
    deviceClass: "smoke",
    computeMs: 1,
    clientVersion: "smoke",
  });
}

async function get<T>(origin: string, path: string, headers: Record<string, string> = {}): Promise<T> {
  return request<T>(origin, path, { method: "GET", headers });
}

async function post<T>(origin: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  return request<T>(origin, path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function request<T>(origin: string, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${origin}${path}`, init);
  const raw = await res.text();
  const body = raw ? JSON.parse(raw) : null;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${raw}`);
  return body as T;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
