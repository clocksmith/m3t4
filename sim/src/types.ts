import type { Rng } from "./rng.js";

// ============ Brain params (static shape) ============

export const PARAM_KEYS = [
  "burnRate",
  "moat",
  "shipRate",
  "foresight",
  "pivotSpeed",
  "leverage",
  "networking",
  // ---- expansion: 4 new axes that interact with the originals ----
  "spite",       // -1..+1: prioritize own delivery (+) vs denying opp's (-)
  "greed",       //  0..1:  how hard to push through danger to deliver
  "pacing",      //  0..1:  rhythmic burst pattern on burnRate
  "cunning",     //  0..1:  swing timing — patient counter vs reckless
  // -------------------------------------------------------------
  "hallucination",
] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];
export type Params = Record<ParamKey, number>;

export const DEFAULT_PARAMS: Params = {
  burnRate: 0.5,
  moat: 90,
  shipRate: 0.7,
  foresight: 0.05,
  pivotSpeed: 0.5,
  leverage: 0.0,
  networking: 0.0,
  spite: 0.0,
  greed: 0.5,
  pacing: 0.0,
  cunning: 0.5,
  hallucination: 0,
};

// ============ Attribute value spec (static scalar OR trajectory) ============

// A raw brain config has attributes that are either:
//   • a number            → constant scalar
//   • a string            → a DSL expression evaluated each tick
//   • a structured object → {base, ramp, oscillate, triggers}
export type AttributeSpec =
  | number
  | string
  | {
      base?: number;
      ramp?: { to: number; overTicks: number };
      oscillate?: { amp: number; period: number; phase?: number };
      triggers?: Array<{ when: string; value: number }>;
    };

export interface BrainConfig {
  id: string;
  author?: string;
  seed?: number; // per-brain RNG offset (server can override)
  attributes: Partial<Record<ParamKey, AttributeSpec>>;
}

// ============ Runtime fighter / world state ============

export type FighterStateLabel =
  | "idle"
  | "walk"
  | "jump"
  | "fall"
  | "wallSlide"
  | "swipe"
  | "dive"
  | "stun"
  | "dead";

export interface Character {
  name: string;
  label: string;
  col: string;
  trim: string;
  shadow: string;
}

export interface Fighter {
  id: 0 | 1;
  ch: Character;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  onGround: boolean;
  wall: -1 | 0 | 1;
  coyote: number;
  jumpBuf: number;
  swipeT: number;
  swipeCD: number;
  diveT: number;
  diveCD: number;
  stun: number;
  invuln: number;
  respawnT: number;
  dead: boolean;
  score: number;
  rounds: number;
  giant: number;
  hp: number; // present for API symmetry; mirrors respawn/dead semantics
  // Short-term memory — all store world tick values, -9999 sentinel for "never".
  // Enables reactive tactics (post-clash backoff, counter-punish, etc.)
  // without adding user-visible attributes.
  lastClashTick: number;
  lastAttackStartTick: number;
  lastKillTick: number;
  // Stuck detector — updated every 30 ticks by physics. If the fighter
  // hasn't displaced >40px in that window, lastMoveTick stays stale and
  // the brain forces a mixup. Breaks camp/stalemate loops.
  lastSignificantX: number;
  lastSignificantY: number;
  lastMoveTick: number;
}

export interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
  solid: boolean;
}

export interface GoalSpawn {
  x: number;
  y: number;
  sx: number;
  sy: number;
  label: string;
}

export interface Stage {
  id: string;
  name: string;
  platforms: Platform[];
  goals: GoalSpawn[];
  spawnL: { x: number; y: number };
  spawnR: { x: number; y: number };
}

export interface Goal {
  x: number;
  y: number;
  sx: number;
  sy: number;
  label: string;
  timer: number;
}

export interface Gold {
  carrier: 0 | 1;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dwellT: number; // seconds spent at the goal this attempt
}

export interface World {
  tick: number;
  stage: Stage;
  fighters: [Fighter, Fighter];
  gold: Gold | null;
  goal: Goal | null;
  lastGoalIdx: number;
  roundStartTick: number;
  roundPause: number;
  roundWinner: -1 | 0 | 1;
  matchWinner: -1 | 0 | 1;
  killCounts: [number, number];
  roundKillCounts: [number, number];
  freeze: number;
  rng: Rng;
  noiseSeed: number;
  brainStates: [BrainState, BrainState];
  // Optional per-fighter telemetry. When present, simulate() tallies mode
  // usage + action counts into these objects. Opt-in via SimulateOptions
  // so default MatchResult shape is unchanged. Not part of simulation
  // state; tallying is read-only and deterministic.
  telemetry?: [FighterTelemetry, FighterTelemetry];
}

// ============ Brain intent state (brain v3) ============
//
// One state object per fighter per match. Mutated in place by the brain.
// Lives for the full match; mode resets to "neutral" on round boundary and
// on own respawn, but the rolling opp-model buffers are preserved across
// lives so an opp's playstyle (e.g. swipe-spammer) is remembered.

export type BrainMode = "neutral" | "offense" | "zone" | "objective" | "escape";

// Per-fighter per-match telemetry. Populated by simulate() when it runs
// the brain loop; exposed on MatchResult.telemetry. Purely additive — no
// state evolution, deterministic, no BEHAVIOR_VERSION bump. Introduced
// as brain v4.0 diagnostic so anti-stall interventions can be picked
// from evidence, not speculation.
export interface FighterTelemetry {
  modeTicks: Record<BrainMode, number>;
  substateTicks: {
    press: number; bait: number; punish: number;
    deliver: number; intercept: number; pickup: number;
  };
  modeSwitches: number;
  zoneEntries: number;
  objectiveEntries: number;
  escapeEntries: number;
  swipes: number;
  dives: number;
  kills: number;
  deaths: number;
  clashes: number;
  deliveries: number; // goal-dwell completions credited
  ticks: number;      // decision ticks for this fighter (excludes freeze/roundPause)
  // Per-mode action/collision counters — diagnostic for v4.1. Lets
  // trace-stalls answer "was OFFENSE mode actually attacking, or
  // passive-foiling?" and "did OBJECTIVE mode convert to dwell?".
  modeSwipes: Record<BrainMode, number>;
  modeDives: Record<BrainMode, number>;
  modeClashes: Record<BrainMode, number>;
}

function emptyModeRecord(): Record<BrainMode, number> {
  return { neutral: 0, offense: 0, zone: 0, objective: 0, escape: 0 };
}

export function emptyFighterTelemetry(): FighterTelemetry {
  return {
    modeTicks: emptyModeRecord(),
    substateTicks: { press: 0, bait: 0, punish: 0, deliver: 0, intercept: 0, pickup: 0 },
    modeSwitches: 0,
    zoneEntries: 0,
    objectiveEntries: 0,
    escapeEntries: 0,
    swipes: 0,
    dives: 0,
    kills: 0,
    deaths: 0,
    clashes: 0,
    deliveries: 0,
    ticks: 0,
    modeSwipes: emptyModeRecord(),
    modeDives: emptyModeRecord(),
    modeClashes: emptyModeRecord(),
  };
}

export interface BrainState {
  id: 0 | 1;
  mode: BrainMode;
  substate: string | null;
  modeEnterTick: number;

  // Rolling event buffers — ring-bounded, tick-stamped. Entries older than
  // OPP_BUFFER_DECAY_TICKS (defined in brain.ts) are dropped on insert.
  recentOppSwipeTicks: number[];
  recentOppDiveTicks: number[];
  lastKnownOppAttackStartTick: number;

  // Self-clash rolling buffer. Populated by reading obs.self.lastClashTick
  // each brain tick and pushing when it advances. Used by v4.1 to detect
  // passive-foil clash loops (high clash rate with low attack rate).
  // Bounded the same way as opp buffers. Preserved across own respawn
  // within a round so pattern detection survives death.
  recentSelfClashTicks: number[];
  lastKnownSelfClashTick: number;

  // Delivery plan — v4.2 addition. Deterministic macro-tactic chosen
  // when bot enters OBJECTIVE-deliver, held for N ticks so the brain
  // doesn't thrash tactics per-frame. Cleared on token loss, death, or
  // expiry. See planDeliveryTactic() for scoring. Replay-safe.
  deliveryPlan: DeliveryPlan | null;

  // v5.1: count of ESCAPE entries since the last reset. Capped by
  // ESCAPE_LOOP_CAP; once hit, decideMode stops routing hard-danger to
  // ESCAPE and instead forces commit-into-trade. Prevents the mutual
  // escape-spiral that produced the 8-bot aerial stalemate clique.
  // Resets via resetBrainStateForRound, which fires on round boundary
  // AND on own respawn — so the effective lifetime is "since last round
  // start or own death," not strictly per round.
  escapeEntriesThisRound: number;

  // v5.2: cumulative ticks spent in ESCAPE / ZONE within the current
  // round-or-respawn window. Capped by ESCAPE_MAX_TICKS_PER_ROUND /
  // ZONE_MAX_TICKS_PER_ROUND respectively. Once exceeded, decideMode
  // force-exits the mode to NEUTRAL and blocks re-entry until reset.
  // Addresses "stuck in safe attractor" stalemate pattern where the
  // escape-exit distance condition (absDist > 280) never fires because
  // opp holds the bot at medium range indefinitely.
  escapeTicksThisRound: number;
  zoneTicksThisRound: number;

  // Debug hook — reason for last mode transition. Not used in decisions.
  lastTransitionReason: string;
}

// One of a small set of hand-authored delivery tactics, chosen by
// deterministic timing + trait-weighted scoring. Each tactic is a
// mini-program runObjectiveMode executes tick-by-tick until expiry.
export type DeliveryTacticKind = "direct" | "kill-first" | "feint";

export interface DeliveryPlan {
  tactic: DeliveryTacticKind;
  startedAt: number;
  expiresAt: number;      // re-plan when tick >= expiresAt
  feintUntil?: number;    // for "feint": tick at which back-step ends
  score: number;          // diagnostic: chosen tactic's utility score
}

// ============ Observation (passed to brains) ============

export interface Observation {
  self: {
    id: 0 | 1;
    x: number;
    y: number;
    vx: number;
    vy: number;
    facing: -1 | 1;
    hp: number;
    onGround: boolean;
    wall: -1 | 0 | 1;
    stun: number;
    invuln: number;
    dead: boolean;
    swipeT: number;
    swipeCD: number;
    diveT: number;
    diveCD: number;
    hasToken: boolean;
    lastClashTick: number;
    lastAttackStartTick: number;
    lastKillTick: number;
    lastMoveTick: number;
    score: number;
    rounds: number;
  };
  opp: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    facing: -1 | 1;
    hp: number;
    onGround: boolean;
    stun: number;
    dead: boolean;
    swipeT: number;
    diveT: number;
    hasToken: boolean;
    lastAttackStartTick: number;
    score: number;
    rounds: number;
  };
  token: { exists: boolean; x: number; y: number; carrier: 0 | 1 | -1; dwellT: number };
  goal: { exists: boolean; x: number; y: number; label: string; timer: number };
  platforms: Platform[];
  arena: { left: number; right: number; top: number; floor: number };
  dx: number;
  absDx: number;
  dy: number;
  tick: number;
}

// ============ Action (returned by brains) ============

export interface Action {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
  action?: boolean;
}

// ============ Match result ============

export interface MatchResult {
  winner: 0 | 1 | -1;
  finalScore: [number, number];
  finalRounds: [number, number];
  ticks: number;
  seed: number;
  logHash: string;
  frameLog: Uint8Array; // packed input + score delta log
  telemetry?: [FighterTelemetry, FighterTelemetry];
}
