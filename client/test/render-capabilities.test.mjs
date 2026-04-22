import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeRendererPreference,
  rendererBackendCandidates,
} from "../render/capabilities.js";

test("renderer backend selection stays conservative by default", () => {
  assert.equal(normalizeRendererPreference("webgpu"), "webgpu");
  assert.equal(normalizeRendererPreference("wat"), "auto");
  assert.deepEqual(rendererBackendCandidates(), ["canvas2d"]);
  assert.deepEqual(
    rendererBackendCandidates({ preferredBackend: "auto", features: { webgpuRenderer: true } }),
    ["webgpu", "webgl", "canvas2d"],
  );
  assert.deepEqual(
    rendererBackendCandidates({ preferredBackend: "webgl", features: { webglRenderer: true } }),
    ["webgl", "canvas2d"],
  );
});
