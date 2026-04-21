import { type CompiledBrain } from "./dsl.js";
import type { Action, BrainConfig, Character, MatchResult, Observation, Params, Stage, World } from "./types.js";
export declare const DEFAULT_CHARS: [Character, Character];
export declare function applyMicroAttributeDrift(params: Params, tick: number, fighterId: 0 | 1, noiseSeed: number): Params;
export declare function applyHallucinationNoise(params: Params, tick: number, fighterId: 0 | 1, noiseSeed: number): Params;
export declare function settleWorldWinner(w: World): void;
declare function packAction(a: Action): number;
declare function unpackAction(byte: number): Action;
export interface SimulateOptions {
    stage: Stage;
    brainA: BrainConfig;
    brainB: BrainConfig;
    seed: number;
    chars?: [Character, Character];
    maxTicks?: number;
    telemetry?: boolean;
}
export declare function simulate(opts: SimulateOptions): MatchResult;
export { unpackAction, packAction };
export declare function createStepperWorld(opts: {
    stage: Stage;
    seed: number;
    chars?: [Character, Character];
}): World;
export declare function worldObservation(w: World, selfIdx: 0 | 1): Observation;
export declare function runBrainForWorld(w: World, brain: CompiledBrain, selfIdx: 0 | 1): Action;
export interface StepResult {
    matchWinner: -1 | 0 | 1;
    tick: number;
}
export declare function stepWorld(w: World, actA: Action, actB: Action): StepResult;
/** Pull the current world state into a TraceFrame (for renderers). */
export declare function worldToFrame(w: World): TraceFrame;
export { STATS } from "./constants.js";
export interface TraceFighterFrame {
    x: number;
    y: number;
    vx: number;
    vy: number;
    facing: -1 | 1;
    onGround: boolean;
    wall: -1 | 0 | 1;
    stun: number;
    swipeT: number;
    diveT: number;
    dead: boolean;
}
export interface TraceFrame {
    tick: number;
    p0: TraceFighterFrame;
    p1: TraceFighterFrame;
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
    scoreboard: [number, number];
    rounds: [number, number];
}
export interface TraceResult {
    result: MatchResult;
    frames: TraceFrame[];
    stage: Stage;
}
export declare function simulateTrace(opts: SimulateOptions): TraceResult;
