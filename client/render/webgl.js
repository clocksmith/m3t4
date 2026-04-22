import { drawFrame } from "./canvas2d.js";
import { H, W, setupCanvasSurface } from "./surface.js";
import { hasBrowserCanvas } from "./capabilities.js";

const VERTEX_SOURCE = `
  attribute vec2 a_pos;
  attribute vec2 a_uv;
  varying vec2 v_uv;
  void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = a_uv;
  }
`;

const FRAGMENT_SOURCE = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_scene;
  void main() {
    gl_FragColor = texture2D(u_scene, v_uv);
  }
`;

export function canUseWebGlRenderer() {
  if (!hasBrowserCanvas()) return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function createWebGlRenderer(canvas) {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = W;
  sourceCanvas.height = H;
  const sourceCtx = sourceCanvas.getContext("2d", { alpha: false });
  if (!sourceCtx) return null;
  sourceCtx.imageSmoothingEnabled = false;

  const program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
  const vertexBuffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!program || !vertexBuffer || !texture) return null;

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 1,
     1, -1, 1, 1,
    -1,  1, 0, 0,
     1,  1, 1, 0,
  ]), gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(program, "a_pos");
  const uvLoc = gl.getAttribLocation(program, "a_uv");
  const sceneLoc = gl.getUniformLocation(program, "u_scene");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(sceneLoc, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  const surface = setupCanvasSurface(canvas, {
    onResize: ({ width, height }) => {
      gl.viewport(0, 0, width, height);
    },
  });
  canvas.dataset.renderer = "webgl";

  function present2D() {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    backend: "webgl",
    capability: "webgl",
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
      gl.deleteTexture(texture);
      gl.deleteBuffer(vertexBuffer);
      gl.deleteProgram(program);
    },
  };
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "failed to link WebGL renderer";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "failed to compile WebGL renderer shader";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}
