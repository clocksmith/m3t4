#!/usr/bin/env node
"use strict";

const { createHash, randomUUID } = require("node:crypto");

const CLIENT_VERSION = "smoke-webrtc-public-artifact-v1";
const DEFAULT_GAME_ORIGIN = "https://m3t4.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const PEER_TIMEOUT_MS = 25_000;

async function main() {
  const { chromium } = loadPlaywright();
  const config = readConfig();

  const initialStatus = await getJson(config.computeOrigin, "/compute/status");
  if (initialStatus.acceptAssignments) {
    throw new Error("assignment intake is already enabled; refusing to run a controlled smoke");
  }
  if (!initialStatus.webrtcSignalingEnabled || !initialStatus.webrtcDataEnabled) {
    throw new Error("WebRTC signaling and data routes must both be enabled");
  }

  const seeded = await seedPublicArtifactTask(config);
  const workerA = await registerWorker(config, "A");
  const workerB = await registerWorker(config, "B");
  let browser;

  try {
    await setAssignments(config, true);
    const nextA = await nextAssignment(config, workerA, seeded.taskId);
    const nextB = await nextAssignment(config, workerB, seeded.taskId);
    await Promise.all([
      acceptAssignment(config, workerA, nextA),
      acceptAssignment(config, workerB, nextB),
    ]);
    await setAssignments(config, false);

    const pair = await createPair(config, workerA, workerB);
    browser = await chromium.launch({ headless: config.headless });
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageErrors = { A: [], B: [] };
    pageA.on("pageerror", (error) => pageErrors.A.push(message(error)));
    pageB.on("pageerror", (error) => pageErrors.B.push(message(error)));

    await Promise.all([
      pageA.goto(`${config.gameOrigin}/#about`, { waitUntil: "domcontentloaded", timeout: 45_000 }),
      pageB.goto(`${config.gameOrigin}/#about`, { waitUntil: "domcontentloaded", timeout: 45_000 }),
    ]);

    const startedAt = Date.now();
    const [resultA, resultB] = await Promise.all([
      runPeer(pageA, config, {
        label: "A",
        role: "offerer",
        pair,
        worker: workerA,
        own: nextA,
        remote: publicWork(nextB),
      }),
      runPeer(pageB, config, {
        label: "B",
        role: "answerer",
        pair,
        worker: workerB,
        own: nextB,
        remote: publicWork(nextA),
      }),
    ]);
    const elapsedMs = Date.now() - startedAt;

    await Promise.all([
      contextA.close().catch(() => undefined),
      contextB.close().catch(() => undefined),
    ]);
    await browser.close();
    browser = null;
    await closePair(config, pair).catch(() => undefined);

    const dashboard = await adminGet(config, "/compute/admin/dashboard");
    const task = await adminGet(config, `/compute/admin/tasks/${encodeURIComponent(seeded.taskId)}`);
    const validation = dashboard.validationList?.find((entry) =>
      entry.taskId === seeded.taskId && entry.status === "accepted"
    );
    if (!validation) throw new Error("missing accepted validation");
    const receipts = await Promise.all(validation.acceptedReceiptIds.map((id) =>
      adminGet(config, `/compute/admin/receipts/${encodeURIComponent(id)}`)
    ));
    assertFinalState({ task, receipts, resultA, resultB });
    const finalStatus = await getJson(config.computeOrigin, "/compute/status");
    if (finalStatus.acceptAssignments) throw new Error("assignment intake remained enabled");

    console.log(JSON.stringify({
      ok: true,
      computeOrigin: config.computeOrigin,
      gameOrigin: config.gameOrigin,
      taskId: seeded.taskId,
      chunkId: task.chunks?.[0]?.chunkId,
      validationId: validation.validationId,
      taskStatus: task.status,
      chunkStatus: task.chunks?.[0]?.status,
      elapsedMs,
      acceptAssignments: finalStatus.acceptAssignments,
      pairId: pair.pairId,
      results: [resultA, resultB].map((result) => ({
        label: result.label,
        role: result.role,
        openMsBucket: result.openMsBucket,
        iceHostBucket: result.iceHostBucket,
        iceSrflxBucket: result.iceSrflxBucket,
        iceRelayBucket: result.iceRelayBucket,
        sentRequest: result.sentRequest,
        remoteAck: result.remoteAck,
        localReceipt: result.localReceipt,
      })),
      receipts: receipts.map((receipt) => ({
        workerId: receipt.workerId,
        receiptId: receipt.receiptId,
        decision: receipt.decision,
        transport: receipt.transport,
        validationMode: receipt.validationMode,
        outputHash: receipt.outputHash?.value,
        artifactHash: receipt.artifactHash?.value,
      })),
      pageErrors,
    }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await setAssignments(config, false).catch((error) => {
      console.error(`failed to disable assignment intake: ${message(error)}`);
    });
  }
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    throw new Error(
      "Playwright is required for this smoke. Install it with `npm install --no-save playwright` " +
      "or run with NODE_PATH pointing at an existing Playwright install.",
    );
  }
}

function readConfig() {
  const computeOrigin = cleanOrigin(process.env.PLASMA_LAB_SMOKE_ORIGIN || process.env.PLASMA_LAB_ORIGIN || "");
  if (!computeOrigin) throw new Error("set PLASMA_LAB_SMOKE_ORIGIN to the plasma-lab origin");
  const adminToken = process.env.PLASMA_LAB_SMOKE_ADMIN_TOKEN || process.env.PLASMA_LAB_ADMIN_TOKEN || "";
  if (!adminToken) throw new Error("set PLASMA_LAB_SMOKE_ADMIN_TOKEN or PLASMA_LAB_ADMIN_TOKEN");
  return {
    computeOrigin,
    adminToken,
    gameOrigin: cleanOrigin(process.env.M3T4_SMOKE_GAME_ORIGIN || process.env.M3T4_ORIGIN || DEFAULT_GAME_ORIGIN),
    headless: process.env.PLASMA_LAB_SMOKE_HEADLESS !== "0",
  };
}

async function seedPublicArtifactTask(config) {
  const matchId = `webrtc-artifact-${Date.now()}`;
  const payload = {
    matchId,
    tuple: {
      matchId,
      expectedLogHash: "webrtc-public-artifact-v1",
      transport: "plasma-data",
    },
  };
  const artifactJson = canonicalJson(payload);
  return adminPost(config, "/compute/admin/tasks/public-artifact", {
    artifact: {
      matchId,
      artifactHash: `webrtc-artifact-${matchId}`,
      artifactSha256: sha256Hex(artifactJson),
      payload,
    },
    minExecutions: 2,
    minAgreeing: 2,
  });
}

async function registerWorker(config, label) {
  return requestJson(config.computeOrigin, "/compute/workers/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: `webrtc-artifact-${label}`,
      capability: {
        kernels: ["m3t4.public_artifact_verify.v0"],
        runtimeSurfaces: ["browser-js", "cpu-reference"],
        maxChunkBytes: 1024 * 1024,
        maxConcurrentChunks: 1,
        deviceClass: "webrtc-artifact-smoke",
        adapterInfo: { smoke: "webrtc-public-artifact", label },
        clientVersion: CLIENT_VERSION,
      },
    }),
  });
}

async function nextAssignment(config, worker, expectedTaskId) {
  const params = new URLSearchParams({
    workerId: worker.workerId,
    workerSessionId: worker.workerSessionId,
  });
  const next = await requestJson(config.computeOrigin, `/compute/tasks/next?${params}`, {
    headers: { "x-worker-session-token": worker.workerSessionToken },
  });
  if (next.idle) throw new Error(`worker received idle assignment: ${next.reason || "unknown"}`);
  if (next.task?.taskId !== expectedTaskId) {
    throw new Error(`worker received task ${next.task?.taskId || "missing"}, expected ${expectedTaskId}`);
  }
  if (next.task?.kind !== "m3t4.public_artifact_verify.v0") {
    throw new Error(`worker received unexpected task kind ${next.task?.kind}`);
  }
  return next;
}

async function acceptAssignment(config, worker, next) {
  const accepted = await requestJson(config.computeOrigin, "/compute/assignments/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: worker.workerId,
      workerSessionId: worker.workerSessionId,
      workerSessionToken: worker.workerSessionToken,
      assignmentId: next.assignment.assignmentId,
      assignmentToken: next.assignment.assignmentToken,
    }),
  });
  if (!accepted.ok) throw new Error("assignment accept failed");
}

async function createPair(config, workerA, workerB) {
  let offer = await joinPair(config, workerA);
  if (offer.role !== "offerer") {
    await closePair(config, offer).catch(() => undefined);
    offer = await joinPair(config, workerA);
  }
  if (offer.role !== "offerer") throw new Error(`expected offerer role, got ${offer.role}`);
  const answer = await joinPair(config, workerB);
  if (answer.role !== "answerer" || answer.pairId !== offer.pairId) {
    await closePair(config, offer).catch(() => undefined);
    await closePair(config, answer).catch(() => undefined);
    throw new Error("failed to create a fresh two-worker WebRTC pair");
  }
  return {
    pairId: offer.pairId,
    pairToken: offer.pairToken,
    iceServers: offer.iceServers ?? [],
    channels: offer.channels ?? [],
    dataEnabled: offer.dataEnabled,
  };
}

async function joinPair(config, worker) {
  return requestJson(config.computeOrigin, "/compute/webrtc/pairs/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: worker.workerId,
      workerSessionId: worker.workerSessionId,
      workerSessionToken: worker.workerSessionToken,
    }),
  });
}

function publicWork(next) {
  return {
    assignmentId: next.assignment.assignmentId,
    taskId: next.task.taskId,
    chunk: next.chunk,
  };
}

async function runPeer(page, config, input) {
  return page.evaluate(async ({ computeOrigin, input, peerTimeoutMs, clientVersion }) => {
    const channels = new Map();
    const seenRemoteCandidates = new Set();
    const candidateTypes = { host: false, srflx: false, relay: false };
    let pc = null;
    let pumpTimer = null;
    let remoteAck = null;
    let localReceipt = null;
    const t0 = performance.now();

    const pairFetch = async (path = "") => {
      const res = await fetch(computeOrigin + `/compute/webrtc/pairs/${input.pair.pairId}${path}`, {
        headers: { "x-webrtc-pair-token": input.pair.pairToken },
        cache: "no-store",
      });
      return parseResponse(res, `pair${path}`);
    };
    const pairPost = async (path, body) => {
      const res = await fetch(computeOrigin + `/compute/webrtc/pairs/${input.pair.pairId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webrtc-pair-token": input.pair.pairToken },
        body: JSON.stringify(body),
      });
      return parseResponse(res, `pair${path}`);
    };
    const markCandidate = (candidate) => {
      const raw = String(candidate?.candidate || "");
      if (raw.includes(" typ host")) candidateTypes.host = true;
      if (raw.includes(" typ srflx")) candidateTypes.srflx = true;
      if (raw.includes(" typ relay")) candidateTypes.relay = true;
    };
    const addRemoteCandidates = async () => {
      const latest = await pairFetch();
      for (const candidate of latest.candidates || []) {
        if (!candidate || candidate.peerId === input.worker.workerId || seenRemoteCandidates.has(candidate.candidateId)) continue;
        try {
          await pc?.addIceCandidate(candidate.payload);
          seenRemoteCandidates.add(candidate.candidateId);
        } catch {
          // Candidate may arrive before remote description.
        }
      }
      return latest;
    };
    const attachChannel = (ch) => {
      channels.set(ch.label || "unknown", ch);
      if (ch.label === "plasma-data") {
        ch.onmessage = async (event) => {
          const msg = parseJson(event.data);
          if (msg?.protocol !== "plasma-data.v0" || msg?.type !== "artifact-work") return;
          localReceipt = await runOwnAssignment(msg, channels.get("plasma-receipts"));
        };
      }
      if (ch.label === "plasma-receipts") {
        ch.onmessage = (event) => {
          const msg = parseJson(event.data);
          if (msg?.protocol === "plasma-receipts.v0" && msg?.type === "artifact-result" && msg.requestId === input.remote.requestId) {
            remoteAck = msg;
          }
        };
      }
    };
    const runOwnAssignment = async (msg, receiptChannel) => {
      if (msg.assignmentId !== input.own.assignment.assignmentId) throw new Error("received assignment for another worker");
      if (msg.taskId !== input.own.task.taskId) throw new Error("received task for another worker");
      if (msg.chunk?.chunkId !== input.own.chunk.chunkId) throw new Error("received chunk for another worker");
      const workerResult = await executeWorkerChunk(msg.chunk, msg.requestId, peerTimeoutMs);
      const receipt = {
        workerId: input.worker.workerId,
        workerSessionId: input.worker.workerSessionId,
        workerSessionToken: input.worker.workerSessionToken,
        assignmentId: input.own.assignment.assignmentId,
        assignmentToken: input.own.assignment.assignmentToken,
        taskId: input.own.task.taskId,
        chunkId: input.own.chunk.chunkId,
        kernelId: workerResult.kernelId,
        kernelHash: workerResult.kernelHash,
        inputHash: workerResult.inputHash,
        artifactHash: workerResult.artifactHash,
        outputHash: { algorithm: "sha256", value: workerResult.outputHash },
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        executionMode: workerResult.executionMode || "cpu",
        transport: "webrtc",
        governorMode: "quiet",
        deviceClass: "webrtc-artifact-smoke",
        adapterInfo: {
          transfer: "plasma-data",
          role: input.role,
          dataChannelBucket: "open",
        },
        computeMs: workerResult.computeMs,
        clientVersion,
      };
      const submitted = await postJson("/compute/receipts", receipt);
      const ack = {
        protocol: "plasma-receipts.v0",
        type: "artifact-result",
        requestId: msg.requestId,
        ok: submitted.receipt?.decision === "pending" || submitted.receipt?.decision === "accepted",
        receiptId: submitted.receipt?.receiptId,
        decision: submitted.receipt?.decision,
        outputHash: workerResult.outputHash,
      };
      await waitFor(() => receiptChannel?.readyState === "open" ? true : null, 1000);
      receiptChannel?.send(JSON.stringify(ack));
      return ack;
    };

    try {
      pc = new RTCPeerConnection({ iceServers: input.pair.iceServers || [] });
      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        markCandidate(event.candidate);
        pairPost("/candidates", {
          peerId: input.worker.workerId,
          candidates: [typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate],
        }).catch(() => {});
      };
      if (input.role === "offerer") {
        for (const label of ["plasma-control", "plasma-data", "plasma-receipts"]) {
          attachChannel(pc.createDataChannel(label, { ordered: true }));
        }
      } else {
        pc.ondatachannel = (event) => attachChannel(event.channel);
      }
      pumpTimer = setInterval(() => { addRemoteCandidates().catch(() => {}); }, 250);

      if (input.role === "offerer") {
        await pc.setLocalDescription(await pc.createOffer());
        await pairPost("/offer", { offer: pc.localDescription });
        const answered = await waitFor(async () => {
          const latest = await addRemoteCandidates();
          return latest.answer ? latest : null;
        }, peerTimeoutMs);
        if (!answered?.answer) throw new Error("answer timeout");
        await pc.setRemoteDescription(answered.answer);
      } else {
        const offered = await waitFor(async () => {
          const latest = await addRemoteCandidates();
          return latest.offer ? latest : null;
        }, peerTimeoutMs);
        if (!offered?.offer) throw new Error("offer timeout");
        await pc.setRemoteDescription(offered.offer);
        await pc.setLocalDescription(await pc.createAnswer());
        await pairPost("/answer", { answer: pc.localDescription });
      }

      await waitFor(() => (
        ["plasma-control", "plasma-data", "plasma-receipts"].every((label) => channels.get(label)?.readyState === "open") ? true : null
      ), peerTimeoutMs);
      const requestId = `artifact-${input.label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      input.remote.requestId = requestId;
      channels.get("plasma-data").send(JSON.stringify({
        protocol: "plasma-data.v0",
        type: "artifact-work",
        requestId,
        assignmentId: input.remote.assignmentId,
        taskId: input.remote.taskId,
        chunk: input.remote.chunk,
      }));
      await waitFor(() => (remoteAck && localReceipt ? true : null), peerTimeoutMs);
      return {
        label: input.label,
        role: input.role,
        openMsBucket: bucketMs(performance.now() - t0),
        iceHostBucket: yesNo(candidateTypes.host),
        iceSrflxBucket: yesNo(candidateTypes.srflx),
        iceRelayBucket: yesNo(candidateTypes.relay),
        sentRequest: { requestId, chunkId: input.remote.chunk.chunkId },
        remoteAck,
        localReceipt,
      };
    } finally {
      if (pumpTimer) clearInterval(pumpTimer);
      for (const ch of channels.values()) {
        try { ch.close?.(); } catch {}
      }
      try { pc?.close?.(); } catch {}
      pairPost("/close", {}).catch(() => {});
    }

    async function executeWorkerChunk(chunk, assignmentId, timeoutMs) {
      return new Promise((resolve, reject) => {
        let worker = null;
        const timer = setTimeout(() => {
          try { worker?.terminate(); } catch {}
          reject(new Error("artifact worker timeout"));
        }, timeoutMs);
        try {
          worker = new Worker(new URL("/workers/plasma-worker.js", location.origin), { type: "module" });
          worker.onmessage = (event) => {
            const msg = event.data;
            if (msg?.assignmentId !== assignmentId) return;
            clearTimeout(timer);
            try { worker?.terminate(); } catch {}
            if (msg.type === "done") resolve(msg);
            else reject(new Error(msg?.message || "artifact worker failed"));
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            try { worker?.terminate(); } catch {}
            reject(new Error(event.message || "artifact worker error"));
          };
          worker.postMessage({ type: "run", assignmentId, chunk });
        } catch (error) {
          clearTimeout(timer);
          try { worker?.terminate(); } catch {}
          reject(error);
        }
      });
    }

    async function postJson(path, body) {
      const response = await fetch(computeOrigin + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseResponse(response, path);
    }

    async function parseResponse(response, path) {
      const raw = await response.text();
      const body = raw ? JSON.parse(raw) : null;
      if (!response.ok) throw new Error(`${path} -> ${response.status}: ${raw}`);
      return body;
    }

    function parseJson(raw) {
      try { return JSON.parse(String(raw)); } catch { return null; }
    }

    async function waitFor(fn, timeoutMs) {
      const started = performance.now();
      while (performance.now() - started < timeoutMs) {
        const value = await fn();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    }

    function bucketMs(ms) {
      if (!Number.isFinite(ms)) return "unknown";
      if (ms < 10) return "<10ms";
      if (ms < 20) return "10-20ms";
      if (ms < 50) return "20-50ms";
      return "50ms+";
    }

    function yesNo(value) {
      return value ? "yes" : "no";
    }
  }, {
    computeOrigin: config.computeOrigin,
    input,
    peerTimeoutMs: PEER_TIMEOUT_MS,
    clientVersion: CLIENT_VERSION,
  });
}

function assertFinalState({ task, receipts, resultA, resultB }) {
  const chunk = task.chunks?.[0];
  if (task.status !== "complete") throw new Error(`task status was ${task.status}`);
  if (chunk?.status !== "accepted") throw new Error(`chunk status was ${chunk?.status || "missing"}`);
  if (receipts.length !== 2) throw new Error(`expected 2 receipts, got ${receipts.length}`);
  for (const receipt of receipts) {
    if (receipt.decision !== "accepted") throw new Error(`${receipt.receiptId} was ${receipt.decision}`);
    if (receipt.transport !== "webrtc") throw new Error(`${receipt.receiptId} transport was ${receipt.transport}`);
    if (receipt.validationMode !== "expected-hash") throw new Error(`${receipt.receiptId} validation was ${receipt.validationMode}`);
    if (receipt.outputHash?.value !== chunk.expectedOutputHash?.value) {
      throw new Error(`${receipt.receiptId} output hash did not match expected`);
    }
  }
  for (const result of [resultA, resultB]) {
    if (result.iceRelayBucket !== "no") throw new Error(`${result.label} used relay`);
    if (!result.remoteAck?.ok) throw new Error(`${result.label} did not receive a peer receipt ack`);
    if (!result.localReceipt?.ok) throw new Error(`${result.label} did not submit its local receipt`);
  }
}

async function setAssignments(config, acceptAssignments) {
  return adminPost(config, "/compute/admin/assignments", { acceptAssignments });
}

async function closePair(config, pair) {
  return requestJson(config.computeOrigin, `/compute/webrtc/pairs/${encodeURIComponent(pair.pairId)}/close`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webrtc-pair-token": pair.pairToken,
    },
    body: "{}",
  });
}

async function adminGet(config, path) {
  return requestJson(config.computeOrigin, path, {
    headers: { "x-plasma-admin-token": config.adminToken },
  });
}

async function adminPost(config, path, body) {
  return requestJson(config.computeOrigin, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-plasma-admin-token": config.adminToken,
    },
    body: JSON.stringify(body),
  });
}

async function getJson(origin, path) {
  return requestJson(origin, path);
}

async function requestJson(origin, path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(origin + path, { ...init, signal: controller.signal });
    const raw = await response.text();
    const body = raw ? JSON.parse(raw) : null;
    if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> ${response.status}: ${raw}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))) {
      out[key] = normalize(inner);
    }
    return out;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanOrigin(value) {
  return String(value || "").replace(/\/+$/, "");
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: message(error),
    runId: randomUUID(),
  }, null, 2));
  process.exitCode = 1;
});
