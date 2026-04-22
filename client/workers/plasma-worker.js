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
      executionMode: chunk.kind === "device_witness.webgpu.v0" ? "webgpu" : "cpu",
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
