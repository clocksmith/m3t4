// Reference kernels for distributed compute. These are the
// deterministic functions a worker is supposed to run; the server
// keeps its own copy so it can (a) produce a reference output for
// adversarial validation and (b) pre-hash the expected result when a
// task is generated.
//
// A kernel MUST be a pure function of its chunk input and produce a
// byte-stable output. Anything else breaks quorum.

import { createHash } from "node:crypto";

export interface KernelChunk {
  chunkId: string;
  kind: string;
  params: Record<string, number | string>;
}

export interface KernelResult {
  chunkId: string;
  outputBytes: Uint8Array;
  outputHash: string;
}

const KERNELS: Record<string, (params: Record<string, number | string>) => Uint8Array> = {
  // Prime-search.v0: enumerate primes in [start, endExclusive) and
  // emit them as little-endian uint32s. Bit-exact across any correct
  // implementation.
  "prime-search.v0": (params) => {
    const start = asInt(params.start);
    const endExclusive = asInt(params.endExclusive);
    if (endExclusive <= start) return new Uint8Array();
    const primes: number[] = [];
    for (let n = start; n < endExclusive; n++) {
      if (isPrime(n)) primes.push(n);
    }
    const out = new Uint8Array(primes.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < primes.length; i++) view.setUint32(i * 4, primes[i], true);
    return out;
  },
};

export function runKernel(chunk: KernelChunk): KernelResult {
  const fn = KERNELS[chunk.kind];
  if (!fn) throw new Error(`unknown kernel: ${chunk.kind}`);
  const outputBytes = fn(chunk.params);
  const outputHash = createHash("sha256").update(outputBytes).digest("hex");
  return { chunkId: chunk.chunkId, outputBytes, outputHash };
}

export function knownKernels(): string[] {
  return Object.keys(KERNELS);
}

function asInt(v: number | string | undefined): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid integer param: ${v}`);
  }
  return n;
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0) return false;
  const limit = Math.floor(Math.sqrt(n));
  for (let d = 3; d <= limit; d += 2) if (n % d === 0) return false;
  return true;
}
