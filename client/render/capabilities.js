export const RENDER_BACKENDS = ["auto", "webgpu", "webgl", "canvas2d"];

export function normalizeRendererPreference(value) {
  const raw = String(value || "auto").toLowerCase();
  return RENDER_BACKENDS.includes(raw) ? raw : "auto";
}

export function gpuRendererEnabled(features = {}, options = {}) {
  return options.webgpu === true || features.webgpuRenderer === true;
}

export function webGlRendererEnabled(features = {}, options = {}) {
  return options.webgl === true || features.webglRenderer === true || gpuRendererEnabled(features, options);
}

export function rendererBackendCandidates({ preferredBackend = "auto", features = {}, options = {} } = {}) {
  const preference = normalizeRendererPreference(preferredBackend);
  const allowWebGpu = gpuRendererEnabled(features, options);
  const allowWebGl = webGlRendererEnabled(features, options);
  const candidates = [];

  if ((preference === "auto" || preference === "webgpu") && allowWebGpu) {
    candidates.push("webgpu");
  }
  if ((preference === "auto" || preference === "webgpu" || preference === "webgl") && allowWebGl) {
    candidates.push("webgl");
  }
  candidates.push("canvas2d");
  return [...new Set(candidates)];
}

export function hasBrowserCanvas() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}
