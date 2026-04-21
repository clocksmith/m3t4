# Compute Lab Plan

This document is the canonical plan for introducing `plasma-lab` as an
isolated, opt-in volunteer compute sidecar for m3t4.

## Current Name And Claim

The current implementation is **Receipt-Carrying Spectator Compute**:

- isolated sidecar service
- opt-in browser worker
- renderer-budgeted slack execution
- public/advisory inputs only
- assignment-bound receipts
- quorum or expected-hash validation
- no ranked authority

It is also fair to call the current shape **Chaperoned Sidecar Compute**.

Do not describe the current implementation as fused-kernel, zero-copy,
shared-buffer, or "every game frame is a science frame." The browser worker
creates its own task inputs and execution buffers, and the renderer keeps first
claim on the device. Plasma-lab can collect receipts and accepted summaries,
but those receipts are sidecar evidence until a later derived-compute contract
binds source frame/artifact hashes, shared buffer regions, producer kernels,
and derived output hashes.

Future names are reserved for later milestones:

- **Receipt-Verified Shared-Buffer Compute**: public/redacted buffer regions are
  explicitly shared under a Plasma contract and receipts bind region hashes.
- **Fused-Kernel Chaperoned Compute**: one admitted dispatch/pass produces both
  a game-visible result and a useful derived output under dual validation.

## Boundary

The game is authoritative. The compute lab is advisory.

The renderer owns the device. Compute borrows measured slack.

Compute results are never authoritative until accepted by validator policy, and
even accepted summaries remain advisory to ranked. Accepted compute summaries
may later decorate the game, but they must not decide the game.

The compute lab must never receive or control:

- private ranked configs
- hidden brain logic
- ranked execution authority
- Elo mutation authority
- roster mutation authority
- match scheduling authority
- Live stream dependency
- shared render/game buffers unless a Plasma derived-compute contract declares
  public/redacted buffer regions, lifetimes, source hashes, and validation
  policy

## Planes

The existing game plane stays focused on the current product:

```text
arena-worker
  schedules ranked matches
  runs authoritative simulations
  emits firehose events
  updates Elo

arena-server
  serves auth, roster, leaderboard, status, Live WS fanout
  exposes public match/replay metadata

client Live
  renders server frames/events
```

Add a separate sidecar plane:

```text
plasma-lab
  worker registration
  capability tracking
  task queue
  assignment issuing
  receipt ingestion
  duplicate/quorum validation
  reputation/credit accounting
  receipt summary API
  admin/receipt dashboard
```

The data flow is one-way:

```text
game -> public artifacts -> compute lab -> accepted summaries -> optional UI badge
```

Never:

```text
game <-> compute lab <-> ranked authority
```

Shared-buffer or fused-kernel experiments, when they exist, must remain
non-ranked and non-private until Plasma has a derived-compute extension and the
m3t4 implementation has a public fixture proving it does not expose hidden
brain logic, private roster configs, auth material, or mutable ranked state.

## Service

Use one service name consistently: `plasma-lab`.

Deploy it as its own Cloud Run service with separate logs, scaling, IAM,
environment variables, rate limits, and kill switches. The main `arena-server`
must not import the compute coordinator into the ranked path.

The implementation supports an in-memory store for local/dev and an optional
Firestore-backed store for staged Cloud Run testing:

```text
PLASMA_LAB_STORE_BACKEND=memory|firestore
PLASMA_LAB_FIRESTORE_PROJECT_ID=<optional separate compute project>
```

Same-project collection naming is useful for code organization, but it is not
a hard read boundary when the Admin SDK has broad Firestore credentials. For
strict isolation, deploy `plasma-lab` with a service account that can access a
separate compute project/database/bucket and cannot access ranked private
collections.

## Storage

Do not reuse ranked/private collections. Compute-owned collections:

```text
compute_workers
compute_capabilities
compute_tasks
compute_chunks
compute_assignments
compute_receipts
compute_validations
compute_reputation
compute_artifact_exports
compute_sessions
compute_webrtc_sessions
compute_webrtc_pairs
compute_capability_observations
compute_connectivity_observations
compute_worker_profiles
compute_device_classes
compute_network_classes
compute_public_stats
compute_replay_badges
```

The compute service may store references to public game artifacts:

```text
matchId
replayHash
rulesHash
stageHash
artifactHash
publicFrameHash
publicActionLogHash
resultHash
```

The game plane exports sanitized replay summaries to:

```text
Firestore: publicReplayArtifacts/{matchId}
HTTP:      GET /api/replays/public-artifact/:matchId
```

The public envelope contains `payload`, `artifactHash`, and `artifactSha256`.
`payload` is canonicalized and hashed; it contains public tuple metadata, public
player refs, result hashes, action-log hashes, and frame metadata, but not
private bot configs.

It must not store or receive:

```text
private BrainConfig
private ranked slot configs
hidden brain source/decision code
stable private configs
Elo write authority
roster mutation authority
match scheduling authority
```

Enforce this with IAM. The `plasma-lab` service account should not have
permissions to read private ranked config collections. The game service may
export public artifacts into a public-artifact namespace. The compute service
reads those public artifacts and writes receipts/summaries.

## Flags

Initial flags:

```text
FEATURE_COMPUTE_LAB_ROUTES=false
FEATURE_COMPUTE_TASK_ADMIN=false
FEATURE_COMPUTE_SLACK_WORKER=false
FEATURE_COMPUTE_WEBRTC_SIGNALING=false
FEATURE_COMPUTE_WEBRTC_DATA=false
FEATURE_COMPUTE_RECEIPT_DASHBOARD=false
FEATURE_COMPUTE_LIVE_BADGES=false
```

Operational kill switch:

```text
COMPUTE_ACCEPT_ASSIGNMENTS=false
```

That stops issuing new work without hiding old receipts or tearing down
dashboards. If it is flipped off, already-issued assignments may report until
their deadline; remaining work becomes no-fault timeout/cancelled.

## Transport

Use HTTP as the control, signaling, fallback, and observability plane.

Use Plasma WebRTC as the optional peer/data plane behind flags.

The rule:

```text
same task
same chunk
same assignment
same receipt
same validation policy
different transport
```

Transport cannot change truth semantics.

## HTTP Control Plane

Worker endpoints:

```text
POST /compute/workers/register
POST /compute/workers/heartbeat
GET  /compute/workers/status
POST /compute/capabilities
POST /compute/connectivity
GET  /compute/tasks/next
POST /compute/assignments/accept
POST /compute/receipts
GET  /compute/status
GET  /compute/healthz
GET  /compute/use-cases
GET  /compute/public/stats
GET  /compute/public/replay-badges/:matchId
```

Admin/debug endpoints behind admin auth:

```text
POST /compute/admin/assignments
POST /compute/admin/tasks/seed
POST /compute/admin/tasks/device-witness-webgpu
POST /compute/admin/tasks/device-witness-render
POST /compute/admin/tasks/device-witness-derived-buffer
POST /compute/admin/tasks/device-witness-webrtc
POST /compute/admin/tasks/public-artifact
POST /compute/admin/tasks/seed-sweep
POST /compute/admin/tasks/:taskId/cancel
GET  /compute/admin/tasks/:taskId
GET  /compute/admin/receipts/:receiptId
GET  /compute/admin/dashboard
GET  /compute/admin/dashboard.html
GET  /compute/admin/worker-profiles
GET  /compute/admin/public-stats
GET  /compute/admin/replay-badges/:matchId
GET  /compute/admin/capability-map
GET  /compute/admin/connectivity-map
```

Device Witness raw data is admin-only in this phase. Raw workers, receipts,
capabilities, connectivity observations, and aggregate maps are not public.
`/compute/public/stats` is privacy-suppressed until the worker count passes the
configured anonymity floor. Replay badges expose artifact verification status,
not who computed it.

The admin dashboard includes a redacted WebRTC pair list for staff pairing
tests: pair status, offer/answer presence, candidate counts, and expiry. It
must not expose pair tokens or raw SDP/candidate payloads in summary views.

HTTP WebRTC signaling endpoints, enabled only by
`FEATURE_COMPUTE_WEBRTC_SIGNALING=true`:

```text
POST /compute/webrtc/sessions
POST /compute/webrtc/sessions/:sessionId/offer
POST /compute/webrtc/sessions/:sessionId/answer
POST /compute/webrtc/sessions/:sessionId/candidates
GET  /compute/webrtc/sessions/:sessionId/candidates
POST /compute/webrtc/sessions/:sessionId/close
GET  /compute/webrtc/ice-config
POST /compute/webrtc/pairs/join
GET  /compute/webrtc/pairs/:pairId
POST /compute/webrtc/pairs/:pairId/offer
POST /compute/webrtc/pairs/:pairId/answer
POST /compute/webrtc/pairs/:pairId/candidates
POST /compute/webrtc/pairs/:pairId/close
```

The `/pairs` routes are the first real two-browser measurement path. They are
still advisory: clients submit only bucketed connectivity observations and the
raw signaling payloads stay inside the short-lived signaling store. TURN is
disabled unless `FEATURE_COMPUTE_WEBRTC_TURN=true` and explicit TURN credentials
are configured; use it as a measured fallback with cost guards, not as the
default path.

## Plasma WebRTC

Keep the Plasma channel names unchanged:

```text
plasma-control
plasma-data
plasma-receipts
```

Suggested use:

```text
plasma-control
  hello
  capability
  task-offer
  chunk-assign
  pause
  resume
  cancel

plasma-data
  chunk input bytes
  artifact fragments
  result fragments

plasma-receipts
  execution receipt
  validation receipt
  receipt acknowledgement
```

Server-side signaling should handle opaque SDP/candidate payloads, not
instantiate browser `RTCPeerConnection`. Browser WebRTC code belongs in a
browser package.

Add ops gates before public WebRTC:

```text
STUN/TURN config
TURN budget guard
session TTL
max candidates/session
HTTP fallback when ICE fails
```

Current implementation status:

```text
FEATURE_COMPUTE_WEBRTC_SIGNALING=false by default
POST /compute/webrtc/sessions creates an opaque signaling session
POST offer/answer/candidates stores opaque browser payloads
GET candidates reads the session using x-webrtc-session-token
FEATURE_COMPUTE_WEBRTC_DATA still gates actual data-channel work
```

## Plasma Slice

Do not import sibling repo files ad hoc.

Before production imports, create stable package boundaries in Plasma or vendor
the minimal slice into `plasma-lab` with a source commit note:

```text
packages/plasma-contract
  task/chunk/receipt/session types
  envelope types
  determinism classes
  validation policy types

packages/plasma-core
  canonical hashing
  envelope validation
  memory transport
  protocol routing
  validator helpers

packages/plasma-browser-webrtc
  DataChannel transport
  WebRTC channel setup
  browser-only types

packages/plasma-node-coordinator
  assignment issuing
  receipt ingestion helpers
  validation orchestration
```

The first m3t4 slice vendors only minimal contract/runtime primitives into
`plasma-lab/src/plasma`.

## Worker Lifecycle

Worker lifecycle:

```text
unregistered
registered
heartbeat-ok
capability-known
offered-assignment
assignment-accepted
connected
executing
receipted
validating
accepted | rejected | timeout | no-quorum
credited | not-credited
```

Refusing work is normal. A browser may say:

```text
not-now
render-struggling
tab-hidden
low-battery
chunk-too-large
unsupported-kernel
user-disabled
```

Every worker session receives a short-lived session token. Every assignment
receives an assignment token. Receipts must bind:

```text
workerId
workerSessionId
workerSessionToken
assignmentId
assignmentToken
taskId
chunkId
inputHash
outputHash
```

## Receipt Shape

Every receipt binds to an assignment, not just a chunk.

Receipt fields:

```text
receiptId
workerId
workerSessionId
assignmentId
taskId
chunkId
kernelId
kernelHash
inputHash
artifactHash
outputHash
determinismClass
validationMode
executionMode: cpu | webgpu
transport: http | webrtc
governorMode: quiet | standard | after-match
deviceClass
adapterInfo
computeMs
receivedAt
clientVersion
signature
```

Durable public-ish receipt logs should avoid raw fingerprinting data. Store
adapter/device values as buckets or hashes where possible:

```text
gpuVendorBucket
browserFamily
capabilityHash
maxBufferBucket
```

## Receipt States

Keep failure states separate:

```text
pending
accepted
rejected
timeout
quorum-missing
disagreement
malformed
assignment-mismatch
input-mismatch
output-mismatch
kernel-mismatch
validator-error
internal-error
```

Timeout is not the same as a wrong answer.

## Determinism

Use Plasma determinism classes as the protocol field:

```text
bit-exact
tolerance-bounded
replicated-quorum
```

Use separate runtime and validation fields:

```text
runtimeSurface: browser-js | browser-wasm | browser-webgpu | cpu-reference
validationMode: expected-hash | quorum | tolerance | human-review
```

Do not pretend all browser compute is byte-stable. A task declares its
determinism class and validation policy.

## Workloads

### Device Witness

Device Witness is the first browser-diversity bundle. The browser proves what
kind of machine/network/render stack it is, using tiny opt-in probes that are
safe to run beside Live.

Implemented Phase 1 observations:

```text
device_witness.webgpu.v0
  adapter availability bucket
  vendor/features/buffer-size buckets
  tiny u32 buffer transform
  expected-output correctness bucket
  latency/throughput buckets

device_witness.webrtc.v0
  HTTP health RTT bucket
  browser network API buckets
  local RTCPeerConnection/datachannel open bucket
  ICE gather bucket
  host/srflx/relay candidate buckets
  optional STUN success bucket from COMPUTE_STUN_URLS

device_witness.render_fixture.v0
  worker-side OffscreenCanvas alpha/compositing fixture
  pixel tolerance pass/fail bucket
  fixture latency bucket
```

These reports are scheduler intelligence, not ranked truth. They answer:

```text
which browsers can run WebGPU correctly
which devices are fast enough without hurting rendering
which clients have viable WebRTC primitives
which browser/render stacks drift on tiny fixtures
```

Storage:

```text
compute_capability_observations
compute_connectivity_observations
```

Visibility:

```text
raw observations: admin-only
aggregate maps: admin-only initially
future public stats: counts only, no worker ids, no rare fingerprints
```

Phase 1.5 promotes all three Device Witness probes into assignment-bound
receipts:

```text
device_witness.webgpu.v0
  coordinator issues seed/count challenge
  browser worker runs the u32 transform on WebGPU
  receipt carries assignmentId, kernelHash, inputHash, outputHash, duration
  validator checks expected output hash

device_witness.render_fixture.v0
  coordinator issues canvas2d-alpha-samples-v1 challenge
  browser worker samples known pixels from OffscreenCanvas
  receipt carries assignmentId, kernelHash, inputHash, outputHash, duration
  validator checks expected sample-byte hash

device_witness.webrtc.v0
  coordinator issues local-datachannel-transcript-v1 challenge
  browser performs local RTCPeerConnection/datachannel probe
  receipt carries assignmentId, kernelHash, inputHash, transcript hash, duration
  validator checks hash over issued challenge params and whitelisted buckets
  raw SDP, raw ICE candidates, IPs, ISP, and exact location are not stored
```

Admin seed routes:

```text
POST /compute/admin/tasks/device-witness-webgpu
POST /compute/admin/tasks/device-witness-render
POST /compute/admin/tasks/device-witness-derived-buffer
POST /compute/admin/tasks/device-witness-webrtc
```

`prime-search.v0` is plumbing only. Timebox it. It proves:

```text
register worker
advertise capability
assign chunk
execute off-thread
hash output
submit receipt
duplicate on another worker
validate agreement
credit accepted receipts
record timeout/disagreement separately
```

The first useful m3t4 workload should be split into two claims:

```text
m3t4.public_artifact_verify.v0
  verifies public artifact bytes/checkpoints match exported hashes

m3t4.seed_sweep.v0
  runs deterministic public-preset seed batches for meta-health diagnostics

m3t4.replay_verify.v1
  verifies public replay/action/checkpoint data reproduces expected result
```

`m3t4.public_artifact_verify.v0` inputs:

```text
matchId
rulesHash
stageHash
artifactHash
public artifact bytes or URL
expected public output hash
verification mode
```

Output:

```text
computedHash
accepted/rejected candidate
runtimeMs
deviceClass
receiptHash
```

Acceptance requires:

```text
assignmentId matches an issued assignment
taskId/chunkId/kernelHash/inputHash match contract
artifactHash/rulesHash/stageHash match public artifact
outputHash equals expected public artifact hash
minAgreeing receipts satisfy validation policy
validator records a reasoned outcome
```

Quorum agreement alone is not enough.

Current implementation status:

```text
server exports PublicReplayArtifactV1
plasma-lab seeds m3t4.public_artifact_verify.v0 from that envelope
workers verify artifactSha256 by hashing canonical payload JSON
2-of-2 expected-hash validation accepts the chunk
npm -w plasma-lab run smoke exercises this path locally or against a deploy
```

`m3t4.seed_sweep.v0` is implemented as a server-side/reference workload only:

```text
inputs: public stage id, public preset A, public preset B, seed range
outputs: canonical summary JSON hash with winner/score/round/tick/logHash rows
limits: max 512 seeds per task, max 64 seeds per chunk
route: POST /compute/admin/tasks/seed-sweep
browser: not advertised by the hidden spectator worker yet
```

This targets use cases 2 and 8 from the ladder: seed sweeps and balance
diagnostics. It intentionally excludes private roster configs.

## Public Artifact Export

After a ranked match is archived, the game plane writes an immutable public
artifact summary:

```text
matchId
publicTuplePath
artifactHash
artifactSha256
stageHash
actionLogHash
actionLogSha256
expectedLogHash
expectedResult
frameLogHash
createdAt
```

Export is passive and non-blocking. If export fails, ranked still works.

Public export must exclude:

```text
private bot configs
hidden brain decisions
raw opponent configs
auth/user tokens
server secrets
non-public strategy internals
```

## Slack Governor

The browser gets a small opt-in controller separate from the renderer.

Current browser slice:

```text
client/lib/compute.js
client/workers/plasma-worker.js
window.__M3T4_COMPUTE_SLACK_WORKER__ = false by default
window.__M3T4_COMPUTE_LAB_ORIGIN__ must be set
window.m3t4Compute.start("quiet") is the hidden staff opt-in
capability reporting sends only coarse buckets after opt-in
```

It observes:

```text
recent frame times
p95 frame time
dropped-frame bursts
document visibility
battery state
low-power mode where detectable
mobile/device class
recent user interaction
match phase: active | countdown | intermission | reconnecting
WebGPU availability
```

Capability mapping currently reports:

```text
deviceClass
browser family bucket
hardware concurrency bucket
WebGPU available | unavailable | no-adapter | probe-failed
GPU vendor bucket
feature-count bucket
buffer-size buckets
one tiny WebGPU compute benchmark bucket after opt-in
WebGPU expected-output correctness bucket
WebGPU mismatch-count bucket
worker fixture status
OffscreenCanvas alpha/compositing fixture bucket
kernel latency bucket
throughput bucket
render p95 bucket
dropped-frame burst bucket
hidden/low-battery/render-struggle pause buckets
battery bucket
visibility bucket
capabilityHash over the bucketed capability record
```

It does not send raw adapter names, raw device strings, or private configs.
The browser refreshes capability reports periodically through
`POST /compute/capabilities`; these reports are advisory scheduler hints, not
validation truth. The dashboard aggregates current worker capability under
`capabilityMap` and historical observations under `capabilityObservationMap`.

Connectivity witness reports are submitted through `POST /compute/connectivity`
after opt-in. The browser records only buckets: HTTP RTT, Network Information
API class, local WebRTC datachannel open latency, ICE gather timing, candidate
type availability, visibility, and battery state. It does not submit IP
addresses, ICE candidate strings, SDP, ISP, or exact location.

Conservative first policy:

```text
p95 frame < 10ms
  allow small GPU chunks

p95 frame 10-14ms
  CPU or tiny GPU chunks only

p95 frame > 14ms
  pause compute

any dropped-frame burst
  pause compute for 5-10s

hidden tab
  pause GPU work by default

mobile
  off or quiet by default

low battery / low power
  pause

user interaction
  pause briefly
```

The server or peer may offer work. The browser decides whether it is polite to
run now.

Good shape:

```text
Live renderer reports health metrics
Slack governor subscribes to metrics
Compute worker runs separately
Renderer never waits for compute
```

Bad shape:

```text
render loop awaits compute
playback depends on compute state
WS playback blocked by compute work
frame decode shares synchronous heavy work with compute
```

Compute chunks must be bounded and preemptible between work units. If a task
cannot be chunked politely, it is not a good spectator workload yet.

## User Modes

User-facing modes:

```text
off
quiet
standard
after-match only
```

Public default:

```text
off
```

Do not use words like max, turbo, mining, or boost.

Public users must explicitly opt in. The UI should explain:

```text
Your browser may verify public replay artifacts when Live has spare frame budget.
It never sees private bot configs or controls ranked outcomes.
You can turn this off at any time.
```

## Dashboard

Build the receipt dashboard before public opt-in or staff/friends Live alpha.

Admin dashboard should show:

```text
active workers
registered workers
capability mix
pending tasks
running assignments
completed chunks
receipt accept rate
disagreement rate
timeout rate
avg/p95 computeMs
validation reasons
top pause reasons
frame-time impact
Device Witness WebGPU correctness buckets
Device Witness WebRTC/ICE buckets
Device Witness rendering fixture buckets
derived worker/device/network profiles
privacy-suppressed public stats
verified replay badges
```

Core product metric:

```text
verified useful artifacts per spectator-minute without hurting frame time
```

Do not optimize for raw compute.

## Rollout

Rollout order:

```text
1. local only, MemoryEnvelopeTransport, seeded prime tasks
2. local HTTP control plane, prime receipts
3. staging plasma-lab service, no client UI
4. replay/public-artifact verify adapter over HTTP
5. admin receipt dashboard
6. same-browser WebRTC loopback
7. two-browser LAN/WebRTC test
8. derived worker/device/network profiles
9. replay verification badge endpoint
10. closed alpha WebRTC lab
11. hidden client opt-in panel behind flag
12. staff/friends alpha on Live
13. replay verification tasks only
14. public opt-in compute panel
15. public volunteer-verified replay badge
```

Rollback options:

```text
FEATURE_COMPUTE_SLACK_WORKER=false
FEATURE_COMPUTE_WEBRTC_DATA=false
FEATURE_COMPUTE_WEBRTC_SIGNALING=false
FEATURE_COMPUTE_LAB_ROUTES=false
COMPUTE_ACCEPT_ASSIGNMENTS=false
scale plasma-lab to zero
```

The game remains up.

## First Visible Win

Do not announce "P2P is live."

Show something useful:

```text
This replay was checked by volunteer compute.
2/2 receipts agreed.
rules hash: ...
replay hash: ...
verified at: ...
```

## Allowed Deeper Integrations

Read-only integrations only:

```text
verified replay badge
compute credit
receipt inspector
public meta-health reports
capability stats
replay verification history
```

## Forbidden Deeper Integrations

Do not use compute lab to:

```text
decide ranked outcomes
run hidden brains
mutate Elo
schedule matches
inspect private configs
block Live playback
replace arena-worker authority
```

## First Build Slice

The first slice is:

```text
docs/compute-lab-plan.md
minimal plasma contract package/vendor slice
separate plasma-lab service skeleton
separate compute storage collection names
HTTP worker registration
HTTP task assignment
HTTP assignment acceptance
HTTP receipt submission
prime-search.v0 plumbing
public_artifact_verify.v0 task contract
admin status endpoint
no public UI
```

The second slice adds:

```text
server/src/public-artifacts.ts
publicReplayArtifacts store projection
GET /api/replays/public-artifact/:matchId
m3t4.public_artifact_verify.v0 kernel
HTTP admin seeding for public artifact verification
tests for config redaction and receipt acceptance
```

The third slice adds:

```text
PLASMA_LAB_STORE_BACKEND=firestore
compute_* Firestore collection names and server-only rules
plasma-lab/Dockerfile
plasma-lab/cloudbuild.yaml
GET /compute/admin/dashboard.html
npm -w plasma-lab run smoke
HTTP WebRTC signaling skeleton behind FEATURE_COMPUTE_WEBRTC_SIGNALING
m3t4.seed_sweep.v0 for public preset seed sweeps
bucketed browser capability reporting after opt-in
WebGPU micro-benchmark and runtime-health buckets for capability mapping
GET /compute/use-cases reports implemented/experimental/planned advisory uses
```

The fourth slice adds:

```text
Device Witness bundle
POST /compute/connectivity
compute_capability_observations persisted and capped
compute_connectivity_observations persisted and capped
admin-only capability/connectivity maps
WebGPU expected-output correctness probe
optional COMPUTE_STUN_URLS exposed to the opt-in browser witness
worker-side OffscreenCanvas rendering fixture probe
WebRTC local datachannel and ICE bucket probe
WebRTC two-browser pairing/signaling probe behind flag
derived worker/device/network profiles
privacy-suppressed public stats
public replay badge endpoint for verified artifacts
```

The fifth slice promotes all three Device Witness probes to receipts:

```text
device_witness.webgpu.v0 task kind
device_witness.render_fixture.v0 task kind
device_witness.webrtc.v0 task kind
server-side expected output reference kernels for WebGPU/render
measurement validation for WebRTC transcript receipts
browser execution for assignment-bound WebGPU/render/WebRTC challenges
admin seeding for all three witness tasks
compute_receipts validation for all three witness tasks
```

The spectator GPU can be "double spent" only as slack. The arena always gets
first claim. The compute lab earns trust by verifying public artifacts, not by
touching ranked authority.
