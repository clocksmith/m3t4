# SELF Arena

A competitive arena platform around the SELF fighter. JSON configs define
brains, brains play scheduled bracket matches, spectators watch live.

Four packages:

```
arena/
  sim/       — deterministic, headless TypeScript simulator (@selfplay/sim)
  server/    — Node HTTP + WebSocket server (@selfplay/server)
  client/    — spectator SPA (vanilla JS, imports compiled sim ESM)
  pareto/    — Monte Carlo + Pareto frontier toolkit (@selfplay/pareto)
  theming/   — character / stage visual kits (data only)
```

See `public/labs/self/PLAN.md` for the full design document.

---

## Quick start

```bash
cd arena
# Install all workspaces (sim, server, pareto)
npm install --workspaces

# Build everything
npm run build

# Run a single headless match
npm run sim -- --a blitz --b moonshot --seed 1

# Verify determinism over many runs
(cd sim && node dist/cli.js --determinism oracle --opp disruptor --n 30)

# Score a random sweep against the 12 named strategies
npm run pareto -- --n 20 --seeds 2 --include-named

# Boot the arena server (broadcasts a new bracket every 60s)
npm run server
# → :7777 with /ws WebSocket and /api/* REST

# Open the spectator client
cd client && python3 -m http.server 8080
# http://localhost:8080 (expects server at :7777)
```

Override the arena server URL the client points at:

```html
<script>window.__SELF_ARENA_SERVER__ = "https://your.server";</script>
```

---

## Config format

A BrainConfig is JSON:

```json
{
  "id": "my-bot",
  "author": "alice",
  "attributes": {
    "burnRate": 1.0,
    "moat": 20,
    "shipRate": 0.5
  }
}
```

Any attribute missing takes its default (`DEFAULT_PARAMS` in sim/types.ts).

Attributes can be **numbers** (static), **DSL strings** (evaluated per-tick),
or **structured objects** (base + ramp + oscillate + triggers).

```json
{
  "attributes": {
    "burnRate":   "0.3 + 0.6 * clamp(tick / 1200, 0, 1)",
    "moat":       "90 + 30 * sin(tick * 0.013)",
    "shipRate":   1.0,
    "pivotSpeed": "self.hp < 40 ? 0.9 : 0.2",

    "leverage": {
      "base": 0.0,
      "triggers": [
        { "when": "opp.hasToken && opp.y < 300", "value": -0.8 }
      ]
    }
  }
}
```

**DSL guarantees** (enforced by `sim/src/dsl.ts`):

- Whitelisted functions only: `sin cos abs sqrt floor ceil min max clamp sign step smoothstep`
- Read-only access to `tick`, `self.*`, `opp.*`, `game.*`
- No loops, no assignment, no `Function`, no `eval`
- AST depth ≤ 8, total nodes ≤ 40
- Deterministic — the only randomness anywhere is the seeded match RNG

---

## Attributes (8 canonical knobs)

| Knob | Range | What it does |
|---|---|---|
| `burnRate` | 0..1 | swing eagerness + range |
| `moat` | px | preferred horizontal distance from opponent |
| `shipRate` | 0..1 | token delivery priority |
| `foresight` | 0..0.3 sec | predict opponent position ahead |
| `pivotSpeed` | 0..1 | retreat from active blades |
| `leverage` | -1..+1 | vertical preference (-1 above, +1 below) |
| `networking` | 0..1 | wall-jump / wall-climb use |
| `hallucination` | 0..100 | perturbation + override blindness. Higher = worse. |

---

## Determinism

Same config + seed → byte-identical frame log, on every JS engine:

```bash
cd sim
node dist/cli.js --determinism blitz --opp oracle --n 100
# → OK: 100 runs ... all hash to <fnv>
```

This is load-bearing: server authoritative replays stay in sync with client
re-simulation for spectating; offline Pareto scoring is reproducible;
replay URLs work without re-running the server.

---

## Viral primitives baked in

- Every match produces a seed-addressable replay URL (to be wired into the
  server: `/replay/<cycleId>/<matchIndex>`).
- Server emits OpenGraph-ready cards per cycle winner (stub; phase 2).
- Every minute, the live spectator page gets a fresh bracket — no state
  required to participate as viewer.
- Config submission is pure HTTP POST of a JSON file; no SDK.

See `public/labs/self/PLAN.md` §8 for the full virality design.

---

## Package-specific docs

- `sim/` — see `sim/src/index.ts` for the full public API
- `server/` — see `server/src/index.ts` for REST + WebSocket endpoints
- `pareto/` — see `pareto/src/sweep.ts` and `pareto/src/evolve.ts`
- `client/` — see `client/viewer.js` for the spectator loop
- `theming/` — data-only; character and stage kits for future phases
