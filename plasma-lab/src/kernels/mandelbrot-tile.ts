// Deterministic integer Mandelbrot tile.
//
// Output: Uint32Array[widthPx * heightPx] of iteration counts (0..maxIter)
// serialized little-endian. CPU and WebGPU use identical Q8.8 fixed-point
// arithmetic so the u32 output hashes match bit-for-bit. View-rectangle
// coordinates and maxIter are client-facing but stored internally as
// already-scaled integers to avoid float conversion ambiguity.
//
// Bounds are chosen so every intermediate product fits in i32 without
// overflow: |z| <= 2 within the valid iteration region, so |z^2| <= 4,
// and Q8.8 products peak at 0x40000 which is comfortably inside i32.

import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const MANDELBROT_TILE_KERNEL_ID = "science.mandelbrot_tile.v0";
export const MANDELBROT_TILE_KERNEL_BINDING = {
  kernelId: MANDELBROT_TILE_KERNEL_ID,
  contract: "mandelbrot-escape-count-tile-v1",
  determinismClass: "bit-exact-u32",
  serialization: "little-endian-u32-output-v1",
  fixedPoint: "Q8.8-i32",
  escapeSquaredQ88: 0x400, // 4 << 8
};
export const MANDELBROT_TILE_KERNEL_HASH = sha256(canonicalJson(MANDELBROT_TILE_KERNEL_BINDING));

export const MANDELBROT_Q_SHIFT = 8;
export const MANDELBROT_MAX_PIXELS = 64 * 64; // keep previews <= 4KB after PNG compression
export const MANDELBROT_MAX_ITER = 255;
export const MANDELBROT_COORD_CAP_Q88 = 2 << MANDELBROT_Q_SHIFT; // |x|,|y| <= 2

export interface MandelbrotTileParams {
  widthPx: number;
  heightPx: number;
  minXQ88: number;
  maxXQ88: number;
  minYQ88: number;
  maxYQ88: number;
  maxIter: number;
}

export interface MandelbrotTileOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function normalizeMandelbrotTileParams(
  params: Partial<MandelbrotTileParams>,
): MandelbrotTileParams {
  const widthPx = assertInt(params.widthPx, "widthPx", 1, 256);
  const heightPx = assertInt(params.heightPx, "heightPx", 1, 256);
  if (widthPx * heightPx > MANDELBROT_MAX_PIXELS) {
    throw new Error(`mandelbrot tile capped at ${MANDELBROT_MAX_PIXELS} pixels`);
  }
  const minXQ88 = assertInt(params.minXQ88, "minXQ88", -MANDELBROT_COORD_CAP_Q88, MANDELBROT_COORD_CAP_Q88);
  const maxXQ88 = assertInt(params.maxXQ88, "maxXQ88", -MANDELBROT_COORD_CAP_Q88, MANDELBROT_COORD_CAP_Q88);
  const minYQ88 = assertInt(params.minYQ88, "minYQ88", -MANDELBROT_COORD_CAP_Q88, MANDELBROT_COORD_CAP_Q88);
  const maxYQ88 = assertInt(params.maxYQ88, "maxYQ88", -MANDELBROT_COORD_CAP_Q88, MANDELBROT_COORD_CAP_Q88);
  if (maxXQ88 <= minXQ88) throw new Error("maxXQ88 must exceed minXQ88");
  if (maxYQ88 <= minYQ88) throw new Error("maxYQ88 must exceed minYQ88");
  const maxIter = assertInt(params.maxIter, "maxIter", 1, MANDELBROT_MAX_ITER);
  return { widthPx, heightPx, minXQ88, maxXQ88, minYQ88, maxYQ88, maxIter };
}

// Q8.8 signed multiply: (a * b) >> 8, matching WGSL i32 semantics. Callers
// guarantee inputs are bounded so the intermediate product fits in i32.
function mulQ(a: number, b: number): number {
  return (Math.imul(a, b) >> MANDELBROT_Q_SHIFT) | 0;
}

// Pixel centers are computed with integer arithmetic — no floats — so the
// WGSL kernel can do the exact same computation and produce the same Q8.8
// value per pixel.
//
//   cx = minX + ((maxX - minX) * (2*px + 1)) / (2 * widthPx)   [integer division]
//
// Clients that pass non-divisible view widths accept the integer-truncation
// artifact as the canonical sample location.
export function runMandelbrotTileReference(
  params: MandelbrotTileParams,
): MandelbrotTileOutput {
  const spec = normalizeMandelbrotTileParams(params);
  const { widthPx, heightPx, minXQ88, maxXQ88, minYQ88, maxYQ88, maxIter } = spec;
  const escapeSquaredQ88 = 0x400; // 4 << 8
  const rangeX = maxXQ88 - minXQ88;
  const rangeY = maxYQ88 - minYQ88;
  const denomX = widthPx * 2;
  const denomY = heightPx * 2;
  const out = new Uint8Array(widthPx * heightPx * 4);
  const view = new DataView(out.buffer);
  for (let py = 0; py < heightPx; py++) {
    const cy = (minYQ88 + (((rangeY * (2 * py + 1)) / denomY) | 0)) | 0;
    for (let px = 0; px < widthPx; px++) {
      const cx = (minXQ88 + (((rangeX * (2 * px + 1)) / denomX) | 0)) | 0;
      let x = 0;
      let y = 0;
      let escape = maxIter;
      for (let i = 0; i < maxIter; i++) {
        const x2 = mulQ(x, x);
        const y2 = mulQ(y, y);
        if (x2 + y2 > escapeSquaredQ88) { escape = i; break; }
        const xy = mulQ(x, y);
        y = ((xy << 1) + cy) | 0;
        x = (x2 - y2 + cx) | 0;
      }
      view.setUint32((py * widthPx + px) * 4, escape >>> 0, true);
    }
  }
  return { outputBytes: out, outputHash: sha256(out) };
}

function assertInt(value: unknown, label: string, lo: number, hi: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(`${label} must be integer in [${lo}, ${hi}]`);
  }
  return n;
}
