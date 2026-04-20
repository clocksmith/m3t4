# Arena Design (PRIVATE)

**DO NOT PUBLISH.** Lives outside `/public/` so Firebase never deploys it.
Covers the competitive-layer architecture: PvP model, privacy, stables,
matchmaking, discovery, replays. See `BRAIN_TUNING.md` for the mechanical
tuning journey — this doc is the layer above it.

---

## 1. Threat model

Assume:

- **Sim code is open source.** Anyone can read `sim/src/*` and learn
  exactly how each attribute maps to behavior.
- **Rich-compute adversary.** Someone can run 100× our Monte Carlo and
  find bots that hit 85-90% WR against any fixed opponent pool.
- **Config observability is the real leak.** If top bots' configs are
  public, rivals copy + perturb + submit. The ladder collapses to a
  near-optimal bot that everyone runs variants of.

We do NOT assume:

- Full NP-hardness in the formal sense. We have 3 empirical signals
  (max random 83.7%, 24 cycles, mutation std 11.4%) but not a reduction
  proof.
- That solving is impossible. Determined compute FINDS good bots. The
  defense is making "good" a **moving target**.

**Primary defense: config privacy + meta-rotation.** Code being open
doesn't matter if rivals can't see WHO they're fighting and the
population keeps changing underneath them.

---

## 2. Split: practice vs ranked

### 2.1 Practice (local, open)

- Full client-side sim. Deterministic, network-free, fast.
- User can fight their own configs against:
  - The 16 named preset strategies
  - Their other saved configs
  - **Ghost bots**: anonymized top-of-last-season configs that have been
    retired from ranked. Server releases these intentionally as public
    training dummies.
- Exposes the sim mechanics by design — that's already public via the
  repo. No config privacy here because there's nothing to protect.

### 2.2 Ranked (server-only, closed)

- Server runs the sim authoritatively.
- Streams frame data (positions, anim states) over WebSocket to
  spectators and the two competing players.
- Opponent configs NEVER leave the server.
- Clients cannot re-simulate ranked matches. They render from
  server frames only.
- Trade-offs accepted:
  - Higher bandwidth than input-log streaming (~10-50× more per match)
  - Replay requires server round-trip to re-run, OR server archives
    the frame log and serves it back

**The asymmetry is the point.** Practice = open and educational.
Ranked = closed and competitive.

---

## 3. Stable system

Each user owns a **stable** of 3-5 bot slots. Rationale:

1. **Anti-sniping**: server picks which slot plays per match randomly;
   opponent can't guarantee a specific counter matchup
2. **Skill expression**: building a diversified stable (close-pressure
   + zoner + anti-aggro) is itself strategic
3. **Compute defense compounds**: a solver must cover 3-5 meta slices,
   not just one

### 3.1 Submission rules

- 1 submission per slot per 24 hours
- Total rerolls per user per week: 3-5 slots × 7 days = 21-35
- A rich-compute rival can test bots offline indefinitely but can only
  DEPLOY 21-35 per week — climbing the ladder is bounded

### 3.2 Slot metadata

Per slot:

```ts
interface Stable {
  userId: string;
  slots: Array<{
    id: string;              // slot ID, immutable
    config: BrainConfig;     // the actual bot — SERVER ONLY
    submittedAt: number;
    rateLockedUntil: number; // next-submission-allowed timestamp
    name?: string;           // user-given nickname, public
    eloSlot: number;         // per-slot ELO, private
    wins: number;
    losses: number;
    draws: number;
  }>;
  eloAggregate: number;      // public display ELO (mean or max of slots)
}
```

Public surface: user handle + aggregate ELO + slot names + stats.
Private: actual config JSON, per-slot ELO.

---

## 4. Cadence: firehose

Server continuously matchmakes from the **active stable pool**. There
is always a ranked match live, regardless of who's watching.

**Why firehose over scheduled ticks:**
- No dead air for spectators
- Compute load is constant (one sim thread always hot) instead of
  spiky
- Featured events layer on top (daily championship, every 6h bracket)
  don't conflict

**Active pool definition:** stables submitted within the last 14 days.
Inactive stables don't take match slots.

### 4.1 Match throughput expectations

- One match ≈ 30-90 seconds wall-clock (BO3, limited to 60s/round cap)
- Single server instance runs ~1 match at a time (real-time pacing)
- For N concurrent matches, need N sim workers
- At launch: 1-2 concurrent matches is enough. Scale with activity.

---

## 5. Matchmaking

**Launch rule: close-ELO only, ±100.**

- `WILDCARD_RATIO = 0` at launch
- Tunable knob in server config — server admin can raise it without a
  redeploy
- Revisit after active pool > ~500 stables. Rationale:
  - Pool too shallow at launch — wildcards have nothing meaningful to
    surface
  - Ladder trust matters most on day 1; upsets driven by code, not
    matchmaking
  - `WILDCARD_RATIO > 0` adds value only once there are distinct tiers
    with different local metas

**Pairing algorithm** (close-ELO only):

1. Sort active pool by ELO.
2. Walk the sorted list; pair each stable with the nearest unpaired
   neighbor within ±100 ELO.
3. If no match within ±100, slot stays in next cycle (tolerance relaxes
   by 50 every cycle, capped at ±300).

### 5.1 Within-stable selection

After a pair is chosen, server picks which **slot** from each stable:

- Uniform random at launch.
- Future: weight by per-slot ELO (MMR-aware slot selection) once data
  warrants it.

---

## 6. Match format

**BO3** — matches existing `ROUNDS_TO_WIN_MATCH = 2` in
`sim/src/constants.ts`. First to 2 rounds wins. Each round is
capped at 60 s.

- Fast enough for firehose throughput
- Slow enough for BO1 variance to average out
- Matches the existing physics constants (no tuning change needed)

**Round format:** unchanged from current sim (3 points/round, token
dwell 0.5s, 16 attribute-config bots).

---

## 7. ELO, decay, seasons

### 7.1 ELO update

- Standard Elo: K=16 on slot-level ELO updates
- Stable aggregate ELO = mean of active slots (for display + matchmaking)

### 7.2 Decay

- Weekly decay applied to each slot: `elo = elo * 0.98 + 1000 * 0.02`
  (2% pull toward 1000 per week)
- Inactive stables drift back to the pack; active stables hold rank
- A snapshot-solved bot loses ~10 ELO/month of inactivity

### 7.3 Seasonal reset

- Hard reset every N weeks (TBD, launch target 12 weeks)
- End-of-season top bots: auto-published as **ghost bots** for the next
  season's practice pool
  - Anonymized (author handle removed)
  - Renamed to `ghost-2025-S1-top3` etc.
  - Configs finally revealed (publication reward + archive value)
- Fresh ladder each season prevents permanent entrenchment

---

## 8. Config privacy

### 8.1 Rules

- Opponent slot configs NEVER streamed to clients during or after
  matches
- Replay frames show visuals only (positions, anim states)
- Public API surface per slot:
  - `name`, `author`, `slotId`, `eloSlot` (optional), `wins/losses/draws`
  - **NOT** `attributes`, **NOT** `authorEloSlot`
- Ghost bots (released per-season) get their configs published as a
  reward/retirement event

### 8.2 Leak vectors we accept

- Frame data reveals behavior. Sophisticated spectators can reverse-
  engineer attribute ranges from watching many matches. Accepted cost.
- Author handles + aggregate ELO are public. Someone could correlate
  "player X wins via close-pressure" from replay watching. Accepted.
- Users who submit the SAME config in public practice can have it
  matched to their ranked slot by behavior fingerprinting. Mitigated
  by not requiring public practice; users can practice locally.

### 8.3 Leak vectors we block

- Direct config dump (the literal JSON). Never.
- Per-slot ELO for a specific slot name. Aggregate ELO only, or
  delayed 7 days.
- Server log access. Standard infra hygiene.

---

## 9. Replays

- **Permanent** retention. Deterministic sim means a replay is just
  `{seedA, stageId, configAHash, configBHash, frameLogBlob}`.
- Seed-addressable URLs: `/replay/<id>` where `id` is a short hash
- Frame log is the artifact; can re-render client-side using the
  COMPILED server code (not the opponent's config — configs stay
  private; only the replay engine needs them, and it runs server-side).

### 9.1 Replay visibility

- Player's own match replays: available immediately
- Other match replays: on demand via `/api/replay/<id>` — server
  re-runs the sim using stored hashes, streams frames. Configs not
  exposed.
- OpenGraph preview card: auto-generated thumbnail + "X vs Y — Z wins
  in BO3" text for shareability

### 9.2 Storage

- Frame log: ~20-40 KB per match (compressed)
- Metadata row: ~1 KB
- Million matches ≈ 30-40 GB total — cheap

---

## 10. Discovery / spectator UX

### 10.1 Front page

- Top-5 live matches by ELO-sum (sum of both competitors' ELOs)
- Each tile: matchup name, ELO tier, tick progress
- Click → live spectate

### 10.2 "See all live"

- Full list of currently-live matches, filterable by:
  - ELO tier (bronze/silver/gold/diamond/champion)
  - Match stage
  - Featured events

### 10.3 Featured events

- Daily championship at a fixed hour (TBD)
- Every-6h bracket of top-8 stables
- Spotlight on front page with countdown

### 10.4 NOT at launch

- Personalized follow
- User pages
- In-depth stats / heatmaps per stable
- Chat / comments

Add these when user base demands them. Not day-1.

---

## 11. Build order

The layers in dependency order. Build in this sequence.

### Phase 1 — Core server (no spectator)

1. `StableStore`: schema + persistence + 3-5 slot model + submission
   rate limit
2. `POST /api/ranked/submit`: privacy-enforced config upload
3. `GET /api/stables/:userId`: public surface (names, ELO, stats — no
   configs)
4. Close-ELO matchmaker (±100) picking from active pool
5. Server-side sim runner: takes two configs, runs BO3, stores result
6. Elo update + weekly decay cron

### Phase 2 — Spectator

7. WebSocket endpoint for live match frame stream
8. Front-end live view: render from server frames, no local sim
9. Top-5 live list endpoint + front-page UI

### Phase 3 — Replays

10. Frame log storage + `GET /api/replay/:id`
11. Replay player page (re-renders from stored frame log)
12. OpenGraph cards

### Phase 4 — Polish

13. Featured events (daily / every-6h)
14. Seasonal reset machinery + ghost bot publication
15. Wildcard ratio knob activation (once active pool > 500)
16. Discovery filters, tier names, etc.

### What to SKIP for v1

- Personalized follow
- In-depth per-stable pages
- Chat/comments
- Mobile app
- Payments / monetization

---

## 12. Open decisions

These were mentioned but not locked. Decide before they block build:

- **Season length**: 4 / 8 / 12 weeks. Default 12.
- **ELO decay rate**: 2% / week feels right, confirm in data.
- **Authentication**: Firebase Auth vs custom vs anonymous slots?
- **Rate-limit enforcement**: IP-based (weak) vs account-based
  (needs auth). If anonymous-allowed, 1 bot/slot/day is
  IP+fingerprint at best.
- **Ghost bot reveal criteria**: top-3 of season? Any champion? Only
  retired voluntarily?

---

## 13. If you inherit this project

Read, in order:

1. `README.md` — public package-level docs
2. `BRAIN_TUNING.md` — **private**, mechanical tuning internals (note: predates v5.2 anti-stall work; see `RELEASE_v9.md` for current state)
3. **this file** — competitive-layer architecture + threat model
4. `sim/src/simulate.ts` — the sim
5. `server/src/*` — server code

**Don't skip 3 and 4.** Most balance breakage and most privacy
leaks come from editing the sim or server without reading these.

---

*Last updated: after the PvP threat-model conversation, wildcard=0 at
launch decision, firehose+close-ELO locked, BO3 format confirmed
against the existing `ROUNDS_TO_WIN_MATCH=2` constant.*
