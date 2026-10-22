# Fighter behavior v26: fix the failed transition, not randomize the loop

Behavior v26 changes only AI inputs. Physics, shared fighter stats and production
stage geometry are unchanged by this patch. The concurrent scoring-rule change
is evaluated separately: **every comparison below holds rules v2, including the
one-second / 120-active-tick goal dwell, constant for both brains**.

The v25 source is public main `0edd63053384eb6fc96933bc8c9d934251fd5988`.
The baseline is the current rules-v2 runtime with its `brain.js` replaced by the
untouched v25 build. The [evidence manifest](fighter-v26-evidence.json) records
SHA-256 bindings proving that every other runtime JavaScript module is identical,
all match identities/hashes, summary counts, and representative failure traces.

## Reproduced causes and fixes

1. **Goal fly-through / repeated dwell reset.** The old carrier stopped holding
   jump as soon as its body entered the goal radius, often while its feet were
   still below the supporting platform. The jump-cut made it fall out again,
   frequently after about 0.38 seconds. The carrier now routes to a supported
   scoring stance and finishes clearing the landing before holding still.
2. **Wall-jump recoil oscillation.** A fighter cleared the wall vertically, then
   immediately selected down toward a lower goal while its wall-jump recoil was
   still carrying it away. It fell back onto the same wall face. The wall remains
   part of the route during ascent until horizontal crossing can occur.
3. **Midair target switching / failed landing.** Recomputing the next platform
   every airborne frame made a bot abandon its intermediate landing for a higher
   platform. A bounded waypoint survives the jump, expires after 180 ticks, and
   clears on arrival, a materially moved target, death or reset. A descending
   fighter does not select a fresh launch platform. Stopping-distance steering
   and an inset landing aim reduce edge overshoot.
4. **Trait mistaken for physical incapability.** Low lift previously removed
   physically reachable tall stepping stones from the graph. Shared jump physics
   now determines the vertical reach bound; style still affects route utility.
5. **Clash/stun amnesia and passive bind.** A brief stun no longer erases a failed
   plan or counts as progress. Repeated passive clashes get a committed facing
   response through the recoil crossing, instead of turning back every frame
   and pushing the two bodies inward again. Exact-overlap ties are deterministic.
6. **Success mistaken for failure.** Observable opponent damage counts as
   progress. Blocked displacement does not override recent actual progress.
   Recovery routes can jump a nearby live blocker rather than repeat a walk-in.

All decisions use the existing public Observation, shared constants, style and
own bounded memory. There is no new RNG, opponent configuration access, hidden
cooldown access or future simulation. Failed-plan history remains bounded to
8 entries / 720 ticks. The facing commitment clears when the close stun/clash
condition ends; navigation is at most one waypoint.

## Exploratory matched self-play, without artificial horizon settlement

Development: 48 matches, all three production stages, eight existing preset
pairs, seeds 7 and 43. Reserved-then-reused exploratory cohort: 72 matches,
the same stages but eight new pairs
and seeds 113, 7273 and 9827. Each match has a 28,800-tick (240-second) observation
horizon. The originally reserved cohort was reused after focused regression tests caught
lifecycle bugs. It is therefore **exploratory**, not untouched final validation.
The earlier per-match output filename was reused; those earlier per-match files
are unavailable, while aggregate results remain in the run transcript and manifest.
The final validation below uses genuinely new seeds, pairs and a second new layout.

| Metric | v25 dev | v26 dev | v25 reused exploratory | v26 reused exploratory |
| --- | ---: | ---: | ---: | ---: |
| Natural completions | 1/48 | 48/48 | 4/72 | 72/72 |
| Mean duration, capped matches included | 236.77 s | 61.54 s | 235.85 s | 55.37 s |
| Round timeouts | 3 | 0 | 6 | 0 |
| Deliveries | 51 | 277 | 85 | 398 |
| Interrupted goal-hold attempts | 4,952 | 119 | 7,125 | 206 |
| Unproductive stuck live ticks | 0.537% | 0.533% | 0.668% | 0.725% |
| Repeated ineffective-input live ticks | 0.0665% | 0.0511% | 0.0687% | 0.0823% |
| Mean effective action kinds, out of 7 | 6.90 | 6.29 | 6.81 | 6.34 |

Completion and reliable goal conversion improve strongly; **not every rate
improves**. Reused-cohort unproductive stuck and repeated-input rates are slightly
higher. Action-category coverage falls, rather than proving increased variety.
The old brain's many repeated failed jumps also count as effective jump starts.
Useful creativity means committing to a context-appropriate route that works,
not maximizing the number of buttons pressed.

Raw stuck rate rises from 0.96% to 2.14% in the reused cohort, partly because successful
one-second holds are intentionally stationary. The refined stuck metric excludes
being inside the held goal radius and being stunned; both raw and refined counts
are retained. The older progress-window metric also falls (86.48% to 82.70%):
it counts any dwell increment, including repeatedly flying through a ring and
resetting before scoring, so it must not be used alone as evidence of success.
Definitions otherwise remain those in the v25 diagnostic. These are not ranked
balance, side-bias, human-opponent, exhaustive matchup or release-qualification
claims.

## Untouched post-freeze validation

The final brain was frozen at source SHA-256
`4b96db7368a43c6ec51d5ba3fe59c29c8e444baa22e5683e6966ac35dcfe9339`
and runtime `brain.js` SHA-256
`599e58adf279dea373bb6c047ed01ce9cea9933166136be1e4686371b0052410`.
It was then evaluated **once, without further AI changes**, on seeds
104729/130363/155921 and eight new pairings, with uniquely named output files.
Both versions still use byte-identical non-brain rules-v2 runtime modules.

| Fresh 72-match cohort | v25 | v26 |
| --- | ---: | ---: |
| Natural completions | 2/72 | 72/72 |
| Completions without round timeout | 1/72 | 72/72 |
| Mean duration, capped matches included | 239.39 s | 56.34 s |
| Round timeouts | 3 | 0 |
| Deliveries | 66 | 392 |
| Interrupted goal-hold attempts | 7,366 | 206 |
| Unproductive stuck live ticks | 0.481% | 0.427% |
| Repeated ineffective-input live ticks | 0.0400% | 0.0328% |
| Mean effective action kinds, out of 7 | 6.80 | 6.18 |

Completion, goal conversion and the two failure rates improve in this untouched
sample. Action-category coverage still falls; it is not evidence of increased
random variety or universal fighting strength. Source/fixture hashes, exact
pairings, raw-output checksums and match-level counts are in the evidence manifest.

## Exploratory controlled loop-class probes

A dead opponent and a long-lived visible goal isolate route/landing/hold behavior
without weakening the real movement or scoring engine. Starts are x=280/640/1000
on the floor. The 30-second route horizon is not settled into a winner.

Development covers all nine production-stage goals and five presets (135 routes).
The earlier reserved layout is asymmetric with staggered platform heights, uses seed 113,
and the eleven presets excluded from the route-development cohort (99 routes).
These earlier probes are also labeled exploratory after the final lifecycle fixes.
The layout is defined only in the diagnostic tool, not added to the game.

| Metric | v25 dev | v26 dev | v25 unseen layout | v26 unseen layout |
| --- | ---: | ---: | ---: | ---: |
| Scored routes | 1/135 | 135/135 | 0/99 | 99/99 |
| Mean route duration | 29.79 s | 2.97 s | 30.00 s | 2.77 s |
| Direction reversals | 10,570 | 287 | 8,915 | 220 |
| Jumps landing back within 48 px of launch | 3,448 | 6 | 1,230 | 0 |
| Dwell resets | 2,887 | 28 | 1,111 | 22 |
| 240-tick no-net-progress oscillation windows | 820 | 4 | 752 | 0 |
| Longest consecutive no-net-progress span | 3,360 ticks | 240 ticks | 2,880 ticks | 0 |

An oscillation window requires less than 36 px net distance improvement and at
least four direction reversals in 240 ticks. A returning jump is a diagnostic
proxy, not proof that any individual jump was irrational. Attempts, durations,
recurrences, endpoints and sampled causal traces are retained. Four development
oscillation windows and six returning jumps remain; this is not a zero-loop
claim. Returning-drop counters were zero in these fixtures, so this campaign does
not establish a separate drop-loop fix. Persistent combat miss loops likewise
remain an observed metric rather than a universally solved class.

### Second unseen layout after the final freeze

The new `validation-terraces` layout uses different wall positions and platform
heights, all sixteen presets, three starting positions and seed 104729: 144 routes.
It was run once on the frozen candidate, without tuning afterward.

- Scoring: v25 1/144; v26 144/144.
- Mean route duration: 29.83 s versus 2.87 s.
- Returning jumps: 3,226 versus 0; route-oscillation windows: 968 versus 0.
- Dwell resets: 3,261 versus 62. These remaining fly-through resets are reported,
  even though every route eventually settles and scores.
- Longest consecutive no-net-progress span: 3,120 ticks versus 0 in completed
  240-tick windows. This does not mean every individual movement advances the goal.

## Verification and reproduction

Focused tests cover support acquisition, every production goal, wall-arc
continuity, committed airborne waypoints, real-physics clash separation, stun
memory, observable success, reset boundaries, valid dwell and deterministic
inputs. The final focused suite passes 51/51. Build and browser-sim sync/check
pass. Six v25/v26 action logs, one per version and stage, replay through the same
rules-v2 engine to identical fighter/goal/kill/tick state; duplicate same-seed
runs also match. Archived scoring-rule compatibility belongs to the separately
versioned replay change, not this AI-only compatibility claim.

Capture the v25 build before editing; then put only that baseline `brain.js` into
a copy of the current rules-v2 `sim/dist` directory. Add a package.json containing
`{"type":"module"}` above each copied dist directory. The manifest verifies that
all non-brain runtime modules match.

```sh
npm -w sim run build
node tools/measure-fighter-tactics.mjs --sim /tmp/v25-rules2/dist/index.js \
  --seeds 7,43 --output /tmp/v25-development.json
node tools/measure-fighter-tactics.mjs --seeds 7,43 --output /tmp/v26-development.json
node tools/measure-fighter-tactics.mjs --seeds 113,7273,9827 \
  --pairs standby:oracle,blitz:unicorn,shipper:regulatory,moonshot:intern,founder:acquirer,disruptor:pivot,troll:incumbent,operator:regulatory \
  --output /tmp/v26-heldout.json
# Repeat this exploratory cohort with --sim /tmp/v25-rules2/dist/index.js for baseline.
node tools/measure-fighter-routes.mjs --output /tmp/v26-routes.json
node tools/measure-fighter-routes.mjs --held-out --output /tmp/v26-routes-heldout.json
node tools/measure-fighter-routes.mjs --validation --output /tmp/v26-validation-routes.json
node tools/measure-fighter-tactics.mjs --seeds 104729,130363,155921 \
  --pairs standby:acquirer,blitz:regulatory,oracle:pivot,shipper:intern,incumbent:unicorn,moonshot:operator,founder:troll,disruptor:regulatory \
  --output /tmp/v26-validation-matches.json
# Repeat all validation and route commands with --sim /tmp/v25-rules2/dist/index.js for baseline.
node --test sim/dist/test/navigation-v26.test.js \
  sim/dist/test/tactical-recovery.test.js sim/dist/test/brain-v3.test.js \
  sim/dist/test/platform-wall.test.js
npm run sync:client-sim
npm run check:client-sim
```

Evidence output paths are exclusive-created and refuse existing files, including
a final atomic `wx` check against concurrent writers. Use a fresh cycle/run path
for every measurement. This post-freeze harness safety change does not change the
frozen AI, fixture layouts or metrics. Final validation outputs were never reused.

The manifest separates the measured comparison bundles from the final integrated
runtime. Historical archive routing integration subsequently changed `replay.js`
and `stage.js`, not the frozen AI or physics. The integrated production client
independently reproduces all 748 recorded outcomes; these are distinct checks.
