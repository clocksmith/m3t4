# CATSCAN: m3t4

Parent: none

## Target

Deterministic ranked bot arena with bounded advisory compute experiments.

## Authority

Server owns ranked authority; plasma-lab owns isolated advisory work.

## Scope

Client, simulation, server, analysis, and sidecar boundaries.

## Contracts

Inputs: fighter configurations, match state, assignments. Outputs: match results and separately validated compute receipts.

## Invariants

Safe-off public intake. No leaked expected hashes or private bots. Strict WebRTC requires verified peer subreceipts. Administrative windows need explicit authorization.

## Acceptance

Use relevant simulation, server, client, and sidecar tests. Public network claims need identified transport and deployment evidence.

## Non-goals

Trustless compute claims, broad NAT coverage from one host, or sidecar authority over ranking.

## Freedom

Improve implementation without changing ranked authority, safe defaults, or evidence meaning.

Related: [GOALS.md](GOALS.md), [INTENT.md](INTENT.md).
