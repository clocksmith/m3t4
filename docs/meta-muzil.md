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

- `/`: a short introduction and bouncing phone peeking out of a pop-up toaster.
  The orange lever and start button press, pop and expand it into the playable phone.
  The menu has only Play, Watch AI play, and Play with a friend. A centered
  m3t4.ai task thought sits above the phone, fading into scattered text after
  five seconds; recall reveals it without navigating the simulated phone.
  Desktop/mobile layouts and reduced-motion and keyboard paths are supported.
- `/history`: preserved arena entry. Existing arena routes and assets remain.
  The historical page links back with native navigation.
- Messages supports search, drafts, sending, and new conversations through Contacts.
  Calendar has month/day navigation, event details, and event creation/editing/deletion.
  Clock supports adding, editing, toggling and deleting alarms. Notes supports
  multiple autosaved notes, search and deletion. Contacts has searchable cards,
  editable names/phone/email, creation/deletion, and a Message action.
  App switching, home/back, notification center and the feed remain available.
  Event/contact drafts can be resumed after app switches; interruptions return to
  the same editor. All changes use shared human/agent actions and deterministic
  replay. Deleting a contact preserves the conversation and recipient identity.
  Each new round starts from its challenge data; these are round-local changes.
  This is a simulated OS; it does not observe or control real phone apps.
- Eight JSON-defined challenges compose contacts, messages, calendar events,
  notes, alarms and interruptions. Each shipped challenge has one outcome: a
  message, an alarm, or a note update, using information distributed across apps.
  The predicate format also supports `all`/`any` for authoring.
  [Authoring guide](muzil-challenges.md) covers catalog edits and local imports.
  The original two scenarios remain available to qualification tools and replays.
- Doom Scroll is a native scrolling fictional social feed with seeded multilingual
  posts, local language/nonsense heuristics, likes, and scroll-reactive WebGPU
  effects. Five cards stay mounted; CSS fallback and reduced motion are supported.
  Post navigation and likes are recorded through the shared action engine.
- The same validated transitions serve humans and agents. Observations contain
  visible controls/text; model memory retains previously observed information.
  New JSON rounds use phone rules v2: top banners must be opened, with no
  dismissal or navigation bypass for humans or agents. Distraction banners lead
  through reveal/pairs/timing, group-chat replies, a reaction, and a link into
  Doom Scroll. The original task is not automatically restored. Drafts persist;
  the clock keeps running. Exact duplicate alerts coalesce, resolved alerts stay
  resolved, and each completed interruption gives eight seconds before the next
  mandatory banner. These detours never satisfy the task. Version 1 replays keep
  their old dismissal and optional-game behavior.
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

## Distributed execution

The distributed helper uses Reploid's authenticated requester entry and direct
A–B partition channel. Only contributors import Doppler execution. The requesting
phone sends authorized observations and receives proposed actions; it carries no
intermediate tensors. The phone validates match, round, controller, attempt and
observation ownership before applying a still-legal action.

The mesh policy explicitly selects both the model artifact directory and its
piece-index URL. Their existing identity pins remain mandatory. A missing or
unavailable policy fails before preparing compute; selecting another model cannot
silently retain Gemma's artifact URLs. Initializing coordination alone imports no
Doppler runtime and downloads no model weights. Action decision receipts include
completion timestamps for recovery measurement; real reply text is not added to
those metrics.

Doppler defines executable partitions and an independently hash-verified piece
index. Reploid coordinates bounded acquisition, cache reuse and source replacement.
This page supplies an exact HTTP range source and OPFS cache; it does not yet
supply a peer weight source. Shared embeddings are genuinely needed by both stages.
The pinned-manifest development path is not signed Capsule qualification.

Contributors advertise readiness after actual loading. Draining refuses new work
and settles admitted attempts. Loss can restart an affected request on another
explicitly connected entry with a new attempt and ownership generation. This is
reconstruction from authorized input, not KV-cache migration. Healthy requests
retain their owners. A rematch cannot accept an old inference result.

Earlier Gemma inference was exercised between a Mac and an Intel Linux machine through
Tailscale WebRTC, with no requester weights. One retained baseline produced eight
valid model actions and a first valid action in 5.6 seconds. It did **not** finish
the appointment. Subsequent lifecycle runs exercised joining, abrupt loss, restart
and draining, but failed the valid-action gate on model output formatting. Those
runs did not meet product acceptance; do not infer autonomous completion from transport
or unit-test success. Whole-model comparison reproduced an empty model response
to the same longer prompt, so that failure was not unique to split execution.

Discovery uses explicit connection codes. No public seed fleet, automatic
placement, global reservations, checkpoint migration, Bayesian scheduling, or
public signed model acquisition is provisioned. Peers are not attested hardware.
Operators can inject `MUZIL_RTC_CONFIG`; no TURN credentials are committed.
The Reploid test-only `tests/fixtures/tailnet-stun.js` can expose tailnet ICE
candidates where browsers advertise only LAN addresses. SSH access alone does not
prove a WebRTC route.

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
npm run test:muzil:mesh -- --ui --personalized --lifecycle --require-completion
# Enforce autonomous completion as a separate quality gate:
npm run test:muzil:inference -- --require-completion
# Compare unchanged and personalized controllers against an explicit artifact:
npm run test:muzil:model -- --model-dir /absolute/model-directory --out /tmp/muzil-candidate
# Run on a separately prepared browser (CDP and app origin must be reachable):
npm run test:muzil:model -- --model-dir /local/manifest-directory \
  --cdp http://127.0.0.1:9334 --origin http://127.0.0.1:7795 \
  --model-url http://127.0.0.1:7806 --out /tmp/muzil-remote-candidate
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

Model quality is a concrete remaining product gap. Models propose commands;
legal-action validation is enforced by m3t4. Valid syntax and legal controls do
not guarantee useful choices. Invalid proposals stop the agent and leave the phone available to the
human. The page does not manufacture task completion or substitute a script.

## Model qualification and controller corrections

The candidate runner pins the served manifest, records the loaded model identity,
and compares an unchanged controller with a fixed demonstration fixture on the
other appointment scenario. Every evaluated move comes from real Doppler
inference. The fixture supplies training examples only. Qualification requires
both controllers to finish within the real round duration and reproduce their
outcomes through replay. Preparation time, first valid action, rejected proposals,
and actual execution identities are retained. A valid move alone does not pass.

Local generation now uses the same command prompt, output budget, and explicit
greedy sampling settings as the mesh.
Previously it inherited Doppler's repetition penalty of 1.1. Demonstrations retain
their observed text and visible result, select the same app/contact and compatible
control availability, and precede current observations. Empty and send-ready drafts
are different demonstration contexts; transient notifications do not discard an
otherwise relevant example. This prevents unrelated example screens
from being presented as immediate action suggestions. It does not establish that
the model learns or improves. Responses identify the model actually loaded.

The pinned original Qwen3 1.7B checkpoint and its F16 Doppler conversion produced
identical input and output token IDs on three unmasked greedy checks. Matching the
sampling settings removed the missing `app:` prefix in the baseline check. Both
implementations reproduced the old prompt's incorrect demonstration-time copy;
that failure was not unique to GPU execution. Relevant examples placed before the
current state corrected the first move in an independent checkpoint probe.

See the [retained candidate evidence](meta-muzil-model-qualification-evidence.json).
Gemma Q4 and F16 still failed the full task: the unchanged controller proposed an
unavailable target, and personalized controllers repeated legal but unproductive
moves. Qwen F16 made legal moves on the Intel helper but both rounds expired;
first valid actions took 46.7 and 70.6 seconds. Its unchanged controller also
drafted the wrong appointment time. Late/partial output from the expired trained
round was rejected. All six recorded outcomes reproduced through replay.
No replacement artifact is published or selected by these experiments.
Transport acceptance and autonomous task completion remain separate gates.

## UI lifecycle proof

The `--ui` mesh proof teaches through actual phone controls, then runs the app's
own agent loop on the other appointment. It records inputs, proposed actions,
accepted action bindings, saved replays, screenshots, and first valid action time.
The lifecycle gate requires complete replayable rounds during contribution,
draining, and abrupt executor loss, plus an unaffected concurrent round. It stops
if the initial round fails. Isolated legal actions cannot satisfy this gate.

`MUZIL_PROOF_POLICY_URL` selects a pinned candidate policy without changing the
site default. `MUZIL_REMOTE_STAGE=0` places stage A on the remote CDP browser;
stage B is local. The default remote stage remains B. The report identifies the
host count, exact served product source hashes, runtime source lock, and policy
hash. Local contributors use separate persistent Chrome profiles, removed after
the run; requesters remain fresh private contexts. Preparation records selective
verified byte counts and preserves acquisition failures before cleanup. Browser
storage estimates are approximate: a private Chrome test reported ample quota
but rejected an actual cache write after about 1.5 GB. That preparation correctly
failed before advertising readiness, and the underlying quota error is surfaced.

## Two-host Qwen integration result (2026-09-29 UTC)

The [retained real-UI report](meta-muzil-qwen4b-mesh-evidence.json) passes the
bounded lifecycle gate with Qwen3 4B Instruct 2507 Q4K/F16. Linux executes the
embedding and first layer; the Mac executes the remaining 35 layers and output.
The human lesson is the first appointment. The agent chooses every move on the
other appointment, using visible observations and remembered notifications.

| Round | First valid action | Completed | Accepted agent actions |
|---|---:|---:|---:|
| Prepared baseline | 19.555 s | 79.304 s | 4 |
| Contributor joining | 26.407 s | 90.908 s | 4 |
| Executor draining | 22.228 s | 83.476 s | 4 |
| Abrupt executor loss | 49.796 s | 137.049 s | 4 |
| Concurrent healthy path | 49.657 s | 136.908 s | 4 |

All five saved replays reproduce the completed outcome. Both requesting pages
fetched zero weight files, imported no Doppler execution runtime, and sent or
received zero binary data-channel bytes. Activation traffic stayed on executor
links. The newcomer acquired 2,771,424,141 verified bytes for stage B and became
ready in 18.757 seconds while a round continued. Those bytes came from a local
artifact server; this is not an Internet download benchmark. First-action delay
during acquisition increased by 6.852 seconds in this single comparison.

Draining settled admitted work and released its resident. Abrupt tab loss restarted
only the affected decision under a new attempt/placement generation; the next
valid result arrived 37.743 seconds after loss. The concurrent healthy round did
not restart. Shared compute still increased its latency. Recovery reconstructs
from authorized input; no generation-state migration is claimed.

This uses two physical hosts and multiple browser executors on those hosts.
Joining and loss concern browser participants, not a third physical machine or a
whole-host outage. It does not qualify public discovery, NAT-diverse access,
long-running availability, signed Capsules, or other models. The first action
latency remains substantial even though the phone opens without weights.

The [controller diagnostics](meta-muzil-qwen4b-controller-evidence.json) retain
the failed variants as well. Earlier profiles repeatedly rewrote the correct
draft. Preserving visible demonstration results and using the same command
protocol locally and remotely produced a completed trained fixture. Its unchanged
engine-fixture baseline still failed to finish within 16 moves. This single task
does not establish general accuracy or broad improvement from personalization.

The [candidate test policy](meta-muzil-qwen4b-test-policy.json) pins the exact
model, piece index and asymmetric plan. Its `/__models/` URLs are local proof
routes. The production selection remains Gemma; the Qwen artifact has not been
published or selected for the live site. Doppler's conversion-promotion protocol
requires human coherence review before catalog/Hugging Face publication.

## Simplified opening and harder rounds (2026-09-30)

The browser smoke now completes the multi-app intention on desktop and mobile,
including persisted drafts, saved demonstrations, replay and two-peer rematches.
It also checks keyboard entry, reduced motion, initial zero-weight requests and
the historical route. Engine tests cover both completion orders, wrong and
ambiguous details, the latest sent reply, continued interruptions and expiration.

The retained Qwen integration evidence above applies to the original appointment
task. Model completion and latency on the harder task have not been measured.
The UI mesh smoke teaches the new task for the next qualification run; changing
the game does not promote a model or change executor readiness or production flags.

## Mini-app interaction checks (2026-09-30)

`npm run test:muzil:apps` exercises event, alarm, note, contact and message controls
in Chrome at 1440, 390 and 320 pixels, including interrupted event drafts,
app-switch persistence, search, deletion, completed-round replay and overflow.
Engine tests also reject invalid saves and stale controls. Existing phone, race,
interruption and Doom Scroll browser suites cover the surrounding game.
These checks do not qualify real-model performance on the expanded controls.

## Mandatory attention detours and thought layout (2026-10-01)

The intention is centered above the phone without a card, border, or side offset.
The simulated iPhone-style banner animates once below the status bar, without a
full-screen scrim. Banner markup is compared against its last generated string,
not the browser's normalized SVG serialization, avoiding a repeated entrance
animation on every timer tick.

The interruption browser suite checks banner position and DOM identity over time,
forbidden dismissal/navigation, the full reaction/link chain, manual return to a
saved draft, centered thought geometry and replay at 1440, 390 and 320 pixels.
Engine tests verify duplicate suppression, the gap between interruptions, queued
alerts, expiration, and version 1 replay compatibility. Real AI completion on
these rules has not been qualified.
