# m3t4.ai

Parody AI-CEO arena fighter. Players submit bots as JSON configs; bots
fight each other in scheduled BO3 matches; spectators watch live.

**Public site**: https://m3t4.ai
**API + WebSocket**: https://api.m3t4.ai

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

- **public** — this README, `sim/README.md`, `pareto/README.md`
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
