import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bundleManifestHash,
  bundleRootHash,
  ComputeLabStore,
} from "../store.js";

function ctorMandelbrotChunks(store: ComputeLabStore, count: number): Array<{ chunkId: string; taskId: string }> {
  const refs: Array<{ chunkId: string; taskId: string }> = [];
  for (let i = 0; i < count; i++) {
    const task = store.seedMandelbrotTileTask({
      widthPx: 8,
      heightPx: 8,
      minXQ88: -512 + i,
      maxXQ88: 0,
      minYQ88: -256,
      maxYQ88: 256,
      maxIter: 8,
      minExecutions: 1,
      minAgreeing: 1,
    });
    refs.push({ chunkId: task.chunks[0].chunkId, taskId: task.taskId });
  }
  return refs;
}

test("bundleManifestHash is stable across chunkId ordering", () => {
  const base = {
    bundleId: "bundle-x",
    kind: "science" as const,
    kernelId: "science.contact_map_tile.v0",
    matchId: "match-42",
    chunkIds: ["a", "b", "c"],
    targetChunkCount: 3,
    quorum: { minExecutions: 2, minAgreeing: 2 },
    deadlineAt: null,
  };
  const h1 = bundleManifestHash(base);
  const h2 = bundleManifestHash({ ...base, chunkIds: ["c", "a", "b"] });
  assert.equal(h1.value, h2.value);
});

test("bundleRootHash is stable across receipt-hash ordering", () => {
  const matchReceiptHash = { algorithm: "sha256" as const, value: "a".repeat(64) };
  const manifestHash = { algorithm: "sha256" as const, value: "b".repeat(64) };
  const accepted = [
    { algorithm: "sha256" as const, value: "1".repeat(64) },
    { algorithm: "sha256" as const, value: "2".repeat(64) },
  ];
  const h1 = bundleRootHash({ matchReceiptHash, bundleManifestHash: manifestHash, acceptedReceiptHashes: accepted });
  const h2 = bundleRootHash({ matchReceiptHash, bundleManifestHash: manifestHash, acceptedReceiptHashes: accepted.slice().reverse() });
  assert.equal(h1.value, h2.value);
});

test("createBundle attaches bundleId to referenced chunks and tasks", () => {
  const store = new ComputeLabStore();
  const refs = ctorMandelbrotChunks(store, 3);
  const chunkIds = refs.map((r) => r.chunkId);
  const bundle = store.createBundle({
    kind: "science",
    kernelId: "science.mandelbrot_tile.v0",
    chunkIds,
    quorum: { minExecutions: 1, minAgreeing: 1 },
  });
  assert.equal(bundle.status, "pending");
  assert.equal(bundle.chunkIds.length, 3);
  for (const { taskId, chunkId } of refs) {
    const task = store.getTask(taskId);
    assert.ok(task);
    assert.equal((task as unknown as { bundleId: string }).bundleId, bundle.bundleId);
    const chunk = task!.chunks.find((c) => c.chunkId === chunkId);
    assert.equal((chunk as unknown as { bundleId: string }).bundleId, bundle.bundleId);
  }
});

test("createBundle rejects unknown chunkIds and duplicates", () => {
  const store = new ComputeLabStore();
  const [ref] = ctorMandelbrotChunks(store, 1);
  assert.throws(() => store.createBundle({
    kind: "science",
    kernelId: "science.mandelbrot_tile.v0",
    chunkIds: [ref.chunkId, ref.chunkId],
  }), /duplicate/);
  assert.throws(() => store.createBundle({
    kind: "science",
    kernelId: "science.mandelbrot_tile.v0",
    chunkIds: ["bogus-chunk-id"],
  }), /unknown chunk/);
});

test("bundleAggregate counts accepted/pending/rejected chunks", () => {
  const store = new ComputeLabStore();
  const refs = ctorMandelbrotChunks(store, 2);
  const bundle = store.createBundle({
    kind: "science",
    kernelId: "science.mandelbrot_tile.v0",
    chunkIds: refs.map((r) => r.chunkId),
    quorum: { minExecutions: 1, minAgreeing: 1 },
  });
  const aggregate = store.bundleAggregate(bundle.bundleId);
  assert.ok(aggregate);
  assert.equal(aggregate!.acceptedReceiptCount, 0);
  assert.equal(aggregate!.pendingReceiptCount, 0);
  assert.equal(aggregate!.rejectedReceiptCount, 0);
  assert.equal(aggregate!.chunkStatus.length, 2);
});

test("sealBundle computes a stable Merkle root anchored to the match receipt", () => {
  const store = new ComputeLabStore();
  const refs = ctorMandelbrotChunks(store, 2);
  const bundle = store.createBundle({
    kind: "science",
    kernelId: "science.mandelbrot_tile.v0",
    chunkIds: refs.map((r) => r.chunkId),
    quorum: { minExecutions: 1, minAgreeing: 1 },
  });
  const matchReceiptHash = { algorithm: "sha256" as const, value: "c".repeat(64) };
  const sealed = store.sealBundle({ bundleId: bundle.bundleId, matchReceiptHash, matchId: "match-42" });
  assert.equal(sealed.status, "sealed");
  assert.equal(sealed.matchId, "match-42");
  assert.ok(sealed.bundleRoot);
  assert.equal(sealed.bundleRoot!.algorithm, "sha256");
  assert.equal(sealed.bundleRoot!.value.length, 64);
  // Re-sealing is idempotent.
  const again = store.sealBundle({ bundleId: bundle.bundleId, matchReceiptHash });
  assert.equal(again.bundleRoot!.value, sealed.bundleRoot!.value);
});
