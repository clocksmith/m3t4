import type { BrainConfig, Stage } from "./types.js";
export type ReciprocalSideBiasOptions = {
    stage: Stage;
    brainA: BrainConfig;
    brainB: BrainConfig;
    seeds: number[];
};
export type ReciprocalSideBiasResult = {
    samples: number;
    aWinsAsP0: number;
    aWinsAsP1: number;
    bWinsAsP0: number;
    bWinsAsP1: number;
    drawsAsP0: number;
    drawsAsP1: number;
    aWinRateAsP0: number;
    aWinRateAsP1: number;
    sideBias: number;
    reciprocalDisagreements: number;
};
export declare function evaluateReciprocalSideBias(opts: ReciprocalSideBiasOptions): ReciprocalSideBiasResult;
