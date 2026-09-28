# m3t4.ai / Meta Muzil

A simulated-phone game about finishing what you opened your phone to do.
The new homepage contains working apps, outcome-based tasks, demonstrations,
replay, paired races, and opt-in model controllers. The previous arena remains
at `/history` and its original routes.

```sh
npm install
npm run sync:runtime   # uses ../reploid and ../doppler; copies no model weights
npm run dev           # http://localhost:7788
npm run test:muzil
npm run test:muzil:browser
```

The page does not load Reploid or Doppler until the relevant connection/execution
control is used. A prepared peer can execute inference for a requester without
weights. Automatic mesh discovery, remote partition placement, selective weight
acquisition, and replacement recovery are not yet connected to this page.

See [implementation, local library copies, and acceptance](docs/meta-muzil.md).
This source change is not a deployment claim.

---

# Historical m3t4 arena

m3t4.ai is a deterministic bot-design arena. Players build fighter brains from
bounded JSON configs, watch scheduled matches, and can opt in to advisory
browser compute that runs public deterministic workloads through Firebase
Functions, Firestore signaling, WebRTC, and the local plasma worker.

**Public site**: https://m3t4.ai

## Current production shape

The cheapest production path is Firebase-first:

- **Firebase Hosting** serves the static SPA and baked match archive.
- **Firebase Auth** identifies players and anonymous compute/spectate peers.
- **Firestore** stores private stables, public projections, match docs,
  mesh presence, signaling docs, and compute receipts.
- **Firebase Functions Gen 2** owns submission validation, handle claims,
  authoritative live match ticks, WebRTC signaling writes, session cleanup,
  and expected-hash compute validation.
- **Cloud Tasks** can chain authoritative live matches at match-end cadence.
- **Cloud Scheduler** is only a watchdog/cleanup layer, not the primary match
  loop.
- **WebRTC data channels** move spectate and compute bytes between browsers
  when peers are available.
- **`plasma-lab`** is now the shared deterministic kernel/reference library and
  legacy staff sidecar. It is not the default production coordinator.

Static hosting mode remains valid: the site can run at near-zero backend cost by
looping pre-generated matches from `client/matches/`.

## Product vision

One browser session carries two authority lanes:

- **Game lane**: ranked or scheduled deterministic matches remain server-owned.
  In static mode they are baked artifacts. In live mode Functions run the sim,
  update Elo, and publish public match docs.
- **Compute lane**: opted-in browsers run public deterministic workloads in a
  worker. Firebase Functions mint assignments, keep expected hashes private,
  validate receipts, and aggregate public stats. WebRTC is a transport, not
  authority.

North-star sentence:

> Players can watch, compete, and optionally donate receipt-carrying browser
> compute, while ranked authority stays server-side and public compute stays
> advisory.

Current public claim boundary:

- Browser compute is opt-in and advisory.
- Browser compute never mutates Elo, private stables, match scheduling, roster
  releases, or ranked outcomes.
- Firebase-authenticated receipts are assignment-bound and expected-hash
  validated by Functions.
- The browser/GPU is not trusted hardware. Correctness comes from deterministic
  public inputs and server-held expected hashes.

## Architecture

```text
Firebase Hosting SPA
  spectate
    static mode: /matches/index.json + baked match docs
    live mode: Firestore current match pointer + matches/{matchId}
    mesh mode: WebRTC fanout, Firestore fallback
  profile
    Firebase Auth
    callable claimHandle / submitStable
    own stables/{uid} read + publicStables projection
  compute
    callable computeRegister / computeClaim / computeSubmitReceipt
    plasma-worker.js executes CPU/WebGPU kernels
    WebRTC peer attempt, local worker fallback

Firebase Functions
  submitStable       validates brain config, rate-limits, writes stables/publicStables
  claimHandle        mediates handle uniqueness
  matchTick          authoritative match sim + Elo/stat updates
  bootstrapMatch     starts/restarts match chain
  matchTickWatchdog  scheduler guard for stalled live chain
  webrtcSignal       stateless signaling write validator
  expireSessions     cleanup for signaling and presence docs
  compute*           browser compute registration, claim, receipt validation, stats

Firestore
  stables/{uid}                         private player state, own-read only
  publicStables/{uid}                   public profile/leaderboard projection
  handles/{handle}                      uniqueness index, server-only
  matches/{matchId}                     public match docs/action logs
  state/matchChain                      live match chain lock/head
  webrtc/{sessionId}                    transient signaling docs
  meshSessions/{matchId}/peers/{peerId} spectator fanout presence
  compute_workers/{workerId}            authenticated worker sessions
  compute_assignments/{assignmentId}    server-held expected hashes
  compute_receipts/{receiptId}          bounded receipt archive
  compute_peer_presence/{peerId}        compute peer discovery
  compute_public_stats/latest           aggregate stats
```

## Match scheduling

There are two match feeds:

- **Static feed**: generated once by `scripts/generate-static-matches.cjs`,
  deployed with Hosting, and looped locally by wall-clock schedule. This is the
  default low-cost mode.
- **Live Firebase feed**: `bootstrapMatch` starts the chain. `matchTick` picks a
  pair from active stables plus system fallbacks, runs the deterministic sim,
  writes `matches/{matchId}`, updates Elo/public projections, and enqueues the
  next tick through Cloud Tasks. `matchTickWatchdog` only repairs a stalled
  chain.

Spectators can consume either feed directly. When mesh mode is enabled, the
first spectator for a match reads Firestore and later spectators receive the
match/action stream over WebRTC; if peers fail, the client falls back to
Firestore/static reads.

## Distributed compute

The Firebase compute path is intentionally small:

1. Browser opts in and signs in anonymously if needed.
2. `computeRegister` records browser capabilities, including CPU/WebRTC/WebGPU.
3. `computeClaim` selects a public kernel lane, creates assignment params, runs
   the matching reference kernel inside Functions, and stores the expected hash
   privately on `compute_assignments/{assignmentId}`.
4. Browser tries WebRTC peer execution first.
5. If no peer answers, the claiming browser computes locally in
   `client/workers/plasma-worker.js`.
6. `computeSubmitReceipt` validates the receipt hash against the server-held
   expected hash and updates aggregate public stats.

Supported production lanes include `prime-search.v0`, public seed sweeps,
exploit search, asset/image/microscopy tiles, genome k-mer, tensor tiles,
contact maps, Mandelbrot, heat diffusion, render fixtures, derived-buffer
witnesses, and WebGPU device witnesses.

## Packages

```text
sim/          deterministic arena sim and replay primitives
match-engine/ live match pair selection, runner, and Elo helpers for Functions
functions/    Firebase Functions control/authority plane
client/       Firebase-hosted SPA, spectate/profile/compute modes
plasma-lab/   deterministic public compute kernels and legacy sidecar tooling
server/       legacy Cloud Run REST/WS arena service, preserved for rollback/dev
pareto/       offline meta/search toolkit, never production authority
infra/        Firestore rules and deployment support
scripts/      static match generation and repo utilities
docs/         architecture, migration, compute, provisioning notes
```

## Quick start

```bash
npm install
npm run build

# Browser UI/render checks: serves a local client, blocks external services.
npx playwright install chromium
npm run test:ui

# Static match generation for hosting-only mode
PROJECT=m3ta-ai node scripts/generate-static-matches.cjs --count=500

# Local legacy API/dev flows remain available under server/ when needed.
```

## Key invariants

- Ranked/live authority is centralized in Functions or baked static artifacts.
- WebRTC is transport only.
- Browsers never receive private configs or server-held expected hashes.
- Compute receipts are advisory and cannot mutate game authority.
- `plasma-lab` kernels are deterministic public workloads; `plasma-lab` Cloud
  Run is not required for the Firebase production path.
- Offline `pareto/` work can inform roster releases but never talks to
  production directly.

## Docs

- `ARCHITECTURE.md` — authority boundaries and runtime architecture.
- `MIGRATION.md` — static/Firebase migration and mode selection.
- `PROVISIONING.md` — Firebase/GCP provisioning runbook.
- `docs/distributed-compute.md` — public-safe compute claim boundary.
- `docs/compute-lab-plan.md` — compute lanes, receipt contract, flags.
- `docs/p2p-migration-plan.md` — mesh rollout plan.

## Licensing

M3T4's original source, checked-in presets, and tuning artifacts are available
under the [MIT License](LICENSE). Third-party dependencies retain their own
licenses; see [third-party notices](THIRD_PARTY_NOTICES.md), including the
GPL-3.0 dependencies used by the optional proof tooling.

Live player stables, credentials, and production database contents remain
private operational data and must not be committed. See the
[public-source review](docs/public-source-review.md) for the publication scope.
