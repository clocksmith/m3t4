export type ComputeUseCaseFamily =
  | "m3t4"
  | "science"
  | "ml"
  | "plasma"
  | "device-witness"
  | "infra";

export type ComputeUseCaseRuntime = "cpu" | "webgpu" | "webrtc";

export interface ComputeUseCase {
  id: string;
  title: string;
  status: "implemented" | "experimental" | "planned";
  workload?: string;
  authority: "advisory";
  inputBoundary: string;
  validation: string;
  notes: string;
  publicEndpoint?: string;
  family: ComputeUseCaseFamily;
  runtime?: ComputeUseCaseRuntime;
}

export const COMPUTE_USE_CASES: ComputeUseCase[] = [
  {
    id: "replay-verification",
    family: "m3t4",
    runtime: "cpu",
    title: "Replay artifact verification",
    status: "implemented",
    workload: "m3t4.replay_verify.v1",
    authority: "advisory",
    inputBoundary: "public replay artifact with action bytes; private player configs rejected",
    validation: "2-of-2 assignment-bound receipts against server-held expected hashes",
    notes: "Re-runs a public match replay from its action log and checks the final hash matches the server's. The receipt proves your browser reproduced the match bit-for-bit. Independent playback turns tournaments into multi-witness artifacts instead of one server's word.",
  },
  {
    id: "public-artifact-verification",
    family: "m3t4",
    runtime: "cpu",
    title: "Artifact integrity check",
    status: "implemented",
    workload: "m3t4.public_artifact_verify.v0",
    authority: "advisory",
    inputBoundary: "public replay artifact payload only",
    validation: "2-of-2 assignment-bound receipts against server-held expected hashes",
    notes: "Hashes a published replay artifact and confirms the bytes match the recorded hash. The receipt proves the artifact you downloaded is the one the server published. Catches silent corruption and doubles as the integrity probe for the strict WebRTC data plane.",
  },
  {
    id: "seed-sweeps",
    family: "m3t4",
    runtime: "cpu",
    title: "Matchup seed sweeps",
    status: "implemented",
    workload: "m3t4.seed_sweep.v0",
    authority: "advisory",
    inputBoundary: "public stage ids and public preset names only",
    validation: "assignment-bound receipts against server-held deterministic reference output",
    notes: "Runs the same public matchup across many seeds and summarizes winners, draws, and tick counts. The receipt proves your browser's summary matches the server's CPU reference. Surfaces broken matchups, loops, and side-bias faster than any single machine can sweep alone.",
  },
  {
    id: "device-witness-webgpu",
    family: "device-witness",
    runtime: "webgpu",
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
    family: "plasma",
    runtime: "webgpu",
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
    family: "device-witness",
    runtime: "webrtc",
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
    family: "device-witness",
    runtime: "cpu",
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
    family: "infra",
    runtime: "webrtc",
    title: "Plasma WebRTC data plane",
    status: "experimental",
    authority: "advisory",
    inputBoundary: "short-lived opaque signaling payloads and bucketed connectivity receipts",
    validation: "same assignment and receipt contract as HTTP plus task-required WebRTC transport, server-issued peer subassignments, and peer-signed data-channel subreceipts",
    notes: "Pairing/signaling and data-channel witness execution are separately flagged; public assignment intake remains independently gated.",
  },
  {
    id: "device-witness-profiles",
    family: "device-witness",
    title: "Device Witness profiles",
    status: "implemented",
    authority: "advisory",
    inputBoundary: "derived from admin-only receipts and bucketed observations",
    validation: "profile scores are summaries, not task truth",
    notes: "Feeds scheduler intelligence: allowed workload tier comes from accepted witness receipts; self-reported buckets remain scoring and dashboard hints.",
  },
  {
    id: "contact-map-tiles",
    family: "science",
    runtime: "webgpu",
    title: "Protein contact maps",
    status: "experimental",
    workload: "science.contact_map_tile.v0",
    authority: "advisory",
    inputBoundary: "public residue windows from published proteins only; no private sequences or hidden labels",
    validation: "assignment-bound expected-hash receipts against a server-held integer contact-score tile reference",
    notes: "Scores contact likelihood for every residue pair in a bounded window of a published protein. The receipt proves your browser computed the same score tile as the server reference, cell-for-cell. Aggregated tiles are served at /compute/public/contact-map/aggregate as a citable reproducibility artifact.",
    publicEndpoint: "/compute/public/contact-map/aggregate",
  },
  {
    id: "heat-diffusion-tile",
    family: "science",
    runtime: "webgpu",
    title: "Heat diffusion tile",
    status: "experimental",
    workload: "science.heat_diffusion_tile.v0",
    authority: "advisory",
    inputBoundary: "public grid dimensions, iteration count, shift, and up to eight Q8.8 hotspot seeds",
    validation: "assignment-bound expected-hash receipts against a server-held integer forward-Euler reference",
    notes: "Textbook 2D heat equation stepped with an integer 5-point Laplacian stencil on a bounded grid with Dirichlet-zero boundaries. The receipt proves your GPU reproduced the server's integer-arithmetic field after N iterations. Each accepted receipt ships an advisory PNG heatmap preview.",
  },
];
