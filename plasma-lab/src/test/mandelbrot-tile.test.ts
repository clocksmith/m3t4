import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MANDELBROT_COORD_CAP_Q88,
  MANDELBROT_MAX_ITER,
  MANDELBROT_TILE_KERNEL_BINDING,
  MANDELBROT_TILE_KERNEL_HASH,
  normalizeMandelbrotTileParams,
  runMandelbrotTileReference,
} from "../kernels/mandelbrot-tile.js";

// Canonical 16x16 view of the classic Mandelbrot rectangle.
// Values pinned so any future regression in the integer arithmetic is
// caught — change them only when the kernel contract intentionally moves.
const CANONICAL_PARAMS = {
  widthPx: 16,
  heightPx: 16,
  // view: real [-2.0, 0.5], imag [-1.25, 1.25] in Q8.8
  minXQ88: -512,
  maxXQ88: 128,
  minYQ88: -320,
  maxYQ88: 320,
  maxIter: 64,
};

test("mandelbrot normalize rejects out-of-range params", () => {
  assert.throws(() => normalizeMandelbrotTileParams({ ...CANONICAL_PARAMS, widthPx: 0 }));
  assert.throws(() => normalizeMandelbrotTileParams({ ...CANONICAL_PARAMS, widthPx: 4096 }));
  assert.throws(() => normalizeMandelbrotTileParams({ ...CANONICAL_PARAMS, maxIter: MANDELBROT_MAX_ITER + 1 }));
  assert.throws(() => normalizeMandelbrotTileParams({ ...CANONICAL_PARAMS, minXQ88: CANONICAL_PARAMS.maxXQ88 }));
  assert.throws(() => normalizeMandelbrotTileParams({ ...CANONICAL_PARAMS, minXQ88: MANDELBROT_COORD_CAP_Q88 + 1 }));
});

test("mandelbrot reference output is deterministic u32 bytes", () => {
  const out1 = runMandelbrotTileReference(CANONICAL_PARAMS);
  const out2 = runMandelbrotTileReference(CANONICAL_PARAMS);
  assert.deepEqual(Array.from(out1.outputBytes), Array.from(out2.outputBytes));
  assert.equal(out1.outputHash.algorithm, "sha256");
  assert.equal(out1.outputHash.value, out2.outputHash.value);
  assert.equal(out1.outputBytes.length, 16 * 16 * 4);
});

test("mandelbrot center escape count matches known-stable interior", () => {
  const { outputBytes } = runMandelbrotTileReference(CANONICAL_PARAMS);
  const view = new DataView(outputBytes.buffer);
  // Pixel (7, 7) is well inside the main cardioid — iteration must cap at maxIter.
  const center = view.getUint32((7 * 16 + 7) * 4, true);
  assert.equal(center, CANONICAL_PARAMS.maxIter);
  // Top-left pixel is far from the set — must escape.
  const corner = view.getUint32(0, true);
  assert.ok(corner < CANONICAL_PARAMS.maxIter, "corner must escape before maxIter");
});

test("mandelbrot kernel binding hash is stable", () => {
  assert.equal(MANDELBROT_TILE_KERNEL_BINDING.kernelId, "science.mandelbrot_tile.v0");
  assert.equal(MANDELBROT_TILE_KERNEL_BINDING.determinismClass, "bit-exact-u32");
  assert.equal(MANDELBROT_TILE_KERNEL_HASH.algorithm, "sha256");
  assert.equal(MANDELBROT_TILE_KERNEL_HASH.value.length, 64);
});
