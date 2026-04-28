# P2P Migration Plan

The migration goal is not to remove servers. The goal is to keep servers small:
Firebase Functions handle identity, signaling writes, assignment tickets, match
authority, and validation; browsers carry public bytes and public execution
when peers are available.

## Current baseline

The repo now has these P2P/Firebase pieces in source:

- `webrtcSignal` callable Function for stateless Firestore-mediated signaling.
- Spectator mesh client that can relay match/action data over WebRTC and fall
  back to Firestore/static docs.
- Firebase compute client that attempts WebRTC peer execution and falls back to
  local plasma worker execution.
- Firestore presence docs for spectator mesh and compute peers.
- Session cleanup through `expireSessions`.
- Expected-hash compute validation through Firebase Functions.

## Long-term planes

| Plane | Owns | Current placement |
| --- | --- | --- |
| Authority | ranked/live match execution, Elo, private configs | Firebase Functions |
| Control | auth, signaling writes, assignment tickets, policy | Firebase Functions |
| State | matches, stables, receipts, presence | Firestore |
| Data | match/action streams, compute work/results | WebRTC with Firestore/static fallback |
| Validation | expected-hash receipt acceptance | Firebase Functions |
| Presentation | spectate/profile/compute UI | Firebase Hosting |

## Invariants

- Ranked truth does not move to peers.
- WebRTC is transport only.
- Private configs and hidden brain logic never enter public peer payloads.
- Public bytes used for validation need stable hashes.
- Every compute receipt stays assignment-bound.
- Any future strict proof mode must fail closed rather than silently downgrade
  and still count as strict evidence.

## Stage 0: Static and callable substrate

Status: implemented in source.

- Static matches run from Hosting.
- Firebase client config supports static, live, mesh, and compute flags.
- Auth/profile callables handle handles and stable submission.
- Firestore rules define private/public boundaries.

## Stage 1: Live Firebase authority

Status: implemented in source, deploy-gated.

- `matchTick` runs authoritative matches.
- `bootstrapMatch` starts the chain.
- `matchTickWatchdog` repairs stalls.
- Cloud Tasks schedules the next tick.
- Active stables fall back to public system presets if needed.

Exit condition:

- Live feed produces continuous public match docs without Cloud Run arena
  services.

Rollback:

- Disable live client flag and return to static match feed.

## Stage 2: Spectator mesh fanout

Status: implemented in source, deploy/config-gated.

- First available spectator can act as primary Firestore reader.
- Later spectators discover peers through `meshSessions`.
- WebRTC data channels carry match docs/action payloads.
- Firestore/static feed remains fallback.

Exit condition:

- Multiple browsers can watch the same match with only one direct Firestore
  reader in the happy path.

Rollback:

- Disable mesh flag; direct Firestore/static feed remains intact.

## Stage 3: Firebase P2P compute

Status: implemented in source, deploy/config-gated.

- `computeClaim` mints public deterministic work.
- Functions store expected hashes privately.
- Browser attempts peer execution over WebRTC.
- Local plasma worker fallback executes the same chunk.
- `computeSubmitReceipt` validates and aggregates stats.
- WebGPU-capable browsers can receive WebGPU-preferred lanes.

Exit condition:

- `/compute` can opt in, receive assignments, submit accepted receipts, and show
  aggregate public stats with compute Functions deployed.

Rollback:

- Disable `__M3T4_COMPUTE_FIREBASE__` in Hosting config.

## Stage 4: Public receipt/audit hardening

Future work:

- Add signed receipt envelopes if anonymous public proof needs stronger audit
  semantics.
- Publish append-only receipt-log segments for independent verification.
- Add duplicate/quorum validation for selected lanes.
- Add admission/invite policy before any broad public-open compute campaign.
- Keep aggregate stats privacy-suppressed.

## Stage 5: Public artifact mesh

Future work:

- Content-address public replay/receipt bundles.
- Fetch large public artifacts through `cache -> p2p -> http`.
- Keep HTTP fallback per request.
- Verify hashes before using peer-supplied bytes.

## Stage 6: Tournament/public-manifest execution

Future work only. A server-authored public manifest could be executed by
multiple peers, then ratified by Functions if result hashes agree. This remains
central adjudication, not peer authority.

Restrictions:

- public configs only
- exact sim version only
- no private ranked configs
- no hidden strategy code
- no Elo writes without server ratification

## What stays centralized

- Auth and account identity.
- Submission validation.
- Handle uniqueness.
- Ranked/live match authority.
- Elo/public stable projections.
- Signaling write validation.
- Assignment minting.
- Expected-hash storage.
- Receipt validation.
- Kill switches and deployment flags.

These centralized roles can move hosts in the future, but they should remain
small, observable, and authoritative.
