# m3t4 Architecture

m3t4 is a deterministic bot-design arena. Players build agents by
allocating a fixed budget across strategic knobs, then watch those agents
fight in a shared ruleset. The architecture has two jobs:

1. Preserve the canonical ranked meta: legal configs, server authority,
   reproducible replays, and trustworthy Elo.
2. Enable private experimentation and exhibition play without forcing
   players to reveal their bot configs.

The key distinction is that different match types prove different claims.
Every replay artifact and live match should carry an immutable trust label
that states exactly what was proven.

## Core Invariants

- The sim is deterministic for a fixed rules hash, stage, seed, players,
  and action log.
- Ranked meta authority stays centralized. Elo, match registry, seed
  issuance, account identity, and canonical roster releases are not
  decentralized.
- Bot configs are player IP. Public products should avoid revealing
  configs unless the match tier explicitly requires it.
- Replays bind to a sim version. A replay proved under one
  `REPLAY_CONSTANTS_HASH` must not silently claim validity under another.
- Offline search, RL, and community verification are allowed to discover
  pressure, but ranked play remains constrained by the legal knob system.

## Trust Labels

Trust labels are first-class replay metadata. A viewer should be able to
read one label and understand the match's proof tier without tracing the
full provenance chain.

Every replay artifact should include:

```ts
interface TrustLabel {
  tier:
    | "ranked-server"
    | "local-practice"
    | "tuple-verified"
    | "p2p-action-verified"
    | "community-verified"
    | "attested-agent"
    | "proof-carrying";
  simConstantsHash: string;
  behaviorVersion: number;
  ruleset: "m3t4";
  proofIssuedAt: string;
  proofIssuer: "server" | "client" | "community-quorum";
  verification?: {
    quorum?: { required: number; total: number; agreed: number };
    verifierIds?: string[];
    actionLogHash?: string;
    stateHashCadenceTicks?: number;
  };
}
```

Trust labels are immutable once the replay is created. If a replay is
re-verified later under the same sim hash, the verifier can append an
attestation record, but it should not mutate the original label. If the
sim hash differs, the replay is archival only unless explicitly decoded
with a mismatch override.

## Match Tiers

### Ranked Server

`ranked-server` is the canonical competitive tier.

Flow:

1. Player submits a legal `BrainConfig` through `POST /api/ranked/submit`.
2. Server validates budget, schema, and current rules compatibility.
3. Server stores the config privately.
4. Matchmaker selects opponents.
5. Server runs the sim with both configs.
6. Server archives a replay artifact with full private provenance.
7. Server updates Elo and public match summaries.

What this proves:

- Both agents were legal submitted configs.
- The approved server sim produced the result.
- Elo changes are canonical.

What remains private:

- Player configs.
- Full private replay payloads when they include config bodies.

Ranked is the source of truth for the live meta and balance decisions.

### Local Practice

`local-practice` is fully client-side.

Flow:

1. Player builds or imports a config locally.
2. Browser runs the bundled deterministic sim.
3. Player watches local matches against presets or imported bots.
4. Optional local replay export.

What this proves:

- Nothing canonical. It is a sandbox.

Why it matters:

- Fast iteration.
- No server cost.
- No config disclosure.

### Tuple-Verified Spectating

`tuple-verified` is the cheapest spectator mode for archived or canned
matches.

The server publishes a tuple:

```ts
{
  simConstantsHash: string;
  stageId: string;
  seed: number;
  playerRefs: [PublicPlayerRef, PublicPlayerRef];
  expectedLogHash: string;
}
```

Spectator clients reconstruct the match locally. This works only when the
client has enough public player data to run the sim, such as named presets
or intentionally public exhibition bots.

Tradeoffs:

- Very low bandwidth.
- Great for public preset fights and static replay pages.
- Not suitable for private ranked configs unless the server also publishes
  those configs, which it should not do by default.

### Action-Stream Spectating

`p2p-action-verified` or `ranked-server` live streams can use action
streams instead of public configs.

The server or peers stream packed action bytes:

```ts
type PackedAction = number; // left/right/up/down/action in 5 bits
```

Spectators advance the deterministic sim from the action stream and check
the final action-log hash.

Tradeoffs:

- Higher bandwidth than tuple replay, but still compact.
- Works with private configs because actions reveal behavior, not config.
- Enables live verification of the firehose.
- Does not prove that actions came from a legal config unless the tier has
  an additional authority or proof mechanism.

## Private P2P Exhibition Duels

P2P exhibitions let players duel without revealing configs. They are not
ranked meta evidence unless upgraded with stronger proofs.

### Rendezvous

1. Alice challenges Bob.
2. Server issues a signed match token:

```ts
interface MatchToken {
  matchId: string;
  playerIds: [string, string];
  stageId: string;
  seed: number;
  simConstantsHash: string;
  expiresAt: string;
  stateHashCadenceTicks: number;
  signature: string;
}
```

3. Server provides WebRTC rendezvous metadata.
4. If WebRTC fails, peers can fall back to WebSocket relay.

### Lockstep Action Streaming

For each sim tick:

1. Alice computes action A locally from her private config.
2. Bob computes action B locally from his private config.
3. Peers exchange packed action bytes.
4. Each applies both actions to local sim.
5. Both produce the same next world state if inputs and rules match.

Every `stateHashCadenceTicks`, default 120 ticks, both peers exchange a
world-state hash. Hash mismatch invalidates the match or triggers rollback
if rollback support exists.

### Finalization

At match end:

1. Both peers sign the full action log hash.
2. Both post result, action log, state checkpoints, and signatures to the
   server.
3. Server replays the action log under the token's seed, stage, and sim
   hash.
4. Server records the result if replay output matches the claimed winner.

What this proves:

- The submitted action log deterministically produces the recorded result.
- Both peers agreed on the action stream.
- The match was bound to the issued seed, stage, and sim hash.

What it does not prove:

- Either action stream came from a legal 360-budget config.
- Either player used the approved brain.
- Either player avoided hidden tools, manual control, or neural policies.

That is acceptable because this tier is a private black-box exhibition
tier. It proves the match, not the config.

## Community Verification Pool

Community verification is optional transparency and load sharing for
exhibition matches.

Default quorum policy:

- Minimum verifier pool: `M = 3`
- Required agreement: `N = 2`
- Server audit triggers on any disagreement.
- Per-match overrides may require higher quorum for tournaments.

Worker flow:

1. Worker receives match token and action log.
2. Worker replays locally under the pinned sim hash.
3. Worker submits signed result hash.
4. Server aggregates verifier attestations.
5. If quorum agrees with server replay, replay label can be upgraded to
   `community-verified`.

Community verification should never override server truth for ranked.
It can add confidence to exhibitions and provide redundancy for public
events.

## Replay Registry

The server owns the replay registry. A replay entry should include:

- `matchId`
- trust label
- sim constants hash
- behavior version
- stage hash
- seed
- player public refs
- private player refs if server-only
- action log hash
- optional packed action log
- final result
- verifier attestations
- archival warnings, including constants mismatch or missing private
  provenance

Replay artifacts should support redaction. Public views can hide private
configs while preserving hashes, player refs, and action logs.

## Server Responsibilities

The server is responsible for:

- Account auth.
- Ranked config submission.
- Ranked budget/schema validation.
- Ranked match execution.
- Elo and leaderboard state.
- Matchmaking and P2P rendezvous signaling.
- Seed issuance with signatures.
- Sim-version manifest and `REPLAY_CONSTANTS_HASH` consensus.
- WebSocket firehose.
- Replay registry.
- Verification endpoint for action logs.
- Community verifier coordination.

The server should not outsource canonical ranked truth to peers.

## Client Responsibilities

The client is responsible for:

- Building and validating local configs before submission.
- Running local practice.
- Rendering server firehose matches.
- Verifying tuple or action-stream replays when possible.
- Running P2P exhibition lockstep.
- Signing P2P action logs with session keys.
- Optionally joining the community verifier pool.

The client should treat trust labels as user-facing provenance. A replay
viewer should show the label and sim hash near match metadata.

## Privacy and Anti-Cheat Model

Private configs are protected differently by tier:

- Ranked: server sees configs, public does not.
- Local practice: only the local player sees configs.
- P2P exhibition: each player sees only their own config; actions are
  public to the match participants and any replay viewers.
- Proof-carrying future tiers: config privacy can be preserved while
  proving legality, but only with additional proof machinery.

Threats and mitigations:

- Network tampering: signatures and hash checkpoints detect altered action
  streams.
- Desync: state hash mismatch invalidates or rolls back the match.
- Post-match rewrite: signed action logs and server replay prevent it.
- Seed cherry-picking: server-issued signed seeds prevent it.
- Illegal private agent in P2P: not prevented at the action-verified tier.
  The tier label must make that explicit.
- Config reconstruction from actions: possible in theory, but the action
  stream is much lower bandwidth than the config. Playstyle is observable;
  exact knob recovery should be treated as hard but not impossible.

## Proof-Carrying Future Tiers

Proof-carrying is deferred until private-config ranked standing becomes a
product requirement.

### L1: Commit-Reveal

Player commits to `hash(config + salt)` before match, then reveals config
after match. Server verifies the revealed config is legal and reproduces
the action log.

Pros:

- Simple.
- Strong legality proof after reveal.

Cons:

- Reveals private config.
- Better for tournaments than evergreen ranked.

### L2: Trusted Execution / Attestation

Player runs an approved agent runtime in an attested environment. The
runtime proves it executed approved brain code over a legal private config.

Pros:

- Practical privacy-preserving path.
- Much cheaper than zero-knowledge proofs.

Cons:

- Native launcher likely required.
- Browser support is weak.
- Platform-specific attestation is operationally heavy.

### L3: Zero-Knowledge Replay Proof

Player proves each action was generated by approved brain code from a
legal hidden config and public observations.

Pros:

- Cleanest trust model.
- Server and opponents need not see config.

Cons:

- Hard engineering.
- Per-tick stateful brain proofs may be expensive.
- Requires circuit-friendly fixed-point policy representation.

## RL and Meta Lab

The RL/meta lab is not a shipped ranked behavior layer. It is an
adversarial research system.

Allowed uses:

- Fictitious self-play best-response rounds.
- MAP-Elites exploit atlas.
- Neural or black-box agents as search pressure.
- Distilling learned pressure back into legal knob configs.
- Discovering missing mechanics or broken trait mappings.

Disallowed by default:

- Installing neural policies directly into ranked.
- Letting RL agents define canonical balance without conversion to legal
  configs.
- Mixing RL-generated behavior changes with roster selection in the same
  evidence cycle.

The knob-brain contract remains the product. RL is a microscope, not the
game interface.

## Implementation Order

1. Add trust labels to existing replay artifacts.
2. Pin labels to `REPLAY_CONSTANTS_HASH`, `BEHAVIOR_VERSION`, ruleset, and
   proof issuer.
3. Add tuple-verified spectator mode for public/canned matches.
4. Add action-stream spectator verification for live firehose.
5. Add P2P exhibition duels with server-signed match tokens and signed
   action logs.
6. Add server verification endpoint for action-log replay.
7. Add community verification pool after P2P has real data.
8. Defer proof-carrying tiers until private-config ranked is a confirmed
   product promise.
9. Defer RL lab integration until brain-v3 and its evolved roster have
   completed Phase 4 measurement.

## Non-Goals

- Do not decentralize ranked Elo.
- Do not expose private ranked configs in public replay views.
- Do not claim P2P action verification proves legal config execution.
- Do not make community workers authoritative for ranked.
- Do not run old replays under new rules without explicit archival
  mismatch labeling.

## Design Principle

Decentralize compute, viewing, and exhibition verification where it makes
the game richer. Keep canonical ranked truth, roster releases, seed
issuance, and meta evidence centralized and versioned.
