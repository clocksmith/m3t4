# m3t4 goals

## Mission & Thesis

m3t4 develops a deterministic bot arena in which configured fighters can compete and their behavior can be studied. Bounded distributed-compute experiments sit beside that arena, not above it. The strategic distinction is between authoritative ranked game execution and advisory work whose results require their own validation and do not automatically affect a match.

## Intended Beneficiaries

Players and bot authors need understandable rules, reproducible matches, and protection of private fighter logic. Operators need reliable ranked authority and explicit rollback controls. Compute researchers need a contained environment for examining transport, task execution, and receipts without presenting laboratory results as a public trustless network.

## Desired Outcomes

1. Reproduce arena behavior from declared simulation inputs and fighter configurations.
2. Keep ranked decisions under the server's authority while the browser presents the game faithfully.
3. Evaluate bot changes and parameter sweeps without exposing private configurations to opponents.
4. Demonstrate bounded compute tasks with identified assignments, signed receipts, and clearly stated transport conditions.
5. Keep laboratory controls separate from ordinary gameplay and public participation.

## Operating Loops

Define or revise a fighter configuration, run the deterministic simulation, inspect the match, and compare controlled results. For compute experiments, open an explicitly authorized bounded intake window, issue assignments, validate returned evidence, and return intake to its safe state. Use isolated sidecar records to explain what was tested instead of promoting an arena result into an unrelated network claim.

## Strategic Constraints

Ranked arena authority stays in the server; plasma-lab remains advisory. Public compute intake stays disabled by default, with COMPUTE_ACCEPT_ASSIGNMENTS=false as the primary rollback. Workers must not receive server-held expected hashes. Strict WebRTC evidence requires the declared transport and an accepted, verified peer-signed subreceipt. Production validation requires signatures, but signatures alone do not establish honest hardware or honest execution. Keep administrative credentials and private bot logic out of public artifacts.

## Explicit Exclusions

Do not claim anonymous proof of useful work, Sybil resistance, broad NAT coverage, shared GPU buffers, or fused kernels from mocks or single-host tests. This charter does not authorize enabling compute intake or deployment. Do not substitute visual polish, peer counts, or sidecar activity for correctness of the ranked game.

Related: [INTENT.md](INTENT.md), [CATSCAN.md](CATSCAN.md).
