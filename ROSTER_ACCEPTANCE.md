# Roster release acceptance criteria

Every roster install — whether the result of a re-evolution, a manual
intervention, or a brain-version bump — must pass this checklist before
being treated as canonical. Ordered by severity: hard gates fail the
release; soft gates require a written rationale in the commit.

## Provenance (hard)

- [ ] Install is reproducible from a recorded pipeline: an HOF JSON
  file, a roster-selected JSON file, and a named mapping are all
  committed OR referenced by path in the commit message.
- [ ] `REPLAY_CONSTANTS_HASH` matches what the roster was evolved
  against. If brain or physics changed, `BEHAVIOR_VERSION` or the
  relevant constant bumped, and old archives are NOT the authority.
- [ ] `npm run build` and `npm test` pass. Client `sim/` mirror
  files are in sync with `sim/dist/`.

## Internal ecology (hard)

- [ ] `phantom-gate` passes. No installed preset has 0 counters.
- [ ] Internal max WR < 75% (no dominant slot).
- [ ] Internal p95 WR < 75%.
- [ ] Cycles ≥ 40 in the 16×16 symmetric H2H.
- [ ] Minimum counter count per preset ≥ 1 (≥ 3 preferred).

## Diversity (hard)

- [ ] No pair of presets with attribute distance < 0.25 (true
  duplicates).
- [ ] No pair with matchup-signature distance < 0.10 (behavioral
  clones).
- [ ] Per-attribute coverage: at least 6 of 11 user knobs above 40%
  range coverage. No weak axis below 20% (wasted dimension).

## External exploitability (hard)

- [ ] Full Phase 4 attack run against the installed roster:
  `adversarial-attack --targets current --budget ≥ 10000 --baseline-commit <hash>`.
- [ ] Report aggregate: **mean validatedWr across 16 targets ≤ 65%**.
  Above 65% means a broadly-beatable roster.
- [ ] Report aggregate: **max validatedWr ≤ 75%**. Above 75% means a
  specific preset is cleanly defeated.
- [ ] **Fewer than 50% of targets have transferable counters
  (transferMean > 55%)**. Above 50% means a universal counter family
  exists.

## Counter geometry (soft — require rationale if violated)

- [ ] **Budget pressure on the worst discovered counter**: top3UiSum
  ≥ 220 and top5UiSum ≥ 310 preferred. Lower means the exploit is
  cheap and user-reachable. Higher means overdetermined (good).
- [ ] **Fragility**: at least 25% of worst counters should have
  fragilityDelta > 4% (razor-sharp, hard to rediscover). A meta where
  every counter is a stable basin is too easy to exploit.
- [ ] **Family distribution**: at most 40% of counters can fall into
  any single family classification (g24-family, delivery-rush,
  denial-stall, novel). Monoculture of exploits = structural gap.

## Human defender check (soft)

- [ ] At least 2 of 16 presets classify as "true defenders": their
  worst found counter wins < 60% AND transferMean < 50%. Defenders
  are the proof that the physics/policy landscape can support
  exploit-resistant designs.

## Product continuity (soft)

- [ ] Installed roster preserves the 16 persona names (`standby`,
  `blitz`, `incumbent`, ..., `founder`). Any name swap requires a
  product-side rationale (label confusion, joke preservation, etc.)
  and should update the client's preset picker copy.
- [ ] `founder` remains in the lowest WR band (joke preservation).

## Release artifacts

Every installed roster commit should include or reference:

- The install JSON: `/tmp/new-roster-<tag>-named.json` or committed
  under `pareto/rosters/<tag>/`.
- The HOF JSON the install was selected from.
- A phantom-gate summary showing hard-gate pass.
- A full Phase 4 exploit-report output showing external gate pass
  (or waiver rationale).
- The `BEHAVIOR_VERSION`, the baseline commit, and the
  `simConstantsHash` the attack ran against.

## Branch decisions

The exploit-report's auto-read drives the next-cycle decision:

| report read | action |
|---|---|
| All external gates pass | Ship. |
| Single family (≥ 70% g24-family or equivalent) | Brain-path intervention. Bump `BEHAVIOR_VERSION`. Rerun from scratch. |
| Multiple transferable families, each < 50% | Roster-path: add adversarial references to selector pool, reselect. |
| Targeted weakness on ≤ 2 slots | Slot replacement or mutation on those specific slots. |
| Ceiling gap > 12 pts but no pattern | Selection fitness weights need retuning. Go back to `roster-select` config. |

One intervention per cycle. Record the chosen branch in the commit.
