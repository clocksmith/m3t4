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
    const bytes = kernel(chunk.params);
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
      computeMs,
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
  if (typeof OffscreenCanvas === "undefined") return { canvas2dFixture: "unavailable" };
  const t0 = performance.now();
  try {
    const canvas = new OffscreenCanvas(8, 8);
    const ctx = canvas.getContext("2d", {
      alpha: true,
      colorSpace: "srgb",
      willReadFrequently: true,
    }) || canvas.getContext("2d");
    if (!ctx) return { canvas2dFixture: "unavailable" };
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
    const red = pixel(data, 1, 1);
    const green = pixel(data, 5, 1);
    const mixed = pixel(data, 1, 5);
    const blackBlue = pixel(data, 5, 5);
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
