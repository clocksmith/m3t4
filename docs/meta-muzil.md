# Meta Muzil: implementation and acceptance

## Product requirement

A human or a teachable stand-in controls a believable simulated phone to finish
an intention. Removing Doppler removes model-driven play and reply assistance.
Removing Reploid removes paired play and inference on the connected computer.
Human play stays available without model weights, accounts, or network services.

The target mesh separates the requester from every execution stage. Prepared
partition executors serve first use; consenting contributors acquire verified
partition dependencies in the background. A complete-model peer is an implemented
integration path, not fulfillment of that distributed-partition target.

## Implemented page

- `/`: new Meta Muzil experience, responsive desktop/mobile phone, keyboard focus
  states, Manrope, original app icons and restrained warm colors.
- `/history`: preserved arena entry. Existing arena routes and assets remain.
  The historical page links back with native navigation.
- Working Messages, Calendar, Clock, Notes, Contacts, app switching, home/back,
  drafts, notification center and a tempting feed. This is a simulated OS; it
  does not observe or control real phone apps.
- Two versioned appointment scenarios. The evaluator checks the sent recipient
  and one explicit correct time. Ambiguous multi-time replies do not win. This
  intentionally bounded evaluator does not establish arbitrary semantic judgment.
- The same validated transitions serve humans and agents. Observations contain
  visible controls/text; model memory retains previously observed information.
  Notification arrival alone does not invalidate a pending contextual action.
- Local profiles store demonstrations and an explicit imitation/improvement
  objective. No fine-tuning, automatic improvement claim, or behavioral diagnosis.
- Recorded replay uses actions and scenario data; new agent play uses inference.
  Profiles and the last replay can be exported. Real reply material is not stored.
- Real Reploid WebRTC pairing with copied codes. Both players accept the same
  scenario; received outcomes are reconstructed through the evaluator. Rematches
  use fresh round IDs. Friendly time comparison is unranked and trusts reported
  timing; it does not establish cheat resistance or competitive latency fairness.
- Local or paired Doppler inference. Pairing authorizes simulated observations
  and the selected profile for requested agent play. Real reply text needs a
  separate checkbox; no automatic sending. The contributor explicitly enables
  incoming jobs. Jobs have bounded sizes, deadlines, cancellation and a single
  active slot. Disconnect rejects pending work. Unloading drains active execution.

## Source ownership and local copies

Run `npm run sync:runtime` from this repository with sibling `../reploid` and
`../doppler` checkouts. No npm/CDN runtime substitution occurs.

The script follows Reploid's relative transport/config imports. Doppler resolves
kernels and configuration dynamically, so its runtime source tree is copied with
JS, JSON, WGSL and WASM assets. Neither copy includes model binaries, node_modules,
credentials, or symlink targets. Both retain LICENSE. Generated `client/vendor/`
is ignored by git and regenerated before Hosting deployment. Do not edit copies.

`client/muzil/runtime-sources.json` records revisions, working-tree state, file
counts and aggregate source hashes; `client/vendor/manifest.json` records each
file hash. `npm run check:runtime` checks source and copy identity. A normal first
page load fetches neither vendor library. Connection loads Reploid; explicit
model preparation loads Doppler.

The selected initial model is Gemma 3 1B Q4K/F16, about 1.05 GB including tokenizer.
The script copies Doppler's tracked refreshed qualification manifest. It references
the same shard hashes as the pinned published artifact at Hugging Face revision
`7c3d30e300bcb02cbd68fb0db3eee64fbf738f99`. Explicit Hosting redirects supply those
shards/tokenizer assets without bundling weights. OPFS caching uses the local
refreshed manifest; using the old hosted manifest directly fails current runtime
validation. Copying this manifest does not certify a public signed Capsule.

First requesting-player weight bytes: zero. A contributor's model preparation
still costs bandwidth, storage, and GPU memory. Keeping an executor ready removes
that cost from subsequent requesters. The app shows unavailable capacity honestly.

## Current integration limit

The page's adapter uses Reploid's transport and complete-model Doppler execution.
It does not implement requester-to-remote-A partition entry, automatic discovery,
mesh-wide slot reservations, selective model-piece acquisition, replica placement,
checkpoint migration, automatic failover, or Bayesian scheduling. Peer output is
validated as a legal proposal; the browser is not attested trustworthy hardware.
A copied connection code does not establish broad NAT traversal. Operators can
inject a short-lived RTC configuration through `MUZIL_RTC_CONFIG`; no TURN secrets
are committed. No public seed fleet or inference service is provisioned here.

Next defining acceptance remains: a weightless requester, separate warm A and B,
a compatible replacement, and an empty contributor; direct A–B tensor exchange;
selective verified acquisition concurrent with play; draining and abrupt failure
with bounded recovery, ownership generations and no duplicate committed action.
Keep those changes in the sibling libraries' established owners.

## Commands and evidence

```sh
npm run sync:runtime
npm run dev
npm run test:muzil
npm run test:client
npm run test:muzil:browser
npm run check:runtime
# Optional physical GPU check; requires sibling local model files:
npm run test:muzil:inference
# Enforce autonomous completion as a separate quality gate:
npm run test:muzil:inference -- --require-completion
```

The browser smoke uses actual Chrome and actual local Reploid WebRTC. Its executor
fixture tests transport and cancellation only. It also plays tasks on desktop and
mobile, preserves drafts, saves demonstrations, replays, races and rematches,
and opens the historical site. Screenshots/report are written under the system
temporary directory. Model quality must be measured separately with real inference.

For local GPU evaluation, `node tools/dev-serve.mjs --local-models` exposes only
JSON/bin artifacts under `../doppler/models/local` at `/__models/`. It binds to
loopback by default; this route is absent from Firebase Hosting. Do not present
local filesystem load timing as public download timing.

The useful reply mode is an early product hypothesis. Model drafts can be wrong;
people review and copy them. There is no claim of demonstrated improvement from
personalization until unchanged and personalized agents are compared on held-out
rounds. No rankings are carried over from the historical arena.

## Retained first-build observations (2026-09-28)

- Nine new engine/controller invariants and 47 historical client tests passed.
- New page desktop/mobile task journeys, live two-tab Reploid races/rematches,
  replay validation, and a transport-fixture disconnect test passed in Chrome.
- Historical UI smoke passed at 1440, 900, and 390 pixels, including fighting,
  traits, routes, and sprite rendering.
- Actual Gemma 3 1B WebGPU inference crossed a real two-tab Reploid data channel
  on one Mac. The requester fetched zero model weights. The retained
  [raw diagnostic](meta-muzil-inference-evidence.json) shows ten model-selected
  legal decisions and a reply draft. **The unpersonalized agent did not finish
  the task within those ten decisions.** This proves execution, not competent
  autonomous completion or training improvement. The reply retained the supplied
  time but still needed human review for perspective and phrasing.
- The real UI model preparation and unload/reload path passed with local weight
  mirroring; its second load made zero weight requests, exercising OPFS reuse.
  This did not measure public Internet download time or separate physical peers.

Model quality is a concrete remaining product gap. JSON syntax is constrained by
Doppler; legal-action validation is enforced by m3t4. Neither guarantees useful
choices. Invalid proposals stop the agent and leave the phone available to the
human. The page does not manufacture task completion or substitute a script.
