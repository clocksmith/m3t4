# m3t4 migration: Cloud Run services to Firebase-first architecture

## Current target

The target architecture is Firebase Hosting + Firebase Auth + Firestore +
Firebase Functions Gen 2, with WebRTC for peer fanout and browser compute.
Cloud Run arena services are legacy rollback/dev surfaces, not the default
production path.

## Modes

| Mode | Client flag | Backend required | Cost shape |
| --- | --- | --- | --- |
| Static matches | default or `__M3T4_USE_STATIC_MATCHES__ = true` | Hosting only | near-zero |
| Live Firebase feed | `__M3T4_USE_FIREBASE_FEED__ = true` | Firestore + Functions + Cloud Tasks | proportional to matches/spectators |
| Spectator mesh | `__M3T4_USE_WEBRTC_MESH__ = true` | `webrtcSignal` + Firestore presence | lowers Firestore fanout reads |
| Firebase compute | `__M3T4_COMPUTE_FIREBASE__ = true` | compute callables + `webrtcSignal` | proportional to opted-in work |
| Legacy Cloud Run | legacy config | arena-server/arena-worker/plasma-lab | rollback/dev |

## Static mode

Static mode ships generated public match docs with Hosting:

```bash
PROJECT=m3ta-ai node scripts/generate-static-matches.cjs --count=500
firebase deploy --only hosting --project m3ta-ai
```

The browser loads `/matches/index.json`, chooses the current match by local wall
clock, replays frames locally, and loops through the schedule. No Functions,
Firestore listeners, Tasks, Scheduler, Cloud Run, or compute jobs are required.

## Live Firebase match chain

Deploy these pieces when player submissions and live scheduling are needed:

- Firestore rules from `infra/firestore.rules`
- `submitStable`
- `claimHandle`
- `bootstrapMatch`
- `matchTick`
- `matchTickWatchdog`
- `webrtcSignal`
- `expireSessions`

Create the Cloud Tasks queue once:

```bash
gcloud tasks queues create matchchain \
  --location=us-central1 \
  --project=m3ta-ai \
  --max-dispatches-per-second=2 \
  --max-concurrent-dispatches=2 \
  --max-attempts=5
```

Grant the Functions service account Cloud Tasks enqueue and Firestore access.
The live chain flow is:

1. `bootstrapMatch` initializes the chain.
2. `matchTick` picks a pair from active stables plus system fallbacks.
3. `matchTick` runs the sim, writes a public match doc, updates private/public
   stable state, and enqueues the next tick.
4. `matchTickWatchdog` repairs stale chain state.
5. `releaseChampionCandidates` evaluates the configured frontier on cron
   `0 */6 * * *` when the release flag is enabled. Each selected winner becomes
   a durable system player keyed by the scheduled release, with one named bot
   from the deterministic 65,536-name space. Retries reuse the same identity,
   and each release is recorded in `publicBotEvents`.

## Firebase compute path

Deploy these when public advisory compute should work from the hosted client:

- `computeRegister`
- `computeClaim`
- `computeSubmitReceipt`
- `computeMyReceipts`
- `computePublicSummary`
- `webrtcSignal`
- `expireSessions`
- Firestore rules for compute presence/stats

No `plasma-lab` Cloud Run sidecar is required for this path. Functions import
`@m3t4/plasma-lab` reference kernels and the browser uses
`client/workers/plasma-worker.js`.

The browser attempts WebRTC peer execution first and falls back to local worker
execution. Functions validate receipts against server-held expected hashes.

## Build order

The Functions build depends on generated outputs from `sim`, `match-engine`,
and `plasma-lab`:

```bash
npm run build
```

That runs:

```text
sim build
client sim sync
match-engine build
plasma-lab build
functions build
```

Firebase Functions predeploy uses the same dependency order.

## Deploy sequence

```bash
cd /Users/xyz/deco/m3t4

firebase deploy --only firestore:rules --project m3ta-ai
firebase deploy --only functions --project m3ta-ai
firebase deploy --only hosting --project m3ta-ai
```

For a narrow deployment, use named Functions:

```bash
firebase deploy --only functions:submitStable,functions:claimHandle --project m3ta-ai
firebase deploy --only functions:webrtcSignal,functions:expireSessions --project m3ta-ai
firebase deploy --only functions:computeRegister,functions:computeClaim,functions:computeSubmitReceipt,functions:computeMyReceipts,functions:computePublicSummary --project m3ta-ai
```

Do not deploy unless billing, auth, rules, and client config are intentionally
ready.

## Decommissioned legacy pieces

The following are not required for Firebase-first production:

- `arena-server` Cloud Run REST/WebSocket fanout
- `arena-worker` Cloud Run singleton match loop
- `plasma-lab` Cloud Run coordinator
- Hosting rewrites to dead `/api/**` or `/ws` services
- Container/Artifact Registry images from old Cloud Run and failed Functions
  builds

The source directories remain for rollback/dev and for shared kernels.

## Firestore model changes

| Legacy | Firebase-first |
| --- | --- |
| WebSocket firehose | `matches/{matchId}` + current match pointer + optional WebRTC mesh |
| Cloud Run submit routes | callable `submitStable` and `claimHandle` |
| arena-worker loop | Cloud Tasks chained `matchTick` |
| plasma-lab compute coordinator | Firebase compute callables + plasma worker/reference kernels |
| `/api/compute/*` | callable compute Functions |
| `/api/duel/*` signaling | `webrtcSignal` + Firestore transient docs |

## Rollback

Rollback keeps the legacy source available:

1. Disable Firebase live/compute flags in `client/config.js`.
2. Return to static match mode or redeploy Cloud Run arena services from
   `server/` if needed.
3. Keep Firestore rules deployed; they are stricter than the legacy browser
   direct-write model.
4. Pause Cloud Scheduler jobs and delete Cloud Tasks queue if live match chain
   is disabled for an extended maintenance window.

## Cost watchpoints

Watch these after enabling live/compute modes:

- Firestore reads from spectator listeners.
- Firestore writes from `matchTick` and `computeSubmitReceipt`.
- Function invocations from compute polling.
- Cloud Tasks dispatch count.
- Artifact Registry build images after Functions deploys.
- Stale `webrtc`, `meshSessions`, and `compute_peer_presence` docs if cleanup
  is not deployed.

The cost shape should remain proportional to actual users, matches, and opted-in
compute receipts. There should be no self-amplifying worker registration or
server-side auto-seed loop.
