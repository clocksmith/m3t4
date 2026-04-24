// Deterministic 2D heat-diffusion tile (explicit forward-Euler step).
//
// State: u[widthPx * heightPx] of Q8.8 integer temperatures, Dirichlet
// zero boundary. Each iteration applies the 5-point Laplacian stencil
//
//   u'(i,j) = u(i,j) + ((north + south + east + west - 4*u(i,j)) >> shift)
//
// with integer shift. Stable iff α = 1/2^shift <= 1/4, i.e. shift >= 2.
// All intermediates fit inside i32 by construction so WebGPU i32 arithmetic
// matches the V8 reference bit-for-bit.

import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const HEAT_DIFFUSION_TILE_KERNEL_ID = "science.heat_diffusion_tile.v0";
export const HEAT_DIFFUSION_TILE_KERNEL_BINDING = {
  kernelId: HEAT_DIFFUSION_TILE_KERNEL_ID,
  contract: "heat-diffusion-5pt-laplacian-tile-v1",
  determinismClass: "bit-exact-u32",
  serialization: "little-endian-u32-output-v1",
  fixedPoint: "Q8.8-i32",
  boundary: "dirichlet-zero",
};
export const HEAT_DIFFUSION_TILE_KERNEL_HASH = sha256(canonicalJson(HEAT_DIFFUSION_TILE_KERNEL_BINDING));

export const HEAT_MAX_DIM = 64;
export const HEAT_MAX_ITERATIONS = 256;
export const HEAT_MAX_HOTSPOTS = 8;
export const HEAT_MAX_VALUE_Q88 = 0xFFFF;

export interface HeatDiffusionHotspot {
  xPx: number;
  yPx: number;
  valueQ88: number;
}

export interface HeatDiffusionTileParams {
  widthPx: number;
  heightPx: number;
  iterations: number;
  shift: number;
  hotspots: HeatDiffusionHotspot[];
}

export interface HeatDiffusionTileOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function normalizeHeatDiffusionTileParams(
  params: Partial<HeatDiffusionTileParams>,
): HeatDiffusionTileParams {
  const widthPx = assertInt(params.widthPx, "widthPx", 4, HEAT_MAX_DIM);
  const heightPx = assertInt(params.heightPx, "heightPx", 4, HEAT_MAX_DIM);
  const iterations = assertInt(params.iterations, "iterations", 1, HEAT_MAX_ITERATIONS);
  const shift = assertInt(params.shift, "shift", 2, 6);
  const rawHotspots = Array.isArray(params.hotspots) ? params.hotspots : [];
  if (rawHotspots.length < 1 || rawHotspots.length > HEAT_MAX_HOTSPOTS) {
    throw new Error(`hotspots must have 1..${HEAT_MAX_HOTSPOTS} entries`);
  }
  const hotspots = rawHotspots.map((raw, idx) => {
    const xPx = assertInt(raw?.xPx, `hotspots[${idx}].xPx`, 0, widthPx - 1);
    const yPx = assertInt(raw?.yPx, `hotspots[${idx}].yPx`, 0, heightPx - 1);
    const valueQ88 = assertInt(raw?.valueQ88, `hotspots[${idx}].valueQ88`, 1, HEAT_MAX_VALUE_Q88);
    return { xPx, yPx, valueQ88 };
  });
  return { widthPx, heightPx, iterations, shift, hotspots };
}

export function runHeatDiffusionTileReference(
  params: HeatDiffusionTileParams,
): HeatDiffusionTileOutput {
  const spec = normalizeHeatDiffusionTileParams(params);
  const { widthPx, heightPx, iterations, shift, hotspots } = spec;
  const total = widthPx * heightPx;
  let curr = new Int32Array(total);
  let next = new Int32Array(total);
  for (const hs of hotspots) curr[hs.yPx * widthPx + hs.xPx] = hs.valueQ88 | 0;
  for (let step = 0; step < iterations; step++) {
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const i = y * widthPx + x;
        const center = curr[i];
        const north = y > 0 ? curr[i - widthPx] : 0;
        const south = y < heightPx - 1 ? curr[i + widthPx] : 0;
        const west = x > 0 ? curr[i - 1] : 0;
        const east = x < widthPx - 1 ? curr[i + 1] : 0;
        const laplacian = (north + south + east + west - (center << 2)) | 0;
        next[i] = (center + (laplacian >> shift)) | 0;
      }
    }
    const swap = curr; curr = next; next = swap;
  }
  const out = new Uint8Array(total * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < total; i++) {
    // Output is u32 in little-endian. Negative integer states are clamped
    // to 0 for preview-friendliness without affecting receipt determinism
    // since the stencil + shift combination cannot drive this grid below
    // zero when hotspots are non-negative.
    const v = curr[i] < 0 ? 0 : curr[i];
    view.setUint32(i * 4, v >>> 0, true);
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
