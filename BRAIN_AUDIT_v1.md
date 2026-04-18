# Brain-mapping audit — BEHAVIOR_VERSION 1

Diagnostic output from Phase 4a adversarial attack against v5-annealed
roster (baseline commit `0708505`). Attack run: `pareto/exploits/v5a/`.

## Evidence summary

| signal | value | read |
|---|---|---|
| mean validatedWr (15 of 16 targets) | 78.2% | roster broadly exploitable |
| max validatedWr | 93.3% (unicorn) | single preset fully defeated |
| g24-family share | 11 / 15 | one dominant basin |
| transferable (>55%) | 12 / 15 | counter rolls most of the roster |
| cheap counters (top3 < 250) | 14 / 15 | user can find cheaply |
| defenders (valWR < 65%) | 3 / 15 (regulatory 57%, intern 68%, operator 68%, founder 45%) | narrow defender set |

## g24-x38 attribute profile

| knob | native | UI | role |
|---|---|---|---|
| foresight | 0.190 | 76 | peak — drives prediction |
| leverage | 0.151 | 58 | slightly below opp |
| burnRate | 0.520 | 52 | moderate swing reach |
| greed | 0.501 | 50 | will commit to delivery |
| shipRate | 0.336 | 34 | not ship-focused |
| pacing | 0.167 | 17 | steady |
| cunning | 0.095 | 10 | near-zero — reflexive |
| moat | 0.000 | 0 | stays close |
| networking | 0.039 | 4 | ignores walls |
| spite | -0.028 | 49 | neutral |

Spent 360/360. **Foresight is the dominant axis.**

## Where g24 exploits `brain.ts`

Foresight appears in only **two** places in brain code, but its effects propagate through **every** tactical decision via `dist`:

```ts
// brain.ts:176
const predX = obs.opp.x + obs.opp.vx * E.foresight;
const dx = predX - obs.self.x;
const dist = Math.abs(dx);

// brain.ts:243
if (mutualImminent && E.foresight > 0.08) { /* preempt hop */ }
```

`dist` — the *predicted* distance — then drives:

- danger detection (`dist < 100`)
- counter-punish trigger (`dist < 160`)
- mutual-imminent check (`dist < 150`)
- stuck-detector close check (`dist < 200`)
- post-clash mixup range (`dist < 110`)
- moat management (`dist > moat + 15`)
- swing reach (`dist < swingRange`)
- safe-strike gate (`dist < 70` inner safety)

**Every positioning and swing decision uses predicted distance, not actual distance.** With g24's `foresight = 0.190` and opp at typical `vx = 300–600 px/s`, predicted distance can differ from actual distance by **60–150 px** — more than a full sword reach.

Meanwhile the sword HIT at the actual physical moment happens at the actual position. So high-foresight bots:
- pre-position themselves to where opp *will be*
- arrive just as opp arrives → swing lands
- retreat before they actually need to (danger detected one foresight-interval early)
- enter/exit swing range based on predicted crossing

## Structural gap

**Foresight has no opportunity cost in the mapping.** It:
- costs 76 UI points (31% of 360 budget — material but not prohibitive)
- linearly improves prediction accuracy
- automatically improves 8 downstream tactical gates
- requires no tradeoff in another axis

A user maxing foresight pays 31% of budget and gets a free-everywhere prediction system. Every other knob has clear local effect (burnRate → swing reach, moat → preferred distance, etc.) — foresight multiplies across the whole policy.

This matches the audit question from the plan: *"Does high foresight create too much free anti-head-on behavior?"* Yes.

## Why regulatory and moonshot resist

Both are delivery-forward configs. Their strategic axis is orthogonal to foresight:
- Regulatory (shipRate 0.47, pacing 0.17): focuses on getting to goal, not positioning vs opp
- Moonshot (shipRate 0.47, pacing 0.43, leverage 0.5): high-pacing delivery rush

High-foresight bots predict opp position to land swings. Delivery-committed bots don't care where opp is going to be — they're committing to the goal path. Foresight doesn't help against a bot that isn't trying to fence with you.

This is consistent with the pattern: **the defender template is delivery-rush**, not spacing/prediction.

## Intervention options

Two paths, one per cycle.

### Brain-path (A) — structural fix

Make foresight have an opportunity cost inside the mapping. Three candidate shapes:

**A.1 — Saturating curve (below-identity)**:
```ts
const MAX_FS = 0.25;
const x = Math.max(0, Math.min(1, E.foresight / MAX_FS));
const effFs = MAX_FS * (x / (1 + 1.5 * x));
const predX = obs.opp.x + obs.opp.vx * effFs;
```
At native 0.25, effFs = 0.10 (60% nerf at max). Linear nerf across range.

**A.2 — Foresight-action tradeoff**:
High foresight delays swing initiation. Structural: better read, slower commit. Requires adding a small state field (`swingPending` ticks) — more complex but truer to the "real tradeoff" principle.

**A.3 — Prediction-only in positioning, not in hit-decisions**:
Split `dist` into `predDist` (for moat/positioning) and `absDist` (for swingRange/danger). Foresight keeps helping strategy, doesn't help the actual strike check. Cleanest surgical fix.

All three preserve knob legibility. A.3 is the most structurally honest — it disentangles "planning" from "striking."

### Roster-path (B) — add g24 as adversarial reference

Keep brain as-is. Inject g24-x38 + 3 budget-transfer variants into the selector's opponent pool for the next roster-evolve run. Force selection to include configs that beat this family. Delivery-forward configs (regulatory/moonshot template) should become more represented.

No brain change, no BEHAVIOR_VERSION bump. Prior evidence stays valid; new roster measured against same brain v1.

## Recommended decision

**Brain-path A.3 (split dist).** Reasons:

1. The diagnosis clearly shows a brain-mapping defect — foresight is universal without tradeoff. Fixing it structurally is cleaner than roster-level whack-a-mole.
2. A.3 is a surgical change (3–4 lines), preserves all other tactical branches, doesn't silently change other knobs' effective value.
3. Post-fix, the exact same Phase 4 attacker will reveal whether the g24 basin disappears (good) or migrates to a different axis (informative — then we know what's really strong).
4. Failed-path cost is cheap: bump BEHAVIOR_VERSION to 2, run roster-evolve + attack cycle (~1 day), if worse we can revert.

If Brain-path loses, we commit to Roster-path on the next cycle.

## Next-cycle checklist

1. Let current attack finish (acquirer still in flight).
2. Regenerate full 16-target exploit report.
3. Apply Brain-path A.3 patch to brain.ts.
4. Bump `BEHAVIOR_VERSION = 2` with changelog comment.
5. Rebuild + sync + full test suite.
6. Re-run roster-evolve from scratch under brain v2.
7. Run Phase 4 attack against the new installed roster.
8. Compare exploit archives v5a (brain v1) vs v5b or next version (brain v2): did g24-family collapse? What replaced it?

One intervention per cycle. No roster changes AND brain changes in the same commit.
