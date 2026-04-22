export {
  W,
  H,
  setupCanvas,
  drawFrame,
  createCanvas2DRenderer,
} from "./canvas2d.js";
export {
  normalizeRendererPreference,
  rendererBackendCandidates,
} from "./capabilities.js";

import { createCanvas2DRenderer } from "./canvas2d.js";
import { rendererBackendCandidates, normalizeRendererPreference } from "./capabilities.js";
import { canUseWebGlRenderer, createWebGlRenderer } from "./webgl.js";
import { canUseWebGpuRenderer, createWebGpuRenderer } from "./webgpu.js";
import { replaceCanvasElement } from "./surface.js";

export async function createFrameRenderer(canvas, options = {}) {
  const runtimeBackend = typeof window !== "undefined" ? window.__M3T4_RENDER_BACKEND__ : "";
  const features = typeof window !== "undefined" ? window.__M3T4_FEATURES__ : {};
  const preferredBackend = normalizeRendererPreference(
    options.backend ?? options.preferredBackend ?? runtimeBackend ?? "auto",
  );
  const candidates = rendererBackendCandidates({ preferredBackend, features, options });
  let targetCanvas = canvas;
  let claimedContext = false;

  for (const backend of candidates) {
    try {
      if (claimedContext) {
        targetCanvas = replaceCanvasElement(targetCanvas);
        claimedContext = false;
      }

      if (backend === "webgpu") {
        if (!await canUseWebGpuRenderer()) continue;
        claimedContext = true;
        const renderer = await createWebGpuRenderer(targetCanvas, options);
        if (renderer) return renderer;
      } else if (backend === "webgl") {
        if (!canUseWebGlRenderer()) continue;
        claimedContext = true;
        const renderer = createWebGlRenderer(targetCanvas, options);
        if (renderer) return renderer;
      } else {
        const renderer = createCanvas2DRenderer(targetCanvas, options);
        if (renderer) return renderer;
      }
    } catch (error) {
      if (typeof console !== "undefined") {
        console.warn(`[m3t4] ${backend} renderer unavailable; falling back.`, error);
      }
      claimedContext = true;
    }
  }

  if (claimedContext) targetCanvas = replaceCanvasElement(targetCanvas);
  return createCanvas2DRenderer(targetCanvas, options);
}
