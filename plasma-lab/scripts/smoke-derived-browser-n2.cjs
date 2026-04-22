#!/usr/bin/env node
"use strict";

const { randomUUID } = require("node:crypto");

const CLIENT_VERSION = "smoke-derived-browser-n2-v1";
const DEFAULT_GAME_ORIGIN = "https://m3t4.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const WORKER_TIMEOUT_MS = 20_000;

async function main() {
  const { chromium } = loadPlaywright();
  const config = readConfig();

  const initialStatus = await getJson(config.computeOrigin, "/compute/status");
  if (initialStatus.acceptAssignments) {
    throw new Error("assignment intake is already enabled; refusing to run a controlled smoke");
  }

  const seeded = await adminPost(config, "/compute/admin/tasks/device-witness-derived-buffer", {
    seed: config.seed,
    count: config.count,
    minExecutions: 2,
    minAgreeing: 2,
  });
  if (seeded.chunks !== 1) throw new Error(`expected 1 chunk, got ${seeded.chunks}`);

  let browser;
  try {
    await setAssignments(config, true);
    browser = await chromium.launch({ headless: config.headless });
    const [a, b] = await Promise.all([
      runBrowserWorker(browser, config, "A", seeded.taskId),
      runBrowserWorker(browser, config, "B", seeded.taskId),
    ]);

    const task = await adminGet(config, `/compute/admin/tasks/${encodeURIComponent(seeded.taskId)}`);
    const receipts = await Promise.all([
      adminGet(config, `/compute/admin/receipts/${encodeURIComponent(a.receiptId)}`),
      adminGet(config, `/compute/admin/receipts/${encodeURIComponent(b.receiptId)}`),
    ]);
    const finalStatus = await setAssignments(config, false);
    const validation = [a, b]
      .map((result) => result.receiptResponse?.validation)
      .find((candidate) => candidate?.status === "accepted");

    assertFinalState({ task, receipts, validation, finalStatus });

    console.log(JSON.stringify({
      ok: true,
      computeOrigin: config.computeOrigin,
      gameOrigin: config.gameOrigin,
      taskId: seeded.taskId,
      chunkId: task.chunks[0]?.chunkId,
      validationId: validation?.validationId,
      taskStatus: task.status,
      chunkStatus: task.chunks[0]?.status,
      acceptAssignments: finalStatus.acceptAssignments,
      initialDecisions: [a.initialDecision, b.initialDecision],
      receipts: receipts.map((receipt, index) => ({
        label: index === 0 ? "A" : "B",
        workerId: receipt.workerId,
        receiptId: receipt.receiptId,
        decision: receipt.decision,
        outputHash: receipt.outputHash?.value,
        evidence: derivedEvidenceSummary(receipt, task),
      })),
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
  } catch (error) {
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
    seed: intEnv("PLASMA_LAB_SMOKE_SEED", 260422),
    count: intEnv("PLASMA_LAB_SMOKE_COUNT", 16),
    headless: process.env.PLASMA_LAB_SMOKE_HEADLESS !== "0",
  };
}

async function runBrowserWorker(browser, config, label, taskId) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(message(error)));
  try {
    await page.goto(`${config.gameOrigin}/#build`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await page.evaluate(async ({ computeOrigin, label, taskId, clientVersion, workerTimeoutMs }) => {
      const capability = {
        kernels: ["device_witness.derived_buffer.v0"],
        runtimeSurfaces: ["browser-js", "cpu-reference"],
        maxChunkBytes: 1024 * 1024,
        maxConcurrentChunks: 1,
        deviceClass: "smoke-browser",
        adapterInfo: { smoke: "derived-browser-n2", label },
        clientVersion,
      };
      const registered = await post("/compute/workers/register", { label: `derived-smoke-${label}`, capability });
      const sessionHeaders = { "x-worker-session-token": registered.workerSessionToken };
      const nextPath = `/compute/tasks/next?workerId=${encodeURIComponent(registered.workerId)}&workerSessionId=${encodeURIComponent(registered.workerSessionId)}`;
      const next = await get(nextPath, sessionHeaders);
      if (next.idle) throw new Error(`received idle assignment: ${next.reason || "unknown"}`);
      if (next.task?.taskId !== taskId) {
        throw new Error(`received unexpected task ${next.task?.taskId || "missing"}; expected ${taskId}`);
      }
      await post("/compute/assignments/accept", {
        workerId: registered.workerId,
        workerSessionId: registered.workerSessionId,
        workerSessionToken: registered.workerSessionToken,
        assignmentId: next.assignment.assignmentId,
        assignmentToken: next.assignment.assignmentToken,
      });

      const workerPath = `/workers/plasma-worker.js?smoke-derived-n2=${encodeURIComponent(label)}-${Date.now()}`;
      const worker = new Worker(new URL(workerPath, location.origin), { type: "module" });
      const workerMessage = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("browser worker timed out"));
        }, workerTimeoutMs);
        worker.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message || "browser worker failed"));
        };
        worker.postMessage({ type: "run", assignmentId: next.assignment.assignmentId, chunk: next.chunk });
      });
      worker.terminate();
      if (workerMessage.type === "error") throw new Error(workerMessage.message || "worker returned error");

      const receipt = {
        workerId: registered.workerId,
        workerSessionId: registered.workerSessionId,
        workerSessionToken: registered.workerSessionToken,
        assignmentId: next.assignment.assignmentId,
        assignmentToken: next.assignment.assignmentToken,
        taskId: next.task.taskId,
        chunkId: next.chunk.chunkId,
        kernelId: workerMessage.kernelId,
        kernelHash: workerMessage.kernelHash,
        inputHash: workerMessage.inputHash,
        artifactHash: workerMessage.artifactHash,
        outputHash: { algorithm: "sha256", value: workerMessage.outputHash },
        derived: workerMessage.derived,
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        executionMode: workerMessage.executionMode || "cpu",
        transport: "http",
        governorMode: "quiet",
        deviceClass: "smoke-browser",
        adapterInfo: { smoke: "derived-browser-n2", label },
        computeMs: workerMessage.computeMs,
        clientVersion,
      };
      const receiptResponse = await post("/compute/receipts", receipt);
      return {
        label,
        workerId: registered.workerId,
        assignmentId: next.assignment.assignmentId,
        chunkId: next.chunk.chunkId,
        outputHash: workerMessage.outputHash,
        receiptId: receiptResponse.receipt?.receiptId,
        initialDecision: receiptResponse.receipt?.decision,
        receiptResponse,
      };

      async function get(path, headers = {}) {
        const response = await fetch(computeOrigin + path, { headers });
        return parseResponse(response, path);
      }

      async function post(path, body) {
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
    }, {
      computeOrigin: config.computeOrigin,
      label,
      taskId,
      clientVersion: CLIENT_VERSION,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
    });
  } catch (error) {
    if (pageErrors.length) {
      throw new Error(`${label} failed: ${message(error)}; page errors: ${pageErrors.join(" | ")}`);
    }
    throw new Error(`${label} failed: ${message(error)}`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

function assertFinalState({ task, receipts, validation, finalStatus }) {
  const chunk = task.chunks?.[0];
  if (!chunk) throw new Error("final task is missing chunk 0");
  if (finalStatus.acceptAssignments !== false) throw new Error("assignment intake remained enabled");
  if (task.status !== "complete") throw new Error(`task status was ${task.status}`);
  if (chunk.status !== "accepted") throw new Error(`chunk status was ${chunk.status}`);
  if (!validation || validation.status !== "accepted") throw new Error("missing accepted validation");
  for (const receipt of receipts) {
    if (receipt.decision !== "accepted") throw new Error(`${receipt.receiptId} decision was ${receipt.decision}`);
    const evidence = derivedEvidenceSummary(receipt, task);
    for (const [key, value] of Object.entries(evidence)) {
      if (value !== true) throw new Error(`${receipt.receiptId} failed evidence check ${key}`);
    }
  }
}

function derivedEvidenceSummary(receipt, task) {
  const chunk = task.chunks?.[0] || {};
  const params = chunk.params || {};
  const derived = receipt.derived || {};
  const sourceId = String(params.sourceId || "synthetic-frame");
  const regionId = String(params.regionId || "synthetic-u32-region");
  const outputId = String(params.outputId || "synthetic-derived-u32");
  const outputHash = receipt.outputHash?.value;
  const sourceHash = derived.sourceHashes?.[sourceId]?.value;
  const bufferRegionHash = derived.bufferRegionHashes?.[regionId]?.value;
  const producerKernelHash = derived.producerKernelHashes?.[outputId]?.value;
  const outputMapHash = derived.outputHashes?.[outputId]?.value;
  const derivedOutputHash = derived.derivedOutputHash?.value;
  return {
    sourceHashPresent: typeof sourceHash === "string" && sourceHash.length > 0,
    bufferRegionHashPresent: typeof bufferRegionHash === "string" && bufferRegionHash.length > 0,
    producerKernelHashPresent: typeof producerKernelHash === "string" && producerKernelHash.length > 0,
    outputHashPresent: typeof outputHash === "string" && outputHash.length > 0,
    derivedOutputHashPresent: typeof derivedOutputHash === "string" && derivedOutputHash.length > 0,
    sourceHashMatches: sourceHash === params.sourceHash,
    bufferRegionHashMatches: bufferRegionHash === params.regionHash,
    producerKernelHashMatches: producerKernelHash === params.producerKernelHash,
    outputHashMatches: outputHash === outputMapHash && outputHash === chunk.expectedOutputHash?.value,
    derivedOutputHashMatches: derivedOutputHash === outputHash,
  };
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

function cleanOrigin(value) {
  return String(value || "").replace(/\/+$/, "");
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
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
