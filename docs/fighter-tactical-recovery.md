# Outcome-aware fighter tactics (behavior v25)

The existing mode and style system remains in charge while it makes progress.
The new recovery layer remembers observable outcomes across mode changes:
repeated attacks that have not helped, attempted movement that is blocked, and
lack of progress toward a visible opponent, token or delivery goal. Moving or
jumping in a loop no longer resets the progress timer on its own.

When necessary, the fighter commits briefly to a viable alternative: approach
by a platform route, cross over an opponent and dive when aligned, retreat then
re-enter, or drop through a platform. Failed plans receive a temporary penalty
so the same ineffective answer is not immediately selected again. Ineligible
actions are never made eligible merely because other tactics failed. An immediate
attack threat outranks a recovery experiment. Goal dwell and stun are not treated
as failures. Death, round reset and objective changes clear stale plans.

No collision, movement, attack, scoring, respawn, stage, or character-stat
mechanics changed. The implementation adds no RNG or hidden knowledge: it accepts
only the existing Observation, evaluated style parameters, and the fighter's own
bounded memory. Stable fighter-ID tie breaks preserve deterministic asymmetry.
Existing match-seeded parameter noise is unchanged. Behavior version increases
from 24 to 25 because the generated inputs intentionally change; recorded input
replays still run through the unchanged simulation.

## Matched-seed diagnostic

Baseline: public main `c81fb0e92c3f08abaf75274484225a59db2fd1ee`.
All three stages, eight preset pairs covering all sixteen presets, seeds
`7, 43, 113, 7273, 9827`: 120 matches, each capped at 28,800 ticks (240 seconds).
Seeds 7/43 were the development set; the other three were held out from the
initial implementation. The script lists the exact pairings.

| Metric | v24 baseline | v25 candidate |
| --- | ---: | ---: |
| Natural match completions, without settling the horizon | 118 / 120 | 120 / 120 |
| Round timeouts | 0 | 0 |
| Mean duration, including capped matches | 91.38 s | 77.38 s |
| Stuck live decision ticks | 5.49% | 1.10% |
| Repeated ineffective-input ticks | 0.914% | 0.135% |
| Objective/engagement progress windows | 60.19% | 63.27% |
| Mean effective action categories per fighter/match | 6.44 / 7 | 6.44 / 7 |
| Deliveries | 678 | 710 |

Definitions are intentionally independent of the new planner's internal labels:

- Stuck: no displacement over 24 pixels from the current anchor for 90 ticks.
  This includes legitimate stillness, such as holding a position, so it is not
  alone a failure verdict.
- Repeated ineffective input: after 180 ticks without measured progress, a
  repeated static movement/hold category for at least 60 decisions, or a swipe
  following at least three attack starts in the current window.
- Progress windows: 240-tick windows with the same objective context, recording
  at least 60 pixels of best-distance improvement, a kill, opponent damage,
  token pickup, dwell progress, or scoring. Incomplete windows are excluded.
- Effective action categories: approach, retreat, jump, drop, swipe, dive, hold,
  counted only when accompanied by physical movement, a jump/attack start, or
  goal dwell. This is coverage, not a measure of intelligence or random variety.

The progress metric is not uniformly better per stage. Datacenter improves from
59.5% to 73.1%; Boardroom changes from 58.6% to 52.5%; Demo Day from 62.8% to 60.6%.
All stages complete faster and show less stuck time. Category coverage is
unchanged overall: the improvement is using alternatives after failure, not
simply pressing more kinds of buttons. These results do not establish ranked
balance, every possible pairing, human-opponent strength or a release gate.

## Reproduce

Capture a baseline build before changing the source, or use a separate checkout
at the baseline commit:

```sh
npm -w sim run build
mkdir -p /tmp/m3t4-brain-before
cp -R sim/dist /tmp/m3t4-brain-before/dist
printf '{"type":"module"}\n' > /tmp/m3t4-brain-before/package.json
```

With this change and the diagnostic script present:

```sh
node tools/measure-fighter-tactics.mjs \
  --sim /tmp/m3t4-brain-before/dist/index.js \
  --seeds 7,43,113,7273,9827 --output /tmp/baseline.json
npm -w sim run build
node tools/measure-fighter-tactics.mjs \
  --seeds 7,43,113,7273,9827 --output /tmp/candidate.json
node --test sim/dist/test/brain-v3.test.js \
  sim/dist/test/tactical-recovery.test.js sim/dist/test/replay.test.js \
  sim/dist/test/dwell.test.js sim/dist/test/platform-wall.test.js
npm run sync:client-sim
npm run check:client-sim
```

JSON outputs contain each match's identity, seed, completion, duration, kills,
scoring, input hash, and each fighter's raw metric counts. Focused tests cover
cross-mode failure memory, committed alternatives, genuine progress, valid goal
dwell, reset boundaries, tactical eligibility, and deterministic input generation.
