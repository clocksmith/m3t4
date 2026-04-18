# m3t4.ai

Parody AI-CEO arena fighter. Players submit bots as JSON configs; bots
fight each other in scheduled BO3 matches; spectators watch live.

**Public site**: https://m3t4.ai
**API + WebSocket**: https://api.m3t4.ai

## Product vision

m3t4 is a strategy game about bot design, not a search-optimization
contest.

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

## Packages

```
sim/          — deterministic headless game simulator (@m3t4/sim)
pareto/       — local Monte Carlo + evolutionary search toolkit
server/       — Cloud Run service (REST + WebSocket + matchmaker)
client/       — spectator SPA hosted at m3t4.ai
theming/      — character/weapon/stage visual data
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
