#!/usr/bin/env node
"use strict";

const { createHash, randomUUID } = require("node:crypto");

const DEFAULT_GAME_ORIGIN = "https://m3t4.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 120_000;

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
  if (seeded.chunks !== 1) throw new Error(`expected 1 chunk, got ${seeded.chunks}`);

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

    await setAssignments(config, true);
    const startedAt = Date.now();
    await Promise.all(pages.map((page) =>
      page.evaluate(() => window.__M3T4_COMPUTE_CLIENT__?.poll())
    ));
    const accepted = await waitForAcceptedTask(config, seeded.taskId);
    const elapsedMs = Date.now() - startedAt;
    const finalStatus = await setAssignments(config, false);

    const validation = accepted.validation;
    const receipts = await Promise.all(validation.acceptedReceiptIds.map((id) =>
      adminGet(config, `/compute/admin/receipts/${encodeURIComponent(id)}`)
    ));
    const snapshots = await Promise.all(pages.map((page) => page.evaluate(() => window.m3t4Compute.status())));
    await Promise.all(pages.map((page) => page.evaluate(() => window.m3t4Compute.stop()).catch(() => undefined)));
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
    await browser.close();
    browser = null;

    assertWebRtcArtifactReceipts(receipts, accepted.task.chunks?.[0]);
    if (finalStatus.acceptAssignments) throw new Error("assignment intake remained enabled");

    console.log(JSON.stringify({
      ok: true,
      computeOrigin: config.computeOrigin,
      gameOrigin: config.gameOrigin,
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
  const matchId = `webrtc-client-artifact-${Date.now()}`;
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
  });
}

async function prepareStaffPage(page, config, label) {
  await page.goto(`${config.gameOrigin}/#about`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return page.evaluate(async ({ computeOrigin, label }) => {
    window.__M3T4_COMPUTE_LAB_ORIGIN__ = computeOrigin;
    window.__M3T4_COMPUTE_SLACK_WORKER__ = true;
    window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ = true;
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

function assertWebRtcArtifactReceipts(receipts, chunk) {
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
  }
}

async function setAssignments(config, acceptAssignments) {
  return adminPost(config, "/compute/admin/assignments", { acceptAssignments });
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
