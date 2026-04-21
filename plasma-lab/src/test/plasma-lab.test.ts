import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { handleComputeLabRequest } from "../routes.js";
import { ComputeLabStore, type ComputeLabSnapshot, referencePrimeReceiptFields, referenceReceiptFields } from "../store.js";
import type { PlasmaLabConfig } from "../config.js";
import { json } from "../http.js";
import type { WorkerCapability } from "../plasma/types.js";
import { canonicalJson, sha256 } from "../plasma/hash.js";
import { PersistentComputeLabStore } from "../persistent-store.js";
import { runSeedSweep } from "../kernels/seed-sweep.js";

const baseConfig: PlasmaLabConfig = {
  port: 0,
  storeBackend: "memory",
  routesEnabled: true,
  taskAdminEnabled: true,
  acceptAssignments: true,
  webrtcSignalingEnabled: false,
  webrtcDataEnabled: false,
  assignmentTimeoutMs: 60_000,
  workerSessionTtlMs: 60_000,
  webrtcSessionTtlMs: 60_000,
};

const capability: WorkerCapability = {
  kernels: ["prime-search.v0", "m3t4.public_artifact_verify.v0", "m3t4.seed_sweep.v0"],
  runtimeSurfaces: ["cpu-reference"],
  maxChunkBytes: 1024 * 1024,
  maxConcurrentChunks: 1,
  deviceClass: "test",
  clientVersion: "test",
};

const webgpuCapability: WorkerCapability = {
  ...capability,
  runtimeSurfaces: ["browser-js", "browser-webgpu"],
  deviceClass: "desktop-high",
  adapterInfo: {
    userAgentBucket: "chromium",
    webgpu: "available",
    gpuVendorBucket: "apple",
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

test("prime-search receipts require two expected-hash executions before acceptance", () => {
  const now = clock();
  const store = new ComputeLabStore({
    now,
    acceptAssignments: true,
    assignmentTimeoutMs: 60_000,
    workerSessionTtlMs: 60_000,
  });
  const task = store.seedPrimeTask({ start: 100, endExclusive: 140, chunkSize: 40 });
  const w1 = store.registerWorker({ capability });
  const w2 = store.registerWorker({ capability });
  const a1 = store.assignNext(auth(w1))!;
  const a2 = store.assignNext(auth(w2))!;

  assert.equal(a1.chunk.chunkId, task.chunks[0].chunkId);
  assert.equal(a2.chunk.chunkId, task.chunks[0].chunkId);
  store.acceptAssignment({ ...auth(w1), assignmentId: a1.assignment.assignmentId, assignmentToken: a1.assignment.assignmentToken });
  store.acceptAssignment({ ...auth(w2), assignmentId: a2.assignment.assignmentId, assignmentToken: a2.assignment.assignmentToken });

  const first = store.submitReceipt({
    ...auth(w1),
    assignmentId: a1.assignment.assignmentId,
    assignmentToken: a1.assignment.assignmentToken,
    taskId: a1.task.taskId,
    chunkId: a1.chunk.chunkId,
    ...referencePrimeReceiptFields(a1.chunk),
    executionMode: "cpu",
    transport: "http",
    governorMode: "quiet",
    computeMs: 3,
  });
  assert.equal(first.receipt.decision, "pending");
  assert.equal(first.validation, undefined);

  const second = store.submitReceipt({
    ...auth(w2),
    assignmentId: a2.assignment.assignmentId,
    assignmentToken: a2.assignment.assignmentToken,
    taskId: a2.task.taskId,
    chunkId: a2.chunk.chunkId,
    ...referencePrimeReceiptFields(a2.chunk),
    executionMode: "cpu",
    transport: "http",
    governorMode: "quiet",
    computeMs: 4,
  });
  assert.equal(second.receipt.decision, "accepted");
  assert.equal(second.validation?.status, "accepted");
  assert.equal(store.getReceipt(first.receipt.receiptId)?.decision, "accepted");
  assert.equal(store.getTask(task.taskId)?.status, "complete");
  assert.equal(store.workerStatus(w1.worker.workerId)?.reputation.accepted, 1);
  assert.equal(store.workerStatus(w2.worker.workerId)?.reputation.accepted, 1);
});

test("receipt submission rejects assignment token mismatches", () => {
  const now = clock();
  const store = new ComputeLabStore({ now, acceptAssignments: true });
  store.seedPrimeTask({ start: 10, endExclusive: 20, chunkSize: 10 });
  const worker = store.registerWorker({ capability });
  const next = store.assignNext(auth(worker))!;
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: next.assignment.assignmentId,
    assignmentToken: "bad-token",
    taskId: next.task.taskId,
    chunkId: next.chunk.chunkId,
    ...referencePrimeReceiptFields(next.chunk),
    executionMode: "cpu",
    transport: "http",
    computeMs: 1,
  });
  assert.equal(result.receipt.decision, "assignment-mismatch");
  assert.equal(store.workerStatus(worker.worker.workerId)?.reputation.rejected, 1);
});

test("public artifact verification receipts accept exported artifact hashes", () => {
  const now = clock();
  const store = new ComputeLabStore({ now, acceptAssignments: true });
  const payload = {
    matchId: "m1",
    tuple: { matchId: "m1", expectedLogHash: "abc123" },
  };
  const artifactJson = canonicalJson(payload);
  const task = store.seedPublicArtifactVerifyTask({
    matchId: "m1",
    artifactHash: "artifact-fnv",
    artifactSha256: sha256(artifactJson).value,
    artifactJson,
  });
  const w1 = store.registerWorker({ capability });
  const w2 = store.registerWorker({ capability });
  const a1 = store.assignNext(auth(w1))!;
  const a2 = store.assignNext(auth(w2))!;

  assert.equal(a1.task.kind, "m3t4.public_artifact_verify.v0");
  assert.equal(a1.chunk.chunkId, task.chunks[0].chunkId);
  store.acceptAssignment({ ...auth(w1), assignmentId: a1.assignment.assignmentId, assignmentToken: a1.assignment.assignmentToken });
  store.acceptAssignment({ ...auth(w2), assignmentId: a2.assignment.assignmentId, assignmentToken: a2.assignment.assignmentToken });

  const first = store.submitReceipt({
    ...auth(w1),
    assignmentId: a1.assignment.assignmentId,
    assignmentToken: a1.assignment.assignmentToken,
    taskId: a1.task.taskId,
    chunkId: a1.chunk.chunkId,
    ...referenceReceiptFields(a1.chunk),
    executionMode: "cpu",
    transport: "http",
    computeMs: 1,
  });
  assert.equal(first.receipt.decision, "pending");

  const second = store.submitReceipt({
    ...auth(w2),
    assignmentId: a2.assignment.assignmentId,
    assignmentToken: a2.assignment.assignmentToken,
    taskId: a2.task.taskId,
    chunkId: a2.chunk.chunkId,
    ...referenceReceiptFields(a2.chunk),
    executionMode: "cpu",
    transport: "http",
    computeMs: 1,
  });
  assert.equal(second.receipt.decision, "accepted");
  assert.equal(second.validation?.status, "accepted");
});

test("seed sweep receipts accept deterministic public preset batches", () => {
  const now = clock();
  const store = new ComputeLabStore({ now, acceptAssignments: true });
  const task = store.seedSeedSweepTask({
    stageId: "boardroom",
    brainA: "unicorn",
    brainB: "disruptor",
    seedStart: 10,
    seedEndExclusive: 14,
    seedChunkSize: 4,
  });
  const w1 = store.registerWorker({ capability });
  const w2 = store.registerWorker({ capability });
  const a1 = store.assignNext(auth(w1))!;
  const a2 = store.assignNext(auth(w2))!;
  assert.equal(a1.task.kind, "m3t4.seed_sweep.v0");
  assert.equal(a1.chunk.chunkId, task.chunks[0].chunkId);
  assert.equal(runSeedSweep(a1.chunk.params as any).outputHash.value, a1.chunk.expectedOutputHash.value);

  store.acceptAssignment({ ...auth(w1), assignmentId: a1.assignment.assignmentId, assignmentToken: a1.assignment.assignmentToken });
  store.acceptAssignment({ ...auth(w2), assignmentId: a2.assignment.assignmentId, assignmentToken: a2.assignment.assignmentToken });
  const first = store.submitReceipt({
    ...auth(w1),
    assignmentId: a1.assignment.assignmentId,
    assignmentToken: a1.assignment.assignmentToken,
    taskId: a1.task.taskId,
    chunkId: a1.chunk.chunkId,
    ...referenceReceiptFields(a1.chunk),
    executionMode: "cpu",
    transport: "http",
    computeMs: 10,
  });
  assert.equal(first.receipt.decision, "pending");
  const second = store.submitReceipt({
    ...auth(w2),
    assignmentId: a2.assignment.assignmentId,
    assignmentToken: a2.assignment.assignmentToken,
    taskId: a2.task.taskId,
    chunkId: a2.chunk.chunkId,
    ...referenceReceiptFields(a2.chunk),
    executionMode: "cpu",
    transport: "http",
    computeMs: 11,
  });
  assert.equal(second.receipt.decision, "accepted");
  assert.equal(second.validation?.status, "accepted");
});

test("persistent store saves and restores compute snapshots", async () => {
  let saved: Partial<ComputeLabSnapshot> = {};
  const persistence = {
    load: async () => saved,
    save: async (snapshot: ComputeLabSnapshot) => {
      saved = snapshot;
    },
  };
  const store = await PersistentComputeLabStore.create({ acceptAssignments: true }, persistence);
  const task = store.seedPrimeTask({ start: 10, endExclusive: 30, chunkSize: 20 });
  store.registerWorker({ capability });
  await store.flush();

  assert.equal(saved.tasks?.length, 1);
  assert.equal(saved.workers?.length, 1);

  const restored = await PersistentComputeLabStore.create({ acceptAssignments: true }, persistence);
  assert.equal(restored.getTask(task.taskId)?.chunks.length, 1);
  assert.equal(restored.summary().workers, 1);
});

test("dashboard aggregates bucketed capability map", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  store.registerWorker({ capability: webgpuCapability });
  const dashboard = store.dashboard() as any;
  assert.equal(dashboard.capabilityMap.webgpu.available, 1);
  assert.equal(dashboard.capabilityMap.gpuVendorBucket.apple, 1);
  assert.equal(dashboard.capabilityMap.webgpuCorrectness.ok, 1);
  assert.equal(dashboard.capabilityMap.canvas2dFixture.ok, 1);
  assert.equal(dashboard.capabilityMap.webgpuThroughputBucket["1m+/s"], 1);
  assert.equal(dashboard.capabilityObservationMap.webgpuCorrectness.ok, 1);
  assert.equal(dashboard.workerList[0].adapterInfo.webgpuBenchmark, "ok");
});

test("device witness connectivity observations stay bucketed and aggregate for admin", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const worker = store.registerWorker({ capability: webgpuCapability });
  const observation = store.submitConnectivityObservation({
    ...auth(worker),
    observation: {
      transport: "webrtc-local",
      status: "ok",
      mode: "quiet",
      networkTypeBucket: "4g",
      downlinkBucket: "20-99mbps",
      rttBucket: "20-50ms",
      webrtcOpenMsBucket: "10-20ms",
      iceGatherMsBucket: "20-50ms",
      iceHostBucket: "yes",
      iceSrflxBucket: "no",
      iceRelayBucket: "no",
      stunSuccessBucket: "unconfigured",
      turnNeedBucket: "unknown",
      visibilityBucket: "visible",
      batteryBucket: "charging",
      notes: "opaque raw candidate should be discarded 192.168.1.10",
    },
  });
  assert.equal(observation.workerId, worker.worker.workerId);
  assert.equal(observation.notes, "other");
  const dashboard = store.dashboard() as any;
  assert.equal(dashboard.connectivityMap.transport["webrtc-local"], 1);
  assert.equal(dashboard.connectivityMap.iceHostBucket.yes, 1);
  assert.equal(dashboard.connectivityMap.networkTypeBucket["4g"], 1);
});

test("HTTP routes keep admin task creation behind the admin flag", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, taskAdminEnabled: false });
  t.after(() => srv.close());

  const resp = await req(srv.port, "POST", "/compute/admin/tasks/seed", {
    kind: "prime-search.v0",
  });
  assert.equal(resp.status, 403);
});

test("HTTP admin routes require the plasma admin token", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, adminToken: "secret" });
  t.after(() => srv.close());

  const missing = await req(srv.port, "POST", "/compute/admin/tasks/seed", {
    kind: "prime-search.v0",
  });
  assert.equal(missing.status, 403);

  const seeded = await req(
    srv.port,
    "POST",
    "/compute/admin/tasks/seed",
    { kind: "prime-search.v0", start: 10, endExclusive: 20, chunkSize: 5 },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(seeded.status, 200);
  assert.equal(seeded.body.chunks, 2);
});

test("HTTP admin can seed public artifact verification from exported artifact", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, adminToken: "secret" });
  t.after(() => srv.close());
  const payload = {
    matchId: "m2",
    tuple: { matchId: "m2", expectedLogHash: "ff00" },
  };
  const artifact = {
    matchId: "m2",
    artifactHash: "artifact-fnv",
    artifactSha256: sha256(canonicalJson(payload)).value,
    payload,
  };

  const seeded = await req(
    srv.port,
    "POST",
    "/compute/admin/tasks/public-artifact",
    { artifact },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(seeded.status, 200);
  assert.equal(seeded.body.chunks, 1);

  const worker = await register(srv.port);
  const n = await next(srv.port, worker);
  assert.equal(n.task.kind, "m3t4.public_artifact_verify.v0");
});

test("HTTP admin can seed public preset seed sweeps", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, adminToken: "secret" });
  t.after(() => srv.close());

  const seeded = await req(
    srv.port,
    "POST",
    "/compute/admin/tasks/seed-sweep",
    {
      stageId: "boardroom",
      brainA: "unicorn",
      brainB: "disruptor",
      seedStart: 1,
      seedEndExclusive: 9,
      seedChunkSize: 4,
    },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(seeded.status, 200);
  assert.equal(seeded.body.chunks, 2);

  const worker = await register(srv.port);
  const n = await next(srv.port, worker);
  assert.equal(n.task.kind, "m3t4.seed_sweep.v0");
});

test("HTTP admin can toggle assignment acceptance without redeploying", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: false });
  store.seedPrimeTask({ start: 20, endExclusive: 50, chunkSize: 30 });
  const srv = await boot(store, { ...baseConfig, adminToken: "secret", acceptAssignments: false });
  t.after(() => srv.close());

  const worker = await register(srv.port);
  const idle = await req(
    srv.port,
    "GET",
    `/compute/tasks/next?workerId=${worker.workerId}&workerSessionId=${worker.workerSessionId}`,
    undefined,
    { "x-worker-session-token": worker.workerSessionToken },
  );
  assert.equal(idle.body.reason, "assignments-disabled");

  const enabled = await req(
    srv.port,
    "POST",
    "/compute/admin/assignments",
    { acceptAssignments: true },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.acceptAssignments, true);

  const nextBody = await next(srv.port, worker);
  assert.equal(nextBody.task.kind, "prime-search.v0");

  const disabled = await req(
    srv.port,
    "POST",
    "/compute/admin/assignments",
    { acceptAssignments: false },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.acceptAssignments, false);
});

test("HTTP compute routes are disabled behind the lab route flag", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, routesEnabled: false });
  t.after(() => srv.close());

  const health = await req(srv.port, "GET", "/healthz");
  assert.equal(health.status, 200);

  const resp = await req(srv.port, "GET", "/compute/status");
  assert.equal(resp.status, 404);
});

test("HTTP use case registry reports implemented advisory workloads", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, baseConfig);
  t.after(() => srv.close());

  const resp = await req(srv.port, "GET", "/compute/use-cases");
  assert.equal(resp.status, 200);
  assert.ok(resp.body.useCases.some((useCase: any) =>
    useCase.id === "replay-verification" &&
    useCase.workload === "m3t4.public_artifact_verify.v0" &&
    useCase.authority === "advisory"
  ));
  assert.ok(resp.body.useCases.some((useCase: any) =>
    useCase.id === "seed-sweeps" &&
    useCase.workload === "m3t4.seed_sweep.v0"
  ));
  assert.ok(resp.body.useCases.some((useCase: any) => useCase.id === "device-witness-webgpu"));
  assert.ok(resp.body.useCases.some((useCase: any) => useCase.id === "device-witness-webrtc"));
  assert.ok(resp.body.useCases.some((useCase: any) => useCase.id === "device-witness-render-fixtures"));
});

test("HTTP device witness observations are collected but maps are admin-only", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, adminToken: "secret" });
  t.after(() => srv.close());

  const worker = await register(srv.port);
  const posted = await req(srv.port, "POST", "/compute/connectivity", {
    ...worker,
    transport: "http",
    status: "ok",
    mode: "quiet",
    networkTypeBucket: "4g",
    downlinkBucket: "20-99mbps",
    rttBucket: "20-50ms",
    httpRttBucket: "10-20ms",
    visibilityBucket: "visible",
    batteryBucket: "charging",
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.ok, true);

  const publicMap = await req(srv.port, "GET", "/compute/connectivity-map");
  assert.equal(publicMap.status, 404);

  const noToken = await req(srv.port, "GET", "/compute/admin/connectivity-map");
  assert.equal(noToken.status, 403);

  const adminMap = await req(
    srv.port,
    "GET",
    "/compute/admin/connectivity-map",
    undefined,
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(adminMap.status, 200);
  assert.equal(adminMap.body.map.transport.http, 1);
  assert.equal(adminMap.body.map.httpRttBucket["10-20ms"], 1);
});

test("WebRTC signaling routes are disabled behind the signaling flag", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, baseConfig);
  t.after(() => srv.close());

  const resp = await req(srv.port, "POST", "/compute/webrtc/sessions", {});
  assert.equal(resp.status, 404);
});

test("WebRTC signaling stores opaque offer answer and candidate payloads", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true, webrtcSessionTtlMs: 60_000 });
  const srv = await boot(store, { ...baseConfig, webrtcSignalingEnabled: true, webrtcDataEnabled: true });
  t.after(() => srv.close());

  const session = await req(srv.port, "POST", "/compute/webrtc/sessions", {});
  assert.equal(session.status, 200);
  assert.equal(session.body.dataEnabled, true);
  assert.ok(session.body.channels.includes("plasma-data"));

  const token = session.body.sessionToken;
  const headers = { "x-webrtc-session-token": token };
  const offer = await req(srv.port, "POST", `/compute/webrtc/sessions/${session.body.sessionId}/offer`, {
    offer: { type: "offer", sdp: "opaque-offer" },
  }, headers);
  assert.equal(offer.status, 200);
  assert.equal(offer.body.offer.sdp, "opaque-offer");

  const answer = await req(srv.port, "POST", `/compute/webrtc/sessions/${session.body.sessionId}/answer`, {
    answer: { type: "answer", sdp: "opaque-answer" },
  }, headers);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.answer.sdp, "opaque-answer");

  const candidates = await req(srv.port, "POST", `/compute/webrtc/sessions/${session.body.sessionId}/candidates`, {
    peerId: "peer-a",
    candidates: [{ candidate: "candidate-a" }, { candidate: "candidate-b" }],
  }, headers);
  assert.equal(candidates.status, 200);
  assert.equal(candidates.body.candidates.length, 2);

  const fetched = await req(
    srv.port,
    "GET",
    `/compute/webrtc/sessions/${session.body.sessionId}/candidates`,
    undefined,
    headers,
  );
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.candidates[0].payload.candidate, "candidate-a");

  const bad = await req(srv.port, "GET", `/compute/webrtc/sessions/${session.body.sessionId}/candidates`, undefined, {
    "x-webrtc-session-token": "wrong",
  });
  assert.equal(bad.status, 400);
});

test("HTTP task assignment is disabled behind the assignment kill switch", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: false });
  store.seedPrimeTask({ start: 20, endExclusive: 50, chunkSize: 30 });
  const srv = await boot(store, { ...baseConfig, acceptAssignments: false });
  t.after(() => srv.close());

  const worker = await register(srv.port);
  const resp = await req(
    srv.port,
    "GET",
    `/compute/tasks/next?workerId=${worker.workerId}&workerSessionId=${worker.workerSessionId}`,
    undefined,
    { "x-worker-session-token": worker.workerSessionToken },
  );
  assert.equal(resp.status, 200);
  assert.equal(resp.body.idle, true);
  assert.equal(resp.body.reason, "assignments-disabled");
});

test("HTTP worker flow issues assignment-bound receipts", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedPrimeTask({ start: 20, endExclusive: 50, chunkSize: 30 });
  const srv = await boot(store, { ...baseConfig, adminToken: "secret" });
  t.after(() => srv.close());

  const w1 = await register(srv.port);
  const w2 = await register(srv.port);
  const n1 = await next(srv.port, w1);
  const n2 = await next(srv.port, w2);
  assert.equal(n1.chunk.chunkId, task.chunks[0].chunkId);
  assert.equal(n2.chunk.chunkId, task.chunks[0].chunkId);

  await accept(srv.port, w1, n1.assignment.assignmentId, n1.assignment.assignmentToken);
  await accept(srv.port, w2, n2.assignment.assignmentId, n2.assignment.assignmentToken);

  const r1 = await receipt(srv.port, w1, n1);
  assert.equal(r1.receipt.decision, "pending");
  const r2 = await receipt(srv.port, w2, n2);
  assert.equal(r2.receipt.decision, "accepted");
  assert.equal(r2.validation.status, "accepted");

  const publicReceipt = await req(srv.port, "GET", `/compute/receipts/${r2.receipt.receiptId}`);
  assert.equal(publicReceipt.status, 404);
  const adminReceipt = await req(
    srv.port,
    "GET",
    `/compute/admin/receipts/${r2.receipt.receiptId}`,
    undefined,
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(adminReceipt.status, 200);
  assert.equal(adminReceipt.body.receiptId, r2.receipt.receiptId);
});

function clock(): () => number {
  let now = 1_000_000;
  return () => now++;
}

function auth(reg: ReturnType<ComputeLabStore["registerWorker"]>) {
  return {
    workerId: reg.worker.workerId,
    workerSessionId: reg.session.workerSessionId,
    workerSessionToken: reg.session.token,
  };
}

async function boot(
  store: ComputeLabStore,
  config: PlasmaLabConfig,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (await handleComputeLabRequest(request, response, url, { store, config })) return;
    json(response, 404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function req(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        "content-type": "application/json",
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        } catch (e) {
          reject(e);
        }
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function register(port: number) {
  const resp = await req(port, "POST", "/compute/workers/register", { capability });
  assert.equal(resp.status, 200);
  return resp.body as {
    workerId: string;
    workerSessionId: string;
    workerSessionToken: string;
  };
}

async function next(port: number, worker: { workerId: string; workerSessionId: string; workerSessionToken: string }) {
  const resp = await req(
    port,
    "GET",
    `/compute/tasks/next?workerId=${worker.workerId}&workerSessionId=${worker.workerSessionId}`,
    undefined,
    { "x-worker-session-token": worker.workerSessionToken },
  );
  assert.equal(resp.status, 200);
  assert.equal(resp.body.idle, undefined);
  return resp.body;
}

async function accept(
  port: number,
  worker: { workerId: string; workerSessionId: string; workerSessionToken: string },
  assignmentId: string,
  assignmentToken: string,
) {
  const resp = await req(port, "POST", "/compute/assignments/accept", {
    ...worker,
    assignmentId,
    assignmentToken,
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.ok, true);
}

async function receipt(
  port: number,
  worker: { workerId: string; workerSessionId: string; workerSessionToken: string },
  nextBody: any,
) {
  const fields = referencePrimeReceiptFields(nextBody.chunk);
  const resp = await req(port, "POST", "/compute/receipts", {
    ...worker,
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...fields,
    executionMode: "cpu",
    transport: "http",
    governorMode: "quiet",
    computeMs: 5,
  });
  assert.equal(resp.status, 200);
  return resp.body;
}
