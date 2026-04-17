# Brain Tuning (PRIVATE)

**DO NOT PUBLISH.** This document captures design decisions, tuning journey,
and meta weak-spots that would let readers reverse-engineer the game.
`/public/` is the Firebase-deployed tree; everything in `/arena/` is
private by default. Keep it that way.

---

## 1. Mechanical design

### 1.1 Attribute count

- **12 total sim parameters**: `burnRate, moat, shipRate, foresight, pivotSpeed, leverage, networking, spite, greed, pacing, cunning, hallucination`
- **11 are user-budgeted** (everything except `hallucination`)
- `hallucination` is reserved for:
  - The satire ("trust the vibes") baked into `acolyte`
  - User overspend penalty: `clamp(10 × (spent - 360), 0, 300)`
  - Evolutionary search, which can freely explore high-hallucination space

### 1.2 Why these 11

Each attribute was chosen to occupy an **orthogonal strategic axis**. We
explicitly avoided duplicate knobs. Here's the axis each covers:

| Knob | Axis | What a high value does |
|---|---|---|
| `burnRate`    | aggression intensity      | widens swing range (50→130 px) |
| `moat`        | preferred spacing         | bot maintains farther distance |
| `shipRate`    | token delivery priority   | bot drops fighting to deliver |
| `foresight`   | prediction depth          | aims for opponent's predicted pos |
| `pivotSpeed`  | retreat reflex            | fleeing from active blades |
| `leverage`    | vertical preference       | -1 = above opp, +1 = below |
| `networking`  | wall-jump use             | climbs walls, seeks walls for altitude |
| `spite`       | score vs deny             | -1 = pure intercept, +1 = pure delivery |
| `greed`       | delivery commitment       | pushes through danger to deliver |
| `pacing`      | tempo pattern             | sin-wave burst on burnRate |
| `cunning`     | swing timing patience     | patient = wait for openings only |

Don't add more without removing something — the search space is already
huge; more knobs without removing one just dilutes each one's importance.

### 1.3 Budget derivation

**Current value: 360 points.**

Derivation (in order of attempts):

1. First attempt: `200 / 7 ≈ 28.6 avg fill × 11 knobs = 315`. Arbitrary
   scaling of the old 7-knob budget. Tested: worked but unprincipled.
2. Empirical measurement of named strategy footprints: min=369 (`blitz`),
   max=557 (`oracle`), median=491.
3. Settled on **9 points below the leanest named**: `369 - 9 = 360`.
   This means users **cannot exactly replicate any named strategy** — they
   have to out-engineer the meta.

**Why not 369 (exact blitz footprint)?** Because that would let users
copy `blitz` verbatim, which is an uninteresting build. 9 below forces
a genuine choice.

**Why not lower (280 or 315)?** Tested both. 315 produced best-bot WR of
81.7%, 360 produced 81.1%. Basically identical — the budget-evolver hits
a ceiling set by the game's non-transitivity, not by the budget. Lower
budgets only made the builder feel punishing without changing best-WR.

**Why not higher (400+)?** Gave users too much room; evolution found
dominant bots at ~85%+ WR, which violates the "no single best bot" rule.

### 1.4 Goal dwell time

**Current value: 0.5 s.**

Pre-dwell, pure-shipper bots (max `shipRate`, everything else zero)
could touch-and-score instantly, hitting 85% WR in the old 8-knob
system. Added dwell:
- Carrier must stay within 32 px of the goal for 0.5s to score
- `dwellT` resets on leave, death, steal
- Implemented in `arena/sim/src/simulate.ts` `updateGold()`

After dwell:
- Pure-shipper exploit: 85.0% → 52.2%
- Dumb max-shipRate control bot: tested at 39.3% (can't win by ship alone)
- Budget-evolved best: 81.7% → uses delivery + combat balance

**Don't tune this without retesting balance.** Dropping to 0.3s brings
back the exploit; raising to 0.8s makes delivery effectively impossible
and destroys the objective loop.

### 1.5 Hallucination mechanic

Two things derived from `hallucination ∈ [0, 100+]`:

1. **Param noise**: each tick, perturb each knob by `±(hallucination/100 × 0.5 × range)`.
   At h=100 that's ±50% of each knob's native range; at h=300 that's ±150%.
   Noise is deterministic per match seed/tick/fighter/parameter.
2. **Anti-stall override blindness**: the "must fight" override that kicks
   in when the bot has no tokens is *weakened* by hallucination. At h=100
   the override is fully disabled — the bot trusts its raw personality
   even when it shouldn't.

The mechanism ensures higher hallucination is strictly worse. No
"sweet spot" where a bit of noise helps.

---

## 2. Named strategies (design intent)

The 16 named strategies are the **evolved roster**. They were derived by
budget-aware diversity-first evolution (`pareto/src/roster-evolve.ts`)
against a co-evolving opponent pool, not hand-authored archetypes. Each
persona label was chosen after the fact to match the dominant attribute
behavior of the evolved config. `founder` is intentionally the weakest
(~25% internal WR) as a running joke.

On the bug-fixed sim, this roster achieves:
- Max preset WR: 73.4% (`unicorn`)
- Best legal-config WR from 50-gen directed search: 75.3% (gap: 1.9%)
- Random-search ceiling: 38.9%
- 16×16 H2H cycles: 273

The archetype descriptions below capture the observed behavior of each
evolved config, not an imposed identity.

| Name | Archetype | Designed to test |
|---|---|---|
| `standby`    | no-op baseline       | dead ref for debugging |
| `blitz`      | pure aggression      | low moat + high burn + greed — leanest build |
| `incumbent`  | defend objective     | high shipRate + cunning, camps goals |
| `pivot`      | adaptable all-rounder| balanced mid-range |
| `disruptor`  | aerial pressure      | negative leverage + pacing, deny-leaning |
| `operator`   | balanced utility     | "sane defaults" across the board |
| `oracle`     | deep lookahead       | max foresight (0.20) — prediction specialist |
| `shipper`    | pure delivery        | max shipRate + greed + spite +1 (selfish) |
| `moonshot`   | chaotic all-in       | max burn + no pivot + pacing burst |
| `regulatory` | patient counter      | max cunning + pivotSpeed, waits to punish |
| `founder`    | wall specialist      | max networking + negative leverage |
| `acolyte`    | controlled chaos counter | h=10 bot; counters denial-spacer budget champs |
| `unicorn`    | rare + valuable      | high-cunning aggressive closer, top-half performer |
| `intern`     | minimalist joker     | lowest spend, disengages — somehow top-WR anyway |
| `troll`      | bait-from-below      | only positive-leverage bot (0.8) |
| `acquirer`   | close-pressure mobility | low moat + high networking |

### 2.1 Known strategy weak spots

| Strategy | Vulnerable to | Notes |
|---|---|---|
| `shipper`   | any combat pressure near goal (dwell nerf) | used to dominate |
| `blitz`     | high-pivotSpeed opponents | runs itself into counters |
| `moonshot`  | anything patient | chaos rarely connects |
| `oracle`    | unpredictable opponents (acolyte) | high foresight hurts vs noise |
| `troll`     | anyone not in the air | niche bot, loses in current meta (~28% WR) |
| `acolyte`   | acquirer / pivot / shipper / troll | controlled chaos has clear counters |

These weaknesses are **intentional** — they make the meta
non-transitive. `acolyte` now exists mainly to counter frontier
denial-spacers, while still losing to mobility, delivery, and bait
archetypes. That creates cycles that prevent any strategy from being "best."

### 2.2 Sanity: each strategy should win SOME matchups

- Ran full H2H with 3 seeds × 3 stages per pair
- Confirmed every named strategy has ≥1 opponent it beats >55%
- If this ever breaks (a strategy becomes strictly dominated), consider
  replacing or retuning. Total dominance = removing that strategy from
  the meta silently.

---

## 3. NP-hardness evidence (empirical)

**Not a formal proof.** Three signals measured on the 16-strategy + DSL
space:

| Signal | Method | Current value | Threshold |
|---|---|---|---|
| Max random WR | 100 random bots vs 16 refs, 3 seeds | 83.7% | < 85% = "not trivially solved" |
| RPS cycles in H2H | 16×16 matrix, 5 seeds, count (A>B>C>A, all >60%) | 24 | > 0 = non-transitive |
| Mutation roughness | 30 small mutations of top bot, std of WR | 11.4% | > 8% = rough |

**What these DON'T prove:**
- Not that the game is NP-hard in the Turing-machine sense
- Not that no one can beat it
- Not that future optimizers won't find something

**What they DO support:**
- No linear ranking of strategies exists (cycles)
- Random search won't stumble on a solution (max bounded)
- Gradient methods will stick in local optima (roughness)

**If you ever make changes that drop cycles below 10 or push max random
over 85%, the game has become TOO SOLVABLE.** Roll back.

---

## 4. Tuning journey (what we tried, what failed)

### 4.1 Soft hallucination penalty on overbudget — RESTORED, STEEPER

Earlier attempt: `hallucination = clamp(2 × (spent − budget), 0, 300)` as a
soft penalty instead of hard-capping the spend.

Why rejected: the test showed peak WR at spent=350 (50 *over* the
nominal 300 budget, with hallucination=50). Going over was *better*
than respecting. At the time, the live sim only had override-blindness,
which saturated at h=100; there was no live per-tick param noise.

Current: users may overspend, but `hallucination = clamp(10 × overage, 0, 300)`
is enforced by builder and submit validation. Per-tick param noise is live, so
h=300 is severe instead of just "override disabled."

### 4.2 Budget progression

- `budget = 300`: too tight (everyone lost)
- `budget = 400`: too loose (evolved bot at 194 pts hit 85%)
- `budget = 200` (old 7-knob): proper balance, budget-binding
- `budget = 315` (11-knob, scaled naively): worked but arbitrary
- `budget = 360` (11-knob, principled just-below-leanest): current

### 4.3 What NOT to do

- **Don't tune attributes independently.** They interact. `spite` and
  `shipRate` are coupled; `cunning` and `burnRate` are coupled. Change
  one without re-testing the full H2H and you'll introduce dominance.
- **Don't add attributes without removing one.** 11 is already a lot.
  Dilution of each attribute's importance makes tuning harder.
- **Don't simplify the DSL.** The trajectory/expression system is
  critical for the "huge search space" claim. Reducing it to scalars
  would make the game solvable by simple optimization.
- **Don't publish the tuning details** (this file). Letting users know
  the exact budget math, strategy footprints, and known weaknesses would
  let them reverse-engineer the meta and flatten the game.

---

## 5. Operational notes

### 5.1 Files that encode the tuning

- `sim/src/types.ts` — `PARAM_KEYS`, `DEFAULT_PARAMS`
- `sim/src/brain.ts` — `runParamBrain` (all 11 attributes applied)
- `sim/src/simulate.ts` — hallucination param noise
- `sim/src/budget.ts` — `USER_BUDGET`, `USER_KNOBS`, derived hallucination, submit validation
- `sim/src/strategies.ts` — the 16 named configs
- `sim/src/constants.ts` — `STATS`, `GOAL_DWELL_S = 0.5`
- `pareto/src/budget-util.ts` — analysis helpers that import canonical budget math
- `client/modes/build.js` — UI budget, overage, and exported hallucination

### 5.2 When to re-test

Run the full NP-hard + budget test after ANY of:

- Changing `USER_BUDGET`
- Changing `GOAL_DWELL_S`
- Changing `STATS.*` physical constants
- Adding/removing an attribute
- Adding/removing a named strategy
- Changing `runParamBrain` logic

Commands:

```bash
cd arena/pareto
node dist/nphard-large.js 150 3          # sweep + H2H + roughness
node dist/evolve-budget.js --gens 8 \
  --pop 24 --seeds 2                      # best-in-budget ceiling
node dist/budget-test.js --gens 8 \
  --pop 24 --seeds 2                      # fixed-spend exploit search
```

If any of those produce:
- Max random WR ≥ 85%
- Cycle count ≤ 8
- Best-in-budget WR ≥ 90%
- Mutation std ≤ 5%

... revert the change. The game is solvable.

### 5.3 Monte Carlo meta expectations

- One full 16×16 H2H, 5 seeds × 3 stages: ~3,150 matches → ~16s on 8 cores
- 200-bot sweep, 3 seeds: ~27,000 matches → ~2.5 min on 8 cores
- Overnight evolve (8h, pop 32, gens unlimited): ~1M matches

### 5.4 Internal-only observations

- `shipper` is the most obvious exploit candidate. Always test nerfs
  against it.
- `acolyte` was retuned after live hallucination noise made h=90 unusable.
  It now uses h=10 controlled chaos and should remain counterable by
  `acquirer`, `pivot`, `shipper`, and `troll`.
- `troll` is near-unviable (~28% WR). It's a "research bot" that
  exists to fill the positive-leverage axis. Users who pick it are
  self-imposing a handicap. Fine.
- `disruptor` + `regulatory` + `founder` are the three most consistent
  winners in the current meta. If any one of them hits 75%+ alone,
  it's time to nerf.

### 5.5 If you inherit this project

Read, in order:

1. `arena/README.md` — architecture overview (public)
2. `public/labs/self/PLAN.md` — game design rationale (public)
3. **this file** — tuning internals (private)
4. `arena/sim/src/simulate.ts` — the actual game loop
5. `arena/sim/src/brain.ts` — how attributes map to behavior

Don't skip #3.

---

*Last updated: after the 16th strategy (`acquirer`) was added and the
11-attribute balance pass confirmed green on all NP-hard signals.*
