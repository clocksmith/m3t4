import { drawFrame } from "./canvas2d.js";
import { H, W, setupCanvasSurface } from "./surface.js";
import { hasBrowserCanvas } from "./capabilities.js";

const SHADER_SOURCE = `
  struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
  };

  @vertex
  fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
    var positions = array<vec2f, 6>(
      vec2f(-1.0, -1.0),
      vec2f( 1.0, -1.0),
      vec2f(-1.0,  1.0),
      vec2f(-1.0,  1.0),
      vec2f( 1.0, -1.0),
      vec2f( 1.0,  1.0)
    );
    var uvs = array<vec2f, 6>(
      vec2f(0.0, 1.0),
      vec2f(1.0, 1.0),
      vec2f(0.0, 0.0),
      vec2f(0.0, 0.0),
      vec2f(1.0, 1.0),
      vec2f(1.0, 0.0)
    );

    var out: VertexOut;
    out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    out.uv = uvs[vertexIndex];
    return out;
  }

  @group(0) @binding(0) var sceneTexture: texture_2d<f32>;
  @group(0) @binding(1) var sceneSampler: sampler;

  @fragment
  fn fs(in: VertexOut) -> @location(0) vec4f {
    return textureSample(sceneTexture, sceneSampler, in.uv);
  }
`;

export async function canUseWebGpuRenderer() {
  if (!hasBrowserCanvas() || typeof navigator === "undefined" || !navigator.gpu) {
    return false;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    const probeCanvas = document.createElement("canvas");
    const ok = Boolean(probeCanvas.getContext("webgpu"));
    device.destroy?.();
    return ok;
  } catch {
    return false;
  }
}

export async function createWebGpuRenderer(canvas) {
  if (!hasBrowserCanvas() || typeof navigator === "undefined" || !navigator.gpu) {
    return null;
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy?.();
    return null;
  }

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = W;
  sourceCanvas.height = H;
  const sourceCtx = sourceCanvas.getContext("2d", { alpha: false });
  if (!sourceCtx) {
    device.destroy?.();
    return null;
  }
  sourceCtx.imageSmoothingEnabled = false;

  const format = navigator.gpu.getPreferredCanvasFormat();
  const sampler = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest",
  });
  const sourceTexture = device.createTexture({
    size: [W, H],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: sourceTexture.createView() },
      { binding: 1, resource: sampler },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: device.createShaderModule({ code: SHADER_SOURCE }),
      entryPoint: "vs",
    },
    fragment: {
      module: device.createShaderModule({ code: SHADER_SOURCE }),
      entryPoint: "fs",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });

  let configuredWidth = 0;
  let configuredHeight = 0;
  function configure(width = canvas.width, height = canvas.height) {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    if (nextWidth === configuredWidth && nextHeight === configuredHeight) return;
    context.configure({
      device,
      format,
      alphaMode: "opaque",
    });
    configuredWidth = nextWidth;
    configuredHeight = nextHeight;
  }

  const surface = setupCanvasSurface(canvas, {
    onResize: ({ width, height }) => configure(width, height),
  });
  configure();
  canvas.dataset.renderer = "webgpu";

  function present2D() {
    device.queue.copyExternalImageToTexture(
      { source: sourceCanvas },
      { texture: sourceTexture },
      [W, H],
    );
    const view = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    backend: "webgpu",
    capability: "webgpu",
    canvas,
    ctx: sourceCtx,
    resize: surface.resize,
    drawFrame(stage, frame, labels) {
      drawFrame(sourceCtx, stage, frame, labels);
      present2D();
    },
    present2D,
    destroy() {
      surface.teardown?.();
      sourceTexture.destroy();
      device.destroy?.();
    },
  };
}
