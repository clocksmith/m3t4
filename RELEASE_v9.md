# v9 Custom-Bot Beta Release Certificate

Date: 2026-04-20

Baseline commit: `d70c93b`

Ruleset:

- `BEHAVIOR_VERSION = 5`
- `REPLAY_CONSTANTS_HASH = f82ff36f`
- v9 roster installed in `sim/src/strategies.ts`
- Ranked authority model: server-run configs, `ranked-server` trust label

## Ship Decision

v9 clears the shape-aware universal-dominance bar for custom-bot beta.
The release claim is not "perfectly solved meta"; it is narrower:
no discovered config wins consistently against all 16 presets without
meaningful losing matchups.

The near-threshold low-budget watchlist results were sampling noise.
At 7 validation seeds, all three watchlist targets dropped under the
55% broad-transfer gate:

| target | full budget 10k, 5 seeds | low budget 500, 3 seeds | low budget 500, 7 seeds |
|---|---:|---:|---:|
| unicorn | narrow | 70.0% | 40.6% |
| disruptor | 63.6% | 59.4% | 38.7% |
| shipper | 64.6% | 24.4% | 37.4% |

Release verdict: ship beta, with watchlist telemetry and willingness to
tune match length after real traffic.

## Evidence

Phantom gate:

- PASS
- mean: 50.2%
- p95: 60.1%
- max: incumbent 63.2%
- counter cycles: 276
- zero-counter slots: 0

Meta-health:

- max single-config WR: 77.0% caution
- draw rate: 16.5% caution
- avg ticks/cap: 73.7% caution
- timeout rate: 42.6% informational
- counter cycles: 11,751 healthy

Full-budget Phase 4:

- budget: 10,000
- starts/neighbors: 20/20
- validation seeds: 5
- universal-god blockers: 0
- broad-transfer counters above 55%: 5/16
- old g24-family counters: 0/16
- every effective counter has losing matchups

Player-realistic Phase 4:

- budget: 500
- validation seeds: 3 initially, watchlist rechecked at 7
- broad-transfer counters above 55% after 7-seed watchlist confirmation: 0

Archive paths:

- `pareto/exploits/v9-brain-v5/`
- `pareto/exploits/v9-brain-v5-budget500/`
- `pareto/exploits/v9-brain-v5-confirm/`
- `/tmp/phantom-gate-v9.json`
- `/tmp/meta-health-v9.json`

## Watchlist

Runtime watchlist telemetry is intentionally a stub, not a blocker. The
server tags and logs:

- named watchlist presets: `unicorn`, `disruptor`, `shipper`
- v9 full-budget generalist archetypes for `disruptor` and `shipper`
- the low-budget `unicorn` noise archetype for post-launch tracking
- draw and long-match quality signals

Cloud Run logs tagged `[watchlist]` are the beta monitor. If live ladder
traffic produces sustained draw rate above 20% or one archetype starts
winning broadly, the next patch should tune match cadence or trait-space
coverage before another roster-only cycle.

## Production Flags

Centralized beta deploy should keep optional authority surfaces off:

```env
FEATURE_P2P_DUEL=false
FEATURE_COMMUNITY_VERIFY=false
FEATURE_PROOF_LAB=false
FEATURE_ZK=false
```

The server defaults all four flags to `false` and skips registering those
routes unless explicitly enabled.

## Production Auth

Server requirements:

```env
NODE_ENV=production
AUTH_MODE=firebase
AUTH_PROVIDERS=google,github
```

The server hard-fails if production tries to run `AUTH_MODE=dev`.

Client requirements:

- production host defaults to `firebase` auth mode
- dev UID auth is local-only
- deploy must provide `window.__M3T4_FIREBASE_CONFIG__` before `app.js`
  loads

Example deploy-time config:

```js
window.__M3T4_AUTH_MODE__ = "firebase";
window.__M3T4_FIREBASE_CONFIG__ = {
  apiKey: "...",
  authDomain: "m3t4.ai",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

## Remaining Cloud Caveat

The game is meta-shippable, but durable production traffic still needs
a non-file-backed store. `FileStableStore` is acceptable for a single
smoke-test instance only. Real beta deployment should add or enable a
Firestore-backed `StableStore` before opening public ranked submissions.
