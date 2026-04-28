# Firebase Browser Compute Plan

This is the current compute plan for m3t4. The production path is Firebase
Functions + Firestore + WebRTC + `client/workers/plasma-worker.js`. The old
`plasma-lab` Cloud Run sidecar is preserved for staff smokes, receipt-log
research, and as the source package for deterministic public kernels.

## Goal

Let opted-in browsers contribute public deterministic compute while keeping
server cost low and ranked authority isolated.

The compute lane must be useful, bounded, and honest:

- public inputs only
- deterministic kernels only
- server-held expected hashes
- browser worker execution off the render thread
- WebRTC peer attempt when possible
- local worker fallback when peers are unavailable
- Firebase Function validation before public credit
- aggregate public stats without private per-user leakage

## Non-crossover boundary

Compute must never read or mutate:

- private ranked stable configs
- hidden brain logic
- ranked execution authority
- Elo authority except through the live match Function
- roster release state
- match scheduling locks
- server-held expected hashes

Accepted compute receipts are advisory. They can power public stats and future
badges, but they are not ranked truth.

## Current implementation

### Client

- `client/lib/firebase-compute.js` is the Firebase compute client.
- `client/lib/compute.js` selects Firebase compute when
  `window.__M3T4_COMPUTE_FIREBASE__ === true`.
- `client/workers/plasma-worker.js` executes the actual CPU/WebGPU kernels.
- WebRTC peer execution is attempted first using the shared `webrtcSignal`
  Function.
- Local worker execution is the fallback path.

### Functions

- `computeRegister`: records worker session/capability.
- `computeClaim`: selects a workload lane and stores the server-held expected
  hash on the assignment doc.
- `computeSubmitReceipt`: validates submitted output hash against the stored
  expected hash and writes a receipt.
- `computeMyReceipts`: returns the caller's recent receipts.
- `computePublicSummary`: returns aggregate status/use-case data.
- `webrtcSignal`: stateless signaling write validator.
- `expireSessions`: deletes stale signaling/presence docs.

### Firestore

```text
compute_workers/{workerId}
compute_assignments/{assignmentId}
compute_receipts/{receiptId}
compute_public_stats/latest
compute_peer_presence/{peerId}
webrtc/{sessionId}
```

`compute_assignments` contains expected hashes and must not be browser-readable.

## Assignment lifecycle

```text
user opts in
  -> anonymous/account Firebase Auth
  -> computeRegister(capability)
  -> computeClaim(workerId)
      Function selects lane
      Function builds public params
      Function runs reference kernel
      Function stores expectedOutputHash privately
      Function returns assignment without expected hash
  -> browser tries WebRTC peer compute
  -> fallback to local plasma worker if peer path fails
  -> computeSubmitReceipt(receipt)
      Function compares outputHash to expectedOutputHash
      Function writes accepted/rejected receipt
      Function updates aggregate stats
```

## Runtime surfaces

Browsers advertise:

- `cpu` when Worker + Web Crypto are available.
- `webrtc` when `RTCPeerConnection` exists.
- `webgpu` when `navigator.gpu` exists.

Claim selection prefers WebGPU lanes only for WebGPU-capable browsers. CPU-only
browsers still receive safe CPU lanes.

## Workload lanes

CPU-oriented lanes:

- `prime-search.v0`
- `asset.tile_audit.v0`
- `ml.image_tile_infer.v0`
- `science.microscopy_tile_score.v0`
- `science.genome_kmer.v0`
- `m3t4.seed_sweep.v0`
- `m3t4.exploit_search.v0`
- `device_witness.render_fixture.v0`
- `device_witness.derived_buffer.v0`

WebGPU-preferred lanes:

- `plasma.tensor_tile.v0`
- `science.contact_map_tile.v0`
- `science.mandelbrot_tile.v0`
- `science.heat_diffusion_tile.v0`
- `device_witness.webgpu.v0`

The plasma worker still contains additional kernels such as replay/public
artifact verification for legacy sidecar and future explicit assignment flows.
The automatic Firebase claim generator mints only the lanes it can construct
from public local params.

## Validation model

Current Firebase production validation is expected-hash validation:

- Functions generate or normalize public assignment params.
- Functions run the matching reference kernel.
- Functions store `expectedOutputHash` in `compute_assignments`.
- Browser workers only receive assignment ID, token, kernel ID/hash, input hash,
  and params.
- Receipt acceptance is a direct hash comparison.

This is not a trusted-browser or trusted-GPU claim. The browser is treated as an
untrusted executor of deterministic public work.

## WebRTC compute model

WebRTC is transport only:

- Offerer claims an assignment from Functions.
- Offerer creates a `webrtc` signaling session.
- Target peer sees an offer where `offer.purpose === "compute"`.
- Peer runs the chunk in its own plasma worker and returns a result over the
  data channel.
- Offerer submits the final receipt to Functions.
- If the peer does not answer or the channel fails, the offerer computes locally
  and submits a fallback receipt.

A WebRTC receipt means the result travelled through a peer channel. It does not
prove the peer was honest hardware.

## Flags

Client flags:

```js
window.__M3T4_COMPUTE_FIREBASE__ = true;
window.__M3T4_COMPUTE_STUN_URLS__ = ["stun:stun.l.google.com:19302"];
window.__M3T4_COMPUTE_ICE_SERVERS__ = [{ urls: "stun:stun.l.google.com:19302" }];
```

Legacy sidecar flags such as `FEATURE_COMPUTE_LAB_ROUTES`,
`COMPUTE_ACCEPT_ASSIGNMENTS`, and `FEATURE_COMPUTE_WEBRTC_DATA` apply only to
the optional `plasma-lab` Cloud Run sidecar path.

## Production guardrails

- Keep `__M3T4_COMPUTE_FIREBASE__` false until compute Functions and rules are
  deployed.
- Keep assignment payloads public and bounded.
- Keep `compute_assignments` private.
- Keep cleanup deployed so stale signaling/presence docs do not accumulate.
- Watch Firestore reads/writes and Functions invocation counts after enabling
  compute.
- Do not claim Sybil resistance, hardware attestation, private-input compute,
  or ranked compute authority.

## Future bridge work

A stricter future public compute tier can add:

- signed browser receipts
- invite/admission controls
- duplicate/quorum validation for selected lanes
- receipt-log segment publication
- independent verifier packages
- strict WebRTC-only assignment policies
- tournament/public-manifest match verification

Those are additive. The current Firebase path is already useful as low-cost,
expected-hash, public deterministic volunteer compute.
