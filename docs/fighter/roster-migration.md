# Fighter identity and shared AI migration

Saved fighters keep their owner ID, slot ID, handles, combat configuration,
cosmetics, submission times, counters and ratings. All current matches execute
one shared `runParamBrain`, so an AI upgrade applies to every configuration, not
only newly created fighters. `aiBehaviorVersion` records the current runtime
that a roster was migrated for; it does not override historical replay routing.
Match/replay snapshots and their original labels are never rewritten.

Display names use a versioned, deterministic generator keyed by the owner and
slot IDs, not by mutable handles. Version 1 combines 142 modifiers and 386 nouns
from eight domains into 18,512,540 possible labels, each at most 32 characters.
Labels are not unique IDs. Migration retains exact prior labels in `previousNames`
and stamps `fighterNameVersion`. Repeating migration is a no-op; later user name
edits and future version markers are preserved. Existing seats outside today's
four-seat UI cap are included. No old fighters or history are purged.

## Local file store

Build the simulator, then inspect a dry-run:

```sh
npm -w sim run build
node scripts/migrate-fighter-roster.mjs --file=data/m3t4.json --expected-version=26
```

Stop any process writing that file before applying a file migration. The apply
path checks for changes immediately before atomic replacement, but is not a
cross-process database transaction. It saves the exact original bytes in an
adjacent content-hashed backup before any rewrite:

```sh
node scripts/migrate-fighter-roster.mjs --file=/private/roster.json --expected-version=26 --apply
```

The legacy file server also backs up before its first startup migration. Read-only
replay inspection does not migrate, seed, back up or write the source file.
System fighter startup no longer replaces saved strategy configs, names or stats.

## Full Firestore backfill (operator action, not performed by source publication)

The explicit backfill pages the entire `stables` collection, including dormant
players and every stored seat. It does not use the active-player window. Dry-run
is the default. Use the existing authorized runtime identity; this tool neither
creates credentials nor changes permissions.

```sh
npm -w sim run build
npm -w match-engine run build
npm -w plasma-lab run build
npx tsc -p functions
node scripts/migrate-fighter-roster.mjs --firestore --project=PROJECT --expected-version=26
```

Only after the reviewed runtime is deployed and a production data migration is
authorized, use `--apply --backup=/private/unique-backup.jsonl`. The backup file
must be new. Each transaction re-reads its current stable, durably appends the
original, updates only the slots array, and updates the public stable/bot
projections atomically. Concurrent match stats and edits are preserved. Transaction
retries can produce duplicate original backup entries, intentionally. The tool
is idempotent and resumable with a new backup path. Keep backups private: they
contain full saved configurations. They are not public match artifacts.

Public projections and current-profile reads use the same name migration for
consistent labels during a rolling upgrade. Historical event/replay views do
not rename past events. Source publication alone does not upgrade an already
running remote engine or persist remote data; report those steps separately.

## Refreshing the featured static archive

The default Watch mode is an explicitly labeled recorded archive, not a live
ranked feed. Existing action logs stay on their historical rules. To show the
new engine, generate fresh recordings rather than relabeling old fights:

```sh
node scripts/generate-static-matches.cjs --roster=data/m3t4.json --count=48 --seed=260122 --start=1792670400000
```

The generator reads only the named local snapshot (no implicit Firestore query),
uses canonical saved IDs and current names, covers every configured saved seat,
cycles all three stages, and uses the bounded deterministic matchup selector.
It does not change stored ratings. The old index is retained with a content-hashed
filename and no old match is removed or overwritten. New matches include engine
and rules versions plus seed/selection provenance, but no fighter configs.
Background evaluation artifacts remain separate and do not automatically enter
this featured index. A current complete production snapshot is still required
if a future featured generation should include all remote fighters.
