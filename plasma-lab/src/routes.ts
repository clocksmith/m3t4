import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlasmaLabConfig } from "./config.js";
import { header, html, json, readJson } from "./http.js";
import { canonicalJson } from "./plasma/hash.js";
import type { ContentHash, ExecutionMode, GovernorMode, TransportKind, WorkerCapability, WorkerRefusalReason } from "./plasma/types.js";
import { ComputeLabStore, type WebRtcPairRecord, type WebRtcSessionRecord } from "./store.js";
import { COMPUTE_USE_CASES } from "./use-cases.js";

export interface RouteDeps {
  store: ComputeLabStore;
  config: PlasmaLabConfig;
}

interface WorkerAuthBody {
  workerId?: string;
  workerSessionId?: string;
  workerSessionToken?: string;
}

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

  if (req.method === "POST" && url.pathname === "/compute/workers/register") {
    const body = await readJson<{ label?: string; capability?: WorkerCapability }>(req);
    if (!body?.capability || !Array.isArray(body.capability.kernels)) {
      json(res, 400, { error: "capability.kernels required" });
      return true;
    }
    const { worker, session, acceptedKernels } = deps.store.registerWorker({
      label: body.label,
      capability: body.capability,
    });
    json(res, 200, {
      workerId: worker.workerId,
      workerSessionId: session.workerSessionId,
      workerSessionToken: session.token,
      expiresAt: session.expiresAt,
      acceptedKernels,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/workers/heartbeat") {
    const body = await readJson<WorkerAuthBody & { governorMode?: GovernorMode }>(req);
    try {
      const session = deps.store.heartbeat(authFrom(body, req, { governorMode: body?.governorMode }));
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
      const worker = deps.store.updateCapability(authFrom(body, req, { capability: body.capability }));
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
          visibilityBucket: body?.visibilityBucket,
          batteryBucket: body?.batteryBucket,
          notes: body?.notes,
        },
      }));
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
        json(res, 200, { idle: true, reason: deps.store.summary().acceptAssignments ? "no-work" : "assignments-disabled" });
        return true;
      }
      json(res, 200, {
        assignment: next.assignment,
        chunk: next.chunk,
        task: {
          taskId: next.task.taskId,
          kind: next.task.kind,
          validationPolicy: next.task.validationPolicy,
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
      computeMs?: number;
      clientVersion?: string;
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
        computeMs: Number(body.computeMs) || 0,
        clientVersion: body.clientVersion,
        signature: body.signature,
      }));
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
      }>(req);
    const token = body?.pairToken ?? header(req, "x-webrtc-pair-token");
    try {
      if (req.method === "GET" && !action) {
        json(res, 200, publicWebRtcPair(deps.store.getWebRtcPair({ pairId, token }), deps.config));
        return true;
      }
      if (req.method === "POST" && action === "offer") {
        if (body?.offer === undefined) throw new Error("offer required");
        json(res, 200, publicWebRtcPair(deps.store.setWebRtcPairOffer({ pairId, token, offer: body.offer }), deps.config));
        return true;
      }
      if (req.method === "POST" && action === "answer") {
        if (body?.answer === undefined) throw new Error("answer required");
        json(res, 200, publicWebRtcPair(deps.store.setWebRtcPairAnswer({ pairId, token, answer: body.answer }), deps.config));
        return true;
      }
      if (req.method === "POST" && action === "candidates") {
        const candidates = Array.isArray(body?.candidates)
          ? body.candidates
          : body?.candidate === undefined
            ? []
            : [body.candidate];
        if (candidates.length === 0) throw new Error("candidate or candidates required");
        json(res, 200, publicWebRtcPair(deps.store.addWebRtcPairCandidates({
          pairId,
          token,
          peerId: body?.peerId,
          candidates,
        }), deps.config));
        return true;
      }
      if (req.method === "POST" && action === "close") {
        json(res, 200, publicWebRtcPair(deps.store.closeWebRtcPair({ pairId, token }), deps.config));
        return true;
      }
      json(res, 404, { error: "WebRTC pair route not found" });
    } catch (e) {
      json(res, 400, { error: message(e) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/compute/webrtc/sessions") {
    const session = deps.store.createWebRtcSession();
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
      json(res, 200, publicWebRtcSession(deps.store.setWebRtcOffer({ sessionId, token, offer: body.offer }), deps.config));
      return true;
    }
    if (req.method === "POST" && action === "answer") {
      if (body?.answer === undefined) throw new Error("answer required");
      json(res, 200, publicWebRtcSession(deps.store.setWebRtcAnswer({ sessionId, token, answer: body.answer }), deps.config));
      return true;
    }
    if (req.method === "POST" && action === "candidates") {
      const candidates = Array.isArray(body?.candidates)
        ? body.candidates
        : body?.candidate === undefined
          ? []
          : [body.candidate];
      if (candidates.length === 0) throw new Error("candidate or candidates required");
      json(res, 200, publicWebRtcSession(deps.store.addWebRtcCandidates({
        sessionId,
        token,
        peerId: body?.peerId,
        candidates,
      }), deps.config));
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
      json(res, 200, publicWebRtcSession(deps.store.closeWebRtcSession({ sessionId, token }), deps.config));
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
    const body = await readJson<{ acceptAssignments?: boolean }>(req);
    if (typeof body?.acceptAssignments !== "boolean") {
      json(res, 400, { error: "acceptAssignments boolean required" });
      return true;
    }
    deps.store.setAcceptAssignments(body.acceptAssignments);
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
      json(res, 200, { taskId: task.taskId, chunks: task.chunks.length, validationPolicy: task.validationPolicy });
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
      });
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
      });
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
      json(res, 200, deps.store.cancelTask(taskId));
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
    </div>
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
    <div>public artifact verify</div>
    <textarea id="artifactJson" placeholder='paste PublicReplayArtifactV1 JSON'></textarea>
    <div class="row"><button id="seedArtifact">seed artifact verify</button></div>
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
<h2>replay badges</h2><div id="replayBadges"></div>
<h2>current capability map</h2><div id="capabilityMap"></div>
<h2>observed capability map</h2><div id="capabilityObservationMap"></div>
<h2>connectivity map</h2><div id="connectivityMap"></div>
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
document.getElementById("seedSweep").onclick = () => adminPost("/compute/admin/tasks/seed-sweep", {
  stageId: val("sweepStage"),
  brainA: val("sweepA"),
  brainB: val("sweepB"),
  seedStart: asNum("sweepStart"),
  seedEndExclusive: asNum("sweepEnd"),
  seedChunkSize: asNum("sweepChunk"),
});
document.getElementById("seedArtifact").onclick = () => {
  const raw = val("artifactJson");
  if (!raw) throwStatus("artifact JSON required");
  const parsed = JSON.parse(raw);
  const body = parsed.artifact ? parsed : { artifact: parsed };
  return adminPost("/compute/admin/tasks/public-artifact", body);
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
  document.getElementById("summary").innerHTML = ["workers","activeSessions","tasks","assignments","receipts","validations","capabilityObservations","connectivityObservations","webrtcSessions","webrtcPairs"]
    .map((k) => '<div class="card"><div>'+k+'</div><div class="n">'+(data[k] ?? 0)+'</div></div>').join("");
  document.getElementById("useCases").innerHTML = table(["id","status","workload","inputBoundary","validation"], useCases);
  document.getElementById("publicStats").innerHTML = table(["generatedAt","privacy","totalWorkers","activeWorkers","totalReceipts","acceptedReceiptPct","webgpuSupportedPct","webgpuCorrectnessPct","renderFixturePct","webrtcDirectSuccessPct","turnRequiredPct","medianKernelMs","p95KernelMs"], [data.publicStats || {}]);
  document.getElementById("workerProfiles").innerHTML = table(["workerId","browserFamily","deviceClass","adapterClass","webgpuAvailable","webgpuCorrectnessScore","renderFixtureScore","webrtcDirectSuccessRate","turnRequiredRate","p95KernelMs","allowedWorkloadTier","acceptedReceipts","rejectedReceipts"], data.workerProfiles || []);
  document.getElementById("deviceClasses").innerHTML = table(["classId","workers","activeWorkers","webgpuCorrectnessScore","renderFixtureScore","webrtcDirectSuccessRate","turnRequiredRate","p95KernelMs"], data.deviceClassProfiles || []);
  document.getElementById("networkClasses").innerHTML = table(["classId","workers","activeWorkers","webrtcDirectSuccessRate","turnRequiredRate","p95KernelMs"], data.networkClassProfiles || []);
  document.getElementById("replayBadges").innerHTML = table(["matchId","status","agreedReceipts","requiredReceipts","rulesHash","stageHash","verifiedAt"], data.replayBadges || []);
  document.getElementById("capabilityMap").innerHTML = table(["dimension","bucket","count"], flattenMap(data.capabilityMap || {}));
  document.getElementById("capabilityObservationMap").innerHTML = table(["dimension","bucket","count"], flattenMap(data.capabilityObservationMap || {}));
  document.getElementById("connectivityMap").innerHTML = table(["dimension","bucket","count"], flattenMap(data.connectivityMap || {}));
  document.getElementById("tasks").innerHTML = table(["taskId","kind","status","chunks","accepted","rejected"], data.taskList || []);
  document.getElementById("receipts").innerHTML = table(["receivedAt","workerId","taskId","chunkId","decision","computeMs"], data.receiptList || []);
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
