import assert from "node:assert/strict";
import test from "node:test";
import { ComputeStore } from "../compute/store.js";

function register(store: ComputeStore, label: string) {
  return store.registerWorker({
    label,
    capability: {
      kernels: ["prime-search.v0"],
      cores: 1,
      ua: "node-test",
    },
  });
}

test("compute receipts are bound to issued assignment ids", () => {
  const store = new ComputeStore();
  const a = register(store, "a");
  const b = register(store, "b");
  const task = store.createTask({
    kind: "prime-search.v0",
    chunks: [{ params: { start: 1_000, endExclusive: 1_200 } }],
    minExecutions: 2,
    minAgreeing: 2,
  });

  const nextA = store.assignNext(a.workerId);
  const nextB = store.assignNext(b.workerId);
  assert.ok(nextA);
  assert.ok(nextB);
  assert.equal(nextA.chunk.chunkId, nextB.chunk.chunkId);

  const wrongAssignment = store.submitReceipt({
    workerId: a.workerId,
    chunkId: nextA.chunk.chunkId,
    assignmentId: nextB.assignment.assignmentId,
    outputHash: nextA.chunk.referenceHash,
    computeMs: 1,
  });
  assert.equal(wrongAssignment.status, "rejected");
  assert.equal(wrongAssignment.reason, "assignment mismatch");

  const firstReceipt = store.submitReceipt({
    workerId: a.workerId,
    chunkId: nextA.chunk.chunkId,
    assignmentId: nextA.assignment.assignmentId,
    outputHash: nextA.chunk.referenceHash,
    computeMs: 1,
  });
  assert.equal(firstReceipt.status, "pending");

  const secondReceipt = store.submitReceipt({
    workerId: b.workerId,
    chunkId: nextB.chunk.chunkId,
    assignmentId: nextB.assignment.assignmentId,
    outputHash: nextB.chunk.referenceHash,
    computeMs: 1,
  });
  assert.equal(secondReceipt.status, "accepted");
  assert.equal(task.chunkStatus.get(nextA.chunk.chunkId), "verified");
});
