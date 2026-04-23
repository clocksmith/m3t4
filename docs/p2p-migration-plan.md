# P2P Migration Plan

This document turns the current distributed-compute shape into a staged
migration plan. The goal is not "no server." The goal is to shrink the origin
to a small control and notary layer while the mesh takes over public bytes and
public execution.

## Goal

Move m3t4 toward:

- centralized ranked authority
- centralized control and signaling
- mesh-first public artifact delivery
- mesh-carried proof-task execution
- replayable receipt validation by more than one verifier

Do not move ranked truth, Elo writes, roster mutation, private configs, or
hidden strategy code into the mesh in this plan.

## Current Baseline

The repo is already partway through the migration:

- `plasma-lab` is a separate sidecar service, not part of ranked authority.
- strict WebRTC proof tasks already use `plasma-control`, `plasma-data`, and
  `plasma-receipts`.
- strict proof tasks already require `transport=webrtc`, accepted server-issued
  peer subassignments, and peer-signed subreceipts.
- browser workers already generate ECDSA P-256 receipt signatures and canonical
  `receiptHash` values.
- expected outputs are server-held for expected-hash work; workers do not see
  them in assignment payloads.
- `/compute/public/stats` and `/compute/public/contact-map/aggregate` already
  expose public aggregate views derived from accepted receipts.
- assignment intake remains closed by default and is opened only for bounded
  smoke windows.

This means the next work is not "invent WebRTC compute." The next work is:

1. make public data delivery mesh-first
2. make strict proof execution dependable enough to be default for proof tasks
3. publish a replayable receipt log and independent verification path
4. derive public fanout from that log

## Non-Goals

This plan does not attempt to:

- replace `arena-worker` for ranked authority
- make the browser authoritative for ranked outcomes
- hide private inputs inside an untrusted peer mesh
- remove the need for a signaling or policy service
- claim Byzantine resistance without admission and attestation

## Planes

Treat the system as five planes.

| Plane | Owns | Current placement | Long-term placement |
|---|---|---|---|
| Authority | ranked sim, Elo, roster writes, private configs | `arena-worker` + `arena-server` | stays centralized |
| Control | admission, signaling, assignment tickets, policy, kill switches | `plasma-lab` | stays centralized, but small and portable |
| Data | public replay artifacts, seed inputs, kernel bundles, large outputs | mostly origin-backed | `cache -> p2p -> http` |
| Validation | receipt acceptance, chunk acceptance, badge derivation | `plasma-lab` | coordinator plus independent verifier(s) |
| Presentation | UI, receipt inspector, public stats, badges | Firebase Hosting client | static shell with log-backed reads |

The long-term claim is not "serverless." It is:

- the origin is bootstrap, policy, and notary
- the mesh moves most public bytes
- peers execute bounded public work
- correctness comes from replicated validation and replayable receipts

## Invariants

These do not change during migration:

- ranked play remains server-authoritative
- WebRTC is transport, not authority
- private configs and hidden brain logic never enter public worker payloads
- proof tasks must fail closed rather than silently downgrade transport
- every accepted receipt stays assignment-bound
- every public byte used for validation must have a stable hash and stable ref

## Stage 0: Baseline

Current state. Already true:

- strict WebRTC proof path exists for controlled smokes
- signed assignment-bound receipts exist
- peer subassignments and peer-signed subreceipts exist
- public aggregate read surfaces exist

Advance from this stage only if:

- strict WebRTC proof smokes continue to pass for at least one useful lane
- intake remains closed by default outside bounded windows
- `COMPUTE_REQUIRE_RECEIPT_SIGNATURES=true` remains enforced for validation work

## Stage 1: Mesh-First Public Artifact Data Plane

Scope:

- replay bundles
- public replay/artifact verification payloads
- public-preset seed-sweep inputs
- public kernel bundles and model shards used by public workloads
- large output refs for public workloads

Do not start with generic static site assets. CDN-served app art is not the
right first migration target. Move dynamic public compute bytes first.

Transport order:

```text
local cache -> p2p -> http origin
```

Requirements:

- every payload is content-addressed
- every manifest has stable refs and hash lineage
- peers may seed bytes, but cannot rewrite manifest trust
- fallback from p2p to http is per request, not whole-session only

Success metrics before Stage 2:

- more than 50% of public compute artifact bytes served from cache or mesh
- p95 artifact fetch latency no worse than 1.5x origin
- integrity mismatch rate = 0
- p2p fallback rate below 5% for warmed public artifacts

Rollback:

- disable p2p reads via feature flag
- keep HTTP origin as immediate per-request fallback
- preserve local cache reads even if mesh reads are off

## Stage 2: Strict Proof Execution As Default For Proof Tasks

Scope:

- public-artifact verify
- replay verify
- public-preset seed sweep
- bounded tensor-tile and other exact-hash proof workloads

Shape:

- control plane stays centralized
- coordinator issues assignment and peer subassignment tickets
- bulk task bytes move over `plasma-data`
- receipts and acks move over `plasma-receipts`
- strict tasks require `requiredTransport="webrtc"` and
  `requiredPeerSubreceipt=true`

Requirements:

- no strict proof task may be accepted after silent HTTP fallback
- timeouts and stale-pair cleanup are first-class scheduler outcomes
- worker cohorts for smoke and staff/friends windows can be isolated from the
  ambient public worker pool

Success metrics before Stage 3:

- more than 30% of accepted proof-task receipts are strict WebRTC receipts
- 100% of accepted strict proof receipts carry accepted peer subassignments
- 0 accepted strict proof receipts with downgraded transport
- strict proof timeout rate below 10% in bounded windows

Rollback:

- strict proof tasks fail closed
- non-proof tasks may still use HTTP fallback
- signaling, data, or strict-proof flags can be disabled independently

## Stage 3: Durable Receipt Log And Independent Verifier

This is the load-bearing migration stage. The goal is to stop trusting one
running coordinator instance as the only source of truth for accepted public
compute outcomes.

Concrete shape:

- coordinator publishes immutable receipt-log segments
- each segment includes a monotonic `segmentSeq`, `prevSegmentHash`, stable
  ordered entries, and `segmentHash`
- entries contain the hashes and public refs needed to replay acceptance
- a second verifier consumes segments and recomputes acceptance independently

Required stable refs:

- kernel manifest ref + hash
- input artifact ref + hash
- validation-policy bundle ref + hash
- accepted receipt fields needed to recompute `receiptHash`
- chunk/task acceptance record tying receipts to the accepted outcome

Host model:

- initial publisher may be the current control-plane service writing to object
  storage
- storage must support immutable segment publication semantics
- verifier must run as a separate process or service, not in the same request
  path as the coordinator

Success metrics before Stage 4:

- independent verifier decision delta below 1% versus coordinator
- segment-hash divergence = 0
- verifier replay succeeds from published refs alone, with no private database
  reads

Rollback:

- coordinator remains authoritative for public badge publication
- independent verifier stays advisory until deltas stabilize

## Stage 4: Public Fanout From The Receipt Log

Scope:

- public receipt inspector
- replay verification badges
- public workload stats
- public verification history

Rule:

- these surfaces read from accepted log-derived views, not mutable in-memory
  coordinator state

Success metrics before Stage 5:

- badge p99 staleness below 10 seconds from accepted log entry to visible badge
- zero cases where badge state disagrees with current accepted log projection

Rollback:

- hide or freeze derived fanout surfaces
- keep ingestion and validation running

## Stage 5: Invite-Token Public Intake

Do not open anonymous public intake first. Minimum honest public-open gate:

- invite-token or allowlist admission
- required receipt signing
- accepted Device Witness promotion before useful work
- anti-correlation scheduling across worker cohorts
- per-IP and per-session caps
- quarantine path for bad workers

Reputation is not enough by itself. Public-open without admission control is a
Sybil subsidy.

Success metrics before broader public-open:

- stable accept/reject/timeout rates in staff and invite-only windows
- no uncontrolled intake outside bounded windows
- quarantine and kill switch exercised successfully at least once in staging

Rollback:

- close assignment intake
- invalidate invite-token issuance
- retain read-only public receipt surfaces

## Stage 6: Ranked Bridge For Public Or Tournament Lanes

This is the bridge between "ranked stays central" and "some sim execution can
move outward."

Shape:

- server authors the match manifest
- manifest includes stage, rules, seeds, public configs, and exact sim version
- multiple peers execute the deterministic match
- peers return signed result hashes and receipt bundles
- server ratifies only if the acceptance policy is satisfied

This is still centralized adjudication. It is not peer authority.

Restrictions:

- public or tournament lanes first
- no private ranked configs
- no hidden strategy code
- no Elo writes unless the server-authored manifest and replicated result hashes
  both satisfy policy

Success metrics before any ranked experiment:

- result-hash agreement above 99% on public deterministic manifests
- no accepted disagreement on exact-hash public sims
- replayable verifier path for ratified outcomes

Rollback:

- server resumes local authoritative execution of the same manifest

## What Stays Central Long-Term

Even in the mature shape, keep these centralized:

- sponsor and manifest publication
- discovery and signaling
- assignment ticket minting
- policy and admission control
- receipt-log publication
- ranked authority

Those do not have to live on Google Cloud forever. They do need to stay small,
observable, and portable.

## Portability

The durable requirement is a centralized control plane, not a Google-specific
control plane. The current Cloud Run deployment is an implementation choice.
The same role could run on Workers, Fly, a VM, or another host as long as it
keeps:

- stable policy endpoints
- append-safe segment publication
- low-latency signaling
- admission and rate-limit controls

## Decision Gates

Advance a stage only when:

1. exit metrics are green for that stage
2. rollback path is tested, not theoretical
3. public claim text matches the currently proven stage, not the next one

## References

- [docs/distributed-compute.md](/Users/xyz/deco/m3t4/docs/distributed-compute.md)
- [docs/compute-lab-plan.md](/Users/xyz/deco/m3t4/docs/compute-lab-plan.md)
- [../plasma/vision.md](/Users/xyz/deco/plasma/vision.md)
- [../ouroboros/docs/strategy/verified-compute-campaign.md](/Users/xyz/deco/ouroboros/docs/strategy/verified-compute-campaign.md)
