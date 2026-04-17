# Canonical Replay Artifact v1

A replay artifact is the durable record needed to replay a match from the same
initial state. It is not the live websocket frame stream. Frames are optional
presentation data; the canonical source of truth is the initial state plus the
packed action log.

## Root

```json
{
  "schema": "m3t4.replay",
  "version": 1,
  "createdAt": "2026-04-17T00:00:00.000Z",
  "sim": {},
  "match": {},
  "players": [{}, {}],
  "initial": {},
  "actions": {},
  "result": {},
  "integrity": {},
  "frames": {}
}
```

## Required Sections

`sim` identifies the ruleset that must interpret the recording. Ranked
artifacts must include at least one build binding: `sourceHash` or
`constantsHash`. Practice/test/generated artifacts may omit them, but replay
tools should surface a warning because unbound artifacts can silently diverge
under a different simulator build.

```json
{
  "packageName": "@m3t4/sim",
  "ruleset": "m3t4-sim-v1",
  "stepHz": 120,
  "packageVersion": "optional",
  "sourceHash": "optional",
  "constantsHash": "required for ranked if sourceHash absent"
}
```

`match` stores the immutable match identity:

```json
{
  "matchId": "ranked-abc123",
  "mode": "ranked",
  "seed": 123,
  "stageId": "datacenter",
  "startedAt": "optional"
}
```

`players` has exactly two entries. `side` is canonical: `0` is left/P1, `1` is
right/P2. `config` is optional for private bots because the action log is enough
to replay physics, but `configHash` should be present whenever config is hidden.

```json
{
  "side": 0,
  "kind": "brain",
  "tier": "user",
  "label": "slot name or human label",
  "handle": "optional",
  "userId": "optional",
  "slotId": "optional",
  "slotName": "optional",
  "controls": "optional string or { scheme, bindings } snapshot for humans",
  "config": "optional BrainConfig snapshot",
  "configHash": "stable hash of config if available"
}
```

`initial` embeds snapshots, not only IDs, so a replay can survive future stage or
character changes:

```json
{
  "stage": "Stage object",
  "chars": ["Character P1", "Character P2"]
}
```

`actions` is the canonical replay stream:

```json
{
  "encoding": "decision-action-pairs-v1",
  "bytesBase64": "base64 Uint8Array",
  "byteLength": 2000,
  "decisionTicks": 1000,
  "hash": "fnv1a32"
}
```

Each decision tick contributes two bytes: packed P1 `Action`, then packed P2
`Action`. Bits match `packAction`: left=1, right=2, up=4, down=8, action=16.
Freeze and round-pause ticks consume no bytes; the replay decoder advances those
from world state exactly like the sim does.

`result` mirrors the public match result without embedding the raw byte array:

```json
{
  "winner": 0,
  "finalScore": [3, 1],
  "finalRounds": [2, 0],
  "ticks": 12345,
  "logHash": "existing sim action hash"
}
```

`integrity` stores stable hashes for quick validation. These are 32-bit FNV-1a
hashes for corruption detection and cache identity only. They are not
cryptographic and are not an anti-cheat or replay-forgery boundary.

Decoders MUST recompute every entry from the in-artifact payload and compare
against the stored value before running the sim (`verifyReplayIntegrityV1`).
Without this check, a mutation of `initial.stage` or `players[i].config`
would silently produce a different replay outcome.

```json
{
  "stageHash": "fnv1a32",
  "charsHash": "fnv1a32",
  "playerHashes": ["fnv1a32", "fnv1a32"],
  "actionLogHash": "fnv1a32",
  "frameLogHash": "optional"
}
```

## Optional Frames

`frames` can cache visual frames for streaming, scrubbing, or debugging. The
frame payload is intentionally opaque to the v1 replay schema; compatibility is
gated by `frames.encoding`, not by the canonical action-log schema.

```json
{
  "encoding": "trace-frames-v1",
  "stride": 1,
  "frameCount": 12345,
  "hash": "fnv1a32",
  "frames": ["opaque trace-frames-v1 payload"]
}
```

Frames are not authoritative for match outcome. Exact replay reconstructs the
world from `initial` and `actions`, then compares `result.logHash` and the final
score/round/tick fields.
