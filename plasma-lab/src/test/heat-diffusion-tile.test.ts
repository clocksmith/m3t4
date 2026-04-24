import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HEAT_DIFFUSION_TILE_KERNEL_BINDING,
  HEAT_DIFFUSION_TILE_KERNEL_HASH,
  HEAT_MAX_DIM,
  HEAT_MAX_HOTSPOTS,
  HEAT_MAX_ITERATIONS,
  normalizeHeatDiffusionTileParams,
  runHeatDiffusionTileReference,
} from "../kernels/heat-diffusion-tile.js";

const CANONICAL = {
  widthPx: 16,
  heightPx: 16,
  iterations: 24,
  shift: 3,
  hotspots: [
    { xPx: 8, yPx: 8, valueQ88: 0x4000 },
  ],
};

test("heat-diffusion normalize rejects bad params", () => {
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, widthPx: 2 }));
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, heightPx: HEAT_MAX_DIM + 1 }));
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, shift: 1 }));
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, shift: 7 }));
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, iterations: 0 }));
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, iterations: HEAT_MAX_ITERATIONS + 1 }));
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, hotspots: [] }));
  assert.throws(() => normalizeHeatDiffusionTileParams({ ...CANONICAL, hotspots: Array(HEAT_MAX_HOTSPOTS + 1).fill({ xPx: 0, yPx: 0, valueQ88: 1 }) }));
});

test("heat-diffusion reference is deterministic across runs", () => {
  const a = runHeatDiffusionTileReference(CANONICAL);
  const b = runHeatDiffusionTileReference(CANONICAL);
  assert.deepEqual(Array.from(a.outputBytes), Array.from(b.outputBytes));
  assert.equal(a.outputHash.value, b.outputHash.value);
  assert.equal(a.outputBytes.length, 16 * 16 * 4);
});

test("heat diffuses outward from the hotspot and the center cools", () => {
  const { outputBytes } = runHeatDiffusionTileReference(CANONICAL);
  const view = new DataView(outputBytes.buffer);
  const center = view.getUint32((8 * 16 + 8) * 4, true);
  const neighbor = view.getUint32((8 * 16 + 9) * 4, true);
  const corner = view.getUint32(0, true);
  // Center must still be the hottest, but cooler than the initial hotspot.
  assert.ok(center < 0x4000, "center must cool after diffusion");
  assert.ok(center > neighbor, "center hotter than neighbor");
  assert.ok(neighbor > 0, "neighbor picked up heat");
  assert.equal(corner, 0, "far corner unreachable within 24 steps");
});

test("heat-diffusion kernel binding hash is stable", () => {
  assert.equal(HEAT_DIFFUSION_TILE_KERNEL_BINDING.kernelId, "science.heat_diffusion_tile.v0");
  assert.equal(HEAT_DIFFUSION_TILE_KERNEL_BINDING.determinismClass, "bit-exact-u32");
  assert.equal(HEAT_DIFFUSION_TILE_KERNEL_HASH.algorithm, "sha256");
  assert.equal(HEAT_DIFFUSION_TILE_KERNEL_HASH.value.length, 64);
});
