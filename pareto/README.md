# @m3t4/pareto — local strategy search toolkit

Everything you need to search the SELF strategy space offline. No Firebase,
no server, no accounts — just `node`.

## Tools

| Script | What it does |
|---|---|
| `sweep.js` | Score N random configs against the 12 named strategies. Report Pareto frontier. |
| `h2h.js` | Full pairwise win-rate matrix. Detects rock-paper-scissors cycles. |
| `sensitivity.js` | For one config, sweep each knob over N points. Ranks knobs by how much they move win rate. |
| `evolve.js` | Evolutionary search. Checkpoints each generation, `--resume`-able. |
| `replay.js` | Generate a self-contained HTML replay file. Share with anyone. |

All tools use a shared worker pool so they max out your CPU cores.

## Setup

```bash
cd arena
npm install --workspaces
npm run build
cd pareto
```

## A typical local workflow

### 1. Get a baseline of the named strategies

```bash
node dist/h2h.js --configs @all --seeds 3
```

You get a 12×12 win-rate matrix + any cycles. Look for:

- Which configs dominate most opponents?
- Any cycles (A > B > C > A)? That tells you the meta has counter-play.

### 2. Sweep random configs to explore the space

```bash
node dist/sweep.js --n 200 --seeds 2 --out sweep.json
```

200 random configs × 12 refs × 3 stages × 2 seeds × 2 sides = 28,800
matches. On an 8-core laptop with workers, ~2 minutes. The frontier ends
up in `sweep.json`.

### 3. Find what makes your best candidate work

Pull a frontier member's config out of `sweep.json` into `bot.json`, then:

```bash
node dist/sensitivity.js --config bot.json --points 5 --seeds 2
```

Ranks knobs by how much win rate moves when you sweep each one across its
range. The top-ranked knob is load-bearing; the bottom one is noise.

### 4. Evolve against the meta

```bash
node dist/evolve.js --gens 10 --pop 24 --seeds 2 --state run1.json
```

Starts with the named strategies seeded into the population. Each
generation: score all, take the Pareto frontier, produce the next
generation via elitism + crossover + mutation + fresh randoms.

State is saved after every generation to `run1.json`. Crash or
ctrl-C? Resume:

```bash
node dist/evolve.js --resume --state run1.json --gens 20
```

### 5. Visualize a match

Pick an interesting match (best evolved bot vs a named strategy, say):

```bash
node dist/replay.js --a bot.json --b moonshot --seed 1 --out match.html
open match.html
```

`match.html` is ~50 KB, self-contained, opens in any browser. Share by
attaching to anything — email, Discord, git.

## DSL configs

Any attribute can be a DSL expression instead of a scalar. Examples:

```json
{
  "id": "ramp-aggro",
  "attributes": {
    "burnRate": "0.3 + 0.6 * clamp(tick / 1200, 0, 1)",
    "moat": "90 + 30 * sin(tick * 0.013)",
    "shipRate": 1.0,
    "pivotSpeed": "self.hp < 40 ? 0.9 : 0.2"
  }
}
```

```json
{
  "id": "panic-switcher",
  "attributes": {
    "burnRate":      { "base": 0.4, "triggers": [ { "when": "self.hp < 30", "value": 1.0 } ] },
    "moat":          { "base": 100, "triggers": [ { "when": "self.hp < 30", "value": 0 } ] },
    "shipRate":      1.0,
    "hallucination": { "base": 5,   "triggers": [ { "when": "self.hp < 20", "value": 60 } ] }
  }
}
```

See `arena/sim/src/dsl.ts` for the full whitelist.

## Performance

| Config | Matches/sec |
|---|---|
| Single core (--workers 1) | ~70 |
| 8 workers on 8 cores | ~215 |

Overhead (IPC, worker spawn) caps parallel speedup at ~3-4× in practice.
For bigger sweeps you'll want overnight runs; for quick iteration one seed
× one stage is plenty. `sensitivity.js` is a great "is this knob worth
tuning?" check that runs in seconds.

## Hacking

- **Add a new scoring objective**: edit `src/frontier.ts` (the `OBJECTIVES`
  array). Pareto fronts naturally expand with more objectives.
- **Restrict random sweep ranges**: edit `src/generate.ts` (the `RANGES`
  map).
- **Add a mutation operator**: edit `src/generate.ts` (`mutateConfig`,
  `crossoverConfig`). For example, a "DSL mutator" that turns a static
  scalar into a `{base, ramp}` trajectory would be ~10 lines and open up
  the time-varying strategy space.
- **Different reference population**: replace `STRATEGY_NAMES` in tool
  scripts with a list of paths to JSON configs.

## Files

```
src/
  parallel.ts      — worker pool
  worker.ts        — per-worker simulate() harness
  score.ts         — batch scoring, ScoreRecord shape
  frontier.ts      — Pareto frontier computation
  generate.ts      — random/mutate/crossover
  sweep.ts         — CLI: random sweep
  h2h.ts           — CLI: head-to-head matrix
  sensitivity.ts   — CLI: per-knob sensitivity
  evolve.ts        — CLI: checkpointing evolve
  replay.ts        — CLI: self-contained HTML replay
  index.ts         — public API
```
