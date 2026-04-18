# Brain-mapping audit - BEHAVIOR_VERSION 1

Diagnostic output from Phase 4a adversarial attack against the v5-annealed
roster. The intended baseline is commit `0708505`; the archive currently lives
at `pareto/exploits/v5a/`.

Important provenance note: the v5a archive was generated before provenance was
fixed, so individual records have mixed `baselineCommit` values even though the
`simConstantsHash` is consistent for the run. Treat this document as the
decision record for the measurements, not as proof that the old archive metadata
is clean. Future attack runs must pass `--baseline-commit 0708505` when measuring
this baseline, or otherwise resolve the baseline once at process start.

No behavior mapping patch has been applied in this audit. `BEHAVIOR_VERSION`
remains `1`.

## Evidence summary

Final reporter output from the completed 16-target archive:

| signal | value | read |
|---|---:|---|
| mean validatedWr vs worst counter | 76.9% | roster broadly exploitable |
| max validatedWr | 93.3% (unicorn) | single preset fully defeated |
| g24-family share | 11 / 16 | dominant basin, but below the reporter's 70% branch |
| transferable counters (>55% mean) | 12 / 16 | counters roll most of the roster |
| stable exploit basins (frag < 4%) | 7 / 16 | several basins are not one-off noise |
| cheap counters (top3 < 250) | 15 / 16 | search does not require exotic budget geometry |
| strict over-budget counters | 6 / 16 | rounded pressure and strict legality must be reported separately |
| true defenders (valWR < 60%) | 3 / 16 | regulatory 56.7%, acquirer 56.7%, founder 45.0% |

Intern and operator are partial resistors, not defenders under the strict
predicate: both land at 68.3% validatedWr against their worst archived counter.

## Final reporter branch

The report decision tree currently falls through to:

> Multiple exploit families exist with broad transferability. Hardening =
> adversarial-fitness in selection.

That branch is technically correct because g24-family is 11/16, just below the
70% threshold. It should not be read as "no brain mapping issue." The full data
still shows broad pressure from a high-foresight spacer basin:

- Exact or near-exact g24-family counters are the worst archived counters for
  11 of 16 targets.
- Transferability is high for 12 of 16 targets.
- The non-g24 worst counters are concentrated in the targets that already resist
  or partially resist the spacer family.
- The three true defenders are regulatory, acquirer, and founder; they lean more
  on delivery/alternative policy than on the same spacing/prediction loop.

The brain-path recommendation below is therefore a hypothesis about knob
orthogonality, not a claim that the archive is purely one exploit family.

## g24-x38 attribute profile

The original ceiling winner is a high-foresight, moderate-everything-else
spacer. Representative profile:

| knob | native | UI | role |
|---|---:|---:|---|
| foresight | 0.190 | 76 | dominant planning axis |
| leverage | 0.151 | 58 | slightly upward engagement |
| burnRate | 0.520 | 52 | moderate swing reach |
| greed | 0.501 | 50 | still commits to delivery |
| shipRate | 0.336 | 34 | not primarily ship-focused |
| pacing | 0.167 | 17 | steady |
| cunning | 0.095 | 10 | mostly reflexive |
| moat | 0.000 | 0 | stays close |
| networking | 0.039 | 4 | ignores walls |
| spite | -0.028 | 49 | neutral |

Spent 360/360 in the ceiling run. The important signal is not exact allocation;
it is that foresight behaves like a tactical multiplier rather than a local
style knob.

`hallucination` is not one of the 11 user-budgeted knobs; it is derived from
overspend. Exact legal counters should have hallucination 0. Some archived
near-g24 rows show UI-vector `spent=362` and hallucination 20 because the report
uses rounded UI vectors; keep strict-budget and rounded-report pressure separate
when presenting product claims.

## Where foresight propagates

Foresight appears directly in only two places in `brain.ts`, but the first one
feeds many decisions:

```ts
const predX = obs.opp.x + obs.opp.vx * E.foresight;
const dx = predX - obs.self.x;
const dist = Math.abs(dx);
const dir = Math.sign(dx) || 1;
```

`dist` is predicted distance, not physical distance. It currently influences:

| branch | current effect |
|---|---|
| danger detection | `oppActive && dist < 100` |
| counter-punish | trigger at `dist < 160`, action at `dist < 90` |
| mutual-imminent | preemptive hop at `dist < 150` plus foresight threshold |
| stuck detector | close-loop break at `dist < 200` |
| post-clash mixup | close response at `dist < 110` |
| moat management | advance/retreat around preferred distance |
| swing reach | `dist < swingRange` |
| safe-strike inner gate | allows strike if opponent active and `dist < 70` |

With high foresight and normal opponent speeds, predicted distance can differ
from physical distance by more than a sword reach. That means one knob improves
positioning, retreat timing, preemption, swing initiation, and safety checks at
once.

## Structural gap

Foresight has insufficient opportunity cost in the mapping:

- It costs a material but affordable amount of the 360-point budget.
- It linearly improves prediction.
- It silently improves multiple downstream tactical gates.
- It does not force a corresponding delay, commitment cost, or loss of physical
  timing accuracy.

Other knobs are more local: burnRate expands strike reach, moat changes preferred
range, shipRate changes delivery priority, networking changes wall use, and so
on. Foresight currently multiplies too much of the policy.

## Intervention options

Two paths remain valid. Pick one per cycle.

### Brain-path A - structural mapping fix

Goal: foresight should help planning and pre-positioning, but should not make
physical hit decisions more accurate for free.

Candidate shapes:

**A.1 - Saturating curve**

Cap effective foresight below the native value. This is easy to tune but less
legible because it changes the value curve without clarifying which behaviors
foresight owns.

**A.2 - Foresight-action tradeoff**

High foresight delays swing initiation. This is semantically clean but larger:
it needs additional state and timing tests.

**A.3 - Prediction only in planning, physical distance in hit decisions**

Split predicted and physical distance:

```ts
const predX = obs.opp.x + obs.opp.vx * E.foresight;
const predDx = predX - obs.self.x;
const predDist = Math.abs(predDx);
const predDir = Math.sign(predDx) || 1;

const absDx = obs.opp.x - obs.self.x;
const absDist = Math.abs(absDx);
const absDir = Math.sign(absDx) || 1;
```

Then wire each gate deliberately. This is still the recommended brain path, but
it is not just "replace `dist` in 3-4 lines." The gate inventory below is part of
the intervention spec.

### Roster-path B - adversarial reference hardening

Keep brain v1 fixed. Add g24-x38 and close variants to the selector opponent
pool, reselect the roster, install it, and rerun Phase 4. This is cheaper and
keeps old behavior evidence valid, but it treats the exploit basin as something
to survive rather than fixing the user-facing knob contract.

## A.3 gate inventory

Policy rule: movement may use predicted position; physical contact and strike
safety must use actual distance. Direction follows the same split: predicted
direction for navigation, actual direction for contact-resolution branches.

| gate or branch | A.3 distance source | A.3 direction source | rationale |
|---|---|---|---|
| altitude navigation toward desired Y | predicted | predicted | movement can aim at where the opponent will be |
| moat management | predicted | predicted | moat is spacing policy, not hit validation |
| delivery navigation | unchanged | unchanged | already targets token/goal, not opponent prediction |
| danger detection | actual for first patch | actual | defensive dodge should react to physical threat; add a hybrid later only if pivot defense collapses |
| counter-punish trigger | actual | predicted for closing, actual for strike threshold | recovery punish should require real range; movement can still close toward projected position |
| mutual-imminent preempt hop | actual | actual | this is a physical collision/clash setup, not long-horizon positioning |
| stuck close-loop test | actual | actual when close; predicted when heading toward distant opponent | loop detection should be based on real proximity |
| post-clash close mixup | actual | actual | clash aftermath is a physical contact state |
| dive from air | unchanged actual | unchanged | already uses `obs.absDx` |
| swing reach | actual | n/a | hit decision must not inherit prediction reach |
| safe-strike inner gate | actual | n/a | safety check must be physical |
| anti-air / behind / vertical advantage | unchanged actual | unchanged | already uses `obs.absDx` and physical geometry |
| freeSwing composition | unchanged actual | n/a | depends on the actual sub-gates above |

Measurement checks required after any A.3 patch:

1. Bump `BEHAVIOR_VERSION` to `2`; verify `REPLAY_CONSTANTS_HASH` changes.
2. Run `npm test` and a full build.
3. Spot-check fixed-seed g24-family matchups against current v5-annealed only
   for qualitative regression; do not treat old roster conclusions as final.
4. Re-run roster evolution from scratch under brain v2.
5. Run Phase 4 attack against the newly installed brain-v2 roster.
6. Compare v5a brain-v1 archive to the new archive: did the g24-family collapse,
   and did pressure move to another knob family?

## Recommended decision

Brain-path A.3 remains the current recommendation because the exploit evidence
points at a user-facing mapping defect: foresight is not just a style knob; it
acts as a broad tactical amplifier.

This is not approval for blind automation. The next intervention should be an
explicit one-cycle decision:

- If choosing brain path: implement the A.3 inventory above, bump
  `BEHAVIOR_VERSION` to `2`, rebuild, rerun selection from scratch, then rerun
  Phase 4.
- If choosing roster path: keep brain v1 fixed, inject g24 and close variants as
  adversarial references, reselect/install, then rerun Phase 4.

Do not combine roster hardening and brain mapping changes in the same cycle.
