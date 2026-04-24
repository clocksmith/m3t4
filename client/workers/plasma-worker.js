import { BEHAVIOR_VERSION, REPLAY_CONSTANTS_HASH, evaluateReciprocalSideBias, replayArtifactToResultV1, simulate, stableReplayJson, STAGES, STRATEGIES } from "../sim/index.js";
import { buildTilePreview } from "../lib/tile-preview.js";

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

const ASSET_TILE_AUDIT_KERNEL = "asset.tile_audit.v0";
const IMAGE_TILE_INFER_KERNEL = "ml.image_tile_infer.v0";
const CONTACT_MAP_TILE_KERNEL = "science.contact_map_tile.v0";
const MANDELBROT_TILE_KERNEL = "science.mandelbrot_tile.v0";
const GENOME_KMER_KERNEL = "science.genome_kmer.v0";
const GENOME_KMER_ALPHABET = "ACGT";
const MICROSCOPY_TILE_SCORE_KERNEL = "science.microscopy_tile_score.v0";
const EXPLOIT_SEARCH_KERNEL = "m3t4.exploit_search.v0";
const IMAGE_TILE_INFER_MODEL = "tile-linear-v1";
const MAX_TILE_DIM = 96;
const MAX_TILE_PIXELS = MAX_TILE_DIM * MAX_TILE_DIM;
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
  [ASSET_TILE_AUDIT_KERNEL]: runAssetTileAudit,
  [IMAGE_TILE_INFER_KERNEL]: runImageTileInfer,
  [CONTACT_MAP_TILE_KERNEL]: runContactMapTile,
  [MANDELBROT_TILE_KERNEL]: runMandelbrotTile,
  [GENOME_KMER_KERNEL]: runGenomeKmer,
  [MICROSCOPY_TILE_SCORE_KERNEL]: runMicroscopyTileScore,
  [EXPLOIT_SEARCH_KERNEL]: runExploitSearch,
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
  if (msg.type === "prepare") {
    try {
      const details = await prepareKernel(msg.kind, msg.params);
      self.postMessage({
        type: "prepared",
        prepareId: msg.prepareId,
        kind: msg.kind,
        details,
      });
    } catch (e) {
      self.postMessage({
        type: "prepare-error",
        prepareId: msg.prepareId,
        kind: msg.kind,
        message: errorMessage(e),
        details: workerErrorDetails(e),
      });
    }
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
      publicOutput: result?.publicOutput,
      preview: result?.preview,
      computeMs,
      executionMode: result?.executionMode || (chunk.kind === "device_witness.webgpu.v0" ? "webgpu" : "cpu"),
    });
  } catch (e) {
    self.postMessage({
      type: "error",
      assignmentId,
      chunkId: chunk.chunkId,
      message: errorMessage(e),
      details: workerErrorDetails(e),
    });
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

async function prepareKernel(kind, params = {}) {
  throw new Error(`unsupported warm kernel: ${kind}`);
}

function runGenomeKmer(params) {
  const spec = normalizeGenomeKmerParams(params);
  const histogramSize = 1 << (2 * spec.k);
  const bytes = new Uint8Array(histogramSize * 4);
  const view = new DataView(bytes.buffer);
  const windowCount = spec.sequence.length - spec.k + 1;
  for (let start = 0; start < windowCount; start++) {
    let index = 0;
    for (let offset = 0; offset < spec.k; offset++) {
      const code = GENOME_KMER_ALPHABET.indexOf(spec.sequence[start + offset]);
      index = (index << 2) | code;
    }
    const position = index * 4;
    const current = view.getUint32(position, true);
    view.setUint32(position, (current + 1) >>> 0, true);
  }
  return { bytes, executionMode: "cpu" };
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
    const preview = await buildTilePreview({
      outputU32: new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      widthPx: spec.colResidues.length,
      heightPx: spec.rowResidues.length,
    });
    return { bytes, executionMode: "webgpu", preview: preview ?? undefined };
  } finally {
    try { rowBuffer?.destroy?.(); } catch {}
    try { colBuffer?.destroy?.(); } catch {}
    try { outBuffer?.destroy?.(); } catch {}
    try { readBuffer?.destroy?.(); } catch {}
    try { device?.destroy?.(); } catch {}
  }
}

// Mandelbrot escape-count tile, Q8.8 fixed-point, bit-exact with the
// plasma-lab CPU reference. Pixel-center selection, the iteration loop,
// and all multiplications are integer-only so i32 WGSL arithmetic matches
// V8 integer arithmetic cell for cell.
async function runMandelbrotTile(params) {
  if (!navigator.gpu?.requestAdapter) throw new Error("WebGPU unavailable");
  const spec = normalizeMandelbrotTileParams(params);
  const totalPixels = spec.widthPx * spec.heightPx;
  let device = null;
  let outBuffer = null;
  let readBuffer = null;
  try {
    const adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: "low-power" }), 1000);
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    device = await withTimeout(adapter.requestDevice(), 1200);
    if (!device) throw new Error("WebGPU device unavailable");
    const byteLength = totalPixels * 4;
    outBuffer = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    readBuffer = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const module = device.createShaderModule({
      code: `
const WIDTH: i32 = ${spec.widthPx};
const HEIGHT: i32 = ${spec.heightPx};
const MIN_X: i32 = ${spec.minXQ88};
const MAX_X: i32 = ${spec.maxXQ88};
const MIN_Y: i32 = ${spec.minYQ88};
const MAX_Y: i32 = ${spec.maxYQ88};
const MAX_ITER: i32 = ${spec.maxIter};
const Q_SHIFT: u32 = 8u;
const ESCAPE_SQ_Q88: i32 = 0x400; // 4 << 8

@group(0) @binding(0) var<storage, read_write> out: array<u32>;

fn mul_q(a: i32, b: i32) -> i32 {
  return (a * b) >> Q_SHIFT;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let px = i32(gid.x);
  let py = i32(gid.y);
  if (px >= WIDTH || py >= HEIGHT) { return; }
  let range_x = MAX_X - MIN_X;
  let range_y = MAX_Y - MIN_Y;
  let cx = MIN_X + (range_x * (2 * px + 1)) / (WIDTH * 2);
  let cy = MIN_Y + (range_y * (2 * py + 1)) / (HEIGHT * 2);
  var x: i32 = 0;
  var y: i32 = 0;
  var escape: i32 = MAX_ITER;
  for (var i: i32 = 0; i < MAX_ITER; i = i + 1) {
    let x2 = mul_q(x, x);
    let y2 = mul_q(y, y);
    if (x2 + y2 > ESCAPE_SQ_Q88) { escape = i; break; }
    let xy = mul_q(x, y);
    y = (xy << 1) + cy;
    x = x2 - y2 + cx;
  }
  out[py * WIDTH + px] = u32(escape);
}
`,
    });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: outBuffer } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(spec.widthPx / 8), Math.ceil(spec.heightPx / 8));
    pass.end();
    encoder.copyBufferToBuffer(outBuffer, 0, readBuffer, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await withTimeout(device.queue.onSubmittedWorkDone(), 1500);
    await withTimeout(readBuffer.mapAsync(GPUMapMode.READ), 800);
    const bytes = new Uint8Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    const preview = await buildTilePreview({
      outputU32: new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      widthPx: spec.widthPx,
      heightPx: spec.heightPx,
    });
    return { bytes, executionMode: "webgpu", preview: preview ?? undefined };
  } finally {
    try { outBuffer?.destroy?.(); } catch {}
    try { readBuffer?.destroy?.(); } catch {}
    try { device?.destroy?.(); } catch {}
  }
}

function normalizeMandelbrotTileParams(params) {
  const widthPx = assertInt(params.widthPx, "widthPx", 1, 256);
  const heightPx = assertInt(params.heightPx, "heightPx", 1, 256);
  if (widthPx * heightPx > 64 * 64) throw new Error("mandelbrot tile capped at 4096 pixels");
  const coordCap = 2 << 8;
  const minXQ88 = assertInt(params.minXQ88, "minXQ88", -coordCap, coordCap);
  const maxXQ88 = assertInt(params.maxXQ88, "maxXQ88", -coordCap, coordCap);
  const minYQ88 = assertInt(params.minYQ88, "minYQ88", -coordCap, coordCap);
  const maxYQ88 = assertInt(params.maxYQ88, "maxYQ88", -coordCap, coordCap);
  if (maxXQ88 <= minXQ88) throw new Error("maxXQ88 must exceed minXQ88");
  if (maxYQ88 <= minYQ88) throw new Error("maxYQ88 must exceed minYQ88");
  const maxIter = assertInt(params.maxIter, "maxIter", 1, 255);
  return { widthPx, heightPx, minXQ88, maxXQ88, minYQ88, maxYQ88, maxIter };
}

function assertInt(value, label, lo, hi) {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(`${label} must be integer in [${lo}, ${hi}]`);
  }
  return n;
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

function runAssetTileAudit(params) {
  const spec = normalizeRgbaTileParams(params);
  const bytes = decodeRgbaBase64(spec);
  const analysis = analyzeRgbaTile(bytes, spec.width, spec.height);
  const bleedRiskQ = clampQ(
    (analysis.edgeTouchMask !== 0 ? 260 : 0) +
    analysis.fringeAlphaQ * 0.42 +
    Math.max(0, 220 - Math.min(
      analysis.alphaRect.x0,
      analysis.alphaRect.y0,
      spec.width - analysis.alphaRect.x1,
      spec.height - analysis.alphaRect.y1,
    )) * 2
  );
  const recommendedPadPx = analysis.blank ? 0 : bleedRiskQ >= 700 ? 2 : bleedRiskQ >= 380 ? 1 : 0;
  return new TextEncoder().encode(stableJson({
    kind: ASSET_TILE_AUDIT_KERNEL,
    sourceId: spec.sourceId,
    width: spec.width,
    height: spec.height,
    blank: analysis.blank,
    trimRect: [analysis.alphaRect.x0, analysis.alphaRect.y0, analysis.alphaRect.x1, analysis.alphaRect.y1],
    alphaCoverageQ: analysis.activeCoverageQ,
    fringeAlphaQ: analysis.fringeAlphaQ,
    bleedRiskQ,
    edgeTouchMask: analysis.edgeTouchMask,
    quantizedColorCount: analysis.quantizedColorCount,
    dominantColors: analysis.dominantColors,
    recommendedPadPx,
  }));
}

function runImageTileInfer(params) {
  const spec = normalizeImageTileInferParamsLowBandwidth(params);
  const bytes = decodeRgbaBase64(spec);
  const analysis = analyzeRgbaTile(bytes, spec.width, spec.height);
  const midCoverageQ = 1000 - Math.min(1000, Math.abs(analysis.activeCoverageQ - 520) * 2);
  const edgeTouchPenalty = analysis.edgeTouchMask === 0 ? 0 : 80;
  const scores = {
    sprite: clampQ(120 + midCoverageQ * 0.34 + analysis.saturationQ * 0.24 + analysis.contrastQ * 0.18 + analysis.symmetryQ * 0.12 - analysis.textStrokeQ * 0.12 - edgeTouchPenalty),
    ui: clampQ(120 + analysis.textStrokeQ * 0.32 + analysis.flatnessQ * 0.28 + analysis.edgeDensityQ * 0.18 + (analysis.edgeTouchMask !== 0 ? 120 : 20) + (analysis.activeCoverageQ > 760 ? 80 : 0) - analysis.saturationQ * 0.08),
    terrain: clampQ(120 + analysis.activeCoverageQ * 0.22 + analysis.entropyQ * 0.28 + analysis.edgeDensityQ * 0.16 + (analysis.edgeTouchMask !== 0 ? 70 : 0) - analysis.symmetryQ * 0.1),
    text: clampQ(110 + analysis.textStrokeQ * 0.42 + analysis.contrastQ * 0.24 + analysis.flatnessQ * 0.16 + (analysis.activeCoverageQ < 720 ? 90 : 0) - analysis.saturationQ * 0.14),
    effect: clampQ(110 + (1000 - analysis.activeCoverageQ) * 0.24 + analysis.saturationQ * 0.36 + analysis.contrastQ * 0.18 + Math.max(analysis.warmRatioQ, analysis.coolRatioQ) * 0.12),
    portrait: clampQ(100 + analysis.warmRatioQ * 0.26 + analysis.symmetryQ * 0.24 + midCoverageQ * 0.16 + (analysis.activeCoverageQ > 220 && analysis.activeCoverageQ < 940 ? 90 : 0)),
    other: clampQ(100 + analysis.entropyQ * 0.12 + analysis.saturationQ * 0.12 + analysis.contrastQ * 0.1),
  };
  const topLabels = Object.entries(scores)
    .map(([label, scoreQ]) => ({ label, scoreQ }))
    .sort((a, b) => b.scoreQ - a.scoreQ || a.label.localeCompare(b.label))
    .slice(0, spec.topK);
  return new TextEncoder().encode(stableJson({
    kind: IMAGE_TILE_INFER_KERNEL,
    modelId: IMAGE_TILE_INFER_MODEL,
    sourceId: spec.sourceId,
    width: spec.width,
    height: spec.height,
    topK: spec.topK,
    alphaRect: [analysis.alphaRect.x0, analysis.alphaRect.y0, analysis.alphaRect.x1, analysis.alphaRect.y1],
    featureQ: {
      activeCoverageQ: analysis.activeCoverageQ,
      edgeDensityQ: analysis.edgeDensityQ,
      contrastQ: analysis.contrastQ,
      saturationQ: analysis.saturationQ,
      textStrokeQ: analysis.textStrokeQ,
      symmetryQ: analysis.symmetryQ,
      warmRatioQ: analysis.warmRatioQ,
      coolRatioQ: analysis.coolRatioQ,
      flatnessQ: analysis.flatnessQ,
    },
    topLabels,
  }));
}

function runMicroscopyTileScore(params) {
  const spec = normalizeRgbaTileParams(params);
  const bytes = decodeRgbaBase64(spec);
  const analysis = analyzeRgbaTile(bytes, spec.width, spec.height);
  const focusQ = clampQ(analysis.edgeDensityQ * 0.5 + analysis.contrastQ * 0.25 + analysis.granularityQ * 0.25);
  const cellularityQ = clampQ(
    analysis.purpleDensityQ * 0.38 +
    analysis.darkDensityQ * 0.24 +
    analysis.granularityQ * 0.18 +
    analysis.activeCoverageQ * 0.1 +
    analysis.pinkDensityQ * 0.1
  );
  const stainBalanceQ = clampQ(1000 - Math.abs(analysis.purpleDensityQ - analysis.pinkDensityQ));
  const artifactQ = clampQ(
    (analysis.edgeTouchMask !== 0 ? 220 : 0) +
    analysis.fringeAlphaQ * 0.32 +
    (1000 - focusQ) * 0.16 +
    Math.max(0, analysis.saturationQ - 760) * 0.18 +
    Math.max(0, Math.abs(analysis.activeCoverageQ - 820) - 120) * 0.2
  );
  const anomalyQ = clampQ(artifactQ * 0.36 + Math.max(0, cellularityQ - 680) * 0.28 + (1000 - stainBalanceQ) * 0.2 + (1000 - focusQ) * 0.16);
  const label = artifactQ >= 620 ? "artifact-heavy" : cellularityQ >= 620 ? "cell-dense" : cellularityQ <= 260 ? "sparse-field" : "mixed-field";
  return new TextEncoder().encode(stableJson({
    kind: MICROSCOPY_TILE_SCORE_KERNEL,
    sourceId: spec.sourceId,
    width: spec.width,
    height: spec.height,
    label,
    alphaRect: [analysis.alphaRect.x0, analysis.alphaRect.y0, analysis.alphaRect.x1, analysis.alphaRect.y1],
    scoreQ: {
      focusQ,
      cellularityQ,
      stainBalanceQ,
      artifactQ,
      anomalyQ,
      purpleDensityQ: analysis.purpleDensityQ,
      pinkDensityQ: analysis.pinkDensityQ,
      darkDensityQ: analysis.darkDensityQ,
      granularityQ: analysis.granularityQ,
    },
  }));
}

function runExploitSearch(params) {
  const spec = normalizeExploitSearchParams(params);
  const stage = STAGES[spec.stageId];
  const brainA = STRATEGIES[spec.brainA];
  const brainB = STRATEGIES[spec.brainB];
  const findings = [];
  const seeds = [];
  let timeoutDraws = 0;
  let stallHeavyCount = 0;
  let clashLoopCount = 0;
  let escapeSpiralCount = 0;
  let objectiveThrashCount = 0;
  let totalTicks = 0;
  for (let seed = spec.seedStart; seed < spec.seedEndExclusive; seed++) {
    seeds.push(seed >>> 0);
    const result = simulate({
      stage,
      brainA,
      brainB,
      seed,
      maxTicks: spec.maxTicks,
      telemetry: true,
    });
    totalTicks += result.ticks;
    const telemetry = result.telemetry || [emptyTelemetry(), emptyTelemetry()];
    const issue = exploitIssueForSeed(result, telemetry, spec.maxTicks);
    if (issue.flags.includes("timeout-draw")) timeoutDraws++;
    if (issue.flags.includes("stall-heavy")) stallHeavyCount++;
    if (issue.flags.includes("clash-loop")) clashLoopCount++;
    if (issue.flags.includes("escape-spiral")) escapeSpiralCount++;
    if (issue.flags.includes("objective-thrash")) objectiveThrashCount++;
    if (issue.flags.length > 0) {
      findings.push({
        seed,
        winner: result.winner,
        ticks: result.ticks,
        severityQ: issue.severityQ,
        flags: issue.flags,
        stallQ: issue.stallQ,
        clashLoopQ: issue.clashLoopQ,
        escapeSpiralQ: issue.escapeSpiralQ,
        objectiveThrashQ: issue.objectiveThrashQ,
      });
    }
  }
  const reciprocal = evaluateReciprocalSideBias({ stage, brainA, brainB, seeds });
  findings.sort((a, b) => b.severityQ - a.severityQ || a.seed - b.seed);
  return new TextEncoder().encode(stableJson({
    kind: EXPLOIT_SEARCH_KERNEL,
    stageId: spec.stageId,
    brainA: spec.brainA,
    brainB: spec.brainB,
    seedStart: spec.seedStart,
    seedEndExclusive: spec.seedEndExclusive,
    maxTicks: spec.maxTicks,
    behaviorVersion: BEHAVIOR_VERSION,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    summary: {
      sweptSeeds: seeds.length,
      flaggedSeeds: findings.length,
      timeoutDraws,
      stallHeavyCount,
      clashLoopCount,
      escapeSpiralCount,
      objectiveThrashCount,
      reciprocalSideBiasQ: clampQ(Math.abs(reciprocal.sideBias) * 1000),
      reciprocalDisagreements: reciprocal.reciprocalDisagreements,
      avgTickUsageQ: clampQ((totalTicks / Math.max(1, seeds.length * spec.maxTicks)) * 1000),
    },
    findings: findings.slice(0, spec.topFindings),
  }));
}

function exploitIssueForSeed(result, telemetry, maxTicks) {
  const [a, b] = telemetry;
  const totalDecisionTicks = Math.max(1, a.ticks + b.ticks);
  const timeoutDraw = result.winner === -1 && result.ticks >= maxTicks;
  const zoneEscapeTicks = a.modeTicks.zone + a.modeTicks.escape + b.modeTicks.zone + b.modeTicks.escape;
  const zoneEscapeQ = clampQ((zoneEscapeTicks / totalDecisionTicks) * 1000);
  const clashes = a.clashes + b.clashes;
  const attacks = a.swipes + a.dives + b.swipes + b.dives;
  const deliveries = a.deliveries + b.deliveries;
  const deliveryCancels = a.deliveryCancels + b.deliveryCancels;
  const escapeEntries = a.escapeEntries + b.escapeEntries;
  const clashRateQ = clampQ((clashes / Math.max(1, totalDecisionTicks / 8)) * 1000);
  const attackRateQ = clampQ((attacks / Math.max(1, totalDecisionTicks / 6)) * 1000);
  const objectiveThrashQ = clampQ(deliveryCancels * 90 + (deliveries === 0 ? 120 : 0));
  const stallQ = clampQ(zoneEscapeQ * 0.55 + (timeoutDraw ? 240 : 0) + Math.max(0, 320 - attackRateQ) * 0.45);
  const clashLoopQ = clampQ(clashRateQ * 0.62 + Math.max(0, 380 - attackRateQ) * 0.34 + (timeoutDraw ? 140 : 0));
  const escapeSpiralQ = clampQ(zoneEscapeQ * 0.72 + escapeEntries * 22 + (timeoutDraw ? 90 : 0));
  const flags = [];
  if (timeoutDraw) flags.push("timeout-draw");
  if (stallQ >= 620) flags.push("stall-heavy");
  if (clashLoopQ >= 560) flags.push("clash-loop");
  if (escapeSpiralQ >= 620) flags.push("escape-spiral");
  if (objectiveThrashQ >= 520) flags.push("objective-thrash");
  return {
    flags,
    severityQ: Math.max(timeoutDraw ? 680 : 0, stallQ, clashLoopQ, escapeSpiralQ, objectiveThrashQ),
    stallQ,
    clashLoopQ,
    escapeSpiralQ,
    objectiveThrashQ,
  };
}

function emptyTelemetry() {
  return {
    modeTicks: { neutral: 0, offense: 0, zone: 0, objective: 0, escape: 0 },
    substateTicks: { press: 0, bait: 0, punish: 0, deliver: 0, intercept: 0, pickup: 0 },
    modeSwitches: 0,
    zoneEntries: 0,
    objectiveEntries: 0,
    escapeEntries: 0,
    swipes: 0,
    dives: 0,
    kills: 0,
    deaths: 0,
    clashes: 0,
    deliveries: 0,
    deliveryCancels: 0,
    deliveryFeintCancels: 0,
    deliveryKillFirstCancels: 0,
    ticks: 0,
    modeSwipes: { neutral: 0, offense: 0, zone: 0, objective: 0, escape: 0 },
    modeDives: { neutral: 0, offense: 0, zone: 0, objective: 0, escape: 0 },
    modeClashes: { neutral: 0, offense: 0, zone: 0, objective: 0, escape: 0 },
  };
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

function normalizeRgbaTileParams(params) {
  const sourceId = normalizeTextParam(params.sourceId ?? "tile", "sourceId", 1, 120);
  const width = asInt(params.width);
  const height = asInt(params.height);
  if (width < 1 || width > MAX_TILE_DIM) throw new Error(`width must be 1..${MAX_TILE_DIM}`);
  if (height < 1 || height > MAX_TILE_DIM) throw new Error(`height must be 1..${MAX_TILE_DIM}`);
  if (width * height > MAX_TILE_PIXELS) throw new Error(`tile area must be <= ${MAX_TILE_PIXELS} pixels`);
  const rgbaBase64 = normalizeTextParam(params.rgbaBase64, "rgbaBase64", 1, 200000);
  const bytes = decodeRgbaBase64({ width, height, rgbaBase64 });
  if (bytes.length !== width * height * 4) throw new Error("rgbaBase64 byte length mismatch");
  return { sourceId, width, height, rgbaBase64 };
}

function normalizeImageTileInferParamsLowBandwidth(params) {
  const tile = normalizeRgbaTileParams(params);
  const topK = asInt(params.topK ?? 3);
  if (topK < 1 || topK > 4) throw new Error("topK must be 1..4");
  return { ...tile, topK };
}

function normalizeExploitSearchParams(params) {
  const stageId = normalizeTextParam(params.stageId, "stageId", 1, 64);
  const brainA = normalizeTextParam(params.brainA, "brainA", 1, 64);
  const brainB = normalizeTextParam(params.brainB, "brainB", 1, 64);
  const seedStart = asInt(params.seedStart);
  const seedEndExclusive = asInt(params.seedEndExclusive);
  const maxTicks = asInt(params.maxTicks ?? 5400);
  const topFindings = asInt(params.topFindings ?? 8);
  if (!STAGES[stageId]) throw new Error(`unknown public stage: ${stageId}`);
  if (!STRATEGIES[brainA]) throw new Error(`unknown public preset brainA: ${brainA}`);
  if (!STRATEGIES[brainB]) throw new Error(`unknown public preset brainB: ${brainB}`);
  if (seedEndExclusive <= seedStart) throw new Error("seedEndExclusive must be greater than seedStart");
  if (seedEndExclusive - seedStart > 32) throw new Error("exploit search is capped at 32 seeds per chunk");
  if (maxTicks < 600 || maxTicks > 20000) throw new Error("maxTicks must be 600..20000");
  if (topFindings < 1 || topFindings > 16) throw new Error("topFindings must be 1..16");
  return { stageId, brainA, brainB, seedStart, seedEndExclusive, maxTicks, topFindings };
}

function decodeRgbaBase64(params) {
  const text = String(params.rgbaBase64 || "");
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (out.length !== params.width * params.height * 4) {
    throw new Error("rgbaBase64 must decode to width*height*4 bytes");
  }
  return out;
}

function analyzeRgbaTile(bytes, width, height) {
  if (bytes.length !== width * height * 4) throw new Error("rgba byte length mismatch");
  const totalPixels = width * height;
  const activeMask = new Uint8Array(totalPixels);
  const lumaValues = new Uint8Array(totalPixels);
  const lumaHist = new Array(16).fill(0);
  const colorCounts = new Map();
  let activePixels = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let satSum = 0;
  let warmPixels = 0;
  let coolPixels = 0;
  let purplePixels = 0;
  let pinkPixels = 0;
  let darkPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let edgeTouchMask = 0;
  let fringeAlphaSum = 0;
  let fringeAlphaCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    const o = i * 4;
    const r = bytes[o];
    const g = bytes[o + 1];
    const b = bytes[o + 2];
    const a = bytes[o + 3];
    const x = i % width;
    const y = Math.floor(i / width);
    const luma = rgbLuma(r, g, b);
    lumaValues[i] = luma;
    const active = a >= 24 ? 1 : 0;
    activeMask[i] = active;
    if (!active) continue;
    activePixels++;
    lumaSum += luma;
    lumaSqSum += luma * luma;
    lumaHist[Math.min(15, Math.floor((luma / 256) * 16))]++;
    satSum += channelRange(r, g, b);
    if (isWarmPixel(r, g, b)) warmPixels++;
    if (isCoolPixel(r, g, b)) coolPixels++;
    if (isPurplePixel(r, g, b)) purplePixels++;
    if (isPinkPixel(r, g, b)) pinkPixels++;
    if (luma < 90) darkPixels++;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (x === 0) edgeTouchMask |= 8;
    if (x === width - 1) edgeTouchMask |= 2;
    if (y === 0) edgeTouchMask |= 1;
    if (y === height - 1) edgeTouchMask |= 4;
    if ((x === 0 || x === width - 1 || y === 0 || y === height - 1) && a > 0 && a < 255) {
      fringeAlphaSum += a;
      fringeAlphaCount++;
    }
    const color = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
  }
  if (activePixels === 0) {
    return {
      blank: true,
      activePixels: 0,
      totalPixels,
      activeCoverageQ: 0,
      meanLumaQ: 0,
      contrastQ: 0,
      saturationQ: 0,
      edgeDensityQ: 0,
      entropyQ: 0,
      symmetryQ: 0,
      textStrokeQ: 0,
      flatnessQ: 1000,
      warmRatioQ: 0,
      coolRatioQ: 0,
      purpleDensityQ: 0,
      pinkDensityQ: 0,
      darkDensityQ: 0,
      granularityQ: 0,
      fringeAlphaQ: 0,
      edgeTouchMask: 0,
      alphaRect: { x0: 0, y0: 0, x1: 0, y1: 0, width: 0, height: 0 },
      dominantColors: [],
      quantizedColorCount: 0,
    };
  }
  let edgeSum = 0;
  let edgeCount = 0;
  let textTransitions = 0;
  let granularSum = 0;
  let granularCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!activeMask[i]) continue;
      const center = lumaValues[i];
      if (x + 1 < width && activeMask[i + 1]) {
        const diff = Math.abs(center - lumaValues[i + 1]);
        edgeSum += diff;
        edgeCount++;
        if (diff >= 120) textTransitions++;
      }
      if (y + 1 < height && activeMask[i + width]) {
        const diff = Math.abs(center - lumaValues[i + width]);
        edgeSum += diff;
        edgeCount++;
        if (diff >= 120) textTransitions++;
      }
      if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
        const left = lumaValues[i - 1];
        const right = lumaValues[i + 1];
        const up = lumaValues[i - width];
        const down = lumaValues[i + width];
        granularSum += Math.abs(left - right) + Math.abs(up - down);
        granularCount += 2;
      }
    }
  }
  let symmetryDiff = 0;
  let symmetryCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < Math.floor(width / 2); x++) {
      const i = y * width + x;
      const j = y * width + (width - 1 - x);
      if (!activeMask[i] && !activeMask[j]) continue;
      symmetryCount++;
      symmetryDiff += Math.abs((activeMask[i] ? 255 : 0) - (activeMask[j] ? 255 : 0)) + Math.abs(lumaValues[i] - lumaValues[j]);
    }
  }
  const meanLuma = lumaSum / activePixels;
  const variance = Math.max(0, lumaSqSum / activePixels - meanLuma * meanLuma);
  const edgeDensityQ = clampQ((edgeCount > 0 ? edgeSum / (edgeCount * 255) : 0) * 1000);
  const entropyQ = clampQ((entropyFromHistogram(lumaHist, activePixels) / Math.log2(16)) * 1000);
  const symmetryQ = clampQ(1000 - Math.round((symmetryDiff / Math.max(1, symmetryCount * 510)) * 1000));
  const flatnessQ = clampQ(1000 - Math.round((entropyQ * 0.65) + (edgeDensityQ * 0.35)));
  return {
    blank: false,
    activePixels,
    totalPixels,
    activeCoverageQ: clampQ((activePixels / totalPixels) * 1000),
    meanLumaQ: clampQ((meanLuma / 255) * 1000),
    contrastQ: clampQ((Math.sqrt(variance) / 128) * 1000),
    saturationQ: clampQ((satSum / (activePixels * 255)) * 1000),
    edgeDensityQ,
    entropyQ,
    symmetryQ,
    textStrokeQ: clampQ((textTransitions / Math.max(1, activePixels)) * 1000),
    flatnessQ,
    warmRatioQ: clampQ((warmPixels / activePixels) * 1000),
    coolRatioQ: clampQ((coolPixels / activePixels) * 1000),
    purpleDensityQ: clampQ((purplePixels / activePixels) * 1000),
    pinkDensityQ: clampQ((pinkPixels / activePixels) * 1000),
    darkDensityQ: clampQ((darkPixels / activePixels) * 1000),
    granularityQ: clampQ((granularCount > 0 ? granularSum / (granularCount * 255) : 0) * 1000),
    fringeAlphaQ: fringeAlphaCount > 0 ? clampQ((fringeAlphaSum / (fringeAlphaCount * 255)) * 1000) : 0,
    edgeTouchMask,
    alphaRect: { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1, width: maxX - minX + 1, height: maxY - minY + 1 },
    dominantColors: dominantColorList(colorCounts, 4),
    quantizedColorCount: colorCounts.size,
  };
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

function normalizeGenomeKmerParams(params) {
  const sequenceId = String(params.sequenceId ?? "").trim().slice(0, 128);
  const sequence = String(params.sequence ?? "").trim().toUpperCase();
  if (sequence.length < 1 || sequence.length > 256) {
    throw new Error("sequence must be 1..256 bases");
  }
  for (const base of sequence) {
    if (!GENOME_KMER_ALPHABET.includes(base)) {
      throw new Error(`sequence contains unsupported base "${base}"`);
    }
  }
  const k = asInt(params.k ?? 3);
  if (k < 2 || k > 6) throw new Error("k must be 2..6");
  if (k > sequence.length) throw new Error("k cannot exceed sequence length");
  return { sequenceId, sequence, k };
}

function workerErrorDetails(error) {
  return error && typeof error === "object" && error.details && typeof error.details === "object"
    ? error.details
    : null;
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "unknown error");
}

function entropyFromHistogram(hist, total) {
  if (total <= 0) return 0;
  let entropy = 0;
  for (const count of hist) {
    if (!count) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function rgbLuma(r, g, b) {
  return Math.round((r * 77 + g * 150 + b * 29) / 256);
}

function channelRange(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function dominantColorList(colorCounts, limit) {
  return [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([color]) => {
      const r = ((color >> 8) & 0xf) * 17;
      const g = ((color >> 4) & 0xf) * 17;
      const b = (color & 0xf) * 17;
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    });
}

function isWarmPixel(r, g, b) {
  return r > 96 && r >= g + 12 && g >= b - 8;
}

function isCoolPixel(r, g, b) {
  return b > 96 && b >= r + 12 && b >= g + 8;
}

function isPurplePixel(r, g, b) {
  return r > 70 && b > 70 && g < Math.min(r, b) - 10;
}

function isPinkPixel(r, g, b) {
  return r > 120 && b > 80 && g < r - 12;
}

function clampQ(value) {
  return Math.max(0, Math.min(1000, Math.round(value)));
}

function toHex(value) {
  return value.toString(16).padStart(2, "0");
}

function normalizeTextParam(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be ${min}..${max} chars`);
  }
  return text;
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
