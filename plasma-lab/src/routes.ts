import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonWebKey } from "node:crypto";
import type { PlasmaLabConfig } from "./config.js";
import { clientIp, header, html, json, readJson } from "./http.js";
import { canonicalJson, hashCanonical } from "./plasma/hash.js";
import type { ContentHash, DerivedExecutionEvidence, ExecutionMode, GovernorMode, TransportKind, ValidationPolicy, WorkerCapability, WorkerRefusalReason } from "./plasma/types.js";
import { bundleManifestHash, ComputeLabStore, type ComputeChunk, type ExecutionReceipt, type PeerSubassignment, type PeerSubreceipt, type ValidationRecord, type WebRtcPairRecord, type WebRtcSessionRecord, type WorkerRecord } from "./store.js";
import { COMPUTE_USE_CASES } from "./use-cases.js";
import { canSeed, getWorkloadPolicy, isPublicVisible } from "./workload-policy.js";
import { CONTACT_MAP_PRESETS, resolveContactMapPreset } from "./contact-map-presets.js";
import { GENOME_KMER_PRESETS, resolveGenomeKmerPreset } from "./genome-kmer-presets.js";
import { IMAGE_TILE_SAMPLE_PRESETS, MICROSCOPY_TILE_SAMPLE_PRESETS, resolveTileSamplePreset } from "./image-tile-presets.js";
import { DEVICE_WITNESS_WEBGPU_KERNEL_ID } from "./kernels/device-witness.js";

export interface RouteDeps {
  store: ComputeLabStore;
  config: PlasmaLabConfig;
  eventLog?: (event: Record<string, unknown>) => void;
}

interface WorkerAuthBody {
  workerId?: string;
  workerSessionId?: string;
  workerSessionToken?: string;
}

const MIN_ASSIGNMENT_WINDOW_MS = 1_000;
const MAX_ASSIGNMENT_WINDOW_MS = 600_000;
const PUBLIC_READ_REFRESH_TTL_MS = 30_000;
const CLOSED_INTAKE_RETRY_AFTER_MS = 60_000;
const OPEN_IDLE_RETRY_AFTER_MS = 5_000;

type RefreshableStore = ComputeLabStore & {
  refresh?: () => Promise<void>;
  flush?: () => Promise<void>;
};

const refreshCache = new WeakMap<ComputeLabStore, { lastRefreshAt: number; inFlight?: Promise<void> }>();

export async function handleComputeLabRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps,
): Promise<boolean> {
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return true;
  }

  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/compute/healthz")) {
    json(res, 200, { ok: true, service: "plasma-lab" });
    return true;
  }

  if (!deps.config.routesEnabled && url.pathname.startsWith("/compute/")) {
    json(res, 404, { error: "compute lab routes disabled" });
    return true;
  }

  if (url.pathname.startsWith("/compute/")) {
    const mode = refreshModeForRequest(req, url);
    if (mode === "fresh") await refreshStore(deps.store);
    else if (mode === "cached") await refreshStoreCached(deps.store, PUBLIC_READ_REFRESH_TTL_MS);
  }

  if (req.method === "POST" && url.pathname === "/compute/workers/register") {
    const body = await readJson<{
      label?: string;
      capability?: WorkerCapability;
      signingPublicKey?: JsonWebKey;
      clientId?: string;
      accountUid?: string;
      inviteToken?: string;
    }>(req);
    if (!body?.capability || !Array.isArray(body.capability.kernels)) {
      json(res, 400, { error: "capability.kernels required" });
      return true;
    }
    if (deps.config.requireReceiptSignatures && !body.signingPublicKey) {
      json(res, 400, { error: "signingPublicKey required" });
      return true;
    }
    const admission = workerRegistrationAdmission(req, body, deps);
    if (!admission.ok) {
      json(res, 403, { error: admission.error });
      return true;
    }
    try {
      const { worker, session, acceptedKernels } = deps.store.registerWorker({
        label: body.label,
        capability: sanitizePublicWorkerCapability(body.capability, adminAllowed(req, deps.config)),
        signingPublicKey: body.signingPublicKey,
        clientId: body.clientId,
        accountUid: body.accountUid,
        clientIpHash: admission.clientIpHash,
        inviteId: admission.inviteId,
      });
      const bootstrapWitnessTaskId = maybeSeedWebGpuBootstrapWitness(deps.store, worker);
      await flushStore(deps.store);
      json(res, 200, {
        workerId: worker.workerId,
        workerSessionId: session.workerSessionId,
        workerSessionToken: session.token,
        expiresAt: session.expiresAt,
        receiptSigning: session.signingPublicKeyHash
          ? { algorithm: "ecdsa-p256-sha256", publicKeyHash: session.signingPublicKeyHash }
          : undefined,
        acceptedKernels,
        bootstrapWitnessTaskId,
      });
    } catch (e) {
      const error = message(e);
      if (/worker registration .* cap exceeded/i.test(error)) {
        res.setHeader("retry-after", "60");
        json(res, 429, { error, retryAfterMs: 60_000 });
      } else {
        json(res, 400, { error });
      }
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/workers/heartbeat") {
    const body = await readJson<WorkerAuthBody & { governorMode?: GovernorMode }>(req);
    try {
      const session = deps.store.heartbeat(authFrom(body, req, { governorMode: body?.governorMode }));
      await flushStore(deps.store);
      json(res, 200, { ok: true, workerSessionId: session.workerSessionId, expiresAt: session.expiresAt });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/workers/status") {
    const workerId = url.searchParams.get("workerId") ?? "";
    const status = deps.store.workerStatus(workerId);
    if (!status) json(res, 404, { error: "unknown worker" });
    else json(res, 200, status);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/capabilities") {
    const body = await readJson<WorkerAuthBody & { capability?: WorkerCapability }>(req);
    if (!body?.capability) {
      json(res, 400, { error: "capability required" });
      return true;
    }
    try {
      const worker = deps.store.updateCapability(authFrom(body, req, {
        capability: sanitizePublicWorkerCapability(body.capability, adminAllowed(req, deps.config)),
      }));
      const bootstrapWitnessTaskId = maybeSeedWebGpuBootstrapWitness(deps.store, worker);
      await flushStore(deps.store);
      json(res, 200, { ok: true, acceptedKernels: worker.capability.kernels, bootstrapWitnessTaskId });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/connectivity") {
    const body = await readJson<WorkerAuthBody & {
      transport?: "http" | "webrtc-local" | "webrtc-signaling";
      status?: "ok" | "timeout" | "failed" | "unsupported";
      mode?: GovernorMode;
      browserFamily?: string;
      deviceClass?: string;
      networkTypeBucket?: string;
      downlinkBucket?: string;
      rttBucket?: string;
      httpRttBucket?: string;
      webrtcOpenMsBucket?: string;
      iceGatherMsBucket?: string;
      iceHostBucket?: string;
      iceSrflxBucket?: string;
      iceRelayBucket?: string;
      stunSuccessBucket?: string;
      turnNeedBucket?: string;
      signalingRttBucket?: string;
      dataChannelBucket?: string;
      dataWorkBucket?: string;
      dataReceiptBucket?: string;
      visibilityBucket?: string;
      batteryBucket?: string;
      notes?: string;
    }>(req);
    try {
      const observation = deps.store.submitConnectivityObservation(authFrom(body, req, {
        observation: {
          transport: body?.transport ?? "http",
          status: body?.status ?? "failed",
          mode: body?.mode,
          browserFamily: body?.browserFamily,
          deviceClass: body?.deviceClass,
          networkTypeBucket: body?.networkTypeBucket,
          downlinkBucket: body?.downlinkBucket,
          rttBucket: body?.rttBucket,
          httpRttBucket: body?.httpRttBucket,
          webrtcOpenMsBucket: body?.webrtcOpenMsBucket,
          iceGatherMsBucket: body?.iceGatherMsBucket,
          iceHostBucket: body?.iceHostBucket,
          iceSrflxBucket: body?.iceSrflxBucket,
          iceRelayBucket: body?.iceRelayBucket,
          stunSuccessBucket: body?.stunSuccessBucket,
          turnNeedBucket: body?.turnNeedBucket,
          signalingRttBucket: body?.signalingRttBucket,
          dataChannelBucket: body?.dataChannelBucket,
          dataWorkBucket: body?.dataWorkBucket,
          dataReceiptBucket: body?.dataReceiptBucket,
          visibilityBucket: body?.visibilityBucket,
          batteryBucket: body?.batteryBucket,
          notes: body?.notes,
        },
      }));
      await flushStore(deps.store);
      json(res, 200, { ok: true, observationId: observation.observationId });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/workers/receipts") {
    try {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : undefined;
      const result = deps.store.listReceiptsForIdentity({
        workerId: url.searchParams.get("workerId") ?? "",
        workerSessionId: url.searchParams.get("workerSessionId") ?? "",
        workerSessionToken: header(req, "x-worker-session-token"),
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      json(res, 200, result);
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/tasks/next") {
    try {
      if (!deps.store.summary().acceptAssignments) {
        json(res, 200, {
          idle: true,
          reason: "assignments-disabled",
          retryAfterMs: CLOSED_INTAKE_RETRY_AFTER_MS,
        });
        return true;
      }
      await refreshStore(deps.store);
      if (!deps.store.summary().acceptAssignments) {
        json(res, 200, {
          idle: true,
          reason: "assignments-disabled",
          retryAfterMs: CLOSED_INTAKE_RETRY_AFTER_MS,
        });
        return true;
      }
      const next = deps.store.assignNext({
        workerId: url.searchParams.get("workerId") ?? "",
        workerSessionId: url.searchParams.get("workerSessionId") ?? "",
        workerSessionToken: header(req, "x-worker-session-token"),
      });
      if (!next) {
        const acceptAssignments = deps.store.summary().acceptAssignments;
        if (acceptAssignments) await flushStore(deps.store);
        json(res, 200, {
          idle: true,
          reason: acceptAssignments ? "no-work" : "assignments-disabled",
          retryAfterMs: acceptAssignments ? OPEN_IDLE_RETRY_AFTER_MS : CLOSED_INTAKE_RETRY_AFTER_MS,
        });
        return true;
      }
      await flushStore(deps.store);
      json(res, 200, {
        assignment: next.assignment,
        chunk: publicComputeChunk(next.chunk),
        task: {
          taskId: next.task.taskId,
          kind: next.task.kind,
          validationPolicy: publicValidationPolicy(next.task.validationPolicy),
        },
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/assignments/accept") {
    const body = await readJson<WorkerAuthBody & {
      assignmentId?: string;
      assignmentToken?: string;
      refusalReason?: WorkerRefusalReason;
    }>(req);
    try {
      const assignment = deps.store.acceptAssignment(authFrom(body, req, {
        assignmentId: body?.assignmentId ?? "",
        assignmentToken: body?.assignmentToken ?? "",
        refusalReason: body?.refusalReason,
      }));
      await flushStore(deps.store);
      json(res, 200, { ok: assignment.status === "accepted", assignment });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/receipts") {
    const body = await readJson<WorkerAuthBody & {
      assignmentId?: string;
      assignmentToken?: string;
      taskId?: string;
      chunkId?: string;
      kernelId?: string;
      kernelHash?: ContentHash;
      inputHash?: ContentHash;
      artifactHash?: ContentHash;
      outputHash?: ContentHash;
      determinismClass?: "bit-exact" | "tolerance-bounded" | "replicated-quorum";
      validationMode?: "expected-hash" | "quorum" | "tolerance" | "human-review" | "measurement";
      executionMode?: ExecutionMode;
      transport?: TransportKind;
      governorMode?: GovernorMode;
      deviceClass?: string;
      adapterInfo?: Record<string, unknown>;
      derived?: DerivedExecutionEvidence;
      publicOutput?: Record<string, unknown>;
      computeMs?: number;
      clientVersion?: string;
      receiptHash?: ContentHash;
      signature?: string;
    }>(req);
    try {
      if (!body?.kernelHash || !body.inputHash || !body.outputHash) throw new Error("kernelHash, inputHash, outputHash required");
      const result = deps.store.submitReceipt(authFrom(body, req, {
        assignmentId: body.assignmentId ?? "",
        assignmentToken: body.assignmentToken ?? "",
        taskId: body.taskId ?? "",
        chunkId: body.chunkId ?? "",
        kernelId: body.kernelId ?? "",
        kernelHash: body.kernelHash,
        inputHash: body.inputHash,
        artifactHash: body.artifactHash,
        outputHash: body.outputHash,
        determinismClass: body.determinismClass ?? "bit-exact",
        validationMode: body.validationMode ?? "expected-hash",
        executionMode: body.executionMode ?? "cpu",
        transport: body.transport ?? "http",
        governorMode: body.governorMode,
        deviceClass: body.deviceClass,
        adapterInfo: body.adapterInfo,
        derived: body.derived,
        publicOutput: body.publicOutput,
        computeMs: Number(body.computeMs) || 0,
        clientVersion: body.clientVersion,
        receiptHash: body.receiptHash,
        signature: body.signature,
      }));
      logDerivedReceiptOutcome(deps, result);
      await flushStore(deps.store);
      json(res, 200, result);
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (url.pathname.startsWith("/compute/webrtc/")) {
    return handleWebRtc(req, res, url, deps);
  }

  if (req.method === "GET" && url.pathname === "/compute/status") {
    json(res, 200, {
      ...deps.store.summary(),
      webrtcSignalingEnabled: deps.config.webrtcSignalingEnabled,
      webrtcDataEnabled: deps.config.webrtcDataEnabled,
      webrtcTurnEnabled: deps.config.webrtcTurnEnabled,
      requireReceiptSignatures: deps.config.requireReceiptSignatures,
      publicRegistrationEnabled: deps.config.publicRegistrationEnabled,
      maxWorkersPerIp: deps.config.maxWorkersPerIp,
      maxSessionsPerClient: deps.config.maxSessionsPerClient,
      maxActiveAssignmentsPerIdentity: deps.config.maxActiveAssignmentsPerIdentity,
      strictProofTasksDefault: deps.config.strictProofTasksDefault,
      iceServers: publicIceServers(deps.config),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/use-cases") {
    json(res, 200, { useCases: publicUseCases() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/stats") {
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=120");
    json(res, 200, deps.store.publicStats());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/summary") {
    const summary = deps.store.summary();
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=120");
    json(res, 200, {
      stats: deps.store.publicStats(),
      useCases: publicUseCases(),
      status: {
        acceptAssignments: summary.acceptAssignments,
        assignmentIntakeClosesAt: summary.assignmentIntakeClosesAt,
      },
    });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/compute/public/replay-badges/")) {
    const matchId = url.pathname.slice("/compute/public/replay-badges/".length);
    const badge = deps.store.replayBadge(matchId);
    if (!badge || badge.status !== "verified") {
      json(res, 200, { status: "pending", matchId, generatedAt: Date.now() });
    } else {
      json(res, 200, badge);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/contact-map/aggregate") {
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=120");
    json(res, 200, deps.store.publicContactMapAggregate());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/tiles/manifest") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const tiles = deps.store.listPublicTiles({ limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined });
    const body = {
      kind: "m3t4.public-tile.manifest.v0",
      generatedAt: Date.now(),
      sourceOrder: ["cache", "p2p", "http"],
      fallback: { onHit: "return", onMiss: "next", onFailure: "terminal" },
      tiles: tiles.map((tile) => ({
        sha256: tile.sha256,
        mimeType: tile.mimeType,
        widthPx: tile.widthPx,
        heightPx: tile.heightPx,
        byteLength: tile.byteLength,
        provenance: tile.provenance,
        submittedAt: tile.submittedAt,
        httpPath: `/compute/public/tiles/${encodeURIComponent(tile.sha256)}`,
        cacheKey: `public-tile:${tile.sha256}`,
      })),
    };
    json(res, 200, { ...body, manifestHash: hashCanonical(body) });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/compute/public/tiles/")) {
    const sha256 = url.pathname.slice("/compute/public/tiles/".length);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      json(res, 400, { error: "sha256 must be 64 hex chars" });
      return true;
    }
    const tile = deps.store.getPublicTile(sha256);
    if (!tile) json(res, 404, { error: "tile not found" });
    else json(res, 200, tile);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/witness") {
    const body = await readJson<{
      matchId?: string;
      tick?: number;
      stateHash?: ContentHash;
      workerId?: string;
      workerSessionId?: string;
      workerSessionToken?: string;
      signingPublicKeyHash?: ContentHash;
      signature?: string;
    }>(req);
    try {
      if (!body?.matchId) throw new Error("matchId required");
      if (typeof body.tick !== "number") throw new Error("tick required");
      if (!body.stateHash?.algorithm || !body.stateHash?.value) throw new Error("stateHash required");
      if (!body.workerId || !body.workerSessionId || !body.workerSessionToken) {
        throw new Error("workerId, workerSessionId, workerSessionToken required");
      }
      const attestation = deps.store.submitWitnessAttestation({
        matchId: body.matchId,
        tick: body.tick,
        stateHash: body.stateHash,
        workerId: body.workerId,
        workerSessionId: body.workerSessionId,
        workerSessionToken: body.workerSessionToken,
        signingPublicKeyHash: body.signingPublicKeyHash,
        signature: body.signature,
      });
      await flushStore(deps.store);
      json(res, 200, { attestationId: attestation.attestationId, submittedAt: attestation.submittedAt });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/compute/public/matches/") && url.pathname.endsWith("/witness-quorum")) {
    const matchId = url.pathname.slice("/compute/public/matches/".length, -"/witness-quorum".length);
    if (!matchId) { json(res, 400, { error: "matchId required" }); return true; }
    json(res, 200, deps.store.witnessQuorumForMatch(matchId));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/bundles") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const statusRaw = url.searchParams.get("status");
    const status = statusRaw === "pending" || statusRaw === "running" || statusRaw === "sealed" || statusRaw === "abandoned"
      ? statusRaw : undefined;
    json(res, 200, {
      bundles: deps.store.listBundles({
        limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
        status,
      }),
    });
    return true;
  }

  // Downloadable verifier bundle. Everything needed to independently verify
  // that the bundleRoot seals the battle receipt + the manifest + each
  // accepted receipt's signed outputHash. No server cooperation required
  // to re-derive: bundleRootHash(matchReceiptHash, bundleManifestHash, ...).
  if (
    req.method === "GET" &&
    url.pathname.startsWith("/compute/public/bundles/") &&
    url.pathname.endsWith("/verifier-bundle")
  ) {
    const bundleId = url.pathname.slice(
      "/compute/public/bundles/".length,
      -"/verifier-bundle".length,
    );
    if (!bundleId) { json(res, 400, { error: "bundleId required" }); return true; }
    const bundle = deps.store.getBundle(bundleId);
    if (!bundle) { json(res, 404, { error: "bundle not found" }); return true; }
    const manifestHash = bundle.bundleManifestHash ?? bundleManifestHash(bundle);
    const acceptedReceipts: Array<Record<string, unknown>> = [];
    for (const chunkId of bundle.chunkIds) {
      const receipts = deps.store.receiptsForChunk(chunkId);
      const best = receipts.find((r) => r.decision === "accepted");
      if (!best) continue;
      acceptedReceipts.push({
        receiptId: best.receiptId,
        chunkId: best.chunkId,
        kernelId: best.kernelId,
        outputHash: best.outputHash,
        receiptHash: best.receiptHash,
        signature: best.signature,
        signaturePublicKeyHash: best.signaturePublicKeyHash,
        signatureStatus: best.signatureStatus,
        executionMode: best.executionMode,
        transport: best.transport,
        receivedAt: best.receivedAt,
        preview: best.preview,
      });
    }
    json(res, 200, {
      kind: "m3t4.compute-bundle.verifier.v1",
      generatedAt: Date.now(),
      bundle: {
        bundleId: bundle.bundleId,
        kind: bundle.kind,
        kernelId: bundle.kernelId,
        matchId: bundle.matchId,
        sponsors: bundle.sponsors,
        chunkIds: bundle.chunkIds,
        targetChunkCount: bundle.targetChunkCount,
        quorum: bundle.quorum,
        deadlineAt: bundle.deadlineAt,
        createdAt: bundle.createdAt,
        startedAt: bundle.startedAt,
        sealedAt: bundle.sealedAt,
        status: bundle.status,
        acceptedReceiptCount: bundle.acceptedReceiptCount,
        rejectedReceiptCount: bundle.rejectedReceiptCount,
        pendingReceiptCount: bundle.pendingReceiptCount,
      },
      bundleManifestHash: manifestHash,
      matchReceiptHash: bundle.matchReceiptHash ?? null,
      bundleRoot: bundle.bundleRoot ?? null,
      acceptedReceipts,
      rehash: {
        notes: "Verifiers: recompute bundleRootHash({matchReceiptHash, bundleManifestHash, sortedAcceptedReceiptHashes}) and compare against bundleRoot. Recompute bundleManifestHash from bundle fields.",
        algorithm: "sha256",
      },
    });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/compute/public/bundles/")) {
    const bundleId = url.pathname.slice("/compute/public/bundles/".length);
    if (!bundleId) { json(res, 400, { error: "bundleId required" }); return true; }
    const aggregate = deps.store.bundleAggregate(bundleId);
    if (!aggregate) { json(res, 404, { error: "bundle not found" }); return true; }
    json(res, 200, aggregate);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/receipt-log/manifest") {
    const limit = Number(url.searchParams.get("limit") ?? "");
    const segments = deps.store.listReceiptLogSegments({ limit: Number.isFinite(limit) && limit > 0 ? limit : undefined });
    res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=120");
    const body = {
      kind: "m3t4.receipt-log.manifest.v0",
      generatedAt: Date.now(),
      sourceOrder: ["cache", "p2p", "http"],
      fallback: {
        onHit: "return",
        onMiss: "next",
        onFailure: "terminal",
      },
      head: deps.store.receiptLogHead(),
      segments: segments.map((segment) => ({
        segmentId: segment.segmentId,
        firstSequence: segment.firstSequence,
        lastSequence: segment.lastSequence,
        entryCount: segment.entryCount,
        segmentHash: segment.segmentHash,
        prevSegmentHash: segment.prevSegmentHash,
        httpPath: `/compute/public/receipt-log/segments/${encodeURIComponent(segment.segmentId)}`,
        verifyPath: `/compute/public/receipt-log/segments/${encodeURIComponent(segment.segmentId)}/verify`,
        cacheKey: `receipt-log-segment:${segment.segmentHash.value}`,
      })),
    };
    json(res, 200, { ...body, manifestHash: hashCanonical(body) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/receipt-log/head") {
    json(res, 200, deps.store.receiptLogHead());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/receipt-log/projection") {
    json(res, 200, deps.store.publicReceiptLogProjection());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/receipt-log/verify") {
    const limit = Number(url.searchParams.get("limit") ?? "");
    json(res, 200, deps.store.verifyReceiptLogArchive({
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/receipt-log/segments") {
    const limit = Number(url.searchParams.get("limit") ?? "");
    json(res, 200, {
      segments: deps.store.listReceiptLogSegments({ limit: Number.isFinite(limit) && limit > 0 ? limit : undefined }),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/compute/public/receipt-log/segments/")) {
    const suffix = url.pathname.slice("/compute/public/receipt-log/segments/".length);
    const [segmentId, action] = suffix.split("/");
    if (action === "verify") {
      const verification = deps.store.verifyReceiptLogSegment(segmentId);
      if (!verification) json(res, 404, { error: "receipt log segment not found" });
      else {
        res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=600");
        json(res, 200, verification);
      }
      return true;
    }
    if (action === undefined || action === "") {
      const segment = deps.store.getReceiptLogSegment(segmentId);
      if (!segment) json(res, 404, { error: "receipt log segment not found" });
      else {
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
        json(res, 200, segment);
      }
      return true;
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/compute/receipts/") && url.pathname.endsWith("/verify")) {
    const receiptId = url.pathname.slice("/compute/receipts/".length, -"/verify".length);
    const verification = deps.store.verifyReceipt(receiptId);
    if (!verification || verification.decision !== "accepted") json(res, 404, { error: "accepted receipt not found" });
    else json(res, 200, verification);
    return true;
  }

  if (url.pathname.startsWith("/compute/admin/")) {
    return handleAdmin(req, res, url, deps);
  }

  return false;
}

async function handleWebRtc(req: IncomingMessage, res: ServerResponse, url: URL, deps: RouteDeps): Promise<boolean> {
  if (!deps.config.webrtcSignalingEnabled) {
    json(res, 404, { error: "WebRTC signaling disabled" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/webrtc/ice-config") {
    json(res, 200, { iceServers: publicIceServers(deps.config), turnEnabled: deps.config.webrtcTurnEnabled });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/webrtc/pairs/join") {
    const body = await readJson<WorkerAuthBody>(req);
    try {
      const joined = deps.store.joinWebRtcPair(authFrom(body, req, {}));
      await flushStore(deps.store);
      json(res, 200, {
        ...publicWebRtcPair(joined.pair, deps.config),
        role: joined.role,
        pairToken: joined.pair.token,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  const pairPrefix = "/compute/webrtc/pairs/";
  if (url.pathname.startsWith(pairPrefix)) {
    const [pairId, action] = url.pathname.slice(pairPrefix.length).split("/");
    const body = req.method === "GET"
      ? null
      : await readJson<{
        pairToken?: string;
        offer?: unknown;
        answer?: unknown;
        candidate?: unknown;
        candidates?: unknown[];
        peerId?: string;
        workerId?: string;
        workerSessionId?: string;
        workerSessionToken?: string;
        assignmentId?: string;
        assignmentToken?: string;
        requestId?: string;
      }>(req);
    const token = body?.pairToken ?? header(req, "x-webrtc-pair-token");
    try {
      if (req.method === "GET" && !action) {
        json(res, 200, publicWebRtcPair(deps.store.getWebRtcPair({ pairId, token }), deps.config));
        return true;
      }
      if (req.method === "POST" && action === "offer") {
        if (body?.offer === undefined) throw new Error("offer required");
        const pair = deps.store.setWebRtcPairOffer({ pairId, token, offer: body.offer });
        await flushStore(deps.store);
        json(res, 200, publicWebRtcPair(pair, deps.config));
        return true;
      }
      if (req.method === "POST" && action === "answer") {
        if (body?.answer === undefined) throw new Error("answer required");
        const pair = deps.store.setWebRtcPairAnswer({ pairId, token, answer: body.answer });
        await flushStore(deps.store);
        json(res, 200, publicWebRtcPair(pair, deps.config));
        return true;
      }
      if (req.method === "POST" && action === "candidates") {
        const candidates = Array.isArray(body?.candidates)
          ? body.candidates
          : body?.candidate === undefined
            ? []
            : [body.candidate];
        if (candidates.length === 0) throw new Error("candidate or candidates required");
        const pair = deps.store.addWebRtcPairCandidates({
          pairId,
          token,
          peerId: body?.peerId,
          candidates,
        });
        await flushStore(deps.store);
        json(res, 200, publicWebRtcPair(pair, deps.config));
        return true;
      }
      if (req.method === "POST" && action === "peer-subassignments") {
        const subassignment = deps.store.issuePeerSubassignment(authFrom(body, req, {
          assignmentId: body?.assignmentId ?? "",
          assignmentToken: body?.assignmentToken ?? "",
          pairId,
          pairToken: token,
          requestId: body?.requestId ?? "",
        }));
        await flushStore(deps.store);
        json(res, 200, publicPeerSubassignment(subassignment, true));
        return true;
      }
      if (req.method === "POST" && action === "close") {
        const pair = deps.store.closeWebRtcPair({ pairId, token });
        await flushStore(deps.store);
        json(res, 200, publicWebRtcPair(pair, deps.config));
        return true;
      }
      json(res, 404, { error: "WebRTC pair route not found" });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  const peerSubassignmentPrefix = "/compute/webrtc/peer-subassignments/";
  if (url.pathname.startsWith(peerSubassignmentPrefix)) {
    const [peerAssignmentId, action] = url.pathname.slice(peerSubassignmentPrefix.length).split("/");
    const body = await readJson<WorkerAuthBody & {
      peerAssignmentToken?: string;
      peerSubreceipt?: PeerSubreceipt;
    }>(req);
    try {
      if (req.method === "POST" && action === "receipt") {
        if (!body?.peerSubreceipt) throw new Error("peerSubreceipt required");
        const subassignment = deps.store.submitPeerSubassignmentReceipt(authFrom(body, req, {
          peerAssignmentId,
          peerAssignmentToken: body.peerAssignmentToken ?? "",
          peerSubreceipt: body.peerSubreceipt,
        }));
        await flushStore(deps.store);
        json(res, 200, { ok: subassignment.status === "accepted", peerSubassignment: publicPeerSubassignment(subassignment) });
        return true;
      }
      json(res, 404, { error: "WebRTC peer subassignment route not found" });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/webrtc/sessions") {
    const session = deps.store.createWebRtcSession();
    await flushStore(deps.store);
    json(res, 200, {
      ...publicWebRtcSession(session, deps.config),
      sessionToken: session.token,
    });
    return true;
  }

  const prefix = "/compute/webrtc/sessions/";
  if (!url.pathname.startsWith(prefix)) {
    json(res, 404, { error: "WebRTC route not found" });
    return true;
  }
  const [sessionId, action] = url.pathname.slice(prefix.length).split("/");
  const body = req.method === "GET"
    ? null
    : await readJson<{
      sessionToken?: string;
      offer?: unknown;
      answer?: unknown;
      candidate?: unknown;
      candidates?: unknown[];
      peerId?: string;
    }>(req);
  const token = body?.sessionToken ?? header(req, "x-webrtc-session-token");
  try {
    if (req.method === "POST" && action === "offer") {
      if (body?.offer === undefined) throw new Error("offer required");
      const session = deps.store.setWebRtcOffer({ sessionId, token, offer: body.offer });
      await flushStore(deps.store);
      json(res, 200, publicWebRtcSession(session, deps.config));
      return true;
    }
    if (req.method === "POST" && action === "answer") {
      if (body?.answer === undefined) throw new Error("answer required");
      const session = deps.store.setWebRtcAnswer({ sessionId, token, answer: body.answer });
      await flushStore(deps.store);
      json(res, 200, publicWebRtcSession(session, deps.config));
      return true;
    }
    if (req.method === "POST" && action === "candidates") {
      const candidates = Array.isArray(body?.candidates)
        ? body.candidates
        : body?.candidate === undefined
          ? []
          : [body.candidate];
      if (candidates.length === 0) throw new Error("candidate or candidates required");
      const session = deps.store.addWebRtcCandidates({
        sessionId,
        token,
        peerId: body?.peerId,
        candidates,
      });
      await flushStore(deps.store);
      json(res, 200, publicWebRtcSession(session, deps.config));
      return true;
    }
    if (req.method === "GET" && action === "candidates") {
      json(res, 200, publicWebRtcSession(deps.store.getWebRtcSession({
        sessionId,
        token: header(req, "x-webrtc-session-token"),
      }), deps.config));
      return true;
    }
    if (req.method === "POST" && action === "close") {
      const session = deps.store.closeWebRtcSession({ sessionId, token });
      await flushStore(deps.store);
      json(res, 200, publicWebRtcSession(session, deps.config));
      return true;
    }
    json(res, 404, { error: "WebRTC route not found" });
  } catch (e) {
    json(res, 400, { error: message(e) });
  }
  return true;
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL, deps: RouteDeps): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/compute/admin/dashboard.html") {
    if (!deps.config.taskAdminEnabled) {
      json(res, 403, { error: "admin disabled" });
      return true;
    }
    html(res, 200, dashboardHtml());
    return true;
  }
  if (!deps.config.taskAdminEnabled || !adminAllowed(req, deps.config)) {
    json(res, 403, { error: "admin disabled" });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tiles") {
    const body = await readJson<{
      sha256?: string;
      mimeType?: "image/rgba";
      widthPx?: number;
      heightPx?: number;
      byteLength?: number;
      bytesBase64?: string;
      provenance?: { label?: string; sourceUrl?: string; license?: string; attribution?: string };
    }>(req);
    try {
      const tile = deps.store.upsertPublicTile({
        sha256: String(body?.sha256 ?? "").toLowerCase(),
        mimeType: "image/rgba",
        widthPx: Number(body?.widthPx ?? 0),
        heightPx: Number(body?.heightPx ?? 0),
        byteLength: Number(body?.byteLength ?? 0),
        bytesBase64: String(body?.bytesBase64 ?? ""),
        provenance: {
          label: String(body?.provenance?.label ?? ""),
          sourceUrl: body?.provenance?.sourceUrl ? String(body.provenance.sourceUrl) : undefined,
          license: body?.provenance?.license ? String(body.provenance.license) : undefined,
          attribution: body?.provenance?.attribution ? String(body.provenance.attribution) : undefined,
        },
      });
      await flushStore(deps.store);
      json(res, 200, {
        sha256: tile.sha256,
        widthPx: tile.widthPx,
        heightPx: tile.heightPx,
        byteLength: tile.byteLength,
        httpPath: `/compute/public/tiles/${encodeURIComponent(tile.sha256)}`,
        cacheKey: `public-tile:${tile.sha256}`,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/compute/admin/tiles") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const tiles = deps.store.listPublicTiles({ limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined });
    json(res, 200, { tiles });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/admin/bundles") {
    const body = await readJson<{
      bundleId?: string;
      kind?: "science" | "proof";
      kernelId?: string;
      matchId?: string | null;
      sponsors?: string[];
      chunkIds?: string[];
      quorum?: { minExecutions?: number; minAgreeing?: number };
      deadlineAt?: number | null;
      notes?: string;
    }>(req);
    try {
      const bundle = deps.store.createBundle({
        bundleId: body?.bundleId,
        kind: body?.kind ?? "science",
        kernelId: String(body?.kernelId ?? ""),
        matchId: body?.matchId ?? null,
        sponsors: body?.sponsors ?? [],
        chunkIds: Array.isArray(body?.chunkIds) ? body!.chunkIds : [],
        quorum: body?.quorum
          ? { minExecutions: Math.max(1, Number(body.quorum.minExecutions ?? 2)), minAgreeing: Math.max(1, Number(body.quorum.minAgreeing ?? 2)) }
          : undefined,
        deadlineAt: body?.deadlineAt ?? null,
        notes: body?.notes,
      });
      await flushStore(deps.store);
      json(res, 200, { bundle });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  // Convenience: materialize a science bundle for contact-map-tile over one
  // preset. Seeds tasks AND records the bundle in a single admin call.
  if (req.method === "POST" && url.pathname === "/compute/admin/bundles/materialize-contact-map") {
    if (!guardSeed(res, "science.contact_map_tile.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      presetId?: string;
      matchId?: string | null;
      sponsors?: string[];
      tileRows?: number;
      tileCols?: number;
      expectedMatchSec?: number;
      quorum?: { minExecutions?: number; minAgreeing?: number };
      deadlineAt?: number | null;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = resolveContactMapPreset(body?.presetId ?? CONTACT_MAP_PRESETS[0]?.id ?? "");
      // Adaptive sizing when tileRows/tileCols aren't pinned by the caller:
      //   targetChunks = activeWorkers × expectedMatchSec × utilization / avgChunkSec
      // clamped to a sane square. Falls back to a 4x4 grid if the network
      // signal is too weak to estimate (first few matches after deploy).
      const summary = deps.store.summary();
      const adaptive = computeAdaptiveTileGrid({
        activeWorkers: Math.max(1, summary.activeSessions || summary.workers),
        expectedMatchSec: Math.max(30, Number(body?.expectedMatchSec ?? 180)),
        avgChunkSec: 1.5,
        utilization: 0.5,
        minRows: 2, maxRows: 10,
        minCols: 2, maxCols: 10,
      });
      const tileRows = Math.max(1, Math.min(10, body?.tileRows ?? adaptive.rows));
      const tileCols = Math.max(1, Math.min(10, body?.tileCols ?? adaptive.cols));
      const rowLen = preset.rowResidues.length;
      const colLen = preset.colResidues.length;
      const rowsPerTile = Math.max(1, Math.floor(rowLen / tileRows));
      const colsPerTile = Math.max(1, Math.floor(colLen / tileCols));
      const minExecutions = Math.max(1, Number(body?.quorum?.minExecutions ?? 3));
      const minAgreeing = Math.max(1, Math.min(minExecutions, Number(body?.quorum?.minAgreeing ?? 2)));
      const chunkIds: string[] = [];
      for (let r = 0; r < tileRows; r++) {
        for (let c = 0; c < tileCols; c++) {
          const rowStart = preset.rowStart + r * rowsPerTile;
          const colStart = preset.colStart + c * colsPerTile;
          const rowResidues = preset.rowResidues.slice(r * rowsPerTile, (r + 1) * rowsPerTile);
          const colResidues = preset.colResidues.slice(c * colsPerTile, (c + 1) * colsPerTile);
          if (rowResidues.length === 0 || colResidues.length === 0) continue;
          const task = deps.store.seedContactMapTileTask({
            rowResidues,
            colResidues,
            rowStart,
            colStart,
            minSeparation: preset.minSeparation,
            minExecutions,
            minAgreeing,
            requiredTransport: transportPolicy(body?.requiredTransport),
            requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
          });
          chunkIds.push(task.chunks[0].chunkId);
        }
      }
      if (chunkIds.length === 0) {
        json(res, 400, { error: "no chunks materialized (check preset window size)" });
        return true;
      }
      const bundle = deps.store.createBundle({
        kind: "science",
        kernelId: "science.contact_map_tile.v0",
        matchId: body?.matchId ?? null,
        sponsors: body?.sponsors ?? [],
        chunkIds,
        quorum: { minExecutions, minAgreeing },
        deadlineAt: body?.deadlineAt ?? null,
        notes: `contact-map preset ${preset.id} tiled ${tileRows}x${tileCols}`,
      });
      deps.store.markBundleRunning(bundle.bundleId);
      await flushStore(deps.store);
      json(res, 200, {
        bundle,
        preset: preset.id,
        tileRows,
        tileCols,
        chunkCount: chunkIds.length,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  // Convenience: materialize a proof bundle for a completed match. Takes the
  // canonical public-replay-artifact JSON, seeds N replay_verify tasks
  // (each one re-executes the full match; N == minExecutions on the first
  // task so quorum is genuinely independent), records the bundle.
  if (req.method === "POST" && url.pathname === "/compute/admin/bundles/materialize-replay-verify") {
    if (!guardSeed(res, "m3t4.replay_verify.v1")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      matchId?: string;
      replayArtifactJson?: string;
      artifactSha256?: string;
      sponsors?: string[];
      minExecutions?: number;
      minAgreeing?: number;
      deadlineAt?: number | null;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      if (!body?.replayArtifactJson) throw new Error("replayArtifactJson required");
      const minExecutions = Math.max(1, Number(body?.minExecutions ?? 5));
      const minAgreeing = Math.max(1, Math.min(minExecutions, Number(body?.minAgreeing ?? 3)));
      const task = deps.store.seedReplayVerifyTask({
        replayArtifactJson: body.replayArtifactJson,
        artifactSha256: body.artifactSha256,
        minExecutions,
        minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      const bundle = deps.store.createBundle({
        kind: "proof",
        kernelId: "m3t4.replay_verify.v1",
        matchId: body?.matchId ?? null,
        sponsors: body?.sponsors ?? [],
        chunkIds: [task.chunks[0].chunkId],
        quorum: { minExecutions, minAgreeing },
        deadlineAt: body?.deadlineAt ?? null,
        notes: `proof bundle: replay_verify quorum ${minAgreeing}-of-${minExecutions}`,
      });
      deps.store.markBundleRunning(bundle.bundleId);
      await flushStore(deps.store);
      json(res, 200, { bundle, taskId: task.taskId, quorum: { minExecutions, minAgreeing } });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/compute/admin/bundles/") && url.pathname.endsWith("/seal")) {
    const bundleId = url.pathname.slice("/compute/admin/bundles/".length, -"/seal".length);
    const body = await readJson<{
      matchReceiptHash?: ContentHash;
      matchId?: string;
    }>(req);
    try {
      if (!body?.matchReceiptHash?.algorithm || !body?.matchReceiptHash?.value) {
        throw new Error("matchReceiptHash { algorithm, value } required");
      }
      const bundle = deps.store.sealBundle({
        bundleId,
        matchReceiptHash: body.matchReceiptHash,
        matchId: body.matchId,
      });
      await flushStore(deps.store);
      json(res, 200, { bundle });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/admin/bundles") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const statusRaw = url.searchParams.get("status");
    const status = statusRaw === "pending" || statusRaw === "running" || statusRaw === "sealed" || statusRaw === "abandoned"
      ? statusRaw : undefined;
    json(res, 200, {
      bundles: deps.store.listBundles({
        limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
        status,
      }),
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/assignments") {
    const body = await readJson<{ acceptAssignments?: boolean; durationMs?: number }>(req);
    if (typeof body?.acceptAssignments !== "boolean") {
      json(res, 400, { error: "acceptAssignments boolean required" });
      return true;
    }
    let durationMs: number | undefined;
    if (body.durationMs !== undefined) {
      if (!Number.isInteger(body.durationMs)) {
        json(res, 400, { error: "durationMs integer required" });
        return true;
      }
      if (body.durationMs < MIN_ASSIGNMENT_WINDOW_MS || body.durationMs > MAX_ASSIGNMENT_WINDOW_MS) {
        json(res, 400, { error: `durationMs must be ${MIN_ASSIGNMENT_WINDOW_MS}..${MAX_ASSIGNMENT_WINDOW_MS}` });
        return true;
      }
      durationMs = body.durationMs;
    }
    deps.store.setAcceptAssignments(body.acceptAssignments, durationMs);
    await flushStore(deps.store);
    json(res, 200, deps.store.summary());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/seed") {
    const body = await readJson<{
      kind?: string;
      start?: number;
      endExclusive?: number;
      chunkSize?: number;
      minExecutions?: number;
      minAgreeing?: number;
    }>(req);
    if (body?.kind && body.kind !== "prime-search.v0") {
      json(res, 400, { error: "only prime-search.v0 can be seeded in this slice" });
      return true;
    }
    if (!guardSeed(res, "prime-search.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    try {
      const task = deps.store.seedPrimeTask({
        start: body?.start ?? 1_000_000,
        endExclusive: body?.endExclusive ?? 1_020_000,
        chunkSize: body?.chunkSize ?? 5_000,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/device-witness-webgpu") {
    if (!guardSeed(res, "device_witness.webgpu.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      seed?: number;
      count?: number;
      minExecutions?: number;
      minAgreeing?: number;
      targetWorkerIds?: string[];
    }>(req);
    try {
      const task = deps.store.seedDeviceWitnessWebGpuTask({
        seed: body?.seed,
        count: body?.count,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        targetWorkerIds: workerIdTargets(body?.targetWorkerIds),
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/device-witness-render") {
    if (!guardSeed(res, "device_witness.render_fixture.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      minExecutions?: number;
      minAgreeing?: number;
      targetWorkerIds?: string[];
    }>(req);
    try {
      const task = deps.store.seedDeviceWitnessRenderTask({
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        targetWorkerIds: workerIdTargets(body?.targetWorkerIds),
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/device-witness-derived-buffer") {
    if (!guardSeed(res, "device_witness.derived_buffer.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      seed?: number;
      count?: number;
      minExecutions?: number;
      minAgreeing?: number;
    }>(req);
    try {
      const task = deps.store.seedDeviceWitnessDerivedBufferTask({
        seed: body?.seed,
        count: body?.count,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/device-witness-webrtc") {
    if (!guardSeed(res, "device_witness.webrtc.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      timeoutMs?: number;
      minExecutions?: number;
      minAgreeing?: number;
    }>(req);
    try {
      const task = deps.store.seedDeviceWitnessWebRtcTask({
        timeoutMs: body?.timeoutMs,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/tensor-tile") {
    if (!guardSeed(res, "plasma.tensor_tile.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      seed?: number;
      rows?: number;
      cols?: number;
      depth?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedTensorTileTask({
        seed: body?.seed,
        rows: body?.rows,
        cols: body?.cols,
        depth: body?.depth,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: proofTransportPolicy(body?.requiredTransport, deps.config),
        requiredPeerSubreceipt: proofPeerSubreceiptPolicy(body?.requiredPeerSubreceipt, deps.config),
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/image-tile-infer") {
    if (!guardSeed(res, "ml.image_tile_infer.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      presetId?: string;
      sourceId?: string;
      width?: number;
      height?: number;
      rgbaBase64?: string;
      tileSha256?: string;
      topK?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = body?.presetId ? resolveTileSamplePreset(body.presetId, "image") : null;
      const task = deps.store.seedImageTileInferTask({
        sourceId: body?.sourceId ?? preset?.sourceId,
        width: body?.width ?? preset?.width,
        height: body?.height ?? preset?.height,
        rgbaBase64: body?.tileSha256 ? undefined : (body?.rgbaBase64 ?? preset?.rgbaBase64),
        tileSha256: body?.tileSha256,
        topK: body?.topK,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, {
        taskId: task.taskId,
        chunks: task.chunks.length,
        validationPolicy: task.validationPolicy,
        presetId: preset?.id ?? null,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/genome-kmer") {
    if (!guardSeed(res, "science.genome_kmer.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      presetId?: string;
      sequenceId?: string;
      sequence?: string;
      k?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = body?.presetId ? resolveGenomeKmerPreset(body.presetId) : null;
      const task = deps.store.seedGenomeKmerTask({
        sequenceId: body?.sequenceId ?? preset?.id,
        sequence: String(body?.sequence ?? preset?.sequence ?? ""),
        k: body?.k ?? preset?.defaultK,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, {
        taskId: task.taskId,
        chunks: task.chunks.length,
        validationPolicy: task.validationPolicy,
        presetId: preset?.id ?? null,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/microscopy-tile-score") {
    if (!guardSeed(res, "science.microscopy_tile_score.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      presetId?: string;
      sourceId?: string;
      width?: number;
      height?: number;
      rgbaBase64?: string;
      tileSha256?: string;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = body?.presetId ? resolveTileSamplePreset(body.presetId, "microscopy") : null;
      const task = deps.store.seedMicroscopyTileScoreTask({
        sourceId: body?.sourceId ?? preset?.sourceId,
        width: body?.width ?? preset?.width,
        height: body?.height ?? preset?.height,
        rgbaBase64: body?.tileSha256 ? undefined : (body?.rgbaBase64 ?? preset?.rgbaBase64),
        tileSha256: body?.tileSha256,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, {
        taskId: task.taskId,
        chunks: task.chunks.length,
        validationPolicy: task.validationPolicy,
        presetId: preset?.id ?? null,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/exploit-search") {
    if (!guardSeed(res, "m3t4.exploit_search.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      stageId?: string;
      brainA?: string;
      brainB?: string;
      seedStart?: number;
      seedEndExclusive?: number;
      maxTicks?: number;
      topFindings?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedExploitSearchTask({
        stageId: String(body?.stageId ?? ""),
        brainA: String(body?.brainA ?? ""),
        brainB: String(body?.brainB ?? ""),
        seedStart: body?.seedStart ?? 0,
        seedEndExclusive: body?.seedEndExclusive ?? 0,
        maxTicks: body?.maxTicks,
        topFindings: body?.topFindings,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/asset-tile-audit") {
    if (!guardSeed(res, "asset.tile_audit.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      presetId?: string;
      sourceId?: string;
      width?: number;
      height?: number;
      rgbaBase64?: string;
      tileSha256?: string;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = body?.presetId ? resolveTileSamplePreset(body.presetId, "image") : null;
      const task = deps.store.seedAssetTileAuditTask({
        sourceId: body?.sourceId ?? preset?.sourceId,
        width: body?.width ?? preset?.width,
        height: body?.height ?? preset?.height,
        rgbaBase64: body?.tileSha256 ? undefined : (body?.rgbaBase64 ?? preset?.rgbaBase64),
        tileSha256: body?.tileSha256,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, {
        taskId: task.taskId,
        chunks: task.chunks.length,
        validationPolicy: task.validationPolicy,
        presetId: preset?.id ?? null,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/heat-diffusion-tile") {
    if (!guardSeed(res, "science.heat_diffusion_tile.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      widthPx?: number;
      heightPx?: number;
      iterations?: number;
      shift?: number;
      hotspots?: Array<{ xPx: number; yPx: number; valueQ88: number }>;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedHeatDiffusionTileTask({
        widthPx: body?.widthPx,
        heightPx: body?.heightPx,
        iterations: body?.iterations,
        shift: body?.shift,
        hotspots: body?.hotspots,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/mandelbrot-tile") {
    if (!guardSeed(res, "science.mandelbrot_tile.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      widthPx?: number;
      heightPx?: number;
      minXQ88?: number;
      maxXQ88?: number;
      minYQ88?: number;
      maxYQ88?: number;
      maxIter?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedMandelbrotTileTask({
        widthPx: body?.widthPx,
        heightPx: body?.heightPx,
        minXQ88: body?.minXQ88,
        maxXQ88: body?.maxXQ88,
        minYQ88: body?.minYQ88,
        maxYQ88: body?.maxYQ88,
        maxIter: body?.maxIter,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/contact-map-tile") {
    if (!guardSeed(res, "science.contact_map_tile.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      presetId?: string;
      rowResidues?: string;
      colResidues?: string;
      rowStart?: number;
      colStart?: number;
      minSeparation?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = body?.presetId ? resolveContactMapPreset(body.presetId) : null;
      const task = deps.store.seedContactMapTileTask({
        rowResidues: String(body?.rowResidues ?? preset?.rowResidues ?? ""),
        colResidues: String(body?.colResidues ?? preset?.colResidues ?? ""),
        rowStart: body?.rowStart ?? preset?.rowStart,
        colStart: body?.colStart ?? preset?.colStart,
        minSeparation: body?.minSeparation ?? preset?.minSeparation,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: transportPolicy(body?.requiredTransport),
        requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
      });
      await flushStore(deps.store);
      json(res, 200, {
        taskId: task.taskId,
        chunks: task.chunks.length,
        validationPolicy: task.validationPolicy,
        presetId: preset?.id ?? null,
      });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/science-cycle") {
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      genomePresetIds?: string[];
      contactPresetIds?: string[];
      genomeK?: number;
      contactMinSeparation?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      // science-cycle seeds per-workload tasks; skip those whose policy
      // blocks seeding, instead of failing the whole cycle.
      const genomePresetIds = canSeed("science.genome_kmer.v0").ok
        ? sciencePresetIds(body?.genomePresetIds, GENOME_KMER_PRESETS.map((preset) => preset.id).slice(0, 1))
        : [];
      const contactPresetIds = canSeed("science.contact_map_tile.v0").ok
        ? sciencePresetIds(body?.contactPresetIds, CONTACT_MAP_PRESETS.map((preset) => preset.id).slice(0, 1))
        : [];
      const seeded: Array<{ workload: string; presetId: string; taskId: string; chunks: number }> = [];
      for (const presetId of genomePresetIds) {
        const preset = resolveGenomeKmerPreset(presetId);
        const task = deps.store.seedGenomeKmerTask({
          sequenceId: preset.id,
          sequence: preset.sequence,
          k: body?.genomeK ?? preset.defaultK,
          minExecutions: body?.minExecutions,
          minAgreeing: body?.minAgreeing,
          requiredTransport: transportPolicy(body?.requiredTransport),
          requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
        });
        seeded.push({ workload: "science.genome_kmer.v0", presetId, taskId: task.taskId, chunks: task.chunks.length });
      }
      for (const presetId of contactPresetIds) {
        const preset = resolveContactMapPreset(presetId);
        const task = deps.store.seedContactMapTileTask({
          rowResidues: preset.rowResidues,
          colResidues: preset.colResidues,
          rowStart: preset.rowStart,
          colStart: preset.colStart,
          minSeparation: body?.contactMinSeparation ?? preset.minSeparation,
          minExecutions: body?.minExecutions,
          minAgreeing: body?.minAgreeing,
          requiredTransport: transportPolicy(body?.requiredTransport),
          requiredPeerSubreceipt: body?.requiredPeerSubreceipt,
        });
        seeded.push({ workload: "science.contact_map_tile.v0", presetId, taskId: task.taskId, chunks: task.chunks.length });
      }
      await flushStore(deps.store);
      json(res, 200, { seeded });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/public-artifact") {
    if (!guardSeed(res, "m3t4.public_artifact_verify.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      artifact?: {
        matchId?: string;
        artifactHash?: string;
        artifactSha256?: string;
        payload?: unknown;
      };
      matchId?: string;
      artifactHash?: string;
      artifactSha256?: string;
      artifactJson?: string;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    const artifact = body?.artifact;
    const matchId = body?.matchId ?? artifact?.matchId ?? "";
    const artifactHash = body?.artifactHash ?? artifact?.artifactHash ?? "";
    const artifactSha256 = body?.artifactSha256 ?? artifact?.artifactSha256 ?? "";
    const artifactJson = body?.artifactJson ?? (artifact?.payload ? canonicalJson(artifact.payload) : "");
    try {
      const task = deps.store.seedPublicArtifactVerifyTask({
        matchId,
        artifactHash,
        artifactSha256,
        artifactJson,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: proofTransportPolicy(body?.requiredTransport, deps.config),
        requiredPeerSubreceipt: proofPeerSubreceiptPolicy(body?.requiredPeerSubreceipt, deps.config),
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/replay-verify") {
    if (!guardSeed(res, "m3t4.replay_verify.v1")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      replayArtifact?: unknown;
      replayArtifactJson?: string;
      artifactSha256?: string;
      allowConstantsMismatch?: boolean;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    const replayArtifactJson = body?.replayArtifactJson
      ?? (body?.replayArtifact ? canonicalJson(body.replayArtifact) : "");
    try {
      const task = deps.store.seedReplayVerifyTask({
        replayArtifactJson,
        artifactSha256: body?.artifactSha256,
        allowConstantsMismatch: body?.allowConstantsMismatch,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: proofTransportPolicy(body?.requiredTransport, deps.config),
        requiredPeerSubreceipt: proofPeerSubreceiptPolicy(body?.requiredPeerSubreceipt, deps.config),
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/seed-sweep") {
    if (!guardSeed(res, "m3t4.seed_sweep.v0")) return true;
    if (!guardBacklog(res, deps)) return true;
    const body = await readJson<{
      stageId?: string;
      brainA?: string;
      brainB?: string;
      seedStart?: number;
      seedEndExclusive?: number;
      seedChunkSize?: number;
      maxTicks?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedSeedSweepTask({
        stageId: body?.stageId ?? "boardroom",
        brainA: body?.brainA ?? "unicorn",
        brainB: body?.brainB ?? "disruptor",
        seedStart: body?.seedStart ?? 1,
        seedEndExclusive: body?.seedEndExclusive ?? 17,
        seedChunkSize: body?.seedChunkSize ?? 8,
        maxTicks: body?.maxTicks,
        minExecutions: body?.minExecutions,
        minAgreeing: body?.minAgreeing,
        requiredTransport: proofTransportPolicy(body?.requiredTransport, deps.config),
        requiredPeerSubreceipt: proofPeerSubreceiptPolicy(body?.requiredPeerSubreceipt, deps.config),
      });
      await flushStore(deps.store);
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }
  const cancelPrefix = "/compute/admin/tasks/";
  if (req.method === "POST" && url.pathname.startsWith(cancelPrefix) && url.pathname.endsWith("/cancel")) {
    const taskId = url.pathname.slice(cancelPrefix.length, -"/cancel".length);
    try {
      const task = deps.store.cancelTask(taskId);
      await flushStore(deps.store);
      json(res, 200, task);
    } catch (e) {
      json(res, 404, { error: message(e) });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/compute/admin/receipts/")) {
    const receiptId = url.pathname.slice("/compute/admin/receipts/".length);
    const receipt = deps.store.getReceipt(receiptId);
    if (!receipt) json(res, 404, { error: "receipt not found" });
    else json(res, 200, receipt);
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/compute/admin/tasks/")) {
    const taskId = url.pathname.slice("/compute/admin/tasks/".length);
    const task = deps.store.getTask(taskId);
    if (!task) json(res, 404, { error: "task not found" });
    else json(res, 200, task);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/compute/admin/dashboard") {
    json(res, 200, deps.store.dashboard());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/compute/admin/receipt-log/seal") {
    const body = await readJson<{ maxEntries?: number }>(req);
    const segment = deps.store.sealReceiptLogSegment({
      maxEntries: Number.isFinite(body?.maxEntries) ? body?.maxEntries : undefined,
    });
    await flushStore(deps.store);
    json(res, 200, { segment, head: deps.store.receiptLogHead() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/compute/admin/worker-profiles") {
    json(res, 200, { generatedAt: Date.now(), profiles: deps.store.workerProfiles() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/compute/admin/public-stats") {
    json(res, 200, deps.store.publicStats({ suppressSmall: false }));
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/compute/admin/replay-badges/")) {
    const matchId = url.pathname.slice("/compute/admin/replay-badges/".length);
    const badge = deps.store.replayBadge(matchId);
    if (!badge) json(res, 404, { error: "replay badge not found" });
    else json(res, 200, badge);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/compute/admin/capability-map") {
    json(res, 200, deps.store.publicCapabilityMap());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/compute/admin/connectivity-map") {
    json(res, 200, deps.store.publicConnectivityMap());
    return true;
  }
  json(res, 404, { error: "admin route not found" });
  return true;
}

function adminAllowed(req: IncomingMessage, config: PlasmaLabConfig): boolean {
  if (!config.adminToken) return false;
  return header(req, "x-plasma-admin-token") === config.adminToken;
}

async function refreshStore(store: ComputeLabStore): Promise<void> {
  const refresh = (store as RefreshableStore).refresh;
  if (typeof refresh === "function") await refresh.call(store);
}

async function refreshStoreCached(store: ComputeLabStore, ttlMs: number): Promise<void> {
  const refresh = (store as RefreshableStore).refresh;
  if (typeof refresh !== "function") return;
  const now = Date.now();
  const cache = refreshCache.get(store) ?? { lastRefreshAt: 0 };
  if (cache.inFlight) {
    await cache.inFlight;
    return;
  }
  if (now - cache.lastRefreshAt < ttlMs) return;
  cache.inFlight = refresh.call(store)
    .then(() => {
      cache.lastRefreshAt = Date.now();
    })
    .finally(() => {
      cache.inFlight = undefined;
    });
  refreshCache.set(store, cache);
  await cache.inFlight;
}

async function flushStore(store: ComputeLabStore): Promise<void> {
  const flush = (store as RefreshableStore).flush;
  if (typeof flush === "function") await flush.call(store);
}

type RefreshMode = "fresh" | "cached" | "none";

function refreshModeForRequest(req: IncomingMessage, url: URL): RefreshMode {
  if (req.method === "GET" && url.pathname === "/compute/use-cases") return "none";
  if (req.method === "GET" && url.pathname === "/compute/tasks/next") return "cached";
  if (req.method === "GET" && isCachedPublicRead(url.pathname)) return "cached";
  return "fresh";
}

function isCachedPublicRead(pathname: string): boolean {
  return (
    pathname === "/compute/status" ||
    pathname === "/compute/public/stats" ||
    pathname === "/compute/public/summary" ||
    pathname === "/compute/public/contact-map/aggregate" ||
    pathname === "/compute/public/receipt-log/manifest" ||
    pathname === "/compute/public/receipt-log/head" ||
    pathname === "/compute/public/receipt-log/projection" ||
    pathname === "/compute/public/receipt-log/verify" ||
    pathname === "/compute/public/receipt-log/segments" ||
    pathname.startsWith("/compute/public/receipt-log/segments/") ||
    pathname.startsWith("/compute/public/replay-badges/") ||
    pathname === "/compute/public/tiles/manifest" ||
    pathname.startsWith("/compute/public/tiles/") ||
    pathname === "/compute/public/bundles" ||
    pathname.startsWith("/compute/public/bundles/") ||
    (pathname.startsWith("/compute/public/matches/") && pathname.endsWith("/witness-quorum"))
  );
}

function publicWebRtcSession(session: WebRtcSessionRecord, config: PlasmaLabConfig) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    offer: session.offer,
    answer: session.answer,
    candidates: session.candidates,
    channels: config.webrtcDataEnabled
      ? ["plasma-control", "plasma-data", "plasma-receipts"]
      : ["plasma-control", "plasma-receipts"],
    dataEnabled: config.webrtcDataEnabled,
    iceServers: publicIceServers(config),
  };
}

function publicComputeChunk(chunk: ComputeChunk): Omit<ComputeChunk, "expectedOutputHash"> {
  const { expectedOutputHash: _expectedOutputHash, ...publicChunk } = chunk;
  if (chunk.kind === "m3t4.public_artifact_verify.v0") {
    const { artifactHash: _artifactHash, params, ...withoutArtifactHash } = publicChunk;
    const { artifactHash, ...publicParams } = params;
    return {
      ...withoutArtifactHash,
      params: {
        ...publicParams,
        ...(typeof artifactHash === "string" ? { artifactId: artifactHash } : {}),
      },
    };
  }
  return publicChunk;
}

function publicValidationPolicy(policy: ValidationPolicy): Omit<ValidationPolicy, "expectedOutputHash"> {
  const { expectedOutputHash: _expectedOutputHash, ...publicPolicy } = policy;
  return publicPolicy;
}

function transportPolicy(value: unknown): TransportKind | undefined {
  if (value === undefined) return undefined;
  if (value === "http" || value === "webrtc" || value === "local") return value;
  throw new Error("requiredTransport must be http, webrtc, or local");
}

function proofTransportPolicy(value: unknown, config: PlasmaLabConfig): TransportKind | undefined {
  const explicit = transportPolicy(value);
  if (explicit !== undefined) return explicit;
  return config.strictProofTasksDefault ? "webrtc" : undefined;
}

function proofPeerSubreceiptPolicy(value: unknown, config: PlasmaLabConfig): boolean | undefined {
  if (typeof value === "boolean") return value;
  return config.strictProofTasksDefault ? true : undefined;
}

function workerRegistrationAdmission(
  req: IncomingMessage,
  body: { inviteToken?: string } | null,
  deps: RouteDeps,
): { ok: true; clientIpHash: ContentHash; inviteId?: string } | { ok: false; error: string } {
  const ip = clientIp(req);
  const clientIpHash = hashCanonical({ kind: "compute-client-ip", ip });
  if (adminAllowed(req, deps.config)) return { ok: true, clientIpHash };
  const inviteToken = String(body?.inviteToken ?? header(req, "x-compute-invite-token") ?? "").trim();
  const inviteId = validInviteId(inviteToken, deps.config.workerInviteTokens);
  if (inviteId) return { ok: true, clientIpHash, inviteId };
  if (deps.config.publicRegistrationEnabled) return { ok: true, clientIpHash };
  return { ok: false, error: "public worker registration disabled" };
}

function validInviteId(token: string, allowedTokens: string[]): string | undefined {
  if (!token || allowedTokens.length === 0) return undefined;
  return allowedTokens.includes(token)
    ? `invite-${hashCanonical({ kind: "compute-worker-invite", token }).value.slice(0, 16)}`
    : undefined;
}

function workerIdTargets(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = Array.from(new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))).sort();
  return normalized.length ? normalized : undefined;
}

function sciencePresetIds(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = Array.from(new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean)));
  return normalized.length ? normalized.slice(0, 12) : fallback;
}

function sanitizePublicWorkerCapability(capability: WorkerCapability, trustedReference: boolean): WorkerCapability {
  const runtimeSurfaces = capability.runtimeSurfaces.filter((surface) =>
    trustedReference || surface !== "cpu-reference"
  );
  return {
    ...capability,
    runtimeSurfaces: Array.from(new Set(runtimeSurfaces)),
  };
}

function maybeSeedWebGpuBootstrapWitness(store: ComputeLabStore, worker: WorkerRecord): string | null {
  if (!worker.capability.kernels.includes(DEVICE_WITNESS_WEBGPU_KERNEL_ID)) return null;
  if (!worker.capability.runtimeSurfaces.includes("browser-webgpu")) return null;
  const profile = store.workerProfiles().find((candidate) => candidate.workerId === worker.workerId);
  if (profile?.allowedWorkloadTier === "webgpu-light") return null;
  const snapshot = store.exportSnapshot();
  const alreadyPending = snapshot.tasks.some((task) =>
    task.kind === DEVICE_WITNESS_WEBGPU_KERNEL_ID &&
    task.status === "running" &&
    task.targetWorkerIds?.includes(worker.workerId) &&
    task.chunks.some((chunk) => chunk.status === "pending")
  );
  if (alreadyPending) return null;
  const task = store.seedDeviceWitnessWebGpuTask({
    minExecutions: 1,
    minAgreeing: 1,
    targetWorkerIds: [worker.workerId],
  });
  return task.taskId;
}

function publicPeerSubassignment(subassignment: PeerSubassignment, includeToken = false) {
  const { peerAssignmentToken, ...publicSubassignment } = subassignment;
  return {
    ...publicSubassignment,
    peerAssignmentToken: includeToken ? peerAssignmentToken : undefined,
  };
}

function publicWebRtcPair(pair: WebRtcPairRecord, config: PlasmaLabConfig) {
  return {
    pairId: pair.pairId,
    status: pair.status,
    createdAt: pair.createdAt,
    expiresAt: pair.expiresAt,
    offererWorkerId: pair.offererWorkerId,
    answererWorkerId: pair.answererWorkerId,
    offer: pair.offer,
    answer: pair.answer,
    candidates: pair.candidates,
    channels: config.webrtcDataEnabled
      ? ["plasma-control", "plasma-data", "plasma-receipts"]
      : ["plasma-control", "plasma-receipts"],
    dataEnabled: config.webrtcDataEnabled,
    iceServers: publicIceServers(config),
  };
}

function publicIceServers(config: PlasmaLabConfig): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const stun = config.stunUrls.filter((url) => /^stuns?:/i.test(url)).slice(0, 4);
  if (stun.length) out.push({ urls: stun });
  const turn = config.webrtcTurnEnabled
    ? config.turnUrls.filter((url) => /^turns?:/i.test(url)).slice(0, 4)
    : [];
  if (turn.length && config.turnUsername && config.turnCredential) {
    out.push({
      urls: turn,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }
  return out;
}

function authFrom<T extends Record<string, unknown>>(
  body: WorkerAuthBody | null,
  req: IncomingMessage,
  rest: T,
): {
  workerId: string;
  workerSessionId: string;
  workerSessionToken: string;
} & T {
  return {
    workerId: body?.workerId ?? "",
    workerSessionId: body?.workerSessionId ?? "",
    workerSessionToken: body?.workerSessionToken ?? header(req, "x-worker-session-token"),
    ...rest,
  };
}

function logDerivedReceiptOutcome(
  deps: RouteDeps,
  result: { receipt: ExecutionReceipt; validation?: ValidationRecord },
): void {
  const { receipt } = result;
  if (!receipt.derived && receipt.kernelId !== "device_witness.derived_buffer.v0") return;
  const chunk = deps.store.getTask(receipt.taskId)?.chunks.find((candidate) => candidate.chunkId === receipt.chunkId);
  const sourceId = paramString(chunk?.params.sourceId);
  const regionId = paramString(chunk?.params.regionId);
  const outputId = paramString(chunk?.params.outputId);
  const event = {
    event: "plasma-lab.derived-receipt",
    accepted: receipt.decision === "accepted",
    decision: receipt.decision,
    reason: receipt.reason,
    validationStatus: result.validation?.status,
    taskId: receipt.taskId,
    chunkId: receipt.chunkId,
    receiptId: receipt.receiptId,
    workerId: receipt.workerId,
    derivedFields: {
      sourceFrameHash: mappedHashStatus(receipt.derived?.sourceHashes, sourceId, hashFromParam(chunk?.params.sourceHash)),
      bufferRegionHash: mappedHashStatus(receipt.derived?.bufferRegionHashes, regionId, hashFromParam(chunk?.params.regionHash)),
      producerKernelHash: mappedHashStatus(
        receipt.derived?.producerKernelHashes,
        outputId,
        hashFromParam(chunk?.params.producerKernelHash),
      ),
      outputHash: mappedHashStatus(receipt.derived?.outputHashes, outputId, receipt.outputHash),
      derivedOutputHash: singleHashStatus(receipt.derived?.derivedOutputHash, receipt.outputHash),
    },
  };
  if (deps.eventLog) deps.eventLog(event);
  else console.log(JSON.stringify(event));
}

function mappedHashStatus(
  values: Record<string, ContentHash> | undefined,
  key: string | undefined,
  expected: ContentHash | undefined,
): "missing" | "present" | "matches" | "mismatch" {
  const value = key ? values?.[key] : undefined;
  if (!value) return "missing";
  if (!expected) return "present";
  return routeHashesEqual(value, expected) ? "matches" : "mismatch";
}

function singleHashStatus(
  value: ContentHash | undefined,
  expected: ContentHash | undefined,
): "missing" | "present" | "matches" | "mismatch" {
  if (!value) return "missing";
  if (!expected) return "present";
  return routeHashesEqual(value, expected) ? "matches" : "mismatch";
}

function hashFromParam(value: unknown): ContentHash | undefined {
  return typeof value === "string" && value ? { algorithm: "sha256", value } : undefined;
}

function paramString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function routeHashesEqual(a: ContentHash, b: ContentHash): boolean {
  return a.algorithm === b.algorithm && a.value.toLowerCase() === b.value.toLowerCase();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Public-facing use-cases, filtered by the workload policy. Each entry gets
// its policy annotations appended so the UI can group by release state and
// show required tier / schedule mode without hard-coding per-workload rules.
function publicUseCases(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const useCase of COMPUTE_USE_CASES) {
    const workload = useCase.workload;
    if (!workload) {
      // Non-workload entries (device-witness meta, infra) — still public by default.
      out.push({ ...useCase, policy: null });
      continue;
    }
    const policy = getWorkloadPolicy(workload);
    if (!policy) continue;
    if (!policy.publicVisible) continue;
    out.push({
      ...useCase,
      policy: {
        release: policy.release,
        scheduleMode: policy.scheduleMode,
        requiredTier: policy.requiredTier,
      },
    });
  }
  return out;
}

// Adaptive bundle sizing. Target chunk count scales with the network's
// current capacity; falls back to a safe square grid when signals are weak.
//   targetChunks ≈ activeWorkers × expectedMatchSec × utilization / avgChunkSec
// Result is decomposed into the closest square-ish tile grid (rows × cols)
// that fits the supplied bounds.
export function computeAdaptiveTileGrid(input: {
  activeWorkers: number;
  expectedMatchSec: number;
  avgChunkSec: number;
  utilization: number;
  minRows: number; maxRows: number;
  minCols: number; maxCols: number;
}): { rows: number; cols: number; targetChunks: number } {
  const target = Math.max(1, Math.round(
    (input.activeWorkers * input.expectedMatchSec * input.utilization) / Math.max(0.1, input.avgChunkSec),
  ));
  const maxTotal = input.maxRows * input.maxCols;
  const minTotal = input.minRows * input.minCols;
  const clamped = Math.max(minTotal, Math.min(maxTotal, target));
  const side = Math.max(1, Math.round(Math.sqrt(clamped)));
  const rows = Math.max(input.minRows, Math.min(input.maxRows, side));
  const cols = Math.max(input.minCols, Math.min(input.maxCols, Math.ceil(clamped / rows)));
  return { rows, cols, targetChunks: rows * cols };
}

// Admin seed-endpoint guard. Callers pass the target workload id; this returns
// a 403 and a reason when the workload is not currently seedable.
function guardSeed(
  res: ServerResponse,
  workload: string,
): boolean {
  const verdict = canSeed(workload);
  if (verdict.ok) return true;
  json(res, 403, { error: `seed rejected: ${verdict.reason}` });
  return false;
}

// Backpressure: refuse to seed new tasks when the queue is already saturated.
// Counts in-flight (not yet complete) tasks and rejects above
// `config.maxPendingTasks` (env COMPUTE_MAX_PENDING_TASKS, default 500). Lets
// workers drain the existing queue before more arrives instead of letting
// auto-seed pile up tens of thousands of tasks.
function guardBacklog(res: ServerResponse, deps: RouteDeps): boolean {
  const limit = deps.config.maxPendingTasks;
  if (!Number.isFinite(limit) || limit <= 0) return true;
  let pending = 0;
  for (const task of deps.store.exportSnapshot().tasks ?? []) {
    if (task.status === "running") pending++;
    if (pending >= limit) {
      res.setHeader("retry-after", "60");
      json(res, 503, {
        error: "queue saturated",
        pendingTasks: pending,
        limit,
        hint: "Lab is throttling new task seeding while workers drain the existing queue. Retry after some receipts complete.",
      });
      return false;
    }
  }
  return true;
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>plasma-lab dashboard</title>
<style>
body{margin:0;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#07080d;color:#f5f7ff}
main{max-width:1180px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 16px}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
input,textarea,button,select{font:inherit;background:#111827;color:#f5f7ff;border:1px solid #374151;border-radius:6px;padding:8px}
textarea{min-height:92px;resize:vertical;width:100%;box-sizing:border-box}
button{cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:16px}
.ops{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;margin-bottom:16px}
.card{border:1px solid #252b3a;border-radius:8px;padding:12px;background:#0d111b}
.n{font-size:24px;font-weight:700}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.row>*{flex:1 1 90px}
.muted{color:#9ca3af}
pre{white-space:pre-wrap;background:#0d111b;border:1px solid #252b3a;border-radius:8px;padding:12px;overflow:auto;max-height:48vh}
table{width:100%;border-collapse:collapse;margin:12px 0;background:#0d111b}
td,th{border-bottom:1px solid #252b3a;padding:7px;text-align:left;vertical-align:top}
.err{color:#fb7185}
.ok{color:#86efac}
</style>
</head>
<body>
<main>
<h1>plasma-lab dashboard</h1>
<div class="bar">
  <input id="token" type="password" placeholder="admin token">
  <button id="refresh">refresh</button>
  <span id="status"></span>
</div>
<div id="summary" class="grid"></div>
<h2>ops</h2>
<div class="ops">
  <div class="card">
    <div>assignment intake</div>
    <div class="muted">admin-only runtime switch</div>
    <div class="row">
      <button id="enableAssignments">enable</button>
      <button id="disableAssignments">disable</button>
    </div>
    <div class="row">
      <input id="assignmentWindowSeconds" value="30" aria-label="assignment window seconds">
      <button id="enableAssignmentsTimed">enable timed</button>
    </div>
  </div>
  <div class="card">
    <div>device witness receipts</div>
    <div class="muted">assignment-bound WebGPU/render/WebRTC probes</div>
    <div class="row">
      <input id="witnessSeed" value="1" aria-label="webgpu seed">
      <input id="witnessCount" value="256" aria-label="webgpu count">
    </div>
    <div class="row">
      <button id="seedWitnessWebgpu">seed WebGPU</button>
      <button id="seedWitnessRender">seed render</button>
      <button id="seedWitnessWebrtc">seed WebRTC</button>
      <button id="seedWitnessDerived">seed derived buffer</button>
    </div>
  </div>
  <div class="card">
    <div>tensor tile</div>
    <div class="muted">WebGPU u32 matmul fixture; requires webgpu-light workers</div>
    <div class="row">
      <input id="tensorSeed" value="1" aria-label="tensor seed">
      <input id="tensorRows" value="16" aria-label="tensor rows">
      <input id="tensorCols" value="16" aria-label="tensor cols">
      <input id="tensorDepth" value="32" aria-label="tensor depth">
    </div>
    <div class="row"><button id="seedTensorTile">seed tensor tile</button></div>
  </div>
  <div class="card">
    <div>image tile infer</div>
    <div class="muted">Low-bandwidth fixed tile classifier over bounded public RGBA tiles</div>
    <select id="imageTilePreset" aria-label="image tile preset">
      ${IMAGE_TILE_SAMPLE_PRESETS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")}
    </select>
    <div class="row">
      <input id="imageTileSourceId" value="${IMAGE_TILE_SAMPLE_PRESETS[0]?.sourceId ?? "image-tile"}" aria-label="image tile source id">
      <input id="imageTileTopK" value="3" aria-label="image tile top k">
    </div>
    <div class="row"><button id="seedImageTileInfer">seed image tile infer</button></div>
  </div>
  <div class="card">
    <div>microscopy tile score</div>
    <div class="muted">Deterministic microscopy scorecard for focus, stain balance, cellularity, and artifact risk</div>
    <select id="microscopyPreset" aria-label="microscopy tile preset">
      ${MICROSCOPY_TILE_SAMPLE_PRESETS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")}
    </select>
    <div class="row">
      <input id="microscopySourceId" value="${MICROSCOPY_TILE_SAMPLE_PRESETS[0]?.sourceId ?? "microscopy-tile"}" aria-label="microscopy source id">
    </div>
    <div class="row"><button id="seedMicroscopyTileScore">seed microscopy score</button></div>
  </div>
  <div class="card">
    <div>contact map tile</div>
    <div class="muted">Low-bandwidth heuristic protein contact-score tile; public residue windows only, no model download</div>
    <select id="contactPreset" aria-label="contact map preset">
      ${CONTACT_MAP_PRESETS.map((preset) => `<option value="${preset.id}">${preset.label} · ${preset.accession}</option>`).join("")}
    </select>
    <textarea id="contactRows" placeholder="row residue window">${CONTACT_MAP_PRESETS[0]?.rowResidues ?? ""}</textarea>
    <textarea id="contactCols" placeholder="column residue window">${CONTACT_MAP_PRESETS[0]?.colResidues ?? ""}</textarea>
    <div class="row">
      <input id="contactRowStart" value="${String(CONTACT_MAP_PRESETS[0]?.rowStart ?? 0)}" aria-label="contact row start">
      <input id="contactColStart" value="${String(CONTACT_MAP_PRESETS[0]?.colStart ?? 0)}" aria-label="contact col start">
      <input id="contactMinSeparation" value="${String(CONTACT_MAP_PRESETS[0]?.minSeparation ?? 8)}" aria-label="contact min separation">
    </div>
    <div id="contactPresetMeta" class="muted">${CONTACT_MAP_PRESETS[0]?.proteinName ?? ""} · ${CONTACT_MAP_PRESETS[0]?.organism ?? ""} · ${CONTACT_MAP_PRESETS[0]?.sourceDb ?? ""}</div>
    <div class="row"><button id="seedContactMapTile">seed contact map tile</button></div>
  </div>
  <div class="card">
    <div>genome k-mer histogram</div>
    <div class="muted">Deterministic ACGT k-mer histogram over bounded public reference-genome windows; CPU kernel, exact-hash validation</div>
    <select id="genomeKmerPreset" aria-label="genome kmer preset">
      ${GENOME_KMER_PRESETS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")}
    </select>
    <textarea id="genomeKmerSequence" placeholder="ACGT sequence (max 256 bases)">${GENOME_KMER_PRESETS[0]?.sequence ?? ""}</textarea>
    <div class="row">
      <input id="genomeKmerK" value="${String(GENOME_KMER_PRESETS[0]?.defaultK ?? 3)}" aria-label="genome kmer k">
    </div>
    <div id="genomeKmerPresetMeta" class="muted">${GENOME_KMER_PRESETS[0]?.source ?? ""} · ${GENOME_KMER_PRESETS[0]?.notes ?? ""}</div>
    <div class="row"><button id="seedGenomeKmer">seed genome kmer</button></div>
  </div>
  <div class="card">
    <div>seed sweep</div>
    <div class="row">
      <input id="sweepStage" value="boardroom" aria-label="stage id">
      <input id="sweepA" value="unicorn" aria-label="preset A">
      <input id="sweepB" value="disruptor" aria-label="preset B">
    </div>
    <div class="row">
      <input id="sweepStart" value="1" aria-label="seed start">
      <input id="sweepEnd" value="17" aria-label="seed end">
      <input id="sweepChunk" value="8" aria-label="chunk size">
    </div>
    <div class="row"><button id="seedSweep">seed sweep</button></div>
  </div>
  <div class="card">
    <div>exploit search</div>
    <div class="muted">Deterministic public-preset exploit scan over bounded seed windows</div>
    <div class="row">
      <input id="exploitStage" value="boardroom" aria-label="exploit stage id">
      <input id="exploitA" value="unicorn" aria-label="exploit preset A">
      <input id="exploitB" value="disruptor" aria-label="exploit preset B">
    </div>
    <div class="row">
      <input id="exploitStart" value="1" aria-label="exploit seed start">
      <input id="exploitEnd" value="17" aria-label="exploit seed end">
      <input id="exploitMaxTicks" value="5400" aria-label="exploit max ticks">
    </div>
    <div class="row"><button id="seedExploitSearch">seed exploit search</button></div>
  </div>
  <div class="card">
    <div>asset tile audit</div>
    <div class="muted">Trim, palette, fringe-alpha, and edge-bleed audit for public asset tiles</div>
    <select id="assetTilePreset" aria-label="asset tile preset">
      ${IMAGE_TILE_SAMPLE_PRESETS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")}
    </select>
    <div class="row">
      <input id="assetTileSourceId" value="${IMAGE_TILE_SAMPLE_PRESETS[0]?.sourceId ?? "asset-tile"}" aria-label="asset tile source id">
    </div>
    <div class="row"><button id="seedAssetTileAudit">seed asset audit</button></div>
  </div>
  <div class="card">
    <div>public artifact verify</div>
    <textarea id="artifactJson" placeholder='paste PublicReplayArtifactV1 JSON'></textarea>
    <div class="row">
      <button id="seedArtifact">seed artifact verify</button>
      <button id="seedReplayVerify">seed replay verify</button>
    </div>
  </div>
  <div class="card">
    <div>prime plumbing</div>
    <div class="row">
      <input id="primeStart" value="1000000" aria-label="start">
      <input id="primeEnd" value="1020000" aria-label="end">
      <input id="primeChunk" value="5000" aria-label="chunk size">
    </div>
    <div class="row"><button id="seedPrime">seed prime</button></div>
  </div>
</div>
<h2>use cases</h2><div id="useCases"></div>
<h2>public-safe stats</h2><div id="publicStats"></div>
<h2>worker profiles</h2><div id="workerProfiles"></div>
<h2>device classes</h2><div id="deviceClasses"></div>
<h2>network classes</h2><div id="networkClasses"></div>
<h2>WebRTC pairs</h2><div id="webRtcPairs"></div>
<h2>replay badges</h2><div id="replayBadges"></div>
<h2>current capability map</h2><div id="capabilityMap"></div>
<h2>observed capability map</h2><div id="capabilityObservationMap"></div>
<h2>connectivity map</h2><div id="connectivityMap"></div>
<h2>receipt transport summary</h2><div id="receiptTransportSummary"></div>
<h2>tasks</h2><div id="tasks"></div>
<h2>recent receipts</h2><div id="receipts"></div>
<h2>raw</h2><pre id="raw"></pre>
</main>
<script>
const token = document.getElementById("token");
const statusEl = document.getElementById("status");
token.value = localStorage.getItem("plasmaAdminToken") || "";
document.getElementById("refresh").onclick = refresh;
document.getElementById("enableAssignments").onclick = () => adminPost("/compute/admin/assignments", { acceptAssignments: true });
document.getElementById("disableAssignments").onclick = () => adminPost("/compute/admin/assignments", { acceptAssignments: false });
document.getElementById("enableAssignmentsTimed").onclick = () => {
  const seconds = asNum("assignmentWindowSeconds");
  if (!Number.isFinite(seconds) || seconds <= 0) throwStatus("positive window seconds required");
  return adminPost("/compute/admin/assignments", { acceptAssignments: true, durationMs: Math.round(seconds * 1000) });
};
document.getElementById("seedPrime").onclick = () => adminPost("/compute/admin/tasks/seed", {
  start: asNum("primeStart"),
  endExclusive: asNum("primeEnd"),
  chunkSize: asNum("primeChunk"),
});
document.getElementById("seedWitnessWebgpu").onclick = () => adminPost("/compute/admin/tasks/device-witness-webgpu", {
  seed: asNum("witnessSeed"),
  count: asNum("witnessCount"),
});
document.getElementById("seedWitnessRender").onclick = () => adminPost("/compute/admin/tasks/device-witness-render", {});
document.getElementById("seedWitnessWebrtc").onclick = () => adminPost("/compute/admin/tasks/device-witness-webrtc", {});
document.getElementById("seedWitnessDerived").onclick = () => adminPost("/compute/admin/tasks/device-witness-derived-buffer", {
  seed: asNum("witnessSeed"),
  count: asNum("witnessCount"),
});
document.getElementById("seedTensorTile").onclick = () => adminPost("/compute/admin/tasks/tensor-tile", {
  seed: asNum("tensorSeed"),
  rows: asNum("tensorRows"),
  cols: asNum("tensorCols"),
  depth: asNum("tensorDepth"),
});
const imageTilePresets = ${JSON.stringify(IMAGE_TILE_SAMPLE_PRESETS)};
const microscopyTilePresets = ${JSON.stringify(MICROSCOPY_TILE_SAMPLE_PRESETS)};
function applySimplePreset(selectId, presets, sourceIdInput) {
  const select = document.getElementById(selectId);
  const target = document.getElementById(sourceIdInput);
  const preset = presets.find((entry) => entry.id === select.value) || presets[0];
  if (!preset || !target) return;
  target.value = preset.sourceId;
}
document.getElementById("seedImageTileInfer").onclick = () => adminPost("/compute/admin/tasks/image-tile-infer", {
  presetId: val("imageTilePreset"),
  sourceId: val("imageTileSourceId"),
  topK: asNum("imageTileTopK"),
});
document.getElementById("seedMicroscopyTileScore").onclick = () => adminPost("/compute/admin/tasks/microscopy-tile-score", {
  presetId: val("microscopyPreset"),
  sourceId: val("microscopySourceId"),
});
const contactMapPresets = ${JSON.stringify(CONTACT_MAP_PRESETS)};
const contactPresetSelect = document.getElementById("contactPreset");
const contactPresetMeta = document.getElementById("contactPresetMeta");
function applyContactPreset(id) {
  const preset = contactMapPresets.find((entry) => entry.id === id) || contactMapPresets[0];
  if (!preset) return;
  document.getElementById("contactRows").value = preset.rowResidues;
  document.getElementById("contactCols").value = preset.colResidues;
  document.getElementById("contactRowStart").value = String(preset.rowStart);
  document.getElementById("contactColStart").value = String(preset.colStart);
  document.getElementById("contactMinSeparation").value = String(preset.minSeparation);
  contactPresetMeta.textContent = preset.proteinName + " · " + preset.organism + " · " + preset.sourceDb;
}
contactPresetSelect.addEventListener("change", () => applyContactPreset(contactPresetSelect.value));
document.getElementById("seedContactMapTile").onclick = () => adminPost("/compute/admin/tasks/contact-map-tile", {
  presetId: contactPresetSelect.value,
  rowResidues: val("contactRows"),
  colResidues: val("contactCols"),
  rowStart: asNum("contactRowStart"),
  colStart: asNum("contactColStart"),
  minSeparation: asNum("contactMinSeparation"),
});
applyContactPreset(contactPresetSelect.value);
const genomeKmerPresets = ${JSON.stringify(GENOME_KMER_PRESETS)};
const genomeKmerPresetSelect = document.getElementById("genomeKmerPreset");
const genomeKmerPresetMeta = document.getElementById("genomeKmerPresetMeta");
function applyGenomeKmerPreset(id) {
  const preset = genomeKmerPresets.find((entry) => entry.id === id) || genomeKmerPresets[0];
  if (!preset) return;
  document.getElementById("genomeKmerSequence").value = preset.sequence;
  document.getElementById("genomeKmerK").value = String(preset.defaultK);
  genomeKmerPresetMeta.textContent = preset.source + " · " + preset.notes;
}
genomeKmerPresetSelect.addEventListener("change", () => applyGenomeKmerPreset(genomeKmerPresetSelect.value));
document.getElementById("seedGenomeKmer").onclick = () => adminPost("/compute/admin/tasks/genome-kmer", {
  presetId: genomeKmerPresetSelect.value,
  sequence: val("genomeKmerSequence"),
  k: asNum("genomeKmerK"),
});
applyGenomeKmerPreset(genomeKmerPresetSelect.value);
document.getElementById("seedSweep").onclick = () => adminPost("/compute/admin/tasks/seed-sweep", {
  stageId: val("sweepStage"),
  brainA: val("sweepA"),
  brainB: val("sweepB"),
  seedStart: asNum("sweepStart"),
  seedEndExclusive: asNum("sweepEnd"),
  seedChunkSize: asNum("sweepChunk"),
});
document.getElementById("seedExploitSearch").onclick = () => adminPost("/compute/admin/tasks/exploit-search", {
  stageId: val("exploitStage"),
  brainA: val("exploitA"),
  brainB: val("exploitB"),
  seedStart: asNum("exploitStart"),
  seedEndExclusive: asNum("exploitEnd"),
  maxTicks: asNum("exploitMaxTicks"),
});
document.getElementById("seedAssetTileAudit").onclick = () => adminPost("/compute/admin/tasks/asset-tile-audit", {
  presetId: val("assetTilePreset"),
  sourceId: val("assetTileSourceId"),
});
document.getElementById("imageTilePreset").addEventListener("change", () => applySimplePreset("imageTilePreset", imageTilePresets, "imageTileSourceId"));
document.getElementById("microscopyPreset").addEventListener("change", () => applySimplePreset("microscopyPreset", microscopyTilePresets, "microscopySourceId"));
document.getElementById("assetTilePreset").addEventListener("change", () => applySimplePreset("assetTilePreset", imageTilePresets, "assetTileSourceId"));
applySimplePreset("imageTilePreset", imageTilePresets, "imageTileSourceId");
applySimplePreset("microscopyPreset", microscopyTilePresets, "microscopySourceId");
applySimplePreset("assetTilePreset", imageTilePresets, "assetTileSourceId");
document.getElementById("seedArtifact").onclick = () => {
  const raw = val("artifactJson");
  if (!raw) throwStatus("artifact JSON required");
  const parsed = JSON.parse(raw);
  const body = parsed.artifact ? parsed : { artifact: parsed };
  return adminPost("/compute/admin/tasks/public-artifact", body);
};
document.getElementById("seedReplayVerify").onclick = () => {
  const raw = val("artifactJson");
  if (!raw) throwStatus("replay artifact JSON required");
  const parsed = JSON.parse(raw);
  return adminPost("/compute/admin/tasks/replay-verify", { replayArtifact: parsed });
};
async function refresh() {
  localStorage.setItem("plasmaAdminToken", token.value);
  statusEl.textContent = "loading";
  statusEl.className = "";
  try {
    const [dash, uses] = await Promise.all([
      adminGet("/compute/admin/dashboard"),
      fetch("/compute/use-cases").then((res) => res.json()),
    ]);
    render(dash, uses.useCases || []);
    statusEl.textContent = "ok " + new Date().toLocaleTimeString();
    statusEl.className = "ok";
  } catch (e) {
    statusEl.textContent = e.message || String(e);
    statusEl.className = "err";
  }
}
async function adminGet(path) {
  const res = await fetch(path, { headers: { "x-plasma-admin-token": token.value } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
async function adminPost(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-plasma-admin-token": token.value },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    statusEl.textContent = "ok " + path;
    statusEl.className = "ok";
    await refresh();
    return data;
  } catch (e) {
    statusEl.textContent = e.message || String(e);
    statusEl.className = "err";
  }
}
function render(data, useCases) {
  document.getElementById("summary").innerHTML = ["acceptAssignments","assignmentIntakeClosesAt","workers","activeSessions","tasks","assignments","receipts","validations","capabilityObservations","connectivityObservations","webrtcSessions","webrtcPairs","peerSubassignments"]
    .map((k) => '<div class="card"><div>'+k+'</div><div class="n">'+(data[k] ?? 0)+'</div></div>').join("");
  document.getElementById("useCases").innerHTML = table(["id","status","workload","inputBoundary","validation"], useCases);
  document.getElementById("publicStats").innerHTML = table(["generatedAt","privacy","computeScore","totalWorkers","activeWorkers","totalReceipts","acceptedReceiptPct","webgpuSupportedPct","webgpuCorrectnessPct","renderFixturePct","webrtcDirectSuccessPct","turnRequiredPct","medianKernelMs","p95KernelMs"], [data.publicStats || {}]) +
    table(["acceptedReceipts","rejectedReceipts","acceptedContactMapTileChunks","acceptedContactMapTileCells","acceptedPublicArtifactChunks","acceptedReplayVerifyChunks","acceptedSeedSweepChunks","acceptedSeedSweepSeeds","acceptedTensorTileChunks","acceptedTensorTileCells","acceptedWebGpuWitnessReceipts","acceptedWebRtcReceipts"], [data.publicStats?.scoreBreakdown || {}]);
  document.getElementById("workerProfiles").innerHTML = table(["workerId","browserFamily","deviceClass","adapterClass","webgpuAvailable","webgpuCorrectnessScore","renderFixtureScore","webrtcDirectSuccessRate","turnRequiredRate","p95KernelMs","allowedWorkloadTier","acceptedReceipts","rejectedReceipts"], data.workerProfiles || []);
  document.getElementById("deviceClasses").innerHTML = table(["classId","workers","activeWorkers","webgpuCorrectnessScore","renderFixtureScore","webrtcDirectSuccessRate","turnRequiredRate","p95KernelMs"], data.deviceClassProfiles || []);
  document.getElementById("networkClasses").innerHTML = table(["classId","workers","activeWorkers","webrtcDirectSuccessRate","turnRequiredRate","p95KernelMs"], data.networkClassProfiles || []);
  document.getElementById("webRtcPairs").innerHTML = table(["pairId","status","offererWorkerId","answererWorkerId","hasOffer","hasAnswer","candidateCount","peerCount","expiresAt"], data.webRtcPairList || []);
  document.getElementById("replayBadges").innerHTML = table(["matchId","status","agreedReceipts","requiredReceipts","rulesHash","stageHash","verifiedAt"], data.replayBadges || []);
  document.getElementById("capabilityMap").innerHTML = table(["dimension","bucket","count"], flattenMap(data.capabilityMap || {}));
  document.getElementById("capabilityObservationMap").innerHTML = table(["dimension","bucket","count"], flattenMap(data.capabilityObservationMap || {}));
  document.getElementById("connectivityMap").innerHTML = table(["dimension","bucket","count"], flattenMap(data.connectivityMap || {}));
  document.getElementById("receiptTransportSummary").innerHTML = table(["taskKind","validationMode","transport","transfer","dataChannelBucket","dataReceiptBucket","decision","count"], data.receiptTransportSummary || []);
  document.getElementById("tasks").innerHTML = table(["taskId","kind","status","chunks","accepted","rejected"], data.taskList || []);
  document.getElementById("receipts").innerHTML = table(["receivedAt","workerId","taskId","chunkId","decision","transport","validationMode","computeMs"], data.receiptList || []);
  document.getElementById("raw").textContent = JSON.stringify(data, null, 2);
}
function flattenMap(map) {
  const rows = [];
  for (const dimension of Object.keys(map).sort()) {
    for (const bucket of Object.keys(map[dimension] || {}).sort()) {
      rows.push({ dimension, bucket, count: map[dimension][bucket] });
    }
  }
  return rows;
}
function table(cols, rows) {
  return '<table><thead><tr>'+cols.map((c)=>'<th>'+esc(c)+'</th>').join("")+'</tr></thead><tbody>'
    + rows.map((r)=>'<tr>'+cols.map((c)=>'<td>'+esc(cell(c, r[c]))+'</td>').join("")+'</tr>').join("")
    + '</tbody></table>';
}
function cell(c, v) {
  if (c.endsWith("At") && typeof v === "number") return new Date(v).toLocaleTimeString();
  if (v && typeof v === "object") return JSON.stringify(v);
  return v;
}
function val(id) { return document.getElementById(id).value.trim(); }
function asNum(id) { return Number(val(id)); }
function throwStatus(message) { statusEl.textContent = message; statusEl.className = "err"; throw new Error(message); }
function esc(v) { return String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
refresh();
</script>
</body>
</html>`;
}
