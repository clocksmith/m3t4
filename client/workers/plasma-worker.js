// Plasma compute worker. Runs deterministic kernels off the main
// thread so the spectator render loop stays smooth.
//
// Protocol (main ↔ worker):
//   { type: "run", assignmentId, chunk: { chunkId, kind, params } }
//   → { type: "done", assignmentId, chunkId, outputHash, computeMs }
//   → { type: "error", assignmentId, chunkId, message }
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
};

async function hashHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "run") return;
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
    self.postMessage({ type: "done", assignmentId, chunkId: chunk.chunkId, outputHash, computeMs });
  } catch (e) {
    self.postMessage({ type: "error", assignmentId, chunkId: chunk.chunkId, message: String(e?.message ?? e) });
  }
};

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
