// Firebase-native browser compute substrate.
//
// Cost shape:
// - no always-on server
// - no cron-driven work loop
// - one callable to register, one callable to claim, one callable to submit
// - optional browser-to-browser WebRTC execution uses the existing
//   webrtcSignal callable and compute_peer_presence docs
//
// Assignment authority stays in Firebase Functions. Browsers receive public
// kernel params only; the Function computes and stores the expected output hash
// when it mints the assignment, then validates receipts against that stored
// hash. This keeps the browser path cheap without trusting browser output.

import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import {
  ASSET_TILE_AUDIT_KERNEL_HASH,
  ASSET_TILE_AUDIT_KERNEL_ID,
  runAssetTileAuditReference,
} from "@m3t4/plasma-lab/dist/kernels/asset-tile-audit.js";
import {
  CONTACT_MAP_TILE_KERNEL_HASH,
  CONTACT_MAP_TILE_KERNEL_ID,
  runContactMapTileReference,
} from "@m3t4/plasma-lab/dist/kernels/contact-map-tile.js";
import {
  DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_HASH,
  DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
  DEVICE_WITNESS_RENDER_KERNEL_HASH,
  DEVICE_WITNESS_RENDER_KERNEL_ID,
  DEVICE_WITNESS_WEBGPU_KERNEL_HASH,
  DEVICE_WITNESS_WEBGPU_KERNEL_ID,
  runDeviceWitnessDerivedBufferReference,
  runDeviceWitnessRenderReference,
  runDeviceWitnessWebGpuReference,
} from "@m3t4/plasma-lab/dist/kernels/device-witness.js";
import {
  EXPLOIT_SEARCH_KERNEL_HASH,
  EXPLOIT_SEARCH_KERNEL_ID,
  runExploitSearchReference,
} from "@m3t4/plasma-lab/dist/kernels/exploit-search.js";
import {
  GENOME_KMER_KERNEL_HASH,
  GENOME_KMER_KERNEL_ID,
  runGenomeKmerReference,
} from "@m3t4/plasma-lab/dist/kernels/genome-kmer.js";
import {
  HEAT_DIFFUSION_TILE_KERNEL_HASH,
  HEAT_DIFFUSION_TILE_KERNEL_ID,
  runHeatDiffusionTileReference,
} from "@m3t4/plasma-lab/dist/kernels/heat-diffusion-tile.js";
import {
  IMAGE_TILE_INFER_KERNEL_HASH,
  IMAGE_TILE_INFER_KERNEL_ID,
  runImageTileInferReference,
} from "@m3t4/plasma-lab/dist/kernels/image-tile-infer.js";
import {
  MANDELBROT_TILE_KERNEL_HASH,
  MANDELBROT_TILE_KERNEL_ID,
  runMandelbrotTileReference,
} from "@m3t4/plasma-lab/dist/kernels/mandelbrot-tile.js";
import {
  MICROSCOPY_TILE_SCORE_KERNEL_HASH,
  MICROSCOPY_TILE_SCORE_KERNEL_ID,
  runMicroscopyTileScoreReference,
} from "@m3t4/plasma-lab/dist/kernels/microscopy-tile-score.js";
import {
  PRIME_SEARCH_KERNEL_HASH,
  PRIME_SEARCH_KERNEL_ID,
  runPrimeSearch,
} from "@m3t4/plasma-lab/dist/kernels/prime-search.js";
import {
  SEED_SWEEP_KERNEL_BINDING,
  SEED_SWEEP_KERNEL_HASH,
  SEED_SWEEP_KERNEL_ID,
  runSeedSweep,
} from "@m3t4/plasma-lab/dist/kernels/seed-sweep.js";
import {
  TENSOR_TILE_KERNEL_HASH,
  TENSOR_TILE_KERNEL_ID,
  runTensorTileReference,
} from "@m3t4/plasma-lab/dist/kernels/tensor-tile.js";
import { CONTACT_MAP_PRESETS } from "@m3t4/plasma-lab/dist/contact-map-presets.js";
import { GENOME_KMER_PRESETS } from "@m3t4/plasma-lab/dist/genome-kmer-presets.js";
import {
  IMAGE_TILE_SAMPLE_PRESETS,
  MICROSCOPY_TILE_SAMPLE_PRESETS,
} from "@m3t4/plasma-lab/dist/image-tile-presets.js";
import { db, COLLECTIONS } from "./firestore.js";

const REGION = "us-central1";
const CLIENT_VERSION = "compute-firebase-p2p-v2";
const CLAIM_COOLDOWN_MS = Number(process.env.COMPUTE_FIREBASE_CLAIM_COOLDOWN_MS ?? 2_000);
const ASSIGNMENT_TTL_MS = Number(process.env.COMPUTE_FIREBASE_ASSIGNMENT_TTL_MS ?? 90_000);
const RECEIPT_RETENTION_WINDOW_MS = Number(process.env.COMPUTE_FIREBASE_RECEIPT_WINDOW_MS ?? 7 * 86_400_000);

interface JsonMap { [key: string]: unknown }

interface KernelResult {
  outputHash: string;
  outputBytes?: Uint8Array;
  sourceHash?: string;
  regionHash?: string;
  producerKernelHash?: string;
  sourceId?: string;
  regionId?: string;
  outputId?: string;
}

interface KernelLane {
  kernelId: string;
  title: string;
  family: string;
  runtime: "cpu" | "webgpu";
  kernelHash: string;
  inputBoundary: string;
  buildParams(now: number, uid: string, assignmentCount: number): JsonMap;
  run(params: JsonMap): KernelResult;
}

interface ComputeWorkerDoc {
  workerId: string;
  uid: string;
  clientId?: string;
  accountUid?: string;
  label?: string;
  capability?: unknown;
  registeredAt: number;
  lastSeenAt: number;
  lastClaimAt?: number;
  assignmentsStarted?: number;
  receiptsSubmitted?: number;
  clientVersion: string;
}

interface ComputeAssignmentDoc {
  assignmentId: string;
  assignmentToken: string;
  uid: string;
  workerId: string;
  taskId: string;
  chunkId: string;
  kernelId: string;
  kind: string;
  params: JsonMap;
  kernelHash: string;
  inputHash: { algorithm: "sha256"; value: string };
  expectedOutputHash: string;
  requiredRuntime: "cpu" | "webgpu";
  status: "offered" | "receipted" | "expired";
  createdAt: number;
  expiresAt: number;
  assignedAt: number;
}

const CPU_LANES: KernelLane[] = [
  lane(PRIME_SEARCH_KERNEL_ID, PRIME_SEARCH_KERNEL_HASH, "Prime search", "plasma", "cpu", "public integer ranges", primeParams, runPrimeSearch),
  lane(ASSET_TILE_AUDIT_KERNEL_ID, ASSET_TILE_AUDIT_KERNEL_HASH, "Asset tile audit", "asset", "cpu", "public sample RGBA tile", imageAssetParams, runAssetTileAuditReference),
  lane(IMAGE_TILE_INFER_KERNEL_ID, IMAGE_TILE_INFER_KERNEL_HASH, "Image tile inference", "ml", "cpu", "public sample RGBA tile", imageInferParams, runImageTileInferReference),
  lane(MICROSCOPY_TILE_SCORE_KERNEL_ID, MICROSCOPY_TILE_SCORE_KERNEL_HASH, "Microscopy tile score", "science", "cpu", "public sample microscopy tile", microscopyParams, runMicroscopyTileScoreReference),
  lane(GENOME_KMER_KERNEL_ID, GENOME_KMER_KERNEL_HASH, "Genome k-mer histogram", "science", "cpu", "synthetic/public DNA sequence snippets", genomeParams, runGenomeKmerReference),
  lane(SEED_SWEEP_KERNEL_ID, SEED_SWEEP_KERNEL_HASH, "Public match seed sweep", "m3t4", "cpu", "public preset brains/stages only", seedSweepParams, runSeedSweep),
  lane(EXPLOIT_SEARCH_KERNEL_ID, EXPLOIT_SEARCH_KERNEL_HASH, "Public exploit search", "m3t4", "cpu", "public preset brains/stages only", exploitParams, runExploitSearchReference),
  lane(DEVICE_WITNESS_RENDER_KERNEL_ID, DEVICE_WITNESS_RENDER_KERNEL_HASH, "Render fixture witness", "device", "cpu", "public canvas fixture", renderFixtureParams, runDeviceWitnessRenderReference),
  lane(DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID, DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_HASH, "Derived buffer witness", "device", "cpu", "synthetic public u32 buffer", derivedBufferParams, runDeviceWitnessDerivedBufferReference),
];

const WEBGPU_LANES: KernelLane[] = [
  lane(TENSOR_TILE_KERNEL_ID, TENSOR_TILE_KERNEL_HASH, "Tensor tile", "plasma", "webgpu", "synthetic public u32 matrix tile", tensorParams, runTensorTileReference),
  lane(CONTACT_MAP_TILE_KERNEL_ID, CONTACT_MAP_TILE_KERNEL_HASH, "Protein contact map tile", "science", "webgpu", "public protein residue windows", contactParams, runContactMapTileReference),
  lane(MANDELBROT_TILE_KERNEL_ID, MANDELBROT_TILE_KERNEL_HASH, "Mandelbrot tile", "science", "webgpu", "public fixed-point tile bounds", mandelbrotParams, runMandelbrotTileReference),
  lane(HEAT_DIFFUSION_TILE_KERNEL_ID, HEAT_DIFFUSION_TILE_KERNEL_HASH, "Heat diffusion tile", "science", "webgpu", "synthetic public heat grid", heatParams, runHeatDiffusionTileReference),
  lane(DEVICE_WITNESS_WEBGPU_KERNEL_ID, DEVICE_WITNESS_WEBGPU_KERNEL_HASH, "WebGPU device witness", "device", "webgpu", "synthetic public u32 workload", webgpuWitnessParams, runDeviceWitnessWebGpuReference),
];

const ALL_LANES = [...WEBGPU_LANES, ...CPU_LANES];
const LANE_BY_ID = new Map(ALL_LANES.map((entry) => [entry.kernelId, entry]));

export const computeRegister = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 30 },
  async (req) => {
    const auth = requireAuth(req.auth?.uid);
    const firestore = db();
    const now = Date.now();
    const workerId = workerIdForUid(auth.uid);
    const worker: ComputeWorkerDoc = {
      workerId,
      uid: auth.uid,
      clientId: stringOrUndefined(req.data?.clientId),
      accountUid: stringOrUndefined(req.data?.accountUid),
      label: stringOrUndefined(req.data?.label) ?? "firebase-browser",
      capability: req.data?.capability ?? null,
      registeredAt: now,
      lastSeenAt: now,
      clientVersion: CLIENT_VERSION,
    };
    await firestore.collection(COLLECTIONS.computeWorkers).doc(workerId).set(worker, { merge: true });
    await ensureStatsDoc(firestore, now);
    return {
      ok: true,
      workerId,
      workerSessionId: `firebase:${auth.uid}`,
      workerSessionToken: "firebase-auth",
      clientVersion: CLIENT_VERSION,
      supportedKernels: ALL_LANES.map((entry) => entry.kernelId),
    };
  },
);

export const computeClaim = onCall(
  { region: REGION, memory: "512MiB", timeoutSeconds: 60 },
  async (req) => {
    const auth = requireAuth(req.auth?.uid);
    const workerId = String(req.data?.workerId ?? workerIdForUid(auth.uid));
    if (workerId !== workerIdForUid(auth.uid)) {
      throw new HttpsError("permission-denied", "worker does not belong to uid");
    }

    const firestore = db();
    const now = Date.now();
    const workerRef = firestore.collection(COLLECTIONS.computeWorkers).doc(workerId);
    const assignmentId = `ca-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
    const assignmentRef = firestore.collection(COLLECTIONS.computeAssignments).doc(assignmentId);

    const assignment = await firestore.runTransaction(async (tx) => {
      const workerSnap = await tx.get(workerRef);
      if (!workerSnap.exists) {
        throw new HttpsError("failed-precondition", "worker not registered");
      }
      const worker = workerSnap.data() as ComputeWorkerDoc;
      const lastClaimAt = Number(worker.lastClaimAt ?? 0);
      if (lastClaimAt && now - lastClaimAt < CLAIM_COOLDOWN_MS) return null;

      const assignmentCount = Number(worker.assignmentsStarted ?? 0);
      const selected = selectLane(worker, auth.uid, assignmentCount, now);
      const params = selected.buildParams(now, auth.uid, assignmentCount);
      const expected = selected.run(params);
      const expectedOutputHash = String(expected.outputHash);
      const inputHash = hashObject({ kernelId: selected.kernelId, params });
      const doc: ComputeAssignmentDoc = {
        assignmentId,
        assignmentToken: randomUUID(),
        uid: auth.uid,
        workerId,
        taskId: `task-${selected.kernelId}`,
        chunkId: `chunk-${assignmentId}`,
        kernelId: selected.kernelId,
        kind: selected.kernelId,
        params,
        kernelHash: selected.kernelHash,
        inputHash,
        expectedOutputHash,
        requiredRuntime: selected.runtime,
        status: "offered",
        createdAt: now,
        assignedAt: now,
        expiresAt: now + ASSIGNMENT_TTL_MS,
      };
      tx.set(assignmentRef, doc);
      tx.set(workerRef, {
        lastSeenAt: now,
        lastClaimAt: now,
        assignmentsStarted: FieldValue.increment(1),
      }, { merge: true });
      return doc;
    });

    if (!assignment) return { ok: true, assignment: null, retryAfterMs: CLAIM_COOLDOWN_MS };

    return {
      ok: true,
      assignment: {
        assignmentId: assignment.assignmentId,
        assignmentToken: assignment.assignmentToken,
        taskId: assignment.taskId,
      },
      task: {
        taskId: assignment.taskId,
        kind: assignment.kind,
        validationPolicy: { mode: "expected-hash" },
        requiredRuntime: assignment.requiredRuntime,
      },
      chunk: {
        chunkId: assignment.chunkId,
        kind: assignment.kind,
        params: assignment.params,
        kernelId: assignment.kernelId,
        kernelHash: assignment.kernelHash,
        inputHash: assignment.inputHash,
      },
    };
  },
);

export const computeSubmitReceipt = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 30 },
  async (req) => {
    const auth = requireAuth(req.auth?.uid);
    const receipt = req.data?.receipt;
    if (!receipt || typeof receipt !== "object") throw new HttpsError("invalid-argument", "receipt required");

    const assignmentId = String(receipt.assignmentId ?? "");
    const assignmentToken = String(receipt.assignmentToken ?? "");
    const outputHashValue = String(receipt.outputHash?.value ?? receipt.outputHash ?? "");
    if (!assignmentId || !assignmentToken || !outputHashValue) {
      throw new HttpsError("invalid-argument", "assignmentId, assignmentToken, outputHash required");
    }

    const firestore = db();
    const now = Date.now();
    const assignmentRef = firestore.collection(COLLECTIONS.computeAssignments).doc(assignmentId);
    const assignmentSnap = await assignmentRef.get();
    if (!assignmentSnap.exists) throw new HttpsError("not-found", "assignment not found");
    const assignment = assignmentSnap.data() as ComputeAssignmentDoc;
    if (assignment.uid !== auth.uid) throw new HttpsError("permission-denied", "assignment belongs to another uid");
    if (assignment.assignmentToken !== assignmentToken) throw new HttpsError("permission-denied", "assignment token mismatch");
    if (assignment.status === "receipted") throw new HttpsError("already-exists", "assignment already receipted");
    if (assignment.expiresAt <= now) throw new HttpsError("deadline-exceeded", "assignment expired");
    if (receipt.kernelId && String(receipt.kernelId) !== assignment.kernelId) {
      throw new HttpsError("invalid-argument", "receipt kernelId mismatch");
    }

    const expectedHash = assignment.expectedOutputHash;
    const decision = outputHashValue === expectedHash ? "accepted" : "rejected";
    const receiptId = `cr-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
    const receiptDoc = {
      receiptId,
      uid: auth.uid,
      workerId: assignment.workerId,
      assignmentId,
      taskId: assignment.taskId,
      chunkId: assignment.chunkId,
      kernelId: assignment.kernelId,
      taskKind: assignment.kind,
      requiredRuntime: assignment.requiredRuntime,
      transport: stringOrUndefined(receipt.transport) ?? "firebase-fallback",
      executionMode: stringOrUndefined(receipt.executionMode) ?? assignment.requiredRuntime,
      decision,
      outputHash: { algorithm: "sha256", value: outputHashValue },
      expectedOutputHash: { algorithm: "sha256", value: expectedHash },
      computeMs: numberOr(receipt.computeMs, 0),
      peerSubreceipt: boundedPayload(receipt.peerSubreceipt, 8192),
      publicOutput: boundedPayload(receipt.publicOutput, 8192),
      derived: boundedPayload(receipt.derived, 8192),
      preview: boundedPayload(receipt.preview, 8192),
      receivedAt: now,
      expiresAt: now + RECEIPT_RETENTION_WINDOW_MS,
      clientVersion: stringOrUndefined(receipt.clientVersion) ?? CLIENT_VERSION,
    };

    const batch = firestore.batch();
    batch.set(firestore.collection(COLLECTIONS.computeReceipts).doc(receiptId), receiptDoc);
    batch.set(assignmentRef, {
      status: "receipted",
      decision,
      receiptId,
      receiptedAt: now,
    }, { merge: true });
    batch.set(firestore.collection(COLLECTIONS.computeWorkers).doc(assignment.workerId), {
      lastSeenAt: now,
      receiptsSubmitted: FieldValue.increment(1),
    }, { merge: true });
    batch.set(firestore.collection(COLLECTIONS.computePublicStats).doc("latest"), {
      schema: "m3t4.compute-public.v1",
      updatedAt: now,
      totalReceipts: FieldValue.increment(1),
      acceptedReceipts: FieldValue.increment(decision === "accepted" ? 1 : 0),
      rejectedReceipts: FieldValue.increment(decision === "rejected" ? 1 : 0),
      webrtcReceipts: FieldValue.increment(receiptDoc.transport === "webrtc" ? 1 : 0),
      firebaseFallbackReceipts: FieldValue.increment(receiptDoc.transport === "firebase-fallback" ? 1 : 0),
      webgpuReceipts: FieldValue.increment(receiptDoc.executionMode === "webgpu" ? 1 : 0),
      activeWorkers: FieldValue.increment(0),
    }, { merge: true });
    await batch.commit();

    logger.info("computeSubmitReceipt", { uid: auth.uid, assignmentId, kernelId: assignment.kernelId, decision });
    return {
      ok: true,
      receipt: {
        receiptId,
        assignmentId,
        taskId: assignment.taskId,
        chunkId: assignment.chunkId,
        kernelId: assignment.kernelId,
        decision,
        transport: receiptDoc.transport,
        executionMode: receiptDoc.executionMode,
        outputHash: receiptDoc.outputHash,
      },
    };
  },
);

export const computeMyReceipts = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 30 },
  async (req) => {
    const auth = requireAuth(req.auth?.uid);
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(req.data?.limit ?? 50))));
    const snap = await db()
      .collection(COLLECTIONS.computeReceipts)
      .where("uid", "==", auth.uid)
      .limit(limit)
      .get();
    const receipts = snap.docs
      .map((doc) => doc.data())
      .sort((a, b) => Number(b.receivedAt ?? 0) - Number(a.receivedAt ?? 0))
      .slice(0, limit);
    return { ok: true, scope: "account", accountUid: auth.uid, receipts };
  },
);

export const computePublicSummary = onCall(
  { region: REGION, memory: "256MiB", timeoutSeconds: 30 },
  async () => {
    const firestore = db();
    const now = Date.now();
    await ensureStatsDoc(firestore, now);
    const [statsSnap, activeWorkersSnap] = await Promise.all([
      firestore.collection(COLLECTIONS.computePublicStats).doc("latest").get(),
      firestore.collection(COLLECTIONS.computePeerPresence).orderBy("lastSeenAt", "desc").limit(100).get(),
    ]);
    const stats = statsSnap.data() ?? {};
    const totalReceipts = numberOr(stats.totalReceipts, 0);
    const accepted = numberOr(stats.acceptedReceipts, 0);
    const webrtc = numberOr(stats.webrtcReceipts, 0);
    const webgpu = numberOr(stats.webgpuReceipts, 0);
    return {
      ok: true,
      status: {
        acceptAssignments: true,
        assignmentIntakeClosesAt: null,
        webrtcSignalingEnabled: true,
        webrtcDataEnabled: true,
        gpuPreferred: true,
      },
      stats: {
        privacy: "aggregate",
        computeScore: accepted,
        totalReceipts,
        activeWorkers: activeWorkersSnap.docs.filter((doc) => Number(doc.data().lastSeenAt ?? 0) >= now - 90_000).length,
        medianKernelMs: null,
        webgpuCorrectnessPct: totalReceipts ? Math.round((accepted / totalReceipts) * 100) : 0,
        webrtcDirectSuccessPct: totalReceipts ? Math.round((webrtc / totalReceipts) * 100) : 0,
        webgpuReceiptPct: totalReceipts ? Math.round((webgpu / totalReceipts) * 100) : 0,
        scoreBreakdown: { acceptedReceipts: accepted, webgpuReceipts: webgpu },
      },
      useCases: ALL_LANES.map((entry) => ({
        id: `firebase-${entry.kernelId}`,
        family: entry.family,
        runtime: entry.runtime === "webgpu" ? "webgpu-webrtc" : "cpu-webrtc",
        title: entry.title,
        status: "implemented",
        workload: entry.kernelId,
        authority: "advisory",
        inputBoundary: entry.inputBoundary,
        validation: "assignment-bound expected-hash receipt verified by Firebase Function",
        notes: "Browsers attempt WebRTC peer execution first; if no peer answers, the claiming browser computes through the same plasma worker and submits a fallback receipt.",
        policy: { release: "experimental" },
      })),
    };
  },
);

function lane(
  kernelId: string,
  kernelHash: unknown,
  title: string,
  family: string,
  runtime: "cpu" | "webgpu",
  inputBoundary: string,
  buildParams: KernelLane["buildParams"],
  runRaw: (params: never) => unknown,
): KernelLane {
  return {
    kernelId,
    kernelHash: String(kernelHash),
    title,
    family,
    runtime,
    inputBoundary,
    buildParams,
    run: (params) => {
      const result = runRaw(params as never) as Record<string, unknown>;
      return { ...result, outputHash: String(result.outputHash ?? "") } as KernelResult;
    },
  };
}

function selectLane(worker: ComputeWorkerDoc, uid: string, assignmentCount: number, now: number): KernelLane {
  const kernels = capabilityStrings(worker.capability, "kernels");
  const surfaces = capabilityStrings(worker.capability, "runtimeSurfaces");
  const supportsWebGpu = surfaces.includes("webgpu");
  const preferred = supportsWebGpu ? WEBGPU_LANES : CPU_LANES;
  const supportedPreferred = preferred.filter((entry) => supportsLane(entry, kernels, supportsWebGpu));
  const supportedFallback = CPU_LANES.filter((entry) => supportsLane(entry, kernels, supportsWebGpu));
  const pool = supportedPreferred.length ? supportedPreferred : supportedFallback.length ? supportedFallback : [CPU_LANES[0]];
  const idx = positiveMod(hashInt(`${uid}:${assignmentCount}:${Math.floor(now / CLAIM_COOLDOWN_MS)}`), pool.length);
  return pool[idx];
}

function supportsLane(entry: KernelLane, kernels: string[], supportsWebGpu: boolean): boolean {
  if (entry.runtime === "webgpu" && !supportsWebGpu) return false;
  return kernels.length === 0 || kernels.includes(entry.kernelId);
}

function primeParams(now: number, uid: string, assignmentCount: number): JsonMap {
  const mixed = hashInt(`${uid}:${assignmentCount}:${Math.floor(now / 10_000)}`);
  const start = 100_000 + (mixed % 20_000);
  return { start, endExclusive: start + 384 };
}

function tensorParams(now: number, uid: string, assignmentCount: number): JsonMap {
  return { seed: hashInt(`${uid}:tensor:${assignmentCount}:${now}`), rows: 32, cols: 32, depth: 64 };
}

function contactParams(_now: number, _uid: string, assignmentCount: number): JsonMap {
  const preset = CONTACT_MAP_PRESETS[assignmentCount % CONTACT_MAP_PRESETS.length];
  return {
    rowResidues: preset.rowResidues,
    colResidues: preset.colResidues,
    rowStart: preset.rowStart,
    colStart: preset.colStart,
    minSeparation: preset.minSeparation,
  };
}

function mandelbrotParams(_now: number, _uid: string, assignmentCount: number): JsonMap {
  const shift = (assignmentCount % 3) * 24;
  return {
    widthPx: 48,
    heightPx: 48,
    minXQ88: -512 + shift,
    maxXQ88: 128 + shift,
    minYQ88: -320,
    maxYQ88: 320,
    maxIter: 96,
  };
}

function heatParams(now: number, uid: string, assignmentCount: number): JsonMap {
  const seed = hashInt(`${uid}:heat:${assignmentCount}:${Math.floor(now / 10_000)}`);
  return {
    widthPx: 32,
    heightPx: 32,
    iterations: 72,
    shift: 3,
    hotspots: [
      { xPx: 8 + (seed % 8), yPx: 8 + ((seed >>> 4) % 8), valueQ88: 0x8000 },
      { xPx: 20 + ((seed >>> 8) % 6), yPx: 18 + ((seed >>> 12) % 6), valueQ88: 0x5000 },
    ],
  };
}

function webgpuWitnessParams(now: number, uid: string, assignmentCount: number): JsonMap {
  return { seed: hashInt(`${uid}:gpu:${assignmentCount}:${now}`), count: 1024 };
}

function derivedBufferParams(now: number, uid: string, assignmentCount: number): JsonMap {
  return { seed: hashInt(`${uid}:derived:${assignmentCount}:${now}`), count: 512 };
}

function renderFixtureParams(): JsonMap {
  return { fixture: "canvas2d-alpha-samples-v1" };
}

function genomeParams(_now: number, _uid: string, assignmentCount: number): JsonMap {
  const preset = GENOME_KMER_PRESETS[assignmentCount % GENOME_KMER_PRESETS.length];
  return { sequenceId: preset.id, sequence: preset.sequence, k: preset.defaultK };
}

function imageAssetParams(_now: number, _uid: string, assignmentCount: number): JsonMap {
  return { ...IMAGE_TILE_SAMPLE_PRESETS[assignmentCount % IMAGE_TILE_SAMPLE_PRESETS.length] };
}

function imageInferParams(_now: number, _uid: string, assignmentCount: number): JsonMap {
  return { ...IMAGE_TILE_SAMPLE_PRESETS[assignmentCount % IMAGE_TILE_SAMPLE_PRESETS.length], topK: 3 };
}

function microscopyParams(_now: number, _uid: string, assignmentCount: number): JsonMap {
  return { ...MICROSCOPY_TILE_SAMPLE_PRESETS[assignmentCount % MICROSCOPY_TILE_SAMPLE_PRESETS.length] };
}

function seedSweepParams(now: number, uid: string, assignmentCount: number): JsonMap {
  const seedStart = hashInt(`${uid}:seed-sweep:${assignmentCount}:${Math.floor(now / 10_000)}`) % 10_000;
  return {
    stageId: "datacenter",
    brainA: assignmentCount % 2 === 0 ? "founder" : "disruptor",
    brainB: assignmentCount % 2 === 0 ? "disruptor" : "founder",
    seedStart,
    seedEndExclusive: seedStart + 4,
    maxTicks: 2400,
    simConstantsHash: SEED_SWEEP_KERNEL_BINDING.simConstantsHash,
    behaviorVersion: SEED_SWEEP_KERNEL_BINDING.behaviorVersion,
  };
}

function exploitParams(now: number, uid: string, assignmentCount: number): JsonMap {
  const seedStart = hashInt(`${uid}:exploit:${assignmentCount}:${Math.floor(now / 10_000)}`) % 10_000;
  return {
    stageId: "datacenter",
    brainA: "founder",
    brainB: "disruptor",
    seedStart,
    seedEndExclusive: seedStart + 3,
    maxTicks: 2400,
    topFindings: 4,
  };
}

function requireAuth(uid: string | undefined): { uid: string } {
  if (!uid) throw new HttpsError("unauthenticated", "sign in required");
  return { uid };
}

async function ensureStatsDoc(firestore: Firestore, now: number): Promise<void> {
  await firestore.collection(COLLECTIONS.computePublicStats).doc("latest").set({
    schema: "m3t4.compute-public.v1",
    updatedAt: now,
    totalReceipts: FieldValue.increment(0),
    acceptedReceipts: FieldValue.increment(0),
    rejectedReceipts: FieldValue.increment(0),
    webrtcReceipts: FieldValue.increment(0),
    firebaseFallbackReceipts: FieldValue.increment(0),
    webgpuReceipts: FieldValue.increment(0),
  }, { merge: true });
}

function workerIdForUid(uid: string): string {
  return `cw-${sha256Hex(uid).slice(0, 24)}`;
}

function capabilityStrings(capability: unknown, key: "kernels" | "runtimeSurfaces"): string[] {
  if (!capability || typeof capability !== "object") return [];
  const value = (capability as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function boundedPayload(value: unknown, maxChars: number): unknown {
  if (value === undefined || value === null) return null;
  try {
    const json = JSON.stringify(value);
    if (!json || json.length > maxChars) return null;
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function hashObject(value: unknown): { algorithm: "sha256"; value: string } {
  return { algorithm: "sha256", value: sha256Hex(stableJson(value)) };
}

function hashInt(value: string): number {
  return parseInt(sha256Hex(value).slice(0, 8), 16) >>> 0;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 256) : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
