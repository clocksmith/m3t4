import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const TENSOR_TILE_KERNEL_ID = "plasma.tensor_tile.v0";
export const TENSOR_TILE_KERNEL_BINDING = {
  kernelId: TENSOR_TILE_KERNEL_ID,
  contract: "u32-matmul-tile-v1",
  determinismClass: "bit-exact-u32",
  serialization: "little-endian-u32-output-v1",
  outputSchema: "tensor-tile-u32-v1",
};
export const TENSOR_TILE_KERNEL_HASH = sha256(canonicalJson(TENSOR_TILE_KERNEL_BINDING));

export interface TensorTileParams {
  seed: number;
  rows: number;
  cols: number;
  depth: number;
}

export interface TensorTileOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function runTensorTileReference(params: TensorTileParams): TensorTileOutput {
  const spec = normalizeTensorTileParams(params);
  const out = new Uint8Array(spec.rows * spec.cols * 4);
  const view = new DataView(out.buffer);
  for (let row = 0; row < spec.rows; row++) {
    for (let col = 0; col < spec.cols; col++) {
      let acc = 0;
      for (let d = 0; d < spec.depth; d++) {
        const av = tensorInputA(spec.seed, row, d) & 0xff;
        const bv = tensorInputB(spec.seed, d, col) & 0xff;
        acc = (acc + Math.imul(av, bv) + Math.imul(row + 1, 17) + Math.imul(col + 1, 31) + d) >>> 0;
      }
      view.setUint32((row * spec.cols + col) * 4, acc, true);
    }
  }
  return { outputBytes: out, outputHash: sha256(out) };
}

export function normalizeTensorTileParams(params: TensorTileParams): TensorTileParams {
  const seed = asInt(params.seed, "seed");
  const rows = asInt(params.rows, "rows");
  const cols = asInt(params.cols, "cols");
  const depth = asInt(params.depth, "depth");
  if (rows <= 0 || rows > 64) throw new Error("rows must be 1..64");
  if (cols <= 0 || cols > 64) throw new Error("cols must be 1..64");
  if (depth <= 0 || depth > 256) throw new Error("depth must be 1..256");
  if (rows * cols > 4096) throw new Error("tensor tile output is capped at 4096 cells");
  if (rows * depth > 16384 || depth * cols > 16384) throw new Error("tensor tile input is capped at 16384 cells per side");
  return { seed, rows, cols, depth };
}

function tensorInputA(seed: number, row: number, depthIndex: number): number {
  return mix32(seed ^ Math.imul(row + 1, 0x9e3779b1) ^ Math.imul(depthIndex + 1, 0x85ebca77));
}

function tensorInputB(seed: number, depthIndex: number, col: number): number {
  return mix32((seed + 0x6d2b79f5) ^ Math.imul(depthIndex + 1, 0xc2b2ae3d) ^ Math.imul(col + 1, 0x27d4eb2f));
}

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid ${label}`);
  }
  return n;
}
