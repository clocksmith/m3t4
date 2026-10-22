# Bounded fighter evaluation

`scripts/evaluate-fighter-roster.mjs` runs reproducible, headless matches from a
local roster. It is a separate evaluation lane, not a second live service.
Every completed result and action log is retained locally. None is automatically
added to Watch, Firestore, Cloud Tasks, or the authoritative leaderboard.

## Run

From the repository root, with dependencies installed:

```sh
npm -w sim run build
npm -w match-engine run build
node scripts/evaluate-fighter-roster.mjs \
  --roster=data/m3t4.json --seed=20261022 --count=64 --max-seconds=30 \
  --out=/tmp/fighter-evaluation-20261022
```

Use a **new** output directory whose parent already exists. Existing runs are
never overwritten. The CLI rejects output within the public `client/` tree,
including symlink routes. Keep all outputs private: the exact input snapshot
contains fighter configs and may contain other private imported fields.

Seed, count, and deadline must all be explicit. Bounds are 1–10,000 matches,
more than zero and at most 3,600 seconds, 2–256 fighters, and 4 MiB of input JSON.
The deadline is checked **between matches**. One already-started simulation can
finish after it; this is not a hard process-termination deadline. Each simulation
retains the existing engine's tick cap. A stopped run reports `time-limit` and
the exact completed count, not success at the requested count.

Optional arguments, all in `--name=value` form:

- `--stage=datacenter`: a known shared-sim stage.
- `--pair-cooldown=8`: do not repeat a pairing within the previous 8 evaluations.
- `--fighter-cooldown=1`: rest fighters for one evaluation before reusing them.
- `--placement-games=6`: imported games plus local evaluations below this number
  are newcomer placement matches.
- `--out=...`: defaults to a new timestamped directory under `/tmp`.

No implicit network reads occur. There is no `--firestore`, credentials, public
generation, deployment, or live-rating mode.

## Input and preservation

The checked-in `data/m3t4.json` shape is supported directly: `stables` keyed by
`userId`, with `slots`. Non-null slots retain their actual `userId`, `slotId`,
`config.id`, name, attributes, initial Elo, and win/loss/draw counts. No synthetic
system identities, Elo jitter, preset replacement, or automatic renaming is used.
The source file is never modified.

A smaller explicit input format is also supported:

```json
{
  "schema": "m3t4.evaluation-roster.v1",
  "fighters": [
    {
      "userId": "owner-a",
      "slotId": "permanent-slot-a",
      "handle": "owner-a",
      "slotName": "Existing fighter name",
      "config": { "id": "existing-config-id", "attributes": { "burnRate": 0.5 } },
      "elo": 1500,
      "wins": 0,
      "losses": 0,
      "draws": 0,
      "isHuman": true,
      "lastPlayedAt": 0,
      "style": "pressure"
    },
    {
      "userId": "owner-b",
      "slotId": "permanent-slot-b",
      "handle": "owner-b",
      "slotName": "Another fighter",
      "config": { "id": "other-config-id", "attributes": { "burnRate": 0.3 } },
      "elo": 1500,
      "wins": 12,
      "losses": 10,
      "draws": 2
    }
  ]
}
```

Optional `gamesPlayed` overrides the inferred sum of wins, losses, and draws for
placement purposes; the original fields remain untouched. Optional `style`
groups strategically distinct entrants for placement diversity. Optional
`uncertainty` is a nonnegative Elo-scale **scheduling heuristic**, not a calibrated
confidence interval. Without it, uncertainty decreases with observed games.

Use the native-unit configs that the match engine consumes (`configVersion: 1`,
or omitted). UI-space version 2 configs are rejected instead of silently being
misinterpreted or rewritten. Legal trajectory/DSL attributes can be evaluated;
the CLI compiles them before creating output. This tool is not submission budget
qualification and does not repair, rebalance, or change an imported config.

## Matching policy

`match-engine/src/background-scheduler.ts` is pure and deterministic. It receives
only scheduling summaries, explicit seed/sequence, and at most 4,096 recent
pairings. It does not read private brain attributes, force results, or update Elo.

1. Exclude self-play and all same-owner slot pairings.
2. Prefer pairs meeting both pair and fighter cooldowns. If none exists, allow
   an unavoidable fighter-rest fallback while retaining a fresh opponent. Only
   when **all legal pairs** are cooling down is a pair-repeat fallback allowed.
   The fallback is always recorded; it never spins waiting for a nonexistent pair.
3. Choose a least-evaluated eligible pivot. Among equally served fighters,
   prioritize newcomers, then uncertainty, then seeded ties. First-pass opponent
   selection prefers fighters not yet evaluated, covering an even distinct-owner
   roster in half as many matches when cooldowns allow it.
4. Newcomers prefer unseen opponents and new declared styles, probing seeded
   lower/middle/upper available rating bands. Established fighters use the Elo
   gap normalized by both fighters' uncertainties, with a recent-repeat penalty.
5. Track side counts and pairing distribution. The existing `runMatch` seeded
   side swap and real simulation decide each result. Small runs need not be
   perfectly side-balanced; use reciprocal experiments for a side-bias claim.

Local evaluation Elo uses the existing result-based K=16 update. Imported stats
and authoritative rankings never change. The goal is opportunities for earned
contenders, not engineered champion turnover or artificially rewarded newcomers.

## Artifacts and replay

- `roster.input.json`: byte-for-byte input snapshot, including private configs.
- `manifest.json`: limits, seed, stage, scheduling policy, input SHA-256, shared
  behavior/constants identity, and a SHA-256 fingerprint of the actual built
  engine plus evaluator. The latter covers dirty builds as well as clean releases.
- `schedule.jsonl`: one ordered entry per completed evaluation, including seed,
  selection rationale, cooldown fallback, and action-log hash.
- `matches/evaluation-<seed>-<sequence>.json`: every result, existing public-shaped
  match doc, full base64 action log, and separate evaluation provenance. Private
  configs and arbitrary imported fields are not copied into the match doc.
- `summary.json`: completed/requested counts, stop reason, schedule hash,
  throughput, simulation duration percentiles, process peak RSS, unique-pair
  coverage, per-fighter appearances/opponents/side counts, and local results/Elo.
- `failure.json`: written on a simulation/persistence failure when possible;
  earlier match files remain available, and the CLI exits nonzero.

The match docs' synthetic timestamps encode explicit simulation seeds through
the existing `runMatch` input contract. They are **not** a broadcast timeline.
`featured: false` and `lane: background-evaluation` identify their purpose.
The replayable match is nested under `match`, not inserted in `client/matches`.

To reproduce, use the same built engine, exact input snapshot, options and seed
with another new output directory. Completed prefixes are deterministic even
when a wall-time cap stops at different counts. Identical count-complete runs
have identical schedules, match docs and action logs. Runtime measurements and
the manifest's generation timestamp are intentionally not deterministic.

## Reusing the scheduler for explicit featured generation

The public API is exported by `@m3t4/match-engine`:

```js
const selection = selectBackgroundPair({
  fighters: [/* userId, slotId, elo, gamesPlayed, evaluations, uncertainty?, style? */],
  history: [/* { sequence, a, b } */],
  seed: 20261022,
  sequence: 0,
  pairCooldown: 8,
  fighterCooldown: 1,
  placementGames: 6,
});
```

`a`, `b`, and `pivot` are keys from `evaluationFighterKey({userId, slotId})`, which
uses collision-safe JSON tuples. `selection` also supplies `reason`,
`placementBand`, skill gaps and explicit fallback fields. `null` means no legal
cross-owner pair exists. `evaluationSeed(seed, sequence, label?)` supplies a
reproducible uint32 seed. Caller state is not mutated: increment evaluations and
games from actual results, append chronological history, and retain only the
last `BACKGROUND_HISTORY_LIMIT` entries. Both pair sides must have their counts
updated, using the displayed identities when applying `runMatch` Elo.

A separate explicitly requested generator may reuse this policy to choose
featured content. Running the evaluation CLI alone never makes that selection,
publishes an artifact, or changes the live `selectPair` / `matchTick` chain.

## Verification and measured baseline

Focused commands:

```sh
npm -w match-engine test
node --test scripts/test/evaluate-fighter-roster.test.mjs
node --check scripts/evaluate-fighter-roster.mjs
git diff --check
```

The initial isolated implementation passed 11 scheduler tests and 6 CLI tests,
including real seeded replay reproduction, deadline partial completion,
side-swap-aware local stat updates, identity/config preservation, full first-pass
coverage, tiny-pool fallbacks, and public-output refusal.

On 2026-10-22, two 64-match runs using the checked-in 16-fighter roster at base
`0edd630`, behavior version **25**, seed `20261022`, and a 30-second limit:

- completed in 3.38 and 3.06 seconds: 18.9 and 20.9 matches/second;
- covered all 16 fighters and 64 distinct pairs out of 120 possible;
- required zero pair-repeat or fighter-cooldown fallbacks;
- produced byte-identical schedules and all 64 match/provenance files;
- had schedule SHA-256
  `bbe65fb51f08e5a3f5bde4738dd1973c0b5e8881793abccfee50c942ceba5c6d`;
- reported process peak RSS of approximately 310 and 317 MiB.

This is a local baseline, **not** v26/rule-v2 qualification or a production
throughput guarantee. `runMatch` currently calls `simulateTrace`, allocating
per-tick frames before packaging only the action log. The CLI processes one match
at a time and does not retain those frames across matches. Simulation dominated
these runs (3.32/3.01 seconds); no simulator semantics or allocation path was
changed merely to improve a benchmark. Re-measure after engine changes.

### Integrated v26 / rules v2 checkpoint

After combining AI v26, the one-second hold rule and the migrated bundled roster,
two fresh 64-match runs (seed `20261022`, 30-second limit) completed in 2.70 and
2.67 seconds: **23.69 and 23.94 matches/second** on this cloud CPU. Both covered
all 16 fighters and 64 distinct pairs, with 7–10 evaluations per fighter and no
pair-repeat or fighter-cooldown fallback. Schedules and all 64 match/provenance
files were byte-identical; manifest differences were only the wall-clock
`generatedAt`. Schedule SHA-256:
`074178cb58a28d850c9b51128b9ab4df6183ce5172033eda3a0a90775a9c7226`.
Peak RSS was approximately 313 and 297 MiB. These are bounded local throughput
observations, not production capacity or an AI quality comparison across rules.

A separate 48-match featured generation covers the full 16-fighter bundled roster
on all three maps (43.79 recorded minutes). A second generation reproduced its
index and all 48 files exactly. Every previous 700 match document remains
byte-identical. All 748 action logs reproduce their recorded outcomes through
the production client replay path: 200 legacy v23, 500 legacy v24 and 48 v26/rule2.
