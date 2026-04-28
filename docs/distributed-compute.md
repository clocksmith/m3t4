# Distributed Compute Claim Boundary

This document defines what m3t4 can and cannot claim about browser distributed
compute.

## Current claim

m3t4 supports opt-in advisory browser compute for public deterministic
workloads. Firebase Functions mint assignments, keep expected hashes private,
and validate submitted output hashes before counting receipts. Browsers execute
work in an off-thread plasma worker, prefer WebRTC peer execution, and fall back
to local worker execution when peers are unavailable.

Safe public phrasing:

> Opted-in browsers can run public deterministic compute jobs. Results are
> receipt-bound and accepted only after Firebase Functions validate the output
> hash against a server-held expected hash. This does not affect ranked match
> authority.

## What is true

- Compute is opt-in.
- Anonymous Firebase Auth can identify unauthenticated workers.
- Assignments are public-input deterministic chunks.
- Server-held expected hashes are not returned to the browser.
- Receipts bind assignment, task, chunk, kernel, input hash, output hash,
  transport, execution mode, and client version.
- WebRTC can carry work/results between browsers.
- Local browser worker fallback keeps the system useful without enough peers.
- WebGPU-capable browsers can receive WebGPU-preferred lanes.
- Aggregate public stats can be shown without exposing private stable configs.

## What is not true

Do not claim:

- ranked matches run on untrusted peers
- browsers are trusted hardware
- GPU execution is attested
- anonymous compute is Sybil-resistant
- private configs or hidden brain logic are sent to workers
- compute receipts can mutate Elo or ranked scheduling
- WebRTC transport by itself proves correctness
- every game frame is a science frame
- fused-kernel or shared-buffer compute is production-ready
- public users can propose arbitrary workloads

## Workloads allowed in the Firebase path

Allowed workloads are deterministic, bounded, and public:

- small integer searches
- public preset seed sweeps
- public exploit-search scans
- public asset/image/microscopy tile analysis
- synthetic/public genome k-mer histograms
- protein-adjacent public residue-window contact maps
- Mandelbrot and heat-diffusion tiles
- tensor tiles
- device witness fixtures

Disallowed workloads:

- private ranked config evaluation
- hidden brain policy execution
- arbitrary user-submitted code
- private image/model/data inference
- canonical ranked match execution
- training workloads without a validator story
- tasks needing tolerance-based scientific judgment unless the validator is
  explicitly designed for that tolerance

## Receipt boundary

A Firebase compute receipt proves only:

- the Function issued an assignment to an authenticated worker session
- the submitted output hash matched the expected hash stored server-side
- the receipt was accepted or rejected by the current validation policy

It does not prove:

- who physically operated the device
- that a GPU was honest
- that the result came from the claimed browser rather than another local tool
- that the worker is unique across identities

This is still useful because the jobs are public and deterministic. The receipt
is an accounting and validation record, not a hardware attestation.

## Authority separation

Ranked authority lives in baked static artifacts or Firebase Functions live
match execution. Browser compute is separate.

Allowed bridge:

```text
public game artifact -> public compute assignment -> accepted receipt -> public badge/stat
```

Forbidden bridge:

```text
compute receipt -> Elo mutation
compute receipt -> private config access
compute receipt -> match scheduling authority
compute receipt -> roster release authority
```

## WebRTC language

Safe language:

- "WebRTC peer execution is attempted before local fallback."
- "WebRTC reduces server data transfer when peers are available."
- "Firebase Functions remain the notary and validator."

Unsafe language:

- "serverless proof"
- "trustless GPU compute"
- "decentralized ranked matches"
- "the swarm decides match results"

## Public UI copy rule

Use short, concrete wording:

- "Opt in to run public verification and science-shaped kernels."
- "Receipts are advisory and do not affect ranked matches."
- "Your browser computes only public chunks; private bot configs are not sent to
  compute workers."

Avoid broad claims about AI training, private inference, or guaranteed rewards.
