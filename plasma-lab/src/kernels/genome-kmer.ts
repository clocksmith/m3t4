import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const GENOME_KMER_KERNEL_ID = "science.genome_kmer.v0";
export const GENOME_KMER_ALPHABET = "ACGT";
export const GENOME_KMER_MIN_K = 2;
export const GENOME_KMER_MAX_K = 6;
export const GENOME_KMER_MAX_SEQUENCE_LENGTH = 256;

export const GENOME_KMER_KERNEL_BINDING = {
  kernelId: GENOME_KMER_KERNEL_ID,
  contract: "dna-kmer-histogram-v1",
  determinismClass: "bit-exact-u32",
  serialization: "little-endian-u32-output-v1",
  outputSchema: "dna-kmer-histogram-u32-v1",
  alphabet: GENOME_KMER_ALPHABET,
  minK: GENOME_KMER_MIN_K,
  maxK: GENOME_KMER_MAX_K,
  maxSequenceLength: GENOME_KMER_MAX_SEQUENCE_LENGTH,
};
export const GENOME_KMER_KERNEL_HASH = sha256(canonicalJson(GENOME_KMER_KERNEL_BINDING));

export interface GenomeKmerParams {
  sequenceId: string;
  sequence: string;
  k: number;
}

export interface GenomeKmerOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function normalizeGenomeKmerParams(params: Partial<GenomeKmerParams>): GenomeKmerParams {
  const sequenceId = String(params.sequenceId ?? "").trim().slice(0, 128);
  const sequence = String(params.sequence ?? "").trim().toUpperCase();
  if (sequence.length < 1 || sequence.length > GENOME_KMER_MAX_SEQUENCE_LENGTH) {
    throw new Error(`sequence must be 1..${GENOME_KMER_MAX_SEQUENCE_LENGTH} bases`);
  }
  for (const base of sequence) {
    if (!GENOME_KMER_ALPHABET.includes(base)) {
      throw new Error(`sequence contains unsupported base "${base}" (only ACGT allowed)`);
    }
  }
  const k = asInt(params.k ?? GENOME_KMER_MIN_K, "k");
  if (k < GENOME_KMER_MIN_K || k > GENOME_KMER_MAX_K) {
    throw new Error(`k must be ${GENOME_KMER_MIN_K}..${GENOME_KMER_MAX_K}`);
  }
  if (k > sequence.length) {
    throw new Error("k cannot exceed sequence length");
  }
  return { sequenceId, sequence, k };
}

export function runGenomeKmerReference(params: GenomeKmerParams): GenomeKmerOutput {
  const spec = normalizeGenomeKmerParams(params);
  const histogramSize = 1 << (2 * spec.k);
  const out = new Uint8Array(histogramSize * 4);
  const view = new DataView(out.buffer);
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
  return { outputBytes: out, outputHash: sha256(out) };
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid ${label}`);
  }
  return n;
}
