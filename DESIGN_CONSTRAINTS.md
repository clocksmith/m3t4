# Design constraints — trait & brain changes

Rules every edit to the trait system (`sim/src/budget.ts`) or the
trait-to-policy mapping (`sim/src/brain.ts`) must satisfy. Breaking one
of these isn't forbidden, but it requires an explicit written rationale
in the audit doc for the change.

## Trait-level constraints

1. **Legibility.** Each knob has a one-sentence strategic meaning a
   player can read and reason about: "burnRate = how aggressively I
   strike," "moat = preferred distance," etc. Renaming a knob requires
   updating the builder UI copy.

2. **Orthogonality.** No knob should silently improve more than one
   strategic axis. `foresight` pre-A.3 failed this — it improved
   prediction AND strike reach AND retreat timing AND safety checks
   simultaneously. A fix that restores orthogonality per
   `BRAIN_AUDIT_v1.md` is a valid structural change.

3. **Opportunity cost.** Every knob must have a clear downside or at
   least a clear scarcity. Either:
   - raising it costs budget points that can't go elsewhere (budget
     scarcity — always true by the 360-point cap), AND
   - raising it should trade off against some other strategic
     capability (semantic scarcity: high foresight → hesitation, high
     burnRate → exposed recovery windows, etc.).

   A knob whose only cost is budget points is a knob that rewards
   search. A knob with semantic trade-offs rewards understanding.

4. **Budget scarcity preserved.** The 360-point cap and hallucination
   penalty stay as the outer contract. Overbudget configs are invalid
   for ranked play. Report strict-legal WR separately from UI-rounded
   WR when they disagree.

## Brain-mapping constraints

5. **No symptom patches.** If an exploit family is identified, the fix
   should be a structural tradeoff in the mapping, not `if (config
   looks like g24) lose`. Symptom patches just move the exploit.

6. **One intervention per cycle.** A change that plausibly affects
   measurement must land alone. Do not combine trait/brain edits with
   roster/selection changes in the same commit. Each cycle: change →
   rebuild → rerun from scratch → measure → decide.

7. **Bump `BEHAVIOR_VERSION` for any mapping change.** Non-physics
   edits to `brain.ts` that could produce different outcomes under
   identical input must bump the integer. `REPLAY_CONSTANTS_HASH`
   picks up the bump automatically. A short `// vN:` comment in the
   bump block records what changed and why.

8. **Archive old HOF is invalid after a brain edit.** Never reuse
   roster selections from before the bump as though the landscape
   hadn't moved. Always re-evolve from scratch.

9. **Physics vs policy split.** Constants in `sim/src/constants.ts`
   (speed, gravity, reach, timers) are physics; flow through
   `REPLAY_CONSTANTS_HASH` directly. Policy logic in `brain.ts`
   (thresholds, branches, heuristics) is behavior; bump
   `BEHAVIOR_VERSION`. Don't mix them in one commit.

## Provenance constraints

10. **Every measurement record stamps its baseline.** Attacker runs
    require `--baseline-commit <hash>` (resolved once at process
    start, never per-target). `AttackResult` records both
    `baselineCommit` (the frozen target) and `measurementCommit`
    (actual HEAD when stamped — may differ on long runs).

11. **Dirty worktrees fail fast.** Measurement runs against uncommitted
    code are only allowed with explicit `--allow-dirty` and are not
    valid as release evidence.

12. **Mixed-baseline archives fail the reporter.** An archive
    containing records with different baseline commits means something
    changed mid-measurement. The reporter rejects by default;
    `--allow-mixed-baseline` exists only for forensic inspection of
    historical archives.

## Acceptance: what must hold after a change lands

Constraint checks, in order of severity:

- **Hard fail**: `npm test` passes. `npm run build` passes. Ranked
  replay tests continue to pass. `REPLAY_CONSTANTS_HASH` has bumped
  if and only if a physics or behavior change landed.
- **Meaningful**: attribute coverage across the roster doesn't
  collapse on any weak axis. Matchup-signature diversity doesn't
  produce clone pairs (< 0.10 distance).
- **Load-bearing**: no installed preset is uncountered internally.
  No installed preset has internal WR > 75%. Cycles ≥ 40.
- **Structural**: running Phase 4 against the new roster does NOT
  surface a >70% worst-case counter that's also >55% transferable.
  A single transferable counter family is a structural regression.

See `ROSTER_ACCEPTANCE.md` for the full roster-release checklist.
