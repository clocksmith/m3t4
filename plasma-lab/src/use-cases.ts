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
    workload: "m3t4.replay_verify.v1",
    authority: "advisory",
    inputBoundary: "public replay artifact with action bytes; private player configs rejected",
    validation: "2-of-2 assignment-bound receipts against server-held expected hashes",
    notes: "First useful workload from the plan. Re-simulates public replay action logs, does not receive expected outputs in assignment payloads, and never receives ranked authority.",
  },
  {
    id: "public-artifact-verification",
    title: "Public artifact hash verification",
    status: "implemented",
    workload: "m3t4.public_artifact_verify.v0",
    authority: "advisory",
    inputBoundary: "public replay artifact payload only",
    validation: "2-of-2 assignment-bound receipts against server-held expected hashes",
    notes: "Integrity scaffold for exported public artifacts and WebRTC data-plane transport tests. Assignment payloads do not expose expected outputs or the server-held artifact hash; strict WebRTC proof tasks require server-issued peer subassignments and peer-signed subreceipts.",
  },
  {
    id: "seed-sweeps",
    title: "Public preset seed sweeps",
    status: "implemented",
    workload: "m3t4.seed_sweep.v0",
    authority: "advisory",
    inputBoundary: "public stage ids and public preset names only",
    validation: "assignment-bound receipts against server-held deterministic reference output",
    notes: "Useful for meta-health and balance diagnostics. Opted-in browsers advertise this as a CPU browser-JS workload bound to sim constants and behavior version.",
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
    id: "tensor-tiles",
    title: "WebGPU tensor tiles",
    status: "implemented",
    workload: "plasma.tensor_tile.v0",
    authority: "advisory",
    inputBoundary: "public deterministic u32 tensor tile params only",
    validation: "assignment-bound expected-hash receipts against a server-held CPU reference output",
    notes: "First real WebGPU useful-work fixture beyond Device Witness. It runs a bounded integer matrix/tensor tile in browser WebGPU and only schedules to workers promoted to webgpu-light.",
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
    id: "device-witness-derived-buffer",
    title: "Device Witness: derived buffer fixture",
    status: "implemented",
    workload: "device_witness.derived_buffer.v0",
    authority: "advisory",
    inputBoundary: "synthetic public byte buffer only; no game frame, private config, or render resource",
    validation: "expected-hash receipt plus derived source/region/kernel/output evidence",
    notes: "Exercises the Plasma derived-compute receipt shape before any real shared renderer buffer exists.",
  },
  {
    id: "webrtc-data-plane",
    title: "Plasma WebRTC data plane",
    status: "experimental",
    authority: "advisory",
    inputBoundary: "short-lived opaque signaling payloads and bucketed connectivity receipts",
    validation: "same assignment and receipt contract as HTTP plus task-required WebRTC transport, server-issued peer subassignments, and peer-signed data-channel subreceipts",
    notes: "Pairing/signaling and data-channel witness execution are separately flagged; public assignment intake remains independently gated.",
  },
  {
    id: "device-witness-profiles",
    title: "Device Witness profiles",
    status: "implemented",
    authority: "advisory",
    inputBoundary: "derived from admin-only receipts and bucketed observations",
    validation: "profile scores are summaries, not task truth",
    notes: "Feeds scheduler intelligence: allowed workload tier comes from accepted witness receipts; self-reported buckets remain scoring and dashboard hints.",
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
