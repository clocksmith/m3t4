# Provisioning m3t4.ai (PRIVATE)

**DO NOT PUBLISH.** Step-by-step to stand up the production environment
from scratch. Pair this with `ARENA_DESIGN.md` for the *why*.

---

## 0. Prereqs

- Domain `m3t4.ai` registered, DNS controllable
- GCP account with billing enabled (separate org from 256one)
- `gcloud`, `firebase`, `npm` installed locally
- Docker desktop (for local Cloud Run build)

---

## 1. GCP project

```bash
# Pick a project ID (immutable, include org hint)
gcloud projects create m3ta-ai --name="m3ta-ai"
gcloud config set project m3ta-ai

# Enable needed services
gcloud services enable \
  firebase.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  identitytoolkit.googleapis.com
```

## 2. Firebase init

```bash
cd /path/to/m3t4
firebase login
firebase use --add m3ta-ai --alias prod
firebase init hosting firestore
```

Hosting public dir: `client`. Single-page app: yes.

Create `client/config.js` from `client/config.example.js` before deploy.
Firebase web config values are public identifiers; do not put server
secrets in this file.

Closed alpha can also set:

```js
window.__M3T4_AUTH_MODE__ = "alpha-token";
window.__M3T4_ALPHA_PASSWORD_SHA256__ = "<sha256(password)>";
```

That password gate is a convenience gate for the static app, not a
security boundary. The plaintext password is sent as the alpha token only
after a successful gate; do not put `M3T4_ALPHA_TOKEN` in
`client/config.js`. Server-side auth and optional UID allowlisting are
still required.

## 3. Auth providers

Firebase Console → Authentication → Sign-in method:

- Enable **Google**
- Enable **GitHub** — requires OAuth app registration at
  https://github.com/settings/developers
  - Homepage URL: `https://m3t4.ai`
  - Callback URL: `https://m3ta-ai.firebaseapp.com/__/auth/handler`
  - Copy Client ID + Secret into Firebase

Add `m3t4.ai` to Authorized Domains.

## 4. Firestore security rules

See `infra/firestore.rules`. Key rules:

- `stables/{uid}` — no browser read/write; contains private bot configs.
- `handles/{handle}` — no browser read/write; server mediates uniqueness.
- `publicStables/{uid}` — read-all computed projection with no configs.
- `replays/{matchId}` — no browser read/write; spectators use sanitized
  `/api/spectate/tuple/:matchId`.

Deploy:
```bash
firebase deploy --only firestore:rules
```

## Code-only deploy loop

Use this path for ordinary code-only changes. It preserves the existing Cloud
Run environment variables, secrets, scaling, and feature flags. Use the full
Cloud Run commands in the next section whenever those settings need to change.

```bash
PROJECT_ID=m3ta-ai

# Build compiles sim/server/pareto/plasma-lab and syncs sim/dist -> client/sim.
npm run build

# Test gate. Do not deploy if any command fails.
npm -w sim test
npm run test:client
npm -w server test
git diff --check

# Static client.
firebase deploy --only hosting

# Shared server image.
gcloud builds submit . --config server/cloudbuild.yaml --project "$PROJECT_ID"

# Roll the same image to both services. These commands preserve existing env.
gcloud run deploy arena-worker \
  --project "$PROJECT_ID" \
  --region us-central1 \
  --image "gcr.io/$PROJECT_ID/arena-server" \
  --quiet

gcloud run deploy arena-server \
  --project "$PROJECT_ID" \
  --region us-central1 \
  --image "gcr.io/$PROJECT_ID/arena-server" \
  --quiet

curl -fsS https://m3t4.ai/api/status
```

Skip conditions:

- No changes under `client/`, `content/`, `sim/`, or `firebase.json`:
  skip `firebase deploy --only hosting`.
- No changes under `sim/`, `server/`, `pareto/`, `plasma-lab/`, or
  `server/Dockerfile`: skip the Cloud Build and Cloud Run deploys.

## 5. Cloud Run (server)

```bash
cd /path/to/m3t4
PROJECT_ID=m3ta-ai

# Build + push container from repo root so the sim/server workspaces are
# both available to Docker.
gcloud builds submit . --config server/cloudbuild.yaml --project "$PROJECT_ID"

# Deploy the authoritative matchmaker worker. This service must stay singleton:
# one worker owns the firehose loop and emits the canonical ranked stream.
gcloud run deploy arena-worker \
  --project "$PROJECT_ID" \
  --image "gcr.io/$PROJECT_ID/arena-server" \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "^|^SERVER_ROLE=worker|NODE_ENV=production|STORE_BACKEND=firestore|AUTH_MODE=firebase|ARENA_API_ORIGIN=https://m3t4.ai|CORS_ORIGINS=https://m3t4.ai,https://www.m3t4.ai,https://m3ta-ai.web.app,https://m3ta-ai.firebaseapp.com|CYCLE_MS=20000|WS_CLIENT_SOFT_LIMIT=50|AUTH_PROVIDERS=google,github|FEATURE_P2P_DUEL=false|FEATURE_COMMUNITY_VERIFY=false|FEATURE_PROOF_LAB=false|FEATURE_ZK=false|FEATURE_DISTRIBUTED_COMPUTE=false|FEATURE_COMPUTE_TASK_ADMIN=false" \
  --set-secrets "M3T4_MATCH_TOKEN_SECRET=m3t4-match-token-secret:latest,M3T4_INTERNAL_TOKEN=m3t4-internal-cron-token:latest" \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 100 \
  --timeout 3600 \
  --no-cpu-throttling \
  --session-affinity

# Deploy the public API / WebSocket fanout service. This can scale horizontally
# because it relays from arena-worker instead of running its own firehose.
gcloud run deploy arena-server \
  --project "$PROJECT_ID" \
  --image "gcr.io/$PROJECT_ID/arena-server" \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "^|^SERVER_ROLE=api|FIREHOSE_WS_ORIGIN=wss://arena-worker-789525635095.us-central1.run.app|NODE_ENV=production|STORE_BACKEND=firestore|AUTH_MODE=firebase|ARENA_API_ORIGIN=https://m3t4.ai|ARENA_WS_ORIGIN=wss://arena-server-789525635095.us-central1.run.app|CORS_ORIGINS=https://m3t4.ai,https://www.m3t4.ai,https://m3ta-ai.web.app,https://m3ta-ai.firebaseapp.com|CYCLE_MS=20000|WS_CLIENT_SOFT_LIMIT=450|AUTH_PROVIDERS=google,github|FEATURE_P2P_DUEL=false|FEATURE_COMMUNITY_VERIFY=false|FEATURE_PROOF_LAB=false|FEATURE_ZK=false|FEATURE_DISTRIBUTED_COMPUTE=false|FEATURE_COMPUTE_TASK_ADMIN=false" \
  --set-secrets "M3T4_MATCH_TOKEN_SECRET=m3t4-match-token-secret:latest,M3T4_INTERNAL_TOKEN=m3t4-internal-cron-token:latest" \
  --min-instances 1 \
  --max-instances 10 \
  --concurrency 500 \
  --timeout 3600 \
  --no-cpu-throttling \
  --session-affinity  # required for WebSocket
```

Closed alpha smoke test may use the file store for one instance only:

```bash
gcloud run deploy arena-server \
  --image "gcr.io/$PROJECT_ID/arena-server" \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,STORE_BACKEND=file,AUTH_MODE=alpha-token,M3T4_ALPHA_ALLOWLIST=alice,bob,ARENA_API_ORIGIN=https://m3t4.ai,CORS_ORIGINS=https://m3t4.ai,CYCLE_MS=20000,FEATURE_P2P_DUEL=false,FEATURE_COMMUNITY_VERIFY=false,FEATURE_PROOF_LAB=false,FEATURE_ZK=false,FEATURE_DISTRIBUTED_COMPUTE=false,FEATURE_COMPUTE_TASK_ADMIN=false" \
  --set-secrets "M3T4_ALPHA_TOKEN=m3t4-alpha-token:latest,M3T4_MATCH_TOKEN_SECRET=m3t4-match-token-secret:latest,M3T4_INTERNAL_TOKEN=m3t4-internal-cron-token:latest" \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 500 \
  --timeout 3600 \
  --no-cpu-throttling \
  --session-affinity
```

File-backed closed alpha has explicit data-loss risk on deploy/revision
replacement and must not be used for public ranked submissions.

### Optional Cloud Run sidecar: plasma-lab

`plasma-lab` is isolated from ranked authority. Deploy it only for staging or
staff alpha until receipt agreement, frame impact, and IAM boundaries are
proven.

```bash
cd /path/to/m3t4
PROJECT_ID=m3ta-ai

gcloud builds submit . --config plasma-lab/cloudbuild.yaml --project "$PROJECT_ID"

gcloud run deploy plasma-lab \
  --project "$PROJECT_ID" \
  --image "gcr.io/$PROJECT_ID/plasma-lab" \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "^|^NODE_ENV=production|FEATURE_COMPUTE_LAB_ROUTES=true|FEATURE_COMPUTE_TASK_ADMIN=true|COMPUTE_ACCEPT_ASSIGNMENTS=false|PLASMA_LAB_STORE_BACKEND=firestore|FEATURE_COMPUTE_WEBRTC_SIGNALING=false|FEATURE_COMPUTE_WEBRTC_DATA=false|FEATURE_COMPUTE_WEBRTC_TURN=false|COMPUTE_STUN_URLS=stun:stun.l.google.com:19302" \
  --set-secrets "PLASMA_LAB_ADMIN_TOKEN=plasma-lab-admin-token:latest" \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 80 \
  --timeout 300
```

Keep `plasma-lab` at `--max-instances 1` during controlled staff alpha. The
current Firestore persistence writes whole compute snapshots, so multiple
serving instances can clobber each other's just-seeded tasks during rapid
admin/worker smoke traffic. Raise this only after persistence moves to
per-record transactional writes or a single coordinator.

For strict storage isolation, prefer a separate compute project/database and
set:

```bash
--set-env-vars "PLASMA_LAB_FIRESTORE_PROJECT_ID=<compute-project-id>"
```

Collection naming plus Firestore rules are useful defense in depth, but the
Admin SDK can bypass rules if its service account has broad project access.
Do not give `plasma-lab` credentials that can read private ranked config
collections.

Keep `COMPUTE_ACCEPT_ASSIGNMENTS=false` until you are intentionally running a
staging smoke or staff alpha. After deploy, the admin dashboard is available at
`/compute/admin/dashboard.html`; it can toggle assignment intake and seed
public-artifact or public seed-sweep tasks without redeploying env vars. It
also has a timed assignment-intake button; use that for staff windows so the
store closes intake automatically even if the operator misses the manual
disable step. The same control is available through
`POST /compute/admin/assignments` with
`{"acceptAssignments":true,"durationMs":30000}`.
Manual `{"acceptAssignments":false}` remains the primary immediate rollback.
The runtime deadline is reported as `assignmentIntakeClosesAt` in
`/compute/status` and the admin dashboard. It
also shows admin-only Device Witness maps for bucketed WebGPU correctness,
WebRTC/ICE connectivity, and rendering fixture observations. The dashboard can
also seed assignment-bound Device Witness WebGPU, rendering fixture, and WebRTC
measurement tasks; those return normal `compute_receipts` and are admin-only.
It also derives worker/device/network profiles, privacy-suppressed public stats,
and replay verification badges from accepted public-artifact receipts.
Browser connectivity witnesses should probe `/compute/healthz` as the stable
same-origin lab health endpoint; `/compute/status` remains the richer debug
surface.

Two-browser WebRTC measurement is available only when
`FEATURE_COMPUTE_WEBRTC_SIGNALING=true`. It uses `/compute/webrtc/pairs/*` for
short-lived offer/answer/candidate exchange, then stores only bucketed
connectivity observations. When `FEATURE_COMPUTE_WEBRTC_DATA=true`, paired
staff browsers also open `plasma-control`, `plasma-data`, and
`plasma-receipts`, send a tiny deterministic `prime-search.v0` witness chunk
over the data channel, and store only bucketed data-channel outcome fields.
The deployed game client does not route useful public-artifact assignments over
WebRTC unless arena-server also exposes
`FEATURE_COMPUTE_WEBRTC_ARTIFACTS=true` in `/api/status` or staff sets
`window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__=true` in devtools for a controlled
window. Staff smokes may also set
`window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS_STRICT__=true` to fail closed instead
of falling back to the normal HTTP worker path if a WebRTC artifact transfer
does not complete. These flags are client-side only: plasma-lab still controls
signaling/data with `FEATURE_COMPUTE_WEBRTC_SIGNALING` and
`FEATURE_COMPUTE_WEBRTC_DATA`, and `COMPUTE_ACCEPT_ASSIGNMENTS=false` still
stops new assignments.
This does not enable ranked authority, private config access, or public
assignment intake. TURN remains off unless
`FEATURE_COMPUTE_WEBRTC_TURN=true` plus `COMPUTE_TURN_URLS`,
`COMPUTE_TURN_USERNAME`, and `COMPUTE_TURN_CREDENTIAL` are set. Treat TURN as a
measured fallback with cost/abuse monitoring, not a default. The admin
dashboard shows redacted WebRTC pair status, offer/answer presence, and
candidate counts for staff pairing tests; it does not expose pair tokens or raw
SDP/candidate payloads in the summary table. The dashboard can also seed
`device_witness.derived_buffer.v0`, a synthetic public-buffer fixture that
exercises derived-compute evidence without touching live render buffers or
ranked game state.

Staff data-channel witness from two browser tabs/devices:

```js
window.__M3T4_COMPUTE_SLACK_WORKER__ = true;
await window.m3t4Compute.webrtcWitness();
```

Run that in two opted-in browsers within the same pairing window. The offerer
should report `dataWorkBucket: "request-ok"` and `dataReceiptBucket: "ok"` if a
peer executed the witness chunk and returned the expected receipt over
`plasma-receipts`.

To run the receipt-path smoke against the deploy:

```bash
# Enable assignment intake from /compute/admin/dashboard.html first.

PLASMA_LAB_SMOKE_ORIGIN=https://<plasma-lab-cloud-run-url> \
PLASMA_LAB_SMOKE_ADMIN_TOKEN=<admin-token> \
npm -w plasma-lab run smoke

# Disable assignment intake from /compute/admin/dashboard.html after the check.
```

The deployed game should only point at the lab after that sidecar is healthy:

```bash
gcloud run services update arena-server \
  --project "$PROJECT_ID" \
  --region us-central1 \
  --update-env-vars "COMPUTE_LAB_ORIGIN=https://<plasma-lab-cloud-run-url>,FEATURE_COMPUTE_SLACK_WORKER=false,FEATURE_COMPUTE_WEBRTC_ARTIFACTS=false,FEATURE_COMPUTE_LIVE_BADGES=false,COMPUTE_STUN_URLS=stun:stun.l.google.com:19302"
```

`COMPUTE_STUN_URLS` is optional. Leaving it empty still measures HTTP RTT and
local datachannel support; setting it lets the opt-in browser witness bucket
STUN/srflx candidate success. Raw ICE candidates are never submitted.

## 6. Domain binding

```bash
# Optional direct API domain for Cloud Run. The production site can also use
# Firebase Hosting rewrites from https://m3t4.ai/api and wss://m3t4.ai/ws.
gcloud run domain-mappings create \
  --service arena-server \
  --domain api.m3t4.ai \
  --region us-central1

# Production Firebase Hosting deploy
firebase deploy --only hosting
# Then Firebase Console → Hosting → Add custom domain → m3t4.ai
```

DNS records (at registrar):

| Name | Type | Target |
|---|---|---|
| `m3t4.ai` | A | Firebase provides |
| `www.m3t4.ai` | A | same |
| `api.m3t4.ai` | CNAME | ghs.googlehosted.com |

Wait for cert provisioning (15 min - 24 h).

## 7. Scheduler jobs

```bash
# Weekly ELO decay
gcloud scheduler jobs create http elo-decay \
  --schedule "0 4 * * 1" \
  --uri "https://m3t4.ai/internal/elo-decay" \
  --http-method POST \
  --headers "x-m3t4-internal-token=<internal-token>" \
  --oidc-service-account-email m3t4-scheduler@m3ta-ai.iam.gserviceaccount.com

# Seasonal reset — 12-week trigger, TBD
```

Firestore backup/export policy:

```bash
# Create a private export bucket once.
gcloud storage buckets create gs://m3ta-ai-firestore-backups \
  --location=us-central1 \
  --uniform-bucket-level-access

# Daily Firestore export.
gcloud scheduler jobs create http firestore-export \
  --schedule "20 4 * * *" \
  --uri "https://firestore.googleapis.com/v1/projects/m3ta-ai/databases/(default):exportDocuments" \
  --http-method POST \
  --headers "Content-Type=application/json" \
  --message-body '{"outputUriPrefix":"gs://m3ta-ai-firestore-backups/daily"}' \
  --oauth-service-account-email m3t4-scheduler@m3ta-ai.iam.gserviceaccount.com
```

## 8. Secrets

Stored in Secret Manager, not `.env`:

```bash
gcloud secrets create m3t4-match-token-secret --replication-policy automatic
echo -n "<secret>" | gcloud secrets versions add m3t4-match-token-secret --data-file=-

gcloud secrets create m3t4-internal-cron-token --replication-policy automatic
echo -n "<internal-token>" | gcloud secrets versions add m3t4-internal-cron-token --data-file=-

gcloud secrets create plasma-lab-admin-token --replication-policy automatic
echo -n "<plasma-lab-admin-token>" | gcloud secrets versions add plasma-lab-admin-token --data-file=-

# Closed alpha only
gcloud secrets create m3t4-alpha-token --replication-policy automatic
echo -n "<shared-alpha-token>" | gcloud secrets versions add m3t4-alpha-token --data-file=-
```

Cloud Run pulls via `--set-secrets`:
```
--set-secrets "M3T4_MATCH_TOKEN_SECRET=m3t4-match-token-secret:latest,M3T4_INTERNAL_TOKEN=m3t4-internal-cron-token:latest"
```

`M3T4_MATCH_TOKEN_SECRET` is required in production whenever the replay
verify module is loaded; keep it set even when P2P is disabled.
`M3T4_INTERNAL_TOKEN` protects internal cron endpoints such as ELO decay;
the Scheduler header value must match the deployed secret value.

## 9. Post-deploy smoke tests

```bash
curl https://m3t4.ai/api/status
# expect: { "ok": true, "cycleMs": 20000, "features": { all optional false } }

curl https://m3t4.ai/api/leaderboard
# expect: array of public stable summaries
```

Auth check: visit `https://m3t4.ai`, click "Sign in with Google", confirm
callback succeeds.

Closed alpha auth check: set `window.__M3T4_AUTH_MODE__="alpha-token"` and
`window.__M3T4_ALPHA_PASSWORD_SHA256__` in `client/config.js`, enter the
alpha password gate, pick an invited UID, and submit a config. The server
secret `M3T4_ALPHA_TOKEN` must match that password. Production must still
reject `AUTH_MODE=dev`.

WebSocket check: from browser console, use the direct Cloud Run WS origin
configured in `client/config.js`:
`new WebSocket(window.__M3T4_WS_ORIGIN__ + "/ws").onopen = () => console.log("ok")`.

Optional plasma-lab check:

```bash
npm -w plasma-lab run smoke

PLASMA_LAB_SMOKE_ORIGIN=https://<plasma-lab-cloud-run-url> \
PLASMA_LAB_SMOKE_ADMIN_TOKEN=<admin-token> \
npm -w plasma-lab run smoke

PLASMA_LAB_SMOKE_ORIGIN=https://<plasma-lab-cloud-run-url> \
PLASMA_LAB_SMOKE_ADMIN_TOKEN=<admin-token> \
M3T4_SMOKE_GAME_ORIGIN=https://m3t4.ai \
npm -w plasma-lab run smoke:webrtc-client-artifact
```

Set `PLASMA_LAB_SMOKE_REPEAT=5` or pass `--repeat=5` to run the hosted
WebRTC artifact smoke repeatedly in one controlled command. Each pass refuses
to start if assignment intake is already open, opens intake with a bounded
server-side window, and disables it again in `finally`.
Set `PLASMA_LAB_SMOKE_KERNEL=replay-verify` or pass
`--kernel=replay-verify` to run the same hosted WebRTC path with
`m3t4.replay_verify.v1` public action-log replay verification instead of the
public artifact hash kernel.

The local smoke starts its own in-memory lab. The remote smoke requires
`FEATURE_COMPUTE_LAB_ROUTES=true` and `FEATURE_COMPUTE_TASK_ADMIN=true`; keep
`COMPUTE_ACCEPT_ASSIGNMENTS=false` as the deploy-time default and let the smoke
open the bounded runtime intake window itself.

Watchlist check: Cloud Run logs should contain `[watchlist]` entries for
matches involving `unicorn`, `disruptor`, `shipper`, long matches, or draws.

## 10. Rollback

```bash
# Cloud Run revisions are versioned — revert each service with:
gcloud run revisions list --service arena-server --project m3ta-ai --region us-central1
gcloud run services update-traffic arena-server \
  --project m3ta-ai \
  --region us-central1 \
  --to-revisions REVISION=100

gcloud run revisions list --service arena-worker --project m3ta-ai --region us-central1
gcloud run services update-traffic arena-worker \
  --project m3ta-ai \
  --region us-central1 \
  --to-revisions REVISION=100
```

Firebase hosting rollback: Console → Hosting → Release history → Rollback.

---

## Cost estimate (pre-traffic)

| Service | Monthly idle cost | Notes |
|---|---|---|
| Firebase Hosting | $0 | 10 GB transfer free |
| Firebase Auth | $0 | < 50K MAU free |
| Firestore | $0-5 | Free tier generous |
| Cloud Run | $15-60 | Worker + API are kept warm for live streams; plasma-lab can scale to zero until alpha |
| Cloud Storage (replays) | $0-2 | 5 GB free |
| Scheduler | $0 | 3 free jobs |
| **Total** | **$15-65** | Scales with usage |

Active: maybe $50-200/mo at ~1000 active stables, ~10K MAU.

## Scale ceiling

Production uses a singleton worker plus horizontally scalable API/fanout:

- `arena-worker`: authoritative matchmaker/firehose, `--max-instances=1`.
- `arena-server`: REST API + WebSocket fanout, `--max-instances=10`,
  `--concurrency=500`.

This keeps one canonical ranked stream while allowing spectator/API load to
scale out. Revisit architecture when the fanout service approaches sustained
high CPU/memory, when egress cost dominates, or before several thousand
concurrent spectators. The next step would be a managed pub/sub fanout layer
or a dedicated edge WebSocket broker.

---

## Separate-org caveat

This project MUST live in a GCP org distinct from 256one. Create under
the new org, not the default personal account. Bill + IAM are then
completely separated. If 256one shares service-account principals,
revoke and reissue per-project.
