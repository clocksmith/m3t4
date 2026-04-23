import http from "node:http";
import { handleComputeLabRequest } from "./routes.js";
import { type PlasmaLabConfig } from "./config.js";
import { json } from "./http.js";
import {
  DEVICE_WITNESS_WEBGPU_KERNEL_ID,
  runDeviceWitnessWebGpuReference,
} from "./kernels/device-witness.js";
import {
  LOGIT_DIVERGENCE_KERNEL_ID,
  LOGIT_DIVERGENCE_LOGIT_SCALE,
  LOGIT_DIVERGENCE_MODEL_ID,
  logitDivergencePublicOutputHash,
  normalizeLogitDivergencePublicOutput,
} from "./kernels/logit-divergence.js";
import { sha256 } from "./plasma/hash.js";
import type { ContentHash, WorkerCapability } from "./plasma/types.js";
import { ComputeLabStore } from "./store.js";

const ADMIN_TOKEN = process.env.PLASMA_LAB_SMOKE_ADMIN_TOKEN ?? process.env.PLASMA_LAB_ADMIN_TOKEN ?? "smoke";
const REMOTE_ORIGIN = process.env.PLASMA_LAB_SMOKE_ORIGIN;
const PROMPT_TEXT = process.env.PLASMA_LAB_SMOKE_LOGIT_PROMPT ?? "Finish this technical note in one line: WebGPU lets browsers run";

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
  assignment: { assignmentId: string; assignmentToken: string };
  chunk: {
    chunkId: string;
    kernelId: string;
    kernelHash: ContentHash;
    inputHash: ContentHash;
    artifactHash?: ContentHash;
    params?: Record<string, unknown>;
  };
  task: { taskId: string; kind: string };
  idle?: boolean;
}

const capability: WorkerCapability = {
  kernels: [LOGIT_DIVERGENCE_KERNEL_ID, "device_witness.webgpu.v0"],
  runtimeSurfaces: ["cpu-reference", "browser-webgpu"],
  maxChunkBytes: 1024 * 1024,
  maxConcurrentChunks: 1,
  deviceClass: "smoke-logit-divergence",
  clientVersion: "smoke-logit-divergence",
  adapterInfo: {
    userAgentBucket: "chromium",
    webgpu: "available",
    gpuVendorBucket: "smoke",
    webgpuBenchmark: "ok",
    webgpuCorrectness: "ok",
    webgpuMismatchBucket: "0",
    webgpuKernelMsBucket: "2-5ms",
    webgpuThroughputBucket: "1m+/s",
    workerFixture: "ok",
    canvas2dFixture: "ok",
    canvas2dFixtureMsBucket: "<2ms",
    canvas2dAlphaBucket: "ok",
    frameP95Bucket: "<2ms",
    batteryBucket: "charging",
    visibilityBucket: "visible",
  },
};

async function main(): Promise<void> {
  const server = REMOTE_ORIGIN
    ? { origin: REMOTE_ORIGIN.replace(/\/$/, ""), close: async () => undefined }
    : await startLocalServer();

  try {
    const seeded = await post<{ taskId: string; chunks: number; validationPolicy: { determinismClass: string; validationMode: string } }>(
      server.origin,
      "/compute/admin/tasks/logit-divergence",
      { promptText: PROMPT_TEXT, topK: 4, minExecutions: 2, minAgreeing: 2 },
      { "x-plasma-admin-token": ADMIN_TOKEN },
    );
    if (seeded.chunks !== 1) throw new Error(`expected 1 chunk, got ${seeded.chunks}`);
    if (seeded.validationPolicy.validationMode !== "measurement") {
      throw new Error(`expected measurement validation, got ${seeded.validationPolicy.validationMode}`);
    }

    const w1 = await register(server.origin, "A");
    const w2 = await register(server.origin, "B");
    await acceptWebGpuWitness(server.origin, w1);
    await acceptWebGpuWitness(server.origin, w2);

    const n1 = await pollNextAssignment(server.origin, w1, LOGIT_DIVERGENCE_KERNEL_ID);
    const n2 = await pollNextAssignment(server.origin, w2, LOGIT_DIVERGENCE_KERNEL_ID);
    await acceptAssignment(server.origin, w1, n1);
    await acceptAssignment(server.origin, w2, n2);

    const publicOutputA = buildPublicOutput(PROMPT_TEXT, "A");
    const publicOutputB = buildPublicOutput(PROMPT_TEXT, "B");
    const outputHashA = logitDivergencePublicOutputHash(publicOutputA);
    const outputHashB = logitDivergencePublicOutputHash(publicOutputB);

    const r1 = await submitReceipt(server.origin, w1, n1, publicOutputA, outputHashA);
    if (r1.receipt?.decision !== "pending") {
      throw new Error(`first receipt decision was ${r1.receipt?.decision ?? "missing"}, expected pending`);
    }
    const r2 = await submitReceipt(server.origin, w2, n2, publicOutputB, outputHashB);
    if (r2.receipt?.decision !== "accepted" || r2.validation?.status !== "accepted") {
      throw new Error(`cohort validation failed: ${JSON.stringify(r2)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      origin: server.origin,
      taskId: seeded.taskId,
      firstReceipt: r1.receipt.receiptId,
      secondReceipt: r2.receipt.receiptId,
      validationId: r2.validation.validationId,
      hitsA: publicOutputA.hits,
      hitsB: publicOutputB.hits,
    }, null, 2));
  } finally {
    await server.close();
  }
}

function buildPublicOutput(promptText: string, label: string) {
  const baseTopLogit = label === "A" ? 512 : 500;
  const hits = [
    { rank: 1, tokenId: 101, logitQ: baseTopLogit, deltaTopQ: 0 },
    { rank: 2, tokenId: 202, logitQ: baseTopLogit - 256, deltaTopQ: -256 },
    { rank: 3, tokenId: 303, logitQ: baseTopLogit - 384, deltaTopQ: -384 },
    { rank: 4, tokenId: 404, logitQ: baseTopLogit - 448, deltaTopQ: -448 },
  ];
  return normalizeLogitDivergencePublicOutput({
    kind: LOGIT_DIVERGENCE_KERNEL_ID,
    modelId: LOGIT_DIVERGENCE_MODEL_ID,
    promptHash: sha256(promptText).value,
    promptLength: promptText.length,
    prefillTokenCount: 8,
    topK: 4,
    logitScale: LOGIT_DIVERGENCE_LOGIT_SCALE,
    hits,
  });
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

async function register(origin: string, label: string): Promise<RegisteredWorker> {
  return post<RegisteredWorker>(origin, "/compute/workers/register", {
    label: `smoke-logit-divergence:${label}`,
    capability,
  });
}

async function acceptWebGpuWitness(origin: string, worker: RegisteredWorker): Promise<void> {
  const witnessSeed = Math.floor(Math.random() * 1_000_000);
  await post(origin, "/compute/admin/tasks/device-witness-webgpu", {
    seed: witnessSeed,
    count: 16,
    minExecutions: 1,
    minAgreeing: 1,
  }, { "x-plasma-admin-token": ADMIN_TOKEN });
  const witness = await pollNextAssignment(origin, worker, DEVICE_WITNESS_WEBGPU_KERNEL_ID);
  await acceptAssignment(origin, worker, witness);
  const params = witness.chunk.params ?? {};
  const ref = runDeviceWitnessWebGpuReference({
    seed: Number(params.seed),
    count: Number(params.count),
  });
  const result = await post<{ receipt?: { decision?: string } }>(origin, "/compute/receipts", {
    ...worker,
    assignmentId: witness.assignment.assignmentId,
    assignmentToken: witness.assignment.assignmentToken,
    taskId: witness.task.taskId,
    chunkId: witness.chunk.chunkId,
    kernelId: witness.chunk.kernelId,
    kernelHash: witness.chunk.kernelHash,
    inputHash: witness.chunk.inputHash,
    outputHash: ref.outputHash,
    determinismClass: "bit-exact",
    validationMode: "expected-hash",
    executionMode: "webgpu",
    transport: "http",
    computeMs: 3,
    adapterInfo: capability.adapterInfo,
  });
  if (result.receipt?.decision !== "accepted") {
    throw new Error(`witness receipt was ${result.receipt?.decision ?? "missing"}, expected accepted`);
  }
}

async function pollNextAssignment(
  origin: string,
  worker: RegisteredWorker,
  expectedKind: string,
  attempts = 8,
): Promise<NextAssignment> {
  for (let i = 0; i < attempts; i++) {
    const result = await get<NextAssignment>(
      origin,
      `/compute/tasks/next?workerId=${encodeURIComponent(worker.workerId)}&workerSessionId=${encodeURIComponent(worker.workerSessionId)}`,
      { "x-worker-session-token": worker.workerSessionToken },
    );
    if (!result.idle && result.task.kind === expectedKind) return result;
    if (!result.idle) continue;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`smoke worker never received assignment for ${expectedKind}`);
}

async function acceptAssignment(origin: string, worker: RegisteredWorker, nextBody: NextAssignment): Promise<void> {
  const result = await post<{ ok: boolean }>(origin, "/compute/assignments/accept", {
    ...worker,
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  if (!result.ok) throw new Error("smoke assignment was not accepted");
}

async function submitReceipt(
  origin: string,
  worker: RegisteredWorker,
  nextBody: NextAssignment,
  publicOutput: unknown,
  outputHash: ContentHash,
): Promise<any> {
  return post(origin, "/compute/receipts", {
    ...worker,
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    kernelId: nextBody.chunk.kernelId,
    kernelHash: nextBody.chunk.kernelHash,
    inputHash: nextBody.chunk.inputHash,
    outputHash,
    publicOutput,
    determinismClass: "tolerance-bounded",
    validationMode: "measurement",
    executionMode: "webgpu",
    transport: "http",
    computeMs: 18,
  });
}

async function get<T>(origin: string, path: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${origin}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T = unknown>(origin: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} -> ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
