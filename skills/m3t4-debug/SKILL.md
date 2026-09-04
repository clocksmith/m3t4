---
name: m3t4-debug
description: Diagnose a named M3T4 simulation, client, server, scheduler, sidecar, receipt, replay, render, or deployment failure; repair it only when requested.
---

# M3T4 Debugging

Diagnosis is read-only. Patch the identified owner only when the user's request includes implementation.

## Prerequisites

Supply the match or replay identity, seed, bot/build versions, failing authority
surface, expected result, and relevant server, client, sidecar, or receipt evidence.

## Procedure

1. Classify the authoritative surface and capture its identities.
2. Trace simulation, server, client, sidecar, receipt, replay, and deployment boundaries.
3. Report the first mismatch; if repair is requested, patch its owner and prove the
   original seed or replay through the applicable tests.

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

When repair is requested, patch the first owner that diverges. Never move ranked authority into
`plasma-lab` or treat advisory browser output as accepted proof.

## Prove

Run the owning package test, deterministic replay, and browser test when the
client participates. For hosted WebRTC failures, run the artifact and replay
smokes with assignment intake returned to `false` afterward.

## Validation

The original state or replay is deterministic, the authoritative receipt verifies,
and any browser or sidecar surface observes the same accepted result.

## Stop Conditions

Stop before changing ranked authority or enabling hosted assignment intake without
explicit authorization. Stop if the authoritative receipt or replay seed is absent.

## Outputs

An authority-scoped diagnosis with seed and receipt evidence and, for an authorized
repair, deterministic replay, focused test, and browser or sidecar results.

## Side Effects

Diagnosis reads evidence and may run local replays. Authorized repair may edit M3T4
and create test artifacts; ranked authority, hosted intake, and deployment stay off.
