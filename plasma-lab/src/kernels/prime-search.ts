import { sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const PRIME_SEARCH_KERNEL_ID = "prime-search.v0";
export const PRIME_SEARCH_KERNEL_HASH = sha256("prime-search.v0:little-endian-u32");

export interface PrimeParams {
  start: number;
  endExclusive: number;
}

export interface KernelOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function runPrimeSearch(params: PrimeParams): KernelOutput {
  const start = asInt(params.start, "start");
  const endExclusive = asInt(params.endExclusive, "endExclusive");
  if (endExclusive <= start) return output(new Uint8Array());
  const primes: number[] = [];
  for (let n = start; n < endExclusive; n++) {
    if (isPrime(n)) primes.push(n);
  }
  const bytes = new Uint8Array(primes.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < primes.length; i++) view.setUint32(i * 4, primes[i], true);
  return output(bytes);
}

export function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0) return false;
  const limit = Math.floor(Math.sqrt(n));
  for (let d = 3; d <= limit; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
}

function output(outputBytes: Uint8Array): KernelOutput {
  return { outputBytes, outputHash: sha256(outputBytes) };
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid ${label}`);
  }
  return n;
}

