#!/usr/bin/env node
"use strict";

const { createHash, randomUUID } = require("node:crypto");

const DEFAULT_GAME_ORIGIN = "https://m3t4.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 120_000;
const ASSET_TILE_AUDIT_KERNEL = "asset.tile_audit.v0";
const EXPLOIT_SEARCH_KERNEL = "m3t4.exploit_search.v0";
const IMAGE_TILE_INFER_KERNEL = "ml.image_tile_infer.v0";
const MICROSCOPY_TILE_SCORE_KERNEL = "science.microscopy_tile_score.v0";
const PUBLIC_ARTIFACT_KERNEL = "m3t4.public_artifact_verify.v0";
const REPLAY_VERIFY_KERNEL = "m3t4.replay_verify.v1";
const CONTACT_MAP_TILE_KERNEL = "science.contact_map_tile.v0";
const TENSOR_TILE_KERNEL = "plasma.tensor_tile.v0";

async function main() {
  const { chromium } = loadPlaywright();
  const config = readConfig();
  const passes = [];
  for (let index = 0; index < config.repeat; index++) {
    passes.push(await runOnce(chromium, config, index + 1));
  }
  const result = config.repeat === 1 ? passes[0] : {
    ok: true,
    computeOrigin: config.computeOrigin,
    gameOrigin: config.gameOrigin,
    repeat: config.repeat,
    passes,
    aggregate: aggregatePasses(passes),
  };
  console.log(JSON.stringify(result, null, 2));
}

async function runOnce(chromium, config, pass) {
  const initialStatus = await getJson(config.computeOrigin, "/compute/status");
  if (initialStatus.acceptAssignments) {
    throw new Error("assignment intake is already enabled; refusing to run a controlled smoke");
  }
  if (!initialStatus.webrtcSignalingEnabled || !initialStatus.webrtcDataEnabled) {
    throw new Error("WebRTC signaling and data routes must both be enabled");
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: config.headless });
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const pageErrors = [[], []];
    pages.forEach((page, index) => {
      page.on("pageerror", (error) => pageErrors[index].push(message(error)));
    });

    const preflight = await Promise.all(pages.map((page, index) =>
      prepareStaffPage(page, config, index === 0 ? "A" : "B")
    ));

    await setAssignments(config, true, config.assignmentWindowMs);
    const startedAt = Date.now();
    await Promise.all(pages.map((page) =>
      page.evaluate(() => window.__M3T4_COMPUTE_CLIENT__?.poll())
    ));

    const witnessTasks = [await seedRenderWitnessTask(config)];
    if (config.kernel === "tensor-tile" || config.kernel === "contact-map-tile") {
      witnessTasks.push(await seedWebGpuWitnessTask(config));
    }
    for (const witness of witnessTasks) {
      if (witness.chunks !== 1) throw new Error(`expected 1 witness chunk, got ${witness.chunks}`);
      await waitForAcceptedTask(config, witness.taskId);
      await waitForComputeClientsIdle(pages);
    }
    await waitForWorkerTiers(
      config,
      preflight.map((status) => status.workerId).filter(Boolean),
      expectedTierForKernel(config.kernel),
    );

    const seeded = await seedTask(config, pass);
    if (seeded.chunks !== 1) throw new Error(`expected 1 chunk, got ${seeded.chunks}`);
    await Promise.all(pages.map((page) =>
      page.evaluate(() => window.__M3T4_COMPUTE_CLIENT__?.poll())
    ));
    await waitForTaskAssignments(config, pages, seeded.taskId, 2);
    const accepted = await waitForAcceptedTask(config, seeded.taskId);
    const elapsedMs = Date.now() - startedAt;
    const finalStatus = await disableAssignments(config);

    const validation = accepted.validation;
    const receipts = await Promise.all(validation.acceptedReceiptIds.map((id) =>
      adminGet(config, `/compute/admin/receipts/${encodeURIComponent(id)}`)
    ));
    const snapshots = await Promise.all(pages.map((page) => page.evaluate(() => window.m3t4Compute.status())));
    await Promise.all(pages.map((page) => page.evaluate(() => window.m3t4Compute.stop()).catch(() => undefined)));
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
    await browser.close();
    browser = null;

    assertWebRtcDataReceipts(receipts, accepted.task);

    return {
      ok: true,
      computeOrigin: config.computeOrigin,
      gameOrigin: config.gameOrigin,
      taskKind: accepted.task.kind,
      witnessTaskIds: witnessTasks.map((task) => task.taskId),
      taskId: seeded.taskId,
      chunkId: accepted.task.chunks?.[0]?.chunkId,
      validationId: validation.validationId,
      taskStatus: accepted.task.status,
      chunkStatus: accepted.task.chunks?.[0]?.status,
      elapsedMs,
      acceptAssignments: finalStatus.acceptAssignments,
      webrtcSignalingEnabled: finalStatus.webrtcSignalingEnabled,
      webrtcDataEnabled: finalStatus.webrtcDataEnabled,
      webrtcTurnEnabled: finalStatus.webrtcTurnEnabled,
      preflight: preflight.map((status, index) => ({
        label: index === 0 ? "A" : "B",
        configured: status.configured,
        available: status.available,
        state: status.state,
        gate: status.gate,
        webrtcArtifacts: status.webrtcArtifacts,
      })),
      receipts: receipts.map((receipt, index) => ({
        label: index === 0 ? "A" : "B",
        workerId: receipt.workerId,
        receiptId: receipt.receiptId,
        decision: receipt.decision,
        transport: receipt.transport,
        validationMode: receipt.validationMode,
        executionMode: receipt.executionMode,
        outputHash: receipt.outputHash?.value,
        transcript: receipt.adapterInfo,
      })),
      snapshots: snapshots.map((status, index) => ({
        label: index === 0 ? "A" : "B",
        workerId: status.workerId,
        state: status.state,
        totals: status.totals,
        gate: status.gate,
        webrtcArtifacts: status.webrtcArtifacts,
      })),
      pageErrors,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await disableAssignments(config).catch((error) => {
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
    kernel: kernelOption(),
    repeat: integerOption("repeat", "PLASMA_LAB_SMOKE_REPEAT", 1, 1, 50),
    assignmentWindowMs: integerOption("assignment-window-ms", "PLASMA_LAB_SMOKE_ASSIGNMENT_WINDOW_MS", TASK_TIMEOUT_MS, 1_000, 600_000),
  };
}

async function seedTask(config, pass) {
  if (config.kernel === "replay-verify") return seedReplayVerifyTask(config, pass);
  if (config.kernel === "seed-sweep") return seedSeedSweepTask(config, pass);
  if (config.kernel === "image-tile-infer") return seedImageTileInferTask(config, pass);
  if (config.kernel === "microscopy-tile-score") return seedMicroscopyTileScoreTask(config, pass);
  if (config.kernel === "exploit-search") return seedExploitSearchTask(config, pass);
  if (config.kernel === "asset-tile-audit") return seedAssetTileAuditTask(config, pass);
  if (config.kernel === "contact-map-tile") return seedContactMapTileTask(config, pass);
  if (config.kernel === "tensor-tile") return seedTensorTileTask(config, pass);
  return seedPublicArtifactTask(config, pass);
}

async function seedRenderWitnessTask(config) {
  return adminPost(config, "/compute/admin/tasks/device-witness-render", {
    minExecutions: 2,
    minAgreeing: 2,
  });
}

async function seedWebGpuWitnessTask(config) {
  return adminPost(config, "/compute/admin/tasks/device-witness-webgpu", {
    seed: 7,
    count: 32,
    minExecutions: 2,
    minAgreeing: 2,
  });
}

async function seedPublicArtifactTask(config, pass) {
  const matchId = `webrtc-client-artifact-${Date.now()}-${pass}`;
  const payload = {
    matchId,
    tuple: {
      matchId,
      expectedLogHash: "webrtc-client-artifact-v1",
      transport: "plasma-data",
    },
  };
  const artifactJson = canonicalJson(payload);
  return adminPost(config, "/compute/admin/tasks/public-artifact", {
    artifact: {
      matchId,
      artifactHash: `webrtc-client-artifact-${matchId}`,
      artifactSha256: sha256Hex(artifactJson),
      payload,
    },
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedReplayVerifyTask(config, pass) {
  const replayArtifactJson = await replayArtifactFixtureJson(`webrtc-replay-verify-${Date.now()}-${pass}`);
  return adminPost(config, "/compute/admin/tasks/replay-verify", {
    replayArtifactJson,
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedSeedSweepTask(config, pass) {
  return adminPost(config, "/compute/admin/tasks/seed-sweep", {
    stageId: "boardroom",
    brainA: "unicorn",
    brainB: "disruptor",
    seedStart: 100 + pass * 8,
    seedEndExclusive: 108 + pass * 8,
    seedChunkSize: 8,
    maxTicks: 180,
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedTensorTileTask(config, pass) {
  return adminPost(config, "/compute/admin/tasks/tensor-tile", {
    seed: 1000 + pass,
    rows: 16,
    cols: 16,
    depth: 32,
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedImageTileInferTask(config, pass) {
  const presets = [
    "ui-chip-sample",
    "sprite-sample",
    "terrain-sample",
    "fx-burst-sample",
  ];
  return adminPost(config, "/compute/admin/tasks/image-tile-infer", {
    presetId: presets[(pass - 1) % presets.length],
    topK: 3,
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedMicroscopyTileScoreTask(config, pass) {
  const presets = [
    "microscopy-dense-sample",
    "microscopy-sparse-sample",
    "microscopy-artifact-sample",
  ];
  return adminPost(config, "/compute/admin/tasks/microscopy-tile-score", {
    presetId: presets[(pass - 1) % presets.length],
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedExploitSearchTask(config, pass) {
  return adminPost(config, "/compute/admin/tasks/exploit-search", {
    stageId: "boardroom",
    brainA: "unicorn",
    brainB: "disruptor",
    seedStart: 200 + pass * 8,
    seedEndExclusive: 208 + pass * 8,
    maxTicks: 180,
    topFindings: 4,
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedAssetTileAuditTask(config, pass) {
  const presets = [
    "sprite-sample",
    "ui-chip-sample",
    "terrain-sample",
    "fx-burst-sample",
  ];
  return adminPost(config, "/compute/admin/tasks/asset-tile-audit", {
    presetId: presets[(pass - 1) % presets.length],
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function seedContactMapTileTask(config, pass) {
  const presets = [
    "human-myoglobin-core-helices",
    "human-hemoglobin-alpha-fold-core",
    "human-lysozyme-stable-core",
  ];
  return adminPost(config, "/compute/admin/tasks/contact-map-tile", {
    presetId: presets[(pass - 1) % presets.length],
    minExecutions: 2,
    minAgreeing: 2,
    requiredTransport: "webrtc",
    requiredPeerSubreceipt: true,
  });
}

async function replayArtifactFixtureJson(matchId) {
  const sim = await import("@m3t4/sim");
  const stage = sim.STAGES.boardroom;
  const brainA = sim.STRATEGIES.unicorn;
  const brainB = sim.STRATEGIES.disruptor;
  const result = sim.simulate({
    stage,
    brainA,
    brainB,
    seed: 9876,
    maxTicks: 180,
  });
  const artifact = sim.createReplayArtifactV1({
    matchId,
    mode: "test",
    stage,
    seed: 9876,
    chars: sim.DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "unicorn" },
      { kind: "brain", tier: "system", label: "disruptor" },
    ],
    actionLog: result.frameLog,
    result,
    createdAt: "2026-04-22T00:00:00.000Z",
  });
  return sim.stableReplayJson(artifact);
}

async function prepareStaffPage(page, config, label) {
  await page.goto(`${config.gameOrigin}/#about`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return page.evaluate(async ({ computeOrigin, label }) => {
    window.__M3T4_COMPUTE_LAB_ORIGIN__ = computeOrigin;
    window.__M3T4_COMPUTE_SLACK_WORKER__ = true;
    window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ = true;
    window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS_STRICT__ = true;
    const mod = await import(`/lib/compute.js?staff-webrtc-client-artifact=${encodeURIComponent(label)}-${Date.now()}`);
    const client = mod.getComputeClient();
    window.__M3T4_COMPUTE_CLIENT__ = client;
    await client.start({ mode: "standard", persist: false });
    const status = client.snapshot();
    if (!status.available || !status.configured || status.webrtcArtifacts !== true) {
      throw new Error(`compute unavailable: ${JSON.stringify(status)}`);
    }
    return status;
  }, { computeOrigin: config.computeOrigin, label });
}

async function waitForAcceptedTask(config, taskId) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < TASK_TIMEOUT_MS) {
    const [task, dashboard] = await Promise.all([
      adminGet(config, `/compute/admin/tasks/${encodeURIComponent(taskId)}`),
      adminGet(config, "/compute/admin/dashboard"),
    ]);
    last = { task, dashboard };
    const chunk = task.chunks?.[0];
    const validation = dashboard.validationList?.find((entry) =>
      entry.taskId === taskId && entry.status === "accepted"
    );
    if (task.status === "complete" && chunk?.status === "accepted" && validation) {
      return { task, dashboard, validation };
    }
    await delay(1500);
  }
  throw new Error(`timed out waiting for accepted task: ${JSON.stringify({
    task: last?.task,
    validations: last?.dashboard?.validationList?.filter((entry) => entry.taskId === taskId),
    receipts: last?.dashboard?.receiptList?.filter((entry) => entry.taskId === taskId),
  })}`);
}

async function waitForComputeClientsIdle(pages, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let last = [];
  while (Date.now() - startedAt < timeoutMs) {
    last = await Promise.all(pages.map((page) =>
      page.evaluate(() => window.m3t4Compute.status()).catch((error) => ({ error: message(error) }))
    ));
    if (last.every((status) => status && !status.current && !String(status.state || "").startsWith("running "))) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for compute clients to idle: ${JSON.stringify(last)}`);
}

async function waitForTaskAssignments(config, pages, taskId, expected, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let last = [];
  while (Date.now() - startedAt < timeoutMs) {
    const dashboard = await adminGet(config, "/compute/admin/dashboard");
    last = (dashboard.assignmentList || []).filter((entry) => entry.taskId === taskId);
    if (last.length >= expected) return last;
    await Promise.all(pages.map((page) =>
      page.evaluate(() => {
        const client = window.__M3T4_COMPUTE_CLIENT__;
        const status = window.m3t4Compute.status();
        if (!client || status.current) return null;
        return client.poll();
      }).catch(() => undefined)
    ));
    await delay(500);
  }
  throw new Error(`timed out waiting for ${expected} task assignments: ${JSON.stringify(last)}`);
}

async function waitForWorkerTiers(config, workerIds, expectedTier, timeoutMs = 20_000) {
  const wanted = new Set(workerIds.filter(Boolean));
  if (!wanted.size) throw new Error("worker ids required to check workload tiers");
  const startedAt = Date.now();
  let last = [];
  while (Date.now() - startedAt < timeoutMs) {
    const dashboard = await adminGet(config, "/compute/admin/dashboard");
    last = (dashboard.workerProfiles || []).filter((profile) => wanted.has(profile.workerId));
    if (last.length === wanted.size && last.every((profile) => profile.allowedWorkloadTier === expectedTier)) return last;
    await delay(500);
  }
  throw new Error(`timed out waiting for worker tier ${expectedTier}: ${JSON.stringify(last)}`);
}

function assertWebRtcDataReceipts(receipts, task) {
  const chunk = task.chunks?.[0];
  if (receipts.length !== 2) throw new Error(`expected 2 accepted receipts, got ${receipts.length}`);
  for (const receipt of receipts) {
    if (receipt.decision !== "accepted") throw new Error(`${receipt.receiptId} was ${receipt.decision}`);
    if (receipt.transport !== "webrtc") throw new Error(`${receipt.receiptId} transport was ${receipt.transport}`);
    if (receipt.validationMode !== "expected-hash") {
      throw new Error(`${receipt.receiptId} validation mode was ${receipt.validationMode}`);
    }
    if (receipt.outputHash?.value !== chunk?.expectedOutputHash?.value) {
      throw new Error(`${receipt.receiptId} output hash did not match expected`);
    }
    const transcript = receipt.adapterInfo ?? {};
    if (transcript.status !== "ok") throw new Error(`${receipt.receiptId} status was ${transcript.status}`);
    if (transcript.transfer !== "plasma-data") throw new Error(`${receipt.receiptId} transfer was ${transcript.transfer}`);
    if (transcript.dataChannelBucket !== "open") {
      throw new Error(`${receipt.receiptId} data channel was ${transcript.dataChannelBucket}`);
    }
    if (transcript.dataWorkBucket !== "artifact-request-ok") {
      throw new Error(`${receipt.receiptId} data work bucket was ${transcript.dataWorkBucket}`);
    }
    if (transcript.dataReceiptBucket !== "ok") {
      throw new Error(`${receipt.receiptId} data receipt bucket was ${transcript.dataReceiptBucket}`);
    }
    if (!transcript.peerAssignmentId) {
      throw new Error(`${receipt.receiptId} missing peer assignment id`);
    }
    if (transcript.peerSubreceipt?.peerAssignmentId !== transcript.peerAssignmentId) {
      throw new Error(`${receipt.receiptId} peer subreceipt did not bind peer assignment`);
    }
    if ((task.kind === TENSOR_TILE_KERNEL || task.kind === CONTACT_MAP_TILE_KERNEL) && receipt.executionMode !== "webgpu") {
      throw new Error(`${receipt.receiptId} execution mode was ${receipt.executionMode}`);
    }
    if (
      (
        task.kind === ASSET_TILE_AUDIT_KERNEL ||
        task.kind === EXPLOIT_SEARCH_KERNEL ||
        task.kind === IMAGE_TILE_INFER_KERNEL ||
        task.kind === MICROSCOPY_TILE_SCORE_KERNEL ||
        task.kind === PUBLIC_ARTIFACT_KERNEL ||
        task.kind === REPLAY_VERIFY_KERNEL
      ) &&
      receipt.executionMode !== "cpu"
    ) {
      throw new Error(`${receipt.receiptId} execution mode was ${receipt.executionMode}`);
    }
  }
}

function aggregatePasses(passes) {
  const receipts = passes.flatMap((pass) => pass.receipts);
  return {
    taskKinds: unique(passes.map((pass) => pass.taskKind)),
    tasks: passes.map((pass) => pass.taskId),
    validations: passes.map((pass) => pass.validationId),
    receipts: receipts.map((receipt) => receipt.receiptId),
    transportSet: unique(receipts.map((receipt) => receipt.transport)),
    validationModeSet: unique(receipts.map((receipt) => receipt.validationMode)),
    transferSet: unique(receipts.map((receipt) => receipt.transcript?.transfer)),
    relaySet: unique(receipts.map((receipt) => receipt.transcript?.iceRelayBucket ?? "unknown")),
    pageErrors: passes.reduce((sum, pass) =>
      sum + pass.pageErrors.reduce((count, errors) => count + errors.length, 0), 0),
    acceptAssignments: passes.every((pass) => pass.acceptAssignments === false) ? false : "mixed",
  };
}

function expectedTierForKernel(kernel) {
  if (kernel === "tensor-tile" || kernel === "contact-map-tile") return "webgpu-light";
  return "cpu-light";
}

function kernelOption() {
  const value = argValue("kernel") || process.env.PLASMA_LAB_SMOKE_KERNEL || "public-artifact";
  if (
    value !== "public-artifact" &&
    value !== "replay-verify" &&
    value !== "seed-sweep" &&
    value !== "image-tile-infer" &&
    value !== "microscopy-tile-score" &&
    value !== "exploit-search" &&
    value !== "asset-tile-audit" &&
    value !== "tensor-tile" &&
    value !== "contact-map-tile"
  ) {
    throw new Error(
      "kernel must be public-artifact, replay-verify, seed-sweep, image-tile-infer, microscopy-tile-score, exploit-search, asset-tile-audit, tensor-tile, or contact-map-tile",
    );
  }
  return value;
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value !== undefined))).sort();
}

function integerOption(argName, envName, fallback, min, max) {
  const raw = argValue(argName) || process.env[envName] || "";
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${argName} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function argValue(name) {
  const flag = `--${name}`;
  const prefix = `${flag}=`;
  const exactIndex = process.argv.indexOf(flag);
  if (exactIndex !== -1) return process.argv[exactIndex + 1] || "";
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : "";
}

async function setAssignments(config, acceptAssignments, durationMs) {
  return adminPost(config, "/compute/admin/assignments", {
    acceptAssignments,
    ...(acceptAssignments && durationMs ? { durationMs } : {}),
  });
}

async function disableAssignments(config) {
  let last = await setAssignments(config, false);
  for (let i = 0; i < 8; i++) {
    const status = await getJson(config.computeOrigin, "/compute/status");
    last = status;
    if (status.acceptAssignments === false) return status;
    await delay(500);
  }
  throw new Error(`assignment intake remained enabled: ${JSON.stringify(last)}`);
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
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
