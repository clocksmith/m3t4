# m3t4 Architecture

m3t4 is split by authority, not by transport. Firebase is the production
control plane. WebRTC and browser workers move public bytes and public compute,
but they never own ranked truth.

## Authority model

| Surface | Authority | Transport | Canonical writes |
| --- | --- | --- | --- |
| Static spectate | baked artifacts | Firebase Hosting | none at runtime |
| Live match chain | Firebase Functions | Cloud Tasks + Firestore | `matches`, `stables`, `publicStables`, `state/matchChain` |
| Profile/submission | Firebase Functions | callable HTTPS | `stables`, `publicStables`, `handles` |
| Spectator mesh | Functions + Firestore signaling | WebRTC data channel | transient `webrtc`, `meshSessions` |
| Browser compute | Firebase Functions | WebRTC first, worker fallback | `compute_assignments`, `compute_receipts`, aggregate stats |
| Local practice | client only | in-browser sim | none |
| Legacy server | Cloud Run | REST/WebSocket | rollback/dev only |

## Core invariants

- `sim/` is deterministic for a fixed rules hash, stage, seed, configs, and
  action log.
- `match-engine/` contains pure match selection/run helpers used by Functions.
- Private stable configs are never sent to spectator or compute peers.
- Firestore rules block browser writes to authority collections; Functions use
  Admin SDK for validated mutations.
- Expected output hashes for compute assignments are server-held.
- WebRTC is an optimization for fanout and peer execution, not a proof of
  correctness.
- Compute is advisory. Accepted compute receipts cannot alter Elo, roster,
  match scheduling, private configs, or ranked outcomes.

## Runtime planes

```text
Presentation plane
  Firebase Hosting
  client/modes/spectate.js
  client/modes/profile.js
  client/modes/compute.js

Authority plane
  functions/src/submitStable.ts
  functions/src/claimHandle.ts
  functions/src/matchTick.ts
  functions/src/bootstrapMatch.ts
  functions/src/compute.ts

State plane
  Firestore collections under infra/firestore.rules

Peer plane
  functions/src/webrtcSignal.ts
  client/lib/peer-mesh.js
  client/lib/firebase-compute.js

Kernel plane
  client/workers/plasma-worker.js
  plasma-lab/src/kernels/* reference implementations
```

## Match feeds

### Static feed

Static mode is the default cost floor. `scripts/generate-static-matches.cjs`
writes public match docs under `client/matches/`. The client reads
`/matches/index.json`, chooses the current scheduled entry by wall clock, and
loops the schedule locally.

No Functions, Firestore reads, Cloud Tasks, or Cloud Scheduler jobs are required
for static mode.

### Live Firebase feed

Live mode is activated by client config and deployed Functions:

1. `bootstrapMatch` acquires or resets the `state/matchChain` lock.
2. `matchTick` loads active stables from Firestore. If fewer than two player
   slots are available, it adds system preset fallbacks.
3. The deterministic sim runs inside Functions through `match-engine` and
   `@m3t4/sim`.
4. The Function writes a compact public `matches/{matchId}` document with
   action log and public refs.
5. Elo, slot stats, and `publicStables/{uid}` projections are updated.
6. The next `matchTick` is enqueued through Cloud Tasks.
7. `matchTickWatchdog` is a repair loop only. It kicks the chain if the head is
   stale or missing.
8. `releaseChampionCandidates`, when enabled, evaluates the frontier on cron
   `0 */6 * * *` and writes each selected candidate as a durable system player.
   The scheduled timestamp makes retries idempotent. Public bot names come from
   a deterministic 65,536-name space, and releases are recorded in
   `publicBotEvents`.

This avoids an always-on arena worker while keeping a single authoritative
match chain.

## Spectator mesh

The spectator mesh uses the same stateless signaling pattern as compute:

- `webrtcSignal` validates a short callable request and writes offer/answer/ICE
  payloads to `webrtc/{sessionId}`.
- Clients subscribe to the Firestore signaling doc with `onSnapshot`.
- Once the WebRTC data channel opens, match/action bytes move peer-to-peer.
- `meshSessions/{matchId}/peers/{peerId}` is ephemeral presence/discovery.
- `expireSessions` deletes stale signaling/presence docs.

If the mesh cannot establish, spectators fall back to Firestore live feed or
static match docs.

## Browser compute

The Firebase compute path is a small notary and validation layer:

1. A browser opts in and authenticates through Firebase Auth, anonymous if the
   user has no account session.
2. `computeRegister` stores worker capability: supported kernels, CPU/WebRTC,
   and WebGPU when `navigator.gpu` exists.
3. `computeClaim` selects a public workload lane. Functions compute the
   reference output hash and store it in `compute_assignments`.
4. The client attempts WebRTC peer execution using the same `webrtcSignal`
   callable.
5. If no peer answers, the client runs the same chunk in
   `client/workers/plasma-worker.js`.
6. `computeSubmitReceipt` accepts or rejects by comparing the submitted hash
   with the stored expected hash.
7. Public stats are aggregate-only.

Current workload lanes are public deterministic kernels only:

- `prime-search.v0`
- `m3t4.seed_sweep.v0`
- `m3t4.exploit_search.v0`
- `asset.tile_audit.v0`
- `ml.image_tile_infer.v0`
- `science.microscopy_tile_score.v0`
- `science.genome_kmer.v0`
- `science.contact_map_tile.v0`
- `science.mandelbrot_tile.v0`
- `science.heat_diffusion_tile.v0`
- `plasma.tensor_tile.v0`
- `device_witness.webgpu.v0`
- `device_witness.render_fixture.v0`
- `device_witness.derived_buffer.v0`

Public-artifact and replay-verify kernels remain available in the plasma worker
and legacy sidecar tooling, but the Firebase auto-claim generator only mints
safe public workload families it can construct from local public params.

## Firestore data model

```text
stables/{uid}
  private player handle, slots, configs, Elo/stat fields
  browser read: owner only
  browser write: never

publicStables/{uid}
  public projection with handle, slot names, Elo/stat summaries, no configs
  browser read: public
  browser write: never

handles/{handle}
  uniqueness index
  browser read/write: never

matches/{matchId}
  public match metadata, action log, frame/replay refs
  browser read: public when live mode enabled
  browser write: never

state/matchChain
  chain head, locks, next schedule metadata
  browser read/write: never

webrtc/{sessionId}
  transient signaling payloads
  writes through webrtcSignal only

meshSessions/{matchId}/peers/{peerId}
  spectator relay presence
  browser self-scoped write

compute_workers/{workerId}
compute_assignments/{assignmentId}
compute_receipts/{receiptId}
compute_peer_presence/{peerId}
compute_public_stats/latest
  browser compute state; authority writes through Functions except peer presence
```

## Auth and profiles

- Firebase Auth is the browser identity layer.
- Profile reads use `stables/{uid}` owner-read and `publicStables` for public
  views.
- `claimHandle` mediates handle uniqueness.
- `submitStable` validates config compilation, rate-limits by uid/slot, writes
  private stable state, and updates public projections.
- Security rules do not allow direct browser writes to private ranked state.

## Legacy Cloud Run services

`server/` and Cloud Run provisioning remain in source for rollback and local
experiments. They are no longer the preferred production path for ordinary
m3t4.ai operation.

`plasma-lab` Cloud Run remains useful for staff smoke tests, receipt-log work,
and advanced sidecar experiments. Production Firebase compute uses the same
kernel/reference code without requiring that sidecar to be deployed.

## Non-goals

- Do not decentralize ranked Elo.
- Do not expose private ranked configs to public spectators or compute workers.
- Do not claim WebRTC execution proves honest hardware/GPU execution.
- Do not claim anonymous Sybil-resistant public compute.
- Do not let compute receipts decorate or mutate ranked authority without a
  later explicit bridge contract.
