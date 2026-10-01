# Authoring phone challenges

The live catalog is `client/muzil/challenges.json`, a `muzil-challenges/v1`
object containing a `challenges` array. Add a JSON entry to add a round; no new
controller or screen code is needed for the existing apps. The catalog currently
contains eight tasks: two pickups, a locker handoff, an early-shift alarm, a moved
meeting, groceries, a train departure and an address to send.

Each shipped round has one outcome. Make it difficult through app navigation,
information gathering and interruptions; do not bundle unrelated errands.

A challenge owns its ID/version, title, intention, success copy, displayed date,
duration, initial contacts/messages, calendar events, notes, alarms, scheduled
interruptions, and a goal tree. `challenges.mjs` validates each entry before play.
The complete configuration is stored in each replay, so changing the catalog
later does not change a saved round. The two original qualification scenarios
remain in `scenarios.mjs` for retained model experiments and old replays.

Example single challenge, also accepted by **Load challenge JSON** in the
stand-in workspace after a round:

```json
{
  "version": 1,
  "id": "library-handoff",
  "title": "Before the library closes",
  "intention": "Send Jo the collection code from Notes.",
  "success": "Jo has the code.",
  "date": "Wednesday, September 30",
  "durationMs": 150000,
  "initial": {
    "contacts": [
      { "id": "jo", "name": "Jo", "messages": ["Can you send the collection code?"] }
    ],
    "calendar": [],
    "notes": "Library collection code: 4826",
    "alarms": []
  },
  "goal": {
    "kind": "message", "contact": "jo", "includes": ["4826"]
  },
  "interruptions": [
    {
      "id": "feed-tease", "at": 9000, "app": "feed",
      "title": "Someone tagged you", "body": "Is that actually you?",
      "interruptive": true, "distraction": "reveal"
    }
  ]
}
```

## Result predicates

- `all`: every child goal must hold. Order is irrelevant.
- `any`: at least one child must hold. Both groups can be nested.
- `message`: checks the **latest sent message** to `contact`. Optional `time`
  requires one unambiguous time matching the configured 24-hour value. `includes`
  requires all listed words/phrases. `choice` takes `options` and `expected` and
  rejects messages mentioning multiple alternatives.
- `note`: checks each saved note using `includes` and/or `choice`; one note must satisfy all conditions. Deleted notes do not count.
- `alarm`: the specified 24-hour `time` must exist in the saved alarm list.

Text matching normalizes case, Unicode and punctuation and matches whole phrases.
It is deliberately bounded and does not interpret negation, synonyms, or arbitrary
meaning. Include the exact words needed to solve a task in the visible phone.
Completion follows the resulting state, not an expected sequence of clicks.
Humans and agents use the same controls and evaluator. Agents see visible app
content; the hidden goal tree is not sent in their observation.

## Limits and imports

Durations are 30–600 seconds. A challenge has at most 12 contacts, 12 calendar
events, 12 initial alarms, 50 interruptions and 32 goal nodes. Notification IDs
must be unique and scheduled inside the duration. References must point to an
existing contact. Catalogs contain at most 100 challenges. Unknown predicate
kinds, invalid times, empty goal groups and invalid references fail validation.
A challenge can compose existing apps; a new kind of app or predicate needs code.

Local import accepts a single challenge or a catalog up to 200 KB, with new IDs.
Imported entries are available for this page session and are embedded in its
saved replay. Imports do not publish to the site or synchronize to a friend's
catalog; paired players need the same challenge configuration.

## Original thought and interruptions

The intention appears as a centered **m3t4.ai task** thought above the phone.
After five seconds the words scatter away. Remember why reveals it again without
changing apps, including during an interruption. It is outside the simulated OS.

New rounds use `muzil-phone/2`. A notification appears below the status bar and
must be opened; there is no dismissal action or Home/Back bypass. Plain alerts
open their app. `distraction` selects `reveal`, `pairs` or `timing`, followed by
group-chat replies, a required reaction, and a link into Doom Scroll. A timing
attempt advances even on a miss; the user must follow the chain, not repeatedly
retry a precision game. Navigation returns after opening the linked post, with
the player in the feed rather than automatically back at their task.

The clock continues throughout. Duplicate title/body/distraction payloads are
coalesced, resolved payloads never recur within a round, and each completed
interruption gives eight seconds before another mandatory banner. Alerts that
arrive during a chain wait until it is complete. The shared engine enforces the
same rules for humans and agents; drafts persist and detours never win the task.
Actions, reactions, card layouts and timing results reconstruct from replay.
Version 1 replays preserve their original optional detours and dismissal rules;
`interruptive` remains part of that legacy format.

## Doom Scroll

The `feed` app ID now displays Doom Scroll. Fictional posts are generated from a
round seed and post index in English, Spanish, French and Portuguese. A local
stop-word vote guesses language; independent lexical cues produce a playful
nonsense score. Neither is a trained semantic classifier or a judgment of people.
No network content, model weights or inference is required.

Native wheel/touch scrolling, keyboard navigation and agent commands become the
same `next-post` / `previous-post` transitions. `like-post` toggles the current
post's like. The state survives app navigation and reproduces through replay.
Only five cards are mounted at once. Scroll position, speed, the nonsense score,
post color and likes feed one WebGPU shader surface. A CSS fallback keeps the
feed usable if WebGPU is unavailable or lost. Reduced motion draws on demand;
leaving the feed releases its GPU resources. The original round timer continues.

## Checks

- `npm run test:muzil`: JSON validation, all eight outcomes, alternatives, expiry,
  deterministic feed content, shared actions and replay.
- `npm run test:muzil:apps`: Calendar, alarms, Notes, Contacts and Messages editing,
  search, app-switch persistence, interrupted drafts and replay at desktop/mobile sizes.
- `npm run test:muzil:browser`: desktop/mobile phone, drafts, demos, races/rematches.
- `node tools/muzil-interruption-smoke.mjs`: toaster controls, centered original thought,
  mandatory top banners, bounded detour chains, preserved drafts and replay.
- `npm run test:muzil:doom`: WebGPU render, wheel/touch/keyboard input, bounded cards,
  JSON import, non-pickup task completion, CSS fallback and reduced motion.

Real model completion on these new tasks has not been qualified. The retained
Qwen success/latency evidence applies to the original pickup task.
