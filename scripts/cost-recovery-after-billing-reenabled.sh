#!/usr/bin/env bash
# Run AFTER re-enabling billing on m3ta-ai. Stops the auto-seed leak before
# the firehose can warm back up.
#
# What's already in source (run `git diff` to review):
#   plasma-lab/src/config.ts     — adds bootstrapWitnessOnRegister flag (default false)
#   plasma-lab/src/routes.ts     — gates witness-on-register seeding behind that flag
#   plasma-lab/src/smoke.ts      — wires the new flag in smoke
#   plasma-lab/src/test/plasma-lab.test.ts — wires the new flag in tests
#
# Sequence below: scale all services to ZERO first (cheapest defensive posture),
# rebuild plasma-lab with the patch, redeploy, then scale up cautiously while
# watching the Firestore read rate.

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=m3ta-ai
REGION=us-central1

echo "=== STEP 1 / 7: Confirm gcloud auth on the right account ==="
gcloud config get-value account
echo ""
read -p "Press ENTER to continue (Ctrl-C to abort if account is wrong)..."

echo "=== STEP 2 / 7: Scale arena-worker AND plasma-lab to zero ==="
echo "(arena-server stays at min=1 max=3 so the API stays available; arena-worker"
echo " is the firehose that produces matches; plasma-lab is the read magnet.)"
gcloud run services update arena-worker --region=$REGION --project=$PROJECT \
  --min-instances=0 --max-instances=0 --quiet
gcloud run services update plasma-lab --region=$REGION --project=$PROJECT \
  --min-instances=0 --max-instances=0 --quiet

echo ""
echo "Both services scaled to zero. Firestore reads should drop to near-nothing"
echo "within 60s. Verify in another terminal:"
echo "  gcloud run services list --region=$REGION --project=$PROJECT"
echo ""
read -p "Press ENTER once you've confirmed reads have dropped (check GCP console)..."

echo "=== STEP 3 / 7: Build plasma-lab with the witness-gate patch ==="
npm -w plasma-lab run build

echo "=== STEP 4 / 7: Push new plasma-lab image to GCR ==="
gcloud builds submit --config plasma-lab/cloudbuild.yaml --project=$PROJECT --timeout=20m .

echo "=== STEP 5 / 7: Deploy plasma-lab — flag explicitly OFF, scaled to ZERO ==="
gcloud run deploy plasma-lab --image gcr.io/$PROJECT/plasma-lab:latest \
  --region=$REGION --project=$PROJECT \
  --memory=2Gi --cpu=2 \
  --min-instances=0 --max-instances=1 \
  --update-env-vars=FEATURE_COMPUTE_BOOTSTRAP_WITNESS_ON_REGISTER=false,COMPUTE_MAX_PENDING_TASKS=500,PLASMA_LAB_PERSIST_EPHEMERAL=0,PLASMA_LAB_LOAD_WINDOW_DAYS=7 \
  --quiet

echo "=== STEP 6 / 7: Bring plasma-lab up ==="
gcloud run services update plasma-lab --region=$REGION --project=$PROJECT \
  --min-instances=0 --max-instances=1 --quiet
echo ""
echo "plasma-lab: min=0 max=1. It will only spin up on demand. Watch read rate;"
echo "it should stay under 1000/sec at steady state."
read -p "Press ENTER once you've watched the rate for 5+ minutes and it stays low..."

echo "=== STEP 7 / 7: Decide arena-worker fate ==="
cat <<'EOM'
arena-worker is currently scaled to ZERO. While that holds:
  - no new matches run
  - no auto-seed (firehose is the auto-seed source)
  - no new witness tasks
  - the game arena is OFFLINE

Three options for arena-worker now:

A) Leave it at zero. m3t4 is offline. Cheapest. Recommended until you actually
   want users playing.

B) Bring it back at min=1 max=1 only when you want the game live:
     gcloud run services update arena-worker --region=us-central1 --project=m3ta-ai \
       --min-instances=1 --max-instances=1
   With auto-seed feature flags defaulting OFF and the witness-gate disabled,
   this should NOT bleed reads. But verify by watching the rate.

C) Bring it up but explicitly disable any auto-seed env vars (defensive):
     gcloud run services update arena-worker --region=us-central1 --project=m3ta-ai \
       --update-env-vars=FEATURE_COMPUTE_AUTO_SEED_REPLAY_TASKS=false,FEATURE_COMPUTE_AUTO_SEED_SEED_SWEEP_TASKS=false,FEATURE_COMPUTE_AUTO_SEED_TENSOR_TILE_TASKS=false \
       --min-instances=1 --max-instances=1

EOM

echo "Recovery sequence complete. arena-worker decision is yours."
echo ""
echo "If anything still bleeds reads after this, in priority order, check:"
echo "  1. New tasks accumulating: \`curl -H \"x-plasma-admin-token: \$(gcloud secrets versions access latest --secret=plasma-lab-admin-token --project=$PROJECT)\" https://plasma-lab-789525635095.us-central1.run.app/compute/admin/dashboard | jq '.taskList | length'\`"
echo "  2. plasma-lab restarts: \`gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"plasma-lab\" AND textPayload=~\"Starting new instance\"' --project=$PROJECT --freshness=15m\`"
echo "  3. Firestore read rate: \`gcloud monitoring metrics ...\` (or the curl-based queries we used in this session)"
