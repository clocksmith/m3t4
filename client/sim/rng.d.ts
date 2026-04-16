export type Rng = () => number;
export declare function makeRng(seed: number): Rng;
export declare function rngRange(rng: Rng, lo: number, hi: number): number;
