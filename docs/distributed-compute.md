# Distributed Compute

m3t4 should use P2P as an opt-in compute fabric, not as ranked authority.
Ranked matches remain server-authoritative. Browser peers may contribute only
public, deterministic, receipt-verifiable work.

## Where This Belongs

This plan spans three repos:

- `m3t4`: concrete product integration, feature flags, worker UI, and safe
  workload adapters.
- `plasma`: task/chunk/receipt/validation contract and workload-adapter ladder.
- `ouroboros`: product and strategy framing for receipt-carrying public compute.

The rule of thumb: if it changes the protocol, put it in Plasma. If it changes
how m3t4 spectators participate, put it here. If it changes the company/product
claim, put it in Ouroboros.

## Current Shape

The repo has a Plasma-lite scaffold running through the isolated `plasma-lab`
sidecar:

- spectators opt in from the Live page
- the browser registers a worker capability envelope
- the coordinator assigns deterministic chunks
- a Web Worker runs the chunk off the render thread
- the worker submits an execution receipt
- the coordinator verifies quorum and updates local reputation counters

Current controlled-production status as of 2026-04-22:

- `plasma-lab` is deployed separately from ranked game authority.
- public m3t4 compute flags remain off; staff smokes opt in from devtools.
- assignment intake defaults to off and is opened only for bounded windows.
- production validation requires ECDSA P-256 receipt signing.
- workers do not receive server-held expected output hashes.
- strict WebRTC proof tasks require `transport=webrtc`, accepted
  server-issued peer subassignments, and peer-signed subreceipts.
- two hosted browser clients have completed `m3t4.seed_sweep.v0` over
  `plasma-data` with 2-of-2 accepted signed strict receipts.
- replay archive can optionally seed advisory public-artifact, replay-verify,
  public-preset seed-sweep, and WebGPU tensor-tile work without opening
  assignment intake.
- `/compute/public/stats` now carries a global compute score derived from
  accepted public chunks and receipts, not per-user credit.
- `plasma.tensor_tile.v0` is implemented as the first bounded WebGPU
  useful-work fixture, gated to workers with accepted WebGPU witness evidence.

The first demo kernel was `prime-search.v0`. It is intentionally boring: it
proved assignment, execution, hashing, receipt submission, and quorum without
shipping any private brain logic to the browser. The useful m3t4 kernels now in
the safe ladder are public-artifact verification, public replay verification,
and public-preset seed sweeps.

## Borrowed Rules

From Plasma:

- task, chunk, receipt, and validation are separate concepts
- every receipt is tied to a specific `chunk-assign`
- output bytes are hashed before they are trusted
- public peers are untrusted by default
- a transport failure is not a compute failure
- no P2P result becomes canonical ranked truth

From the Ouroboros receipt/notarization docs:

- receipts are integrity artifacts, not compliance claims
- say exactly what was observed and hashed
- avoid overclaiming without hardware-backed attestation
- make useful participation visible before selling topology

## Safe m3t4 Workloads

Recommended workload ladder:

| Rank | Workload | Why It Fits | Validation | Product Fit |
|---:|---|---|---|---|
| 1 | `m3t4.replay_verify.v1` | Uses public action logs or frame/checkpoint hashes; no brain required | bit-exact replay/action hash | Spectators help verify public receipts and tournament artifacts |
| 2 | `m3t4.match_batch.v0` | Embarrassingly parallel match sweeps, but only safe for public bots or non-secret kernels | bit-exact result hash | Meta-health, public build validation, tournament sweeps |
| 3 | `m3t4.webgpu_benchmark.v0` | Measures real browser GPU capability before assigning harder work | deterministic fixtures plus tolerance checks | Hardware scouting for scheduler policy |
| 4 | `m3t4.asset_tile.v0` | Visual, parallel, useful, low-risk | hash plus pixel tolerance | Sprite cleanup, alpha keying, palette quantization, parallax checks |
| 5 | `science.docking_pose_toy.v0` | Independent ligand/pose chunks without full wet-lab claims | replicated quorum plus known controls | First science-looking adapter without overclaiming |
| 6 | `science.microscopy_tile_score.v0` | Image tiles parallelize naturally on browser GPUs | ensemble agreement plus reference tiles | Cancer-adjacent and more browser-realistic than folding |
| 7 | `science.drug_combo_sweep.v0` | Large parameter grids with independent seeds | statistical quorum and confidence intervals | Useful research shape with manageable validation |
| 8 | `science.contact_map_tile.v0` | Folding-adjacent but smaller than full folding | tolerance-bounded tile scores | Bridge toward protein workloads |
| 9 | `science.conformer_search_mini.v0` | Many short stochastic trajectories | replicated seeds plus energy sanity checks | Realistic but validation is harder |
| 10 | `plasma.tensor_tile.v0` | Direct WebGPU/tensor contract fit | server-held CPU reference hash for deterministic u32 tiles | Strong substrate proof, less visible to m3t4 users |

The first useful m3t4 class is public replay/artifact verification: public
artifact hashes, public replay action logs, and public preset seed sweeps.
Match batches remain unsafe unless every policy kernel, bot, and input is
public, or a later attested/proof-carrying runtime exists.

Not safe for browser peers:

- ranked match execution
- private config evaluation
- canonical brain decision-making
- Elo mutation
- any work requiring hidden strategy code

## WebRTC Path

The HTTP coordinator is the right first slice because it is easy to observe and
rate-limit. The WebRTC path should reuse the same assignment and receipt shape:

1. coordinator admits a peer and issues a session descriptor
2. peers open `plasma-control`, `plasma-data`, and `plasma-receipts`
3. coordinator sends `task-offer` then `chunk-assign`
4. executor sends `chunk-result`
5. validator or coordinator emits `validation-result`
6. accepted chunks are assembled or credited

WebRTC is a transport optimization. The authority still comes from content
hashes, assignment IDs, validation policy, and replayable receipts.

Current WebRTC claim:

- `plasma-control`, `plasma-data`, and `plasma-receipts` are exercised in
  controlled staff smokes.
- accepted WebRTC data-plane receipts are still ingested and validated through
  the normal coordinator path.
- strict WebRTC proof tasks can require `requiredTransport: "webrtc"` and
  `requiredPeerSubreceipt: true`, so a proof task cannot silently fall back to
  HTTP and still count as WebRTC evidence.
- each strict WebRTC parent receipt must link to an accepted server-issued peer
  subassignment from the remote worker, with a signed subreceipt bound to pair,
  parent assignment, chunk, input hash, and output hash.
- no relay was observed in the latest controlled production smokes, but TURN/NAT
  diversity is not yet a public-coverage claim.

Remaining before public-open use:

- public admission/rate-limit/Sybil controls
- NAT-diverse TURN policy and metrics
- retry, timeout, and stale-pair cleanup dashboards
- public receipt inspector copy that avoids overstating host trust

## Product Framing

Call this “contribute idle cycles” in the product. Users should understand:

- it is opt-in
- it pauses when hidden or on low battery
- it runs off-thread
- it earns local credit/reputation
- it helps public verification and experiments

Do not sell “the swarm” as the feature. The feature is faster verification and
useful public compute that gets better when spectators participate.

Use “receipt-carrying volunteer compute” until the proof stack is real. A
receipt says what assignment ran, what output hash came back, which validation
policy accepted it, and how the peer was credited. It is not yet a claim that
the contributor's host, browser, or GPU was fully trusted.

The strongest current claim is: controlled opted-in browsers can exchange
public deterministic work over WebRTC, receive server-issued peer
subassignments, return assignment-bound signed receipts with linked
peer-signed subreceipts, and have those receipts accepted by the sidecar
validator without affecting ranked authority.
