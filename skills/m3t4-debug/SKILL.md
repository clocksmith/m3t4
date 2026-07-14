---
name: m3t4-debug
description: Diagnose and fix M3T4 simulation, client, ranked server, leaderboard, scheduler, match-engine, WebRTC sidecar, receipt, replay, render, or deployed-state failures. Use when game state, authority, proof, transport, or UI differs from its contract.
---

# M3T4 Debugging

## Classify Authority

First decide whether the symptom belongs to deterministic simulation, ranked
server authority, client projection, advisory Plasma compute, or deployment.
Record seed, bot versions, match ID, server decision, receipt IDs, flags, build,
and rendered state.

## Trace Maps

- Match: bot config -> sim seed -> deterministic result -> match engine -> rank
- Leaderboard: accepted match -> persisted score -> API -> client rows/paging
- Scheduler: cron trigger -> candidate generation -> queued match -> completion
- Sidecar: assignment -> transport -> worker result -> peer subreceipt -> server
  verification -> parent receipt
- UI: API state -> client store -> canvas/DOM -> browser smoke
- Deploy: commit -> built assets -> Firebase revision -> `/config.js` -> flags

Patch the first owner that diverges. Never move ranked authority into
`plasma-lab` or treat advisory browser output as accepted proof.

## Prove

Run the owning package test, deterministic replay, and browser test when the
client participates. For hosted WebRTC failures, run the artifact and replay
smokes with assignment intake returned to `false` afterward.
