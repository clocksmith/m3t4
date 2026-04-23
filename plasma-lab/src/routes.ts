import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonWebKey } from "node:crypto";
import type { PlasmaLabConfig } from "./config.js";
import { header, html, json, readJson } from "./http.js";
import { canonicalJson } from "./plasma/hash.js";
import type { ContentHash, DerivedExecutionEvidence, ExecutionMode, GovernorMode, TransportKind, ValidationPolicy, WorkerCapability, WorkerRefusalReason } from "./plasma/types.js";
import { ComputeLabStore, type ComputeChunk, type ExecutionReceipt, type PeerSubassignment, type PeerSubreceipt, type ValidationRecord, type WebRtcPairRecord, type WebRtcSessionRecord } from "./store.js";
import { COMPUTE_USE_CASES } from "./use-cases.js";
import { CONTACT_MAP_PRESETS, resolveContactMapPreset } from "./contact-map-presets.js";
import { IMAGE_TILE_SAMPLE_PRESETS, MICROSCOPY_TILE_SAMPLE_PRESETS, resolveTileSamplePreset } from "./image-tile-presets.js";
import { LOGIT_DIVERGENCE_MODEL_ID } from "./kernels/logit-divergence.js";
import { PREFILL_TOPK_PROBE_MODEL_ID } from "./kernels/prefill-topk-probe.js";

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

type RefreshableStore = ComputeLabStore & {
  refresh?: () => Promise<void>;
  flush?: () => Promise<void>;
};

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
    await refreshStore(deps.store);
  }

  if (req.method === "POST" && url.pathname === "/compute/workers/register") {
    const body = await readJson<{ label?: string; capability?: WorkerCapability; signingPublicKey?: JsonWebKey }>(req);
    if (!body?.capability || !Array.isArray(body.capability.kernels)) {
      json(res, 400, { error: "capability.kernels required" });
      return true;
    }
    if (deps.config.requireReceiptSignatures && !body.signingPublicKey) {
      json(res, 400, { error: "signingPublicKey required" });
      return true;
    }
    const { worker, session, acceptedKernels } = deps.store.registerWorker({
      label: body.label,
      capability: sanitizePublicWorkerCapability(body.capability, adminAllowed(req, deps.config)),
      signingPublicKey: body.signingPublicKey,
    });
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
    });
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
      await flushStore(deps.store);
      json(res, 200, { ok: true, acceptedKernels: worker.capability.kernels });
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

  if (req.method === "GET" && url.pathname === "/compute/tasks/next") {
    try {
      const next = deps.store.assignNext({
        workerId: url.searchParams.get("workerId") ?? "",
        workerSessionId: url.searchParams.get("workerSessionId") ?? "",
        workerSessionToken: header(req, "x-worker-session-token"),
      });
      if (!next) {
        await flushStore(deps.store);
        json(res, 200, { idle: true, reason: deps.store.summary().acceptAssignments ? "no-work" : "assignments-disabled" });
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
      iceServers: publicIceServers(deps.config),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/use-cases") {
    json(res, 200, { useCases: COMPUTE_USE_CASES });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/stats") {
    json(res, 200, deps.store.publicStats());
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/compute/public/replay-badges/")) {
    const matchId = url.pathname.slice("/compute/public/replay-badges/".length);
    const badge = deps.store.replayBadge(matchId);
    if (!badge || badge.status !== "verified") json(res, 404, { error: "verified replay badge not found" });
    else json(res, 200, badge);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/compute/public/contact-map/aggregate") {
    json(res, 200, deps.store.publicContactMapAggregate());
    return true;
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
    const body = await readJson<{
      seed?: number;
      count?: number;
      minExecutions?: number;
      minAgreeing?: number;
    }>(req);
    try {
      const task = deps.store.seedDeviceWitnessWebGpuTask({
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/device-witness-render") {
    const body = await readJson<{
      minExecutions?: number;
      minAgreeing?: number;
    }>(req);
    try {
      const task = deps.store.seedDeviceWitnessRenderTask({
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/device-witness-derived-buffer") {
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/embedding-tile") {
    const body = await readJson<{
      modelId?: string;
      queryText?: string;
      documents?: string[];
      topK?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedEmbeddingTileTask({
        modelId: body?.modelId,
        queryText: String(body?.queryText ?? ""),
        documents: Array.isArray(body?.documents) ? body.documents.map((entry) => String(entry ?? "")) : [],
        topK: body?.topK,
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/image-tile-infer") {
    const body = await readJson<{
      presetId?: string;
      sourceId?: string;
      width?: number;
      height?: number;
      rgbaBase64?: string;
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
        width: body?.width ?? preset?.width ?? 0,
        height: body?.height ?? preset?.height ?? 0,
        rgbaBase64: String(body?.rgbaBase64 ?? preset?.rgbaBase64 ?? ""),
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/prefill-topk-probe") {
    const body = await readJson<{
      modelId?: string;
      promptText?: string;
      topK?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedPrefillTopkProbeTask({
        modelId: body?.modelId,
        promptText: String(body?.promptText ?? ""),
        topK: body?.topK,
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/logit-divergence") {
    const body = await readJson<{
      modelId?: string;
      promptText?: string;
      topK?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedLogitDivergenceTask({
        modelId: body?.modelId,
        promptText: String(body?.promptText ?? ""),
        topK: body?.topK,
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/genome-kmer") {
    const body = await readJson<{
      sequenceId?: string;
      sequence?: string;
      k?: number;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const task = deps.store.seedGenomeKmerTask({
        sequenceId: body?.sequenceId,
        sequence: String(body?.sequence ?? ""),
        k: body?.k,
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/microscopy-tile-score") {
    const body = await readJson<{
      presetId?: string;
      sourceId?: string;
      width?: number;
      height?: number;
      rgbaBase64?: string;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = body?.presetId ? resolveTileSamplePreset(body.presetId, "microscopy") : null;
      const task = deps.store.seedMicroscopyTileScoreTask({
        sourceId: body?.sourceId ?? preset?.sourceId,
        width: body?.width ?? preset?.width ?? 0,
        height: body?.height ?? preset?.height ?? 0,
        rgbaBase64: String(body?.rgbaBase64 ?? preset?.rgbaBase64 ?? ""),
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
    const body = await readJson<{
      presetId?: string;
      sourceId?: string;
      width?: number;
      height?: number;
      rgbaBase64?: string;
      minExecutions?: number;
      minAgreeing?: number;
      requiredTransport?: TransportKind;
      requiredPeerSubreceipt?: boolean;
    }>(req);
    try {
      const preset = body?.presetId ? resolveTileSamplePreset(body.presetId, "image") : null;
      const task = deps.store.seedAssetTileAuditTask({
        sourceId: body?.sourceId ?? preset?.sourceId,
        width: body?.width ?? preset?.width ?? 0,
        height: body?.height ?? preset?.height ?? 0,
        rgbaBase64: String(body?.rgbaBase64 ?? preset?.rgbaBase64 ?? ""),
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/contact-map-tile") {
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/public-artifact") {
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/replay-verify") {
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
  if (req.method === "POST" && url.pathname === "/compute/admin/tasks/seed-sweep") {
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

async function flushStore(store: ComputeLabStore): Promise<void> {
  const flush = (store as RefreshableStore).flush;
  if (typeof flush === "function") await flush.call(store);
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

function sanitizePublicWorkerCapability(capability: WorkerCapability, trustedReference: boolean): WorkerCapability {
  const runtimeSurfaces = capability.runtimeSurfaces.filter((surface) =>
    trustedReference || surface !== "cpu-reference"
  );
  return {
    ...capability,
    runtimeSurfaces: Array.from(new Set(runtimeSurfaces)),
  };
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
    <div>embedding tile</div>
    <div class="muted">Doppler EmbeddingGemma rerank tile; replicated quorum on quantized top-k outputs</div>
    <textarea id="embeddingQuery" placeholder="query text">browser webgpu embedding retrieval</textarea>
    <textarea id="embeddingDocs" placeholder='JSON string array of documents'>["webgpu browser retrieval engine","protein contact map tile scoring","public replay verification receipts","quantized embedding rerank batch"]</textarea>
    <div class="row">
      <input id="embeddingTopK" value="3" aria-label="embedding top k">
    </div>
    <div class="row"><button id="seedEmbeddingTile">seed embedding tile</button></div>
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
    <div>prefill top-k probe</div>
    <div class="muted">Doppler Gemma 3 270M next-token top-k probe; public prompts only, replicated quorum, fixed model ${PREFILL_TOPK_PROBE_MODEL_ID}</div>
    <textarea id="prefillTopkPrompt" placeholder="prompt text">Finish this technical note in one line: WebGPU lets browsers run</textarea>
    <div class="row">
      <input id="prefillTopkK" value="4" aria-label="prefill top k">
    </div>
    <div class="row"><button id="seedPrefillTopkProbe">seed prefill top-k probe</button></div>
  </div>
  <div class="card">
    <div>logit divergence</div>
    <div class="muted">Quantized top-k logit buckets for cross-hardware measurement; fixed model ${LOGIT_DIVERGENCE_MODEL_ID}</div>
    <textarea id="logitDivergencePrompt" placeholder="prompt text">Finish this technical note in one line: WebGPU lets browsers run</textarea>
    <div class="row">
      <input id="logitDivergenceK" value="4" aria-label="logit divergence top k">
    </div>
    <div class="row"><button id="seedLogitDivergence">seed logit divergence</button></div>
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
document.getElementById("seedEmbeddingTile").onclick = () => adminPost("/compute/admin/tasks/embedding-tile", {
  queryText: val("embeddingQuery"),
  documents: JSON.parse(val("embeddingDocs") || "[]"),
  topK: asNum("embeddingTopK"),
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
document.getElementById("seedPrefillTopkProbe").onclick = () => adminPost("/compute/admin/tasks/prefill-topk-probe", {
  promptText: val("prefillTopkPrompt"),
  topK: asNum("prefillTopkK"),
});
document.getElementById("seedLogitDivergence").onclick = () => adminPost("/compute/admin/tasks/logit-divergence", {
  promptText: val("logitDivergencePrompt"),
  topK: asNum("logitDivergenceK"),
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
    table(["acceptedReceipts","rejectedReceipts","acceptedContactMapTileChunks","acceptedContactMapTileCells","acceptedEmbeddingTileChunks","acceptedLogitDivergenceChunks","acceptedPrefillTopkProbeChunks","acceptedPublicArtifactChunks","acceptedReplayVerifyChunks","acceptedSeedSweepChunks","acceptedSeedSweepSeeds","acceptedTensorTileChunks","acceptedTensorTileCells","acceptedWebGpuWitnessReceipts","acceptedWebRtcReceipts"], [data.publicStats?.scoreBreakdown || {}]);
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
