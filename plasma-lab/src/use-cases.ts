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
    workload: "device_witness.webgpu.v0",
    authority: "advisory",
    inputBoundary: "bucketed opt-in browser capability plus assignment-bound tiny WebGPU challenge",
    validation: "expected-hash receipt for deterministic u32 buffer transform",
    notes: "Reports coarse WebGPU availability, correctness, and runtime buckets after opt-in; no raw adapter strings.",
  },
  {
    id: "device-witness-webrtc",
    title: "Device Witness: WebRTC connectivity",
    status: "implemented",
    workload: "device_witness.webrtc.v0",
    authority: "advisory",
    inputBoundary: "bucketed opt-in HTTP/WebRTC observations plus assignment-bound local transcript receipts",
    validation: "measurement receipt hash over issued challenge params and whitelisted transcript buckets",
    notes: "Measures HTTP RTT, local and signaled two-browser datachannel open, ICE candidate type buckets, and optional STUN/TURN outcomes. Raw network details stay admin-only.",
  },
  {
    id: "device-witness-render-fixtures",
    title: "Device Witness: rendering fixtures",
    status: "implemented",
    workload: "device_witness.render_fixture.v0",
    authority: "advisory",
    inputBoundary: "tiny worker-side OffscreenCanvas fixture samples",
    validation: "expected-hash receipt for pixel sample bytes plus observation buckets",
    notes: "Catches alpha/compositing/rendering drift without collecting full images or exact device identifiers.",
  },
  {
    id: "webrtc-data-plane",
    title: "Plasma WebRTC data plane",
    status: "experimental",
    authority: "advisory",
    inputBoundary: "short-lived opaque signaling payloads and bucketed connectivity receipts",
    validation: "same assignment and receipt contract as HTTP",
    notes: "Pairing/signaling exists behind a flag. Data-channel workload execution remains disabled separately.",
  },
  {
    id: "device-witness-profiles",
    title: "Device Witness profiles",
    status: "implemented",
    authority: "advisory",
    inputBoundary: "derived from admin-only receipts and bucketed observations",
    validation: "profile scores are summaries, not task truth",
    notes: "Feeds scheduler intelligence: allowed workload tier, correctness scores, kernel timing, and WebRTC direct/TURN rates.",
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
