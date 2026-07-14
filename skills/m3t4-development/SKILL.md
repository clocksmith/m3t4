---
name: m3t4-development
description: Implement and validate M3T4 arena client, deterministic simulation, ranked server, match engine, Pareto analysis, and Plasma sidecar behavior. Use for game mechanics, leaderboard, scheduled matches, browser UI, distributed-compute contracts, receipts, or deployment preparation.
---

# M3T4 Development

## Load The Contract

Read `AGENTS.md`. Use `PROVISIONING.md` for deployments,
`docs/compute-lab-plan.md` for operations, and
`docs/distributed-compute.md` for public claims.

## Ownership Map

- Browser app: `client/`
- Deterministic arena simulation: `sim/`
- Ranked authority: `server/`, `match-engine/`
- Analysis and sweeps: `pareto/`
- Advisory compute experiments: `plasma-lab/`
- Shared neutral contracts: sibling `plasma` repo

## Implement

1. Keep ranked decisions server-authoritative and simulation deterministic.
2. Rebuild and sync `sim/src` changes into the browser copy.
3. Keep private bot logic and expected result hashes off public clients.
4. Keep public assignment intake off unless the user authorizes a controlled
   window.
5. Bind strict WebRTC claims to server assignments, peer subreceipts, transport,
   signatures, and replay verification.
6. Validate visual changes on desktop and mobile without changing mechanics
   unintentionally.

## Validate

- Simulation: `npm -w sim test`
- Client: `npm run test:client`
- Server: `npm -w server test`
- Sidecar: `npm -w plasma-lab test`
- Browser copy: `npm run check:client-sim`
- Static content: `npm run check:content`
- Full build: `npm run build`
- Final hygiene: `git diff --check`

For hosted compute work, run the named Plasma smoke and report production flags.
