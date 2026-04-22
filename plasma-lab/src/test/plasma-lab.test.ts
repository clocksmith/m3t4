import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { handleComputeLabRequest } from "../routes.js";
import { ComputeLabStore, type ComputeLabSnapshot, referencePrimeReceiptFields, referenceReceiptFields } from "../store.js";
import type { PlasmaLabConfig } from "../config.js";
import { json } from "../http.js";
import type { WorkerCapability } from "../plasma/types.js";
import { canonicalJson, hashCanonical, sha256 } from "../plasma/hash.js";
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
  webrtcTurnEnabled: false,
  stunUrls: [],
  turnUrls: [],
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
  kernels: [
    ...capability.kernels,
    "device_witness.webgpu.v0",
    "device_witness.render_fixture.v0",
    "device_witness.webrtc.v0",
    "device_witness.derived_buffer.v0",
  ],
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

test("dashboard separates WebRTC public artifact receipts from measurement receipts", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const payload = {
    matchId: "webrtc-artifact-dashboard",
    tuple: { matchId: "webrtc-artifact-dashboard", expectedLogHash: "abc123" },
  };
  const artifactJson = canonicalJson(payload);
  store.seedPublicArtifactVerifyTask({
    matchId: "webrtc-artifact-dashboard",
    artifactHash: "artifact-fnv",
    artifactSha256: sha256(artifactJson).value,
    artifactJson,
  });
  const w1 = store.registerWorker({ capability });
  const w2 = store.registerWorker({ capability });
  const a1 = store.assignNext(auth(w1))!;
  const a2 = store.assignNext(auth(w2))!;
  store.acceptAssignment({ ...auth(w1), assignmentId: a1.assignment.assignmentId, assignmentToken: a1.assignment.assignmentToken });
  store.acceptAssignment({ ...auth(w2), assignmentId: a2.assignment.assignmentId, assignmentToken: a2.assignment.assignmentToken });
  const adapterInfo = {
    transfer: "plasma-data",
    dataChannelBucket: "open",
    dataReceiptBucket: "ok",
  };
  store.submitReceipt({
    ...auth(w1),
    assignmentId: a1.assignment.assignmentId,
    assignmentToken: a1.assignment.assignmentToken,
    taskId: a1.task.taskId,
    chunkId: a1.chunk.chunkId,
    ...referenceReceiptFields(a1.chunk),
    executionMode: "cpu",
    transport: "webrtc",
    adapterInfo,
    computeMs: 1,
  });
  store.submitReceipt({
    ...auth(w2),
    assignmentId: a2.assignment.assignmentId,
    assignmentToken: a2.assignment.assignmentToken,
    taskId: a2.task.taskId,
    chunkId: a2.chunk.chunkId,
    ...referenceReceiptFields(a2.chunk),
    executionMode: "cpu",
    transport: "webrtc",
    adapterInfo,
    computeMs: 1,
  });

  const dashboard = store.dashboard() as any;
  assert.deepEqual(dashboard.receiptTransportSummary, [{
    taskKind: "m3t4.public_artifact_verify.v0",
    validationMode: "expected-hash",
    transport: "webrtc",
    transfer: "plasma-data",
    dataChannelBucket: "open",
    dataReceiptBucket: "ok",
    decision: "accepted",
    count: 2,
  }]);
});

test("public artifact verification produces replay badge summaries", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const payload = {
    matchId: "badge-1",
    tuple: { matchId: "badge-1", expectedLogHash: "abc123", simConstantsHash: "rules-1" },
    integrity: { stageHash: "stage-1" },
  };
  const artifactJson = canonicalJson(payload);
  store.seedPublicArtifactVerifyTask({
    matchId: "badge-1",
    artifactHash: "artifact-fnv",
    artifactSha256: sha256(artifactJson).value,
    artifactJson,
  });
  const w1 = store.registerWorker({ capability });
  const w2 = store.registerWorker({ capability });
  const a1 = store.assignNext(auth(w1))!;
  const a2 = store.assignNext(auth(w2))!;
  store.acceptAssignment({ ...auth(w1), assignmentId: a1.assignment.assignmentId, assignmentToken: a1.assignment.assignmentToken });
  store.acceptAssignment({ ...auth(w2), assignmentId: a2.assignment.assignmentId, assignmentToken: a2.assignment.assignmentToken });
  store.submitReceipt({
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
  store.submitReceipt({
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

  const badge = store.replayBadge("badge-1");
  assert.equal(badge?.status, "verified");
  assert.equal(badge?.agreedReceipts, 2);
  assert.equal(badge?.rulesHash, "rules-1");
  assert.equal(badge?.stageHash, "stage-1");
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

test("dashboard derives worker profiles, class profiles, and public-safe stats", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const worker = store.registerWorker({ capability: webgpuCapability });
  store.submitConnectivityObservation({
    ...auth(worker),
    observation: {
      transport: "webrtc-signaling",
      status: "ok",
      mode: "quiet",
      networkTypeBucket: "4g",
      webrtcOpenMsBucket: "10-20ms",
      iceHostBucket: "yes",
      iceSrflxBucket: "yes",
      iceRelayBucket: "no",
      stunSuccessBucket: "yes",
      turnNeedBucket: "unknown",
    },
  });

  const dashboard = store.dashboard() as any;
  assert.equal(dashboard.workerProfiles.length, 1);
  assert.equal(dashboard.workerProfiles[0].allowedWorkloadTier, "webgpu-light");
  assert.equal(dashboard.workerProfiles[0].webrtcDirectSuccessRate, 1);
  assert.equal(dashboard.deviceClassProfiles[0].classId, "desktop-high");
  assert.equal(dashboard.networkClassProfiles[0].classId, "4g");
  assert.equal(dashboard.publicStats.privacy, "full");
  assert.equal(dashboard.publicStats.webgpuSupportedPct, 100);
  assert.equal(dashboard.publicStats.webrtcDirectSuccessPct, 100);
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
      dataChannelBucket: "open",
      dataWorkBucket: "request-ok",
      dataReceiptBucket: "ok",
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
  assert.equal(dashboard.connectivityMap.dataWorkBucket["request-ok"], 1);
});

test("Device Witness WebGPU challenge validates as an assignment-bound receipt", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedDeviceWitnessWebGpuTask({ seed: 7, count: 64 });
  const worker = store.registerWorker({ capability: webgpuCapability });
  const nextBody = store.assignNext(auth(worker))!;
  assert.equal(nextBody.task.kind, "device_witness.webgpu.v0");
  assert.equal(nextBody.chunk.chunkId, task.chunks[0].chunkId);
  store.acceptAssignment({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...referenceReceiptFields(nextBody.chunk),
    executionMode: "webgpu",
    transport: "http",
    governorMode: "quiet",
    deviceClass: "desktop-high",
    adapterInfo: { webgpu: "available", webgpuCorrectness: "ok" },
    computeMs: 3,
  });
  assert.equal(result.receipt.decision, "accepted");
  assert.equal(result.validation?.status, "accepted");
  assert.equal(store.getTask(task.taskId)?.status, "complete");
});

test("Device Witness render fixture validates as an assignment-bound receipt", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedDeviceWitnessRenderTask();
  const worker = store.registerWorker({ capability: webgpuCapability });
  const nextBody = store.assignNext(auth(worker))!;
  assert.equal(nextBody.task.kind, "device_witness.render_fixture.v0");
  assert.equal(nextBody.chunk.chunkId, task.chunks[0].chunkId);
  store.acceptAssignment({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...referenceReceiptFields(nextBody.chunk),
    executionMode: "cpu",
    transport: "http",
    governorMode: "quiet",
    deviceClass: "desktop-high",
    adapterInfo: { canvas2dFixture: "ok" },
    computeMs: 2,
  });
  assert.equal(result.receipt.decision, "accepted");
  assert.equal(result.validation?.status, "accepted");
  assert.equal(store.getTask(task.taskId)?.status, "complete");
});

test("Device Witness derived buffer fixture binds source region kernel and output hashes", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedDeviceWitnessDerivedBufferTask({ seed: 5, count: 16 });
  const worker = store.registerWorker({ capability: webgpuCapability });
  const nextBody = store.assignNext(auth(worker))!;
  assert.equal(nextBody.task.kind, "device_witness.derived_buffer.v0");
  assert.equal(nextBody.chunk.chunkId, task.chunks[0].chunkId);
  store.acceptAssignment({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...referenceReceiptFields(nextBody.chunk),
    executionMode: "cpu",
    transport: "http",
    computeMs: 3,
  });
  assert.equal(result.receipt.decision, "accepted");
  assert.equal(result.validation?.status, "accepted");
  assert.equal(result.receipt.derived?.contractVersion, "derived-compute-extension.v0");
  assert.equal(
    result.receipt.derived?.sourceHashes[nextBody.chunk.params.sourceId as string]?.value,
    nextBody.chunk.params.sourceHash,
  );
  assert.equal(store.getTask(task.taskId)?.status, "complete");
});

test("Device Witness derived buffer fixture rejects mismatched derived output hash", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedDeviceWitnessDerivedBufferTask({ seed: 5, count: 16 });
  const worker = store.registerWorker({ capability: webgpuCapability });
  const nextBody = store.assignNext(auth(worker))!;
  store.acceptAssignment({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  const fields = referenceReceiptFields(nextBody.chunk);
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...fields,
    derived: {
      ...fields.derived!,
      derivedOutputHash: { algorithm: "sha256", value: "00".repeat(32) },
    },
    executionMode: "cpu",
    transport: "http",
    computeMs: 3,
  });
  assert.equal(result.receipt.decision, "output-mismatch");
  assert.equal(result.receipt.reason, "derived output hash mismatch");
  assert.notEqual(store.getTask(task.taskId)?.status, "complete");
});

test("Device Witness derived buffer fixture rejects missing source hash evidence", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedDeviceWitnessDerivedBufferTask({ seed: 5, count: 16 });
  const worker = store.registerWorker({ capability: webgpuCapability });
  const nextBody = store.assignNext(auth(worker))!;
  store.acceptAssignment({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  const fields = referenceReceiptFields(nextBody.chunk);
  const derived = {
    ...fields.derived!,
    sourceHashes: { ...fields.derived!.sourceHashes },
  };
  delete derived.sourceHashes[nextBody.chunk.params.sourceId as string];
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...fields,
    derived,
    executionMode: "cpu",
    transport: "http",
    computeMs: 3,
  });
  assert.equal(result.receipt.decision, "malformed");
  assert.equal(result.receipt.reason, "derived source hash required");
  assert.notEqual(store.getTask(task.taskId)?.status, "complete");
});

test("Device Witness derived buffer fixture rejects unknown producer kernel evidence", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedDeviceWitnessDerivedBufferTask({ seed: 5, count: 16 });
  const worker = store.registerWorker({ capability: webgpuCapability });
  const nextBody = store.assignNext(auth(worker))!;
  store.acceptAssignment({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  const fields = referenceReceiptFields(nextBody.chunk);
  const outputId = nextBody.chunk.params.outputId as string;
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...fields,
    derived: {
      ...fields.derived!,
      producerKernelHashes: {
        ...fields.derived!.producerKernelHashes,
        [outputId]: { algorithm: "sha256", value: "11".repeat(32) },
      },
    },
    executionMode: "cpu",
    transport: "http",
    computeMs: 3,
  });
  assert.equal(result.receipt.decision, "kernel-mismatch");
  assert.equal(result.receipt.reason, "derived producer kernel hash mismatch");
  assert.notEqual(store.getTask(task.taskId)?.status, "complete");
});

test("Device Witness WebRTC challenge validates as an assignment-bound measurement receipt", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const task = store.seedDeviceWitnessWebRtcTask({ timeoutMs: 500 });
  const worker = store.registerWorker({ capability: webgpuCapability });
  const nextBody = store.assignNext(auth(worker))!;
  assert.equal(nextBody.task.kind, "device_witness.webrtc.v0");
  assert.equal(nextBody.chunk.chunkId, task.chunks[0].chunkId);
  store.acceptAssignment({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
  });
  const transcript = {
    status: "ok",
    mode: "quiet",
    browserFamily: "chromium",
    deviceClass: "desktop-high",
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
    dataChannelBucket: "open",
    dataWorkBucket: "request-ok",
    dataReceiptBucket: "ok",
    visibilityBucket: "visible",
    batteryBucket: "charging",
  };
  const outputHash = hashCanonical({
    kind: nextBody.chunk.kind,
    params: nextBody.chunk.params,
    transcript,
  });
  const result = store.submitReceipt({
    ...auth(worker),
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    kernelId: nextBody.chunk.kernelId,
    kernelHash: nextBody.chunk.kernelHash,
    inputHash: nextBody.chunk.inputHash,
    outputHash,
    determinismClass: "replicated-quorum",
    validationMode: "measurement",
    executionMode: "cpu",
    transport: "webrtc",
    governorMode: "quiet",
    deviceClass: "desktop-high",
    adapterInfo: {
      ...transcript,
      rawCandidate: "candidate:1 1 udp 123 192.168.1.2 54321 typ host",
    },
    computeMs: 12,
  });
  assert.equal(result.receipt.decision, "accepted");
  assert.equal((result.receipt.adapterInfo as any).rawCandidate, undefined);
  assert.equal(result.validation?.status, "accepted");
  assert.equal(result.validation?.reason, "measurement transcript accepted");
  assert.equal(store.getTask(task.taskId)?.status, "complete");
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

test("HTTP admin can seed Device Witness receipt workloads", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, adminToken: "secret" });
  t.after(() => srv.close());

  const webgpu = await req(
    srv.port,
    "POST",
    "/compute/admin/tasks/device-witness-webgpu",
    { seed: 11, count: 32 },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(webgpu.status, 200);
  assert.equal(webgpu.body.chunks, 1);

  const render = await req(
    srv.port,
    "POST",
    "/compute/admin/tasks/device-witness-render",
    {},
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(render.status, 200);
  assert.equal(render.body.chunks, 1);

  const webrtc = await req(
    srv.port,
    "POST",
    "/compute/admin/tasks/device-witness-webrtc",
    { timeoutMs: 500 },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(webrtc.status, 200);
  assert.equal(webrtc.body.chunks, 1);
  assert.equal(webrtc.body.validationPolicy.validationMode, "measurement");

  const derived = await req(
    srv.port,
    "POST",
    "/compute/admin/tasks/device-witness-derived-buffer",
    { seed: 13, count: 16, minExecutions: 1, minAgreeing: 1 },
    { "x-plasma-admin-token": "secret" },
  );
  assert.equal(derived.status, 200);
  assert.equal(derived.body.chunks, 1);
  assert.equal(derived.body.validationPolicy.minExecutions, 1);
  assert.equal(derived.body.validationPolicy.minAgreeing, 1);

  const worker = await register(srv.port, webgpuCapability);
  const first = await next(srv.port, worker);
  assert.equal(first.task.kind, "device_witness.webgpu.v0");
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

test("HTTP derived receipts log structured evidence field status", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  store.seedDeviceWitnessDerivedBufferTask({ seed: 13, count: 16, minExecutions: 1, minAgreeing: 1 });
  const events: Record<string, any>[] = [];
  const srv = await boot(store, baseConfig, { eventLog: (event) => events.push(event) });
  t.after(() => srv.close());

  const worker = await register(srv.port, webgpuCapability);
  const nextBody = await next(srv.port, worker);
  assert.equal(nextBody.task.kind, "device_witness.derived_buffer.v0");
  await accept(srv.port, worker, nextBody.assignment.assignmentId, nextBody.assignment.assignmentToken);

  const fields = referenceReceiptFields(nextBody.chunk);
  const resp = await req(srv.port, "POST", "/compute/receipts", {
    ...worker,
    assignmentId: nextBody.assignment.assignmentId,
    assignmentToken: nextBody.assignment.assignmentToken,
    taskId: nextBody.task.taskId,
    chunkId: nextBody.chunk.chunkId,
    ...fields,
    executionMode: "cpu",
    transport: "http",
    computeMs: 5,
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.receipt.decision, "accepted");

  const event = events.find((entry) => entry.event === "plasma-lab.derived-receipt")!;
  assert.equal(event.accepted, true);
  assert.equal(event.decision, "accepted");
  assert.equal(event.validationStatus, "accepted");
  assert.deepEqual(event.derivedFields, {
    sourceFrameHash: "matches",
    bufferRegionHash: "matches",
    producerKernelHash: "matches",
    outputHash: "matches",
    derivedOutputHash: "matches",
  });
});

test("HTTP compute routes are disabled behind the lab route flag", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, { ...baseConfig, routesEnabled: false });
  t.after(() => srv.close());

  const health = await req(srv.port, "GET", "/healthz");
  assert.equal(health.status, 200);

  const computeHealth = await req(srv.port, "GET", "/compute/healthz?witness=test");
  assert.equal(computeHealth.status, 200);
  assert.equal(computeHealth.body.service, "plasma-lab");

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

test("HTTP public stats suppress detailed aggregates until enough workers exist", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const srv = await boot(store, baseConfig);
  t.after(() => srv.close());

  await register(srv.port, webgpuCapability);
  const resp = await req(srv.port, "GET", "/compute/public/stats");
  assert.equal(resp.status, 200);
  assert.equal(resp.body.privacy, "suppressed");
  assert.equal(resp.body.totalWorkers, 1);
  assert.equal(resp.body.webgpuSupportedPct, null);
});

test("HTTP public replay badge route exposes verified artifact summaries only", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const payload = {
    matchId: "route-badge-1",
    tuple: { matchId: "route-badge-1", expectedLogHash: "abc123", simConstantsHash: "rules-route" },
    integrity: { stageHash: "stage-route" },
  };
  const artifactJson = canonicalJson(payload);
  store.seedPublicArtifactVerifyTask({
    matchId: "route-badge-1",
    artifactHash: "artifact-fnv",
    artifactSha256: sha256(artifactJson).value,
    artifactJson,
  });
  const w1 = store.registerWorker({ capability });
  const w2 = store.registerWorker({ capability });
  const a1 = store.assignNext(auth(w1))!;
  const a2 = store.assignNext(auth(w2))!;
  store.acceptAssignment({ ...auth(w1), assignmentId: a1.assignment.assignmentId, assignmentToken: a1.assignment.assignmentToken });
  store.acceptAssignment({ ...auth(w2), assignmentId: a2.assignment.assignmentId, assignmentToken: a2.assignment.assignmentToken });
  for (const [worker, nextBody] of [[w1, a1], [w2, a2]] as const) {
    store.submitReceipt({
      ...auth(worker),
      assignmentId: nextBody.assignment.assignmentId,
      assignmentToken: nextBody.assignment.assignmentToken,
      taskId: nextBody.task.taskId,
      chunkId: nextBody.chunk.chunkId,
      ...referenceReceiptFields(nextBody.chunk),
      executionMode: "cpu",
      transport: "http",
      computeMs: 1,
    });
  }
  const srv = await boot(store, baseConfig);
  t.after(() => srv.close());

  const resp = await req(srv.port, "GET", "/compute/public/replay-badges/route-badge-1");
  assert.equal(resp.status, 200);
  assert.equal(resp.body.status, "verified");
  assert.equal(resp.body.rulesHash, "rules-route");

  const missing = await req(srv.port, "GET", "/compute/public/replay-badges/missing");
  assert.equal(missing.status, 404);
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

test("WebRTC pairing joins two workers and exchanges offer answer candidates", async (t) => {
  const store = new ComputeLabStore({ acceptAssignments: true, webrtcSessionTtlMs: 60_000 });
  const srv = await boot(store, {
    ...baseConfig,
    webrtcSignalingEnabled: true,
    webrtcDataEnabled: true,
    stunUrls: ["stun:stun.example.test:19302"],
    adminToken: "secret",
  });
  t.after(() => srv.close());
  const w1 = await register(srv.port, webgpuCapability);
  const w2 = await register(srv.port, webgpuCapability);

  const p1 = await req(srv.port, "POST", "/compute/webrtc/pairs/join", w1);
  assert.equal(p1.status, 200);
  assert.equal(p1.body.role, "offerer");
  assert.equal(p1.body.status, "waiting");
  assert.equal(p1.body.iceServers[0].urls[0], "stun:stun.example.test:19302");

  const p2 = await req(srv.port, "POST", "/compute/webrtc/pairs/join", w2);
  assert.equal(p2.status, 200);
  assert.equal(p2.body.role, "answerer");
  assert.equal(p2.body.status, "matched");
  assert.equal(p2.body.pairId, p1.body.pairId);

  const headers = { "x-webrtc-pair-token": p1.body.pairToken };
  const offer = await req(srv.port, "POST", `/compute/webrtc/pairs/${p1.body.pairId}/offer`, {
    offer: { type: "offer", sdp: "opaque-offer" },
  }, headers);
  assert.equal(offer.status, 200);
  assert.equal(offer.body.offer.sdp, "opaque-offer");

  const answer = await req(srv.port, "POST", `/compute/webrtc/pairs/${p1.body.pairId}/answer`, {
    answer: { type: "answer", sdp: "opaque-answer" },
  }, headers);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.answer.sdp, "opaque-answer");

  const candidates = await req(srv.port, "POST", `/compute/webrtc/pairs/${p1.body.pairId}/candidates`, {
    peerId: w1.workerId,
    candidates: [{ candidate: "candidate-a" }],
  }, headers);
  assert.equal(candidates.status, 200);
  assert.equal(candidates.body.candidates[0].payload.candidate, "candidate-a");

  const fetched = await req(srv.port, "GET", `/compute/webrtc/pairs/${p1.body.pairId}`, undefined, headers);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.candidates.length, 1);

  const dashboard = await req(srv.port, "GET", "/compute/admin/dashboard", undefined, { "x-plasma-admin-token": "secret" });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.webRtcPairList.length, 1);
  assert.equal(dashboard.body.webRtcPairList[0].pairId, p1.body.pairId);
  assert.equal(dashboard.body.webRtcPairList[0].status, "matched");
  assert.equal(dashboard.body.webRtcPairList[0].hasOffer, true);
  assert.equal(dashboard.body.webRtcPairList[0].hasAnswer, true);
  assert.equal(dashboard.body.webRtcPairList[0].candidateCount, 1);
  assert.equal("pairToken" in dashboard.body.webRtcPairList[0], false);
  assert.equal("token" in dashboard.body.webRtcPairList[0], false);
  assert.equal("offer" in dashboard.body.webRtcPairList[0], false);
  assert.equal("answer" in dashboard.body.webRtcPairList[0], false);
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
  options: { eventLog?: (event: Record<string, unknown>) => void } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (await handleComputeLabRequest(request, response, url, { store, config, ...options })) return;
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

async function register(port: number, workerCapability: WorkerCapability = capability) {
  const resp = await req(port, "POST", "/compute/workers/register", { capability: workerCapability });
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
