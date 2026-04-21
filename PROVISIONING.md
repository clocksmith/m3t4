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
  --set-env-vars "^|^SERVER_ROLE=worker|NODE_ENV=production|STORE_BACKEND=firestore|AUTH_MODE=firebase|ARENA_API_ORIGIN=https://m3t4.ai|CORS_ORIGINS=https://m3t4.ai,https://www.m3t4.ai,https://m3ta-ai.web.app,https://m3ta-ai.firebaseapp.com|CYCLE_MS=60000|AUTH_PROVIDERS=google,github|FEATURE_P2P_DUEL=false|FEATURE_COMMUNITY_VERIFY=false|FEATURE_PROOF_LAB=false|FEATURE_ZK=false|FEATURE_DISTRIBUTED_COMPUTE=false|FEATURE_COMPUTE_TASK_ADMIN=false" \
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
  --set-env-vars "^|^SERVER_ROLE=api|FIREHOSE_WS_ORIGIN=wss://arena-worker-789525635095.us-central1.run.app|NODE_ENV=production|STORE_BACKEND=firestore|AUTH_MODE=firebase|ARENA_API_ORIGIN=https://m3t4.ai|ARENA_WS_ORIGIN=wss://arena-server-789525635095.us-central1.run.app|CORS_ORIGINS=https://m3t4.ai,https://www.m3t4.ai,https://m3ta-ai.web.app,https://m3ta-ai.firebaseapp.com|CYCLE_MS=60000|AUTH_PROVIDERS=google,github|FEATURE_P2P_DUEL=false|FEATURE_COMMUNITY_VERIFY=false|FEATURE_PROOF_LAB=false|FEATURE_ZK=false|FEATURE_DISTRIBUTED_COMPUTE=false|FEATURE_COMPUTE_TASK_ADMIN=false" \
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
  --set-env-vars "NODE_ENV=production,STORE_BACKEND=file,AUTH_MODE=alpha-token,M3T4_ALPHA_ALLOWLIST=alice,bob,ARENA_API_ORIGIN=https://m3t4.ai,CORS_ORIGINS=https://m3t4.ai,CYCLE_MS=60000,FEATURE_P2P_DUEL=false,FEATURE_COMMUNITY_VERIFY=false,FEATURE_PROOF_LAB=false,FEATURE_ZK=false,FEATURE_DISTRIBUTED_COMPUTE=false,FEATURE_COMPUTE_TASK_ADMIN=false" \
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

## 6. Domain binding

```bash
# Optional direct API domain for Cloud Run. The production site can also use
# Firebase Hosting rewrites from https://m3t4.ai/api and wss://m3t4.ai/ws.
gcloud run domain-mappings create \
  --service arena-server \
  --domain api.m3t4.ai \
  --region us-central1

# Custom domain for Firebase Hosting
firebase hosting:channel:deploy live --only hosting
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
# expect: { "ok": true, "cycleMs": 60000, "features": { all optional false } }

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

Watchlist check: Cloud Run logs should contain `[watchlist]` entries for
matches involving `unicorn`, `disruptor`, `shipper`, long matches, or draws.

## 10. Rollback

```bash
# Cloud Run revisions are versioned — revert with:
gcloud run services update-traffic arena-server --to-revisions REVISION=100
```

Firebase hosting rollback: Console → Hosting → Release history → Rollback.

---

## Cost estimate (pre-traffic)

| Service | Monthly idle cost | Notes |
|---|---|---|
| Firebase Hosting | $0 | 10 GB transfer free |
| Firebase Auth | $0 | < 50K MAU free |
| Firestore | $0-5 | Free tier generous |
| Cloud Run | $15-60 | Worker + API are kept warm for live streams |
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
