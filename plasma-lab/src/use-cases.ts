export interface ComputeUseCase {
  id: string;
  title: string;
  status: "implemented" | "experimental" | "planned";
  workload?: string;
  authority: "advisory";
  inputBoundary: string;
  validation: string;
  notes: string;
}

export const COMPUTE_USE_CASES: ComputeUseCase[] = [
  {
    id: "replay-verification",
    title: "Replay artifact verification",
    status: "implemented",
    workload: "m3t4.public_artifact_verify.v0",
    authority: "advisory",
    inputBoundary: "public replay artifact payload only",
    validation: "2-of-2 expected-hash receipts",
    notes: "First real workload. Never receives private configs or ranked authority.",
  },
  {
    id: "seed-sweeps",
    title: "Public preset seed sweeps",
    status: "implemented",
    workload: "m3t4.seed_sweep.v0",
    authority: "advisory",
    inputBoundary: "public stage ids and public preset names only",
    validation: "expected-hash receipts against deterministic reference output",
    notes: "Useful for meta-health and balance diagnostics. Browser workers do not advertise this kernel yet.",
  },
  {
    id: "device-witness-webgpu",
    title: "Device Witness: WebGPU conformance",
    status: "implemented",
    authority: "advisory",
    inputBoundary: "bucketed opt-in browser capability and tiny WebGPU probe results",
    validation: "expected u32 buffer transform plus bucketed timing",
    notes: "Reports coarse WebGPU availability, correctness, and runtime buckets after opt-in; no raw adapter strings.",
  },
  {
    id: "device-witness-webrtc",
    title: "Device Witness: WebRTC connectivity",
    status: "implemented",
    authority: "advisory",
    inputBoundary: "bucketed opt-in HTTP/WebRTC probe observations",
    validation: "server-authenticated worker session plus aggregate transcript counts",
    notes: "Measures HTTP RTT, local datachannel open, ICE candidate type buckets, and optional STUN success. Raw network details stay admin-only.",
  },
  {
    id: "device-witness-render-fixtures",
    title: "Device Witness: rendering fixtures",
    status: "implemented",
    authority: "advisory",
    inputBoundary: "tiny worker-side OffscreenCanvas fixture result buckets",
    validation: "pixel tolerance fixture buckets",
    notes: "Catches alpha/compositing/rendering drift without collecting full images or exact device identifiers.",
  },
  {
    id: "webrtc-data-plane",
    title: "Plasma WebRTC data plane",
    status: "experimental",
    authority: "advisory",
    inputBoundary: "opaque signaling payloads only in this slice",
    validation: "same assignment and receipt contract as HTTP",
    notes: "Signaling exists behind a flag. Data-channel execution remains disabled separately.",
  },
  {
    id: "exploit-search",
    title: "Exploit search",
    status: "planned",
    authority: "advisory",
    inputBoundary: "public/system opponents or explicitly published configs",
    validation: "server-recomputed or quorum-checked findings",
    notes: "Do not run private ranked brains in the lab.",
  },
  {
    id: "asset-processing",
    title: "Asset processing",
    status: "planned",
    authority: "advisory",
    inputBoundary: "public image tiles or generated assets",
    validation: "hash and pixel-tolerance receipts",
    notes: "Good later workload for visual cleanup and sprite validation.",
  },
];
