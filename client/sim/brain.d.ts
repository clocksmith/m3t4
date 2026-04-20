import type { Action, BrainState, Observation, Params } from "./types.js";
export declare const BEHAVIOR_VERSION = 8;
export declare function createBrainState(id: 0 | 1): BrainState;
export declare function resetBrainStateForRound(state: BrainState, tick: number): void;
export declare function runParamBrain(obs: Observation, params: Params, state: BrainState): Action;
