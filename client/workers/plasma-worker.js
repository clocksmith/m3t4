import { BEHAVIOR_VERSION, REPLAY_CONSTANTS_HASH, replayArtifactToResultV1, simulate, stableReplayJson, STAGES, STRATEGIES } from "../sim/index.js";

// Plasma compute worker. Runs deterministic kernels off the main
// thread so the spectator render loop stays smooth.
//
// Protocol (main ↔ worker):
//   { type: "run", assignmentId, chunk: { chunkId, kind, params } }
//   → { type: "done", assignmentId, chunkId, outputHash, computeMs }
//   → { type: "error", assignmentId, chunkId, message }
//   { type: "probe", probeId }
//   → { type: "probe", probeId, result }
//
// All kernels produce little-endian byte outputs and the worker hashes
// them with Web Crypto so the server can verify bit-for-bit.

const EMBEDDING_TILE_KERNEL = "ml.embedding_tile.v0";
const PREFILL_TOPK_PROBE_KERNEL = "ml.prefill_topk_probe.v0";
const CONTACT_MAP_TILE_KERNEL = "science.contact_map_tile.v0";
const EMBEDDING_TILE_MODEL = "google-embeddinggemma-300m-q4k-ehf16-af32";
const PREFILL_TOPK_PROBE_MODEL = "gemma-3-270m-it-q4k-ehf16-af32";
const EMBEDDING_TILE_SCORE_SCALE = 1000;
const DOPPLER_GENERATION_URL = new URL("../vendor/doppler/src/generation/index.js", import.meta.url).href;
const DOPPLER_REGISTRY_URL = new URL("../vendor/doppler/src/client/doppler-registry.js", import.meta.url).href;
const DOPPLER_MODEL_SOURCE_URL = new URL("../vendor/doppler/src/client/runtime/model-source.js", import.meta.url).href;
const DOPPLER_STORAGE_URL = new URL("../vendor/doppler/src/storage/artifact-storage-context.js", import.meta.url).href;

let dopplerModulesPromise = null;
const dopplerPipelineCache = new Map();
const CONTACT_RESIDUES = "ACDEFGHIKLMNPQRSTVWYX";
const CONTACT_HYDROPHOBICITY = [1, 2, 0, 0, 3, 0, 1, 4, 0, 4, 3, 0, 0, 0, 0, 0, 1, 3, 3, 2, 0];
const CONTACT_CHARGE = [0, 0, -1, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
const CONTACT_AROMATIC = [0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0];
const CONTACT_POLAR = [0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0];
const CONTACT_CYS_INDEX = 1;
const CONTACT_GLY_INDEX = 5;
const CONTACT_PRO_INDEX = 12;
const CONTACT_UNKNOWN_INDEX = 20;

const KERNELS = {
  "prime-search.v0": (params) => {
    const start = asInt(params.start);
    const endExclusive = asInt(params.endExclusive);
    if (endExclusive <= start) return new Uint8Array();
    const primes = [];
    for (let n = start; n < endExclusive; n++) if (isPrime(n)) primes.push(n);
    const out = new Uint8Array(primes.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < primes.length; i++) view.setUint32(i * 4, primes[i], true);
    return out;
  },
  "m3t4.public_artifact_verify.v0": (params) => {
    if (typeof params.artifactJson !== "string" || params.artifactJson.length === 0) {
      throw new Error("artifactJson required");
    }
    return new TextEncoder().encode(params.artifactJson);
  },
  "m3t4.replay_verify.v1": runReplayVerify,
  "m3t4.seed_sweep.v0": runSeedSweep,
  [EMBEDDING_TILE_KERNEL]: runEmbeddingTile,
  [PREFILL_TOPK_PROBE_KERNEL]: runPrefillTopkProbe,
  [CONTACT_MAP_TILE_KERNEL]: runContactMapTile,
  "plasma.tensor_tile.v0": runTensorTile,
  "device_witness.webgpu.v0": runDeviceWitnessWebGpu,
  "device_witness.render_fixture.v0": () => canvas2dFixtureBytes(),
  "device_witness.derived_buffer.v0": runDeviceWitnessDerivedBuffer,
};

async function hashHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === "probe") {
    self.postMessage({ type: "probe", probeId: msg.probeId, result: await runDeviceWitnessProbe() });
    return;
  }
  if (msg.type !== "run") return;
  const { assignmentId, chunk } = msg;
  const kernel = KERNELS[chunk?.kind];
  if (!kernel) {
    self.postMessage({ type: "error", assignmentId, chunkId: chunk?.chunkId, message: `unknown kernel: ${chunk?.kind}` });
    return;
  }
  const t0 = performance.now();
  try {
    const result = await kernel(chunk.params);
    const bytes = result instanceof Uint8Array ? result : result.bytes;
    const outputHash = await hashHex(bytes);
    const computeMs = performance.now() - t0;
    self.postMessage({
      type: "done",
      assignmentId,
      chunkId: chunk.chunkId,
      kernelId: chunk.kernelId,
      kernelHash: chunk.kernelHash,
      inputHash: chunk.inputHash,
      artifactHash: chunk.artifactHash,
      outputHash,
      derived: result?.derived,
      computeMs,
      executionMode: result?.executionMode || (chunk.kind === "device_witness.webgpu.v0" ? "webgpu" : "cpu"),
    });
  } catch (e) {
    self.postMessage({ type: "error", assignmentId, chunkId: chunk.chunkId, message: String(e?.message ?? e) });
  }
};

async function runDeviceWitnessProbe() {
  const result = { workerFixture: "ok" };
  Object.assign(result, canvas2dFixtureProbe());
  return result;
}

function canvas2dFixtureProbe() {
  const t0 = performance.now();
  try {
    const bytes = canvas2dFixtureBytes();
    const red = Array.from(bytes.slice(0, 4));
    const green = Array.from(bytes.slice(4, 8));
    const mixed = Array.from(bytes.slice(8, 12));
    const blackBlue = Array.from(bytes.slice(12, 16));
    const ok =
      close(red, [128, 0, 0, 255], 2) &&
      close(green, [0, 255, 0, 255], 2) &&
      close(mixed, [96, 0, 64, 255], 6) &&
      close(blackBlue, [0, 0, 64, 255], 6);
    return {
      canvas2dFixture: ok ? "ok" : "mismatch",
      canvas2dFixtureMsBucket: bucketMs(performance.now() - t0),
      canvas2dAlphaBucket: close(mixed, [96, 0, 64, 255], 6) ? "ok" : "drift",
    };
  } catch {
    return { canvas2dFixture: "failed", canvas2dFixtureMsBucket: "failed" };
  }
}

function canvas2dFixtureBytes() {
  if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas unavailable");
  const canvas = new OffscreenCanvas(8, 8);
  const ctx = canvas.getContext("2d", {
    alpha: true,
    colorSpace: "srgb",
    willReadFrequently: true,
  }) || canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.clearRect(0, 0, 8, 8);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 8, 8);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(255,0,0,0.5)";
  ctx.fillRect(0, 0, 4, 8);
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(4, 0, 4, 4);
  ctx.fillStyle = "rgba(0,0,255,0.25)";
  ctx.fillRect(0, 4, 8, 4);
  const data = ctx.getImageData(0, 0, 8, 8).data;
  return new Uint8Array([
    ...pixel(data, 1, 1),
    ...pixel(data, 5, 1),
    ...pixel(data, 1, 5),
    ...pixel(data, 5, 5),
  ]);
}

async function runEmbeddingTile(params) {
  if (!navigator.gpu?.requestAdapter) throw new Error("WebGPU unavailable");
  const spec = normalizeEmbeddingTileParams(params);
  const pipeline = await getDopplerPipeline(spec.modelId);
  const queryEmbedding = await embedText(pipeline, spec.queryText, "query", spec.modelId);
  const docs = [];
  for (let docIndex = 0; docIndex < spec.documents.length; docIndex++) {
    const embedding = await embedText(pipeline, spec.documents[docIndex], "document", spec.modelId);
    const score = cosineSimilarity(queryEmbedding, embedding);
    docs.push({
      docIndex,
      scoreQ: quantizeEmbeddingScore(score),
    });
  }
  docs.sort((a, b) => b.scoreQ - a.scoreQ || a.docIndex - b.docIndex);
  const topHits = docs.slice(0, spec.topK);
  const bytes = new TextEncoder().encode(stableJson({
    kind: EMBEDDING_TILE_KERNEL,
    modelId: spec.modelId,
    queryHash: await hashText(spec.queryText),
    documentsHash: await hashText(stableJson(spec.documents)),
    documentCount: spec.documents.length,
    topK: spec.topK,
    scoreScale: EMBEDDING_TILE_SCORE_SCALE,
    hits: topHits,
  }));
  return { bytes, executionMode: "webgpu" };
}

async function runPrefillTopkProbe(params) {
  if (!navigator.gpu?.requestAdapter) throw new Error("WebGPU unavailable");
  const spec = normalizePrefillTopkProbeParams(params);
  const pipeline = await getDopplerPipeline(spec.modelId);
  pipeline.reset?.();
  const prefill = await pipeline.prefillWithLogits(spec.promptText, {
    temperature: 0,
    topK: 1,
    topP: 1,
  });
  const logits = prefill?.logits;
  const inputTokens = Array.isArray(prefill?.tokens) ? prefill.tokens : [];
  if (!(logits instanceof Float32Array) || logits.length === 0) {
    throw new Error("prefill logits missing");
  }
  const hits = topKTokenIds(logits, spec.topK).map((tokenId, rank) => ({ rank: rank + 1, tokenId }));
  const bytes = new TextEncoder().encode(stableJson({
    kind: PREFILL_TOPK_PROBE_KERNEL,
    modelId: spec.modelId,
    promptHash: await hashText(spec.promptText),
    promptLength: spec.promptText.length,
    prefillTokenCount: inputTokens.length,
    topK: spec.topK,
    hits,
  }));
  return { bytes, executionMode: "webgpu" };
}

async function runContactMapTile(params) {
  if (!navigator.gpu?.requestAdapter) throw new Error("WebGPU unavailable");
  const spec = normalizeContactMapTileParams(params);
  const rowCodes = new Uint32Array(encodeContactResidues(spec.rowResidues));
  const colCodes = new Uint32Array(encodeContactResidues(spec.colResidues));
  let device = null;
  let rowBuffer = null;
  let colBuffer = null;
  let outBuffer = null;
  let readBuffer = null;
  try {
    const adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: "low-power" }), 1000);
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    device = await withTimeout(adapter.requestDevice(), 1200);
    if (!device) throw new Error("WebGPU device unavailable");

    const outputBytes = rowCodes.length * colCodes.length * 4;
    rowBuffer = device.createBuffer({
      size: rowCodes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    colBuffer = device.createBuffer({
      size: colCodes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    outBuffer = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    readBuffer = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(rowBuffer, 0, rowCodes);
    device.queue.writeBuffer(colBuffer, 0, colCodes);

    const module = device.createShaderModule({
      code: `
const ROWS: u32 = ${spec.rowResidues.length}u;
const COLS: u32 = ${spec.colResidues.length}u;
const ROW_START: u32 = ${spec.rowStart}u;
const COL_START: u32 = ${spec.colStart}u;
const MIN_SEPARATION: i32 = ${spec.minSeparation};

const HYDRO: array<i32, 21> = array<i32, 21>(1, 2, 0, 0, 3, 0, 1, 4, 0, 4, 3, 0, 0, 0, 0, 0, 1, 3, 3, 2, 0);
const CHARGE: array<i32, 21> = array<i32, 21>(0, 0, -1, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
const AROMATIC: array<i32, 21> = array<i32, 21>(0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0);
const POLAR: array<i32, 21> = array<i32, 21>(0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0);

@group(0) @binding(0) var<storage, read> row_codes: array<u32>;
@group(0) @binding(1) var<storage, read> col_codes: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;

fn separation_bonus(separation: i32) -> i32 {
  if (separation < 12) { return 8; }
  if (separation < 24) { return 18; }
  if (separation < 64) { return 12; }
  return 6;
}

fn contact_score(a: u32, b: u32, row_pos: u32, col_pos: u32) -> u32 {
  let separation = abs(i32(row_pos) - i32(col_pos));
  if (separation < MIN_SEPARATION) { return 0u; }
  let hydro_sum = HYDRO[a] + HYDRO[b];
  var score: i32 = 12;
  if (hydro_sum >= 4) { score = score + ((hydro_sum - 3) * 24); }
  if (AROMATIC[a] == 1 && AROMATIC[b] == 1) { score = score + 40; }
  if (POLAR[a] == 1 && POLAR[b] == 1) { score = score + 10; }
  let charge_a = CHARGE[a];
  let charge_b = CHARGE[b];
  if (charge_a != 0 && charge_b != 0) {
    if ((charge_a + charge_b) == 0) { score = score + 34; }
    else if (charge_a == charge_b) { score = score - 22; }
  }
  if (a == ${CONTACT_CYS_INDEX}u && b == ${CONTACT_CYS_INDEX}u) { score = score + 52; }
  if (a == ${CONTACT_GLY_INDEX}u || a == ${CONTACT_PRO_INDEX}u || b == ${CONTACT_GLY_INDEX}u || b == ${CONTACT_PRO_INDEX}u) { score = score - 8; }
  if (a == ${CONTACT_UNKNOWN_INDEX}u || b == ${CONTACT_UNKNOWN_INDEX}u) { score = score - 14; }
  score = score + separation_bonus(separation);
  if (score < 0) { return 0u; }
  return u32(score);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let col = id.x;
  let row = id.y;
  if (row >= ROWS || col >= COLS) { return; }
  out[row * COLS + col] = contact_score(
    row_codes[row],
    col_codes[col],
    ROW_START + row,
    COL_START + col,
  );
}`,
    });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: rowBuffer } },
        { binding: 1, resource: { buffer: colBuffer } },
        { binding: 2, resource: { buffer: outBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(spec.colResidues.length / 8), Math.ceil(spec.rowResidues.length / 8));
    pass.end();
    encoder.copyBufferToBuffer(outBuffer, 0, readBuffer, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await withTimeout(device.queue.onSubmittedWorkDone(), 1500);
    await withTimeout(readBuffer.mapAsync(GPUMapMode.READ), 800);
    const bytes = new Uint8Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    return { bytes, executionMode: "webgpu" };
  } finally {
    try { rowBuffer?.destroy?.(); } catch {}
    try { colBuffer?.destroy?.(); } catch {}
    try { outBuffer?.destroy?.(); } catch {}
    try { readBuffer?.destroy?.(); } catch {}
    try { device?.destroy?.(); } catch {}
  }
}

async function getDopplerPipeline(modelId) {
  const key = String(modelId || "").trim();
  if (!key) throw new Error("embedding modelId required");
  if (!dopplerPipelineCache.has(key)) {
    dopplerPipelineCache.set(key, (async () => {
      const modules = await loadDopplerModules();
      const entry = await modules.resolveQuickstartModel(key);
      const baseUrl = modules.buildQuickstartModelBaseUrl(entry);
      const manifestPayload = await modules.fetchManifestPayloadFromBaseUrl(baseUrl);
      const resolved = await modules.resolveManifestArtifactSource({
        modelId: key,
        baseUrl,
        manifest: null,
        trace: [],
      }, manifestPayload);
      const storage = modules.createHttpArtifactStorageContext(
        resolved.storageBaseUrl ?? resolved.baseUrl,
        resolved.storageManifest ?? resolved.manifest,
      );
      await storage.preflight?.();
      return modules.createPipeline(resolved.manifest, {
        baseUrl: resolved.storageBaseUrl ?? resolved.baseUrl,
        storage,
      });
    })().catch((error) => {
      dopplerPipelineCache.delete(key);
      throw error;
    }));
  }
  return dopplerPipelineCache.get(key);
}

async function loadDopplerModules() {
  if (!dopplerModulesPromise) {
    dopplerModulesPromise = Promise.all([
      import(DOPPLER_GENERATION_URL),
      import(DOPPLER_REGISTRY_URL),
      import(DOPPLER_MODEL_SOURCE_URL),
      import(DOPPLER_STORAGE_URL),
    ]).then(([generation, registry, modelSource, storage]) => ({
      createPipeline: generation.createPipeline,
      resolveQuickstartModel: registry.resolveQuickstartModel,
      buildQuickstartModelBaseUrl: registry.buildQuickstartModelBaseUrl,
      fetchManifestPayloadFromBaseUrl: modelSource.fetchManifestPayloadFromBaseUrl,
      resolveManifestArtifactSource: modelSource.resolveManifestArtifactSource,
      createHttpArtifactStorageContext: storage.createHttpArtifactStorageContext,
    })).catch((error) => {
      dopplerModulesPromise = null;
      throw new Error(
        `Doppler vendor runtime unavailable: ${error?.message || error}. ` +
        "Run `npm run sync:doppler:client` before enabling embedding tiles."
      );
    });
  }
  return dopplerModulesPromise;
}

async function embedText(pipeline, text, kind, modelId) {
  pipeline.reset?.();
  const formatted = formatEmbeddingText(text, kind, modelId);
  const result = await pipeline.embed(formatted);
  const embedding = result?.embedding;
  if (!embedding || !Number.isFinite(embedding.length) || embedding.length <= 0) {
    throw new Error("embedding output missing");
  }
  return embedding;
}

function formatEmbeddingText(text, kind, modelId) {
  if (String(modelId || "").includes("embeddinggemma")) {
    if (kind === "query") return `task: search result | query: ${text}`;
    if (kind === "document") return `title: None | text: ${text}`;
  }
  return text;
}

function runReplayVerify(params) {
  if (typeof params.replayArtifactJson !== "string" || params.replayArtifactJson.length === 0) {
    throw new Error("replayArtifactJson required");
  }
  if (params.replayArtifactJson.length > 1024 * 1024) throw new Error("replayArtifactJson too large");
  const artifact = JSON.parse(params.replayArtifactJson);
  if (!artifact || artifact.schema !== "m3t4.replay" || artifact.version !== 1) {
    throw new Error("replay artifact v1 required");
  }
  if (Array.isArray(artifact.players) && artifact.players.some((player) => player?.config !== undefined)) {
    throw new Error("private player config is not allowed in replay verify tasks");
  }
  const decoded = replayArtifactToResultV1(artifact, {
    allowConstantsMismatch: params.allowConstantsMismatch === true,
  });
  return new TextEncoder().encode(stableReplayJson({
    kind: "m3t4.replay_verify.v1",
    matchId: artifact.match.matchId,
    mode: artifact.match.mode,
    stageId: artifact.match.stageId,
    seed: artifact.match.seed,
    actionLogHash: artifact.actions.hash,
    actionLogSha256: artifact.actions.sha256,
    simConstantsHash: artifact.sim.constantsHash,
    behaviorVersion: artifact.trust?.behaviorVersion,
    consumedDecisionTicks: decoded.consumedDecisionTicks,
    result: decoded.result,
  }));
}

function runSeedSweep(params) {
  const stageId = String(params.stageId || "");
  const brainAName = String(params.brainA || "");
  const brainBName = String(params.brainB || "");
  const seedStart = asInt(params.seedStart);
  const seedEndExclusive = asInt(params.seedEndExclusive);
  const maxTicks = params.maxTicks === undefined ? undefined : asInt(params.maxTicks);
  if (params.simConstantsHash !== undefined && params.simConstantsHash !== REPLAY_CONSTANTS_HASH) {
    throw new Error("simConstantsHash mismatch");
  }
  if (params.behaviorVersion !== undefined && asInt(params.behaviorVersion) !== BEHAVIOR_VERSION) {
    throw new Error("behaviorVersion mismatch");
  }
  if (!STAGES[stageId]) throw new Error(`unknown public stage: ${stageId}`);
  if (!STRATEGIES[brainAName]) throw new Error(`unknown public brainA preset: ${brainAName}`);
  if (!STRATEGIES[brainBName]) throw new Error(`unknown public brainB preset: ${brainBName}`);
  if (seedEndExclusive <= seedStart) throw new Error("seedEndExclusive must be greater than seedStart");
  if (seedEndExclusive - seedStart > 64) throw new Error("seed sweep chunks are capped at 64 seeds");
  const results = [];
  for (let seed = seedStart; seed < seedEndExclusive; seed++) {
    const result = simulate({
      stage: STAGES[stageId],
      brainA: STRATEGIES[brainAName],
      brainB: STRATEGIES[brainBName],
      seed,
      maxTicks,
    });
    results.push({
      seed,
      winner: result.winner,
      finalScore: result.finalScore,
      finalRounds: result.finalRounds,
      ticks: result.ticks,
      logHash: result.logHash,
    });
  }
  const summary = {
    kind: "m3t4.seed_sweep.v0",
    stageId,
    brainA: brainAName,
    brainB: brainBName,
    seedStart,
    seedEndExclusive,
    maxTicks,
    aggregate: {
      seeds: results.length,
      winsA: results.filter((result) => result.winner === 0).length,
      winsB: results.filter((result) => result.winner === 1).length,
      draws: results.filter((result) => result.winner === -1).length,
      avgTicks: results.length
        ? Math.round(results.reduce((sum, result) => sum + result.ticks, 0) / results.length)
        : 0,
    },
    results,
  };
  return new TextEncoder().encode(stableReplayJson(summary));
}

async function runDeviceWitnessWebGpu(params) {
  if (!navigator.gpu?.requestAdapter) throw new Error("WebGPU unavailable");
  const seed = asInt(params.seed);
  const count = asInt(params.count);
  if (count <= 0 || count > 4096) throw new Error("count must be 1..4096");
  let device = null;
  let buffer = null;
  let readBuffer = null;
  try {
    const adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: "low-power" }), 1000);
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    device = await withTimeout(adapter.requestDevice(), 1200);
    if (!device) throw new Error("WebGPU device unavailable");
    const input = new Uint32Array(count);
    for (let i = 0; i < count; i++) input[i] = witnessInput(seed, i);
    buffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    readBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, input);
    const module = device.createShaderModule({
      code: `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&data)) { return; }
  let x = data[id.x];
  let y = x ^ ((x >> 16u) + (id.x * 2246822519u));
  data[id.x] = y * 1664525u + 1013904223u;
}`,
    });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, readBuffer, 0, count * 4);
    device.queue.submit([encoder.finish()]);
    await withTimeout(device.queue.onSubmittedWorkDone(), 1500);
    await withTimeout(readBuffer.mapAsync(GPUMapMode.READ), 800);
    const out = new Uint8Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    return out;
  } finally {
    try { buffer?.destroy?.(); } catch {}
    try { readBuffer?.destroy?.(); } catch {}
    try { device?.destroy?.(); } catch {}
  }
}

async function runTensorTile(params) {
  if (!navigator.gpu?.requestAdapter) throw new Error("WebGPU unavailable");
  const spec = normalizeTensorTileParams(params);
  let device = null;
  let aBuffer = null;
  let bBuffer = null;
  let outBuffer = null;
  let readBuffer = null;
  try {
    const adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: "low-power" }), 1000);
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    device = await withTimeout(adapter.requestDevice(), 1200);
    if (!device) throw new Error("WebGPU device unavailable");

    const a = new Uint32Array(spec.rows * spec.depth);
    const b = new Uint32Array(spec.depth * spec.cols);
    for (let row = 0; row < spec.rows; row++) {
      for (let d = 0; d < spec.depth; d++) a[row * spec.depth + d] = tensorInputA(spec.seed, row, d);
    }
    for (let d = 0; d < spec.depth; d++) {
      for (let col = 0; col < spec.cols; col++) b[d * spec.cols + col] = tensorInputB(spec.seed, d, col);
    }

    const outputBytes = spec.rows * spec.cols * 4;
    aBuffer = device.createBuffer({
      size: a.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    bBuffer = device.createBuffer({
      size: b.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    outBuffer = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    readBuffer = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(aBuffer, 0, a);
    device.queue.writeBuffer(bBuffer, 0, b);

    const module = device.createShaderModule({
      code: `
const ROWS: u32 = ${spec.rows}u;
const COLS: u32 = ${spec.cols}u;
const DEPTH: u32 = ${spec.depth}u;

@group(0) @binding(0) var<storage, read> a: array<u32>;
@group(0) @binding(1) var<storage, read> b: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let col = id.x;
  let row = id.y;
  if (row >= ROWS || col >= COLS) { return; }
  var acc: u32 = 0u;
  var d: u32 = 0u;
  loop {
    if (d >= DEPTH) { break; }
    let av = a[row * DEPTH + d] & 255u;
    let bv = b[d * COLS + col] & 255u;
    acc = acc + (av * bv) + ((row + 1u) * 17u) + ((col + 1u) * 31u) + d;
    d = d + 1u;
  }
  out[row * COLS + col] = acc;
}`,
    });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: aBuffer } },
        { binding: 1, resource: { buffer: bBuffer } },
        { binding: 2, resource: { buffer: outBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(spec.cols / 8), Math.ceil(spec.rows / 8));
    pass.end();
    encoder.copyBufferToBuffer(outBuffer, 0, readBuffer, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await withTimeout(device.queue.onSubmittedWorkDone(), 1500);
    await withTimeout(readBuffer.mapAsync(GPUMapMode.READ), 800);
    const bytes = new Uint8Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    return { bytes, executionMode: "webgpu" };
  } finally {
    try { aBuffer?.destroy?.(); } catch {}
    try { bBuffer?.destroy?.(); } catch {}
    try { outBuffer?.destroy?.(); } catch {}
    try { readBuffer?.destroy?.(); } catch {}
    try { device?.destroy?.(); } catch {}
  }
}

function runDeviceWitnessDerivedBuffer(params) {
  const seed = asInt(params.seed);
  const count = asInt(params.count);
  if (count <= 0 || count > 4096) throw new Error("count must be 1..4096");
  const sourceBytes = new Uint8Array(count * 4);
  const outputBytes = new Uint8Array(count * 4);
  const sourceView = new DataView(sourceBytes.buffer);
  const outputView = new DataView(outputBytes.buffer);
  for (let i = 0; i < count; i++) {
    const x = witnessInput(seed, i);
    sourceView.setUint32(i * 4, x, true);
    outputView.setUint32(i * 4, (witnessTransform(x, i) ^ 0xa5a5a5a5) >>> 0, true);
  }
  return hashHex(sourceBytes).then((sourceHash) => hashHex(outputBytes).then((outputHash) => ({
    bytes: outputBytes,
    derived: {
      contractVersion: "derived-compute-extension.v0",
      sourceHashes: { [String(params.sourceId || "synthetic-frame")]: { algorithm: "sha256", value: sourceHash } },
      bufferRegionHashes: { [String(params.regionId || "synthetic-u32-region")]: { algorithm: "sha256", value: sourceHash } },
      producerKernelHashes: {
        [String(params.outputId || "synthetic-derived-u32")]: {
          algorithm: "sha256",
          value: String(params.producerKernelHash || ""),
        },
      },
      outputHashes: { [String(params.outputId || "synthetic-derived-u32")]: { algorithm: "sha256", value: outputHash } },
      derivedOutputHash: { algorithm: "sha256", value: outputHash },
    },
  })));
}

function witnessInput(seed, index) {
  return (Math.imul(seed >>> 0, 747796405) + Math.imul(index >>> 0, 2891336453) + 1013904223) >>> 0;
}

function normalizeTensorTileParams(params) {
  const seed = asInt(params.seed);
  const rows = asInt(params.rows);
  const cols = asInt(params.cols);
  const depth = asInt(params.depth);
  if (rows <= 0 || rows > 64) throw new Error("rows must be 1..64");
  if (cols <= 0 || cols > 64) throw new Error("cols must be 1..64");
  if (depth <= 0 || depth > 256) throw new Error("depth must be 1..256");
  if (rows * cols > 4096) throw new Error("tensor tile output is capped at 4096 cells");
  if (rows * depth > 16384 || depth * cols > 16384) throw new Error("tensor tile input is capped at 16384 cells per side");
  return { seed, rows, cols, depth };
}

function tensorInputA(seed, row, depthIndex) {
  return mix32((seed ^ Math.imul(row + 1, 0x9e3779b1) ^ Math.imul(depthIndex + 1, 0x85ebca77)) >>> 0);
}

function tensorInputB(seed, depthIndex, col) {
  return mix32(((seed + 0x6d2b79f5) ^ Math.imul(depthIndex + 1, 0xc2b2ae3d) ^ Math.imul(col + 1, 0x27d4eb2f)) >>> 0);
}

function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function witnessTransform(x, index) {
  const y = (x ^ ((x >>> 16) + Math.imul(index >>> 0, 2246822519))) >>> 0;
  return (Math.imul(y, 1664525) + 1013904223) >>> 0;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function pixel(data, x, y) {
  const i = (y * 8 + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

function close(actual, expected, tolerance) {
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tolerance) return false;
  }
  return true;
}

function bucketMs(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 2) return "<2ms";
  if (ms < 5) return "2-5ms";
  if (ms < 10) return "5-10ms";
  if (ms < 20) return "10-20ms";
  if (ms < 50) return "20-50ms";
  return "50ms+";
}

function normalizeContactMapTileParams(params) {
  const rowResidues = normalizeResiduesParam(params.rowResidues, "rowResidues");
  const colResidues = normalizeResiduesParam(params.colResidues, "colResidues");
  const rowStart = asInt(params.rowStart);
  const colStart = asInt(params.colStart);
  const minSeparation = asInt(params.minSeparation);
  if (minSeparation > 256) throw new Error("minSeparation must be 0..256");
  if (rowResidues.length * colResidues.length > 4096) {
    throw new Error("contact map tile output is capped at 4096 cells");
  }
  return { rowResidues, colResidues, rowStart, colStart, minSeparation };
}

function normalizeResiduesParam(value, label) {
  const text = String(value ?? "").trim().toUpperCase();
  if (text.length < 1 || text.length > 64) throw new Error(`${label} must be 1..64 residues`);
  for (const residue of text) {
    if (!CONTACT_RESIDUES.includes(residue)) throw new Error(`${label} contains unsupported residue "${residue}"`);
  }
  return text;
}

function encodeContactResidues(text) {
  return Array.from(text, (residue) => {
    const index = CONTACT_RESIDUES.indexOf(residue);
    if (index < 0) throw new Error(`unsupported residue "${residue}"`);
    return index;
  });
}

function normalizePrefillTopkProbeParams(params) {
  const modelId = String(params.modelId || PREFILL_TOPK_PROBE_MODEL).trim();
  if (modelId !== PREFILL_TOPK_PROBE_MODEL) {
    throw new Error(`unsupported prefill probe model: ${modelId}`);
  }
  const promptText = normalizeTextParam(params.promptText, "promptText", 1, 1024);
  const topK = asInt(params.topK ?? 4);
  if (topK < 1 || topK > 8) throw new Error("topK must be 1..8");
  return { modelId, promptText, topK };
}

function normalizeEmbeddingTileParams(params) {
  const modelId = String(params.modelId || EMBEDDING_TILE_MODEL).trim();
  if (modelId !== EMBEDDING_TILE_MODEL) {
    throw new Error(`unsupported embedding model: ${modelId}`);
  }
  const queryText = normalizeTextParam(params.queryText, "queryText", 1, 2048);
  if (typeof params.documentsJson !== "string" || params.documentsJson.length === 0 || params.documentsJson.length > 16 * 1024) {
    throw new Error("documentsJson required");
  }
  let documents = null;
  try { documents = JSON.parse(params.documentsJson); } catch {}
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 16) {
    throw new Error("embedding tile requires 1..16 documents");
  }
  documents = documents.map((value) => normalizeTextParam(value, "document", 1, 2048));
  const topK = asInt(params.topK);
  if (topK < 1 || topK > Math.min(8, documents.length)) {
    throw new Error("topK must be 1..min(8, documents.length)");
  }
  return { modelId, queryText, documents, topK };
}

function normalizeTextParam(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be ${min}..${max} chars`);
  }
  return text;
}

function quantizeEmbeddingScore(value) {
  if (!Number.isFinite(value)) throw new Error("non-finite embedding score");
  return Math.max(-EMBEDDING_TILE_SCORE_SCALE, Math.min(
    EMBEDDING_TILE_SCORE_SCALE,
    Math.round(value * EMBEDDING_TILE_SCORE_SCALE),
  ));
}

function cosineSimilarity(a, b) {
  if (!a || !b || !Number.isFinite(a.length) || !Number.isFinite(b.length) || a.length !== b.length || a.length === 0) {
    throw new Error("embedding vectors incompatible");
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) throw new Error("embedding vector contained non-finite values");
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA <= 0 || normB <= 0) throw new Error("embedding norm invalid");
  return dot / Math.sqrt(normA * normB);
}

function topKTokenIds(logits, topK) {
  const best = [];
  for (let tokenId = 0; tokenId < logits.length; tokenId++) {
    const logit = Number(logits[tokenId]);
    if (!Number.isFinite(logit)) continue;
    const entry = { tokenId, logit };
    let inserted = false;
    for (let i = 0; i < best.length; i++) {
      const current = best[i];
      if (logit > current.logit || (logit === current.logit && tokenId < current.tokenId)) {
        best.splice(i, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted && best.length < topK) best.push(entry);
    if (best.length > topK) best.length = topK;
  }
  if (best.length === 0) throw new Error("no finite logits");
  return best.map((entry) => entry.tokenId);
}

function stableJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortJsonValue(value[key]);
  return out;
}

async function hashText(value) {
  return hashHex(new TextEncoder().encode(String(value ?? "")));
}

function asInt(v) {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid integer param: ${v}`);
  }
  return n;
}

function isPrime(n) {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0) return false;
  const limit = Math.floor(Math.sqrt(n));
  for (let d = 3; d <= limit; d += 2) if (n % d === 0) return false;
  return true;
}
