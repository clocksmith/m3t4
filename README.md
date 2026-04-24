# m3t4.ai

Parody AI-CEO arena fighter. Players submit bots as JSON configs; bots
fight each other in scheduled BO3 matches; spectators watch live.

**Public site**: https://m3t4.ai
**API + WebSocket**: https://api.m3t4.ai

## Product vision

m3t4 is a strategy game about bot design, not a search-optimization
contest.

One browser session carries both lanes:

- **Game lane**: ranked-deterministic arena, server-authoritative matches,
  live spectator stream, and a hard-to-exploit curated meta.
- **Compute lane**: opt-in, receipt-carrying public compute through the
  isolated `plasma-lab` sidecar, advisory-only and device-idle-gated.

North-star business sentence:

> Players can watch, compete, and optionally donate receipt-carrying compute
> from a single browser session, where ranked authority stays server-side,
> compute stays advisory, and every public receipt is independently
> verifiable.

Current implementation is not allowed to overclaim that final clause. Today,
public compute receipts are signed, validation-bound, and receipt-log
verifiable; the no-private-database third-party verifier is still a public-open
gate.

- **Player layer**: spend a fixed budget across strategic knobs to
  build a bot, watch it fight in a deterministic arena. Fun should
  come from understanding tradeoffs — delivery pressure, spacing,
  denial, aggression, recovery timing, movement — not from brute-
  force knob tuning.
- **Meta layer**: the curated 16 presets define a credible playable
  ceiling. A strong custom bot should be *possible*, but no obvious
  legal build should crush the roster by exploiting a single
  overpowered trait.
- **Technical north star**: turn a vast discrete strategy space into
  a hard-to-exploit, high-power, diverse meta. Trait knobs stay
  legible and orthogonal; the roster is diverse and internally
  cyclic; external search finds interesting counters, not universal
  exploits; landscape changes are reproducible through versioned
  constants, replay hashes, exploit archives, and audit records.

The success test is whether a determined-but-bounded user search can
meaningfully out-play the curated meta. If they can, the knobs or the
roster have a structural gap — not a tuning error.

### Terms

- **meta**: the set of strategies that actually works against strong
  opposition.
- **self-play**: evolving candidates against the current roster and
  Hall of Fame so the roster learns from its own counters.
- **exploit**: a legal config or family that beats too much of the
  roster for one simple reason.

m3t4 maintains its meta with an adversarial loop: evolve a diverse
roster, attack it with legal search, archive the counters, then change
exactly one thing when a universal exploit appears. Sometimes the fix
is roster selection; sometimes it is the trait-to-brain mapping. The
goal is not to eliminate counters, but to make counters specific,
costly, and understandable.

## System architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    USER BROWSER  (https://m3t4.ai)                       │
│                                                                          │
│   CORE (always on)                         OPTIONAL (feature-flagged)    │
│   ┌─────────┐  ┌─────────┐  ┌────────┐     ┌──────────────────────┐      │
│   │ live    │  │practice │  │  build │     │     #duel            │      │
│   │ WS feed │  │ local   │  │ editor │     │  (p2pDuel flag)      │      │
│   └────┬────┘  │  sim    │  └────────┘     │  WebRTC + signaling  │      │
│        │       └─────────┘                  └──────┬───────────────┘     │
│        │       ┌─────────┐                         │                     │
│        │       │ submit  │──── bearer token ───────│                     │
│        │       └────┬────┘                         │                     │
└────────┼────────────┼─────────────────────────────┼──────────────────────┘
         │ /ws        │ POST /api/ranked/submit     │ /api/duel/*
         ▼            ▼                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│             SERVER  (https://api.m3t4.ai · Cloud Run · Node+ws)          │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐    │
│   │ CORE routes (server/src/routes/)                                │    │
│   │  /api/ranked/submit  /api/leaderboard  /api/stables/:uid        │    │
│   │  /api/verify/replay  /api/spectate/tuple/:id   WS /ws firehose  │    │
│   └─────────────────────────────────────────────────────────────────┘    │
│   ┌─────────────────────────────────────────────────────────────────┐    │
│   │ OPTIONAL routes (gated by CONFIG.features)                      │    │
│   │  p2pDuel         → server/src/p2p/          /api/duel/*         │    │
│   │  communityVerify → server/src/community/    /api/community/*    │    │
│   │  proofLab        → server/src/labs/proof/   /api/proof/*        │    │
│   │  compute         → server/src/compute/      /api/compute/*      │    │
│   └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│   ┌──────────────┐  ┌──────────────────────┐  ┌──────────────────┐       │
│   │ Firebase     │  │   @m3t4/sim          │  │  StableStore     │       │
│   │ auth adapter │  │  brain v5 +          │  │  configs · Elo · │       │
│   │ (dev/prod)   │  │  deterministic sim + │  │  replays         │       │
│   │              │  │  replay/hash format  │  │  (File · Fire-   │       │
│   │              │  │                      │  │   store prod)    │       │
│   └──────────────┘  └──────────────────────┘  └──────────────────┘       │
└──────────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ (offline-only; never touches prod)
                                  │
┌─────────────────────────────────┴────────────────────────────────────────┐
│              pareto/ TOOLKIT (developer laptop)                          │
│                                                                          │
│  roster-evolve      → evolves candidate 16-bot roster via adv-gated      │
│                        search                                            │
│  adversarial-attack → Phase 4 external exploit search (certification)    │
│  trace-stalls       → mode-telemetry breakdown of stall patterns         │
│  meta-health        → combined-pool H2H report (release gate)            │
│  phantom-gate       → internal ecology gate (cycles, uncountered, max)   │
│  install-roster     → writes sim/src/strategies.ts canonical 16 presets  │
│                                                                          │
│  Cycle: evolve → install → phantom-gate → meta-health → attack → ship    │
└──────────────────────────────────────────────────────────────────────────┘
```

Key invariants:

- **Sim is shared**: one deterministic engine runs in-browser (practice,
  local verify), on-server (ranked, `/verify/replay`), and in `pareto/`
  tools. Brain version + physics constants hash into
  `REPLAY_CONSTANTS_HASH`; any rule change bumps it.
- **Ranked never touches p2p**: even with feature flags on, ranked
  matches always run server-authoritatively. p2p is exhibition-only,
  non-ranked, nav-hidden in beta.
- **Compute never crosses into ranked authority**: compute receipts may
  decorate public artifacts after validation, but they never mutate Elo,
  rosters, match scheduling, private configs, hidden brain logic, or ranked
  outcomes.
- **Renderer owns the device**: browser compute only borrows measured slack.
  It is not "every game frame is a science frame," fused-kernel compute, or
  shared-buffer compute until a later Plasma derived-compute contract exists.
- **pareto/ is offline**: evolves and tests locally; only the output
  (`install-roster` writing `sim/src/strategies.ts`) touches prod.
- **Feature flags are the beta knob**: `CONFIG.features = { p2pDuel,
  communityVerify, proofLab, zk, distributedCompute }`. All off by default. Client hides
  the nav item; server skips registering the route set entirely.

## Packages

```
sim/          — deterministic headless game simulator (@m3t4/sim)
                brain state machine, physics constants, replay format
pareto/       — local Monte Carlo + evolutionary search toolkit
                roster-evolve, adversarial-attack, meta-health,
                trace-stalls, phantom-gate, install-roster
server/       — Cloud Run service (REST + WebSocket + matchmaker)
  routes/     —   core: ranked, replay-verify
  p2p/        —   optional: exhibition duel (WebRTC signaling)
  community/  —   optional: federated replay-verification workers
  compute/    —   optional: Plasma-lite spectator compute coordinator
  labs/proof/ —   optional: L1 commit-reveal, L2 attestation,
                  L3 zk envelope
client/       — spectator SPA hosted at m3t4.ai
  modes/      —   spectate, practice, build, submit (+ duel flag-gated)
theming/      — visual-only asset manifests: stages, sprites, VFX, prompts
content/      — display copy, fiction, HUD strings, fighter/weapon names
config/       — selected presentation IDs for a release
data/         — generated local/runtime data such as preset rankings
docs/         — architecture and renderer contracts
```

## Quick start (dev)

```bash
cp .env.example .env.local
npm install --workspaces
npm run build

# API + WS on :7777
cd server && npm start

# Static SPA on :5173, reads ARENA_API_ORIGIN from env
cd client && npm run dev
```

## Offline toolkit

See `pareto/README.md`. The Monte Carlo/evolution tools are local-only
— they never touch the production server or pool.

## Docs

- **public** — this README, `ARCHITECTURE.md`, `sim/README.md`, `pareto/README.md`
- **private** (do not publish):
  - `ARENA_DESIGN.md` — competitive-layer architecture + threat model
  - `BRAIN_TUNING.md` — mechanical tuning internals, balance journey
  - `PROVISIONING.md` — GCP setup + deploy runbook

## Heritage

The sim + search toolkit started under [256one](https://256.1)'s `arena/`
labs tree; see 256one's commit history for pre-fork context. This repo
is the production home.

## Licensing

TBD. Sim code likely MIT. Named strategies, tuning config, and the live
meta stay proprietary.
