import type { Rng } from "./rng.js";
export declare const PARAM_KEYS: readonly ["burnRate", "moat", "shipRate", "foresight", "pivotSpeed", "leverage", "networking", "spite", "greed", "pacing", "cunning", "lift", "parry", "chase", "discipline", "hallucination"];
export type ParamKey = (typeof PARAM_KEYS)[number];
export type Params = Record<ParamKey, number>;
export declare const DEFAULT_PARAMS: Params;
export type AttributeSpec = number | string | {
    base?: number;
    ramp?: {
        to: number;
        overTicks: number;
    };
    oscillate?: {
        amp: number;
        period: number;
        phase?: number;
    };
    triggers?: Array<{
        when: string;
        value: number;
    }>;
};
export interface BrainConfig {
    id: string;
    author?: string;
    seed?: number;
    attributes: Partial<Record<ParamKey, AttributeSpec>>;
}
export type FighterStateLabel = "idle" | "walk" | "jump" | "fall" | "wallSlide" | "swipe" | "dive" | "stun" | "dead";
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
    hp: number;
    lastClashTick: number;
    lastAttackStartTick: number;
    lastKillTick: number;
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
    spawnL: {
        x: number;
        y: number;
    };
    spawnR: {
        x: number;
        y: number;
    };
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
    dwellT: number;
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
    telemetry?: [FighterTelemetry, FighterTelemetry];
}
export type BrainMode = "neutral" | "offense" | "zone" | "objective" | "escape";
export interface FighterTelemetry {
    modeTicks: Record<BrainMode, number>;
    substateTicks: {
        press: number;
        bait: number;
        punish: number;
        deliver: number;
        intercept: number;
        pickup: number;
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
    deliveries: number;
    ticks: number;
    modeSwipes: Record<BrainMode, number>;
    modeDives: Record<BrainMode, number>;
    modeClashes: Record<BrainMode, number>;
}
export declare function emptyFighterTelemetry(): FighterTelemetry;
export interface BrainState {
    id: 0 | 1;
    mode: BrainMode;
    substate: string | null;
    modeEnterTick: number;
    recentOppSwipeTicks: number[];
    recentOppDiveTicks: number[];
    lastKnownOppAttackStartTick: number;
    recentSelfClashTicks: number[];
    lastKnownSelfClashTick: number;
    deliveryPlan: DeliveryPlan | null;
    escapeEntriesThisRound: number;
    escapeTicksThisRound: number;
    zoneTicksThisRound: number;
    lastTransitionReason: string;
}
export type DeliveryTacticKind = "direct" | "kill-first" | "feint";
export interface DeliveryPlan {
    tactic: DeliveryTacticKind;
    startedAt: number;
    expiresAt: number;
    feintUntil?: number;
    score: number;
}
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
    token: {
        exists: boolean;
        x: number;
        y: number;
        carrier: 0 | 1 | -1;
        dwellT: number;
    };
    goal: {
        exists: boolean;
        x: number;
        y: number;
        label: string;
        timer: number;
    };
    platforms: Platform[];
    arena: {
        left: number;
        right: number;
        top: number;
        floor: number;
    };
    dx: number;
    absDx: number;
    dy: number;
    tick: number;
}
export interface Action {
    left?: boolean;
    right?: boolean;
    up?: boolean;
    down?: boolean;
    action?: boolean;
}
export interface MatchResult {
    winner: 0 | 1 | -1;
    finalScore: [number, number];
    finalRounds: [number, number];
    ticks: number;
    seed: number;
    logHash: string;
    frameLog: Uint8Array;
    telemetry?: [FighterTelemetry, FighterTelemetry];
}
