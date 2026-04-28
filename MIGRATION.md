# m3t4 cutover: Cloud Run → static + (optional) Firebase Functions

## TL;DR — the cheapest path

**Hosting-only mode** is now the default. The `client/matches/` directory
ships pre-generated match docs with a wall-clock-anchored virtual
schedule. Spectators pick the current match locally, replay it, loop the
schedule. **Zero backend required.** Total cost: $0/mo.

```bash
# Generate matches once (or whenever you want to refresh the pool)
PROJECT=m3ta-ai node scripts/generate-static-matches.cjs --count=500

# Deploy. That's it.
firebase deploy --only hosting --project m3ta-ai
```

The Functions architecture below is the upgrade path when you want live
matchmaking (player-submitted brain configs trigger new matches). Until
then, the static path is the recommended deploy.

## Mode selection

The client picks the feed based on flags set on `window`:

| Flag | Mode | Backend cost |
|---|---|---|
| neither flag set | **static** (default) | $0/mo |
| `__M3T4_USE_STATIC_MATCHES__ = true` | static (explicit) | $0/mo |
| `__M3T4_USE_FIREBASE_FEED__ = true` | Firestore subscription (live) | ~$5-8/mo |

Set in `client/index.html` or anywhere before `client/modes/spectate.js`
loads.

---

## Static mode — full details

The legacy stack (arena-server + arena-worker + plasma-lab on Cloud Run +
heavy Firestore writes per match) is replaced with:

- **`functions/`** — Firebase Functions (Gen 2) handling matchTick,
  watchdog, bootstrapMatch, submitStable, webrtcSignal
- **`match-engine/`** — shared TypeScript module: pair selection, ELO,
  match runner. Used by Functions; safe for client import too
- **`client/lib/match-feed.js`** — Firestore-subscription-based match
  feed; replaces the WebSocket firehose
- **Cloud Tasks queue** `matchchain` — enqueues the next matchTick at
  precise match-end time; eliminates fixed cron
- **Cloud Scheduler watchdog** every 30s — kicks the chain if Cloud
  Tasks delivery breaks

Cost target: **~$5-8/mo** at modest spectator load.

## What goes away

- `server/` (arena-server + arena-worker share this build) — DELETED
- `plasma-lab/` and the entire compute-coordinator subsystem — DELETED
- WebSocket-based spectate (arena-server `/ws`) — replaced by Firestore
  `onSnapshot`
- All `compute_*` Firestore collections — orphaned and ignored; can be
  dropped via Console after verification
- `firebase.json` rewrites that pointed `/api/**` and `/ws` to Cloud
  Run — replaced by Function-target rewrites and direct Firestore reads

## Pre-deploy checklist

1. **Cloud Tasks queue exists.** Create once via gcloud:

   ```bash
   gcloud tasks queues create matchchain \
     --location=us-central1 \
     --project=m3ta-ai \
     --max-dispatches-per-second=2 \
     --max-concurrent-dispatches=2 \
     --max-attempts=5
   ```

2. **Functions service account has tasks enqueue + Firestore write
   permissions.** The default Functions SA (`<project>@appspot.gserviceaccount.com`)
   needs:
   - `roles/cloudtasks.enqueuer`
   - `roles/datastore.user`

   ```bash
   PROJECT=m3ta-ai
   SA=${PROJECT}@appspot.gserviceaccount.com
   gcloud projects add-iam-policy-binding $PROJECT \
     --member="serviceAccount:$SA" \
     --role="roles/cloudtasks.enqueuer"
   gcloud projects add-iam-policy-binding $PROJECT \
     --member="serviceAccount:$SA" \
     --role="roles/datastore.user"
   ```

3. **Enable APIs:**

   ```bash
   gcloud services enable cloudfunctions.googleapis.com \
     cloudtasks.googleapis.com \
     cloudscheduler.googleapis.com \
     run.googleapis.com \
     firebase.googleapis.com \
     firestore.googleapis.com \
     --project=m3ta-ai
   ```

4. **Build + verify locally:**

   ```bash
   cd /Users/xyz/deco/m3t4
   npm install
   npm -w sim run build
   npm -w match-engine run build
   npm -w functions run build
   ```

## Deploy sequence (after re-enabling billing)

```bash
cd /Users/xyz/deco/m3t4

# 1. Confirm gcloud + firebase auth on anthony@d4da.com
gcloud config set account anthony@d4da.com
firebase login:use anthony@d4da.com

# 2. Deploy Firestore rules first (gates Functions writes)
firebase deploy --only firestore:rules --project m3ta-ai

# 3. Deploy Functions (matchTick, watchdog, etc.)
firebase deploy --only functions --project m3ta-ai

# 4. After deploy, fetch the matchTick HTTPS URL from console and
#    set it as a runtime env var so Cloud Tasks knows where to deliver:
MATCH_TICK_URL="https://matchtick-<hash>-uc.a.run.app"
firebase functions:config:set matchchain.url="$MATCH_TICK_URL" --project m3ta-ai
# Or set via gcloud run services update on the matchTick function
# directly with --update-env-vars=MATCH_TICK_URL=...

# 5. Re-deploy Functions so MATCH_TICK_URL is baked in
firebase deploy --only functions --project m3ta-ai

# 6. Update client to talk to Firestore + Functions directly
firebase deploy --only hosting --project m3ta-ai

# 7. Bootstrap the match chain (one-shot HTTP call)
ID_TOKEN=$(gcloud auth print-identity-token)
curl -X POST -H "Authorization: Bearer $ID_TOKEN" \
  -H "content-type: application/json" \
  -d '{"data":{}}' \
  "https://us-central1-m3ta-ai.cloudfunctions.net/bootstrapMatch"
```

## Decommissioning the legacy stack

Once the Functions deploy is verified and matches are flowing, tear
down the old Cloud Run services:

```bash
gcloud run services delete arena-server  --region=us-central1 --project=m3ta-ai --quiet
gcloud run services delete arena-worker  --region=us-central1 --project=m3ta-ai --quiet
gcloud run services delete plasma-lab    --region=us-central1 --project=m3ta-ai --quiet

# Delete old Container Registry images (optional cleanup)
gcloud container images delete gcr.io/m3ta-ai/arena-server --quiet --force-delete-tags
gcloud container images delete gcr.io/m3ta-ai/plasma-lab    --quiet --force-delete-tags
```

The orphaned Firestore `compute_*` collections can be deleted via
Console once you've confirmed nothing reads them. Or just leave them —
they cost ~pennies/month for storage at this scale.

## Rollback

If anything goes wrong:

1. Re-enable `arena-server` + `arena-worker` deployments (they're still
   in source under `server/` and `plasma-lab/`).
2. Restore `firebase.json` rewrites to `arena-server` Cloud Run.
3. Run the legacy build: `npm run build:legacy`.
4. Re-deploy Cloud Run services.

The legacy code is preserved in source. The Functions migration is
purely additive until you delete the legacy directories.

## What changed in the Firestore data model

| Old | New |
|---|---|
| `replays/{matchId}` (full replay, server-only) | `matches/{matchId}` (small doc with actionLog, public-read) |
| `publicReplayArtifacts/{matchId}` (sanitized projection) | merged into `matches/{matchId}` |
| `stables/{userId}` (server-only writes via API) | `stables/{userId}` (server-only writes via Function) |
| `compute_*` (plasma-lab state) | gone |
| - | `state/matchChain` (chain head + lock) |
| - | `webrtc/{sessionId}` (transient signaling) |

## Spectator client refactor (still TODO before full cutover)

`client/modes/spectate.js` currently consumes WebSocket `frames` events.
The new feed lives in `client/lib/match-feed.js`. Wire it in:

```js
// at top of spectate.js
import { subscribeLatestMatch, framesFromActionLog, playMatchAligned } from "../lib/match-feed.js";

// replace the connectWs(...) path with:
const stop = subscribeLatestMatch(async (matchDoc) => {
  const frames = await framesFromActionLog(matchDoc);
  if (!frames) return; // sim verifier helper not exported yet — see below
  playMatchAligned(matchDoc, frames, {
    onFrame: (frame, idx) => appendFrames([frame]),
    onEnd: () => { /* matchEnd UI */ },
  });
});
```

The `framesFromActionLog` path requires `@m3t4/sim` to export a helper
that re-runs the world step-by-step using the action log and yields each
frame. This helper does not yet exist as an export; add it to
`sim/src/replay.ts` based on the existing `verifyActionLog` function
(same loop, but call `worldToFrame(world)` after each step and push to
an array).

Until that export lands, spectators see match metadata but can't render
frames. Either:
- Add the export and rebuild sim, OR
- Pass brain configs through the match doc (privacy tradeoff) and use
  `simulateTrace` directly (already wired in `reconstructFrames`).

## Cost monitoring after cutover

Watch for:
- Function invocations matching ~1 per match (matchTick) and 2/min
  (watchdog)
- Firestore writes ~5 per match
- Firestore reads scaling with concurrent spectators
- Cloud Tasks ~1 per match

If reads spike, check that client has only ONE active `onSnapshot` per
spectator (not one per UI component).

## Phase 2 (optional, future)

- Wire `webrtcSignal` Function for real peer pairing
- Spectator mesh: first spectator fetches actionLog from Firestore;
  later spectators fetch from peers via WebRTC data channel
- Lockstep human-vs-human matches with peer-signed result commits
