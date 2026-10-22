# One-second objective hold and archived replay compatibility

## Current gameplay

Rules version 2 requires the living gold carrier's existing scoring anchor to
stay strictly inside the existing 40-unit target radius for 120 consecutive
active simulation steps (1 second at 120 Hz). The counter is integral, so tick
119 cannot score and tick 120 does. Leaving the radius, death, transfer, or
losing gold resets that attempt. Freeze and score pauses do not advance it.

The gold outer ring fills from the frame's authoritative `holdTicks` /
`holdRequiredTicks`. It has no render-delta accumulation, wall-clock countdown,
or frame-history interpolation. The existing purple objective-expiry ring stays
separate. Replaying, seeking, pausing, or rendering a frame again cannot advance
the hold ring. Goal pulse animation now uses simulation ticks too.

The ten-second goal expiry and round/match tie-break rules are unchanged. Expiry
is still checked before hold completion on the same tick; scoring still precedes
the round-timeout check. Hit freeze and pauses retain their existing timer behavior.

## Explicit compatibility routing

- Rules 0: behavior v23, original stage geometry without the v24 vertical walls,
  no stage-local horizontal wall collision, historical floating 0.12-second dwell.
- Rules 1: behavior v24/v25, current wall geometry/collision and historical dwell.
- Rules 2: new one-second integer hold; emitted by new artifacts and match docs.

Replay artifacts carry `sim.rulesVersion`; archived artifacts resolve their known
constants hash or historical behavior version. Match-feed playback validates the
full recorded outcome, refuses incomplete logs or unknown rule bindings, and uses
the same historical stage for simulation and display. Stored full replay stages
are not replaced. No historical action log is regenerated with today's brain.

The v23 stages are copied verbatim from source commit
`cfd4d63993ba1cfc96e75ac5e0d2dab743ec6581`. Commit
`c6d3326110b1f0c115cd6c7fb23054a93279e1fe` introduced exactly the six walls and
horizontal collision path. The v24/v25 physical-frame reference was the shipped
engine at `0edd630`, with behavior v25 and unchanged v24 physics.

## Verification evidence

On 2026-10-22, all 700 pre-existing archive documents were compared against their
historical physics and recorded results: 200 v23 and 500 v24, all on Datacenter.
Every winner, score, rounds, tick count, action-log hash, and per-tick physical
frame matched. For v23 only, the comparison omitted `lastAttackStartTick` and
`respawnT`, two additive render-pose fields introduced by the prior graphics
release; every original frame field matched exactly. Before this change, all
200 v23 documents diverged when replayed against today's walled stage.

`sim/src/test/fixtures/archive-frame-hashes.json` pins representative original
full-frame SHA-256 values. `v25-replay.json` is an independent sealed v25 action
log (Blitz vs Shipper, seed 13579, 7200-tick horizon) with its full-frame hash.
`legacy-replay-provenance.json` records source identities and the complete archive
parity check. These fixtures must not be regenerated using the current rules.

Focused verification commands:

```sh
npm -w sim run build
npm run sync:client-sim
npm -w match-engine run build
node --test sim/dist/test/goal-hold.test.js sim/dist/test/replay-rules.test.js \
  sim/dist/test/replay.test.js sim/dist/test/timeout-tiebreak.test.js \
  sim/dist/test/dwell.test.js sim/dist/test/respawn-timing.test.js \
  sim/dist/test/platform-wall.test.js client/test/goal-progress.test.mjs \
  client/test/match-feed-replay.test.mjs client/test/fighter-art.test.mjs
```

Tests cover threshold boundaries, strict radius exit/reentry, killing transfer,
death/drop/double KO, pause/freeze, objective expiry, round timeout ordering,
legacy full-frame hashes, unknown/corrupt replay refusal, repeated replay, and
render-only fraction/seek invariance. Browser ring playtesting belongs to the
combined-release integration; this evidence is not a browser-layout claim.
