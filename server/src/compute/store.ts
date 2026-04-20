// In-memory coordinator store for distributed compute.
//
// This is a deliberately minimal implementation of the Plasma
// scheduling/validation pipeline, just enough to prove the pipeline
// end-to-end against the browser worker. It implements:
//   - worker registration + capability envelope
//   - chunk assignment with per-chunk executor redundancy
//   - execution-receipt ingestion + quorum validation
//   - local reputation (accept/reject counters)
//   - task lifecycle (pending → running → complete)
//
// Not in scope: durability, Sybil resistance, multi-coordinator,
// authentication of worker identity beyond a random token. Those
// become relevant once a scientific kernel is adopted.

import { randomUUID } from "node:crypto";
import { runKernel, knownKernels } from "./kernels.js";

export type ChunkStatus = "pending" | "assigned" | "verified" | "failed";

export interface ChunkSpec {
  chunkId: string;
  taskId: string;
  kind: string;
  params: Record<string, number | string>;
  referenceHash: string;
}

export interface Assignment {
  assignmentId: string;
  chunkId: string;
  workerId: string;
  assignedAt: number;
  deadlineAt: number;
}

export interface ExecutionReceipt {
  receiptId: string;
  chunkId: string;
  workerId: string;
  outputHash: string;
  computeMs: number;
  receivedAt: number;
}

export interface ComputeTask {
  taskId: string;
  kind: string;
  chunks: ChunkSpec[];
  minExecutions: number;
  minAgreeing: number;
  status: "pending" | "running" | "complete";
  createdAt: number;
  chunkStatus: Map<string, ChunkStatus>;
  receipts: Map<string, ExecutionReceipt[]>;
  assignmentsByChunk: Map<string, Assignment[]>;
}

export interface Worker {
  workerId: string;
  label?: string;
  capability: {
    kernels: string[];
    cores: number;
    ua: string;
  };
  registeredAt: number;
  lastSeenAt: number;
  reputation: {
    accepted: number;
    rejected: number;
    timeouts: number;
  };
}

const ASSIGNMENT_DEADLINE_MS = 60_000;

export class ComputeStore {
  private readonly tasks = new Map<string, ComputeTask>();
  private readonly workers = new Map<string, Worker>();

  registerWorker(input: { label?: string; capability: Worker["capability"] }): Worker {
    const filtered = input.capability.kernels.filter((k) => knownKernels().includes(k));
    const workerId = `wk-${randomUUID().slice(0, 12)}`;
    const worker: Worker = {
      workerId,
      label: input.label,
      capability: { ...input.capability, kernels: filtered },
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      reputation: { accepted: 0, rejected: 0, timeouts: 0 },
    };
    this.workers.set(workerId, worker);
    return worker;
  }

  touchWorker(workerId: string): Worker | undefined {
    const w = this.workers.get(workerId);
    if (w) w.lastSeenAt = Date.now();
    return w;
  }

  listWorkers(): Worker[] {
    return Array.from(this.workers.values());
  }

  createTask(input: {
    kind: string;
    chunks: Array<{ params: Record<string, number | string> }>;
    minExecutions?: number;
    minAgreeing?: number;
  }): ComputeTask {
    if (!knownKernels().includes(input.kind)) {
      throw new Error(`unknown kernel: ${input.kind}`);
    }
    const taskId = `tk-${randomUUID().slice(0, 12)}`;
    const minExecutions = Math.max(2, input.minExecutions ?? 2);
    const minAgreeing = Math.min(minExecutions, Math.max(2, input.minAgreeing ?? 2));
    const chunks: ChunkSpec[] = input.chunks.map((c, i) => {
      const chunkId = `${taskId}-c${i}`;
      const reference = runKernel({ chunkId, kind: input.kind, params: c.params });
      return {
        chunkId,
        taskId,
        kind: input.kind,
        params: c.params,
        referenceHash: reference.outputHash,
      };
    });
    const chunkStatus = new Map<string, ChunkStatus>();
    const receipts = new Map<string, ExecutionReceipt[]>();
    const assignmentsByChunk = new Map<string, Assignment[]>();
    for (const c of chunks) {
      chunkStatus.set(c.chunkId, "pending");
      receipts.set(c.chunkId, []);
      assignmentsByChunk.set(c.chunkId, []);
    }
    const task: ComputeTask = {
      taskId, kind: input.kind, chunks,
      minExecutions, minAgreeing,
      status: "running", createdAt: Date.now(),
      chunkStatus, receipts, assignmentsByChunk,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  getTask(taskId: string): ComputeTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): ComputeTask[] {
    return Array.from(this.tasks.values());
  }

  // Pick the highest-priority pending chunk this worker hasn't already
  // executed and hand out an assignment. Returns null when nothing
  // needs work from this peer.
  assignNext(workerId: string): { task: ComputeTask; chunk: ChunkSpec; assignment: Assignment } | null {
    const worker = this.touchWorker(workerId);
    if (!worker) return null;
    this.expireStaleAssignments();
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      if (!worker.capability.kernels.includes(task.kind)) continue;
      for (const chunk of task.chunks) {
        const status = task.chunkStatus.get(chunk.chunkId);
        if (status !== "pending" && status !== "assigned") continue;
        const assignments = task.assignmentsByChunk.get(chunk.chunkId) ?? [];
        if (assignments.some((a) => a.workerId === workerId)) continue;
        // Cap concurrent assignments per chunk to 2x required executions
        // so we don't burn worker cycles on already-quorumed chunks.
        if (assignments.length >= task.minExecutions * 2) continue;
        const assignment: Assignment = {
          assignmentId: `as-${randomUUID().slice(0, 12)}`,
          chunkId: chunk.chunkId,
          workerId,
          assignedAt: Date.now(),
          deadlineAt: Date.now() + ASSIGNMENT_DEADLINE_MS,
        };
        assignments.push(assignment);
        task.assignmentsByChunk.set(chunk.chunkId, assignments);
        task.chunkStatus.set(chunk.chunkId, "assigned");
        return { task, chunk, assignment };
      }
    }
    return null;
  }

  submitReceipt(input: {
    workerId: string;
    chunkId: string;
    outputHash: string;
    computeMs: number;
  }): { status: "accepted" | "rejected" | "pending"; reason?: string } {
    const worker = this.touchWorker(input.workerId);
    if (!worker) return { status: "rejected", reason: "unknown worker" };
    const task = this.findTaskByChunk(input.chunkId);
    if (!task) return { status: "rejected", reason: "unknown chunk" };
    const chunkStatus = task.chunkStatus.get(input.chunkId);
    if (chunkStatus === "verified" || chunkStatus === "failed") {
      // Late receipt for an already-decided chunk — still credit the
      // worker if the hash matches the reference, penalize if it
      // doesn't.
      const chunk = task.chunks.find((c) => c.chunkId === input.chunkId)!;
      const matches = input.outputHash === chunk.referenceHash;
      this.bumpReputation(worker, matches ? "accept" : "reject");
      return { status: matches ? "accepted" : "rejected", reason: "chunk already decided" };
    }
    const assignments = task.assignmentsByChunk.get(input.chunkId) ?? [];
    if (!assignments.some((a) => a.workerId === input.workerId)) {
      return { status: "rejected", reason: "no matching assignment" };
    }
    const receipts = task.receipts.get(input.chunkId) ?? [];
    if (receipts.some((r) => r.workerId === input.workerId)) {
      return { status: "rejected", reason: "duplicate receipt" };
    }
    const receipt: ExecutionReceipt = {
      receiptId: `rc-${randomUUID().slice(0, 12)}`,
      chunkId: input.chunkId,
      workerId: input.workerId,
      outputHash: input.outputHash,
      computeMs: input.computeMs,
      receivedAt: Date.now(),
    };
    receipts.push(receipt);
    task.receipts.set(input.chunkId, receipts);

    const result = this.evaluateQuorum(task, input.chunkId);
    if (result.decision === "verified") {
      task.chunkStatus.set(input.chunkId, "verified");
      for (const r of receipts) {
        const w = this.workers.get(r.workerId);
        if (!w) continue;
        this.bumpReputation(w, r.outputHash === result.winningHash ? "accept" : "reject");
      }
      this.maybeCompleteTask(task);
      return { status: "accepted" };
    }
    if (result.decision === "failed") {
      task.chunkStatus.set(input.chunkId, "failed");
      this.maybeCompleteTask(task);
      return { status: "rejected", reason: "quorum-failed" };
    }
    return { status: "pending" };
  }

  workerStatus(workerId: string): {
    worker: Worker;
    assignments: number;
    totalCompleted: number;
    totalRejected: number;
  } | null {
    const worker = this.workers.get(workerId);
    if (!worker) return null;
    let assignments = 0;
    for (const task of this.tasks.values()) {
      for (const as of task.assignmentsByChunk.values()) {
        for (const a of as) if (a.workerId === workerId && a.deadlineAt >= Date.now()) assignments++;
      }
    }
    return {
      worker,
      assignments,
      totalCompleted: worker.reputation.accepted,
      totalRejected: worker.reputation.rejected,
    };
  }

  summary() {
    const tasks = Array.from(this.tasks.values()).map((t) => ({
      taskId: t.taskId,
      kind: t.kind,
      status: t.status,
      chunks: t.chunks.length,
      verified: Array.from(t.chunkStatus.values()).filter((s) => s === "verified").length,
      failed: Array.from(t.chunkStatus.values()).filter((s) => s === "failed").length,
      minExecutions: t.minExecutions,
      minAgreeing: t.minAgreeing,
    }));
    return {
      tasks,
      workers: this.workers.size,
      activeWorkers: Array.from(this.workers.values())
        .filter((w) => Date.now() - w.lastSeenAt < 60_000).length,
    };
  }

  private findTaskByChunk(chunkId: string): ComputeTask | undefined {
    for (const task of this.tasks.values()) if (task.chunkStatus.has(chunkId)) return task;
    return undefined;
  }

  private evaluateQuorum(task: ComputeTask, chunkId: string):
    { decision: "verified" | "failed" | "pending"; winningHash?: string } {
    const receipts = task.receipts.get(chunkId) ?? [];
    if (receipts.length < task.minExecutions) return { decision: "pending" };
    const groups = new Map<string, number>();
    for (const r of receipts) groups.set(r.outputHash, (groups.get(r.outputHash) ?? 0) + 1);
    const [winningHash, count] = Array.from(groups.entries()).sort((a, b) => b[1] - a[1])[0];
    if (count >= task.minAgreeing) return { decision: "verified", winningHash };
    // If every assignment has reported and quorum still isn't reached,
    // the chunk is unrecoverable from this cohort — mark it failed.
    const assignments = task.assignmentsByChunk.get(chunkId) ?? [];
    const pending = assignments.filter((a) => a.deadlineAt >= Date.now()).length - receipts.length;
    if (pending <= 0) return { decision: "failed" };
    return { decision: "pending" };
  }

  private maybeCompleteTask(task: ComputeTask): void {
    const statuses = Array.from(task.chunkStatus.values());
    if (statuses.every((s) => s === "verified" || s === "failed")) {
      task.status = "complete";
    }
  }

  private bumpReputation(worker: Worker, outcome: "accept" | "reject"): void {
    if (outcome === "accept") worker.reputation.accepted++;
    else worker.reputation.rejected++;
  }

  private expireStaleAssignments(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      for (const [chunkId, assignments] of task.assignmentsByChunk) {
        const receipts = task.receipts.get(chunkId) ?? [];
        const live = assignments.filter((a) => {
          if (a.deadlineAt >= now) return true;
          if (receipts.some((r) => r.workerId === a.workerId)) return true;
          const w = this.workers.get(a.workerId);
          if (w) w.reputation.timeouts++;
          return false;
        });
        task.assignmentsByChunk.set(chunkId, live);
        if (live.length === 0 && task.chunkStatus.get(chunkId) === "assigned") {
          task.chunkStatus.set(chunkId, "pending");
        }
      }
    }
  }
}
