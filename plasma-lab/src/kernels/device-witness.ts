import { sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const DEVICE_WITNESS_WEBGPU_KERNEL_ID = "device_witness.webgpu.v0";
export const DEVICE_WITNESS_WEBGPU_KERNEL_HASH = sha256(`${DEVICE_WITNESS_WEBGPU_KERNEL_ID}:u32-lcg-roundtrip-v1`);

export const DEVICE_WITNESS_RENDER_KERNEL_ID = "device_witness.render_fixture.v0";
export const DEVICE_WITNESS_RENDER_KERNEL_HASH = sha256(`${DEVICE_WITNESS_RENDER_KERNEL_ID}:canvas2d-alpha-samples-v1`);

export const DEVICE_WITNESS_WEBRTC_KERNEL_ID = "device_witness.webrtc.v0";
export const DEVICE_WITNESS_WEBRTC_KERNEL_HASH = sha256(`${DEVICE_WITNESS_WEBRTC_KERNEL_ID}:local-datachannel-transcript-v1`);

export const DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID = "device_witness.derived_buffer.v0";
export const DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_HASH = sha256(`${DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID}:synthetic-u32-region-v1`);

export interface DeviceWitnessWebGpuParams {
  seed: number;
  count: number;
}

export interface DeviceWitnessDerivedBufferParams {
  seed: number;
  count: number;
}

export interface KernelOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export interface DerivedBufferOutput extends KernelOutput {
  sourceHash: ContentHash;
  regionHash: ContentHash;
  producerKernelHash: ContentHash;
  sourceId: string;
  regionId: string;
  outputId: string;
}

export function runDeviceWitnessWebGpuReference(params: DeviceWitnessWebGpuParams): KernelOutput {
  const seed = asInt(params.seed, "seed");
  const count = asInt(params.count, "count");
  if (count <= 0 || count > 4096) throw new Error("count must be 1..4096");
  const bytes = new Uint8Array(count * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    const x = witnessInput(seed, i);
    view.setUint32(i * 4, witnessTransform(x, i), true);
  }
  return output(bytes);
}

export function runDeviceWitnessRenderReference(): KernelOutput {
  return output(new Uint8Array([
    128, 0, 0, 255,
    0, 255, 0, 255,
    96, 0, 64, 255,
    0, 0, 64, 255,
  ]));
}

export function runDeviceWitnessDerivedBufferReference(params: DeviceWitnessDerivedBufferParams): DerivedBufferOutput {
  const seed = asInt(params.seed, "seed");
  const count = asInt(params.count, "count");
  if (count <= 0 || count > 4096) throw new Error("count must be 1..4096");
  const sourceBytes = new Uint8Array(count * 4);
  const outputBytes = new Uint8Array(count * 4);
  const sourceView = new DataView(sourceBytes.buffer);
  const outputView = new DataView(outputBytes.buffer);
  for (let i = 0; i < count; i++) {
    const x = witnessInput(seed, i);
    sourceView.setUint32(i * 4, x, true);
    outputView.setUint32(i * 4, (witnessTransform(x, i) ^ 0xa5a5a5a5) >>> 0, true);
  }
  const out = output(outputBytes);
  return {
    ...out,
    sourceHash: sha256(sourceBytes),
    regionHash: sha256(sourceBytes),
    producerKernelHash: DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_HASH,
    sourceId: "synthetic-frame",
    regionId: "synthetic-u32-region",
    outputId: "synthetic-derived-u32",
  };
}

function witnessInput(seed: number, index: number): number {
  return (Math.imul(seed >>> 0, 747796405) + Math.imul(index >>> 0, 2891336453) + 1013904223) >>> 0;
}

function witnessTransform(x: number, index: number): number {
  const y = (x ^ ((x >>> 16) + Math.imul(index >>> 0, 2246822519))) >>> 0;
  return (Math.imul(y, 1664525) + 1013904223) >>> 0;
}

function output(outputBytes: Uint8Array): KernelOutput {
  return { outputBytes, outputHash: sha256(outputBytes) };
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid ${label}`);
  }
  return n;
}
