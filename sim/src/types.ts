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
  roundPause: number;
  roundWinner: -1 | 0 | 1;
  matchWinner: -1 | 0 | 1;
  freeze: number;
  rng: Rng;
  noiseSeed: number;
}

// ============ Observation (passed to brains) ============

export interface Observation {
  self: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    facing: -1 | 1;
    hp: number;
    onGround: boolean;
    wall: -1 | 0 | 1;
    stun: number;
    dead: boolean;
    swipeT: number;
    swipeCD: number;
    diveT: number;
    diveCD: number;
    hasToken: boolean;
    lastClashTick: number;
    lastAttackStartTick: number;
    lastKillTick: number;
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
  };
  token: { exists: boolean; x: number; y: number; carrier: 0 | 1 | -1 };
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
}
