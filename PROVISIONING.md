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
gcloud projects create m3t4-arena-prod --name="m3t4 Arena"
gcloud config set project m3t4-arena-prod

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
firebase use --add m3t4-arena-prod --alias prod
firebase init hosting firestore
```

Hosting public dir: `client/dist`. Single-page app: yes.

## 3. Auth providers

Firebase Console → Authentication → Sign-in method:

- Enable **Google**
- Enable **GitHub** — requires OAuth app registration at
  https://github.com/settings/developers
  - Homepage URL: `https://m3t4.ai`
  - Callback URL: `https://m3t4-arena-prod.firebaseapp.com/__/auth/handler`
  - Copy Client ID + Secret into Firebase

Add `m3t4.ai` to Authorized Domains.

## 4. Firestore security rules

See `infra/firestore.rules`. Key rules:

- `stables/{uid}` — read own, write own, **no cross-user read of `.attributes`**
- `stables/{uid}/public` — computed doc with only public fields (name,
  ELO, stats). Read-all.
- `replays/{id}` — read public, no writes (server-only via admin SDK)

Deploy:
```bash
firebase deploy --only firestore:rules
```

## 5. Cloud Run (server)

```bash
cd server
# Build + push container
gcloud builds submit --tag gcr.io/m3t4-arena-prod/arena-server

# Deploy
gcloud run deploy arena-server \
  --image gcr.io/m3t4-arena-prod/arena-server \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "ARENA_PUBLIC_DOMAIN=m3t4.ai,CYCLE_MS=60000,AUTH_PROVIDERS=google,github" \
  --min-instances 0 \
  --max-instances 4 \
  --concurrency 80 \
  --timeout 3600 \
  --session-affinity  # required for WebSocket
```

## 6. Domain binding

```bash
# Custom domain for Cloud Run
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
  --uri "https://api.m3t4.ai/internal/elo-decay" \
  --http-method POST \
  --oidc-service-account-email m3t4-scheduler@m3t4-arena-prod.iam.gserviceaccount.com

# Seasonal reset — 12-week trigger, TBD
```

## 8. Secrets

Stored in Secret Manager, not `.env`:

```bash
gcloud secrets create github-oauth-client-secret --replication-policy automatic
echo -n "<secret>" | gcloud secrets versions add github-oauth-client-secret --data-file=-
```

Cloud Run pulls via `--set-secrets`:
```
--set-secrets "GITHUB_SECRET=github-oauth-client-secret:latest"
```

## 9. Post-deploy smoke tests

```bash
curl https://api.m3t4.ai/api/status
# expect: { "ok": true, "cycleMs": 60000 }

curl https://api.m3t4.ai/api/leaderboard
# expect: array of public stable summaries
```

Auth check: visit `https://m3t4.ai`, click "Sign in with Google", confirm
callback succeeds.

WebSocket check: from browser console,
`new WebSocket("wss://api.m3t4.ai/ws").onopen = () => console.log("ok")`.

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
| Cloud Run | $0 | Scales to zero when idle |
| Cloud Storage (replays) | $0-2 | 5 GB free |
| Scheduler | $0 | 3 free jobs |
| **Total** | **$0-10** | Scales with usage |

Active: maybe $50-200/mo at ~1000 active stables, ~10K MAU.

---

## Separate-org caveat

This project MUST live in a GCP org distinct from 256one. Create under
the new org, not the default personal account. Bill + IAM are then
completely separated. If 256one shares service-account principals,
revoke and reissue per-project.
