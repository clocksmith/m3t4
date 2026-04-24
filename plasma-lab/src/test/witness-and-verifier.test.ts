import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bundleManifestHash,
  bundleRootHash,
  ComputeLabStore,
  witnessAttestationId,
} from "../store.js";
import { computeAdaptiveTileGrid } from "../routes.js";

const CAPABILITY = {
  clientVersion: "test",
  kernels: [],
  runtimeSurfaces: [],
  maxChunkBytes: 64,
  maxConcurrentChunks: 1,
};

function registerWorker(store: ComputeLabStore, label: string) {
  const reg = store.registerWorker({ label, capability: CAPABILITY as any });
  return reg;
}

test("witnessAttestationId is stable per (matchId, tick, workerId)", () => {
  const a = witnessAttestationId({ matchId: "m1", tick: 300, workerId: "w1" });
  const b = witnessAttestationId({ matchId: "m1", tick: 300, workerId: "w1" });
  const c = witnessAttestationId({ matchId: "m1", tick: 300, workerId: "w2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("witness attestations aggregate into per-tick quorum winners", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const w1 = registerWorker(store, "w1");
  const w2 = registerWorker(store, "w2");
  const w3 = registerWorker(store, "w3");
  const stateHashA = { algorithm: "sha256" as const, value: "a".repeat(64) };
  const stateHashB = { algorithm: "sha256" as const, value: "b".repeat(64) };
  const submit = (w: ReturnType<typeof registerWorker>, tick: number, sh: typeof stateHashA) =>
    store.submitWitnessAttestation({
      matchId: "m-1",
      tick,
      stateHash: sh,
      workerId: w.worker.workerId,
      workerSessionId: w.session.workerSessionId,
      workerSessionToken: w.session.token,
    });
  submit(w1, 300, stateHashA);
  submit(w2, 300, stateHashA);
  submit(w3, 300, stateHashB); // dissenter
  submit(w1, 600, stateHashA);
  submit(w2, 600, stateHashA);

  const quorum = store.witnessQuorumForMatch("m-1");
  assert.equal(quorum.matchId, "m-1");
  assert.equal(quorum.totalSubmitters, 3);
  const t300 = quorum.ticks.find((t) => t.tick === 300)!;
  assert.equal(t300.winner!.count, 2);
  assert.equal(t300.agreements.length, 2);
  const t600 = quorum.ticks.find((t) => t.tick === 600)!;
  assert.equal(t600.winner!.count, 2);
  assert.equal(t600.agreements.length, 1);
});

test("witness resubmission from same worker overwrites, does not duplicate", () => {
  const store = new ComputeLabStore({ acceptAssignments: true });
  const w = registerWorker(store, "w1");
  const sh = { algorithm: "sha256" as const, value: "c".repeat(64) };
  store.submitWitnessAttestation({
    matchId: "m-2", tick: 0, stateHash: sh,
    workerId: w.worker.workerId, workerSessionId: w.session.workerSessionId, workerSessionToken: w.session.token,
  });
  store.submitWitnessAttestation({
    matchId: "m-2", tick: 0, stateHash: sh,
    workerId: w.worker.workerId, workerSessionId: w.session.workerSessionId, workerSessionToken: w.session.token,
  });
  const list = store.witnessAttestationsForMatch("m-2");
  assert.equal(list.length, 1);
});

test("computeAdaptiveTileGrid clamps to bounds and honors signals", () => {
  const tiny = computeAdaptiveTileGrid({
    activeWorkers: 1, expectedMatchSec: 60, avgChunkSec: 1.5, utilization: 0.5,
    minRows: 2, maxRows: 10, minCols: 2, maxCols: 10,
  });
  assert.ok(tiny.targetChunks >= 4);
  assert.ok(tiny.rows >= 2);
  const big = computeAdaptiveTileGrid({
    activeWorkers: 200, expectedMatchSec: 180, avgChunkSec: 1.5, utilization: 0.5,
    minRows: 2, maxRows: 10, minCols: 2, maxCols: 10,
  });
  assert.ok(big.targetChunks <= 100);
  assert.ok(big.rows >= 2 && big.rows <= 10);
  assert.ok(big.cols >= 2 && big.cols <= 10);
});

test("bundleManifestHash and bundleRootHash compose for independent verification", () => {
  const manifest = {
    bundleId: "b",
    kind: "science" as const,
    kernelId: "science.contact_map_tile.v0",
    matchId: "m-1",
    chunkIds: ["c1", "c2", "c3"],
    targetChunkCount: 3,
    quorum: { minExecutions: 2, minAgreeing: 2 },
    deadlineAt: 123,
  };
  const mh = bundleManifestHash(manifest);
  const matchReceiptHash = { algorithm: "sha256" as const, value: "1".repeat(64) };
  const accepted = [
    { algorithm: "sha256" as const, value: "a".repeat(64) },
    { algorithm: "sha256" as const, value: "b".repeat(64) },
    { algorithm: "sha256" as const, value: "c".repeat(64) },
  ];
  const root1 = bundleRootHash({ matchReceiptHash, bundleManifestHash: mh, acceptedReceiptHashes: accepted });
  const root2 = bundleRootHash({ matchReceiptHash, bundleManifestHash: mh, acceptedReceiptHashes: accepted.slice().reverse() });
  assert.equal(root1.value, root2.value);
  assert.equal(root1.algorithm, "sha256");
  assert.equal(root1.value.length, 64);
});
