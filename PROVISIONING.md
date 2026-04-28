# Provisioning m3t4.ai (PRIVATE)

**Do not publish.** This is the Firebase-first production runbook. Cloud Run
arena services are preserved as legacy rollback/dev surfaces.

## Prerequisites

- Domain `m3t4.ai` registered and DNS controllable.
- GCP/Firebase project `m3ta-ai` with billing intentionally enabled for live
  Functions modes.
- `gcloud`, `firebase`, and `npm` installed.
- Local checkout at `/Users/xyz/deco/m3t4`.

## Enable services

```bash
gcloud config set project m3ta-ai

gcloud services enable \
  firebase.googleapis.com \
  firestore.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  run.googleapis.com \
  identitytoolkit.googleapis.com \
  artifactregistry.googleapis.com \
  --project=m3ta-ai
```

`run.googleapis.com` is still required because Firebase Functions Gen 2 runs on
Cloud Run under the hood.

## Firebase init

```bash
firebase login
firebase use --add m3ta-ai --alias prod
firebase init hosting firestore functions
```

Settings:

- Hosting public directory: `client`
- Single-page app: yes
- Firestore rules: `infra/firestore.rules`
- Functions source: `functions`
- Runtime: Node.js 22

Create `client/config.js` from `client/config.example.js`. Firebase web config
values are public identifiers, not secrets. Do not put service accounts, admin
tokens, or server secrets in `client/config.js`.

## Auth providers

Firebase Console -> Authentication -> Sign-in method:

- Enable Google.
- Enable GitHub if account linking through GitHub is desired.
- Add `m3t4.ai`, `www.m3t4.ai`, `m3ta-ai.web.app`, and
  `m3ta-ai.firebaseapp.com` to Authorized Domains.

Anonymous auth is required for unauthenticated spectators/compute peers when
Firebase compute or mesh presence is enabled.

## Firestore rules

Deploy:

```bash
firebase deploy --only firestore:rules --project m3ta-ai
```

Important rule boundaries:

- `stables/{uid}`: owner read only, no browser writes.
- `publicStables/{uid}`: public read, no browser writes.
- `handles/{handle}`: server-only.
- `meshSessions/{matchId}/peers/{peerId}`: public read, self-scoped auth write.
- `compute_peer_presence/{peerId}`: public read, self-scoped auth write.
- `compute_public_stats/latest`: public read.
- Authority writes go through Functions using Admin SDK.

## Cloud Tasks queue for live matches

Create once if live match scheduling will be deployed:

```bash
gcloud tasks queues create matchchain \
  --location=us-central1 \
  --project=m3ta-ai \
  --max-dispatches-per-second=2 \
  --max-concurrent-dispatches=2 \
  --max-attempts=5
```

Grant the Functions service account:

```bash
PROJECT=m3ta-ai
SA=${PROJECT}@appspot.gserviceaccount.com

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" \
  --role="roles/cloudtasks.enqueuer"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" \
  --role="roles/datastore.user"
```

## Build

```bash
npm install --workspaces
npm run build
```

The build order compiles `sim`, syncs client sim assets, builds
`match-engine`, builds `plasma-lab` kernel/reference outputs, then builds
`functions`.

## Static Hosting deploy

Use this when operating the near-zero-cost static mode:

```bash
PROJECT=m3ta-ai node scripts/generate-static-matches.cjs --count=500
firebase deploy --only hosting --project m3ta-ai
```

Expected runtime dependencies: Hosting only.

## Functions deploy

Full Functions deployment:

```bash
firebase deploy --only functions --project m3ta-ai
```

Narrow deployments:

```bash
# Auth/profile/submission
firebase deploy --only firestore:rules,functions:claimHandle,functions:submitStable --project m3ta-ai

# Live match chain
firebase deploy --only functions:bootstrapMatch,functions:matchTick,functions:matchTickWatchdog --project m3ta-ai

# Signaling/session cleanup
firebase deploy --only functions:webrtcSignal,functions:expireSessions --project m3ta-ai

# Firebase browser compute
firebase deploy --only functions:computeRegister,functions:computeClaim,functions:computeSubmitReceipt,functions:computeMyReceipts,functions:computePublicSummary --project m3ta-ai
```

After deploying live match Functions, configure the `MATCH_TICK_URL` environment
variable for `matchTick` if the Cloud Tasks helper is not deriving it from the
runtime environment. Then redeploy the affected Function and call
`bootstrapMatch` once.

## Hosting config flags

`client/config.js` controls production behavior:

```js
window.__M3T4_FIREBASE_CONFIG__ = { /* Firebase web config */ };
window.__M3T4_FIREBASE_REGION__ = "us-central1";

// Static mode cost floor.
window.__M3T4_USE_STATIC_MATCHES__ = true;

// Live mode, enable only after Functions/rules/tasks are deployed.
window.__M3T4_USE_FIREBASE_FEED__ = false;
window.__M3T4_USE_WEBRTC_MESH__ = false;

// Advisory browser compute, enable only after compute Functions are deployed.
window.__M3T4_COMPUTE_FIREBASE__ = false;
```

Keep the live and compute flags false until their Functions and rules are
verified in the target project.

## Match chain operation

Bootstrap live mode with the callable after deploy. From an authenticated admin
context or a local callable helper, call `bootstrapMatch` with an empty payload.

Runtime behavior:

- `matchTick` is the only authoritative match executor.
- Cloud Tasks schedules the next tick.
- `matchTickWatchdog` repairs missing/stale chain state.
- If active player stables are insufficient, system preset fallback stables are
  used so the feed stays alive.

Pause live mode by disabling client live flags and pausing/deleting the watchdog
scheduler. Existing match docs remain readable.

## Firebase compute operation

Runtime behavior:

- Browser opt-in registers a worker under Firebase Auth.
- Functions mint public deterministic assignments only.
- Expected hashes stay in `compute_assignments`.
- Browser attempts WebRTC peer execution first.
- Browser falls back to local `plasma-worker.js` execution.
- `computeSubmitReceipt` validates and updates aggregate stats.

Current compute lanes include CPU and WebGPU workloads. Browsers without
WebGPU receive CPU lanes. WebGPU-capable browsers can receive tensor/contact/
Mandelbrot/heat/device-witness lanes.

Disable compute immediately by setting `window.__M3T4_COMPUTE_FIREBASE__ = false`
and redeploying Hosting. Existing receipts remain in Firestore until TTL/cleanup
policy removes them.

## Cleanup

Delete old Cloud Run services if the Firebase path is the active production
path:

```bash
gcloud run services delete arena-server --region=us-central1 --project=m3ta-ai --quiet
gcloud run services delete arena-worker --region=us-central1 --project=m3ta-ai --quiet
gcloud run services delete plasma-lab --region=us-central1 --project=m3ta-ai --quiet
```

Clean old image/build artifacts when no longer needed:

```bash
gcloud artifacts repositories delete gcf-artifacts \
  --location=us-central1 \
  --project=m3ta-ai \
  --quiet

gcloud container images delete gcr.io/m3ta-ai/arena-server --force-delete-tags --quiet
gcloud container images delete gcr.io/m3ta-ai/plasma-lab --force-delete-tags --quiet
```

If a resource is already gone, a not-found response is acceptable.

## Post-deploy checks

Static mode:

```bash
curl -sI https://m3ta-ai.web.app/matches/index.json | head
```

Firebase resources:

```bash
gcloud functions list --project=m3ta-ai --regions=us-central1
gcloud scheduler jobs list --location=us-central1 --project=m3ta-ai
gcloud tasks queues list --location=us-central1 --project=m3ta-ai
gcloud artifacts repositories list --location=us-central1 --project=m3ta-ai
```

Browser checks:

- `/spectate` renders and advances matches.
- `/profile` signs in and reads/writes only through callable Functions.
- `/compute` shows Firebase compute as configured only when the compute flag is
  enabled.
- Browser console has no Firestore permission errors for intended public reads.

## Rollback

Fast rollback to static mode:

1. Set live/mesh/compute flags false in `client/config.js`.
2. Deploy Hosting only.
3. Pause watchdog Scheduler jobs.
4. Leave Functions deployed but idle, or delete them if the cost target requires
   a Hosting-only state.

Legacy Cloud Run rollback:

1. Rebuild and deploy `server/` services from the preserved legacy source.
2. Restore any needed Hosting rewrites/API config.
3. Keep Firebase rules restrictive; do not restore direct browser writes to
   authority collections.

## Cost model

| Service | Static mode | Live/compute mode |
| --- | --- | --- |
| Firebase Hosting | primary cost surface, usually free tier | same |
| Firebase Auth | unused or low | proportional to active users/anonymous sessions |
| Firestore | static assets only | reads/writes scale with spectators, matches, receipts |
| Functions Gen 2 | none if undeployed | scales with submissions, match ticks, signaling, compute claims |
| Cloud Tasks | none | one dispatch per live match tick |
| Cloud Scheduler | none or paused | watchdog and cleanup only |
| Cloud Run | none | legacy only |

The desired production shape has no always-on Cloud Run service and no
self-amplifying compute/match loop.

## Separate-org caveat

Keep `m3ta-ai` in the intended GCP org and audit IAM bindings when moving
between orgs. Reissue service-account permissions per project instead of sharing
broad principals across unrelated workspaces.
